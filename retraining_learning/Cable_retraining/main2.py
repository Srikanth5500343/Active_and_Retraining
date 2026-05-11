import os
import time
import subprocess

# =========================
# CONFIG
# =========================
FEEDBACK_DIR = "feedback_dir"
REQUIRED_CLASSES = 14
MIN_IMAGES_PER_CLASS = 20   # <-- change as needed
CHECK_INTERVAL = 10         # seconds

# =========================
# CHECK DATASET READY
# =========================
def is_dataset_ready():
    if not os.path.exists(FEEDBACK_DIR):
        return False

    class_folders = [
        f for f in os.listdir(FEEDBACK_DIR)
        if os.path.isdir(os.path.join(FEEDBACK_DIR, f))
    ]

    if len(class_folders) < REQUIRED_CLASSES:
        print(f"⏳ Only {len(class_folders)}/{REQUIRED_CLASSES} folders found")
        return False

    for folder in class_folders:
        path = os.path.join(FEEDBACK_DIR, folder)
        num_images = len([
            f for f in os.listdir(path)
            if f.lower().endswith((".jpg", ".png", ".jpeg"))
        ])

        if num_images < MIN_IMAGES_PER_CLASS:
            print(f"⏳ {folder}: {num_images}/{MIN_IMAGES_PER_CLASS} images")
            return False

    print("✅ Dataset ready for next step")
    return True


# =========================
# RUN SCRIPT
# =========================
def run_script(script_name):
    print(f"\n🚀 Running {script_name}...")
    subprocess.run(["python", script_name])


# =========================
# MAIN PIPELINE
# =========================
if __name__ == "__main__":

    # STEP 1: Run cable.py
    run_script("cable.py")

    print("\n🧠 Waiting for dataset completion...")

    # STEP 2: Wait until dataset is ready
    while True:
        if is_dataset_ready():
            break
        time.sleep(CHECK_INTERVAL)

    # STEP 3: Run dataset.py
    run_script("dataset.py")

    # STEP 4: Run training
    run_script("train2.py")

    print("\n🎉 FULL PIPELINE COMPLETED SUCCESSFULLY")