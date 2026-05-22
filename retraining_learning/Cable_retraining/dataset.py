import os
import cv2
import shutil
import random
from tqdm import tqdm
import albumentations as A

# -----------------------------
# CONFIG
# -----------------------------

INPUT_DIR   = r"C:\Users\GeethikaPallelapati\Downloads\cables 2\cables"  # new images (14 folders, ≥15 each)
OLD_DATASET = r"\\192.168.1.29\Sharing folder\shankar\dataset_dir"      # existing train/val/test split
NEW_DATASET = r"C:\Users\GeethikaPallelapati\Downloads\Retraining\feedback_dir"      # final merged output

MIN_IMAGES  = 15
NUM_FOLDERS = 14
TRAIN_RATIO = 0.70
VAL_RATIO   = 0.15
TEST_RATIO  = 0.15

random.seed(42)

# -----------------------------
# AUGMENTATIONS
# -----------------------------

augmentations = [
    ("rotation",         A.Rotate(limit=30, p=1)),
    ("gaussian_blur",    A.GaussianBlur(blur_limit=(3, 5), p=1)),
    ("fog",              A.RandomFog(fog_coef_lower=0.1, fog_coef_upper=0.2, p=1)),
    ("random_crop",      A.RandomCrop(width=200, height=200, p=1)),
    ("mirror",           A.HorizontalFlip(p=1)),
    ("zoom_in",          A.RandomScale(scale_limit=(0.1, 0.3), p=1)),
    ("sharpen",          A.Sharpen(p=1)),
    ("brightness_high",  A.RandomBrightnessContrast(brightness_limit=0.4, contrast_limit=0, p=1)),
    ("zoom_out",         A.RandomScale(scale_limit=(-0.3, -0.1), p=1)),
    ("brightness_high2", A.RandomBrightnessContrast(brightness_limit=0.4, contrast_limit=0, p=1)),
    ("rotate_45",        A.Rotate(limit=(45, 45), p=1)),
    ("rotate_60",        A.Rotate(limit=(60, 60), p=1)),
]

# ==============================
# STEP 1: VALIDATE INPUT FOLDER
# ==============================
print("\n" + "="*55)
print("  STEP 1: Validating Input Directory")
print("="*55)

subfolders = [
    f for f in os.listdir(INPUT_DIR)
    if os.path.isdir(os.path.join(INPUT_DIR, f))
]

if len(subfolders) != NUM_FOLDERS:
    print(f"\n❌ FAILED: Expected {NUM_FOLDERS} folders, found {len(subfolders)}.")
    exit()

all_passed       = True
folder_image_map = {}

for folder in subfolders:
    folder_path = os.path.join(INPUT_DIR, folder)
    images      = [
        f for f in os.listdir(folder_path)
        if f.lower().endswith(('.png', '.jpg', '.jpeg'))
    ]
    folder_image_map[folder] = images

    if len(images) < MIN_IMAGES:
        print(f"  ❌ '{folder}': {len(images)} images  (need ≥ {MIN_IMAGES})")
        all_passed = False
    else:
        print(f"  ✅ '{folder}': {len(images)} images")

if not all_passed:
    print("\n❌ FAILED: One or more folders have less than 15 images. Exiting.")
    exit()

print(f"\n✅ Image count is passed — {NUM_FOLDERS} folders, each ≥ {MIN_IMAGES} images.\n")

# ==============================
# STEP 2: CREATE NEW_DATASET STRUCTURE
# ==============================
print("="*55)
print("  STEP 2: Creating new_dataset folder structure")
print("="*55 + "\n")

for split in ["train", "val", "test"]:
    for folder in subfolders:
        os.makedirs(os.path.join(NEW_DATASET, split, folder), exist_ok=True)

print("  ✅ Folder structure created.\n")

# ==============================
# STEP 3: COPY OLD DATASET → NEW_DATASET
# ==============================
print("="*55)
print("  STEP 3: Copying Old Dataset → new_dataset")
print("="*55 + "\n")

for split in ["train", "val", "test"]:
    split_total = 0
    for folder in subfolders:
        src_dir = os.path.join(OLD_DATASET, split, folder)
        dst_dir = os.path.join(NEW_DATASET, split, folder)

        count = 0
        if os.path.exists(src_dir):
            for img_file in os.listdir(src_dir):
                if img_file.lower().endswith(('.png', '.jpg', '.jpeg')):
                    shutil.copy2(
                        os.path.join(src_dir, img_file),
                        os.path.join(dst_dir, f"old_{img_file}")
                    )
                    count += 1
        else:
            print(f"  ⚠️  Not found: {src_dir}")

        split_total += count

    print(f"  [{split}] Copied {split_total} old images across {NUM_FOLDERS} folders")

print()

# ==============================
# STEP 4: AUGMENT + SPLIT DIRECTLY INTO NEW_DATASET
# ==============================
print("="*55)
print("  STEP 4: Augmenting New Images → directly into new_dataset")
print("="*55 + "\n")

for folder in subfolders:
    folder_path = os.path.join(INPUT_DIR, folder)
    images      = folder_image_map[folder]

    # --- Generate all augmented images in memory list first ---
    all_augmented = []   # list of (aug_name, base_name, augmented_image)

    for img_name in tqdm(images, desc=f"  Augmenting '{folder}'"):
        img_path = os.path.join(folder_path, img_name)
        image    = cv2.imread(img_path)

        if image is None:
            print(f"  ⚠️  Could not read {img_name}, skipping.")
            continue

        image     = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        base_name = os.path.splitext(img_name)[0]

        # original
        all_augmented.append((f"{base_name}_original", image.copy()))

        # augmented versions
        for aug_name, aug in augmentations:
            try:
                augmented = aug(image=image)["image"]
                all_augmented.append((f"{base_name}_{aug_name}", augmented))
            except Exception as e:
                print(f"  ⚠️  Error in '{aug_name}' for '{img_name}': {e}")

    # --- Shuffle and split ---
    random.shuffle(all_augmented)

    total     = len(all_augmented)
    train_end = int(total * TRAIN_RATIO)
    val_end   = train_end + int(total * VAL_RATIO)

    split_data = {
        "train": all_augmented[:train_end],
        "val":   all_augmented[train_end:val_end],
        "test":  all_augmented[val_end:]
    }

    # --- Save directly into new_dataset/split/folder ---
    for split, items in split_data.items():
        dst_dir = os.path.join(NEW_DATASET, split, folder)
        for file_name, img_array in items:
            save_path = os.path.join(dst_dir, f"new_{file_name}.jpg")
            cv2.imwrite(save_path, cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR))

    print(f"  '{folder}': {total} augmented → "
          f"train={len(split_data['train'])}  "
          f"val={len(split_data['val'])}  "
          f"test={len(split_data['test'])}\n")

# ==============================
# STEP 5: FINAL SUMMARY
# ==============================
print("="*55)
print("  STEP 5: Final Summary")
print("="*55 + "\n")

grand_total = 0
for split in ["train", "val", "test"]:
    split_total = 0
    for folder in subfolders:
        dst_dir = os.path.join(NEW_DATASET, split, folder)
        count   = len([
            f for f in os.listdir(dst_dir)
            if f.lower().endswith(('.png', '.jpg', '.jpeg'))
        ])
        split_total += count
        grand_total += count
    print(f"  {split:5s} → {split_total} total images across {NUM_FOLDERS} folders")

print(f"\n  Grand total : {grand_total} images")
print(f"  Saved to    : {NEW_DATASET}")
print("="*55 + "\n")