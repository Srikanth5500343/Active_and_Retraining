import os
import cv2
import shutil
import random

# ---------------- CONFIG ----------------
NEW_IMG = r"C:\Users\GeethikaPallelapati\Downloads\Retraining\dataset\images_all"
NEW_LBL = r"C:\Users\GeethikaPallelapati\Downloads\Retraining\dataset\labels_all"

OLD_BASE = r"C:\Users\GeethikaPallelapati\Downloads\Rack_devices.v4i.yolov8\data"

FINAL_PATH = "final_dataset"

THRESHOLD = 100  # 🔴 Minimum new images required

CLASSES = [
    "Closed Unit","Empty","Firewall","Gateway","PDU","PSU",
    "Patch Panel","Router","Server","Storage Unit","Switch","UPS"
]

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

def augment_new_data():
    print("\n🔄 Augmenting NEW data...")

    for f in os.listdir(NEW_IMG):
        if not f.lower().endswith((".jpg",".png",".jpeg")):
            continue

        if "_aug" in f:  # skip already augmented
            continue

        img_path = os.path.join(NEW_IMG, f)
        lbl_path = os.path.join(NEW_LBL, f.replace(".jpg",".txt"))

        if not os.path.exists(lbl_path):
            print(f"⚠️ Missing label: {f}")
            continue

        img = cv2.imread(img_path)
        if img is None:
            continue

        for i, aug in enumerate(augment_image(img)):
            new_name = f.replace(".jpg", f"_aug{i}.jpg")

            cv2.imwrite(os.path.join(NEW_IMG, new_name), aug)

            shutil.copy2(lbl_path,
                         os.path.join(NEW_LBL, new_name.replace(".jpg",".txt")))

# ---------------- LOAD OLD DATA ----------------
def collect_old_data():
    all_old = []
    splits = ["train", "valid", "test"]

    print("\n📂 Reading OLD dataset...")

    for split in splits:
        img_dir = os.path.join(OLD_BASE, split, "images")
        lbl_dir = os.path.join(OLD_BASE, split, "labels")

        if not os.path.exists(img_dir):
            print(f"❌ Missing: {img_dir}")
            continue

        files = os.listdir(img_dir)
        print(f"📁 {split}: {len(files)} images")

        for f in files:
            if f.lower().endswith((".jpg",".png",".jpeg")):
                lbl_path = os.path.join(lbl_dir, f.replace(".jpg",".txt"))

                if os.path.exists(lbl_path):
                    all_old.append((os.path.join(img_dir, f), lbl_path))

    print(f"✅ Total OLD collected: {len(all_old)}")
    return all_old

# ---------------- MERGE ----------------
def merge_datasets():
    merged_img = os.path.join(FINAL_PATH, "images_all")
    merged_lbl = os.path.join(FINAL_PATH, "labels_all")

    os.makedirs(merged_img, exist_ok=True)
    os.makedirs(merged_lbl, exist_ok=True)

    # ---- NEW DATA ----
    print("\n📦 Adding NEW data...")
    new_count = 0

    for f in os.listdir(NEW_IMG):
        if not f.lower().endswith((".jpg",".png",".jpeg")):
            continue

        shutil.copy2(os.path.join(NEW_IMG, f),
                     os.path.join(merged_img, f))

        lbl = f.replace(".jpg",".txt")
        shutil.copy2(os.path.join(NEW_LBL, lbl),
                     os.path.join(merged_lbl, lbl))

        new_count += 1

    print(f"✅ NEW added: {new_count}")

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

    for img_path, lbl_path in sampled:
        fname = "old_" + os.path.basename(img_path)

        shutil.copy2(img_path,
                     os.path.join(merged_img, fname))

        shutil.copy2(lbl_path,
                     os.path.join(merged_lbl, fname.replace(".jpg",".txt")))

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

    augment_new_data()
    merged_img, merged_lbl = merge_datasets()
    split_dataset(merged_img, merged_lbl)
    create_yaml()

    print("\n✅ FINAL DATASET READY FOR TRAINING")

# ---------------- RUN ----------------
if __name__ == "__main__":
    run_pipeline()