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
from pipeline.quality_check import check_tilt, check_letterbox, check_side_view, check_occlusion  # noqa: E402
from pipeline.detection import load_model, detect_devices_dual, normalize_class_name  # noqa: E402
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

    # Occlusion check — image-based cable-clutter detector. May return a
    # hard fail (ok=False, kind='occlusion') for severely cabled racks,
    # in which case we surface it as a quality choice so the user can
    # pick multi-angle capture or proceed-anyway.
    occ = check_occlusion(img)
    if not occ.get("ok"):
        return occ

    merged = {}
    merged.update(tilt.get("metrics", {}))
    merged.update(side.get("metrics", {}))
    merged.update(occ.get("metrics", {}))
    result = {"ok": True, "metrics": merged}
    # side_view + occlusion can both emit soft warnings; prefer occlusion
    # since it points to a remediable action (multi-angle), and side_view
    # is more advisory.
    if occ.get("warning"):
        result["warning"] = occ["warning"]
        result["warning_msg"] = occ["warning_msg"]
    elif side.get("warning"):
        result["warning"] = side["warning"]
        result["warning_msg"] = side["error"]
    return result


def handle_detect_only(req):
    """Stateless, lightweight YOLO bbox detection — used by the live
    in-viewfinder overlay (POSTed at ~1 Hz). Skips the full analyze
    pipeline (no rack folder, no port detection, no OCR, no image
    renders). Returns just devices with class_name + confidence + bbox.

    Coordinates are in the input image's pixel space. The caller is
    responsible for any back-scaling to its source resolution.
    """
    import json as _json
    img_path    = req.get("image_path")
    config_path = req.get("config_path")
    if not img_path or not os.path.exists(img_path):
        return {"ok": False, "error": "image_path missing"}
    if not config_path or not os.path.exists(config_path):
        return {"ok": False, "error": "config_path missing"}

    img = cv2.imread(img_path)
    if img is None:
        return {"ok": False, "error": "could not read image"}
    h, w = img.shape[:2]

    with open(config_path) as f:
        config = _json.load(f)
    models = config.get("models", {})
    server_path  = models.get("server")
    general_path = models.get("devices") or models.get("general")
    if not general_path:
        return {"ok": False, "error": "no general/devices model configured"}

    model = load_model(general_path)

    # Inline the YOLO call so we can pass imgsz=320 — full /api/analyze
    # uses YOLO's default 640, but on CPU that's ~1s per frame; halving
    # the inference resolution roughly triples throughput while still
    # finding rack devices (40+ px tall in the source frame). Confidence
    # bumped to 0.4 to keep the live overlay from strobing on noise.
    names = getattr(model, "names", {}) or {}
    results = model(img, conf=0.4, imgsz=320, verbose=False)

    devices = []
    if results and results[0].boxes is not None and len(results[0].boxes) > 0:
        xyxy    = results[0].boxes.xyxy.cpu().numpy()
        cls_ids = results[0].boxes.cls.cpu().numpy().astype(int)
        scores  = results[0].boxes.conf.cpu().numpy()
        for box, cid, score in zip(xyxy, cls_ids, scores):
            x1, y1, x2, y2 = [int(v) for v in box]
            if (x2 - x1) < 10 or (y2 - y1) < 10:
                continue
            cn = normalize_class_name(str(names.get(int(cid), cid)))
            if cn in ("Empty", "Closed Unit", "Unidentified"):
                continue
            devices.append({
                "class_name": cn,
                "confidence": float(score),
                "bbox":       [x1, y1, x2 - x1, y2 - y1],
                "box":        [x1, y1, x2, y2],
            })

    return {"ok": True, "devices": devices, "image_size": {"w": w, "h": h}}


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


def handle_split_video_racks(req):
    """Split a multi-rack pan video into one best-frame per detected rack.
    Returns a list of {position, label, best_frame_path, ...}. The Node
    server then runs the existing single-rack analyze() on each path."""
    from pipeline.multi_rack_split import split_video_into_racks
    video_path = req["video_path"]
    output_dir = req.get("output_dir")
    try:
        racks = split_video_into_racks(video_path, output_dir=output_dir)
    except Exception as e:
        return {"ok": False, "error": f"multi-rack split failed: {e}"}
    if not racks:
        return {"ok": False,
                "error": "No racks detected in the video. Please re-record a clear pan across the racks."}
    return {"ok": True, "racks": racks, "count": len(racks)}


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
    # Patch panels run against the older count-only model (Empty_port /
    # Connected_port); switches/firewalls/gateways stay on port_best.pt.
    pp_model_rel = config["models"].get("port_patch_panel")
    pp_port_model = load_model(pp_model_rel) if pp_model_rel else port_model
    ports_conf = config.get("detection", {}).get("ports_conf", 0.23)

    from pipeline.port_pattern import (
        classify_ports_with_target_count,
        detect_patch_panel_ports,
    )

    if device.get("class_name") == "Patch Panel":
        classified = detect_patch_panel_ports(crop, pp_port_model, conf=ports_conf)
        # Honor the user-supplied target count — patch panels are uniform
        # grids of 24 or 48, so trimming/padding by index is meaningful.
        mp = classified.get("main_ports", [])
        if len(mp) > target_count:
            mp = mp[:target_count]
            for i, p in enumerate(mp, 1):
                p["index"] = i
            classified["main_ports"] = mp
    else:
        classified = classify_ports_with_target_count(
            crop, port_model, target_count, conf=ports_conf,
            status_model=pp_port_model,
        )

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


def _queue_low_confidence_samples(image_path, output_dir):
    """Uncertainty sampling: after analyze succeeds, scan the produced
    device_unit_map.json for predictions whose confidence is below the
    per-model LOW_CONF_THRESHOLDS and queue them into the active-learning
    store as `source="low_confidence"`. Best-effort — never raise.

    The queued samples flow through the same retraining pipeline as
    user corrections. Operators can then label them via the Flask UIs
    and they'll be picked up by the next retrain cycle."""
    try:
        # Lazy import so the worker boot doesn't pay this cost
        sys_path_added = False
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        if repo_root not in sys.path:
            sys.path.insert(0, repo_root)
            sys_path_added = True
        try:
            from active_learning_Cache import config as al_cfg
            from active_learning_Cache.store import Store
        finally:
            if sys_path_added:
                try: sys.path.remove(repo_root)
                except ValueError: pass

        import json as _json
        map_path = os.path.join(output_dir, "device_unit_map.json")
        if not os.path.exists(map_path):
            return
        with open(map_path, "r", encoding="utf-8") as f:
            data = _json.load(f)

        thr_dev = al_cfg.LOW_CONF_THRESHOLDS.get("devices", 0.0)
        if thr_dev <= 0:
            return

        # Lazy load the source image so we can crop low-conf devices
        try:
            import cv2 as _cv2
            src = _cv2.imread(image_path)
        except Exception:
            src = None

        store = Store("devices")
        low_conf_devices = [
            d for d in (data.get("devices") or [])
            if isinstance(d.get("confidence"), (int, float))
            and d["confidence"] < thr_dev
        ]
        for d in low_conf_devices:
            box = d.get("box") or []
            if src is not None and len(box) == 4:
                x1, y1, x2, y2 = [int(v) for v in box]
                crop = src[max(0, y1):y2, max(0, x1):x2]
                if crop.size > 0:
                    ok, encoded = _cv2.imencode(".jpg", crop, [_cv2.IMWRITE_JPEG_QUALITY, 88])
                    img_bytes = encoded.tobytes() if ok else None
                else:
                    img_bytes = None
            else:
                img_bytes = None

            try:
                store.add({
                    "source":    "low_confidence",
                    "predicted": {
                        "class":      d.get("class_name"),
                        "confidence": float(d["confidence"]),
                    },
                    "actual":    {},  # operator fills via Flask / React
                    "metadata":  {
                        "device_box": box,
                        "image_path": image_path,
                        "threshold":  thr_dev,
                    },
                }, image_bytes=img_bytes)
            except Exception as e:
                # Don't let the AL queue cap us blocking the analyze
                log(f"AL low-conf queue rejected: {e}")
                break
        if low_conf_devices:
            log(f"AL: queued {len(low_conf_devices)} low-conf devices "
                f"(threshold={thr_dev})")
    except Exception as e:
        # Anything goes wrong → swallow. Active learning is a side-channel,
        # never a hard dependency of the analyze response.
        log(f"AL uncertainty hook failed (non-fatal): {e}")


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
        port_category = req.get("port_category")
        if port_category:
            argv += ["--port_category", str(port_category)]

    old_argv = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            runner.main()
        # Forward pipeline tail to stderr so the operator keeps visibility.
        tail = buf.getvalue()[-500:].replace("\n", " | ")
        log(f"pipeline tail: {tail}")
        # Hook: uncertainty sampling for active learning. Only on
        # analyze (select doesn't produce new predictions).
        if req.get("command") == "analyze":
            _queue_low_confidence_samples(req["image_path"], req["output_dir"])
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


def handle_extract_ticket(req):
    """Zero-LLM ticket-text extraction + reasoning chain + work-note preview.
    Pure CPU/regex work — no model loads, so it's near-instant inside the
    already-warm worker.

    Also auto-records the prediction into the feedback-loop state file so
    later resolution-feedback can score the agent's accuracy.
    """
    from pipeline.agent import (
        extract_incident, build_reasoning, _format_work_note,
        _analysis_hash, POST_CONFIDENCE_FLOOR,
    )
    from pipeline.agent_feedback import record_prediction
    import json as _json

    text = req.get("text") or ""
    cmdb_facts = req.get("cmdb_facts") or {}
    cmdb_device_list = req.get("cmdb_device_list")
    last_scan_path = req.get("last_scan_path")

    extracted = extract_incident(text, cmdb_device_list=cmdb_device_list)

    # Auto-record prediction (best-effort; never fails the request).
    inc_number = req.get("incident_number")
    if inc_number:
        try:
            record_prediction(inc_number, extracted)
        except Exception as exc:
            log(f"feedback record_prediction failed: {exc}")

    last_scan = None
    if last_scan_path and os.path.exists(last_scan_path):
        try:
            with open(last_scan_path, encoding="utf-8") as f:
                last_scan = _json.load(f)
        except Exception:
            last_scan = None

    ticket = {
        "incident_number":   inc_number,
        "sys_id":            req.get("sys_id"),
        "short_description": req.get("short_description"),
        "priority":          req.get("priority"),
        "cmdb":              cmdb_facts,
        "extracted":         extracted,
    }
    reasoning = build_reasoning(ticket, extracted, cmdb_facts, last_scan=last_scan)
    ticket["reasoning"] = reasoning

    work_note = _format_work_note(ticket)
    confidence = extracted.get("confidence", 0.0)
    would_post = confidence >= POST_CONFIDENCE_FLOOR
    status = (
        f"would post (confidence >= {POST_CONFIDENCE_FLOOR:.1f})"
        if would_post
        else f"would NOT post (confidence {confidence:.2f} below floor {POST_CONFIDENCE_FLOOR:.1f})"
    )

    return {
        "ok": True,
        "extraction": extracted,
        "reasoning":  reasoning,
        "work_note_preview": {
            "text":       work_note,
            "would_post": bool(would_post),
            "status":     status,
            "hash":       _analysis_hash(extracted, reasoning),
        },
    }


# ─────────────────────────────────────────── Agent dashboard handlers ───────
# All ServiceNow-talking handlers expect sn_creds in the request body:
#   { "sn_creds": { "instance": "...", "user": "...", "password": "..." } }
# These are passed from the Node server (loaded from server/.env or
# s_agent/.env). Worker never reads SN creds from env directly.

def _sn_context(req):
    """Returns (sn_base, sn_auth, sn_headers) or (None, None, None) when creds missing."""
    creds = req.get("sn_creds") or {}
    inst = creds.get("instance")
    user = creds.get("user")
    pw   = creds.get("password")
    if not (inst and user and pw):
        return None, None, None
    base = f"https://{inst}.service-now.com/api/now"
    return base, (user, pw), {"Accept": "application/json"}


def handle_feedback_scoreboard(req):
    """Return the agent accuracy scoreboard (no SN call — local state only)."""
    from pipeline.agent_feedback import get_scoreboard
    return {"ok": True, "scoreboard": get_scoreboard()}


def handle_feedback_refresh(req):
    """Fetch recently resolved incidents from SN, evaluate them, return both
    the per-incident evaluations and the updated scoreboard."""
    from pipeline.agent_feedback import process_resolved_incidents, get_scoreboard
    sn_base, sn_auth, sn_headers = _sn_context(req)
    if not sn_base:
        return {"ok": False, "error": "ServiceNow credentials not configured (set SN_INSTANCE/SN_USER/SN_PASSWORD)"}
    try:
        evaluations = process_resolved_incidents(sn_base, sn_auth, sn_headers, limit=int(req.get("limit") or 50))
    except Exception as exc:
        return {"ok": False, "error": f"feedback refresh failed: {exc}"}
    return {"ok": True, "evaluations": evaluations, "scoreboard": get_scoreboard()}


def handle_proactive_cached(req):
    """Return cached proactive insights (no SN call)."""
    from pipeline.agent_proactive import get_cached_insights
    return {"ok": True, "insights": get_cached_insights()}


def handle_proactive_refresh(req):
    """Regenerate proactive insights from live SN data + return them."""
    from pipeline.agent_proactive import generate_proactive_insights
    sn_base, sn_auth, sn_headers = _sn_context(req)
    if not sn_base:
        return {"ok": False, "error": "ServiceNow credentials not configured (set SN_INSTANCE/SN_USER/SN_PASSWORD)"}
    try:
        insights = generate_proactive_insights(sn_base, sn_auth, sn_headers)
    except Exception as exc:
        return {"ok": False, "error": f"proactive refresh failed: {exc}"}
    return {"ok": True, "insights": insights}


def handle_post_work_note(req):
    """Actually POST the agent's work-note text to ServiceNow.

    Request shape:
      { "command": "post_work_note",
        "ticket":  { incident_number, sys_id, cmdb, extracted, reasoning, ... },
        "sn_creds": { instance, user, password },
        "force":    bool   # optional — skip rate-limit + no-change guards }

    Returns whatever auto_post_analysis returns:
      { "ok": True, "status": "posted"|"skipped_low_confidence"|... }
    """
    from pipeline.agent import auto_post_analysis, POST_CONFIDENCE_FLOOR
    sn_base, sn_auth, sn_headers = _sn_context(req)
    if not sn_base:
        return {"ok": False, "error": "ServiceNow credentials not configured"}

    ticket = req.get("ticket") or {}
    if not ticket.get("sys_id"):
        return {"ok": False, "error": "ticket.sys_id is required"}
    if not ticket.get("extracted") or not ticket.get("reasoning"):
        return {"ok": False, "error": "ticket must include both 'extracted' and 'reasoning' (run extract_ticket first)"}

    import requests as _rq

    class _SnClient:
        """Minimal SN client — only implements add_work_note() because
        that's all auto_post_analysis() calls. Posts via PATCH to the
        incident table with the `work_notes` field. Per SN convention,
        any string written to work_notes is appended as a new note."""
        def __init__(self, base, auth, headers):
            self.base = base; self.auth = auth; self.headers = headers
        def add_work_note(self, sys_id, note_text):
            r = _rq.patch(
                f"{self.base}/table/incident/{sys_id}",
                params={"sysparm_input_display_value": "true"},
                json={"work_notes": note_text},
                auth=self.auth,
                headers={**self.headers, "Content-Type": "application/json"},
                timeout=20,
            )
            r.raise_for_status()
            return r.json().get("result", {})

    sn_client = _SnClient(sn_base, sn_auth, sn_headers)

    # If force=True, bypass guards by temporarily ignoring posted-state.
    # auto_post_analysis() checks hash + 24h rate limit; force unblocks
    # both by deleting the posted record for this incident first.
    if req.get("force"):
        from pipeline.agent import _load_posted, _save_posted
        inc = ticket.get("incident_number")
        posted = _load_posted()
        if inc in posted:
            del posted[inc]
            _save_posted(posted)

    try:
        result = auto_post_analysis(ticket, sn_client, related_in_batch=req.get("related"))
    except Exception as exc:
        return {"ok": False, "error": f"post failed: {exc}"}
    return {"ok": True, **result}


def handle_request(req):
    command = req.get("command")
    if command == "quality_check":
        return handle_quality_check(req)
    if command == "detect_only":
        return handle_detect_only(req)
    if command == "extract_best_frame":
        return handle_extract_best_frame(req)
    if command == "split_video_racks":
        return handle_split_video_racks(req)
    if command == "relabel_port_count":
        return handle_relabel_port_count(req)
    if command == "extract_ticket":
        return handle_extract_ticket(req)
    if command == "feedback_scoreboard":
        return handle_feedback_scoreboard(req)
    if command == "feedback_refresh":
        return handle_feedback_refresh(req)
    if command == "proactive_cached":
        return handle_proactive_cached(req)
    if command == "proactive_refresh":
        return handle_proactive_refresh(req)
    if command == "post_work_note":
        return handle_post_work_note(req)
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
