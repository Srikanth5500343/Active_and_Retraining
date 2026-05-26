import time
import subprocess
import os
import shutil
import sys

# Force UTF-8 console output — the print() statements below use emoji that
# Windows' default cp1252 codec can't encode, and an unhandled
# UnicodeEncodeError on the first print crashes the pipeline.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------- CONFIG ----------------
# Labeling now happens inside the React UI (POST /api/feedback/device writes
# directly into review_dataset/images and /labels), so we poll that folder
# instead of the standalone device.py Flask labeler.
SCRIPT_DIR     = os.path.dirname(os.path.abspath(__file__))
NEW_DATA_PATH  = os.path.join(SCRIPT_DIR, "review_dataset", "images")
# Pull THRESHOLD from createdataset.py so there's one source of truth — when
# you bump it (3 for testing, 100 for prod), main.py picks it up automatically.
sys.path.insert(0, SCRIPT_DIR)
try:
    from createdataset import THRESHOLD as THRESHOLD
except Exception:
    THRESHOLD = 100

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
    result = subprocess.run([sys.executable, os.path.join(SCRIPT_DIR, script_name)],
                            cwd=SCRIPT_DIR)

    if result.returncode != 0:
        print(f"❌ Error running {script_name}")
        exit()
    else:
        print(f"✅ {script_name} completed")

# ---------------- POST-RETRAIN CLEANUP ----------------
def post_retrain_cleanup():
    """Run AFTER train.py succeeds. Two jobs:
       1. Promote final_dataset/ → prev_dataset/ so the NEXT retrain pulls its
          70% sample from this just-built dataset (the model's knowledge
          evolves instead of being yanked back to the original bootstrap).
       2. Wipe review_dataset/{images,labels}/ so it starts collecting the
          NEXT round of UI corrections from a clean slate.
    """
    final_dir  = os.path.join(SCRIPT_DIR, "final_dataset")
    prev_dir   = os.path.join(SCRIPT_DIR, "prev_dataset")
    review_img = os.path.join(SCRIPT_DIR, "review_dataset", "images")
    review_lbl = os.path.join(SCRIPT_DIR, "review_dataset", "labels")

    # 1. Promote final_dataset → prev_dataset (replaces any existing one)
    if os.path.isdir(final_dir):
        if os.path.isdir(prev_dir):
            shutil.rmtree(prev_dir)
        shutil.move(final_dir, prev_dir)
        print(f"📦 Archived final_dataset → prev_dataset (next 70%-old source)")
    else:
        print("⚠️ final_dataset/ missing — nothing to promote.")

    # 2. Wipe review_dataset content (keep the directories themselves)
    wiped = 0
    for d in (review_img, review_lbl):
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            fp = os.path.join(d, f)
            try:
                if os.path.isfile(fp):
                    os.remove(fp)
                    wiped += 1
            except Exception as e:
                print(f"⚠️ couldn't remove {fp}: {e}")
    print(f"🧹 review_dataset cleared ({wiped} files) — ready for next round of UI corrections.")

# ---------------- ONE-SHOT PIPELINE ----------------
def run_pipeline_once():
    """Build the merged dataset, retrain, then clean up."""
    print("\n📦 Step 1: Creating dataset...")
    run_script("createdataset.py")

    print("\n🤖 Step 2: Training model...")
    run_script("train.py")

    # Only runs if both scripts above succeeded — run_script() exits on failure.
    print("\n🧹 Step 3: Post-retrain cleanup...")
    post_retrain_cleanup()

    print("\n🎉 PIPELINE COMPLETED SUCCESSFULLY!")

# ---------------- MAIN PIPELINE ----------------
def main():
    import argparse
    ap = argparse.ArgumentParser(description="Devices retraining pipeline.")
    ap.add_argument("--once", action="store_true",
                    help="Single-shot: check threshold; if met, build dataset + train, then exit. "
                         "If not met, exit immediately. Use this from the server auto-trigger.")
    args = ap.parse_args()

    if args.once:
        count = check_dataset_ready()
        print(f"📊 Labeled images in review_dataset: {count} (threshold: {THRESHOLD})")
        if count < THRESHOLD:
            print(f"⏳ Below threshold — need {THRESHOLD - count} more. Skipping retrain.")
            return
        print("✅ Threshold reached.")
        run_pipeline_once()
        return

    # Original interactive mode: poll until threshold hits, then run once.
    print("🔥 FULL AUTO PIPELINE STARTED\n")
    print("⏳ Waiting for labeled data from the UI...")

    while True:
        count = check_dataset_ready()
        print(f"📊 Current labeled images: {count}")

        if count >= THRESHOLD:
            print("✅ Dataset threshold reached!")
            break

        time.sleep(10)  # check every 10 sec

    run_pipeline_once()

# ---------------- RUN ----------------
if __name__ == "__main__":
    main()
