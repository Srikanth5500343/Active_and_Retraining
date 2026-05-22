"""
Port pattern analysis — classify ports by model's predicted class.

Geometric/pattern logic is retained only for **within-category cleanup**:
  - phantom edge-column removal on main ports
  - cross-category overlap removal
  - patch panel grid completion (uniform grid, equal gaps, best-fit 24-col)

Usage::

    from port_pattern import classify_ports_by_pattern
    from port_pattern import detect_patch_panel_ports
"""

import cv2
import numpy as np

from port import (
    get_port_detections, find_rows, get_dx, build_columns,
    get_boxes, infer_port_status, draw_classified,
    verify_boxes_with_edges,
    BOX_W, BOX_H, CONF,
)

# ── Config ───────────────────────────────────────────────────────────────────
START_PORT = 1

PORT_CATEGORY_KEYWORDS = {
    'sfp':     ('sfp', 'sfp+', 'qsfp', 'fiber', 'optic', 'fibre'),
    'console': ('console', 'serial', 'mgmt', 'management', 'aux'),
    'main':    ('main', 'rj45', 'rj-45', 'ethernet', 'eth', 'lan',
                'occupied', 'empty', 'port'),
}
_CATEGORY_ORDER = ('sfp', 'console', 'main')


def _classify_by_class_name(class_name: str) -> str:
    if not class_name:
        return 'other'
    n = class_name.lower().strip().replace('-', '').replace('_', '').replace(' ', '')
    for category in _CATEGORY_ORDER:
        for kw in PORT_CATEGORY_KEYWORDS[category]:
            if kw.replace('-', '').replace('_', '').replace(' ', '') in n:
                return category
    return 'other'


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def cluster_ports(detections):
    if len(detections) < 2:
        return [list(detections)] if detections else []

    sorted_dets = sorted(detections, key=lambda d: d['center'][0])
    xs = [d['center'][0] for d in sorted_dets]

    col_tol = BOX_W // 3
    col_xs = [xs[0]]
    for x in xs[1:]:
        if x - col_xs[-1] > col_tol:
            col_xs.append(x)

    if len(col_xs) < 2:
        return [sorted_dets]

    col_gaps = sorted(col_xs[i + 1] - col_xs[i] for i in range(len(col_xs) - 1))
    median_gap = col_gaps[len(col_gaps) // 2]
    threshold = median_gap * 1.3

    clusters = [[sorted_dets[0]]]
    for i in range(1, len(sorted_dets)):
        if xs[i] - xs[i - 1] > threshold:
            clusters.append([sorted_dets[i]])
        else:
            clusters[-1].append(sorted_dets[i])

    if len(clusters) >= 3:
        biggest = max(len(c) for c in clusters)
        while (len(clusters) >= 2
               and len(clusters[-1]) < biggest * 0.5
               and len(clusters[-2]) < biggest * 0.5):
            clusters[-2].extend(clusters.pop())

    return clusters


# ---------------------------------------------------------------------------
# Overlap removal
# ---------------------------------------------------------------------------

def _overlap_ratio(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = max(1, (a[2] - a[0]) * (a[3] - a[1]))
    area_b = max(1, (b[2] - b[0]) * (b[3] - b[1]))
    return inter / min(area_a, area_b)


def _remove_overlapping_ports(ports, threshold=0.3):
    kept = []
    for p in ports:
        if any(_overlap_ratio(p['box'], k['box']) > threshold for k in kept):
            continue
        kept.append(p)
    return kept


def _drop_isolated_left_edge_ports(main_ports, dx):
    if len(main_ports) < 5:
        return main_ports

    xs = [p['center'][0] for p in main_ports]
    unique_xs = sorted(set(xs))
    if len(unique_xs) < 4:
        return main_ports

    gaps = [unique_xs[i] - unique_xs[i - 1] for i in range(1, len(unique_xs))]
    if not gaps:
        return main_ports

    median_gap = float(np.median(gaps))
    threshold = max(median_gap * 1.4, dx * 1.5, BOX_W * 1.5)

    if gaps[0] <= threshold:
        return main_ports

    split_idx = next((i for i, gap in enumerate(gaps) if gap > threshold), None)
    if split_idx is None or split_idx == 0:
        return main_ports

    left_cluster = unique_xs[:split_idx]
    right_cluster = unique_xs[split_idx:]
    if len(left_cluster) <= 2 and len(right_cluster) >= 4:
        drop_set = set(left_cluster)
        return [p for p in main_ports if p['center'][0] not in drop_set]

    return main_ports


# ---------------------------------------------------------------------------
# Pattern analysis
# ---------------------------------------------------------------------------

def analyze_pattern(clusters):
    if not clusters:
        return 0, [], [], []

    sizes = [len(c) for c in clusters]
    from collections import Counter
    main_pattern = Counter(sizes).most_common(1)[0][0]

    def matches(s):
        return main_pattern > 0 and s >= main_pattern * 0.6

    first_main = len(clusters)
    last_main = -1
    for i, s in enumerate(sizes):
        if matches(s):
            first_main = min(first_main, i)
            last_main = max(last_main, i)

    main_idx, sfp_idx, console_idx = [], [], []
    for i in range(len(clusters)):
        if i < first_main:
            console_idx.append(i)
        elif i > last_main:
            sfp_idx.append(i)
        else:
            main_idx.append(i)

    return main_pattern, main_idx, sfp_idx, console_idx


# ---------------------------------------------------------------------------
# Edge-density helpers
# ---------------------------------------------------------------------------

def _edge_density(img, box):
    x1, y1, x2, y2 = box
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    edges = cv2.Canny(gray, 50, 150)
    return float(np.mean(edges)) / 255.0


def _port_crop_density(gray, box):
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    thw = max(4, int(bw * 0.3))
    thh = max(4, int(bh * 0.3))
    h_img, w_img = gray.shape[:2]
    x1c = max(0, cx - thw)
    y1c = max(0, cy - thh)
    x2c = min(w_img, cx + thw)
    y2c = min(h_img, cy + thh)
    if x2c - x1c < 4 or y2c - y1c < 4:
        return None
    crop = gray[y1c:y2c, x1c:x2c]
    edges = cv2.Canny(crop, 50, 150)
    return float(np.count_nonzero(edges)) / float(edges.size)


def _drop_phantom_edge_ports(img, ports, max_trim_per_side=4, density_ratio=0.5):
    if img is None or len(ports) < 6:
        return ports

    sorted_ports = sorted(
        ports,
        key=lambda p: ((p['box'][0] + p['box'][2]) // 2, p['box'][1]),
    )
    cxs = [(p['box'][0] + p['box'][2]) // 2 for p in sorted_ports]
    median_box_w = float(np.median(
        [p['box'][2] - p['box'][0] for p in sorted_ports]
    ))
    col_tol = max(median_box_w * 0.5, 8.0)

    columns = [[sorted_ports[0]]]
    for i in range(1, len(sorted_ports)):
        if cxs[i] - cxs[i - 1] > col_tol:
            columns.append([])
        columns[-1].append(sorted_ports[i])

    if len(columns) < 5:
        return ports

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img

    def _col_density(col):
        ds = [_port_crop_density(gray, p['box']) for p in col]
        ds = [d for d in ds if d is not None]
        return float(np.median(ds)) if ds else 0.0

    n = len(columns)
    interior = columns[n // 4: n - n // 4]
    interior_densities = [_col_density(c) for c in interior]
    interior_densities = [d for d in interior_densities if d > 0]
    if not interior_densities:
        return ports

    ref_density = float(np.median(interior_densities))
    threshold = ref_density * density_ratio

    keep = list(columns)
    trimmed_left = 0
    while trimmed_left < max_trim_per_side and len(keep) > 4:
        if _col_density(keep[0]) < threshold:
            keep.pop(0)
            trimmed_left += 1
        else:
            break

    trimmed_right = 0
    while trimmed_right < max_trim_per_side and len(keep) > 4:
        if _col_density(keep[-1]) < threshold:
            keep.pop()
            trimmed_right += 1
        else:
            break

    if trimmed_left == 0 and trimmed_right == 0:
        return ports

    print(
        f"DEBUG: phantom-edge trim → dropped {trimmed_left} column(s) on left, "
        f"{trimmed_right} on right"
    )
    return [p for col in keep for p in col]


# ---------------------------------------------------------------------------
# Main entry point — class-aware classification
# ---------------------------------------------------------------------------

def classify_ports_by_pattern(img, model, conf=CONF, skip_first_n_ports=0):
    detections = get_port_detections(img, model, conf=conf)
    empty = {
        'console_ports': [], 'main_ports': [], 'sfp_ports': [],
        'other_ports':   [], 'all_boxes': [],
        'pattern_info':  {'main_cluster_size': 0, 'num_clusters': 0,
                          'cluster_sizes': []},
    }
    if len(detections) < 2:
        return empty

    unique_classes = sorted({d.get('class_name', '') for d in detections})
    print(f"DEBUG: model classes in this crop: {unique_classes}")

    by_cat = {'main': [], 'sfp': [], 'console': [], 'other': []}
    for d in detections:
        cat = _classify_by_class_name(d.get('class_name', ''))
        by_cat[cat].append(d)

    if by_cat['other']:
        if by_cat['main']:
            main_left_x = min(d['center'][0] for d in by_cat['main'])
        else:
            main_left_x = float('-inf')

        n_to_console = n_to_sfp = 0
        for d in by_cat['other']:
            if d['center'][0] < main_left_x:
                by_cat['console'].append(d)
                n_to_console += 1
            else:
                by_cat['sfp'].append(d)
                n_to_sfp += 1
        print(
            f"DEBUG: reclassified {len(by_cat['other'])} 'other' detection(s) "
            f"→ {n_to_console} console, {n_to_sfp} sfp"
        )
        by_cat['other'] = []

    def _make_port(d, category):
        bb = d.get('bbox')
        if bb is not None:
            x1, y1, x2, y2 = (int(v) for v in bb)
        else:
            cx0, cy0 = d['center']
            x1 = int(cx0 - BOX_W // 2)
            y1 = int(cy0 - BOX_H // 2)
            x2 = int(cx0 + BOX_W // 2)
            y2 = int(cy0 + BOX_H // 2)
        cx = (x1 + x2) // 2
        cy = (y1 + y2) // 2
        cn = d.get('class_name', '')
        return {
            'box':            [x1, y1, x2, y2],
            'center':         [cx, cy],
            'status':         infer_port_status(cn),
            'class_name':     cn,
            'confidence':     float(d.get('confidence', 0.0)),
            'port_category':  category,
        }

    main_ports    = [_make_port(d, 'main')    for d in by_cat['main']]
    sfp_ports     = [_make_port(d, 'sfp')     for d in by_cat['sfp']]
    console_ports = [_make_port(d, 'console') for d in by_cat['console']]
    other_ports   = [_make_port(d, 'other')   for d in by_cat['other']]

    ordered = sfp_ports + console_ports + main_ports + other_ports
    ordered = _remove_overlapping_ports(ordered, threshold=0.3)
    main_ports    = [p for p in ordered if p['port_category'] == 'main']
    sfp_ports     = [p for p in ordered if p['port_category'] == 'sfp']
    console_ports = [p for p in ordered if p['port_category'] == 'console']
    other_ports   = [p for p in ordered if p['port_category'] == 'other']

    def _sort_xy(ports):
        return sorted(ports, key=lambda p: (p['center'][0], p['center'][1]))

    main_ports    = _sort_xy(main_ports)
    sfp_ports     = _sort_xy(sfp_ports)
    console_ports = _sort_xy(console_ports)
    other_ports   = _sort_xy(other_ports)

    if len(main_ports) >= 6:
        main_ports = _drop_phantom_edge_ports(img, main_ports)

    if len(main_ports) >= 2:
        xs = sorted(p['center'][0] for p in main_ports)
        diffs = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)
                 if xs[i + 1] - xs[i] > 0]
        dx_est = float(np.median(diffs)) if diffs else float(BOX_W)
        main_ports = _drop_isolated_left_edge_ports(main_ports, dx_est)

    if skip_first_n_ports > 0 and len(main_ports) > skip_first_n_ports:
        main_ports = main_ports[skip_first_n_ports:]

    for i, p in enumerate(main_ports, 1):
        p['index'] = START_PORT + i - 1
    sfp_start = START_PORT + len(main_ports)
    for i, p in enumerate(sfp_ports, 1):
        p['index'] = sfp_start + i - 1
    console_start = sfp_start + len(sfp_ports)
    for i, p in enumerate(console_ports, 1):
        p['index'] = console_start + i - 1
    other_start = console_start + len(console_ports)
    for i, p in enumerate(other_ports, 1):
        p['index'] = other_start + i - 1

    all_boxes = [p['box'] for p in
                 main_ports + sfp_ports + console_ports + other_ports]

    cluster_info = cluster_ports(detections)

    print(
        f"DEBUG: classified → main={len(main_ports)}, sfp={len(sfp_ports)}, "
        f"console={len(console_ports)}, other={len(other_ports)}"
    )

    return {
        'console_ports': console_ports,
        'main_ports':    main_ports,
        'sfp_ports':     sfp_ports,
        'other_ports':   other_ports,
        'all_boxes':     all_boxes,
        'pattern_info': {
            'main_cluster_size': len(main_ports),
            'num_clusters':      len(cluster_info),
            'cluster_sizes':     [len(c) for c in cluster_info],
        },
    }


# ---------------------------------------------------------------------------
# Patch panel port detection helpers
# ---------------------------------------------------------------------------

def _fill_column_gaps(cols, dx):
    if len(cols) < 2:
        return cols

    sorted_cols = sorted(cols, key=lambda c: c['cx'])
    filled = [sorted_cols[0]]

    for i in range(1, len(sorted_cols)):
        gap = sorted_cols[i]['cx'] - filled[-1]['cx']
        if gap > dx * 1.5:
            n_fill = round(gap / dx) - 1
            step = gap / (n_fill + 1)
            for j in range(1, n_fill + 1):
                filled.append({'cx': int(round(filled[-1]['cx'] + step)),
                               'type': 'top_paired'})
        filled.append(sorted_cols[i])

    return sorted(filled, key=lambda c: c['cx'])


def _remove_edge_outlier_dets(dets):
    """Trim left/right edge outliers."""
    if len(dets) < 6:
        return dets

    sorted_dets = sorted(dets, key=lambda d: d['center'][0])
    xs = [d['center'][0] for d in sorted_dets]
    gaps = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
    pos_gaps = [g for g in gaps if g > 2]
    if not pos_gaps:
        return dets

    median_gap = float(np.median(pos_gaps))
    if median_gap < 3:
        return dets

    gap_threshold = median_gap * 1.6

    start = 0
    for i, g in enumerate(gaps):
        if g > gap_threshold:
            total_left = i + 1
            total_right = len(xs) - total_left
            if total_left <= 4 and total_right >= 4:
                start = i + 1

    end = len(xs)
    for i in range(len(gaps) - 1, -1, -1):
        if gaps[i] > gap_threshold:
            total_right = end - (i + 1)
            total_left = (i + 1) - start
            if total_right <= 4 and total_left >= 4:
                end = i + 1

    filtered = sorted_dets[start:end]
    if len(filtered) < 4:
        return dets

    ys = np.array([d['center'][1] for d in filtered])
    median_y = float(np.median(ys))
    y_diffs = np.abs(ys - median_y)
    med_ydiff = float(np.median(y_diffs)) if len(y_diffs) > 0 else 0.0
    y_threshold = max(med_ydiff * 3.0, median_gap * 1.5)
    filtered = [d for d, yd in zip(filtered, y_diffs) if yd <= y_threshold]

    return filtered if len(filtered) >= 4 else dets


def _remove_isolated_middle_outliers(dets):
    """Drop detections in the middle with no nearby neighbours."""
    if len(dets) < 6:
        return dets

    sorted_dets = sorted(dets, key=lambda d: d['center'][0])
    xs = [d['center'][0] for d in sorted_dets]

    gaps = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
    pos_gaps = [g for g in gaps if g > 2]
    if not pos_gaps:
        return dets
    median_gap = float(np.median(pos_gaps))
    if median_gap < 3:
        return dets

    iso_threshold = median_gap * 2.5

    keep = []
    n_dropped = 0
    for i, d in enumerate(sorted_dets):
        if i == 0 or i == len(sorted_dets) - 1:
            keep.append(d)
            continue
        left_gap  = xs[i]     - xs[i - 1]
        right_gap = xs[i + 1] - xs[i]
        if left_gap > iso_threshold and right_gap > iso_threshold:
            n_dropped += 1
            continue
        keep.append(d)

    if n_dropped > 0:
        print(f"DEBUG: isolated-middle outlier → dropped {n_dropped} "
              f"detection(s) (threshold={iso_threshold:.0f}px)")
    return keep if len(keep) >= 4 else dets


# ---------------------------------------------------------------------------
# Patch panel detection — UNIFORM grid, EQUAL gaps everywhere
# ---------------------------------------------------------------------------

def detect_patch_panel_ports(img, model, conf=CONF):
    """Detect ports on a patch panel — uniform 24-column grid, equal gaps.

    Pipeline:
      1. YOLO detect (low-conf fallback for sparse panels).
      2. Outlier rejection: edge outliers + isolated-middle outliers.
      3. Strict 2-row guard (only true 2U panels split).
      4. Best-fit 24-column grid (left-anchored / right-anchored /
         span-uniform). All three hypotheses are uniformly spaced by
         construction; the one with the smallest total |distance to
         actual detections| wins.
      5. Clamp the chosen grid inside image bounds without changing
         the spacing.
      6. Build boxes at uniformly-spaced (cx, row_y) positions.

    No per-column snapping — that would break equal gaps. Box width is
    set to leave a clean visible gap between every adjacent pair.

    Box dimensions (equal gap everywhere):
      - Half-width   hw = 0.30 · step  →  full width  = 0.60 · step
      - Half-height  hh = 0.75 · step  →  full height = 1.50 · step
      - Gap          = step − 2·hw = 0.40 · step  (40% of step)

    Because columns are uniform AND every box has identical (hw, hh),
    the gap between adjacent boxes is identical across the whole row.
    """
    dets = get_port_detections(img, model, conf=0.05)
    if len(dets) < 4:
        dets = get_port_detections(img, model, conf=conf)

    empty = {
        'console_ports': [], 'main_ports': [], 'sfp_ports': [],
        'other_ports': [], 'all_boxes': [],
        'pattern_info': {'main_cluster_size': 0, 'num_clusters': 0,
                         'cluster_sizes': []},
    }
    if len(dets) < 4:
        return empty

    # ── Two-stage outlier rejection ──
    n0 = len(dets)
    dets = _remove_edge_outlier_dets(dets)
    dets = _remove_isolated_middle_outliers(dets)
    if len(dets) < 4:
        return empty
    if len(dets) != n0:
        print(f"DEBUG: outlier rejection → {n0} → {len(dets)} detections")

    h_img, w_img = img.shape[:2]
    centers = [(d['center'][0], d['center'][1]) for d in dets]

    top, bot, r1, r2 = find_rows(centers, h_img)

    # ─── STRICT 2-row guard ────────────────────────────────────────────────
    two_rows = False
    if (r1 is not None and r2 is not None
            and len(top) >= 8 and len(bot) >= 8):
        row_sep = abs(r2 - r1)
        if row_sep >= max(20, int(h_img * 0.25)):
            two_rows = True

    if not two_rows and r1 is not None and r2 is not None:
        all_ys = [y for _, y in centers]
        r1 = int(np.mean(all_ys))
        r2 = None
    elif r1 is None and r2 is not None:
        r1, r2 = r2, None

    dx = get_dx(centers)
    max_cols = 24

    # ── Edge-clipped detection x-positions ──
    edge_margin = min(dx * 0.5, w_img * 0.02)
    valid_dets = [d for d in dets
                  if edge_margin <= d['center'][0] <= w_img - edge_margin]
    if len(valid_dets) < 2:
        return empty

    det_xs = sorted({d['center'][0] for d in valid_dets})

    # ───────────────────────────────────────────────────────────────────────
    # BEST-FIT 24-COLUMN GRID  (all three hypotheses are UNIFORM)
    #   H1: anchor leftmost,  step = dx          → uniform, step=dx
    #   H2: anchor rightmost, step = dx          → uniform, step=dx
    #   H3: span uniformly leftmost → rightmost  → uniform, step=span/23
    # ───────────────────────────────────────────────────────────────────────
    leftmost_det  = det_xs[0]
    rightmost_det = det_xs[-1]

    h1_step = float(dx)
    h2_step = float(dx)
    h3_step = max(rightmost_det - leftmost_det, dx) / (max_cols - 1)

    h1 = [int(round(leftmost_det + i * h1_step)) for i in range(max_cols)]
    h2 = [int(round(rightmost_det - (max_cols - 1 - i) * h2_step))
          for i in range(max_cols)]
    h3 = [int(round(leftmost_det + i * h3_step)) for i in range(max_cols)]

    def _total_dist(grid):
        return sum(min(abs(g - x) for g in grid) for x in det_xs)

    candidates = [('left-anchored',  h1, h1_step),
                  ('right-anchored', h2, h2_step),
                  ('span-uniform',   h3, h3_step)]
    chosen_name, col_xs, step = min(
        candidates, key=lambda kv: _total_dist(kv[1])
    )

    # ── Clamp the whole grid inside image bounds (preserves uniformity) ──
    if col_xs[-1] >= w_img:
        shift = col_xs[-1] - (w_img - 5)
        col_xs = [c - shift for c in col_xs]
    if col_xs[0] < 0:
        shift = -col_xs[0]
        col_xs = [c + shift for c in col_xs]

    # ───────────────────────────────────────────────────────────────────────
    # BOX DIMENSIONS — width and height fixed; same for every box.
    #   hw = 0.30 · step  →  full width  = 0.60 · step
    #   hh = 0.75 · step  →  full height = 1.50 · step
    # Equal gap = step − 2·hw = 0.40 · step (40% of the column step).
    # ───────────────────────────────────────────────────────────────────────
    hw = max(6,  int(round(step * 0.30)))
    hh = max(15, int(round(step * 0.75)))

    if two_rows and r1 is not None and r2 is not None:
        row_gap = abs(r2 - r1)
        if hh * 2 > row_gap:
            hh = max(12, row_gap // 2 - 2)

    # ── Build boxes at UNIFORM (cx, row_y) — no per-column snapping ──
    row_ys = [r1, r2] if two_rows else [r1]
    row_ys = [r for r in row_ys if r is not None]

    boxes = []
    for row_y in row_ys:
        for cx in col_xs:
            x1 = max(0, cx - hw)
            y1 = max(0, row_y - hh)
            x2 = min(w_img, cx + hw)
            y2 = min(h_img, row_y + hh)
            boxes.append((x1, y1, x2, y2))

    def _match(cx, cy):
        best = min(dets,
                   key=lambda d: (d['center'][0] - cx) ** 2
                               + (d['center'][1] - cy) ** 2)
        return (best['class_name'], best['confidence'],
                infer_port_status(best['class_name']))

    main_ports = []
    for i, box in enumerate(boxes, 1):
        cx = (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        cn, cf, st = _match(cx, cy)
        main_ports.append({
            'index': i,
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy], 'status': st,
            'class_name': cn, 'confidence': cf,
            'port_category': 'main',
        })

    target = 48 if two_rows else 24
    if len(main_ports) > target:
        main_ports = main_ports[:target]

    for i, p in enumerate(main_ports, 1):
        p['index'] = i

    gap_px = max(0, int(round(step - 2 * hw)))
    print(
        f"DEBUG: patch panel → {len(main_ports)}/{target} ports, "
        f"{'2 rows' if two_rows else '1 row'}, "
        f"grid={chosen_name}, step={step:.2f}px, "
        f"box={2*hw}x{2*hh}px, gap={gap_px}px (equal)"
    )

    return {
        'console_ports': [], 'main_ports': main_ports,
        'sfp_ports': [], 'other_ports': [],
        'all_boxes': [p['box'] for p in main_ports],
        'pattern_info': {
            'main_cluster_size': len(main_ports),
            'num_clusters': 1 if not two_rows else 2,
            'cluster_sizes': [len(main_ports)],
        },
    }