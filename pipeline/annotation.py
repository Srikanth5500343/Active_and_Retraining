import cv2

# Step 03: Image annotation utilities

DEVICE_CLASS_COLOR = {
    0:  (0, 0, 255),     # Closed Unit - red
    1:  (0, 165, 255),   # Empty - orange
    2:  (64, 255, 192),  # Firewall - mint
    3:  (0, 255, 255),   # Gateway - yellow
    4:  (128, 0, 128),   # PDU - purple
    5:  (255, 0, 255),   # PSU - magenta
    7:  (200, 200, 0),   # Router - olive
    9:  (255, 128, 0),   # Storage Unit - teal
    11: (255, 0, 128),   # UPS - pink
}

DEVICE_NAME_COLOR = {
    "Patch Panel": (0, 255, 0),
    "Switch":      (0, 128, 255),
    "Empty":       (0, 165, 255),   # orange — YOLO-classified empty slots
    "Closed Unit": (0, 0, 255),     # red
    "Unidentified": (128, 128, 128), # grey — row with no confident class
}


def annotate_units_only(img, units):
    out = img.copy()
    for unit in units:
        x1, y1, x2, y2 = unit["box"]
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 255, 0), 3)
        cv2.putText(out, unit["label"], (x1, y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
    return out


def annotate_devices_only(img, devices):
    out = img.copy()
    for idx, device in enumerate(devices, start=1):
        x1, y1, x2, y2 = device["box"]
        cls_id = device["class_id"]
        color = DEVICE_NAME_COLOR.get(device["class_name"], DEVICE_CLASS_COLOR.get(cls_id, (255, 0, 0)))
        units = device.get("units") or []
        units_label = ",".join(units) if units else "unknown"
        label = f"{idx}:{device['class_name']} [{units_label}]"
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 3)
        cv2.putText(out, label, (x1, y2 + 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 1)
    return out


def annotate_units_and_devices(img, units, devices):
    out = annotate_units_only(img, units)
    return annotate_devices_only(out, devices)


def annotate_image(img, units, devices):
    return annotate_units_and_devices(img, units, devices)


def annotate_full_rack(img, selected_device_box, selected_port_box=None):
    out = img.copy()
    x1, y1, x2, y2 = selected_device_box
    cv2.rectangle(out, (x1, y1), (x2, y2), (0, 0, 255), 4)
    cv2.putText(out, "SELECTED DEVICE", (x1, max(20, y1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 3)

    if selected_port_box is not None:
        px1, py1, px2, py2 = selected_port_box
        cv2.rectangle(out, (px1, py1), (px2, py2), (0, 255, 0), 2)
        cx = (px1 + px2) // 2
        cy = (py1 + py2) // 2
        cv2.circle(out, (cx, cy), 8, (0, 255, 0), 2)

    return out


def save_json(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        import json
        json.dump(payload, f, indent=2)
