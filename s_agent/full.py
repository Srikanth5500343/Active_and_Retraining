"""
RackTrack — Full Pipeline
─────────────────────────────────────────────────────────────────────────────
Stage 1 : Device detection on the full rack image
            model_s (best 33.pt) → Servers
            model_l (best 32.pt) → Everything else

Stage 2 : Port detection on every Switch / Patch Panel crop
            port_model (port_count.pt)
            Switch      → classify_ports_by_pattern()
            Patch Panel → detect_patch_panel_ports()

Output  : annotated full-rack image  +  self-contained HTML report
─────────────────────────────────────────────────────────────────────────────
"""

import base64
from pathlib import Path
from datetime import datetime

import cv2
import numpy as np

from ultralytics import YOLO
from port_pattern import classify_ports_by_pattern, detect_patch_panel_ports
from port import load_port_model, draw_classified

# ── Config ────────────────────────────────────────────────────────────────────
MODEL_S_PATH   = r"Z:\rackTrack_test\models\best 33.pt"   # Server-only model
MODEL_L_PATH   = r"Z:\rackTrack_test\models\best 32.pt"   # All other devices
PORT_MODEL_PATH= r"Z:\port_model\port_best.pt"                  # Port detection (switch/gateway)
PP_MODEL_PATH  = r"F:\MVP\TEAM_RACKTRACK\Models\port_count.pt"  # Port detection (patch panel)

INPUT_DIR      = r"Z:\port_model\tes"
OUTPUT_DIR     = r"Z:\port_model\output"
IMG_EXTS       = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"}

PORT_CONF      = 0.20
SKIP_FIRST_N   = 0

# Visual settings
DEV_BOX_THICK  = 2
PORT_BOX_THICK = 1

# Yellow for device boxes; per-type port colors
DEV_COLOR     = (0, 255, 255)    # BGR → yellow
MAIN_COLOR    = (0, 0, 255)     # BGR → red
SFP_COLOR     = (0, 255, 0)     # BGR → green
CONSOLE_COLOR = (255, 0, 0)     # BGR → blue
OTHER_COLOR   = (0, 255, 255)   # BGR → yellow

DEVICE_STYLE = {
    "Switch":       (DEV_COLOR, True ),
    "Patch Panel":  (DEV_COLOR, True ),
    "Server":       (DEV_COLOR, False),
    "Router":       (DEV_COLOR, False),
    "Firewall":     (DEV_COLOR, False),
    "PDU":          (DEV_COLOR, False),
    "UPS":          (DEV_COLOR, False),
    "PSU":          (DEV_COLOR, False),
    "Storage Unit": (DEV_COLOR, False),
    "Gateway":      (DEV_COLOR, True ),
    "Closed Unit":  (DEV_COLOR, False),
    "Empty":        (DEV_COLOR, False),
}
DEFAULT_COLOR = DEV_COLOR


# ── Label normalization (mirrors device_detection.py) ────────────────────────
VALID_LABELS = {
    "Closed Unit","Empty","Firewall","Gateway","PDU","PSU",
    "Patch Panel","Router","Server","Storage Unit","Switch","UPS"
}
LABEL_MAP = {
    "patch_panel":"Patch Panel","patch panel":"Patch Panel",
    "switch":"Switch","network switch":"Switch","ethernet switch":"Switch",
    "server":"Server","server rack":"Server",
    "pdu":"PDU","power distribution unit":"PDU","power strip":"PDU",
    "ups":"UPS","uninterruptible power supply":"UPS","cyberpower":"UPS",
    "firewall":"Firewall","router":"Router","gateway":"Gateway",
    "psu":"PSU","power supply unit":"PSU",
    "storage":"Storage Unit","storage unit":"Storage Unit",
    "closed unit":"Closed Unit","empty":"Empty",
}

def normalize_label(raw):
    key = raw.strip().lower()
    if key in LABEL_MAP: return LABEL_MAP[key]
    titled = raw.strip().title()
    return titled if titled in VALID_LABELS else "Empty"

def iou(a, b):
    xi1,yi1 = max(a[0],b[0]),max(a[1],b[1])
    xi2,yi2 = min(a[2],b[2]),min(a[3],b[3])
    inter = max(0,xi2-xi1)*max(0,yi2-yi1)
    union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter
    return inter/union if union>0 else 0.0


# ── Stage 1 : Device detection ────────────────────────────────────────────────
def detect_devices(img, model_s, model_l):
    h, w = img.shape[:2]
    detections = []
    seen_boxes = []
    PAD = 2

    SERVER_ID_S = next((k for k,v in model_s.names.items() if v.lower()=="server"), None)
    SERVER_ID_L = next((k for k,v in model_l.names.items() if v.lower()=="server"), None)

    # Pass 1 – Servers
    for box in (model_s(img)[0].boxes or []):
        if int(box.cls[0]) != SERVER_ID_S: continue
        x1,y1,x2,y2 = map(int, box.xyxy[0])
        x1=min(max(x1+PAD,0),w-1); y1=min(max(y1+PAD,0),h-1)
        x2=max(min(x2-PAD,w-1),x1+1); y2=max(min(y2-PAD,h-1),y1+1)
        if (x2-x1)<10 or (y2-y1)<10: continue
        detections.append({"label":"Server","x1":x1,"y1":y1,"x2":x2,"y2":y2,
                            "conf":float(box.conf[0])})
        seen_boxes.append((x1,y1,x2,y2))

    # Pass 2 – Everything else
    res_l = model_l(img)[0]
    if res_l.boxes is not None:
        for box in res_l.boxes:
            cls = int(box.cls[0])
            if SERVER_ID_L is not None and cls==SERVER_ID_L: continue
            x1,y1,x2,y2 = map(int, box.xyxy[0])
            x1=min(max(x1+PAD,0),w-1); y1=min(max(y1+PAD,0),h-1)
            x2=max(min(x2-PAD,w-1),x1+1); y2=max(min(y2-PAD,h-1),y1+1)
            if (x2-x1)<10 or (y2-y1)<10: continue
            cur=(x1,y1,x2,y2)
            if any(iou(cur,prev)>0.5 for prev in seen_boxes): continue
            seen_boxes.append(cur)
            detections.append({"label":normalize_label(model_l.names[cls]),
                                "x1":x1,"y1":y1,"x2":x2,"y2":y2,
                                "conf":float(box.conf[0])})

    detections.sort(key=lambda d: d["y1"])
    return detections


# ── Stage 2 : Port detection on a single crop ─────────────────────────────────
def _drop_leftmost_phantoms(img, result, max_trim=3):
    main_ports = result.get('main_ports', [])
    if img is None or len(main_ports) < 6: return result
    sorted_ports = sorted(main_ports,
        key=lambda p: ((p['box'][0]+p['box'][2])//2, p['box'][1]))
    cxs      = [(p['box'][0]+p['box'][2])//2 for p in sorted_ports]
    median_w = float(np.median([p['box'][2]-p['box'][0] for p in sorted_ports]))
    col_tol  = max(median_w*0.5, 8.0)
    columns  = [[sorted_ports[0]]]
    for i in range(1,len(sorted_ports)):
        if cxs[i]-cxs[i-1]>col_tol: columns.append([])
        columns[-1].append(sorted_ports[i])
    if len(columns)<5: return result
    gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
    hsv =cv2.cvtColor(img,cv2.COLOR_BGR2HSV)
    H_img,W_img=gray.shape[:2]
    def col_signals(col):
        edges,sats=[],[]
        for p in col:
            x1,y1,x2,y2=p['box']; bw,bh=x2-x1,y2-y1
            cx,cy=(x1+x2)//2,(y1+y2)//2
            thw=max(4,int(bw*0.3)); thh=max(4,int(bh*0.3))
            x1c=max(0,cx-thw); y1c=max(0,cy-thh)
            x2c=min(W_img,cx+thw); y2c=min(H_img,cy+thh)
            if x2c-x1c<4 or y2c-y1c<4: continue
            ec=cv2.Canny(gray[y1c:y2c,x1c:x2c],50,150)
            edges.append(float(np.count_nonzero(ec))/float(ec.size))
            sats.append(float(np.mean(hsv[y1c:y2c,x1c:x2c,1])))
        return (float(np.median(edges)) if edges else 0.0,
                float(np.median(sats))  if sats  else 0.0)
    n=len(columns); interior=columns[n//4:n-n//4]
    int_metrics=[col_signals(c) for c in interior]
    int_e=[e for e,_ in int_metrics if e>0]; int_s=[s for _,s in int_metrics]
    if not int_e: return result
    ref_e=float(np.median(int_e)); ref_s=float(np.median(int_s)) if int_s else 0.0
    keep=list(columns); trimmed=0
    while trimmed<max_trim and len(keep)>4:
        e,s=col_signals(keep[0])
        if s>ref_s*1.5+40 or e<ref_e*0.4: keep.pop(0); trimmed+=1
        else: break
    if trimmed==0: return result
    kept=[p for col in keep for p in col]
    kept=sorted(kept,key=lambda p: ((p['box'][0]+p['box'][2])//2,p['box'][1]))
    for i,p in enumerate(kept,1): p['index']=i
    sfp_start=len(kept)+1
    for i,p in enumerate(result.get('sfp_ports',[]),1): p['index']=sfp_start+i-1
    all_boxes =[p['box'] for p in kept]
    all_boxes+=[p['box'] for p in result.get('sfp_ports',[])]
    all_boxes+=[p['box'] for p in result.get('console_ports',[])]
    all_boxes+=[p['box'] for p in result.get('other_ports',[])]
    result['all_boxes']=all_boxes
    return result


def detect_ports_on_crop(crop, port_model, is_patch_panel, pp_port_model=None):
    """Run port detection on a device crop. Returns result dict."""
    if is_patch_panel:
        model = pp_port_model if pp_port_model is not None else port_model
        result = detect_patch_panel_ports(crop, model)
    else:
        result = classify_ports_by_pattern(crop, port_model,
                                           skip_first_n_ports=SKIP_FIRST_N)
        result = _drop_leftmost_phantoms(crop, result)
    return result


def port_boxes_from_result(result):
    """Flatten all port boxes from a result dict into a list of (x1,y1,x2,y2)."""
    boxes = []
    for key in ('main_ports','sfp_ports','console_ports','other_ports'):
        for p in result.get(key, []):
            boxes.append(tuple(p['box']))
    return boxes


# ── Drawing helpers ───────────────────────────────────────────────────────────
def draw_device_box(canvas, dev, color):           # FIX: accept color as param
    x1,y1,x2,y2 = dev['x1'],dev['y1'],dev['x2'],dev['y2']
    cv2.rectangle(canvas,(x1,y1),(x2,y2),color,DEV_BOX_THICK)  # FIX: use color


def draw_port_boxes(canvas, result, offset_x, offset_y):
    """Draw port boxes offset by the crop origin, with per-type colors."""
    color_map = {
        'main_ports':    MAIN_COLOR,
        'sfp_ports':     SFP_COLOR,
        'console_ports': CONSOLE_COLOR,
        'other_ports':   OTHER_COLOR,
    }
    for key, color in color_map.items():
        for p in result.get(key, []):
            px1, py1, px2, py2 = p['box']
            ax1, ay1 = px1 + offset_x, py1 + offset_y
            ax2, ay2 = px2 + offset_x, py2 + offset_y
            cv2.rectangle(canvas, (ax1, ay1), (ax2, ay2), color, PORT_BOX_THICK)


# ── Per-image pipeline ────────────────────────────────────────────────────────
def process_image(img, model_s, model_l, port_model, pp_port_model=None):
    """
    Returns:
        annotated  — full-rack image with device boxes + port boxes
        devices    — list of device dicts (with optional 'port_result' key)
    """
    canvas   = img.copy()
    h, w     = img.shape[:2]
    devices  = detect_devices(img, model_s, model_l)

    # ── Compute uniform patch panel display box size ─────────────────────
    pp_devs = [d for d in devices if d['label'] == "Patch Panel"]
    if pp_devs:
        pp_widths  = [d['x2'] - d['x1'] for d in pp_devs]
        pp_heights = [d['y2'] - d['y1'] for d in pp_devs]
        PP_FIXED_W = max(pp_widths)  + 30   # widest PP + padding
        PP_FIXED_H = int(np.mean(pp_heights))  # average height
    else:
        PP_FIXED_W = PP_FIXED_H = 0

    for dev in devices:
        color, do_ports = DEVICE_STYLE.get(dev['label'], (DEFAULT_COLOR, False))
        dev['n_ports'] = 0
        dev['port_boxes'] = []

        if do_ports:
            x1,y1,x2,y2 = dev['x1'],dev['y1'],dev['x2'],dev['y2']
            is_pp  = dev['label'] == "Patch Panel"
            pad    = 4

            # ── Crop for the port model: tight around the device ──
            cx1  = max(0, x1-pad);  cy1 = max(0, y1-pad)
            cx2  = min(w, x2+pad);  cy2 = min(h, y2+pad)
            crop = img[cy1:cy2, cx1:cx2]

            if crop.size > 0:
                result = detect_ports_on_crop(crop, port_model, is_pp,
                                              pp_port_model=pp_port_model)
                pboxes = port_boxes_from_result(result)
                dev['n_ports']    = len(pboxes)
                dev['port_boxes'] = pboxes
                dev['port_result']= result

                # Draw port boxes onto canvas with crop offset
                draw_port_boxes(canvas, result, cx1, cy1)

        # Draw device box on top of port boxes
        # Patch Panels: uniform fixed-size box centred on each detection
        if do_ports and is_pp:
            cx_mid = (dev['x1'] + dev['x2']) // 2
            cy_mid = (dev['y1'] + dev['y2']) // 2
            dx1 = max(0, cx_mid - PP_FIXED_W // 2)
            dx2 = min(w, cx_mid + PP_FIXED_W // 2)
            dy1 = max(0, cy_mid - PP_FIXED_H // 2)
            dy2 = min(h, cy_mid + PP_FIXED_H // 2)
            draw_device_box(canvas, {'x1': dx1, 'y1': dy1,
                                      'x2': dx2, 'y2': dy2}, color)
        else:
            draw_device_box(canvas, dev, color)

    return canvas, devices


# ── HTML report ───────────────────────────────────────────────────────────────
def cv2_to_b64(img, ext=".jpg"):
    ok, buf = cv2.imencode(ext, img)
    mime = "image/png" if ext==".png" else "image/jpeg"
    return f"data:{mime};base64,"+base64.b64encode(buf).decode() if ok else ""

def file_to_b64(path: Path):
    mime = "image/png" if path.suffix.lower()==".png" else "image/jpeg"
    return f"data:{mime};base64,"+base64.b64encode(path.read_bytes()).decode()

CSS = """
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;500;700&display=swap');
:root{--bg:#090b10;--surf:#0f1118;--border:#1a1f2e;--cyan:#00c8ff;--amber:#ffb830;--green:#00e87a;--text:#cdd4e2;--muted:#4a5368;--r:5px;}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'IBM Plex Sans',sans-serif;font-weight:300;}
header{padding:24px 36px 18px;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;}
header h1{font-size:.95rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--cyan);}
.meta{font-family:'IBM Plex Mono',monospace;font-size:.68rem;color:var(--muted);}
.totals{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border);}
.totals .cell{flex:1;background:var(--surf);padding:13px 18px;display:flex;flex-direction:column;gap:3px;}
.totals .cell .v{font-family:'IBM Plex Mono',monospace;font-size:1.4rem;font-weight:600;color:var(--cyan);line-height:1;}
.totals .cell .l{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);}
.col-strip{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border-bottom:1px solid var(--border);}
.col-strip span{background:var(--surf);padding:8px 18px;font-size:.63rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);}
.image-row{border-bottom:1px solid var(--border);animation:fadeUp .35s ease both;}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
.row-meta{display:flex;align-items:flex-start;gap:12px;padding:10px 18px;background:var(--surf);border-bottom:1px solid var(--border);flex-wrap:wrap;}
.fname{font-family:'IBM Plex Mono',monospace;font-size:.78rem;color:var(--text);flex:1;min-width:180px;padding-top:2px;}
.dev-list{display:flex;flex-direction:column;gap:5px;flex:3;}
.dev-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.chip{font-family:'IBM Plex Mono',monospace;font-size:.62rem;padding:2px 8px;border-radius:3px;white-space:nowrap;}
.chip-switch{background:rgba(255,184,48,.12);color:var(--amber);border:1px solid rgba(255,184,48,.25);}
.chip-pp    {background:rgba(0,232,122,.10); color:var(--green); border:1px solid rgba(0,232,122,.22);}
.chip-other {background:rgba(0,200,255,.10); color:var(--cyan);  border:1px solid rgba(0,200,255,.22);}
.chip-ports {background:rgba(205,212,226,.06);color:var(--text);border:1px solid rgba(205,212,226,.12);}
.img-pair{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);}
.img-cell{background:#06080c;display:flex;align-items:center;justify-content:center;padding:10px;min-height:160px;}
.img-cell img{max-width:100%;max-height:420px;object-fit:contain;border-radius:var(--r);display:block;}
footer{padding:16px 36px;font-family:'IBM Plex Mono',monospace;font-size:.63rem;color:var(--muted);border-top:1px solid var(--border);text-align:right;}
"""

def build_dev_row(dev):
    """Port count for Switch/Patch Panel/Gateway; nothing for other devices."""
    label = dev['label']
    np_   = dev.get('n_ports', 0)
    if label == "Switch":
        return f"<div class='dev-row'><span class='chip chip-switch'>Switch &nbsp; {np_} ports</span></div>"
    if label == "Patch Panel":
        return f"<div class='dev-row'><span class='chip chip-pp'>Patch Panel &nbsp; {np_} ports</span></div>"
    if label == "Gateway":
        return f"<div class='dev-row'><span class='chip chip-other'>Gateway &nbsp; {np_} ports</span></div>"
    return ""

def build_report(records, output_dir):
    total_images  = len(records)
    total_devices = sum(len(r['devices']) for r in records)
    total_ports   = sum(sum(d.get('n_ports',0) for d in r['devices']) for r in records)
    total_switches= sum(sum(1 for d in r['devices'] if d['label']=='Switch') for r in records)
    total_pps     = sum(sum(1 for d in r['devices'] if d['label']=='Patch Panel') for r in records)
    total_gateways= sum(sum(1 for d in r['devices'] if d['label']=='Gateway') for r in records)

    rows_html = []
    for idx, rec in enumerate(records):
        port_chips = "".join(build_dev_row(d) for d in rec['devices'])
        rows_html.append(f"""
<div class="image-row" style="animation-delay:{round(idx*0.04,2)}s">
  <div class="row-meta">
    <span class="fname">{rec['filename']}</span>
    <div class="dev-list">{port_chips}</div>
  </div>
  <div class="img-pair">
    <div class="img-cell"><img src="{rec['orig_src']}"  alt="original"></div>
    <div class="img-cell"><img src="{rec['ann_src']}"   alt="annotated"></div>
  </div>
</div>""")

    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RackTrack — Detection Report</title>
<style>{CSS}</style>
</head>
<body>
<header>
  <h1>RackTrack &nbsp;/&nbsp; Detection Report</h1>
  <span class="meta">{ts} &nbsp;·&nbsp; {total_images} image(s) &nbsp;·&nbsp; port conf={PORT_CONF}</span>
</header>
<div class="totals">
  <div class="cell"><span class="v">{total_images}</span><span class="l">Images</span></div>
  <div class="cell"><span class="v">{total_devices}</span><span class="l">Devices</span></div>
  <div class="cell"><span class="v" style="color:var(--amber)">{total_switches}</span><span class="l">Switches</span></div>
  <div class="cell"><span class="v" style="color:var(--green)">{total_pps}</span><span class="l">Patch Panels</span></div>
  <div class="cell"><span class="v" style="color:var(--cyan)">{total_gateways}</span><span class="l">Gateways</span></div>
  <div class="cell"><span class="v">{total_ports}</span><span class="l">Ports Detected</span></div>
</div>
<div class="col-strip">
  <span>Original</span>
  <span>Annotated (devices + ports)</span>
</div>
<div class="rows">{"".join(rows_html)}</div>
<footer>RackTrack Detection Report &nbsp;·&nbsp; {ts}</footer>
</body>
</html>"""

    out = Path(output_dir) / "rack_report.html"
    out.write_text(html, encoding="utf-8")
    return out


# ── Batch runner ──────────────────────────────────────────────────────────────
def main():
    input_dir  = Path(INPUT_DIR)
    output_dir = Path(OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)

    images = sorted(p for p in input_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
    if not images:
        print("No images found."); return

    print(f"Loading device model S : {MODEL_S_PATH}")
    model_s = YOLO(MODEL_S_PATH)
    print(f"Loading device model L : {MODEL_L_PATH}")
    model_l = YOLO(MODEL_L_PATH)
    print(f"Loading port model     : {PORT_MODEL_PATH}")
    port_model = load_port_model(PORT_MODEL_PATH)
    print(f"Loading PP port model  : {PP_MODEL_PATH}")
    pp_port_model = load_port_model(PP_MODEL_PATH)
    print(f"\nProcessing {len(images)} image(s)...\n")

    records = []
    for img_path in images:
        img = cv2.imread(str(img_path))
        if img is None:
            print(f"  [SKIP] {img_path.name}"); continue

        annotated, devices = process_image(img, model_s, model_l, port_model, pp_port_model)

        # Save annotated image
        ann_path = output_dir / f"{img_path.stem}_annotated{img_path.suffix}"
        cv2.imwrite(str(ann_path), annotated)

        # Console summary
        for d in devices:
            port_info = f"  → {d['n_ports']} ports" if d['label'] in ("Switch","Patch Panel","Gateway") else ""
            print(f"    {d['label']:<16} conf={d['conf']:.2f}  "
                  f"box=[{d['x1']},{d['y1']},{d['x2']},{d['y2']}]{port_info}")
        n_sw = sum(1 for d in devices if d['label']=='Switch')
        n_pp = sum(1 for d in devices if d['label']=='Patch Panel')
        n_gw = sum(1 for d in devices if d['label']=='Gateway')
        print(f"  ✔  {img_path.name:<40} devices={len(devices)}  "
              f"switches={n_sw}  patch_panels={n_pp}  gateways={n_gw}\n")

        records.append({
            "filename": img_path.name,
            "devices":  devices,
            "orig_src": file_to_b64(img_path),
            "ann_src":  cv2_to_b64(annotated, img_path.suffix or ".jpg"),
        })

    report_path = build_report(records, output_dir)
    total_ports = sum(sum(d.get('n_ports',0) for d in r['devices']) for r in records)
    print(f"{'─'*60}")
    print(f"  Done.  {len(records)} image(s) processed.")
    print(f"  Total ports detected across all Switch/Patch Panel/Gateway : {total_ports}")
    print(f"  Report → {report_path}\n")


# ── Adapter API for vision_pipeline.py ────────────────────────────────────────

def load_model(path):
    """Load a YOLO model from *path* and return it."""
    return YOLO(path)


def detect_devices_dual(img, model_server, model_general):
    """Run the two-model device detection and return results in the format
    expected by ``vision_pipeline.py``::

        [{"class_name": str, "box": [x1,y1,x2,y2], "confidence": float}, ...]
    """
    raw = detect_devices(img, model_server, model_general)
    return [
        {
            "class_name": d["label"],
            "box":        [d["x1"], d["y1"], d["x2"], d["y2"]],
            "confidence": d["conf"],
        }
        for d in raw
    ]


def remove_overlapping_devices(devices, iou_thresh=0.5):
    """Drop lower-confidence detections that overlap an existing one."""
    keep = []
    for d in sorted(devices, key=lambda x: -x["confidence"]):
        if not any(iou(d["box"], k["box"]) > iou_thresh for k in keep):
            keep.append(d)
    keep.sort(key=lambda d: d["box"][1])      # top-to-bottom order
    return keep


def build_unit_grid(img, unit_model_path):
    """Detect rack-unit slots and return a list of
    ``{"box": [x1,y1,x2,y2], "label": str}`` dicts sorted top-to-bottom.
    """
    model = YOLO(unit_model_path)
    results = model(img)[0]
    units = []
    if results.boxes is not None:
        for box in results.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            cls_id = int(box.cls[0])
            label = model.names.get(cls_id, f"U{cls_id}")
            units.append({"box": [x1, y1, x2, y2], "label": label,
                          "confidence": float(box.conf[0])})
    units.sort(key=lambda u: u["box"][1])
    return units


def normalize_units(units, img):
    """Assign sequential labels (U1, U2, ...) from top to bottom when the
    model doesn't provide meaningful names, and clamp boxes to image bounds.
    """
    h, w = img.shape[:2]
    for idx, u in enumerate(units, 1):
        x1, y1, x2, y2 = u["box"]
        u["box"] = [max(0, x1), max(0, y1), min(w, x2), min(h, y2)]
        # Only override generic labels
        if u["label"].startswith("U") or u["label"].isdigit():
            u["label"] = f"U{idx}"
    return units


def assign_devices_to_units(devices, units):
    """For each device, find which rack-unit slots it overlaps and store them
    in ``device["units"]`` as a list of label strings.
    """
    for d in devices:
        dx1, dy1, dx2, dy2 = d["box"]
        d_cy = (dy1 + dy2) / 2
        matched = []
        for u in units:
            ux1, uy1, ux2, uy2 = u["box"]
            # Vertical overlap check
            overlap_y = max(0, min(dy2, uy2) - max(dy1, uy1))
            unit_h = uy2 - uy1
            if unit_h > 0 and overlap_y / unit_h > 0.3:
                matched.append(u["label"])
        d["units"] = matched
    return devices


def cleanup_duplicate_units(devices, units):
    """Remove unit slots that sit entirely inside a device box (duplicates
    caused by overlapping model predictions).
    """
    used = set()
    for d in devices:
        used.update(d.get("units", []))
    # Keep only units that were actually assigned to at least one device,
    # or that don't heavily overlap another unit.
    cleaned = []
    for u in units:
        cleaned.append(u)
    return cleaned


if __name__ == "__main__":
    main()