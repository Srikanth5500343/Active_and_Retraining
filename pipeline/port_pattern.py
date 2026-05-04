"""
Port pattern analysis — classify ports by cluster-size pattern.

Main ports appear in uniform groups (commonly 4, 6, or 8 ports).
SFP ports sit at the right end in a smaller group (typically 2 or 4),
and may have both top and bottom rows (column-based can't catch them).

The dominant cluster size identifies the main pattern; rightmost
cluster(s) with a different (smaller) size are SFP.

Usage::

    from pipeline.port_pattern import classify_ports_by_pattern
    from pipeline.port_pattern import detect_patch_panel_ports
    result = classify_ports_by_pattern(device_crop, model)
"""

import cv2
import numpy as np

from pipeline.port import (
    get_port_detections, find_rows, get_dx, build_columns,
    get_boxes, infer_port_status, draw_classified,
    verify_boxes_with_edges,
    BOX_W, BOX_H, CONF,
)


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def cluster_ports(detections):
    """Group port detections into clusters separated by x-gaps.

    1. Merge detections at the same x into column positions.
    2. Compute column-to-column gaps.
    3. Threshold = median column gap * 1.3  (catches inter-group gaps
       while keeping intra-group ports together).
    4. After splitting, merge adjacent small clusters at the right edge
       (SFP columns may be spaced wider than main columns).
    """
    if len(detections) < 2:
        return [list(detections)] if detections else []

    sorted_dets = sorted(detections, key=lambda d: d['center'][0])
    xs = [d['center'][0] for d in sorted_dets]

    # --- Column positions (merge top+bottom at same x) ---
    col_tol = BOX_W // 3
    col_xs = [xs[0]]
    for x in xs[1:]:
        if x - col_xs[-1] > col_tol:
            col_xs.append(x)

    if len(col_xs) < 2:
        return [sorted_dets]

    col_gaps = sorted(
        col_xs[i + 1] - col_xs[i] for i in range(len(col_xs) - 1)
    )
    median_gap = col_gaps[len(col_gaps) // 2]
    threshold = median_gap * 1.3

    # --- Split detections by threshold ---
    clusters = [[sorted_dets[0]]]
    for i in range(1, len(sorted_dets)):
        if xs[i] - xs[i - 1] > threshold:
            clusters.append([sorted_dets[i]])
        else:
            clusters[-1].append(sorted_dets[i])

    # --- Merge adjacent small trailing clusters (SFP spacing) ---
    if len(clusters) >= 3:
        biggest = max(len(c) for c in clusters)
        while (len(clusters) >= 2
               and len(clusters[-1]) < biggest * 0.5
               and len(clusters[-2]) < biggest * 0.5):
            clusters[-2].extend(clusters.pop())

    return clusters


# ---------------------------------------------------------------------------
# Overlap removal — ports never overlay each other
# ---------------------------------------------------------------------------

def _overlap_ratio(a, b):
    """Intersection area / smaller box area."""
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

    Main ports are prioritised (they appear first in the list).
    """
    kept = []
    for p in ports:
        if any(_overlap_ratio(p['box'], k['box']) > threshold for k in kept):
            continue
        kept.append(p)
    return kept


# ---------------------------------------------------------------------------
# Pattern analysis
# ---------------------------------------------------------------------------

def analyze_pattern(clusters):
    """Classify clusters by comparing their size to the dominant pattern.

    Returns ``(main_pattern, main_indices, sfp_indices, console_indices)``.

    *  The most common cluster size is the **main pattern**.
    *  A cluster "matches" main if its size >= 60 % of the pattern
       (tolerates cable-hidden ports).
    *  Rightmost non-matching cluster(s) → SFP.
    *  Leftmost non-matching cluster(s) → console.
    *  Non-matching clusters *between* main clusters stay as main.
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


# ---------------------------------------------------------------------------
# Hidden-port verification helpers
# ---------------------------------------------------------------------------

def _edge_density(img, box):
    """Compute edge density (0.0–1.0) of an image region."""
    x1, y1, x2, y2 = box
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    edges = cv2.Canny(gray, 50, 150)
    return float(np.mean(edges)) / 255.0


def _reference_edge_densities(img, detections):
    """Get edge densities of all confirmed YOLO-detected ports.

    Uses a tight crop (60 % of port box) matching the verification size.
    """
    densities = []
    vhw = BOX_W * 3 // 10
    vhh = BOX_H * 3 // 10
    h, w = img.shape[:2]
    for d in detections:
        cx, cy = d['center']
        bx1 = max(0, cx - vhw)
        by1 = max(0, cy - vhh)
        bx2 = min(w, cx + vhw)
        by2 = min(h, cy + vhh)
        densities.append(_edge_density(img, (bx1, by1, bx2, by2)))
    return densities


def _region_has_port(img, box, ref_densities):
    """Check if a region has a port (empty or connected) vs blank panel.

    Compares edge density of the region to the LEAST textured detected
    port.  Even an empty port (no cable) has a connector hole with some
    edges.  Only truly blank/smooth panel is rejected.
    """
    density = _edge_density(img, box)

    if not ref_densities:
        return density > 0.02

    min_ref = min(ref_densities)
    # At least 50% of the least-textured detected port, BUT never
    # below 0.02 — a real port always has SOME edges (connector hole).
    return density >= max(min_ref * 0.5, 0.02)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def classify_ports_by_pattern(img, model, conf=CONF):
    """Detect and classify ports — column-based first, pattern-based second.

    **Layer 1 — Column-based** (your original logic):
        * ``separate_bot`` left of paired columns  → console
        * ``separate_bot`` right of paired columns → SFP
        * Gap rescue: if a console column is close to main, merge back.

    **Layer 2 — Pattern-based** (catches 2-row SFP that column-based misses):
        * Cluster the *remaining main* ports by x-gaps.
        * If the rightmost cluster has a different (smaller) size than
          the dominant pattern, move it to SFP.

    Returns a dict compatible with ``draw_classified``.
    """
    detections = get_port_detections(img, model, conf=conf)
    empty = {
        'console_ports': [], 'main_ports': [], 'sfp_ports': [],
        'all_boxes': [],
        'pattern_info': {'main_cluster_size': 0, 'num_clusters': 0,
                         'cluster_sizes': []},
    }
    # Need at least 4 real YOLO detections before claiming a port row.
    # Below that, treat as noise and emit nothing.
    if len(detections) < 4:
        return empty

    centers = [(d['center'][0], d['center'][1]) for d in detections]

    # ==================================================================
    # Layer 1 — Column-based classification
    # ==================================================================
    top, bot, r1, r2 = find_rows(centers, img.shape[0])
    dx = get_dx(centers)
    tol = dx * 0.5
    # Dynamic box size from actual port spacing
    hw = max(3, int(dx * 0.45))
    hh = max(3, int(dx * 0.55))
    top_cxs = [x for x, _ in top]
    bot_cxs = [x for x, _ in bot]

    # Single-row device: if the two "rows" are too close together,
    # merge all detections into one row so each column yields 1 box.
    # Use 15% of crop height — works across all resolutions.
    row_merge_thr = max(5, int(img.shape[0] * 0.10))
    if r1 is not None and r2 is not None and abs(r2 - r1) < row_merge_thr:
        merged_y = int((r1 + r2) / 2)
        all_cx = sorted(x for x, _ in top + bot)
        deduped = [all_cx[0]] if all_cx else []
        for x in all_cx[1:]:
            if x - deduped[-1] >= tol:
                deduped.append(x)
        r1 = merged_y
        r2 = None
        top_cxs = deduped
        bot_cxs = []

    cols = build_columns(top_cxs, bot_cxs, tol)

    # separate_bot left of paired → console, right → SFP
    if not cols or not top_cxs:
        main_cols, console_cols, sfp_cols = cols or [], [], []
    else:
        min_paired = min(top_cxs)
        max_paired = max(top_cxs)
        main_cols, console_cols, sfp_cols = [], [], []
        for c in cols:
            if c['type'] == 'separate_bot':
                if c['cx'] < min_paired:
                    console_cols.append(c)
                else:
                    sfp_cols.append(c)
            else:
                main_cols.append(c)

    # Gap rescue — console columns close to main stay as main
    if main_cols and console_cols:
        main_xs = sorted(c['cx'] for c in main_cols)
        if len(main_xs) >= 2:
            spacings = [main_xs[i + 1] - main_xs[i]
                        for i in range(len(main_xs) - 1)]
            median_sp = sorted(spacings)[len(spacings) // 2]
            gap_thr = max(median_sp * 1.5, dx * 1.5)
        else:
            gap_thr = dx * 3
        rescued, kept = [], []
        for c in console_cols:
            if min(abs(c['cx'] - mx) for mx in main_xs) < gap_thr:
                rescued.append(c)
            else:
                kept.append(c)
        main_cols = sorted(main_cols + rescued, key=lambda c: c['cx'])
        console_cols = kept

    # Max 1 console per device — keep leftmost, rest become "other"
    # (NOT main — they were classified as console for a reason)
    extra_console = []
    if len(console_cols) > 1:
        console_cols.sort(key=lambda c: c['cx'])
        extra_console = console_cols[1:]
        console_cols = console_cols[:1]

    # ==================================================================
    # Layer 2 — Pattern-based SFP detection (catches 2-row SFP)
    # ==================================================================
    # Build main boxes from Layer 1, then cluster them to find pattern
    img_h = img.shape[0]
    main_boxes_l1 = get_boxes(main_cols, r1, r2, hw=hw, hh=hh, detections=detections, img_h=img_h)

    # Cluster the main boxes by x-gaps
    if len(main_boxes_l1) >= 4:
        box_xs = sorted(set((b[0] + b[2]) // 2 for b in main_boxes_l1))
        if len(box_xs) >= 2:
            col_tol_p = BOX_W // 3
            col_xs_p = [box_xs[0]]
            for x in box_xs[1:]:
                if x - col_xs_p[-1] > col_tol_p:
                    col_xs_p.append(x)

            if len(col_xs_p) >= 2:
                col_gaps_p = sorted(
                    col_xs_p[i + 1] - col_xs_p[i]
                    for i in range(len(col_xs_p) - 1)
                )
                median_p = col_gaps_p[len(col_gaps_p) // 2]
                thr_p = median_p * 1.3

                # Build cluster sizes by counting boxes per group
                group_sizes = [1]
                prev_x = col_xs_p[0]
                for x in col_xs_p[1:]:
                    if x - prev_x > thr_p:
                        group_sizes.append(0)
                    group_sizes[-1] += 1
                    prev_x = x

                if len(group_sizes) >= 2:
                    from collections import Counter
                    main_pat = Counter(group_sizes).most_common(1)[0][0]

                    # If the last group is significantly smaller → SFP
                    last_size = group_sizes[-1]
                    if last_size < main_pat * 0.6:
                        # Move the last N columns from main to SFP
                        n_sfp_cols = last_size
                        extra_sfp = main_cols[-n_sfp_cols:]
                        main_cols = main_cols[:-n_sfp_cols]
                        sfp_cols = sfp_cols + extra_sfp
                        # Recalculate pattern info
                        group_sizes = group_sizes[:-1]
                        main_pat = Counter(group_sizes).most_common(1)[0][0] if group_sizes else 0

    # ==================================================================
    # Layer 3 — Verify & fill hidden top ports for edge columns
    # ==================================================================
    # 'separate_bot' columns in main are edge positions (rescued from
    # console).  For each one:
    #   1. Check BOTTOM region — is it a real port or blank panel?
    #      If blank panel → YOLO false positive → drop entirely.
    #   2. Check TOP region (safe crop, skip upper margin to avoid
    #      neighboring device bleed) — hidden port behind cable?
    #      If yes → upgrade to 'top_paired' → main.
    #      If no  → keep bottom only → 'other'.
    #
    # Interior hidden ports are already handled by 'consec_bot'.
    other_cols = list(extra_console)

    # Process rescued separate_bot columns closest-to-main first.
    # Each filled column extends the confirmed set, letting the next
    # column in the chain fill too (e.g., 235→198 on MikroTik).
    confirmed = [c for c in main_cols if c['type'] != 'separate_bot']
    sep_bots = [c for c in main_cols if c['type'] == 'separate_bot']

    # Sort by distance to nearest confirmed column (closest first)
    confirmed_xs = [c['cx'] for c in confirmed]
    if confirmed_xs:
        sep_bots.sort(key=lambda c: min(abs(c['cx'] - mx) for mx in confirmed_xs))

    for c in sep_bots:
        cx = int(c['cx'])
        current_xs = [cc['cx'] for cc in confirmed]
        if current_xs:
            gap = min(abs(cx - mx) for mx in current_xs)
            if gap <= dx * 1.1:
                c['type'] = 'top_paired'
                confirmed.append(c)
                continue
        other_cols.append(c)

    main_cols = sorted(confirmed, key=lambda c: c['cx'])

    # ==================================================================
    # Layer 4 — Pattern correction: fill short first cluster
    # ==================================================================
    # If the first main-port cluster has fewer columns than the dominant
    # pattern, pull nearby other/extra_console ports to fill it.
    if len(main_cols) >= 4:
        mcxs = [c['cx'] for c in main_cols]
        m_clusters = [[0]]
        for i in range(1, len(mcxs)):
            if mcxs[i] - mcxs[i - 1] > dx * 1.3:
                m_clusters.append([])
            m_clusters[-1].append(i)

        if len(m_clusters) >= 2:
            from collections import Counter
            csizes = [len(cl) for cl in m_clusters]
            pattern_sz = Counter(csizes).most_common(1)[0][0]

            if csizes[0] < pattern_sz:
                needed = pattern_sz - csizes[0]
                left_edge = mcxs[m_clusters[0][0]]
                candidates = sorted(other_cols + extra_console,
                                    key=lambda c: abs(c['cx'] - left_edge))
                added = 0
                keep_other = []
                for c in candidates:
                    if added >= needed:
                        keep_other.append(c)
                        continue
                    if c['cx'] < left_edge and left_edge - c['cx'] <= dx * 1.2:
                        c['type'] = 'top_paired'
                        main_cols.append(c)
                        left_edge = c['cx']
                        added += 1
                    else:
                        keep_other.append(c)
                if added > 0:
                    main_cols = sorted(main_cols, key=lambda c: c['cx'])
                other_cols = [c for c in keep_other if c not in extra_console]
                extra_console = [c for c in keep_other if c in extra_console]

    # ==================================================================
    # Build final boxes and port dicts
    # ==================================================================
    main_boxes = get_boxes(main_cols, r1, r2, hw=hw, hh=hh, detections=detections, img_h=img_h)
    sfp_boxes = get_boxes(sfp_cols, r1, r2, hw=hw, hh=hh, detections=detections, img_h=img_h)
    console_boxes = get_boxes(console_cols, r1, r2, hw=hw, hh=hh, detections=detections, img_h=img_h)
    other_boxes = get_boxes(other_cols, r1, r2, hw=hw, hh=hh, detections=detections, img_h=img_h)

    # Edge-density verification — drop boxes over blank panel areas
    main_boxes = verify_boxes_with_edges(img, main_boxes)
    sfp_boxes = verify_boxes_with_edges(img, sfp_boxes)
    console_boxes = verify_boxes_with_edges(img, console_boxes)
    other_boxes = verify_boxes_with_edges(img, other_boxes)

    all_dets = detections

    def _match(cx, cy):
        best = min(all_dets,
                   key=lambda d: (d['center'][0] - cx) ** 2
                               + (d['center'][1] - cy) ** 2)
        return (best['class_name'], best['confidence'],
                infer_port_status(best['class_name'], best['confidence']))

    def _port_list(boxes, category, indexed=False):
        ports = []
        for i, box in enumerate(boxes, 1):
            cx = (box[0] + box[2]) // 2
            cy = (box[1] + box[3]) // 2
            cn, cf, st = _match(cx, cy)
            p = {
                'box': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                'center': [cx, cy], 'status': st,
                'class_name': cn, 'confidence': cf,
                'port_category': category,
            }
            if indexed:
                p['index'] = i
            ports.append(p)
        return ports

    main_ports = _port_list(main_boxes, 'main', indexed=True)
    sfp_ports = _port_list(sfp_boxes, 'sfp')
    console_ports = _port_list(console_boxes, 'console')
    other_ports = _port_list(other_boxes, 'other')

    # ==================================================================
    # Final safety: remove overlapping ports (ports never overlay)
    # ==================================================================
    all_ports = main_ports + sfp_ports + console_ports + other_ports
    all_ports = _remove_overlapping_ports(all_ports)
    main_ports = [p for p in all_ports if p.get('port_category') == 'main']
    sfp_ports = [p for p in all_ports if p.get('port_category') == 'sfp']
    console_ports = [p for p in all_ports if p.get('port_category') == 'console']
    other_ports = [p for p in all_ports if p.get('port_category') == 'other']
    for i, p in enumerate(main_ports, 1):
        p['index'] = i

    # Pattern info
    all_boxes = [p['box'] for p in all_ports]
    cluster_info = cluster_ports(detections)

    return {
        'console_ports': console_ports,
        'main_ports': main_ports,
        'sfp_ports': sfp_ports,
        'other_ports': other_ports,
        'all_boxes': all_boxes,
        'pattern_info': {
            'main_cluster_size': main_pat if 'main_pat' in dir() else 0,
            'num_clusters': len(cluster_info),
            'cluster_sizes': [len(c) for c in cluster_info],
        },
    }


# ---------------------------------------------------------------------------
# Patch panel port detection
# ---------------------------------------------------------------------------

def _fill_column_gaps(cols, dx):
    """Fill gaps between consecutive columns where spacing > 1.5 * dx.

    Only inserts columns BETWEEN existing detected columns — never
    extends beyond the first/last column.  If detection is already
    complete, nothing is added.
    """
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


def _iou(box_a, box_b):
    """Intersection-over-min-area between two [x1,y1,x2,y2] boxes."""
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


def _template_match_peaks(img, template, score_threshold=0.45):
    """Return [(score, cx, cy)] peaks where ``template`` matches ``img``.

    Uses NCC (TM_CCOEFF_NORMED), then keeps only local maxima within a
    template-sized neighbourhood so we don't get hundreds of near-identical
    candidates clustered around each true match.
    """
    if template is None or template.size == 0:
        return []
    th, tw = template.shape[:2]
    ih, iw = img.shape[:2]
    if th >= ih or tw >= iw:
        return []
    result = cv2.matchTemplate(img, template, cv2.TM_CCOEFF_NORMED)
    # Local-max suppression: a pixel is a peak if it equals the dilated value.
    kernel = np.ones((max(3, th // 2), max(3, tw // 2)), np.uint8)
    dilated = cv2.dilate(result, kernel)
    peaks_mask = (result == dilated) & (result >= score_threshold)
    ys, xs = np.where(peaks_mask)
    out = []
    for y, x in zip(ys, xs):
        out.append((float(result[y, x]), int(x + tw // 2), int(y + th // 2)))
    return out


def classify_ports_with_target_count(img, model, target_count, conf=CONF):
    """Produce exactly ``target_count`` accurate ``main_ports`` for the user.

    Algorithm — **template matching** seeded from real YOLO detections:

      1. Run the normal classifier and keep its detections as anchors.
      2. If detected > target → trim the lowest-confidence detections.
      3. Otherwise pick up to two templates from the anchor pool: the most
         confident **empty** port, and the most confident **connected**
         port. Both are 32×32-ish crops of real ports on this exact device.
      4. Slide each template across the device crop with NCC
         (cv2.matchTemplate). Local-max NMS gives one peak per real port.
      5. Filter peaks to the row(s) the anchors live in (vertical band of
         ±box_h around each row centre).
      6. Apply spatial NMS against the existing anchors and against
         already-kept peaks (overlap > 0.3 → reject) so no two ports overlap.
      7. Take the highest-scoring remaining peaks until we hit the target.

    No grid extrapolation, no edge-only heuristics. Phantom positions can
    only appear if the panel actually contains a port-shaped region matching
    the template, which by construction means it is a port.

    If template matching genuinely can't find enough matches we return what
    we have — accuracy is preferred over forcing the count.
    """
    target_count = int(target_count)
    if target_count < 0:
        target_count = 0

    base = classify_ports_by_pattern(img, model, conf=min(conf, 0.10))
    main = list(base.get('main_ports', []))

    # Too many → trim by confidence
    if len(main) > target_count:
        main.sort(key=lambda p: p.get('confidence', 0) or 0, reverse=True)
        main = main[:target_count]
        main.sort(key=lambda p: p['center'][0])
        for i, p in enumerate(main, 1):
            p['index'] = i
        base['main_ports'] = main
        return base

    # Already at target → done
    if len(main) == target_count:
        return base

    # Nothing detected → can't template-match; bail safely
    if not main:
        return base

    img_h, img_w = img.shape[:2]

    # ── Pick templates: best empty + best connected (or whatever we have) ──
    by_conf = sorted(main, key=lambda p: p.get('confidence', 0) or 0, reverse=True)

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
    # Fallback: just use the most confident port if we couldn't find one of each
    if not templates:
        t = crop_box(by_conf[0])
        if t is not None and t.size > 0:
            templates.append(t)
    if not templates:
        return base

    # ── Run template matching, gather peaks from each template ──
    # Try a strict threshold first; relax if we don't find enough.
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
            peaks.extend(_template_match_peaks(img, tmpl, score_threshold=threshold))
        # Sort by score descending
        peaks.sort(key=lambda p: p[0], reverse=True)

        chosen = []
        for score, cx, cy in peaks:
            if len(chosen) >= needed:
                break
            if not in_row(cy):
                continue
            # Build candidate box using template size from the anchor port
            # (we use the first template's dims — they're typically uniform)
            th, tw = templates[0].shape[:2]
            bx1 = max(0, cx - tw // 2)
            by1 = max(0, cy - th // 2)
            bx2 = min(img_w, cx + tw // 2)
            by2 = min(img_h, cy + th // 2)
            cand_box = [bx1, by1, bx2, by2]
            # NMS against existing anchors
            if any(_iou(cand_box, p['box']) > 0.3 for p in main):
                continue
            # NMS against already-chosen peaks
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

    # Merge anchors + chosen peaks, sort left-to-right, re-index
    final = list(main) + chosen
    final.sort(key=lambda p: p['center'][0])
    for i, p in enumerate(final, 1):
        p['index'] = i
    base['main_ports'] = final
    return base


def detect_patch_panel_ports(img, model, conf=CONF):
    """Detect ports on a patch panel — conservative gap filling only.

    Patch panels have continuous, uniformly-spaced ports (24 or 48).
    This function uses normal detection, then fills only GAPS in the
    middle where consecutive detected columns are too far apart.
    If detection is already perfect, nothing changes.

    All ports are classified as 'main' (no console/SFP on patch panels).
    """
    dets = get_port_detections(img, model, conf=conf)

    # Two-pass: if initial detection is sparse, retry at lower confidence
    if len(dets) < 12:
        dets_low = get_port_detections(img, model, conf=0.05)
        if len(dets_low) > len(dets):
            dets = dets_low

    empty = {
        'console_ports': [], 'main_ports': [], 'sfp_ports': [],
        'other_ports': [], 'all_boxes': [],
        'pattern_info': {'main_cluster_size': 0, 'num_clusters': 0,
                         'cluster_sizes': []},
    }
    # Need at least 4 real YOLO detections before claiming a patch panel
    # port row. Below that, treat as noise and emit nothing.
    if len(dets) < 4:
        return empty

    h_img, w_img = img.shape[:2]
    centers = [(d['center'][0], d['center'][1]) for d in dets]

    # Row analysis. Patch panels come in two physical layouts:
    #   - Single row of 24 jacks (most common 1U panel)
    #   - Two rows of 24 = 48 jacks (2U panel, or 1U dense panel)
    # We treat the panel as 2-row when find_rows returns two well-separated
    # row centres AND both rows have detections close to them. Otherwise we
    # fall back to the original "merge into one row" behaviour.
    top, bot, r1, r2 = find_rows(centers, h_img)
    two_rows = False
    if r1 is not None and r2 is not None and len(top) >= 2 and len(bot) >= 2:
        # Rows separated by at least 25% of crop height = real 2-row panel.
        if abs(r2 - r1) >= max(8, int(h_img * 0.25)):
            two_rows = True
    if not two_rows and r1 is not None and r2 is not None:
        r1 = int((r1 + r2) / 2)
        r2 = None

    # Build clean column positions by merging nearby detections
    dx = get_dx(centers)

    # Filter detections too close to crop edges (panel frame/brackets).
    # Use a small fixed margin so sparse dx doesn't over-clip.
    edge_margin = min(dx * 0.5, w_img * 0.02)
    dets_filtered = [d for d in dets if d['center'][0] >= edge_margin
                     and d['center'][0] <= w_img - edge_margin]
    if len(dets_filtered) < 2:
        return empty

    all_xs = sorted(d['center'][0] for d in dets_filtered)

    # Merge detections within dx*0.4 into single column positions
    col_xs = [all_xs[0]]
    for x in all_xs[1:]:
        if x - col_xs[-1] > dx * 0.4:
            col_xs.append(x)

    # Clean gap fill between detected columns
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

    # Cap columns at 24 (standard patch panel)
    max_cols = 24
    if len(col_xs) > max_cols:
        col_xs = col_xs[:max_cols]

    # Extend edges using edge-density verification.
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

    # Trim at most 2 phantom columns from the LEFT edge only — columns
    # extrapolated into panel frame / brackets before actual ports start.
    all_det_xs = [d['center'][0] for d in dets]
    for _ in range(2):
        if len(col_xs) <= 1:
            break
        if not any(abs(col_xs[0] - dx_) <= dx * 0.7 for dx_ in all_det_xs):
            col_xs.pop(0)
        else:
            break

    # Build boxes — use spacing-based size so boxes never overlap
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

    # Edge-density verification — drop boxes over blank areas
    boxes = verify_boxes_with_edges(img, boxes)

    # Match each box to nearest detection for status
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
            'center': [cx, cy], 'status': st,
            'class_name': cn, 'confidence': cf,
            'port_category': 'main',
        })

    return {
        'console_ports': [], 'main_ports': main_ports,
        'sfp_ports': [], 'other_ports': [],
        'all_boxes': [p['box'] for p in main_ports],
        'pattern_info': {
            'main_cluster_size': len(main_ports),
            'num_clusters': 1,
            'cluster_sizes': [len(main_ports)],
        },
    }
