from ultralytics import YOLO
import os

# ---------------- CONFIG ----------------
DATA_YAML = r"C:\Users\GeethikaPallelapati\Downloads\Retraining\final_dataset\data.yaml"
MODEL_WEIGHTS = "yolov8l.pt"

EPOCHS = 50
IMG_SIZE = 640
BATCH_SIZE = 4   # ⚠️ reduce for CPU
PROJECT = "runs/train"
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