"""
Runner-contract adapter for the cable EfficientNet classifier.

Invoked by retraining_learning/runner.py with:
  - cwd = retraining_learning/runs/cable-<run_id>/
  - dataset.jsonl + image files staged in cwd
  - --holdout <path>  ← retraining_learning/holdout/cable/

Required outputs (in cwd, exit 0):
  - best.pt              ← the fine-tuned EfficientNet
  - val_metrics.json     ← {"accuracy": float, ...}

The actual training happens in this file (continue-training from the
production cable_classifier checkpoint). Holdout is expected as
class-named subdirectories (the standard ImageFolder layout).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

ADAPTER_DIR = Path(__file__).resolve().parent
REPO_ROOT   = ADAPTER_DIR.parent.parent

# Cable-classifier label space (must match the production model)
CLASS_NAMES = [
    "LC_Aqua",
    "RJ-45 Violet",
    "RJ_45 Black",
    "RJ_45 Blue",
    "RJ_45 Brown",
    "RJ_45 Green",
    "RJ_45 Grey",
    "RJ_45 Orange",
    "RJ_45 Pink",
    "RJ_45 Red",
    "RJ_45 White",
    "RJ_45 Yellow",
    "SC_Orange",
    "SC_Yellow",
]
CLS_INDEX = {n: i for i, n in enumerate(CLASS_NAMES)}


# ── Imports deferred so `--help` works without torch installed ────────
def _torch_imports():
    import torch
    import torch.nn as nn
    from torch.utils.data import Dataset, DataLoader
    import torchvision
    from torchvision import transforms
    from PIL import Image
    return torch, nn, Dataset, DataLoader, torchvision, transforms, Image


# ── Build a Dataset from dataset.jsonl ────────────────────────────────
def make_train_dataset(work_dir: Path, dataset_jsonl: Path):
    torch, nn, Dataset, DataLoader, torchvision, transforms, Image = _torch_imports()
    tf = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(0.1, 0.1, 0.1),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],
                             std=[0.229, 0.224, 0.225]),
    ])

    samples: list[tuple[Path, int]] = []
    with dataset_jsonl.open("r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            actual = row.get("actual") or {}
            color  = actual.get("cable_color") or actual.get("class")
            if color is None:
                continue
            # Be permissive: try exact match, then cheap normalization
            cls = color if color in CLS_INDEX else _normalize_label(color)
            if cls not in CLS_INDEX:
                continue
            img_path = row.get("image_path")
            if not img_path:
                continue
            full = work_dir / img_path
            if not full.exists():
                continue
            samples.append((full, CLS_INDEX[cls]))

    class _DS(Dataset):
        def __len__(self): return len(samples)
        def __getitem__(self, i):
            p, y = samples[i]
            img = Image.open(p).convert("RGB")
            return tf(img), y
    return _DS(), len(samples)


def _normalize_label(s: str) -> str:
    """Best-effort match user-typed colors to canonical CLASS_NAMES."""
    s = s.strip()
    for c in CLASS_NAMES:
        if c.lower() == s.lower():
            return c
        if c.lower().replace("-", "_").replace(" ", "_") == s.lower().replace("-", "_").replace(" ", "_"):
            return c
    return s


# ── Continue-train from production checkpoint ─────────────────────────
def train_classifier(train_ds, work_dir: Path, epochs: int = 10) -> Path:
    torch, nn, Dataset, DataLoader, torchvision, transforms, Image = _torch_imports()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Load production cable model and continue training
    base_path = REPO_ROOT / "Models" / "best_model_efficientnet.pth"
    print(f"[adapter] base model: {base_path}, device={device}", file=sys.stderr)

    model = torchvision.models.efficientnet_b0(weights=None)
    in_feat = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_feat, len(CLASS_NAMES))

    if base_path.exists():
        ckpt = torch.load(base_path, map_location="cpu", weights_only=False)
        if isinstance(ckpt, dict):
            for key in ("state_dict", "model_state_dict", "model"):
                if key in ckpt and isinstance(ckpt[key], dict):
                    ckpt = ckpt[key]
                    break
        if not isinstance(ckpt, nn.Module):
            sd = {k.replace("module.", ""): v for k, v in ckpt.items()}
            model.load_state_dict(sd, strict=False)

    model = model.to(device).train()
    loader = DataLoader(train_ds, batch_size=16, shuffle=True, num_workers=0)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-4)
    loss_fn = nn.CrossEntropyLoss()

    for epoch in range(epochs):
        total, correct, loss_sum = 0, 0, 0.0
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            out = model(x)
            loss = loss_fn(out, y)
            loss.backward()
            opt.step()
            loss_sum += loss.item() * x.size(0)
            correct += (out.argmax(1) == y).sum().item()
            total += x.size(0)
        print(f"[adapter] epoch {epoch+1}/{epochs}  loss={loss_sum/max(1,total):.4f}  acc={correct/max(1,total):.4f}",
              file=sys.stderr)

    out = work_dir / "best.pt"
    torch.save(model.state_dict(), out)
    return out


# ── Evaluate against holdout (ImageFolder layout) ─────────────────────
def evaluate(model_path: Path, holdout_dir: Path) -> dict:
    torch, nn, Dataset, DataLoader, torchvision, transforms, Image = _torch_imports()
    if not holdout_dir.exists() or not any(holdout_dir.iterdir()):
        return {"accuracy": 0.0, "n_holdout": 0,
                "note": f"holdout {holdout_dir} is empty — no validation possible"}

    tf = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],
                             std=[0.229, 0.224, 0.225]),
    ])

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = torchvision.models.efficientnet_b0(weights=None)
    in_feat = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_feat, len(CLASS_NAMES))
    model.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=False))
    model = model.to(device).eval()

    ds = torchvision.datasets.ImageFolder(str(holdout_dir), transform=tf)
    # Map ImageFolder's idx → CLASS_NAMES idx (folder names must match)
    folder_to_idx = {n: CLS_INDEX[n] for n in ds.classes if n in CLS_INDEX}
    loader = DataLoader(ds, batch_size=32, shuffle=False, num_workers=0)

    correct, total = 0, 0
    with torch.no_grad():
        for x, y in loader:
            # Translate ImageFolder labels → our class indexing
            y_translated = torch.tensor(
                [folder_to_idx.get(ds.classes[int(yi)], -1) for yi in y]
            ).to(device)
            x = x.to(device)
            out = model(x).argmax(1)
            mask = y_translated >= 0
            correct += (out[mask] == y_translated[mask]).sum().item()
            total += int(mask.sum().item())
    acc = correct / total if total else 0.0
    return {
        "accuracy":  acc,
        "n_holdout": total,
        "n_classes": len(folder_to_idx),
    }


# ── Runner contract ───────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", required=True)
    ap.add_argument("--epochs", type=int, default=10)
    args = ap.parse_args()

    work = Path.cwd()
    dataset_jsonl = work / "dataset.jsonl"
    if not dataset_jsonl.exists():
        print(f"[adapter] FATAL: no dataset.jsonl in {work}", file=sys.stderr)
        sys.exit(2)

    started = time.time()
    train_ds, n = make_train_dataset(work, dataset_jsonl)
    if n == 0:
        print("[adapter] no usable training samples after label normalization", file=sys.stderr)
        sys.exit(3)
    print(f"[adapter] train samples: {n}", file=sys.stderr)

    best = train_classifier(train_ds, work, epochs=args.epochs)
    print(f"[adapter] trained → {best}", file=sys.stderr)

    metrics = evaluate(best, Path(args.holdout))
    metrics["elapsed_sec"] = round(time.time() - started, 2)
    metrics["n_train_samples"] = n
    (work / "val_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"[adapter] val_metrics: {json.dumps(metrics)}", file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
