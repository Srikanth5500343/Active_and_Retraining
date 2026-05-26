"""
Cable_retraining/dataset.py — build a train/val/test dataset for the cable
classifier from feedback that the React UI staged into feedback_dir/.

Pipeline (analog to Devices_Retraining/createdataset.py):
  feedback_dir/<14 class folders>/<*.jpg>     ← UI corrections (NEW samples)
  prev_dataset/<train|val|test>/<class>/        ← last retrain's output (OLD)
                       OR
  OLD_BASE bootstrap split (optional fallback)  ← original dataset, if accessible

Output:
  final_dataset/<train|val|test>/<class>/<*.jpg>

The 14 class folders are the cable model's existing label space and MUST stay
in lockstep with runner_adapter.py:CLASS_NAMES + cable_classification flow on
the server (server/app.js:CABLE_CLASS_FOLDERS / cableClassFolder()).

Labeling now happens INSIDE the React UI — the user marks a color wrong on
the Port Located card, picks the actual color, and the server crops the
detected port patch into feedback_dir/<class>/. There's no longer a
standalone Flask/HTML labeler (cable.py / cable_classification_upd_4.html).

Threshold for the testing phase is THRESHOLD = 1 image per class. Raise it
in this file when you're ready for real retraining — main.py reads the same
constant so the two stay in sync.
"""

import os
import sys
import cv2
import shutil
import random

import albumentations as A
from tqdm import tqdm

# Force UTF-8 console — Windows' default cp1252 codec can't encode the emoji
# in print() calls below; an unhandled UnicodeEncodeError on the first print
# would crash the whole pipeline.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------- CONFIG ----------------
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))

# NEW samples staged by the React UI (one folder per class). Server endpoint
# /api/feedback/cable-color writes here.
REVIEW_DIR  = os.path.join(SCRIPT_DIR, "feedback_dir")

# OLD source #1: last retrain's output, promoted by main.py after a
# successful train2.py run. Same layout as FINAL_DIR. Preferred over
# OLD_BASE so the model's old knowledge evolves with each cycle.
PREV_DIR    = os.path.join(SCRIPT_DIR, "prev_dataset")

# OLD source #2: original bootstrap dataset. Network shares often aren't
# reachable on a dev machine — if this path doesn't resolve, we skip the
# OLD merge entirely and train on NEW + (whatever's in PREV_DIR).
OLD_BASE    = r"\\192.168.1.29\Sharing folder\shankar\dataset_dir"

FINAL_DIR   = os.path.join(SCRIPT_DIR, "final_dataset")

# 🔴 Testing mode: 1 image per class is enough to fire the pipeline. Raise
# this to ~15-20 once we're done validating the end-to-end glue.
THRESHOLD   = 15

# Train/val/test split applied AFTER augmentation, per class.
TRAIN_RATIO = 0.70
VAL_RATIO   = 0.15
# TEST_RATIO is the remainder.

random.seed(42)

# Folder names == cable model's 14 classes with spaces→underscores. Stays in
# lockstep with server/app.js:CABLE_CLASS_FOLDERS — adding/removing a class
# requires updating BOTH.
CLASSES = [
    "LC_Aqua",
    "RJ-45_Violet",   # legacy: model uses a dash for this one class
    "RJ_45_Black", "RJ_45_Blue", "RJ_45_Brown", "RJ_45_Green", "RJ_45_Grey",
    "RJ_45_Orange", "RJ_45_Pink", "RJ_45_Red", "RJ_45_White", "RJ_45_Yellow",
    "SC_Orange", "SC_Yellow",
]

# ---------------- AUGMENTATIONS ----------------
# Same set the original dataset.py used — these expand each user-corrected
# crop into ~13 training samples so a 1-image-per-class threshold isn't
# completely useless during testing.
AUGMENTATIONS = [
    ("rotation",        A.Rotate(limit=30, p=1)),
    ("gaussian_blur",   A.GaussianBlur(blur_limit=(3, 5), p=1)),
    ("fog",             A.RandomFog(fog_coef_lower=0.1, fog_coef_upper=0.2, p=1)),
    ("random_crop",     A.RandomCrop(width=200, height=200, p=1)),
    ("mirror",          A.HorizontalFlip(p=1)),
    ("zoom_in",         A.RandomScale(scale_limit=(0.1, 0.3), p=1)),
    ("sharpen",         A.Sharpen(p=1)),
    ("brightness",      A.RandomBrightnessContrast(brightness_limit=0.4, contrast_limit=0, p=1)),
    ("zoom_out",        A.RandomScale(scale_limit=(-0.3, -0.1), p=1)),
    ("rotate_45",       A.Rotate(limit=(45, 45), p=1)),
    ("rotate_60",       A.Rotate(limit=(60, 60), p=1)),
]

# ---------------- THRESHOLD CHECK ----------------
def list_class_images(folder):
    if not os.path.isdir(folder):
        return []
    return [f for f in os.listdir(folder)
            if f.lower().endswith((".jpg", ".jpeg", ".png"))]

def check_threshold():
    """Return True only when every one of the 14 class folders has ≥ THRESHOLD
    NEW images staged by the UI. Otherwise print the deficit per class and
    return False so main.py exits cleanly."""
    print(f"\n📊 Checking feedback_dir/ against THRESHOLD={THRESHOLD} per class…")
    missing = []
    for cls in CLASSES:
        n = len(list_class_images(os.path.join(REVIEW_DIR, cls)))
        if n < THRESHOLD:
            missing.append((cls, n))
            print(f"  ⏳ {cls}: {n}/{THRESHOLD}")
        else:
            print(f"  ✅ {cls}: {n}")
    if missing:
        print(f"❌ {len(missing)}/{len(CLASSES)} class(es) below threshold — skipping retrain.")
        return False
    print("✅ All 14 class folders at or above threshold.")
    return True

# ---------------- MAKE OUTPUT STRUCTURE ----------------
def ensure_final_dirs():
    """Wipe any stale final_dataset/ and recreate it with empty
    train|val|test → <14 class folders>/."""
    if os.path.isdir(FINAL_DIR):
        shutil.rmtree(FINAL_DIR)
    for split in ("train", "val", "test"):
        for cls in CLASSES:
            os.makedirs(os.path.join(FINAL_DIR, split, cls), exist_ok=True)

# ---------------- OLD DATA MERGE ----------------
def copy_old_data():
    """If prev_dataset/ exists (last retrain's output), copy every image into
    final_dataset/ at the same split. Otherwise fall back to OLD_BASE — if
    THAT's not reachable either (network share), skip and continue with NEW
    only. Returns the per-split copy count."""
    if os.path.isdir(PREV_DIR):
        src = PREV_DIR
        print(f"\n📂 OLD source: prev_dataset/ ({src})")
    elif os.path.isdir(OLD_BASE):
        src = OLD_BASE
        print(f"\n📂 OLD source: bootstrap dataset ({src})")
    else:
        print(f"\n⚠️  No OLD source available (neither prev_dataset/ nor {OLD_BASE}).")
        print(f"   Training on NEW UI corrections only — fine for testing, not for production.")
        return {"train": 0, "val": 0, "test": 0}

    totals = {"train": 0, "val": 0, "test": 0}
    for split in ("train", "val", "test"):
        for cls in CLASSES:
            src_dir = os.path.join(src, split, cls)
            dst_dir = os.path.join(FINAL_DIR, split, cls)
            if not os.path.isdir(src_dir):
                continue
            for fname in os.listdir(src_dir):
                if not fname.lower().endswith((".jpg", ".jpeg", ".png")):
                    continue
                shutil.copy2(os.path.join(src_dir, fname),
                             os.path.join(dst_dir, f"old_{fname}"))
                totals[split] += 1
        print(f"  [{split}] OLD copied: {totals[split]}")
    return totals

# ---------------- AUG + SPLIT FROM REVIEW_DATASET ----------------
def augment_and_split_new():
    """For every class folder in feedback_dir/, generate the original + 12
    augmented copies, then split per-class 70/15/15 into
    final_dataset/{train,val,test}/<class>/."""
    print(f"\n🧪 Augmenting NEW samples from feedback_dir/")
    grand_new = 0
    for cls in CLASSES:
        src_dir = os.path.join(REVIEW_DIR, cls)
        files   = list_class_images(src_dir)
        if not files:
            print(f"  ⚠️  {cls}: no images — skipping (shouldn't happen post-threshold check)")
            continue

        augmented = []  # list of (filename_stem, RGB ndarray)
        for fname in tqdm(files, desc=f"  {cls:18s}", ncols=80):
            img = cv2.imread(os.path.join(src_dir, fname))
            if img is None:
                print(f"    ⚠️ could not read {fname}, skipping")
                continue
            img  = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            stem = os.path.splitext(fname)[0]

            augmented.append((f"{stem}_orig", img.copy()))
            for aug_name, aug in AUGMENTATIONS:
                try:
                    out = aug(image=img)["image"]
                    augmented.append((f"{stem}_{aug_name}", out))
                except Exception as e:
                    print(f"    ⚠️ {aug_name} failed on {fname}: {e}")

        random.shuffle(augmented)
        n         = len(augmented)
        train_end = int(n * TRAIN_RATIO)
        val_end   = train_end + int(n * VAL_RATIO)
        splits = {
            "train": augmented[:train_end],
            "val":   augmented[train_end:val_end],
            "test":  augmented[val_end:],
        }
        for split, items in splits.items():
            dst_dir = os.path.join(FINAL_DIR, split, cls)
            for stem, arr in items:
                cv2.imwrite(os.path.join(dst_dir, f"new_{stem}.jpg"),
                            cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
        grand_new += n
        print(f"    → {n} total ({len(splits['train'])} train, "
              f"{len(splits['val'])} val, {len(splits['test'])} test)")
    print(f"✅ NEW grand total: {grand_new}")
    return grand_new

# ---------------- SUMMARY ----------------
def print_summary():
    print("\n" + "=" * 55)
    print("  Final dataset summary")
    print("=" * 55)
    grand = 0
    for split in ("train", "val", "test"):
        per_split = 0
        for cls in CLASSES:
            n = len(list_class_images(os.path.join(FINAL_DIR, split, cls)))
            per_split += n
        grand += per_split
        print(f"  {split:5s} → {per_split:5d} images")
    print(f"  TOTAL → {grand}")
    print(f"  Saved to: {FINAL_DIR}")
    print("=" * 55)

# ---------------- ENTRY POINT ----------------
def run():
    if not check_threshold():
        return False
    ensure_final_dirs()
    copy_old_data()
    augment_and_split_new()
    print_summary()
    return True

if __name__ == "__main__":
    ok = run()
    sys.exit(0 if ok else 1)
