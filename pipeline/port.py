import os
import cv2
import numpy as np
from ultralytics import YOLO

# Step 05: Port detection and highlighting

MODEL_PATH = r"H:/Integration/Models/port_count.pt"
CONF = 0.23
BOX_W = 30
BOX_H = 35


def verify_boxes_with_edges(img, boxes, min_edge_pct=0.04):
    """Drop boxes whose image region has too few edges (blank panel area).

    Converts each box crop to grayscale → Canny edges → edge pixel %.
    Real ports have connector outlines, cables, labels — high edge density.
    Blank panel / empty space has almost no edges.
    """
    if not boxes or img is None:
        return boxes
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    h_img, w_img = gray.shape[:2]
    verified = []
    for b in boxes:
        x1 = max(0, int(b[0]))
        y1 = max(0, int(b[1]))
        x2 = min(w_img, int(b[2]))
        y2 = min(h_img, int(b[3]))
        if x2 <= x1 or y2 <= y1:
            continue
        crop = gray[y1:y2, x1:x2]
        edges = cv2.Canny(crop, 50, 150)
        area = edges.shape[0] * edges.shape[1]
        if area == 0:
            continue
        edge_pct = np.count_nonzero(edges) / area
        if edge_pct >= min_edge_pct:
            verified.append(b)
    return verified


def load_port_model(model_path: str = MODEL_PATH):
    return YOLO(model_path)


# Minimum confidence required to call a port 'connected' or 'empty'. Below
# this we return 'unknown' — the downstream cable / port-type classifiers
# only run on high-confidence calls, which cuts false positives on blurry
# or ambiguous ports.
PORT_STATUS_CONF_MIN = 0.35


def infer_port_status(class_name: str, confidence: float = None):
    if confidence is not None and confidence < PORT_STATUS_CONF_MIN:
        return 'unknown'
    if not class_name:
        return 'unknown'
    key = class_name.strip().lower()
    if any(term in key for term in ('connect', 'connected', 'plug', 'occupied', 'cable', 'linked', 'live', 'active')):
        return 'connected'
    if any(term in key for term in ('empty', 'vacant', 'free', 'none', 'unused', 'unconnected')):
        return 'empty'
    return 'unknown'


def get_port_detections(img, model, conf: float = CONF):
    # agnostic_nms lets Empty_port and Connected_port detections suppress each
    # other when they overlap — without it, both classes can fire on the same
    # physical port and create duplicate boxes. iou=0.3 is stricter than the
    # default 0.7 so even slightly overlapping duplicates get culled.
    results = model(img, conf=conf, iou=0.3, agnostic_nms=True)
    if not results or results[0].boxes is None:
        return []

    xyxy = results[0].boxes.xyxy.cpu().numpy()
    cls_ids = results[0].boxes.cls.cpu().numpy().astype(int)
    scores = results[0].boxes.conf.cpu().numpy()
    names = getattr(model, 'names', {})

    detections = []
    for i, (x1, y1, x2, y2) in enumerate(xyxy):
        cx = int(round((x1 + x2) / 2))
        cy = int(round((y1 + y2) / 2))
        class_id = int(cls_ids[i])
        class_name = str(names.get(class_id, class_id))
        detections.append({
            'center': (cx, cy),
            'class_id': class_id,
            'class_name': class_name,
            'confidence': float(scores[i]),
        })

    return sorted(detections, key=lambda item: (item['center'][0], item['center'][1]))


def get_port_centers(img, model, conf: float = CONF):
    return [d['center'] for d in get_port_detections(img, model, conf=conf)]


def detect_ports(img, model, conf: float = CONF):
    detections = get_port_detections(img, model, conf=conf)
    centers = [d['center'] for d in detections]
    top, bot, r1, r2 = find_rows(centers, img.shape[0])
    dx = get_dx(centers)
    tol = dx * 0.5
    cols = build_columns([x for x, _ in top], [x for x, _ in bot], tol)
    hw = max(3, int(dx * 0.45))
    hh = max(3, int(dx * 0.55))
    boxes = get_boxes(cols, r1, r2, hw=hw, hh=hh, detections=detections, img_h=img.shape[0])
    boxes = verify_boxes_with_edges(img, boxes)

    ports = []
    for idx, box in enumerate(boxes, 1):
        cx = (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        class_name = None
        confidence = 0.0
        status = 'unknown'

        if detections:
            best = min(
                detections,
                key=lambda d: (d['center'][0] - cx) ** 2 + (d['center'][1] - cy) ** 2,
            )
            class_name = best['class_name']
            confidence = best['confidence']
            status = infer_port_status(class_name, confidence)

        ports.append({
            'index': idx,
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy],
            'status': status,
            'class_name': class_name,
            'confidence': confidence,
        })

    return ports, boxes


def find_rows(ports, H):
    mid = H // 2
    top = [(x, y) for x, y in ports if y < mid]
    bot = [(x, y) for x, y in ports if y >= mid]

    # Both rows detected → existing iterative refinement.
    if top and bot:
        r1, r2 = np.mean([y for _, y in top]), np.mean([y for _, y in bot])
        for _ in range(10):
            nt = [(x, y) for x, y in ports if abs(y - r1) <= abs(y - r2)]
            nb = [(x, y) for x, y in ports if abs(y - r1) > abs(y - r2)]
            r1n = np.mean([y for _, y in nt]) if nt else r1
            r2n = np.mean([y for _, y in nb]) if nb else r2
            if abs(r1n - r1) < 0.1 and abs(r2n - r2) < 0.1:
                break
            r1, r2 = r1n, r2n
        return nt, nb, int(r1), int(r2)

    # Neither row detected → nothing to do.
    if not top and not bot:
        return [], [], None, None

    # Only one row detected. The most common cause is cable occlusion of
    # the second row on a 2-row switch / patch panel — the YOLO model
    # under-fires on the hidden row and `bot` (or `top`) ends up empty.
    #
    # Heuristic for inferring the missing row: position of the detected
    # band relative to the crop tells us whether we're looking at a
    # 2-row device with one row hidden, or a true 1-row device.
    #   - upper third (y < H/3)     → 2-row, missing row is below
    #   - lower third (y > 2H/3)    → 2-row, missing row is above
    #   - middle third              → genuine 1-row device, no inference
    pts = top or bot
    ys  = [y for _, y in pts]
    y_mean = float(np.mean(ys))

    if y_mean < H / 3:
        # Detected band sits in the top third → infer bottom row by mirror.
        r1 = int(y_mean)
        r2 = int(H - y_mean)
        return pts, [], r1, r2
    if y_mean > 2 * H / 3:
        # Detected band sits in the bottom third → infer top row.
        r2 = int(y_mean)
        r1 = int(H - y_mean)
        return [], pts, r1, r2

    # Middle: single-row device. No inference.
    return top, bot, \
        (int(y_mean) if top else None), \
        (int(y_mean) if bot else None)


def get_dx(ports):
    if len(ports) < 2:
        return BOX_W
    xs = sorted(set(x for x, _ in ports))
    dx = np.diff(xs)
    dx = dx[dx > 5]
    return float(np.median(dx)) if len(dx) else BOX_W


def has_top_on_both_sides(bcx, top_cxs):
    return any(t < bcx for t in top_cxs) and any(t > bcx for t in top_cxs)


def build_columns(top_cxs, bot_cxs, tol):
    cols = [{'cx': cx, 'type': 'top_paired'} for cx in sorted(top_cxs)]

    for b in bot_cxs:
        # Skip if this bottom detection aligns with any existing column
        if any(abs(b - c['cx']) < tol for c in cols):
            continue
        if has_top_on_both_sides(b, top_cxs):
            cols.append({'cx': b, 'type': 'consec_bot'})
        else:
            cols.append({'cx': b, 'type': 'separate_bot'})

    return sorted(cols, key=lambda c: c['cx'])


def get_boxes(cols, r1, r2, hw=None, hh=None, detections=None, img_h=None):
    boxes = []
    if hw is None:
        hw = BOX_W // 2
    if hh is None:
        hh = BOX_H // 2

    # Cap box size: a port should never be taller than 30% of device height
    # or wider than 5% of a typical rack-width device.
    if img_h:
        max_hh = max(5, int(img_h * 0.15))
        max_hw = max(5, int(img_h * 0.25))
        hh = min(hh, max_hh)
        hw = min(hw, max_hw)

    for c in cols:
        cx, t = c['cx'], c['type']

        if t in ('top_paired', 'consec_bot'):
            if r1:
                boxes.append((cx - hw, r1 - hh, cx + hw, r1 + hh))
            if r2:
                boxes.append((cx - hw, r2 - hh, cx + hw, r2 + hh))

        elif t == 'separate_bot' and r2:
            boxes.append((cx - hw, r2 - hh, cx + hw, r2 + hh))

    # Column-based validation: if ANY detection aligns in x with a box,
    # keep ALL boxes at that x (preserves both rows for 2-row switches).
    # Edge verification downstream catches blank-area phantoms.
    if detections and boxes:
        det_xs = [d['center'][0] for d in detections]
        margin_x = hw * 0.5
        validated = []
        for b in boxes:
            bcx = (b[0] + b[2]) // 2
            if any(abs(px - bcx) <= margin_x for px in det_xs):
                validated.append(b)
        boxes = validated

    return boxes


def draw(img, ports, boxes, highlight_idx):
    out = img.copy()
    centers = []

    for p in ports:
        x, y = p['center']
        cv2.circle(out, (x, y), 4, (0, 0, 255), -1)

    for i, (x1, y1, x2, y2) in enumerate(boxes, 1):
        cx = (x1 + x2) // 2
        cy = (y1 + y2) // 2
        centers.append((cx, cy))

        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 0, 255), 2)
        cv2.putText(out, str(i), (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3)
        cv2.putText(out, str(i), (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

    if len(centers) > 0:
        if 1 <= highlight_idx <= len(centers):
            hx, hy = centers[highlight_idx - 1]
            cv2.circle(out, (hx, hy), 16, (0, 255, 0), 4)
        else:
            hx, hy = centers[-1]
            cv2.circle(out, (hx, hy), 16, (0, 165, 255), 4)

    return out


def highlight_ports_in_image(image_path: str,
                             target_port: int,
                             output_path: str,
                             model_path: str = MODEL_PATH,
                             conf: float = CONF):
    model = load_port_model(model_path)
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Unable to open image: {image_path}")

    ports, boxes = detect_ports(img, model, conf=conf)
    result = draw(img, ports, boxes, target_port)
    cv2.imwrite(output_path, result)
    return output_path, ports, boxes


# ---------------------------------------------------------------------------
# Port classification: console / main / SFP
# ---------------------------------------------------------------------------

def _classify_columns(cols, top_cxs):
    """Column-based classification (primary).

    * ``separate_bot`` left of all paired columns  → console
    * ``separate_bot`` right of all paired columns → SFP
    * everything else (paired / consec_bot)        → main
    """
    if not cols:
        return cols, [], []
    if not top_cxs:
        return [], cols, []

    min_paired = min(top_cxs)
    max_paired = max(top_cxs)

    main, console_cols, sfp_cols = [], [], []
    for c in cols:
        if c['type'] == 'separate_bot':
            if c['cx'] < min_paired:
                console_cols.append(c)
            else:
                sfp_cols.append(c)
        else:
            main.append(c)
    return main, console_cols, sfp_cols


def _rescue_by_gap(main_cols, console_cols, sfp_cols):
    """Gap-based rescue (secondary) — applies only to console columns.

    If a console column sits within 2× the median main-column spacing
    of its nearest main neighbour, it is likely a cable-covered main
    port and gets merged back into main.

    SFP columns are NOT rescued — the column-based classification
    (bottom-only at right of paired region) is reliable for SFP.
    """
    if not main_cols or not console_cols:
        return main_cols, console_cols, sfp_cols

    main_xs = sorted(c['cx'] for c in main_cols)
    if len(main_xs) >= 2:
        spacings = [main_xs[i + 1] - main_xs[i] for i in range(len(main_xs) - 1)]
        median_sp = sorted(spacings)[len(spacings) // 2]
        gap_threshold = max(median_sp * 1.5, BOX_W * 1.5)
    else:
        gap_threshold = BOX_W * 2

    rescued = []
    kept_console = []
    for c in console_cols:
        if min(abs(c['cx'] - mx) for mx in main_xs) < gap_threshold:
            rescued.append(c)
        else:
            kept_console.append(c)

    merged_main = sorted(main_cols + rescued, key=lambda c: c['cx'])
    return merged_main, kept_console, sfp_cols


def detect_and_classify_ports(img, model, conf=CONF):
    """Detect ports and classify into console, main, and SFP categories.

    Uses two layers of classification:

    1. **Column-based** (primary) – bottom-only columns left of the
       paired region are console; bottom-only columns right of the
       paired region are SFP; paired columns are main.
    2. **Gap-based rescue** (secondary) – any console/SFP column whose
       x-distance to the nearest main column is within 2× the median
       main spacing is merged back into main.  This prevents
       cable-covered top ports from being misclassified.

    Returns a dict::

        {
            'console_ports': [...],   # left-side, gap-separated
            'main_ports':    [...],   # primary port grid, indexed 1..N
            'sfp_ports':     [...],   # right-side, gap-separated
            'all_boxes':     [...],   # every port box for annotation
        }

    Only *main_ports* carry an ``index`` key (1-based numbering).
    """
    detections = get_port_detections(img, model, conf=conf)
    empty = {'console_ports': [], 'main_ports': [],
             'sfp_ports': [], 'all_boxes': []}
    if not detections:
        return empty

    hw, hh = BOX_W // 2, BOX_H // 2
    centers = [(d['center'][0], d['center'][1]) for d in detections]

    # ------------------------------------------------------------------
    # Step 1 – rows & columns from ALL detections
    # ------------------------------------------------------------------
    top, bot, r1, r2 = find_rows(centers, img.shape[0])
    dx = get_dx(centers)
    tol = dx * 0.5
    top_cxs = [x for x, _ in top]
    bot_cxs = [x for x, _ in bot]
    cols = build_columns(top_cxs, bot_cxs, tol)

    # ------------------------------------------------------------------
    # Step 2 – column-based classification (primary)
    # ------------------------------------------------------------------
    main_cols, console_cols, sfp_cols = _classify_columns(cols, top_cxs)

    # ------------------------------------------------------------------
    # Step 3 – gap-based rescue (secondary)
    # ------------------------------------------------------------------
    main_cols, console_cols, sfp_cols = _rescue_by_gap(
        main_cols, console_cols, sfp_cols,
    )

    # ------------------------------------------------------------------
    # Step 4 – build boxes
    # ------------------------------------------------------------------
    main_boxes = get_boxes(main_cols, r1, r2, detections=detections, img_h=img.shape[0])
    sfp_boxes = get_boxes(sfp_cols, r1, r2, detections=detections, img_h=img.shape[0])
    console_boxes = get_boxes(console_cols, r1, r2, detections=detections, img_h=img.shape[0])

    # ------------------------------------------------------------------
    # Step 5 – build port dicts
    # ------------------------------------------------------------------
    all_dets = detections

    def _match(cx, cy):
        best = min(all_dets,
                   key=lambda d: (d['center'][0] - cx) ** 2
                               + (d['center'][1] - cy) ** 2)
        return (best['class_name'], best['confidence'],
                infer_port_status(best['class_name'], best['confidence']))

    main_ports = []
    for idx, box in enumerate(main_boxes, 1):
        cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
        cn, cf, st = _match(cx, cy)
        main_ports.append({
            'index': idx,
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy], 'status': st,
            'class_name': cn, 'confidence': cf,
            'port_category': 'main',
        })

    sfp_ports = []
    for box in sfp_boxes:
        cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
        cn, cf, st = _match(cx, cy)
        sfp_ports.append({
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy], 'status': st,
            'class_name': cn, 'confidence': cf,
            'port_category': 'sfp',
        })

    console_ports = []
    for box in console_boxes:
        cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
        cn, cf, st = _match(cx, cy)
        console_ports.append({
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy], 'status': st,
            'class_name': cn, 'confidence': cf,
            'port_category': 'console',
        })

    all_boxes = list(console_boxes) + list(main_boxes) + list(sfp_boxes)
    return {'console_ports': console_ports, 'main_ports': main_ports,
            'sfp_ports': sfp_ports, 'all_boxes': all_boxes}


def _boxes_to_ports(boxes, detections, category):
    """Helper: convert raw boxes into port dicts matched to nearest detection."""
    ports = []
    for box in boxes:
        cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
        if detections:
            best = min(detections,
                       key=lambda d: (d['center'][0] - cx) ** 2
                                   + (d['center'][1] - cy) ** 2)
            cn, cf = best['class_name'], best['confidence']
            st = infer_port_status(cn, cf)
        else:
            cn, cf, st = None, 0.0, 'unknown'
        ports.append({
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy], 'status': st,
            'class_name': cn, 'confidence': cf,
            'port_category': category,
        })
    return ports


def draw_classified(img, classified, highlight_idx=None):
    """Draw classified ports. If highlight_idx is set, only draw that port."""
    out = img.copy()
    CLR_C = (255, 255, 0)    # cyan   - console
    CLR_M = (0, 0, 255)      # red    - main
    CLR_O = (0, 255, 255)    # yellow - other
    CLR_H = (0, 255, 0)      # green  - highlighted

    # When a specific port is selected, only draw that one
    if highlight_idx is not None:
        for p in classified.get('main_ports', []):
            if p['index'] == highlight_idx:
                x1, y1, x2, y2 = p['box']
                cv2.rectangle(out, (x1, y1), (x2, y2), CLR_H, 2)
                cv2.circle(out, (p['center'][0], p['center'][1]), 12, CLR_H, 3)
                break
        return out

    for p in classified.get('console_ports', []):
        x1, y1, x2, y2 = p['box']
        cv2.rectangle(out, (x1, y1), (x2, y2), CLR_C, 2)
        cv2.putText(out, 'C', (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, CLR_C, 1)

    for p in classified.get('main_ports', []):
        x1, y1, x2, y2 = p['box']
        idx = p['index']
        cv2.rectangle(out, (x1, y1), (x2, y2), CLR_M, 2)
        cv2.putText(out, str(idx), (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3)
        cv2.putText(out, str(idx), (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

    for p in classified.get('sfp_ports', []):
        x1, y1, x2, y2 = p['box']
        cv2.rectangle(out, (x1, y1), (x2, y2), CLR_O, 2)
        cv2.putText(out, 'S', (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, CLR_O, 1)

    CLR_OT = (0, 165, 255)   # orange - other
    for p in classified.get('other_ports', []):
        x1, y1, x2, y2 = p['box']
        cv2.rectangle(out, (x1, y1), (x2, y2), CLR_OT, 2)
        cv2.putText(out, 'O', (x1, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, CLR_OT, 1)

    return out
