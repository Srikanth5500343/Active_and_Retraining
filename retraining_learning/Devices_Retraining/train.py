from ultralytics import YOLO
import os
import sys

# Force UTF-8 console output — print() at the end uses emoji that Windows'
# default cp1252 codec can't encode, which would otherwise raise
# UnicodeEncodeError after training completes.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------- CONFIG ----------------
# Paths are derived script-relative so the pipeline is portable.
SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT     = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
DATA_YAML     = os.path.join(SCRIPT_DIR, "final_dataset", "data.yaml")

# Continue-train from the current production device model so the new
# corrections build on top of what the model already learned. Falls back to
# stock yolov8l.pt if the production weights are missing.
PROD_MODEL    = os.path.join(REPO_ROOT, "Models", "best 32.pt")
MODEL_WEIGHTS = PROD_MODEL if os.path.exists(PROD_MODEL) else "yolov8l.pt"

EPOCHS = 50
IMG_SIZE = 640
BATCH_SIZE = 4   # ⚠️ reduce for CPU
PROJECT = os.path.join(SCRIPT_DIR, "runs", "train")
NAME = "rack_device_model_v1"

# ---------------- LOAD MODEL ----------------
model = YOLO(MODEL_WEIGHTS)

# ---------------- TRAIN ----------------
results = model.train(
    data=DATA_YAML,
    epochs=EPOCHS,
    imgsz=IMG_SIZE,
    batch=BATCH_SIZE,
    project=PROJECT,
    name=NAME,
    pretrained=True,
    patience=20,
    workers=2,          # ⚠️ reduce for CPU
    device="cpu",       # ✅ FIXED
    optimizer="auto",
    lr0=0.01,
    verbose=True
)

print("\n✅ Training completed!")
print(f"Best model saved at: {os.path.join(PROJECT, NAME, 'weights', 'best.pt')}")
