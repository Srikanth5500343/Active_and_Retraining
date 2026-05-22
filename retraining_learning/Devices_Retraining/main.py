import atexit
import os
import subprocess
import sys
import time

# ---------------- CONFIG ----------------
# Overridable via DEVICES_RETRAINING_DATA_PATH so the script isn't tied to a
# specific developer machine.
NEW_DATA_PATH = os.environ.get(
    "DEVICES_RETRAINING_DATA_PATH",
    r"C:\Users\GeethikaPallelapati\Downloads\Test_Image\Test_Image",
)
THRESHOLD = int(os.environ.get("DEVICES_RETRAINING_THRESHOLD", "100"))

# ---------------- CHECK DATA ----------------
def check_dataset_ready():
    if not os.path.isdir(NEW_DATA_PATH):
        return 0
    images = [
        f for f in os.listdir(NEW_DATA_PATH)
        if f.lower().endswith((".jpg",".png",".jpeg")) and "_aug" not in f
    ]
    return len(images)

# ---------------- RUN SCRIPT ----------------
def run_script(script_name):
    print(f"\n🚀 Running {script_name} ...\n")
    result = subprocess.run([sys.executable, script_name])

    if result.returncode != 0:
        print(f"❌ Error running {script_name}")
        sys.exit(1)
    else:
        print(f"✅ {script_name} completed")

# ---------------- MAIN PIPELINE ----------------
def main():
    print("🔥 FULL AUTO PIPELINE STARTED\n")

    # Step 1: Start labeling tool (Flask app). Track the child so we can
    # tear it down on exit / Ctrl+C — without this the Flask process keeps
    # running after the pipeline ends.
    print("🧠 Step 1: Start labeling tool (device.py)")
    flask_child = subprocess.Popen([sys.executable, "device.py"])

    def _kill_flask():
        if flask_child.poll() is None:
            try: flask_child.terminate()
            except Exception: pass
            try: flask_child.wait(timeout=5)
            except Exception:
                try: flask_child.kill()
                except Exception: pass
    atexit.register(_kill_flask)

    try:
        # Step 2: Wait for dataset to reach threshold
        print("\n⏳ Waiting for labeled data...")

        while True:
            count = check_dataset_ready()
            print(f"📊 Current labeled images: {count}")

            if count >= THRESHOLD:
                print("✅ Dataset threshold reached!")
                break

            time.sleep(10)  # check every 10 sec

        # Step 3: Create final dataset
        print("\n📦 Step 2: Creating dataset...")
        run_script("createdataset.py")

        # Step 4: Train model
        print("\n🤖 Step 3: Training model...")
        run_script("train.py")

        print("\n🎉 PIPELINE COMPLETED SUCCESSFULLY!")
    finally:
        _kill_flask()

# ---------------- RUN ----------------
if __name__ == "__main__":
    main()