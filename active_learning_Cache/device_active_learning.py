
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
from PIL import Image, ImageDraw, ImageFont
from ultralytics import YOLO
from flask import Flask, request, redirect, url_for, render_template_string

# Make the active_learning_Cache package importable when this script
# is run directly (`python device_active_learning.py`).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from active_learning_Cache import config as al_config
from active_learning_Cache.store import Store


# ---------- config ----------
# All paths derived from the central package config so the layout is
# portable (no hard-coded D:\ paths). Override IMAGE_PATH or
# RACKTRACK_DEVICES_MODEL via env if you want to point at something
# other than the production device-detector model.
REPO_ROOT    = al_config.REPO_ROOT
IMAGE_PATH   = os.environ.get("RACKTRACK_AL_IMAGE",
    str(REPO_ROOT / "outputs" / "device_unit_annotation.png"))
# Resolve the production model path from config.json (same one the
# live pipeline uses) — falls back to a sensible default in Models/.
def _default_devices_model():
    cfg_path = REPO_ROOT / "config.json"
    try:
        models = json.loads(cfg_path.read_text(encoding="utf-8"))["models"]
        rel = models.get("devices") or "Models/best 32.pt"
    except Exception:
        rel = "Models/best 32.pt"
    return str(REPO_ROOT / rel)
MODEL_PATH   = os.environ.get("RACKTRACK_DEVICES_MODEL", _default_devices_model())

# Per-script crops dir (kept ALONGSIDE the AL store, not inside it,
# so wiping it doesn't blow away the queue).
FEEDBACK_DIR = REPO_ROOT / "active_learning_Cache" / "data" / ".flask_devices"
CORR_FILE   = FEEDBACK_DIR / "corrections.json"
CROP_DIR    = FEEDBACK_DIR / "crops"
for d in (FEEDBACK_DIR, CROP_DIR):
    d.mkdir(parents=True, exist_ok=True)

HASH_SIZE    = 16
HAMMING_TOL  = 6        # exact-ish match on perceptual hash (fast path)
SIM_THRESH   = 0.88     # cosine similarity on deep features (robust path)

# Wire this Flask UI into the central per-model store so corrections
# made here flow into the same retraining pipeline as production
# feedback.
_STORE_DEVICES = Store("devices")


# ---------- perceptual hash ----------
def phash(pil_img: Image.Image, size: int = HASH_SIZE) -> str:
    g = pil_img.convert("L").resize((size, size), Image.BILINEAR)
    arr = np.asarray(g, dtype=np.float32)
    bits = (arr > arr.mean()).flatten()
    return "".join("1" if b else "0" for b in bits)


def hamming(a: str, b: str) -> int:
    return sum(c1 != c2 for c1, c2 in zip(a, b)) if len(a) == len(b) else 10**9


# ---------- deep-feature embedder (robust to angle / lighting / crop) ----------
print("Loading embedder (ResNet18)...")
_DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_emb_model = torchvision.models.resnet18(
    weights=torchvision.models.ResNet18_Weights.DEFAULT
)
_emb_model.fc = torch.nn.Identity()
_emb_model.eval().to(_DEVICE)
_emb_tf = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406],
                         std=[0.229, 0.224, 0.225]),
])


@torch.no_grad()
def embed(pil_img: Image.Image) -> list:
    x = _emb_tf(pil_img.convert("RGB")).unsqueeze(0).to(_DEVICE)
    v = _emb_model(x).squeeze(0).cpu().numpy()
    v = v / (np.linalg.norm(v) + 1e-9)
    return v.astype(np.float32).tolist()


def cos_sim(a, b) -> float:
    return float(np.dot(np.asarray(a, dtype=np.float32),
                        np.asarray(b, dtype=np.float32)))


# ---------- persistence ----------
def load_corrections() -> dict:
    return json.loads(CORR_FILE.read_text()) if CORR_FILE.exists() else {}


def save_corrections(c: dict) -> None:
    CORR_FILE.write_text(json.dumps(c, indent=2))


def nearest_correction(h: str, emb: list, corr: dict) -> Optional[str]:
    """First try perceptual-hash (cheap, exact). Fall back to deep-feature
    cosine similarity, which handles angle/lighting/crop changes."""
    # Fast path: pHash
    best, best_d = None, HAMMING_TOL + 1
    for stored_h, rec in corr.items():
        d = hamming(h, stored_h)
        if d < best_d:
            best, best_d = rec["label"], d
    if best is not None:
        return best
    # Robust path: ResNet18 embedding cosine similarity
    best, best_s = None, SIM_THRESH
    for rec in corr.values():
        v = rec.get("embedding")
        if not v:
            continue
        s = cos_sim(emb, v)
        if s > best_s:
            best, best_s = rec["label"], s
    return best


# ---------- image helpers ----------
def pil_to_b64(img: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format=fmt, quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def draw_boxes(pil_img: Image.Image, dets, labels):
    img = pil_img.copy()
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", max(14, img.size[1] // 60))
    except Exception:
        font = ImageFont.load_default()
    for d, lbl in zip(dets, labels):
        x1, y1, x2, y2 = d["box"]
        draw.rectangle([x1, y1, x2, y2], outline="lime", width=3)
        draw.text((x1 + 3, max(0, y1 - 18)), lbl, fill="lime", font=font)
    return img


# ---------- model & detection ----------
print("Loading model...")
MODEL = YOLO(MODEL_PATH)
CLASS_MAP  = MODEL.names                                   # {id: name}
CLASS_LIST = [CLASS_MAP[i] for i in sorted(CLASS_MAP)]
print(f"Model loaded. {len(CLASS_LIST)} classes.")


def run_detection(pil_img: Image.Image):
    res = MODEL.predict(pil_img, verbose=False)[0]
    out = []
    if res.boxes is None or len(res.boxes) == 0:
        return out
    xyxy  = res.boxes.xyxy.cpu().numpy()
    confs = res.boxes.conf.cpu().numpy()
    clses = res.boxes.cls.cpu().numpy().astype(int)
    for (x1, y1, x2, y2), c, k in zip(xyxy, confs, clses):
        crop = pil_img.crop((int(x1), int(y1), int(x2), int(y2)))
        out.append({
            "box":        (int(x1), int(y1), int(x2), int(y2)),
            "crop":       crop,
            "pred_label": CLASS_MAP[int(k)],
            "conf":       float(c),
            "phash":      phash(crop),
            "embedding":  embed(crop),
        })
    return out


# ---------- YOLO dataset writer ----------
def save_as_yolo(src_img: Image.Image, dets, final_labels):
    name2id = {n: i for i, n in CLASS_MAP.items()}
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    img_p = IMG_OUT_DIR / f"{ts}.jpg"
    lbl_p = LBL_OUT_DIR / f"{ts}.txt"
    src_img.convert("RGB").save(img_p, quality=92)
    W, H = src_img.size
    lines = []
    for d, lbl in zip(dets, final_labels):
        if lbl not in name2id:
            continue
        x1, y1, x2, y2 = d["box"]
        xc = ((x1 + x2) / 2) / W
        yc = ((y1 + y2) / 2) / H
        bw = (x2 - x1) / W
        bh = (y2 - y1) / H
        lines.append(f"{name2id[lbl]} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}")
    lbl_p.write_text("\n".join(lines))
    return img_p, lbl_p


# ---------- HTML template ----------
PAGE = """
<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Rack Device Feedback</title>
<style>
 body{font-family:system-ui,Segoe UI,Arial;margin:24px;background:#0f172a;color:#e2e8f0;}
 h1{margin-top:0;color:#38bdf8;}
 .bar{background:#1e293b;padding:10px 14px;border-radius:8px;margin-bottom:16px;}
 .imgs{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px;}
 .imgs img{max-width:48%;border:1px solid #334155;border-radius:8px;}
 .det{display:flex;gap:16px;align-items:center;background:#1e293b;
      padding:12px;border-radius:8px;margin-bottom:10px;}
 .det img{width:160px;border-radius:6px;border:1px solid #334155;}
 .meta{flex:1;}
 .meta b{color:#38bdf8;}
 select,button{padding:6px 10px;border-radius:6px;border:1px solid #475569;
   background:#0f172a;color:#e2e8f0;}
 button{background:#22c55e;color:#0f172a;font-weight:600;cursor:pointer;border:0;}
 .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#334155;
   font-size:12px;margin-left:6px;}
 .ok{background:#16a34a;color:#fff;}
 label{margin-right:8px;}
 .flash{background:#16a34a;color:#fff;padding:10px;border-radius:8px;margin-bottom:14px;}
</style>
</head><body>

<h1>Rack Device Detection - Feedback</h1>

<div class="bar">
  <b>Image:</b> {{ image_path }} &nbsp;|&nbsp;
  <b>Detections:</b> {{ dets|length }} &nbsp;|&nbsp;
  <b>Stored corrections:</b> {{ n_corr }} &nbsp;|&nbsp;
  <b>Auto-applied this run:</b> {{ auto_fixed }} &nbsp;|&nbsp;
  <a href="{{ url_for('clear') }}" style="color:#f87171;">Clear all corrections</a>
</div>

{% if flash %}<div class="flash">{{ flash }}</div>{% endif %}

<div class="imgs">
  <div><div>Original</div>
       <img src="data:image/jpeg;base64,{{ orig_b64 }}"></div>
  <div><div>Detected + corrected</div>
       <img src="data:image/jpeg;base64,{{ ann_b64 }}"></div>
</div>

<form method="post" action="{{ url_for('feedback') }}">
{% for d in dets %}
  <div class="det">
    <img src="data:image/jpeg;base64,{{ d.crop_b64 }}">
    <div class="meta">
      <div><b>Detected:</b> {{ d.eff_label }}
           <span class="pill">conf {{ "%.2f"|format(d.conf) }}</span>
      </div>
      <div style="margin-top:8px;">
        Is this correct?
        <label><input type="radio" name="ok_{{ loop.index0 }}" value="yes" checked onclick="document.getElementById('sel_{{ loop.index0 }}').style.display='none'"> Yes</label>
        <label><input type="radio" name="ok_{{ loop.index0 }}" value="no" onclick="document.getElementById('sel_{{ loop.index0 }}').style.display='inline-block'"> No</label>
      </div>
      <div id="sel_{{ loop.index0 }}" style="margin-top:8px;display:none;">
        Pick the true class:
        <select name="cls_{{ loop.index0 }}">
          {% for c in classes %}
            <option value="{{ c }}" {% if c == d.eff_label %}selected{% endif %}>{{ c }}</option>
          {% endfor %}
        </select>
        <input type="hidden" name="phash_{{ loop.index0 }}" value="{{ d.phash }}">
        <input type="hidden" name="pred_{{ loop.index0 }}"  value="{{ d.pred_label }}">
        <input type="hidden" name="box_{{ loop.index0 }}"   value="{{ d.box|join(',') }}">
      </div>
    </div>
  </div>
{% endfor %}
  <input type="hidden" name="n" value="{{ dets|length }}">
  <button type="submit">Submit feedback</button>
</form>

</body></html>
"""

# ---------- Flask ----------
app = Flask(__name__)


@app.route("/")
def index():
    flash = request.args.get("flash")
    if not Path(IMAGE_PATH).exists():
        return f"<h2>IMAGE_PATH not found:</h2><pre>{IMAGE_PATH}</pre>", 500

    pil = Image.open(IMAGE_PATH).convert("RGB")
    dets = run_detection(pil)
    corrections = load_corrections()

    auto_fixed = 0
    view = []
    for d in dets:
        learned = nearest_correction(d["phash"], d["embedding"], corrections)
        eff = learned if learned else d["pred_label"]
        auto = bool(learned and learned != d["pred_label"])
        if auto:
            auto_fixed += 1
        view.append({
            "crop_b64":   pil_to_b64(d["crop"]),
            "pred_label": d["pred_label"],
            "eff_label":  eff,
            "conf":       d["conf"],
            "phash":      d["phash"],
            "box":        d["box"],
            "auto":       auto,
        })

    annotated = draw_boxes(pil, dets, [v["eff_label"] for v in view])
    return render_template_string(
        PAGE,
        image_path=IMAGE_PATH,
        dets=view,
        classes=CLASS_LIST,
        n_corr=len(corrections),
        auto_fixed=auto_fixed,
        orig_b64=pil_to_b64(pil),
        ann_b64=pil_to_b64(annotated),
        flash=flash,
    )


@app.route("/feedback", methods=["POST"])
def feedback():
    n = int(request.form["n"])
    pil = Image.open(IMAGE_PATH).convert("RGB")
    corrections = load_corrections()

    dets, finals, changed = [], [], 0
    for i in range(n):
        cls   = request.form.get(f"cls_{i}")
        ph    = request.form.get(f"phash_{i}")
        pred  = request.form.get(f"pred_{i}")
        box   = tuple(int(v) for v in request.form.get(f"box_{i}", "0,0,0,0").split(","))
        crop  = pil.crop(box)

        if cls != pred:
            corrections[ph] = {
                "label":     cls,
                "pred":      pred,
                "embedding": embed(crop),
                "timestamp": datetime.now().isoformat(timespec="seconds"),
            }
            crop.save(CROP_DIR / f"{ph[:16]}_{cls}.jpg")

            # Also push into the central per-model Store so this
            # correction flows into the retraining pipeline like
            # production feedback would.
            try:
                buf = io.BytesIO()
                crop.convert("RGB").save(buf, format="JPEG", quality=88)
                _STORE_DEVICES.add({
                    "source":    "flask_ui",
                    "predicted": {"class": pred},
                    "actual":    {"class": cls},
                    "metadata":  {
                        "phash":     ph,
                        "device_box": list(box),
                        "image_path": str(IMAGE_PATH),
                    },
                }, image_bytes=buf.getvalue())
            except Exception as e:
                print(f"[WARN] failed to push to AL store: {e}")
            changed += 1

        dets.append({"box": box})
        finals.append(cls)

    save_corrections(corrections)
    _, lbl_p = save_as_yolo(pil, dets, finals)
    msg = f"Saved {changed} new correction(s). YOLO sample: {lbl_p.name}"
    return redirect(url_for("index", flash=msg))


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
    _port = int(_os.environ.get("DEVICE_LEARNING_PORT", "5050"))
    app.run(host=_host, port=_port, debug=False)
