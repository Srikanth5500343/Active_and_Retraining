import os
import json
import http.server
import socketserver
import webbrowser
import base64
from urllib.parse import urlparse
from datetime import datetime
from io import BytesIO
 
import torch
import torch.nn as nn
from torchvision import transforms, models
from PIL import Image
 
# ---------------- CONFIG ----------------
HTML_FILENAME = "cable_classification_upd_4.html"
SERVER_PORT = 8001
FEEDBACK_ROOT = "feedback_dir"
 
MODEL_PATH = r"C:\Users\GeethikaPallelapati\Downloads\best_model_efficientnet.pth"
 
CLASS_NAMES = [
    'LC_Aqua','RJ-45 Violet','RJ_45 Black','RJ_45 Blue','RJ_45 Brown',
    'RJ_45 Green','RJ_45 Grey','RJ_45 Orange','RJ_45 Pink','RJ_45 Red',
    'RJ_45 White','RJ_45 Yellow','SC_Orange','SC_Yellow'
]
 
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
 
# ---------------- MODEL ----------------
model = models.efficientnet_b0(weights=None)
model.classifier[1] = nn.Linear(model.classifier[1].in_features, len(CLASS_NAMES))
 
ckpt = torch.load(MODEL_PATH, map_location=device)
if isinstance(ckpt, dict):
    model.load_state_dict(ckpt.get("model_state_dict", ckpt))
else:
    model.load_state_dict(ckpt)
 
model.to(device).eval()
 
# ---------------- TRANSFORM ----------------
transform = transforms.Compose([
    transforms.Resize((256, 256)),
    transforms.ToTensor(),
])
 
def preprocess(path):
    return transform(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
 
# ---------------- PREDICT ----------------
def predict(path):
    x = preprocess(path)
    with torch.no_grad():
        out = model(x)
        probs = torch.softmax(out, dim=1)[0]
        conf, idx = torch.max(probs, 0)
 
    predicted_class = CLASS_NAMES[idx.item()]
    predicted_conf  = round(conf.item() * 100, 1)
 
    top4 = sorted(
        [(CLASS_NAMES[i], round(probs[i].item() * 100, 1))
         for i in range(len(CLASS_NAMES)) if i != idx.item()],
        key=lambda x: x[1], reverse=True
    )[:4]
 
    return predicted_class, predicted_conf, top4
 
# ---------------- BASE64 ----------------
def image_to_base64(path):
    img = Image.open(path).convert("RGB")
    img.thumbnail((150, 150))
    buf = BytesIO()
    img.save(buf, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
 
# ---------------- SAVE FEEDBACK ----------------
def save_feedback_image(img_b64, label):
    """
    Saves image ONLY if:
      - label is a valid class name
      - User selected 'No' (wrong prediction) and picked a correct label
    Creates the class folder only when needed. Skips if folder already exists.
    """
    if label not in CLASS_NAMES:
        print(f"⚠️  Invalid label '{label}' — skipping.")
        return
 
    label_folder = label.replace(" ", "_")
    folder_path  = os.path.join(FEEDBACK_ROOT, label_folder)
 
    # Create folder only if it doesn't already exist
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
        print(f"📁 Created folder: {folder_path}")
    else:
        print(f"📂 Folder already exists: {folder_path}")
 
    # Strip base64 header if present
    if img_b64.startswith("data:"):
        img_b64 = img_b64.split(",", 1)[1]
 
    ts       = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    filename = f"{label_folder}_{ts}.jpg"
    save_path = os.path.join(folder_path, filename)
 
    with open(save_path, "wb") as f:
        f.write(base64.b64decode(img_b64))
 
    print(f"✅ Saved → {save_path}")
 
# ---------------- HTTP SERVER ----------------
class Handler(http.server.SimpleHTTPRequestHandler):
 
    def do_POST(self):
        if urlparse(self.path).path == "/save_all":
            length = int(self.headers.get("Content-Length", 0))
            data   = json.loads(self.rfile.read(length).decode())
 
            saved_count = 0
 
            for row in data.get("rows", []):
                # Only process rows where user explicitly marked prediction as WRONG
                if row.get("changed") is True:
                    label = row.get("label", "").strip()
                    img_b64 = row.get("img_b64", "")
 
                    if label and img_b64:
                        save_feedback_image(img_b64, label)
                        saved_count += 1
                    else:
                        print("⚠️  Missing label or image data — skipping row.")
 
            response = json.dumps({"status": "saved", "count": saved_count})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(response.encode())
 
    def log_message(self, format, *args):
        pass  # Suppress default request logs
 
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
 
# ---------------- GENERATE HTML ----------------
def run_batch(folder):
    rows = []
 
    for f in sorted(os.listdir(folder)):
        if f.lower().endswith((".jpg", ".png", ".jpeg")):
            path = os.path.join(folder, f)
            predicted_class, conf, top4 = predict(path)
            rows.append((f, image_to_base64(path), predicted_class, conf, top4))
 
    # Build ALL class options for the correction dropdown (full list, not just top 4)
    all_class_options = "".join(
        [f'<option value="{c}">{c}</option>' for c in CLASS_NAMES]
    )
 
    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Cable Classification</title>
<style>
  body        {{ font-family: Arial; background: #0f172a; color: white; margin: 20px; }}
  h2          {{ color: #38bdf8; }}
  table       {{ width: 100%; border-collapse: collapse; margin-top: 16px; }}
  th, td      {{ border: 1px solid #334155; padding: 10px; vertical-align: middle; }}
  th          {{ background: #1e293b; text-align: center; }}
  tr:hover    {{ background: #1e293b; }}
  img         {{ width: 120px; border-radius: 6px; display: block; margin: auto; }}
  .predicted  {{ color: #38bdf8; font-weight: bold; }}
  select      {{ background: #1e293b; color: white; border: 1px solid #475569;
                 border-radius: 4px; padding: 4px 8px; width: 100%; }}
  button      {{ padding: 10px 24px; background: #38bdf8; color: #0f172a;
                 border: none; border-radius: 6px; font-size: 15px;
                 font-weight: bold; cursor: pointer; margin-bottom: 10px; }}
  button:hover {{ background: #7dd3fc; }}
  .tag-yes    {{ color: #4ade80; font-size: 12px; }}
  .tag-no     {{ color: #f87171; font-size: 12px; }}
</style>
 
<script>
  // Show/hide the correction dropdown based on Yes/No selection
  function toggleDropdown(id) {{
    const yn  = document.getElementById("yn_"  + id).value;
    const dd  = document.getElementById("dd_"  + id);
    const tag = document.getElementById("tag_" + id);
 
    if (yn === "no") {{
      dd.style.display  = "block";
      tag.className     = "tag-no";
      tag.innerText     = "⚠ Select correct class below";
    }} else {{
      dd.style.display  = "none";
      tag.className     = "tag-yes";
      tag.innerText     = "✔ Prediction accepted";
    }}
  }}
 
  async function saveAll() {{
    const rows = [];
 
    document.querySelectorAll("tr[id^='row_']").forEach(r => {{
      const id      = r.dataset.id;
      const yn      = document.getElementById("yn_"    + id).value;
      const changed = (yn === "no");   // true only when user says prediction is WRONG
 
      // If correct (yes) → label is ignored on server side anyway
      // If wrong  (no)  → label is whatever user selected in dropdown
      const label = changed
        ? document.getElementById("dd_" + id).value
        : document.getElementById("predicted_" + id).dataset.label;
 
      rows.push({{
        img_b64 : document.getElementById("img_" + id).src,
        label   : label,
        changed : changed   // server saves ONLY when this is true
      }});
    }});
 
    const res  = await fetch("/save_all", {{
      method  : "POST",
      headers : {{ "Content-Type": "application/json" }},
      body    : JSON.stringify({{ rows }})
    }});
 
    const json = await res.json();
    alert(`✅ Done! ${{json.count}} corrected image(s) saved to feedback_dir.`);
  }}
</script>
</head>
 
<body>
<h2>🧠 Cable Classification Report</h2>
<button onclick="saveAll()">💾 Save Corrections</button>
 
<table>
  <tr>
    <th>#</th>
    <th>Image</th>
    <th>File Name</th>
    <th>Predicted Class</th>
    <th>Confidence</th>
    <th>Correct?</th>
    <th>Correct Class (if wrong)</th>
  </tr>
"""
 
    for rid, (filename, b64, predicted_class, conf, top4) in enumerate(rows, start=1):
        html += f"""
  <tr id="row_{rid}" data-id="{rid}">
    <td style="text-align:center">{rid}</td>
    <td><img id="img_{rid}" src="{b64}"></td>
    <td style="font-size:12px; color:#94a3b8;">{filename}</td>
    <td>
      <span id="predicted_{rid}" class="predicted" data-label="{predicted_class}">
        {predicted_class}
      </span>
      <br>
      <small id="tag_{rid}" class="tag-yes">✔ Prediction accepted</small>
    </td>
    <td style="text-align:center">{conf}%</td>
    <td style="text-align:center">
      <select id="yn_{rid}" onchange="toggleDropdown('{rid}')">
        <option value="yes">✅ Yes</option>
        <option value="no">❌ No</option>
      </select>
    </td>
    <td>
      <!-- Full class list dropdown — hidden until user selects No -->
      <select id="dd_{rid}" style="display:none;">
        {all_class_options}
      </select>
    </td>
  </tr>
"""
 
    html += """
</table>
</body>
</html>
"""
 
    with open(HTML_FILENAME, "w", encoding="utf-8") as f:
        f.write(html)
 
    print(f"✅ HTML report generated: {HTML_FILENAME}  ({len(rows)} images)")
 
# ---------------- MAIN ----------------
if __name__ == "__main__":
    image_folder = r"C:\Users\GeethikaPallelapati\Downloads\cables 2\cables"
 
    run_batch(image_folder)
 
    server = Server(("0.0.0.0", SERVER_PORT), Handler)
    webbrowser.open(f"http://localhost:{SERVER_PORT}/{HTML_FILENAME}")
 
    print(f"🚀 Server running at http://localhost:{SERVER_PORT}")
    server.serve_forever()
 
 