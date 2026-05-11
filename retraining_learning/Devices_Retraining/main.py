import time
import subprocess
import os

# ---------------- CONFIG ----------------
NEW_DATA_PATH = r"C:\Users\GeethikaPallelapati\Downloads\Test_Image\Test_Image"
THRESHOLD = 100

# ---------------- CHECK DATA ----------------
def check_dataset_ready():
    images = [
        f for f in os.listdir(NEW_DATA_PATH)
        if f.lower().endswith((".jpg",".png",".jpeg")) and "_aug" not in f
    ]
    return len(images)

# ---------------- RUN SCRIPT ----------------
def run_script(script_name):
    print(f"\n🚀 Running {script_name} ...\n")
    result = subprocess.run(["python", script_name])

    if result.returncode != 0:
        print(f"❌ Error running {script_name}")
        exit()
    else:
        print(f"✅ {script_name} completed")

# ---------------- MAIN PIPELINE ----------------
def main():
    print("🔥 FULL AUTO PIPELINE STARTED\n")

    # Step 1: Start labeling tool (Flask app)
    print("🧠 Step 1: Start labeling tool (device.py)")
    subprocess.Popen(["python", "device.py"])

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

# ---------------- RUN ----------------
if __name__ == "__main__":
    main()