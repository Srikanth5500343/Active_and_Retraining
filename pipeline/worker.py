"""Persistent worker: keeps Python + all YOLO models warm in memory, so each
request avoids the ~10s cold start that `pipeline.runner` pays when spawned
per-request.

Node dispatches JSON requests line-by-line via stdin; worker responds on stdout.
All progress logs + ultralytics spam go to stderr so the stdout protocol stays
parseable. Protocol: each line is one complete JSON object.

Handshake:
    Worker emits {"ready": true} on stdout when models are loaded.

Request shapes (stdin):
    {"id": "<uuid>", "command": "quality_check", "image_path": "..."}
    {"id": "<uuid>", "command": "analyze",  "image_path": "...", "config_path": "...", "output_dir": "..."}
    {"id": "<uuid>", "command": "select",   "image_path": "...", "config_path": "...", "output_dir": "...", "device_index": 0, "port": 1}

Response shape (stdout):
    {"id": "<uuid>", "ok": true,  ...}
    {"id": "<uuid>", "ok": false, "error": "..."}
"""

import io
import json
import os
import sys
import traceback
from contextlib import redirect_stdout

# Silence ultralytics' per-inference progress lines before anything imports it,
# otherwise they escape our redirect_stdout and corrupt the JSON protocol.
os.environ.setdefault("YOLO_VERBOSE", "False")


def log(msg):
    print(f"[worker] {msg}", file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


log("importing pipeline modules (slow, one-time)")
from pipeline import runner  # noqa: E402
from pipeline.quality_check import check_tilt, check_letterbox, check_side_view  # noqa: E402
from pipeline.detection import load_model  # noqa: E402
from pipeline.cable import load_cable_model, load_port_identify_model  # noqa: E402
import cv2  # noqa: E402
import numpy as np  # noqa: E402

# Ultralytics monkey-patches cv2.imread to use np.fromfile (multilang filename
# support). On Python 3.13 + Windows, np.fromfile raises
# "'NoneType' object has no attribute 'flush'" when called while sys.stdout is
# redirected (which we do via redirect_stdout in handle_pipeline). Replace it
# with an open()-based equivalent that avoids np.fromfile entirely.
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
log("cv2.imread patched to open()+imdecode (bypasses ultralytics np.fromfile)")


QUALITY_ERROR = ("Please upload a clearer photo of the rack — keep the camera "
                 "steady and make sure the full rack fits in the frame.")


def preload_models(config_path):
    with open(config_path) as f:
        config = json.load(f)
    models = config.get("models", {})
    for key in ("units", "devices", "server", "port_count"):
        p = models.get(key)
        if p:
            log(f"preloading {key} ({p})")
            load_model(p)
    if models.get("cable_classifier"):
        log(f"preloading cable_classifier ({models['cable_classifier']})")
        load_cable_model(models["cable_classifier"])
    if models.get("port_identify"):
        log(f"preloading port_identify ({models['port_identify']})")
        load_port_identify_model(models["port_identify"])


def handle_quality_check(req):
    img = cv2.imread(req["image_path"])
    if img is None:
        return {"ok": False, "error": QUALITY_ERROR}
    lb = check_letterbox(img)
    if not lb["ok"]:
        return lb
    tilt = check_tilt(img)
    if not tilt["ok"]:
        return tilt
    side = check_side_view(img)

    merged = {}
    merged.update(tilt.get("metrics", {}))
    merged.update(side.get("metrics", {}))
    result = {"ok": True, "metrics": merged}
    if side.get("warning"):
        result["warning"] = side["warning"]
        result["warning_msg"] = side["error"]
    return result


def handle_extract_best_frame(req):
    from pipeline.frame_selector import extract_best_frame
    frame = extract_best_frame(req["video_path"])
    if frame is None:
        return {"ok": False,
                "error": "Could not read a usable frame from the video. Please record a clearer video of the rack."}
    output_path = req["output_path"]
    if not cv2.imwrite(output_path, frame):
        return {"ok": False, "error": f"Failed to write extracted frame to {output_path}"}
    return {"ok": True, "image_path": output_path}


def handle_relabel_port_count(req):
    """Re-detect ports for one device with a user-supplied target count.
    Updates that device's entry in device_unit_map.json and returns it."""
    import json as _json
    rack_dir     = req["rack_dir"]
    device_index = int(req["device_index"])
    target_count = int(req["target_count"])
    config_path  = req["config_path"]

    map_path = os.path.join(rack_dir, "device_unit_map.json")
    if not os.path.exists(map_path):
        return {"ok": False, "error": "device_unit_map.json missing"}
    with open(map_path) as f:
        data = _json.load(f)
    devices = data.get("devices", [])
    if not (1 <= device_index <= len(devices)):
        return {"ok": False, "error": "device_index out of range"}
    device = devices[device_index - 1]

    # Locate the original image — try the new flat layout, then any candidate.
    img_path = None
    for ext in ("jpg", "jpeg", "png"):
        candidate = os.path.join(rack_dir, f"original_image.{ext}")
        if os.path.exists(candidate):
            img_path = candidate
            break
    if img_path is None:
        return {"ok": False, "error": "original image not found in rack folder"}

    img = cv2.imread(img_path)
    if img is None:
        return {"ok": False, "error": "could not read original image"}

    bx1, by1, bx2, by2 = [int(v) for v in device["box"]]
    crop = img[by1:by2, bx1:bx2]
    if crop.size == 0:
        return {"ok": False, "error": "device crop is empty"}

    with open(config_path) as f:
        config = _json.load(f)
    port_model = load_model(config["models"]["port_count"])
    ports_conf = config.get("detection", {}).get("ports_conf", 0.23)

    from pipeline.port_pattern import (
        classify_ports_with_target_count,
        detect_patch_panel_ports,
    )

    classified = classify_ports_with_target_count(crop, port_model, target_count, conf=ports_conf)

    main_ports = classified.get("main_ports", [])
    device["port_count"]      = len(main_ports)
    device["ports"]           = main_ports
    device["console_ports"]   = classified.get("console_ports", [])
    device["sfp_ports"]       = classified.get("sfp_ports", [])
    device["connected_ports"] = [p for p in main_ports if p.get("status") == "connected"]
    device["port_count_source"] = "user_relabeled"

    # Hardware rule: a Patch Panel is just RJ-45 jacks — no SFP cages, no
    # console port. Force-clear those so the picker doesn't show e.g. "24p 3s".
    if device.get("class_name") == "Patch Panel":
        device["console_ports"] = []
        device["sfp_ports"] = []

    # Save back atomically (write to .tmp then rename)
    tmp = map_path + ".tmp"
    with open(tmp, "w") as f:
        _json.dump(data, f, indent=2)
    os.replace(tmp, map_path)

    return {
        "ok": True,
        "device_index": device_index,
        "port_count": device["port_count"],
        "device": device,
    }


def handle_pipeline(req):
    argv = [
        "pipeline.runner",
        "--image", req["image_path"],
        "--config", req["config_path"],
        "--output_dir", req["output_dir"],
    ]
    if req.get("command") == "analyze":
        argv.append("--detect_only")
    elif req.get("command") == "select":
        argv += ["--device_index", str(req["device_index"]),
                 "--port", str(req["port"])]

    old_argv = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            runner.main()
        # Forward pipeline tail to stderr so the operator keeps visibility.
        tail = buf.getvalue()[-500:].replace("\n", " | ")
        log(f"pipeline tail: {tail}")
        return {"ok": True}
    except Exception as e:
        # Log the full traceback to stderr so it shows up in the Node server's
        # worker output — otherwise only str(e) propagates to the client.
        tb = traceback.format_exc()
        captured_tail = buf.getvalue()[-2000:]
        log(f"pipeline FAILED: {e.__class__.__name__}: {e}\n--- captured stdout tail ---\n{captured_tail}\n--- traceback ---\n{tb}")
        return {"ok": False, "error": str(e), "trace": tb}
    finally:
        sys.argv = old_argv


def handle_request(req):
    command = req.get("command")
    if command == "quality_check":
        return handle_quality_check(req)
    if command == "extract_best_frame":
        return handle_extract_best_frame(req)
    if command == "relabel_port_count":
        return handle_relabel_port_count(req)
    if command in ("analyze", "select"):
        return handle_pipeline(req)
    return {"ok": False, "error": f"Unknown command: {command}"}


def main():
    config_path = os.environ.get("RACKTRACK_CONFIG", "config.json")
    log(f"config: {config_path}")
    preload_models(config_path)
    log("ready")
    emit({"ready": True})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = handle_request(req)
            result["id"] = req_id
            emit(result)
        except Exception as e:
            emit({"id": req_id, "ok": False, "error": str(e),
                  "trace": traceback.format_exc()})


if __name__ == "__main__":
    main()
