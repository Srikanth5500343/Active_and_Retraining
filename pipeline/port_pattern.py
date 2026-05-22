"""
Port pattern analysis — classify ports by the model's predicted class.

The new port model (port_best.pt) was trained with distinct classes for
main, SFP, and console ports (typically encoded in `class_name` — e.g.
"main_port", "sfp_port", "console_port", or "rj45"/"sfp"/"console").
We trust the model's prediction for *category* rather than inferring it
from column layout. Layout-based logic is retained only for
*within-category cleanup*:

  - phantom edge-column removal on main ports (edge density + HSV saturation)
  - cross-category overlap removal (SFP > console > main on conflict)
  - patch panel grid completion

Usage::

    from pipeline.port_pattern import classify_ports_by_pattern
    from pipeline.port_pattern import detect_patch_panel_ports
    from pipeline.port_pattern import classify_ports_with_target_count

    result = classify_ports_by_pattern(device_crop, model)
"""

import cv2
import numpy as np

from pipeline.port import (
    get_port_detections, find_rows, get_dx,
    infer_port_status, verify_boxes_with_edges,
    BOX_W, BOX_H, CONF,
)

# ── Config ─────────────────────────────────────────────────────────────────
START_PORT = 1  # main-port numbering starts here

# ── Class-name → category mapping ──────────────────────────────────────────
# Maps substrings found in the model's class_name strings to one of the
# canonical categories. Iteration order matters: SFP is checked before main
# because a class like "sfp_port" contains "port" too.
PORT_CATEGORY_KEYWORDS = {
    'sfp':     ('sfp', 'sfp+', 'qsfp', 'fiber', 'optic', 'fibre'),
    'console': ('console', 'serial', 'mgmt', 'management', 'aux'),
    'main':    ('main', 'rj45', 'rj-45', 'ethernet', 'eth', 'lan',
                'occupied', 'empty', 'port'),
}
_CATEGORY_ORDER = ('sfp', 'console', 'main')


def _classify_by_class_name(class_name: str) -> str:
    """Map a model class_name to one of: main, sfp, console, other."""
    if not class_name:
        return 'other'
    n = (class_name.lower().strip()
         .replace('-', '').replace('_', '').replace(' ', ''))
    for category in _CATEGORY_ORDER:
        for kw in PORT_CATEGORY_KEYWORDS[category]:
            kw_norm = kw.replace('-', '').replace('_', '').replace(' ', '')
            if kw_norm in n:
                return category
    return 'other'


# ── Clustering (diagnostic only — used to populate pattern_info) ───────────

def cluster_ports(detections):
    """Group port detections into clusters separated by x-gaps."""
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


# ── Overlap removal ────────────────────────────────────────────────────────

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
    """Drop any port whose box overlaps significantly with an earlier port.

    First-in-the-list wins. Caller controls priority by ordering.
    """
    kept = []
    for p in ports:
        if any(_overlap_ratio(p['box'], k['box']) > threshold for k in kept):
            continue
        kept.append(p)
    return kept


def _drop_isolated_left_edge_ports(main_ports, dx):
    """Reject a tiny left-edge blob of phantom main ports.

    Triggers only when the first sizable gap between columns falls early
    in the list AND the left cluster has ≤ 2 ports while the right has
    ≥ 4 — i.e. a clear "1-2 phantom columns drifting off to the left of
    the real port row."
    """
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

    # split_idx = index of the first port AFTER the splitter gap.
    # gap[k] sits between unique_xs[k] and unique_xs[k+1], so the
    # corresponding split index is k+1.
    split_idx = next((i + 1 for i, gap in enumerate(gaps) if gap > threshold),
                     None)
    if split_idx is None:
        return main_ports

    left_cluster = unique_xs[:split_idx]
    right_cluster = unique_xs[split_idx:]
    if len(left_cluster) <= 2 and len(right_cluster) >= 4:
        drop_set = set(left_cluster)
        return [p for p in main_ports if p['center'][0] not in drop_set]

    return main_ports


# ── Pattern analysis (diagnostic) ──────────────────────────────────────────

def analyze_pattern(clusters):
    """Classify clusters by comparing their size to the dominant pattern.

    Kept for back-compat with anything that reads pattern_info; the active
    classifier no longer drives categories from this.
    """
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


# ── Phantom-edge-column trim (edge density + HSV saturation) ───────────────

def _port_crop_density(gray, box):
    """Canny edge density of the 60% center crop (0.0–1.0)."""
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
    if edges.size == 0:
        return None
    return float(np.count_nonzero(edges)) / float(edges.size)


def _port_crop_saturation(hsv, box):
    """Mean HSV saturation of the 60% center crop (0–255)."""
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    thw = max(4, int(bw * 0.3))
    thh = max(4, int(bh * 0.3))
    h_img, w_img = hsv.shape[:2]
    x1c = max(0, cx - thw)
    y1c = max(0, cy - thh)
    x2c = min(w_img, cx + thw)
    y2c = min(h_img, cy + thh)
    if x2c - x1c < 4 or y2c - y1c < 4:
        return None
    return float(np.mean(hsv[y1c:y2c, x1c:x2c, 1]))


def _drop_phantom_edge_ports(img, ports,
                             max_trim_per_side=4,
                             density_ratio=0.5):
    """Drop edge columns whose interior signature is far from the interior median.

    Two signals, both relative to the median of the *interior* columns:
      - Canny edge density < ref_edge * density_ratio  → too blank
      - HSV saturation     > ref_sat * 1.5 + 40        → colored sticker/label

    Either signal triggers a trim. Walks in from each edge, stopping
    as soon as an edge column matches the interior signature.
    """
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
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV) if len(img.shape) == 3 else None

    def col_signals(col):
        ds = [_port_crop_density(gray, p['box']) for p in col]
        ds = [d for d in ds if d is not None]
        ss = []
        if hsv is not None:
            ss = [_port_crop_saturation(hsv, p['box']) for p in col]
            ss = [s for s in ss if s is not None]
        return (float(np.median(ds)) if ds else 0.0,
                float(np.median(ss)) if ss else 0.0)

    n = len(columns)
    interior = columns[n // 4: n - n // 4]
    int_metrics = [col_signals(c) for c in interior]
    int_e = [e for e, _ in int_metrics if e > 0]
    int_s = [s for _, s in int_metrics if s > 0]
    if not int_e:
        return ports

    ref_e = float(np.median(int_e))
    ref_s = float(np.median(int_s)) if int_s else 0.0
    blank_thr = ref_e * density_ratio

    def is_phantom(col):
        e, s = col_signals(col)
        too_blank = e < blank_thr
        too_colored = ref_s > 0 and s > ref_s * 1.5 + 40
        return too_blank or too_colored

    keep = list(columns)

    trimmed_left = 0
    while trimmed_left < max_trim_per_side and len(keep) > 4:
        if is_phantom(keep[0]):
            keep.pop(0)
            trimmed_left += 1
        else:
            break

    trimmed_right = 0
    while trimmed_right < max_trim_per_side and len(keep) > 4:
        if is_phantom(keep[-1]):
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


# Column-major sort so that a 2-row switch numbers as:
#   top row:    1, 3, 5, 7, 9, ...
#   bottom row: 2, 4, 6, 8, 10, ...
# Pure (x, y) sorting breaks this whenever two ports in the same column have
# slightly different detection-center x values, which swaps them across
# columns. We cluster by x using the median port-pitch as tolerance, then
# within each column sort top-to-bottom.
def _column_major_sort(ports):
    if len(ports) < 2:
        return list(ports)
    sx = sorted(ports, key=lambda p: p['center'][0])
    xs = [p['center'][0] for p in sx]
    diffs = [xs[i + 1] - xs[i] for i in range(len(xs) - 1) if xs[i + 1] - xs[i] > 0]
    pitch = float(np.median(diffs)) if diffs else 0.0
    col_tol = max(pitch * 0.5, 8.0)
    cols = [[sx[0]]]
    for p in sx[1:]:
        if p['center'][0] - cols[-1][-1]['center'][0] > col_tol:
            cols.append([])
        cols[-1].append(p)
    out = []
    for col in cols:
        out.extend(sorted(col, key=lambda p: p['center'][1]))
    return out


# ── Main entry point — class-aware classifier ──────────────────────────────

def classify_ports_by_pattern(img, model, conf=CONF, skip_first_n_ports=0,
                              status_model=None):
    """Detect and classify ports using the model's predicted class.

    Pipeline:
      1. Run the model on the device crop.
      2. Partition detections into main / sfp / console / other by class name.
      3. Reassign 'other' detections by position (left of leftmost main →
         console, otherwise → sfp).
      4. Build port dicts using YOLO bounding boxes directly.
      5. Within each category, sort by confidence DESC so within-category
         duplicates favor the higher-confidence detection.
      6. Cross-category overlap removal — SFP wins, then console, then main.
      7. Phantom edge-column cleanup on main ports (edge density + HSV
         saturation) and isolated-left-edge phantom drop.

    The function name is kept for back-compat with callers. The
    "by_pattern" suffix now refers to within-category pattern cleanup.
    """
    detections = get_port_detections(img, model, conf=conf)
    empty = {
        'console_ports': [], 'main_ports': [], 'sfp_ports': [],
        'other_ports':   [], 'all_boxes': [],
        'pattern_info':  {'main_cluster_size': 0, 'num_clusters': 0,
                          'cluster_sizes': []},
    }
    if len(detections) < 4:
        return empty

    # Diagnostic: log unique class names. The first run on a fresh model
    # is the canonical way to confirm PORT_CATEGORY_KEYWORDS covers
    # whatever labels the model emits.
    unique_classes = sorted({d.get('class_name', '') for d in detections})
    print(f"DEBUG: model classes in this crop: {unique_classes}")

    # Partition by predicted class.
    by_cat = {'main': [], 'sfp': [], 'console': [], 'other': []}
    for d in detections:
        by_cat[_classify_by_class_name(d.get('class_name', ''))].append(d)

    # Reassign 'other' by position.
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

    # Detection → port dict.
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
        cf = float(d.get('confidence', 0.0))
        return {
            'box':            [x1, y1, x2, y2],
            'center':         [cx, cy],
            'status':         infer_port_status(cn, cf),
            'class_name':     cn,
            'confidence':     cf,
            'port_category':  category,
        }

    main_ports    = [_make_port(d, 'main')    for d in by_cat['main']]
    sfp_ports     = [_make_port(d, 'sfp')     for d in by_cat['sfp']]
    console_ports = [_make_port(d, 'console') for d in by_cat['console']]

    # Within each category, highest confidence first — so within-category
    # duplicate suppression below keeps the more confident detection.
    def _by_conf(ports):
        return sorted(ports, key=lambda p: p['confidence'], reverse=True)

    main_ports    = _by_conf(main_ports)
    sfp_ports     = _by_conf(sfp_ports)
    console_ports = _by_conf(console_ports)

    # Cross-category overlap removal. Order = priority: any ambiguous
    # detection on the SFP cluster keeps its SFP label rather than being
    # demoted to main.
    ordered = sfp_ports + console_ports + main_ports
    ordered = _remove_overlapping_ports(ordered, threshold=0.3)
    main_ports    = [p for p in ordered if p['port_category'] == 'main']
    sfp_ports     = [p for p in ordered if p['port_category'] == 'sfp']
    console_ports = [p for p in ordered if p['port_category'] == 'console']

    # Drop SFP detections sitting above the RJ45 row when the switch already
    # has RJ45 ports occupying its bottom half — real layouts don't stack an
    # SFP cage above a copper row, so a "top-row SFP" in that geometry is a
    # misclassified RJ45.
    if main_ports and sfp_ports:
        img_h = img.shape[0]
        main_y_max = max(p['center'][1] for p in main_ports)
        main_y_min = min(p['center'][1] for p in main_ports)
        if main_y_max > img_h / 2:
            half_h = BOX_H // 2
            kept = [sp for sp in sfp_ports if sp['center'][1] >= main_y_min - half_h]
            dropped = len(sfp_ports) - len(kept)
            if dropped:
                print(f"DEBUG: dropped {dropped} top-row SFP (RJ45 occupies bottom row)")
                sfp_ports = kept

    # Reclassify SFP→RJ45 when an SFP detection sits in the RJ45 row but has
    # no other SFP neighbors nearby — real SFP cages always cluster in groups
    # of 2 or 4, so a lone SFP inside the copper row (edge or middle) is the
    # detector mis-labeling an RJ45. Neighbor distance is derived from the
    # measured main-port pitch so it scales with the image, not the (small)
    # detection-box width constant.
    if main_ports and sfp_ports:
        half_h = BOX_H // 2
        median_main_y = float(np.median([p['center'][1] for p in main_ports]))
        if len(main_ports) >= 2:
            xs = sorted(p['center'][0] for p in main_ports)
            diffs = [xs[i + 1] - xs[i] for i in range(len(xs) - 1) if xs[i + 1] - xs[i] > 0]
            port_pitch = float(np.median(diffs)) if diffs else float(BOX_W)
        else:
            port_pitch = float(BOX_W)
        neighbor_dx = port_pitch * 1.8
        isolated = []
        for sp in sfp_ports:
            sx, sy = sp['center'][0], sp['center'][1]
            if abs(sy - median_main_y) > half_h:
                continue
            has_sfp_neighbor = any(
                other is not sp
                and abs(other['center'][0] - sx) <= neighbor_dx
                and abs(other['center'][1] - sy) <= half_h
                for other in sfp_ports
            )
            if not has_sfp_neighbor:
                isolated.append(sp)
        if isolated:
            for sp in isolated:
                sp['port_category'] = 'main'
                sfp_ports.remove(sp)
                main_ports.append(sp)
            print(f"DEBUG: reclassified {len(isolated)} isolated SFP→RJ45 (no SFP neighbors in copper row)")

    def _sort_xy(ports):
        return sorted(ports, key=lambda p: (p['center'][0], p['center'][1]))

    main_ports    = _column_major_sort(main_ports)
    sfp_ports     = _column_major_sort(sfp_ports)
    console_ports = _sort_xy(console_ports)

    # Phantom edge-column cleanup (main only; SFP cluster too small to
    # form a reliable interior reference).
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

    # Indexing.
    for i, p in enumerate(main_ports, 1):
        p['index'] = START_PORT + i - 1
    sfp_start = START_PORT + len(main_ports)
    for i, p in enumerate(sfp_ports, 1):
        p['index'] = sfp_start + i - 1
    console_start = sfp_start + len(sfp_ports)
    for i, p in enumerate(console_ports, 1):
        p['index'] = console_start + i - 1

    all_boxes = [p['box'] for p in main_ports + sfp_ports + console_ports]
    cluster_info = cluster_ports(detections)

    print(
        f"DEBUG: classified → main={len(main_ports)}, sfp={len(sfp_ports)}, "
        f"console={len(console_ports)}"
    )

    _apply_status_from_status_model(
        img, main_ports + sfp_ports + console_ports,
        status_model, conf=conf,
    )

    return {
        'console_ports': console_ports,
        'main_ports':    main_ports,
        'sfp_ports':     sfp_ports,
        'other_ports':   [],
        'all_boxes':     all_boxes,
        'pattern_info': {
            'main_cluster_size': len(main_ports),
            'num_clusters':      len(cluster_info),
            'cluster_sizes':     [len(c) for c in cluster_info],
        },
    }


# ── Patch panel grid detection ─────────────────────────────────────────────

def detect_patch_panel_ports(img, model, conf=CONF):
    """Detect ports on a patch panel — conservative grid completion.

    Patch panels have a continuous, uniformly-spaced row (24 or 48). We
    use the YOLO model only to anchor the column grid; the grid itself
    is extended/filled by geometric reasoning, with each extrapolated
    column edge-verified to avoid hallucinating columns onto a bracket
    or blank panel.

    All output ports are classified as 'main' — patch panels have no
    console or SFP cages.
    """
    dets = get_port_detections(img, model, conf=conf)

    # Two-pass: if detection looks sparse, retry at lower confidence.
    if len(dets) < 12:
        dets_low = get_port_detections(img, model, conf=0.05)
        if len(dets_low) > len(dets):
            dets = dets_low

    empty = {
        'console_ports': [], 'main_ports': [], 'sfp_ports': [],
        'other_ports':   [], 'all_boxes': [],
        'pattern_info':  {'main_cluster_size': 0, 'num_clusters': 0,
                          'cluster_sizes': []},
    }
    if len(dets) < 4:
        return empty

    h_img, w_img = img.shape[:2]
    centers = [(d['center'][0], d['center'][1]) for d in dets]

    # Two-row vs one-row decision. Patch panels come as 1U (24 ports in
    # one row) or 2U (48 ports in two rows). Real two-row detection
    # requires both bands populated AND separated by ≥ 25% of crop
    # height — otherwise merge into one row.
    top, bot, r1, r2 = find_rows(centers, h_img)
    two_rows = False
    if r1 is not None and r2 is not None and len(top) >= 2 and len(bot) >= 2:
        if abs(r2 - r1) >= max(8, int(h_img * 0.25)):
            two_rows = True
    if not two_rows and r1 is not None and r2 is not None:
        r1 = int((r1 + r2) / 2)
        r2 = None

    dx = get_dx(centers)

    # Drop detections too close to the crop edge (panel frame / bracket).
    edge_margin = min(dx * 0.5, w_img * 0.02)
    dets_filtered = [d for d in dets
                     if d['center'][0] >= edge_margin
                     and d['center'][0] <= w_img - edge_margin]
    if len(dets_filtered) < 2:
        return empty

    # Merge nearby x-positions into column anchors.
    all_xs = sorted(d['center'][0] for d in dets_filtered)
    col_xs = [all_xs[0]]
    for x in all_xs[1:]:
        if x - col_xs[-1] > dx * 0.4:
            col_xs.append(x)

    # Fill gaps between consecutive detected columns.
    clean = [col_xs[0]]
    for i in range(1, len(col_xs)):
        gap = col_xs[i] - clean[-1]
        if gap > dx * 1.5:
            n_fill = round(gap / dx) - 1
            step = gap / (n_fill + 1)
            for j in range(1, n_fill + 1):
                clean.append(int(round(clean[-1] + step)))
        clean.append(col_xs[i])
    col_xs = clean

    max_cols = 24
    if len(col_xs) > max_cols:
        col_xs = col_xs[:max_cols]

    # Edge-verified extension: try to walk one column at a time outward
    # from each side, only keeping a candidate if its crop has enough
    # Canny edges to plausibly be a port.
    edge_stop = max(int(dx * 0.5), 10)
    ry = r1 or r2
    hw_t = max(3, int(dx * 0.45))
    hh_t = max(3, int(dx * 0.55))

    for _ in range(12):
        if len(col_xs) >= max_cols:
            break
        cand = int(round(col_xs[0] - dx))
        if cand - hw_t < edge_stop:
            break
        test_box = [(cand - hw_t, ry - hh_t, cand + hw_t, ry + hh_t)]
        if verify_boxes_with_edges(img, test_box, min_edge_pct=0.03):
            col_xs.insert(0, cand)
        else:
            break
    for _ in range(12):
        if len(col_xs) >= max_cols:
            break
        cand = int(round(col_xs[-1] + dx))
        if cand + hw_t > w_img - edge_stop:
            break
        test_box = [(cand - hw_t, ry - hh_t, cand + hw_t, ry + hh_t)]
        if verify_boxes_with_edges(img, test_box, min_edge_pct=0.03):
            col_xs.append(cand)
        else:
            break

    # Trim up to 2 leftmost columns if they don't actually align with
    # any YOLO detection — these are extrapolations into panel frame.
    all_det_xs = [d['center'][0] for d in dets]
    for _ in range(2):
        if len(col_xs) <= 1:
            break
        if not any(abs(col_xs[0] - dx_) <= dx * 0.7 for dx_ in all_det_xs):
            col_xs.pop(0)
        else:
            break

    # Build boxes — size from dx so adjacent boxes never overlap.
    rows = [r1, r2] if two_rows else [r1 or r2]
    rows = [r for r in rows if r is not None]
    hw = max(3, int(dx * 0.45))
    hh = max(3, int(dx * 0.55))
    max_hh = max(5, int(h_img * 0.15))
    max_hw = max(5, int(h_img * 0.25))
    hh = min(hh, max_hh)
    hw = min(hw, max_hw)

    boxes = []
    for cx in col_xs:
        for ry in rows:
            boxes.append((cx - hw, ry - hh, cx + hw, ry + hh))

    # Edge-density verification — drop boxes over blank areas.
    boxes = verify_boxes_with_edges(img, boxes)

    def _match(cx, cy):
        best = min(dets,
                   key=lambda d: (d['center'][0] - cx) ** 2
                               + (d['center'][1] - cy) ** 2)
        return (best['class_name'], best['confidence'],
                infer_port_status(best['class_name'], best['confidence']))

    main_ports = []
    for i, box in enumerate(boxes, 1):
        cx = (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        cn, cf, st = _match(cx, cy)
        main_ports.append({
            'index': i,
            'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
            'center': [cx, cy],
            'status': st,
            'class_name': cn,
            'confidence': cf,
            'port_category': 'main',
        })

    target = 48 if two_rows else 24
    if len(main_ports) > target:
        main_ports = main_ports[:target]
    for i, p in enumerate(main_ports, 1):
        p['index'] = i

    return {
        'console_ports': [],
        'main_ports':    main_ports,
        'sfp_ports':     [],
        'other_ports':   [],
        'all_boxes':     [p['box'] for p in main_ports],
        'pattern_info': {
            'main_cluster_size': len(main_ports),
            'num_clusters':      1 if not two_rows else 2,
            'cluster_sizes':     [len(main_ports)],
        },
    }


# ── User-relabel retry path (called by worker.py) ──────────────────────────
#
# When the operator overrides the visual port count for a device, we
# re-classify and pad missing positions via NCC template matching seeded
# from real YOLO detections — no grid extrapolation, no edge-only
# heuristics. A phantom position can only appear if the panel actually
# contains a port-shaped region matching the template.

def _iou(box_a, box_b):
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    a = max(1, (ax2 - ax1) * (ay2 - ay1))
    b = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / min(a, b)


def _apply_status_from_status_model(img, ports, status_model,
                                    conf=CONF, iou_thresh=0.3):
    """Overlay connected/empty onto ports using a secondary status model.

    port_best.pt is category-only (main/sfp/console) so every detection
    comes out with status='unknown'. Callers pass the older port_count.pt
    (Empty_port/Connected_port) here to get a real status by IoU-matching
    its detections against the already-built port boxes. Ports without a
    confident overlap keep their existing status.
    """
    if status_model is None or not ports:
        return ports
    try:
        status_dets = get_port_detections(img, status_model, conf=conf)
    except Exception as exc:
        print(f"DEBUG: status sweep failed: {exc}")
        return ports
    if not status_dets:
        return ports

    status_dets = sorted(
        status_dets,
        key=lambda d: float(d.get('confidence', 0.0)),
        reverse=True,
    )

    n_updated = 0
    for port in ports:
        box = port.get('box')
        if not box or len(box) != 4:
            continue
        best = None
        best_iou = 0.0
        for d in status_dets:
            bb = d.get('bbox')
            if bb is None:
                continue
            iou = _iou(box, list(bb))
            if iou > best_iou:
                best_iou = iou
                best = d
        if best is None or best_iou < iou_thresh:
            continue
        new_status = infer_port_status(
            best.get('class_name', ''),
            float(best.get('confidence', 0.0)),
        )
        if new_status == 'unknown':
            continue
        port['status'] = new_status
        n_updated += 1
    if n_updated:
        print(f"DEBUG: status sweep updated {n_updated}/{len(ports)} ports")
    return ports


def _template_match_peaks(img, template, score_threshold=0.45):
    """Return [(score, cx, cy)] peaks where ``template`` matches ``img``."""
    if template is None or template.size == 0:
        return []
    th, tw = template.shape[:2]
    ih, iw = img.shape[:2]
    if th >= ih or tw >= iw:
        return []
    result = cv2.matchTemplate(img, template, cv2.TM_CCOEFF_NORMED)
    kernel = np.ones((max(3, th // 2), max(3, tw // 2)), np.uint8)
    dilated = cv2.dilate(result, kernel)
    peaks_mask = (result == dilated) & (result >= score_threshold)
    ys, xs = np.where(peaks_mask)
    out = []
    for y, x in zip(ys, xs):
        out.append((float(result[y, x]), int(x + tw // 2), int(y + th // 2)))
    return out


def classify_ports_with_target_count(img, model, target_count, conf=CONF,
                                     status_model=None):
    """Produce exactly ``target_count`` main_ports for the user.

    1. Run the normal classifier and keep its detections as anchors.
    2. If detected > target → trim the lowest-confidence anchors.
    3. Otherwise pick up to two templates (best empty + best connected),
       slide them across the crop with NCC matchTemplate, and pad with
       the highest-scoring non-overlapping peaks that land in the
       anchor row band.

    Accuracy is preferred over hitting the target — if template matching
    can't find enough real-looking peaks, we return what we have.
    """
    target_count = int(target_count)
    if target_count < 0:
        target_count = 0

    # Defer the status sweep to the end so it covers template-padded
    # ports too — pass status_model=None into the inner call.
    base = classify_ports_by_pattern(img, model, conf=min(conf, 0.10),
                                     status_model=None)

    def _finalize(b):
        _apply_status_from_status_model(
            img,
            (b.get('main_ports') or [])
            + (b.get('sfp_ports') or [])
            + (b.get('console_ports') or []),
            status_model, conf=conf,
        )
        return b

    main = list(base.get('main_ports', []))

    if len(main) > target_count:
        main.sort(key=lambda p: p.get('confidence', 0) or 0, reverse=True)
        main = main[:target_count]
        main = _column_major_sort(main)
        for i, p in enumerate(main, 1):
            p['index'] = i
        base['main_ports'] = main
        return _finalize(base)

    if len(main) == target_count:
        return _finalize(base)

    if not main:
        return _finalize(base)

    img_h, img_w = img.shape[:2]
    by_conf = sorted(main, key=lambda p: p.get('confidence', 0) or 0,
                     reverse=True)

    def crop_box(p):
        bx1, by1, bx2, by2 = [int(v) for v in p['box']]
        bx1 = max(0, bx1); by1 = max(0, by1)
        bx2 = min(img_w, bx2); by2 = min(img_h, by2)
        if bx2 <= bx1 or by2 <= by1:
            return None
        return img[by1:by2, bx1:bx2]

    templates = []
    for status_match in ('empty', 'connected'):
        for p in by_conf:
            if p.get('status') == status_match:
                t = crop_box(p)
                if t is not None and t.size > 0:
                    templates.append(t)
                    break
    if not templates:
        t = crop_box(by_conf[0])
        if t is not None and t.size > 0:
            templates.append(t)
    if not templates:
        return _finalize(base)

    rows_y = sorted({int(p['center'][1]) for p in main})
    box_h_anchor = main[0]['box'][3] - main[0]['box'][1]
    y_tol = max(box_h_anchor, 12)

    def in_row(cy):
        return any(abs(cy - ry) <= y_tol for ry in rows_y)

    needed = target_count - len(main)
    chosen = []

    for threshold in (0.55, 0.45, 0.35, 0.25):
        peaks = []
        for tmpl in templates:
            peaks.extend(_template_match_peaks(img, tmpl,
                                               score_threshold=threshold))
        peaks.sort(key=lambda p: p[0], reverse=True)

        chosen = []
        for score, cx, cy in peaks:
            if len(chosen) >= needed:
                break
            if not in_row(cy):
                continue
            th, tw = templates[0].shape[:2]
            bx1 = max(0, cx - tw // 2)
            by1 = max(0, cy - th // 2)
            bx2 = min(img_w, cx + tw // 2)
            by2 = min(img_h, cy + th // 2)
            cand_box = [bx1, by1, bx2, by2]
            if any(_iou(cand_box, p['box']) > 0.3 for p in main):
                continue
            if any(_iou(cand_box, c['box']) > 0.3 for c in chosen):
                continue
            chosen.append({
                'index': 0,
                'box': [int(bx1), int(by1), int(bx2), int(by2)],
                'center': [int(cx), int(cy)],
                'status': 'unknown',
                'class_name': 'inferred',
                'confidence': float(score),
                'port_category': 'main',
                'inferred': True,
            })
        if len(chosen) >= needed:
            break

    final = list(main) + chosen
    final = _column_major_sort(final)
    for i, p in enumerate(final, 1):
        p['index'] = i
    base['main_ports'] = final
    return _finalize(base)
