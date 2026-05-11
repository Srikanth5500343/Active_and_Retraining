#Efficientnet b0
 
 
 
import torch

import torch.nn as nn

import torch.optim as optim

from torchvision import datasets, transforms, models

from torch.utils.data import DataLoader

from sklearn.metrics import confusion_matrix, ConfusionMatrixDisplay

import matplotlib.pyplot as plt

import os

import copy
 
# =========================

# CONFIG

# =========================

data_dir = r"\\192.168.1.29\Sharing folder\shankar\dataset_dir"

batch_size = 32

epochs = 60

patience = 5

lr = 1e-4

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
 
# =========================

# TRANSFORMS

# =========================

train_transforms = transforms.Compose([

    transforms.Resize((256, 256)),

    transforms.RandomHorizontalFlip(),

    transforms.RandomRotation(15),

    transforms.ToTensor(),

])
 
val_transforms = transforms.Compose([

    transforms.Resize((256, 256)),

    transforms.ToTensor(),

])
 
# =========================

# DATASETS

# =========================

train_dataset = datasets.ImageFolder(os.path.join(data_dir, "train"), transform=train_transforms)

val_dataset   = datasets.ImageFolder(os.path.join(data_dir, "val"), transform=val_transforms)

test_dataset  = datasets.ImageFolder(os.path.join(data_dir, "test"), transform=val_transforms)
 
class_names = train_dataset.classes

num_classes = len(class_names)
 
print("Classes:", class_names)
 
train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)

val_loader   = DataLoader(val_dataset, batch_size=batch_size)

test_loader  = DataLoader(test_dataset, batch_size=batch_size)
 
# =========================

# MODEL

# =========================

model = models.efficientnet_b0(weights="IMAGENET1K_V1")

model.classifier[1] = nn.Linear(model.classifier[1].in_features, num_classes)

model = model.to(device)
 
# =========================

# LOSS & OPTIMIZER

# =========================

criterion = nn.CrossEntropyLoss(label_smoothing=0.1)

optimizer = optim.AdamW(model.parameters(), lr=lr)
 
# =========================

# TRAIN FUNCTION

# =========================

def train_one_epoch():

    model.train()

    total_loss, correct = 0, 0
 
    for images, labels in train_loader:

        images, labels = images.to(device), labels.to(device)
 
        optimizer.zero_grad()

        outputs = model(images)

        loss = criterion(outputs, labels)
 
        loss.backward()

        optimizer.step()
 
        total_loss += loss.item()

        preds = outputs.argmax(dim=1)

        correct += (preds == labels).sum().item()
 
    acc = correct / len(train_dataset)

    return total_loss, acc
 
# =========================

# VALIDATION FUNCTION

# =========================

def validate():

    model.eval()

    correct = 0
 
    with torch.no_grad():

        for images, labels in val_loader:

            images, labels = images.to(device), labels.to(device)
 
            outputs = model(images)

            preds = outputs.argmax(dim=1)
 
            correct += (preds == labels).sum().item()
 
    acc = correct / len(val_dataset)

    return acc
 
# =========================

# EARLY STOPPING SETUP

# =========================

best_acc = 0

patience_counter = 0

best_model_wts = copy.deepcopy(model.state_dict())
 
# =========================

# TRAIN LOOP

# =========================

for epoch in range(epochs):

    train_loss, train_acc = train_one_epoch()

    val_acc = validate()
 
    print(f"\nEpoch {epoch+1}/{epochs}")

    print(f"Train Loss: {train_loss:.4f} | Train Acc: {train_acc:.4f}")

    print(f"Val Acc: {val_acc:.4f}")
 
    # Check improvement

    if val_acc > best_acc:

        best_acc = val_acc

        best_model_wts = copy.deepcopy(model.state_dict())

        patience_counter = 0

        print("✅ Best model updated")

    else:

        patience_counter += 1

        print(f"⏳ No improvement ({patience_counter}/{patience})")
 
    # Early stopping

    if patience_counter >= patience:

        print("🛑 Early stopping triggered")

        break
 
# =========================

# LOAD BEST MODEL

# =========================

model.load_state_dict(best_model_wts)
 
# =========================

# CONFUSION MATRIX (VAL)

# =========================

model.eval()

all_preds, all_labels = [], []
 
with torch.no_grad():

    for images, labels in val_loader:

        images = images.to(device)

        outputs = model(images)
 
        preds = outputs.argmax(dim=1).cpu().numpy()

        all_preds.extend(preds)

        all_labels.extend(labels.numpy())
 
cm = confusion_matrix(all_labels, all_preds)
 
plt.figure(figsize=(10, 8))

disp = ConfusionMatrixDisplay(confusion_matrix=cm, display_labels=class_names)

disp.plot(xticks_rotation=45)

plt.title("Confusion Matrix (Validation)")

plt.show()
 
# =========================

# TEST EVALUATION

# =========================

def test_model():

    model.eval()

    correct = 0
 
    with torch.no_grad():

        for images, labels in test_loader:

            images, labels = images.to(device), labels.to(device)
 
            outputs = model(images)

            preds = outputs.argmax(dim=1)
 
            correct += (preds == labels).sum().item()
 
    acc = correct / len(test_dataset)

    print(f"\n🧪 Test Accuracy: {acc:.4f}")
 
test_model()
 
# =========================

# SAVE MODEL

# =========================

torch.save(model.state_dict(), "best_model_efficientnet.pth")

print("\n✅ Training complete. Best model saved as best_model_efficientnet.pth")
 