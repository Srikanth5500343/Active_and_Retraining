"""
Cable_retraining/train2.py — fine-tune the cable EfficientNet classifier on
final_dataset/ (produced by dataset.py from UI corrections + optional old
data). Saves the best checkpoint to final_dataset/best_model_efficientnet.pth
so main.py can promote it to prev_dataset/ alongside the data.

This is the standalone trainer wired into main.py. The runner-contract
adapter (runner_adapter.py) does the same fine-tuning but for the
production-orchestrated retraining flow — they share the same base model
and class space, just differ in how they get invoked.
"""

import copy
import os
import sys

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader
from torchvision import datasets, transforms, models

# Force UTF-8 console — Windows' default cp1252 codec can't encode the emoji
# in print() statements below; a single UnicodeEncodeError would crash
# training after a successful run, masking the actual result.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------- CONFIG ----------------
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT   = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
DATA_DIR    = os.path.join(SCRIPT_DIR, "final_dataset")
PROD_MODEL  = os.path.join(REPO_ROOT, "Models", "best_model_efficientnet.pth")
OUTPUT_CKPT = os.path.join(DATA_DIR, "best_model_efficientnet.pth")

BATCH_SIZE = 16
EPOCHS     = 10        # low for testing — fine-tuning on UI corrections
PATIENCE   = 5
LR         = 1e-4

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"[train2] device={device}, data_dir={DATA_DIR}")

# ---------------- TRANSFORMS ----------------
train_tf = transforms.Compose([
    transforms.Resize((256, 256)),
    transforms.RandomHorizontalFlip(),
    transforms.RandomRotation(15),
    transforms.ToTensor(),
])
val_tf = transforms.Compose([
    transforms.Resize((256, 256)),
    transforms.ToTensor(),
])

# ---------------- DATASETS ----------------
train_ds = datasets.ImageFolder(os.path.join(DATA_DIR, "train"), transform=train_tf)
val_ds   = datasets.ImageFolder(os.path.join(DATA_DIR, "val"),   transform=val_tf)
test_ds  = datasets.ImageFolder(os.path.join(DATA_DIR, "test"),  transform=val_tf)

class_names = train_ds.classes
num_classes = len(class_names)
print(f"[train2] classes ({num_classes}): {class_names}")

train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,  num_workers=0)
val_loader   = DataLoader(val_ds,   batch_size=BATCH_SIZE, shuffle=False, num_workers=0)
test_loader  = DataLoader(test_ds,  batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

# ---------------- MODEL (continue-train from production) ----------------
model = models.efficientnet_b0(weights=None)
model.classifier[1] = nn.Linear(model.classifier[1].in_features, num_classes)

if os.path.isfile(PROD_MODEL):
    print(f"[train2] loading production weights: {PROD_MODEL}")
    ckpt = torch.load(PROD_MODEL, map_location="cpu", weights_only=False)
    if isinstance(ckpt, dict):
        for key in ("state_dict", "model_state_dict", "model"):
            if key in ckpt and isinstance(ckpt[key], dict):
                ckpt = ckpt[key]
                break
    if not isinstance(ckpt, nn.Module):
        sd = {k.replace("module.", ""): v for k, v in ckpt.items()}
        # strict=False so a head-size mismatch (e.g. if classes ever change)
        # doesn't kill the load — just reinitializes the final layer.
        model.load_state_dict(sd, strict=False)
else:
    print(f"[train2] ⚠️  no production model at {PROD_MODEL} — starting from random head on ImageNet backbone")
    model = models.efficientnet_b0(weights="IMAGENET1K_V1")
    model.classifier[1] = nn.Linear(model.classifier[1].in_features, num_classes)

model = model.to(device)

# ---------------- LOSS / OPT ----------------
criterion = nn.CrossEntropyLoss(label_smoothing=0.1)
optimizer = optim.AdamW(model.parameters(), lr=LR)

# ---------------- TRAIN / VALIDATE ----------------
def train_one_epoch():
    model.train()
    total_loss, correct, n = 0.0, 0, 0
    for x, y in train_loader:
        x, y = x.to(device), y.to(device)
        optimizer.zero_grad()
        out  = model(x)
        loss = criterion(out, y)
        loss.backward()
        optimizer.step()
        total_loss += loss.item() * x.size(0)
        correct    += (out.argmax(1) == y).sum().item()
        n          += x.size(0)
    return total_loss / max(1, n), correct / max(1, n)

def validate(loader, ds_len):
    model.eval()
    correct = 0
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            correct += (model(x).argmax(1) == y).sum().item()
    return correct / max(1, ds_len)

# ---------------- TRAIN LOOP (early stopping on val acc) ----------------
best_acc = 0.0
patience = 0
best_wts = copy.deepcopy(model.state_dict())

for epoch in range(EPOCHS):
    tr_loss, tr_acc = train_one_epoch()
    val_acc = validate(val_loader, len(val_ds))
    print(f"[train2] epoch {epoch+1}/{EPOCHS}  loss={tr_loss:.4f}  train_acc={tr_acc:.4f}  val_acc={val_acc:.4f}")

    if val_acc > best_acc:
        best_acc = val_acc
        best_wts = copy.deepcopy(model.state_dict())
        patience = 0
        print("[train2] ✅ best updated")
    else:
        patience += 1
        if patience >= PATIENCE:
            print("[train2] 🛑 early stop")
            break

# ---------------- TEST + SAVE ----------------
model.load_state_dict(best_wts)
test_acc = validate(test_loader, len(test_ds))
print(f"\n[train2] 🧪 test accuracy: {test_acc:.4f}")

torch.save(model.state_dict(), OUTPUT_CKPT)
print(f"[train2] ✅ saved → {OUTPUT_CKPT}")
