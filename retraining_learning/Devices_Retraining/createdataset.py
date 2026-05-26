import os
import sys
import cv2
import shutil
import random

# Force UTF-8 console output — the print() statements below use emoji that
# Windows' default cp1252 codec can't encode, and an unhandled
# UnicodeEncodeError on the first print crashes the whole pipeline.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------- CONFIG ----------------
NEW_IMG = r"C:\Users\SrikanthMekala\Downloads\RACKTRACK_FINAL_V1\retraining_learning\Devices_Retraining\review_dataset\images"
NEW_LBL = r"C:\Users\SrikanthMekala\Downloads\RACKTRACK_FINAL_V1\retraining_learning\Devices_Retraining\review_dataset\labels"

# Two sources of "OLD" data, in priority order:
#   1. PREV_PATH — populated by main.py after a successful retrain (it
#      promotes the just-built final_dataset to here). Already in UI class-ID
#      order, so no remap needed.
#   2. OLD_BASE  — the original bootstrap dataset. Uses the legacy 12-class
#      order, so labels are remapped via OLD_ID_REMAP during merge.
# This way the model's "old knowledge" evolves with each retrain instead of
# being yanked back to the original snapshot every cycle.
PREV_PATH = r"C:\Users\SrikanthMekala\Downloads\RACKTRACK_FINAL_V1\retraining_learning\Devices_Retraining\prev_dataset"
OLD_BASE  = r"C:\Users\SrikanthMekala\Downloads\TEAM_RACKTRACK\data"

FINAL_PATH = "final_dataset"

THRESHOLD = 100  # 🔴 Minimum new images required

CLASSES = [
    "Switch","Patch Panel","Firewall","Router","Server","Load Balancer",
    "Modem","Controller","Recorder","Amplifier","Gateway","PDU","PSU","UPS",
]

# Old labels in data/{train,valid,test}/labels/*.txt were written under the
# legacy 12-class order:
#   0:Closed Unit 1:Empty 2:Firewall 3:Gateway 4:PDU 5:PSU
#   6:Patch Panel 7:Router 8:Server 9:Storage Unit 10:Switch 11:UPS
# CLASSES above is the UI's 14-class order, so we remap each line on the fly
# when copying. IDs 12-16 cover review_dataset labels written before the
# UI-order migration (extended 17-class space — Load Balancer..Amplifier).
# Classes the UI dropped (Closed Unit/Empty/Storage Unit) → None → line dropped.
OLD_ID_REMAP = {
    0: None, 1: None,     # Closed Unit, Empty — removed from UI
    2: 2,                  # Firewall
    3: 10,                 # Gateway
    4: 11,                 # PDU
    5: 12,                 # PSU
    6: 1,                  # Patch Panel
    7: 3,                  # Router
    8: 4,                  # Server
    9: None,               # Storage Unit — removed from UI
    10: 0,                 # Switch
    11: 13,                # UPS
    12: 5, 13: 6, 14: 7, 15: 8, 16: 9,   # extended-space → new
}

def remap_label_file(src_path, dst_path):
    """Read a YOLO .txt, rewrite each class ID via OLD_ID_REMAP, drop lines
    whose class no longer exists in CLASSES, write to dst_path."""
    out = []
    with open(src_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            try:
                cid = int(parts[0])
            except (ValueError, IndexError):
                continue
            new_id = OLD_ID_REMAP.get(cid)
            if new_id is None:
                continue
            parts[0] = str(new_id)
            out.append(" ".join(parts))
    with open(dst_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + ("\n" if out else ""))

# ---------------- THRESHOLD CHECK ----------------
def check_new_data_threshold():
    images = [
        f for f in os.listdir(NEW_IMG)
        if f.lower().endswith((".jpg",".png",".jpeg")) and "_aug" not in f
    ]

    count = len(images)

    print(f"\n📊 New labeled images (excluding augmented): {count}")

    if count < THRESHOLD:
        print(f"⏳ Waiting... Need {THRESHOLD - count} more images.")
        return False

    print("✅ Threshold reached. Starting pipeline...")
    return True

# ---------------- AUGMENT ----------------
def augment_image(img):
    return [
        cv2.flip(img, 1),
        cv2.convertScaleAbs(img, alpha=1.2, beta=25)
    ]

def _write_augmented(src_img_path, src_lbl_path, dst_img_dir, dst_lbl_dir, stem):
    """Read one image, write 2 augmented copies (flip + brightness) into
    dst_img_dir/dst_lbl_dir as <stem>_aug{0,1}.{jpg,txt}. The augmented
    label is the same as the original (flip on the X axis would invert
    YOLO x-centers; brightness doesn't change geometry — for now we accept
    the small flip-mismatch the original author was already living with).
    Returns the number of augmented samples actually written."""
    img = cv2.imread(src_img_path)
    if img is None:
        return 0
    written = 0
    for i, aug in enumerate(augment_image(img)):
        cv2.imwrite(os.path.join(dst_img_dir, f"{stem}_aug{i}.jpg"), aug)
        shutil.copy2(src_lbl_path, os.path.join(dst_lbl_dir, f"{stem}_aug{i}.txt"))
        written += 1
    return written

# ---------------- LOAD OLD DATA ----------------
def collect_old_data():
    """Return list of (img_path, lbl_path, needs_remap) tuples.
    Prefers PREV_PATH (last retrain's output, UI-ordered labels). Falls back
    to OLD_BASE (legacy bootstrap, requires class-ID remap)."""
    all_old = []

    if os.path.isdir(PREV_PATH):
        print(f"\n📂 Reading PREVIOUS dataset (last retrain): {PREV_PATH}")
        # Layout written by createdataset.py's split_dataset():
        #   <PREV_PATH>/images/{train,val,test}/*.jpg
        #   <PREV_PATH>/labels/{train,val,test}/*.txt
        for split in ("train", "val", "test"):
            img_dir = os.path.join(PREV_PATH, "images", split)
            lbl_dir = os.path.join(PREV_PATH, "labels", split)
            if not os.path.isdir(img_dir):
                continue
            files = os.listdir(img_dir)
            print(f"📁 {split}: {len(files)} images")
            for f in files:
                if not f.lower().endswith((".jpg",".png",".jpeg")):
                    continue
                stem = os.path.splitext(f)[0]
                lbl_path = os.path.join(lbl_dir, stem + ".txt")
                if os.path.exists(lbl_path):
                    all_old.append((os.path.join(img_dir, f), lbl_path, False))
        print(f"✅ Total OLD collected (no remap): {len(all_old)}")
        return all_old

    print(f"\n📂 Reading BOOTSTRAP dataset: {OLD_BASE}")
    for split in ("train", "valid", "test"):
        img_dir = os.path.join(OLD_BASE, split, "images")
        lbl_dir = os.path.join(OLD_BASE, split, "labels")
        if not os.path.exists(img_dir):
            print(f"❌ Missing: {img_dir}")
            continue
        files = os.listdir(img_dir)
        print(f"📁 {split}: {len(files)} images")
        for f in files:
            if not f.lower().endswith((".jpg",".png",".jpeg")):
                continue
            lbl_path = os.path.join(lbl_dir, f.replace(".jpg", ".txt"))
            if os.path.exists(lbl_path):
                all_old.append((os.path.join(img_dir, f), lbl_path, True))
    print(f"✅ Total OLD collected (will remap legacy IDs): {len(all_old)}")
    return all_old

# ---------------- MERGE ----------------
def merge_datasets():
    merged_img = os.path.join(FINAL_PATH, "images_all")
    merged_lbl = os.path.join(FINAL_PATH, "labels_all")

    os.makedirs(merged_img, exist_ok=True)
    os.makedirs(merged_lbl, exist_ok=True)

    # ---- NEW DATA ----
    # Copy each user-corrected sample once, then generate 2 augmented copies
    # (flip + brightness) directly into the merged staging area. The original
    # design wrote those _aug files back into review_dataset/, which made it
    # look like every UI correction was being saved 3 times.
    print("\n📦 Adding NEW data (+ 2 augmented copies per original)...")
    new_count = 0
    aug_count = 0

    for f in os.listdir(NEW_IMG):
        if not f.lower().endswith((".jpg",".png",".jpeg")):
            continue
        if "_aug" in f:
            # Belt-and-suspenders: skip any stray legacy augmented files that
            # might still be left in review_dataset from before this change.
            continue

        src_img = os.path.join(NEW_IMG, f)
        src_lbl = os.path.join(NEW_LBL, f.replace(".jpg",".txt"))
        if not os.path.exists(src_lbl):
            print(f"⚠️ missing label for {f}; skipping")
            continue

        shutil.copy2(src_img, os.path.join(merged_img, f))
        shutil.copy2(src_lbl, os.path.join(merged_lbl, f.replace(".jpg",".txt")))
        new_count += 1

        aug_count += _write_augmented(src_img, src_lbl, merged_img, merged_lbl,
                                       os.path.splitext(f)[0])

    print(f"✅ NEW added: {new_count} originals + {aug_count} augmented = {new_count + aug_count}")

    # ---- OLD DATA ----
    old_data = collect_old_data()

    if len(old_data) == 0:
        print("❌ No OLD data found — check path")
        return merged_img, merged_lbl

    sample_size = int(len(old_data) * 0.7)
    sample_size = max(sample_size, 1)

    print(f"\n📊 OLD total: {len(old_data)}")
    print(f"📊 Taking 70% → {sample_size}")

    sampled = random.sample(old_data, sample_size)

    old_count = 0

    for img_path, lbl_path, needs_remap in sampled:
        fname = "old_" + os.path.basename(img_path)
        dst_img = os.path.join(merged_img, fname)
        dst_lbl = os.path.join(merged_lbl, fname.replace(".jpg",".txt"))

        shutil.copy2(img_path, dst_img)
        # PREV_PATH labels are already in UI class-ID order — straight copy.
        # OLD_BASE labels use the legacy 12-class order — remap each line.
        if needs_remap:
            remap_label_file(lbl_path, dst_lbl)
        else:
            shutil.copy2(lbl_path, dst_lbl)

        old_count += 1

    print(f"✅ OLD added: {old_count}")
    print(f"📊 TOTAL merged: {new_count + old_count}")

    return merged_img, merged_lbl

# ---------------- SPLIT ----------------
def split_dataset(img_path, lbl_path):
    print("\n🔀 Splitting dataset...")

    images = [f for f in os.listdir(img_path)
              if f.endswith((".jpg",".png",".jpeg"))]

    print(f"Total images before split: {len(images)}")

    random.shuffle(images)

    train_cut = int(len(images)*0.7)
    val_cut = int(len(images)*0.9)

    splits = {
        "train": images[:train_cut],
        "val": images[train_cut:val_cut],
        "test": images[val_cut:]
    }

    for split in splits:
        img_dir = os.path.join(FINAL_PATH, "images", split)
        lbl_dir = os.path.join(FINAL_PATH, "labels", split)

        os.makedirs(img_dir, exist_ok=True)
        os.makedirs(lbl_dir, exist_ok=True)

        for f in splits[split]:
            shutil.copy2(os.path.join(img_path,f),
                         os.path.join(img_dir,f))

            lbl = f.replace(".jpg",".txt")
            shutil.copy2(os.path.join(lbl_path,lbl),
                         os.path.join(lbl_dir,lbl))

        print(f"{split}: {len(splits[split])} images")

# ---------------- YAML ----------------
def create_yaml():
    yaml_path = os.path.join(FINAL_PATH, "data.yaml")

    with open(yaml_path,"w") as f:
        f.write(f"""
path: {os.path.abspath(FINAL_PATH)}

train: images/train
val: images/val
test: images/test

names:
""")
        for i,c in enumerate(CLASSES):
            f.write(f"  {i}: {c}\n")

    print("📝 data.yaml created")

# ---------------- MAIN ----------------
def run_pipeline():
    print("\n🚀 STARTING PIPELINE\n")

    # 🔴 THRESHOLD CHECK
    if not check_new_data_threshold():
        return

    # Augmentation now happens INSIDE merge_datasets and writes only to
    # final_dataset/ — review_dataset/ stays one-file-per-correction.
    merged_img, merged_lbl = merge_datasets()
    split_dataset(merged_img, merged_lbl)
    create_yaml()

    print("\n✅ FINAL DATASET READY FOR TRAINING")

# ---------------- RUN ----------------
if __name__ == "__main__":
    run_pipeline()
