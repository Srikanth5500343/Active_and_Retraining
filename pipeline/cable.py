import os
import cv2
import torch
import torch.nn as nn
from torchvision import models, transforms
from PIL import Image

IMG_SIZE = 256

# Must match sorted(os.listdir(train_dir)) â€” the order the model was trained with
FALLBACK_CABLE_CLASSES = [
    'LC_Aqua',
    'RJ-45 Violet',
    'RJ_45 Black',
    'RJ_45 Blue',
    'RJ_45 Brown',
    'RJ_45 Green',
    'RJ_45 Grey',
    'RJ_45 Orange',
    'RJ_45 Pink',
    'RJ_45 Red',
    'RJ_45 White',
    'RJ_45 Yellow',
    'SC_Orange',
    'SC_Yellow',
]

IMAGE_TRANSFORMS = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
])

_CABLE_MODEL_CACHE = {}
_PORT_IDENTIFY_CACHE = {}


def _extract_cable_classes(checkpoint):
    if not isinstance(checkpoint, dict):
        return None

    for key in ('classes', 'labels', 'class_names', 'class_to_idx', 'idx_to_class', 'mapping'):
        if key not in checkpoint:
            continue
        value = checkpoint[key]
        if isinstance(value, (list, tuple)) and value:
            return [str(x) for x in value]
        if isinstance(value, dict) and value:
            items = list(value.items())
            if all(isinstance(k, int) for k, _ in items):
                return [str(v) for _, v in sorted(items, key=lambda x: x[0])]
            if all(isinstance(v, int) for _, v in items):
                return [str(k) for k, _ in sorted(items, key=lambda x: x[1])]
    return None


def _get_model_output_labels(model):
    classifier = getattr(model, 'classifier', None)
    if classifier is None:
        return None

    if isinstance(classifier, nn.Sequential) and len(classifier) > 0:
        last = classifier[-1]
    else:
        last = classifier

    out_features = getattr(last, 'out_features', None)
    if isinstance(out_features, int) and out_features > 0:
        return [f'class_{i}' for i in range(out_features)]
    return None


def load_cable_model(model_path: str, device: str = 'cpu'):
    cache_key = (model_path, device)
    cached = _CABLE_MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Cable model file not found: {model_path}")

    checkpoint = torch.load(model_path, map_location=device)

    if isinstance(checkpoint, nn.Module):
        model = checkpoint
        model._cable_classes = _get_model_output_labels(model)
    else:
        model = models.efficientnet_b0(weights=None)
        class_names = _extract_cable_classes(checkpoint)

        if isinstance(checkpoint, dict) and "state_dict" in checkpoint:
            checkpoint = checkpoint["state_dict"]

        if isinstance(checkpoint, dict):
            state_dict = checkpoint
            if any(key.startswith("module.") for key in state_dict):
                state_dict = {
                    key[len("module."):]: value
                    for key, value in state_dict.items()
                }

            num_classes = None
            for key in ["classifier.1.weight", "classifier.weight", "fc.weight"]:
                if key in state_dict:
                    num_classes = state_dict[key].shape[0]
                    break

            if num_classes is not None and num_classes != model.classifier[1].out_features:
                in_features = model.classifier[1].in_features
                model.classifier[1] = nn.Linear(in_features, num_classes)

            model.load_state_dict(state_dict, strict=False)
            if class_names:
                model._cable_classes = class_names
            elif num_classes is not None and num_classes == len(FALLBACK_CABLE_CLASSES):
                model._cable_classes = FALLBACK_CABLE_CLASSES
            else:
                model._cable_classes = _get_model_output_labels(model)
        else:
            raise ValueError("Unsupported checkpoint format for cable model.")

    model.to(device)
    model.eval()
    if getattr(model, '_cable_classes', None) is None:
        model._cable_classes = FALLBACK_CABLE_CLASSES
    _CABLE_MODEL_CACHE[cache_key] = model
    return model


def preprocess_image(img):
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    return IMAGE_TRANSFORMS(pil).unsqueeze(0)


def classify_cable(img, model, classes=None, device: str = 'cpu'):
    """Classify a cable crop. Returns (label, confidence) where confidence is
    the softmax probability of the chosen class (0.0â€“1.0).

    Applies active learning corrections based on user feedback from the UI
    before returning the prediction.
    """
    if img is None or img.size == 0:
        return None, 0.0

    tensor = preprocess_image(img).to(device)
    with torch.no_grad():
        output = model(tensor)
    if isinstance(output, tuple):
        output = output[0]
    probs = torch.softmax(output, dim=1)
    idx = int(probs.argmax(dim=1).item())
    confidence = float(probs[0, idx].item())

    labels = classes
    if labels is None:
        labels = getattr(model, '_cable_classes', None)
    if labels is None:
        labels = _get_model_output_labels(model)
    if labels is None:
        labels = FALLBACK_CABLE_CLASSES

    if labels is not None and idx < len(labels):
        predicted_label = labels[idx]
    else:
        predicted_label = f'class_{idx}'

    # Check for active learning correction based on user feedback
    final_label = predicted_label
    try:
        from pipeline.cable_al import get_correction
        correction = get_correction(img, predicted_label)
        if correction:
            corrected_label, method = correction
            # Use the learned correction instead of model prediction
            final_label = corrected_label
            import sys
            print(f"[cable.classify_cable] Applied AL correction via {method}: {predicted_label} -> {corrected_label}", file=sys.stderr)
    except Exception as e:
        # If AL lookup fails, just use model prediction (non-blocking)
        import sys
        print(f"[cable.classify_cable] AL lookup error (non-blocking): {e}", file=sys.stderr)

    return final_label, confidence


def crop_box(img, box, pad=8, pad_x=None, pad_y=None):
    """Crop `box` out of `img` with padding.

    - `pad` applies uniformly to all four edges.
    - `pad_x` / `pad_y`, when given, override `pad` per axis (left/right and
      top/bottom respectively). Useful when the caller wants the final crop
      to be a specific multiple of the original box (e.g. pass
      pad_x = box_w // 2 and pad_y = box_h // 2 to double the crop size).
    """
    x1, y1, x2, y2 = box
    h, w = img.shape[:2]
    px = pad if pad_x is None else pad_x
    py = pad if pad_y is None else pad_y
    x1 = max(0, x1 - px)
    y1 = max(0, y1 - py)
    x2 = min(w, x2 + px)
    y2 = min(h, y2 + py)
    return img[y1:y2, x1:x2]


def parse_cable_type_color(cable_class):
    """Parse a cable class name into (connector_type, color).

    Examples:
        'RJ_45 Black'  -> ('RJ-45', 'Black')
        'LC_Aqua'      -> ('LC', 'Aqua')
        'SC_Orange'    -> ('SC', 'Orange')
        'RJ-45 Violet' -> ('RJ-45', 'Violet')
    """
    if not cable_class:
        return None, None
    if ' ' in cable_class:
        connector, color = cable_class.rsplit(' ', 1)
    elif '_' in cable_class:
        connector, color = cable_class.rsplit('_', 1)
    else:
        return cable_class, None
    connector = connector.replace('_', '-')
    return connector, color


def load_port_identify_model(model_path, device='cpu'):
    """Load the port-type identification model (EfficientNet checkpoint)."""
    model = load_cable_model(model_path, device=device)
    if getattr(model, '_cable_classes', None) is FALLBACK_CABLE_CLASSES:
        model._cable_classes = None
    return model


def classify_port_type(img, model, device='cpu'):
    """Classify the port type from a cropped port image. Returns (label, confidence)."""
    return classify_cable(img, model, device=device)
