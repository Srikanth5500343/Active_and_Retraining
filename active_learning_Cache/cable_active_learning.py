"""
Cable-type classification with HTML feedback UI (folder input).

Input  : IMAGE_DIR (hardcoded below) -- folder of cable images.
Output : Interactive HTML page at http://127.0.0.1:5001/

Run:
    pip install torch torchvision flask pillow numpy
    python cable_active_learning.py

Workflow:
- Every image in IMAGE_DIR is classified.
- For each image the page shows the predicted class, Yes/No, and a dropdown
  of all classes when No is chosen.
- Corrections persisted by perceptual-hash + ResNet18 embedding per image.
- On any future run (or reload), images whose hash/embedding matches a stored
  correction get that label applied INSTANTLY before the page renders.
"""

import json
import base64
import io
import os
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional

import numpy as np
import torch
import torchvision
from torchvision import transforms
from PIL import Image
from flask import Flask, request, redirect, url_for, render_template_string

# Make the active_learning_Cache package importable when this script
# is run directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from active_learning_Cache import config as al_config
from active_learning_Cache.store import Store
from active_learning_Cache.embedder import phash, hamming, embed, cos_sim, find_correction, HAMMING_TOL, SIM_THRESH


# ---------- config ----------
# Paths derived from the central package config so the layout is
# portable. Override IMAGE_DIR or RACKTRACK_CABLE_MODEL via env.
REPO_ROOT    = al_config.REPO_ROOT
IMAGE_DIR    = Path(os.environ.get(
    "RACKTRACK_AL_CABLE_DIR",
    str(REPO_ROOT / "active_learning_Cache" / "data" / ".flask_cable_input")
))
def _default_cable_model():
    cfg_path = REPO_ROOT / "config.json"
    try:
        models = json.loads(cfg_path.read_text(encoding="utf-8"))["models"]
        rel = models.get("cable_classifier") or "Models/best_model_efficientnet.pth"
    except Exception:
        rel = "Models/best_model_efficientnet.pth"
    return str(REPO_ROOT / rel)
MODEL_PATH   = os.environ.get("RACKTRACK_CABLE_MODEL", _default_cable_model())

FEEDBACK_DIR = REPO_ROOT / "active_learning_Cache" / "data" / ".flask_cable"
HASH_SIZE    = 16
HAMMING_TOL  = 6
SIM_THRESH   = 0.88
IMG_EXTS     = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
THUMB_MAX    = 360   # max side length for page thumbnails

# Wire into the central per-model store.
_STORE_CABLE = Store("cable")

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
# -----------------------------------------

CORR_FILE      = FEEDBACK_DIR / "corrections.json"
IMG_DIR        = FEEDBACK_DIR / "confirmed_images"
LATER_USE_DIR  = FEEDBACK_DIR / "later_use_cables"
for d in (FEEDBACK_DIR, IMG_DIR, LATER_USE_DIR, IMAGE_DIR):
    d.mkdir(parents=True, exist_ok=True)


def class_to_folder(name: str) -> str:
    """Turn a class label like 'RJ-45 Violet' into a safe folder name 'RJ_45_Violet'."""
    return name.replace(" ", "_").replace("-", "_")


def normalize_correction_label(label: str, rec: dict) -> str:
    """Convert server color-only corrections into this UI's class labels."""
    if not label:
        return label

    label = str(label).strip()
    if label in CLASS_NAMES:
        return label
    if "_" in label or label.startswith("RJ-45") or label.startswith("SC "):
        candidate = label.replace("SC ", "SC_", 1)
        return candidate if candidate in CLASS_NAMES else label

    metadata = rec.get("metadata") or {}
    connector = str(metadata.get("cable_connector") or "").upper()
    connector = connector.replace("-", "").replace("_", "").replace(" ", "")

    candidates = []
    if label == "Aqua":
        candidates.append("LC_Aqua")
    elif label == "Violet":
        candidates.extend(["RJ-45 Violet", "RJ-45_Violet"])
    elif connector == "SC" and label in {"Orange", "Yellow"}:
        candidates.append(f"SC_{label}")
    elif connector == "LC":
        candidates.append(f"LC_{label}")
    else:
        candidates.extend([f"RJ_45 {label}", f"RJ_45_{label}"])

    for candidate in candidates:
        if candidate in CLASS_NAMES:
            return candidate
    return label


# ---------- persistence ----------
def load_corrections() -> dict:
    """Load corrections from both local file and server's AL database.

    This ensures corrections from production UI feedback are available
    in the Flask AL UI, and vice versa.
    """
    merged = {}

    # Load local Flask AL corrections
    try:
        if CORR_FILE.exists():
            local = json.loads(CORR_FILE.read_text())
            merged.update(local)
    except Exception as e:
        print(f"[AL] Warning: failed to load local corrections: {e}")

    # Load server's AL corrections (from production UI feedback)
    try:
        server_al_path = REPO_ROOT / "server" / "data" / "active_learning" / "cable_corrections.json"
        if server_al_path.exists():
            server_al = json.loads(server_al_path.read_text())
            for rec in server_al.values():
                if isinstance(rec, dict):
                    rec["label"] = normalize_correction_label(rec.get("label"), rec)
            # Merge server corrections, giving precedence to local corrections
            for h, rec in server_al.items():
                if h not in merged:
                    merged[h] = rec
    except Exception as e:
        print(f"[AL] Warning: failed to load server AL corrections: {e}")

    return merged


def save_corrections(c: dict) -> None:
    CORR_FILE.write_text(json.dumps(c, indent=2))


# ---------- deep-feature embedder ----------
_DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Device: {_DEVICE}")

print("Loading embedder (ResNet18)...")
_emb_model = torchvision.models.resnet18(
    weights=torchvision.models.ResNet18_Weights.DEFAULT
)
_emb_model.fc = torch.nn.Identity()
_emb_model.eval().to(_DEVICE)
_tf_224 = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406],
                         std=[0.229, 0.224, 0.225]),
])


@torch.no_grad()
def embed(pil_img: Image.Image) -> list:
    x = _tf_224(pil_img.convert("RGB")).unsqueeze(0).to(_DEVICE)
    v = _emb_model(x).squeeze(0).cpu().numpy()
    v = v / (np.linalg.norm(v) + 1e-9)
    return v.astype(np.float32).tolist()


def cos_sim(a, b) -> float:
    return float(np.dot(np.asarray(a, dtype=np.float32),
                        np.asarray(b, dtype=np.float32)))


def nearest_correction(h: str, emb: list, corr: dict) -> Optional[str]:
    best, best_d = None, HAMMING_TOL + 1
    for stored_h, rec in corr.items():
        d = hamming(h, stored_h)
        if d < best_d:
            best, best_d = rec["label"], d
    if best is not None:
        return best
    best, best_s = None, SIM_THRESH
    for rec in corr.values():
        v = rec.get("embedding")
        if not v:
            continue
        s = cos_sim(emb, v)
        if s > best_s:
            best, best_s = rec["label"], s
    return best


# ---------- classifier ----------
def build_efficientnet(num_classes: int):
    m = torchvision.models.efficientnet_b0(weights=None)
    in_feat = m.classifier[-1].in_features
    m.classifier[-1] = torch.nn.Linear(in_feat, num_classes)
    return m


def load_classifier(path: str, num_classes: int):
    print(f"Loading classifier: {path}")
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    if isinstance(ckpt, dict):
        for key in ("state_dict", "model_state_dict", "model"):
            if key in ckpt and isinstance(ckpt[key], dict):
                ckpt = ckpt[key]
                break
    if isinstance(ckpt, torch.nn.Module):
        model = ckpt
    else:
        sd = {k.replace("module.", ""): v for k, v in ckpt.items()}
        model = build_efficientnet(num_classes)
        missing, unexpected = model.load_state_dict(sd, strict=False)
        if missing or unexpected:
            print(f"  load_state_dict: missing={len(missing)} unexpected={len(unexpected)}")
    model.eval().to(_DEVICE)
    return model


CLASSIFIER = load_classifier(MODEL_PATH, len(CLASS_NAMES))


@torch.no_grad()
def classify(pil_img: Image.Image):
    x = _tf_224(pil_img.convert("RGB")).unsqueeze(0).to(_DEVICE)
    probs = torch.softmax(CLASSIFIER(x), dim=1).squeeze(0).cpu().numpy()
    idx = int(np.argmax(probs))
    return CLASS_NAMES[idx], float(probs[idx])


# ---------- helpers ----------
def list_images(folder: Path):
    if not folder.exists():
        return []
    return sorted(
        [p for p in folder.iterdir()
         if p.is_file() and p.suffix.lower() in IMG_EXTS],
        key=lambda p: p.name.lower(),
    )


def pil_to_b64(img: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format=fmt, quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def make_thumb(img: Image.Image, max_side: int = THUMB_MAX) -> Image.Image:
    w, h = img.size
    s = max_side / max(w, h)
    if s >= 1:
        return img
    return img.resize((int(w * s), int(h * s)), Image.LANCZOS)


# ---------- HTML ----------
PAGE = """
<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Cable Classifier - Batch Feedback</title>
<style>
 body{font-family:system-ui,Segoe UI,Arial;margin:24px;background:#0f172a;color:#e2e8f0;}
 h1{margin-top:0;color:#38bdf8;}
 .bar{background:#1e293b;padding:10px 14px;border-radius:8px;margin-bottom:16px;
   position:sticky;top:0;z-index:10;}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
   gap:14px;}
 .card{background:#1e293b;padding:12px;border-radius:10px;
   display:flex;flex-direction:column;}
 .card img{width:100%;border-radius:6px;border:1px solid #334155;
   object-fit:contain;background:#0f172a;max-height:260px;}
 .fname{color:#94a3b8;font-size:12px;margin:6px 0 2px;word-break:break-all;}
 .label{font-size:18px;font-weight:700;color:#38bdf8;margin:2px 0 6px;}
 .pill{display:inline-block;padding:2px 8px;border-radius:999px;
   background:#334155;font-size:11px;margin-left:6px;vertical-align:middle;}
 .ok{background:#16a34a;color:#fff;}
 select,button{padding:6px 10px;border-radius:6px;border:1px solid #475569;
   background:#0f172a;color:#e2e8f0;font-size:13px;}
 button{background:#22c55e;color:#0f172a;font-weight:700;cursor:pointer;border:0;
   padding:10px 18px;}
 .radio{margin-right:10px;}
 .flash{background:#16a34a;color:#fff;padding:10px;border-radius:8px;margin-bottom:14px;}
 a{color:#f87171;}
 .muted{color:#94a3b8;font-size:12px;}
</style>
<script>
function toggleSel(i){
  var yes = document.querySelector('input[name="ok_'+i+'"][value="yes"]').checked;
  document.getElementById('sel_'+i).style.display = yes ? 'none' : 'block';
}
</script>
</head><body>

<h1>Cable Classifier - Batch Feedback</h1>

<div class="bar">
  <b>Folder:</b> {{ folder }} &nbsp;|&nbsp;
  <b>Images:</b> {{ items|length }} &nbsp;|&nbsp;
  <b>Stored corrections:</b> {{ n_corr }} &nbsp;|&nbsp;
  <b>Auto-applied this run:</b> {{ auto_fixed }} &nbsp;|&nbsp;
  <a href="{{ url_for('clear') }}">Clear all corrections</a>
</div>

{% if flash %}<div class="flash">{{ flash }}</div>{% endif %}

{% if not items %}
  <p class="muted">No images found in <code>{{ folder }}</code>.
     Supported: jpg, jpeg, png, bmp, webp.</p>
{% else %}
<form method="post" action="{{ url_for('feedback') }}">
<div class="grid">
{% for it in items %}
  <div class="card">
    <img src="data:image/jpeg;base64,{{ it.b64 }}">
    <div class="fname">{{ it.name }}</div>
    <div class="label">{{ it.eff_label }}
      <span class="pill">conf {{ "%.2f"|format(it.conf) }}</span>
      {% if it.auto %}<span class="pill ok">auto</span>{% endif %}
    </div>
    <div>
      <label class="radio"><input type="radio" name="ok_{{ loop.index0 }}" value="yes" checked
        onclick="toggleSel({{ loop.index0 }})"> Yes</label>
      <label class="radio"><input type="radio" name="ok_{{ loop.index0 }}" value="no"
        onclick="toggleSel({{ loop.index0 }})"> No</label>
    </div>
    <div id="sel_{{ loop.index0 }}" style="margin-top:8px;display:none;">
      <select name="cls_{{ loop.index0 }}">
        {% for c in classes %}
          <option value="{{ c }}" {% if c == it.eff_label %}selected{% endif %}>{{ c }}</option>
        {% endfor %}
      </select>
    </div>
    <input type="hidden" name="path_{{ loop.index0 }}"  value="{{ it.path }}">
    <input type="hidden" name="phash_{{ loop.index0 }}" value="{{ it.ph }}">
    <input type="hidden" name="pred_{{ loop.index0 }}"  value="{{ it.pred_label }}">
    <input type="hidden" name="eff_{{ loop.index0 }}"   value="{{ it.eff_label }}">
  </div>
{% endfor %}
</div>
<input type="hidden" name="n" value="{{ items|length }}">
<div style="margin-top:18px;"><button type="submit">Submit all feedback</button></div>
</form>
{% endif %}

</body></html>
"""


# ---------- Flask ----------
app = Flask(__name__)


@app.route("/")
def index():
    flash = request.args.get("flash")
    paths = list_images(IMAGE_DIR)
    corrections = load_corrections()

    items = []
    auto_fixed = 0
    for p in paths:
        try:
            pil = Image.open(p).convert("RGB")
        except Exception as e:
            print(f"Skip {p.name}: {e}")
            continue
        pred, conf = classify(pil)
        ph  = phash(pil)
        emb = embed(pil)
        learned = nearest_correction(ph, emb, corrections)
        auto = bool(learned and learned != pred)
        if auto:
            auto_fixed += 1
        eff = learned if learned else pred

        thumb = make_thumb(pil)
        items.append({
            "path":       str(p),
            "name":       p.name,
            "b64":        pil_to_b64(thumb),
            "pred_label": pred,
            "eff_label":  eff,
            "conf":       conf,
            "ph":         ph,
            "auto":       auto,
        })

    return render_template_string(
        PAGE,
        folder=str(IMAGE_DIR),
        items=items,
        classes=CLASS_NAMES,
        n_corr=len(corrections),
        auto_fixed=auto_fixed,
        flash=flash,
    )


@app.route("/feedback", methods=["POST"])
def feedback():
    n = int(request.form.get("n", "0"))
    corrections = load_corrections()
    changed = 0

    for i in range(n):
        ok    = request.form.get(f"ok_{i}", "yes")
        path  = request.form.get(f"path_{i}")
        ph    = request.form.get(f"phash_{i}")
        pred  = request.form.get(f"pred_{i}")
        eff   = request.form.get(f"eff_{i}")
        cls   = request.form.get(f"cls_{i}")

        final = eff if ok == "yes" else cls
        if not final or not ph or not path:
            continue

        if final != pred:
            try:
                pil = Image.open(path).convert("RGB")
            except Exception as e:
                print(f"Skip feedback for {path}: {e}")
                continue
            corrections[ph] = {
                "label":     final,
                "pred":      pred,
                "source":    Path(path).name,
                "embedding": embed(pil),
                "timestamp": datetime.now().isoformat(timespec="seconds"),
            }
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            pil.save(IMG_DIR / f"{ts}_{final}_{Path(path).stem}.jpg", quality=90)

            # Save into later_use_cables/<class>/  for retraining
            class_dir = LATER_USE_DIR / class_to_folder(final)
            class_dir.mkdir(parents=True, exist_ok=True)
            src = Path(path)
            dst = class_dir / src.name
            if dst.exists():                       # avoid overwrite collisions
                dst = class_dir / f"{src.stem}_{ts}{src.suffix}"
            try:
                dst.write_bytes(src.read_bytes())  # original-quality copy
            except Exception as e:
                print(f"Could not copy {src} -> {dst}: {e}")

            # Push into the central per-model AL store so the
            # retraining pipeline picks this up alongside production
            # feedback.
            try:
                buf = io.BytesIO()
                pil.convert("RGB").save(buf, format="JPEG", quality=88)
                _STORE_CABLE.add({
                    "source":    "flask_ui",
                    "predicted": {"cable_color": pred},
                    "actual":    {"cable_color": final},
                    "metadata":  {
                        "phash":      ph,
                        "source_path": str(path),
                    },
                }, image_bytes=buf.getvalue())
            except Exception as e:
                print(f"[WARN] failed to push to AL store: {e}")
            changed += 1

    save_corrections(corrections)
    return redirect(url_for("index",
        flash=f"Saved. {changed} new / updated correction(s)."))


@app.route("/clear")
def clear():
    save_corrections({})
    return redirect(url_for("index", flash="All stored corrections cleared."))


if __name__ == "__main__":
    # Default to loopback so the labelling UI isn't exposed to the network.
    # Set ACTIVE_LEARNING_HOST=0.0.0.0 (or a specific IP) when running inside
    # Docker / k8s where the UI must be reachable from outside the container.
    import os as _os
    _host = _os.environ.get("ACTIVE_LEARNING_HOST", "127.0.0.1")
    _port = int(_os.environ.get("CABLE_LEARNING_PORT", "5001"))
    app.run(host=_host, port=_port, debug=False)
