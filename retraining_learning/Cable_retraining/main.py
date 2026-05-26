"""
Cable_retraining/main.py — one-shot pipeline runner for the cable
classifier retrain. Mirrors Devices_Retraining/main.py.

UI corrections land in feedback_dir/<14 class folders>/ via the
server's /api/feedback/cable-color endpoint. After enough samples
accumulate, the server kicks `python main.py --once`, which:

  1. Checks the threshold (≥THRESHOLD images in every class folder).
  2. Runs dataset.py to build final_dataset/{train,val,test}/<class>/.
  3. Runs train2.py to fine-tune from Models/best_model_efficientnet.pth.
  4. Promotes final_dataset/ → prev_dataset/ (so next cycle's "old data"
     is the just-trained dataset, not a stale snapshot).
  5. Wipes feedback_dir/<*>/ so it starts collecting fresh corrections.

Run without --once for the legacy interactive mode (polls every 10s
until threshold and runs once).
"""

import os
import shutil
import subprocess
import sys
import time

# Force UTF-8 console — the print() lines below use emoji that Windows'
# default cp1252 codec can't encode. A single UnicodeEncodeError on the
# first print would crash the pipeline before it even gets started.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------- CONFIG ----------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REVIEW_DIR = os.path.join(SCRIPT_DIR, "feedback_dir")
FINAL_DIR  = os.path.join(SCRIPT_DIR, "final_dataset")
PREV_DIR   = os.path.join(SCRIPT_DIR, "prev_dataset")

# Pull THRESHOLD + CLASSES from dataset.py so there's one source of truth —
# bumping the threshold there (1 for testing, ~15-20 for prod) is picked up
# here automatically.
sys.path.insert(0, SCRIPT_DIR)
try:
    from dataset import THRESHOLD as THRESHOLD, CLASSES as CLASSES
except Exception:
    THRESHOLD = 1
    CLASSES   = []

CHECK_INTERVAL = 10  # seconds — interactive mode only

# ---------------- THRESHOLD CHECK ----------------
def class_image_counts():
    counts = {}
    for cls in CLASSES:
        d = os.path.join(REVIEW_DIR, cls)
        if not os.path.isdir(d):
            counts[cls] = 0
            continue
        counts[cls] = sum(1 for f in os.listdir(d)
                          if f.lower().endswith((".jpg", ".jpeg", ".png")))
    return counts

def threshold_met():
    counts = class_image_counts()
    short = [(c, n) for c, n in counts.items() if n < THRESHOLD]
    if short:
        for c, n in short:
            print(f"  ⏳ {c}: {n}/{THRESHOLD}")
        return False
    print(f"✅ All {len(CLASSES)} class folders ≥ {THRESHOLD} image(s).")
    return True

# ---------------- RUN A STEP ----------------
def run_script(name):
    print(f"\n🚀 Running {name} …")
    result = subprocess.run([sys.executable, os.path.join(SCRIPT_DIR, name)],
                            cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print(f"❌ {name} failed (exit {result.returncode}) — aborting pipeline.")
        sys.exit(result.returncode)
    print(f"✅ {name} completed")

# ---------------- POST-RETRAIN CLEANUP ----------------
def post_retrain_cleanup():
    """1. Promote final_dataset/ → prev_dataset/ so the NEXT cycle's "old"
          source is the just-trained dataset (model knowledge evolves
          instead of being yanked back to the original bootstrap).
       2. Wipe feedback_dir/<*>/ so it starts the next round empty."""
    # Promote final → prev (replace any existing prev)
    if os.path.isdir(FINAL_DIR):
        if os.path.isdir(PREV_DIR):
            shutil.rmtree(PREV_DIR)
        shutil.move(FINAL_DIR, PREV_DIR)
        print("📦 Archived final_dataset → prev_dataset (next cycle's OLD source)")
    else:
        print("⚠️  final_dataset/ missing — nothing to promote.")

    # Wipe feedback_dir content (keep the class folders themselves)
    wiped = 0
    for cls in CLASSES:
        d = os.path.join(REVIEW_DIR, cls)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            fp = os.path.join(d, f)
            try:
                if os.path.isfile(fp):
                    os.remove(fp)
                    wiped += 1
            except Exception as e:
                print(f"⚠️  couldn't remove {fp}: {e}")
    print(f"🧹 feedback_dir cleared ({wiped} files) — ready for next round.")

# ---------------- ONE-SHOT PIPELINE ----------------
def run_pipeline_once():
    print("\n📦 Step 1: Building dataset…")
    run_script("dataset.py")
    print("\n🤖 Step 2: Training model…")
    run_script("train2.py")
    print("\n🧹 Step 3: Post-retrain cleanup…")
    post_retrain_cleanup()
    print("\n🎉 PIPELINE COMPLETED SUCCESSFULLY")

# ---------------- MAIN ----------------
def main():
    import argparse
    ap = argparse.ArgumentParser(description="Cable retraining pipeline.")
    ap.add_argument("--once", action="store_true",
                    help="Single-shot: check threshold; if met, build dataset + train, then exit. "
                         "If not met, exit immediately. Used by the server auto-trigger.")
    args = ap.parse_args()

    if args.once:
        print(f"📊 Checking feedback_dir/ against THRESHOLD={THRESHOLD} per class…")
        if not threshold_met():
            print("⏳ Below threshold — skipping retrain.")
            return
        run_pipeline_once()
        return

    # Interactive: poll until every class is at threshold, then run once.
    print("🔥 CABLE RETRAINING PIPELINE STARTED\n")
    print("⏳ Waiting for labeled data from the UI…")
    while True:
        print(f"\n📊 Checking feedback_dir/ against THRESHOLD={THRESHOLD} per class…")
        if threshold_met():
            break
        time.sleep(CHECK_INTERVAL)
    run_pipeline_once()

if __name__ == "__main__":
    main()
