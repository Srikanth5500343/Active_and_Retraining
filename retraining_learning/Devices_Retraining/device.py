import os
import cv2
import shutil
import random
from flask import Flask, render_template_string, request, send_from_directory
from ultralytics import YOLO

# ---------------- CONFIG ----------------
INPUT_FOLDER = r"C:\Users\GeethikaPallelapati\Downloads\Test_Image\Test_Image"
OUTPUT_DATASET = "review_dataset"
MIN_CONFIDENCE = 0.30

MODEL_S_PATH = r"C:\Users\GeethikaPallelapati\Downloads\best 33.pt"
MODEL_L_PATH = r"C:\Users\GeethikaPallelapati\Downloads\best 32.pt"

SERVER_CLASS_NAME = "server"

CLASSES = [
    "Closed Unit", "Empty", "Firewall", "Gateway", "PDU", "PSU",
    "Patch Panel", "Router", "Server", "Storage Unit", "Switch", "UPS"
]

os.makedirs(f"{OUTPUT_DATASET}/images", exist_ok=True)
os.makedirs(f"{OUTPUT_DATASET}/labels", exist_ok=True)
os.makedirs("temp", exist_ok=True)

# ---------------- LOAD MODELS ----------------
model_s = YOLO(MODEL_S_PATH)
model_l = YOLO(MODEL_L_PATH)

names_s = model_s.names
names_l = model_l.names

# ---------------- CLASS ID ----------------
def get_class_id(names_dict, target_name):
    for k, v in names_dict.items():
        if v.lower() == target_name.lower():
            return k
    return None

server_class_id_s = get_class_id(names_s, SERVER_CLASS_NAME)
server_class_id_l = get_class_id(names_l, SERVER_CLASS_NAME)

# ---------------- COLOR MAP ----------------
def generate_colors(classes):
    random.seed(42)
    return {
        cls: (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        for cls in classes
    }

COLOR_MAP = generate_colors(CLASSES)

# ---------------- IOU ----------------
def compute_iou(box1, box2):
    x1, y1, x2, y2 = box1
    x1g, y1g, x2g, y2g = box2

    xi1 = max(x1, x1g)
    yi1 = max(y1, y1g)
    xi2 = min(x2, x2g)
    yi2 = min(y2, y2g)

    inter = max(0, xi2 - xi1) * max(0, yi2 - yi1)
    union = ((x2 - x1) * (y2 - y1)) + ((x2g - x1g) * (y2g - y1g)) - inter

    return inter / union if union > 0 else 0

# ---------------- LABEL POSITION FIX (from second code — 20px spacing) ----------------
def adjust_label_position(x, y, used_positions):
    """
    Shifts label upward/downward by 20px increments until it doesn't
    collide with any already-placed label. Mirrors the second code exactly.
    """
    while any(abs(y - uy) < 20 for uy in used_positions):
        y += 20
    used_positions.append(y)
    return x, y

# ---------------- DRAW BOXES (detection numbers for easy identification) ----------------
def draw_boxes(img, detections):
    """
    Draws bounding boxes + detection numbers with collision-free
    positioning for easy identification.
    """
    used_label_positions = []

    for idx, det in enumerate(detections, 1):
        x1, y1, x2, y2 = det["box"]
        label_name = det["label"]

        color = COLOR_MAP.get(label_name, (0, 255, 0))

        label_text = f"{idx} {label_name}"

        lx, ly = adjust_label_position(x1, y1 - 10, used_label_positions)

        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        cv2.putText(img, label_text, (lx, ly),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

    return img

# ---------------- HTML PAGE ----------------
HTML_PAGE = """
<html>
<head>
<style>
  body { background:#111; color:white; font-family:Arial; }
  .box { border:1px solid #444; padding:15px; margin:15px; border-radius:10px; }
  img { width:500px; }
  select, button { padding:5px; margin-top:5px; }
  .hidden { display:none; }
  .det-row { margin-bottom:8px; }
  .det-badge { 
    display: inline-block; 
    background: #ff6600; 
    color: white; 
    font-weight: bold; 
    width: 32px; 
    height: 32px; 
    border-radius: 50%; 
    text-align: center; 
    line-height: 32px; 
    margin-right: 12px; 
    font-size: 16px;
  }
  button { background:#333; color:white; border:1px solid #666;
           border-radius:6px; cursor:pointer; padding:6px 14px; }
  button:hover { background:#555; }
</style>
</head>
<body>
<h1>Detection Review</h1>

{% for img_name, data in detections.items() %}
<div class="box">
  <h3>{{ img_name }}</h3>
  <img src="/image/{{ img_name }}"><br><br>

  {% for det in data %}
  <div class="det-row">
    <span class="det-badge">{{ loop.index }}</span>
    <b>{{ det['label'] }}</b> (conf: {{ "%.2f"|format(det['conf']) }})
    <br>

    <input type="radio" name="{{ img_name }}_{{ loop.index }}" value="correct" checked
           onchange="toggleDropdown(this)"> Correct

    <input type="radio" name="{{ img_name }}_{{ loop.index }}" value="wrong"
           onchange="toggleDropdown(this)"> Wrong

    <br>

    <select class="hidden" name="{{ img_name }}_{{ loop.index }}_dropdown">
      {% for c in classes %}
        <option value="{{ c }}" {% if c == det['label'] %}selected{% endif %}>{{ c }}</option>
      {% endfor %}
    </select>
  </div>
  <hr>
  {% endfor %}

  <button onclick="submitData('{{ img_name }}')">Save</button>
</div>
{% endfor %}

<script>
function toggleDropdown(el) {
  let dropdown = document.querySelector(`[name="${el.name}_dropdown"]`);
  dropdown.classList.toggle("hidden", el.value !== "wrong");
}

function submitData(img_name) {
  let formData = [];
  let radios = document.querySelectorAll(`[name^="${img_name}_"]`);
  let processed = new Set();

  radios.forEach(el => {
    if (el.type === "radio" && el.checked) {
      if (processed.has(el.name)) return;
      processed.add(el.name);

      let dropdown = document.querySelector(`[name="${el.name}_dropdown"]`);

      formData.push({
        key: el.name,
        status: el.value,
        new_class: dropdown ? dropdown.value : ""
      });
    }
  });

  fetch("/save/" + img_name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formData)
  }).then(res => res.json())
    .then(data => alert(data.status === "saved" ? "✅ Saved!" : "❌ Error saving"))
    .catch(() => alert("❌ Network error"));
}
</script>
</body>
</html>
"""

# ---------------- FLASK APP ----------------
app = Flask(__name__)
detections_store = {}

@app.route("/")
def index():
    return render_template_string(HTML_PAGE, detections=detections_store, classes=CLASSES)

@app.route("/image/<filename>")
def serve_image(filename):
    return send_from_directory("temp", filename)

@app.route("/save/<img_name>", methods=["POST"])
def save(img_name):
    data = request.json

    img_path = os.path.join(INPUT_FOLDER, img_name)
    img = cv2.imread(img_path)

    if img is None:
        return {"status": "error", "message": "Image not found"}, 404

    h, w = img.shape[:2]
    detections = detections_store.get(img_name, [])
    label_lines = []

    for i, det in enumerate(detections):
        if i >= len(data):
            break

        user_input = data[i]

        if user_input["status"] == "correct":
            class_name = det["label"]
        else:
            class_name = user_input["new_class"]

        if class_name not in CLASSES:
            continue

        class_id = CLASSES.index(class_name)
        x1, y1, x2, y2 = det["box"]

        xc = ((x1 + x2) / 2) / w
        yc = ((y1 + y2) / 2) / h
        bw = (x2 - x1) / w
        bh = (y2 - y1) / h

        label_lines.append(f"{class_id} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}")

    shutil.copy(img_path, f"{OUTPUT_DATASET}/images/{img_name}")

    txt_name = os.path.splitext(img_name)[0] + ".txt"
    with open(f"{OUTPUT_DATASET}/labels/{txt_name}", "w") as f:
        f.write("\n".join(label_lines))

    return {"status": "saved"}

# ---------------- DETECTION (second code logic — clean + correct) ----------------
def run_detection():
    for img_name in os.listdir(INPUT_FOLDER):

        if not img_name.lower().endswith((".jpg", ".png", ".jpeg")):
            continue

        img_path = os.path.join(INPUT_FOLDER, img_name)
        img = cv2.imread(img_path)

        if img is None:
            continue

        all_detections = []
        detected_boxes = []  # tracks kept boxes for IOU dedup (from second code)

        # -------- MODEL S → SERVER ONLY (highest priority) --------
        results_s = model_s(img)[0]

        if results_s.boxes is not None and server_class_id_s is not None:
            for box in results_s.boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])

                # Only take "Server" from model_s
                if cls != server_class_id_s:
                    continue

                if conf < MIN_CONFIDENCE:
                    continue

                x1, y1, x2, y2 = map(int, box.xyxy[0])

                # Add server detection — no overlap check needed yet (first pass)
                all_detections.append({
                    "label": names_s[cls],
                    "box": [x1, y1, x2, y2],
                    "conf": conf
                })
                detected_boxes.append((x1, y1, x2, y2))

        # -------- MODEL L → ALL CLASSES EXCEPT SERVER --------
        results_l = model_l(img)[0]

        if results_l.boxes is not None:
            for box in results_l.boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])

                # Strictly skip server from model_l
                if server_class_id_l is not None and cls == server_class_id_l:
                    continue

                if conf < MIN_CONFIDENCE:
                    continue

                x1, y1, x2, y2 = map(int, box.xyxy[0])
                current_box = (x1, y1, x2, y2)

                # IOU dedup: skip if overlaps any already-kept box (second code logic)
                if any(compute_iou(current_box, prev) > 0.5 for prev in detected_boxes):
                    continue

                detected_boxes.append(current_box)

                all_detections.append({
                    "label": names_l[cls],
                    "box": [x1, y1, x2, y2],
                    "conf": conf
                })

        # Sort detections top-to-bottom so numbers remain in visual order
        all_detections.sort(key=lambda det: det["box"][1])

        # Store final detections (already deduped and ordered)
        detections_store[img_name] = all_detections

        # Draw with collision-free labels + detection numbers
        drawn = draw_boxes(img.copy(), all_detections)
        cv2.imwrite(f"temp/{img_name}", drawn)

        print(f"✅ {img_name} → {len(all_detections)} detections")

# ---------------- MAIN ----------------
if __name__ == "__main__":
    run_detection()
    app.run(debug=True)