"""Batch-run every image in Racks/ through the pipeline and emit a single HTML
report at outputs/batch_racks/index.html showing original + annotated images
side-by-side for manual verification.

Per image we capture:
  - original image (copied into the per-image folder for portable HTML)
  - 2_devices_only.png       (device boxes, no ports, no unit grid)
  - 8_ports_only.png         (port boxes only, no device boxes — derived
                              from device_unit_map.json so we don't re-run
                              detection)
  - device_unit_report.txt   (U-row textual report)

Usage:
    python scripts/batch_racks_html.py
    python scripts/batch_racks_html.py --input Racks --output outputs/batch_racks
"""

import argparse
import html
import io
import json
import os
import shutil
import sys
import time
import traceback
from contextlib import redirect_stdout

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

os.environ.setdefault("YOLO_VERBOSE", "False")

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def find_images(folder):
    out = []
    for name in sorted(os.listdir(folder)):
        if name.lower().endswith(IMAGE_EXTS):
            out.append(os.path.join(folder, name))
    return out


def safe_slug(name):
    # Strip extension + replace anything non-alnum/_- with _
    stem = os.path.splitext(os.path.basename(name))[0]
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in stem)


def run_one(runner_mod, image_path, out_dir, config_path):
    """Invoke runner.main() with sys.argv set as if called from CLI.
    Returns (ok, elapsed_seconds, tail_log)."""
    argv_old = sys.argv
    sys.argv = [
        "pipeline.runner",
        "--image",      image_path,
        "--config",     config_path,
        "--output_dir", out_dir,
        "--detect_only",
    ]
    buf = io.StringIO()
    t0 = time.time()
    try:
        with redirect_stdout(buf):
            runner_mod.main()
        elapsed = time.time() - t0
        return True, elapsed, buf.getvalue()[-2000:]
    except Exception as exc:
        elapsed = time.time() - t0
        tb = traceback.format_exc()
        tail = buf.getvalue()[-1500:]
        return False, elapsed, f"{exc.__class__.__name__}: {exc}\n--- stdout tail ---\n{tail}\n--- traceback ---\n{tb}"
    finally:
        sys.argv = argv_old


def read_report(path):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read()


def read_json(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def render_ports_only(image_path, payload, out_path):
    """Re-draw the original image with ONLY port boxes (no device boxes,
    no unit grid). Colors mirror runner.py's full-rack overlay:
      - main_ports    -> red
      - sfp_ports     -> yellow
      - console_ports -> cyan
    Returns True if written, False otherwise."""
    import cv2 as _cv2
    img = _cv2.imread(image_path)
    if img is None:
        return False

    CLR_CONSOLE = (255, 255, 0)   # cyan (BGR)
    CLR_MAIN    = (0, 0, 255)     # red
    CLR_SFP     = (0, 255, 255)   # yellow

    for dev in (payload.get("devices") or []):
        box = dev.get("box") or []
        if len(box) != 4:
            continue
        ox, oy = int(box[0]), int(box[1])
        for ports, clr in (
            (dev.get("console_ports") or [], CLR_CONSOLE),
            (dev.get("ports")         or [], CLR_MAIN),
            (dev.get("sfp_ports")     or [], CLR_SFP),
        ):
            for p in ports:
                pb = p.get("box") or []
                if len(pb) != 4:
                    continue
                px1, py1, px2, py2 = (int(v) for v in pb)
                _cv2.rectangle(
                    img, (px1 + ox, py1 + oy), (px2 + ox, py2 + oy), clr, 1,
                )

    return bool(_cv2.imwrite(out_path, img))


def build_html(entries, output_html):
    """entries: list of dicts with keys
      name, slug, original_rel, devices_rel, ports_rel,
      report_text, ok, elapsed, error, n_devices, n_units
    """
    style = """
    body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; padding: 0; background: #0f1115; color: #e8eaed; }
    header { padding: 16px 24px; background: #1a1d23; border-bottom: 1px solid #2a2e36; position: sticky; top: 0; z-index: 10; }
    header h1 { margin: 0 0 4px 0; font-size: 18px; font-weight: 600; }
    header .meta { font-size: 12px; color: #9aa0a6; }
    .item { border-bottom: 1px solid #2a2e36; padding: 20px 24px; }
    .item h2 { margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #e8eaed; }
    .item .sub { font-size: 12px; color: #9aa0a6; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .cell { background: #1a1d23; border: 1px solid #2a2e36; border-radius: 6px; padding: 8px; }
    .cell .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #9aa0a6; margin-bottom: 6px; }
    .cell img { width: 100%; height: auto; display: block; border-radius: 4px; cursor: zoom-in; }
    .report { margin-top: 12px; background: #0a0c10; border: 1px solid #2a2e36; border-radius: 6px; padding: 10px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; color: #c9d1d9; max-height: 240px; overflow: auto; }
    .err { color: #ff6b6b; }
    .ok-pill  { display: inline-block; padding: 2px 8px; background: #1f3a2a; color: #7ee2a8; border-radius: 10px; font-size: 11px; }
    .bad-pill { display: inline-block; padding: 2px 8px; background: #3a1f1f; color: #ff8a8a; border-radius: 10px; font-size: 11px; }
    a { color: #6ea8fe; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .toc { padding: 12px 24px; background: #14171c; border-bottom: 1px solid #2a2e36; font-size: 13px; }
    .toc a { margin-right: 10px; }
    @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
    """

    ok_count  = sum(1 for e in entries if e["ok"])
    bad_count = len(entries) - ok_count
    total_t   = sum(e.get("elapsed", 0) for e in entries)

    parts = []
    parts.append(f"<!doctype html><html><head><meta charset='utf-8'>")
    parts.append(f"<title>RackTrack batch — {len(entries)} images</title>")
    parts.append(f"<style>{style}</style></head><body>")
    parts.append(
        f"<header><h1>RackTrack batch — {len(entries)} images</h1>"
        f"<div class='meta'>{ok_count} ok · {bad_count} failed · "
        f"{total_t:.1f}s total · click any image to open full-size</div></header>"
    )

    # TOC
    toc_links = " ".join(
        f"<a href='#{e['slug']}'>{html.escape(e['name'])}</a>" for e in entries
    )
    parts.append(f"<div class='toc'>{toc_links}</div>")

    for e in entries:
        pill = "<span class='ok-pill'>OK</span>" if e["ok"] else "<span class='bad-pill'>FAILED</span>"
        sub_bits = [pill, f"{e['elapsed']:.1f}s"]
        if e["ok"]:
            sub_bits.append(f"{e['n_devices']} devices")
            sub_bits.append(f"{e['n_units']} units")
        sub = " · ".join(sub_bits)

        parts.append(f"<section class='item' id='{e['slug']}'>")
        parts.append(f"<h2>{html.escape(e['name'])}</h2>")
        parts.append(f"<div class='sub'>{sub}</div>")

        def cell(label, rel):
            if rel and os.path.exists(os.path.join(os.path.dirname(output_html), rel)):
                return (f"<div class='cell'><div class='label'>{label}</div>"
                        f"<a href='{rel}' target='_blank'><img src='{rel}' loading='lazy'></a></div>")
            return f"<div class='cell'><div class='label'>{label}</div><div class='err'>(missing)</div></div>"

        parts.append("<div class='grid'>")
        parts.append(cell("Original",     e.get("original_rel")))
        parts.append(cell("Devices Only", e.get("devices_rel")))
        parts.append(cell("Ports Only",   e.get("ports_rel")))
        parts.append("</div>")

        if e["ok"] and e.get("report_text"):
            parts.append(f"<div class='report'>{html.escape(e['report_text'])}</div>")
        elif not e["ok"]:
            parts.append(f"<div class='report err'>{html.escape(e.get('error', '(no error captured)'))}</div>")

        parts.append("</section>")

    parts.append("</body></html>")
    with open(output_html, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",  default=os.path.join(PROJECT_ROOT, "Racks"))
    ap.add_argument("--output", default=os.path.join(PROJECT_ROOT, "outputs", "batch_racks"))
    ap.add_argument("--config", default=os.path.join(PROJECT_ROOT, "config.json"))
    ap.add_argument("--limit",  type=int, default=0, help="Process at most N images (0 = all).")
    args = ap.parse_args()

    if not os.path.isdir(args.input):
        print(f"[error] input folder not found: {args.input}", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.config):
        print(f"[error] config not found: {args.config}", file=sys.stderr)
        sys.exit(2)

    os.makedirs(args.output, exist_ok=True)

    images = find_images(args.input)
    if args.limit > 0:
        images = images[: args.limit]
    if not images:
        print(f"[error] no images in {args.input}", file=sys.stderr)
        sys.exit(1)

    print(f"[batch] {len(images)} image(s) in {args.input}")
    print(f"[batch] output -> {args.output}")
    print(f"[batch] importing pipeline.runner (loads YOLO models once)...")

    # Apply the same cv2.imread patch the worker uses — protects redirect_stdout
    # on Windows/py3.13 where ultralytics' np.fromfile path crashes.
    import cv2
    import numpy as np

    def _safe_imread(filename, flags=cv2.IMREAD_COLOR):
        try:
            with open(filename, "rb") as f:
                data = f.read()
        except OSError:
            return None
        if not data:
            return None
        file_bytes = np.frombuffer(data, np.uint8)
        im = cv2.imdecode(file_bytes, flags)
        if im is not None and im.ndim == 2:
            im = im[..., None]
        return im
    cv2.imread = _safe_imread

    from pipeline import runner as runner_mod

    entries = []
    for i, image_path in enumerate(images, 1):
        name = os.path.basename(image_path)
        slug = safe_slug(name)
        out_dir = os.path.join(args.output, slug)
        os.makedirs(out_dir, exist_ok=True)

        print(f"\n[{i}/{len(images)}] {name}")
        ok, elapsed, log_or_err = run_one(runner_mod, image_path, out_dir, args.config)
        if ok:
            print(f"  -> ok in {elapsed:.1f}s")
        else:
            print(f"  -> FAILED in {elapsed:.1f}s: {log_or_err.splitlines()[0] if log_or_err else ''}")

        # Copy the original into the per-image folder so the HTML is portable
        ext = os.path.splitext(name)[1].lower() or ".jpg"
        original_dst = os.path.join(out_dir, f"original{ext}")
        try:
            shutil.copyfile(image_path, original_dst)
        except Exception as exc:
            print(f"  [warn] failed to copy original: {exc}")
            original_dst = None

        devices_abs = os.path.join(out_dir, "images", "2_devices_only.png")
        ports_abs   = os.path.join(out_dir, "images", "8_ports_only.png")
        report_text = read_report(os.path.join(out_dir, "device_unit_report.txt"))
        payload     = read_json(os.path.join(out_dir, "device_unit_map.json")) or {}

        # Build ports-only image from JSON + the copied original (runner
        # doesn't emit a ports-only render natively — its 7_rack_all_ports.png
        # also overlays device boxes, which we don't want here).
        if ok and original_dst and payload:
            try:
                if not render_ports_only(original_dst, payload, ports_abs):
                    print(f"  [warn] ports-only render returned False")
            except Exception as exc:
                print(f"  [warn] ports-only render failed: {exc}")

        rel = lambda p: os.path.relpath(p, args.output).replace("\\", "/") if p and os.path.exists(p) else None
        entries.append({
            "name":         name,
            "slug":         slug,
            "ok":           ok,
            "elapsed":      elapsed,
            "error":        None if ok else log_or_err,
            "report_text":  report_text,
            "n_devices":    len(payload.get("devices") or []),
            "n_units":      len(payload.get("units_detected") or []),
            "original_rel": rel(original_dst),
            "devices_rel":  rel(devices_abs),
            "ports_rel":    rel(ports_abs),
        })

    html_path = os.path.join(args.output, "index.html")
    build_html(entries, html_path)
    print(f"\n[batch] wrote {html_path}")
    print(f"[batch] open in browser:  file:///{html_path.replace(chr(92), '/')}")


if __name__ == "__main__":
    main()
