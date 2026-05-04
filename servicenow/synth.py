"""
Shared synthesis utilities — takes scan_result.json + an optional per-rack
override file and produces a fully-populated inventory dict ready for either
topology snapshot generation or CMDB push.

Two principles:
  1. REAL data wins. If servicenow/overrides/<rackId>.json provides a value,
     we use it verbatim. Synth only fills gaps.
  2. Synthetic values are DETERMINISTIC. We hash (rack_id, dev_name, kind) so
     re-running gives the same fake IPs/MACs/serials — which means the CMDB
     stays idempotent and "promote synthetic → real" can replace specific
     fields without churning others.

Every synthesized device dict carries `_synthetic: True` and a
`_synthetic_fields: [list]` so a future "promote" step can identify exactly
which fields were guessed and need real data.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
OVERRIDES_DIR = os.path.join(HERE, "overrides")


def _u_size_from_scan(scan: dict) -> int | None:
    """Derive the rack U-height from the scan. Tries `units_range` ("U01-U18"
    → 18), then falls back to `len(units_detected)`. Returns None if neither
    is present, so callers can apply their own default."""
    rng = scan.get("units_range")
    if isinstance(rng, str):
        m = re.search(r"U0*(\d+)\s*$", rng)
        if m:
            return int(m.group(1))
    units = scan.get("units_detected")
    if isinstance(units, list) and units:
        return len(units)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Deterministic hashing — same inputs always give the same output, so
# regenerating an old rack's topology produces the same dummy MACs/IPs.
# ─────────────────────────────────────────────────────────────────────────────

def _hash_int(*parts: Any) -> int:
    s = "|".join(str(p) for p in parts)
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest()[:8], 16)

def _pick(rack_id: str, dev_name: str, options: list[str], salt: str = "pick") -> str:
    return options[_hash_int(rack_id, dev_name, salt) % len(options)]


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic-value primitives
# ─────────────────────────────────────────────────────────────────────────────

def synth_mac(rack_id: str, dev_name: str) -> str:
    h = _hash_int(rack_id, dev_name, "mac")
    return f"AA:BB:CC:{(h >> 16) & 0xFF:02X}:{(h >> 8) & 0xFF:02X}:{h & 0xFF:02X}"

def synth_ip(rack_id: str, dev_name: str, u: int) -> str:
    """10.<rackBlock>.<u>.<host> — each rack gets its own /16 deterministically."""
    block = (_hash_int(rack_id, "ipblock") % 200) + 10
    host = (_hash_int(dev_name, "iphost") % 240) + 10
    u = max(0, min(255, int(u or 0)))
    return f"10.{block}.{u}.{host}"

def synth_serial(rack_id: str, dev_name: str, prefix: str) -> str:
    return f"{prefix}-{_hash_int(rack_id, dev_name, 'serial') % 1_000_000:06d}"


# ─────────────────────────────────────────────────────────────────────────────
# Per-class catalogues — plausible-looking models so the topology view reads
# as a credible rack to a casual viewer.
# ─────────────────────────────────────────────────────────────────────────────

SWITCH_MODELS = [
    "Catalyst 2960X-24",
    "Catalyst 9300-48P",
    "Catalyst 9300-48UN",
    "Catalyst 9200-24T",
    "Catalyst 9200L-48P-4G",
]
PATCH_PANEL_MODELS = [
    "Panduit DP24584TGY",
    "Panduit DP18584TGY",
    "Panduit FP6X10ATY",
    "Leviton 49255-H24",
]
SERVER_MODELS = [
    "Dell PowerEdge R750",
    "HPE ProLiant DL380 Gen10",
    "Dell PowerEdge R650",
    "Lenovo ThinkSystem SR650",
]

SYNTH_TAG = "synthetic_data=true"   # marker used in CMDB `comments` / topology snapshot


# ─────────────────────────────────────────────────────────────────────────────
# Class-specific synthesizers — produce the same dict shape the curated
# overrides use, so downstream code is uniform.
# ─────────────────────────────────────────────────────────────────────────────

def synthesize_switch(rack_id: str, name: str, u: int, scan_dev: dict) -> dict:
    main = int(scan_dev.get("port_count") or 0)
    sfp_list = scan_dev.get("sfp_ports") or []
    sfp = len(sfp_list) if isinstance(sfp_list, list) else int(sfp_list or 0)
    return {
        "_synthetic": True,
        "_synthetic_fields": ["model_number", "serial_number", "mgmt_ip", "mac", "os", "port_prefix"],
        "model_number":   _pick(rack_id, name, SWITCH_MODELS, "switch_model"),
        "serial_number":  synth_serial(rack_id, name, "AUTOSW"),
        "mgmt_ip":        synth_ip(rack_id, name, u),
        "mac":            synth_mac(rack_id, name),
        "os":             "IOS-XE 17.09.03",
        "ports":          main,
        "sfp_ports":      sfp,
        "port_prefix":    "Gi0/" if main < 30 else "Gi1/0/",
        "short_description": (
            f"Auto-generated switch CI from scan; main={main} sfp={sfp}; {SYNTH_TAG}"
        ),
    }

def synthesize_patch_panel(rack_id: str, name: str, scan_dev: dict) -> dict:
    main = int(scan_dev.get("port_count") or 0)
    return {
        "_synthetic": True,
        "_synthetic_fields": ["model_number", "serial_number"],
        "model_number":  _pick(rack_id, name, PATCH_PANEL_MODELS, "panel_model"),
        "serial_number": synth_serial(rack_id, name, "AUTOPP"),
        "ports":         main,
        "short_description": f"Auto-generated patch panel CI from scan; ports={main}; {SYNTH_TAG}",
    }

def synthesize_server(rack_id: str, name: str, u: int, scan_dev: dict) -> dict:
    gateway = synth_ip(rack_id, "rack-gateway", 1)
    return {
        "_synthetic": True,
        "_synthetic_fields": ["model_number", "serial_number", "os", "cpu_name",
                              "cpu_count", "cpu_core_count", "ram", "nics", "disks"],
        "name": name,
        "meta": {
            "model_number":  _pick(rack_id, name, SERVER_MODELS, "server_model"),
            "serial_number": synth_serial(rack_id, name, "AUTOSRV"),
            "os":            "Ubuntu 22.04 LTS",
            "cpu_name":      "Intel Xeon Silver 4314",
            "cpu_count":     "2",
            "cpu_core_count":"24",
            "ram":           "131072",
            "short_description": f"Auto-generated server CI from scan; {SYNTH_TAG}",
            "comments":      f"{SYNTH_TAG}; provenance=synth",
        },
        "nics": [
            {
                "name": f"{name}:eth0", "alias": "eth0",
                "mac":  synth_mac(rack_id, f"{name}:eth0"),
                "ip":   synth_ip(rack_id, f"{name}:eth0", u),
                "netmask": "255.255.255.0",
                "gateway": gateway,
                "fqdn": f"{name.lower()}.auto.dark",
                "short_description": f"vlan=10 mode=access speed=1000M oper=up admin=up; {SYNTH_TAG}",
            },
            {
                "name": f"{name}:eth1", "alias": "eth1",
                "mac":  synth_mac(rack_id, f"{name}:eth1"),
                "ip":   synth_ip(rack_id, f"{name}:eth1", u),
                "netmask": "255.255.255.0",
                "gateway": gateway,
                "fqdn": f"{name.lower()}-mgmt.auto.dark",
                "short_description": f"vlan=99 mgmt; {SYNTH_TAG}",
            },
        ],
        "disks": [
            {
                "name": f"{name}:/dev/sda",
                "size_bytes": "500107862016",
                "short_description": f"Auto-generated boot drive; {SYNTH_TAG}",
                "partitions": [
                    {"name": "/boot", "partition_number": "1", "size_bytes": "1073741824",
                     "short_description": f"fs=ext4; {SYNTH_TAG}"},
                    {"name": "/",     "partition_number": "2", "size_bytes": "499034120192",
                     "short_description": f"fs=ext4; {SYNTH_TAG}"},
                ],
            },
        ],
    }

def synthesize_agg_core(rack_id: str) -> dict:
    name = f"AGG-CORE-{_hash_int(rack_id, 'agg') % 100:02d}"
    return {
        "_synthetic": True,
        "_synthetic_fields": ["all"],
        "name":          name,
        "model_number":  "Catalyst 9500-32C",
        "serial_number": synth_serial(rack_id, name, "AUTOAGG"),
        "mgmt_ip":       synth_ip(rack_id, "agg-core", 1),
        "mac":           synth_mac(rack_id, "agg-core"),
        "os":            "IOS-XE 17.12.01",
        "ports":         32,
        "sfp_ports":     0,
        "port_prefix":   "Up",
        "short_description": (
            f"Adjacent-rack aggregation switch (auto-generated for {rack_id}); {SYNTH_TAG}"
        ),
    }

def synthesize_rack_meta(rack_id: str, rack_name: str) -> dict:
    return {
        "_synthetic": True,
        "asset_tag":     f"AT-{rack_name}",
        "serial_number": synth_serial(rack_id, "rack-chassis", "AUTORACK"),
        "short_description": f"Auto-bootstrapped rack from scan {rack_id}; {SYNTH_TAG}",
        "comments":      f"{SYNTH_TAG}; provenance=synth; rack_id={rack_id}",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Override loading — per-rack JSON file is the upgrade path. Anything in the
# override file wins over the synth values.
# ─────────────────────────────────────────────────────────────────────────────

def load_override(rack_id: str) -> dict:
    path = os.path.join(OVERRIDES_DIR, f"{rack_id}.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ─────────────────────────────────────────────────────────────────────────────
# Per-port detail loader. The scan model already detects which port indices
# are connected vs empty (with image bboxes) — we just have to read it.
#   device_unit_map.json carries:
#     devices[].box                  → device bbox in image pixels
#     devices[].connected_ports[]    → list of {index, box, center, status}
#       (box/center are device-local; add device.box[0]/[1] for image-global)
#     devices[].sfp_ports[]          → list of dicts (sometimes), or count
# Returns a dict keyed by CMDB name (SW-Uxx, PP-Uxx, SRV-Uxx) so callers can
# merge into the synth inventory without re-deriving names.
# ─────────────────────────────────────────────────────────────────────────────

def _u_from_units_list(units: list) -> int | None:
    for u_str in units or []:
        m = re.match(r"u0*(\d+)", str(u_str).lower())
        if m:
            return int(m.group(1))
    return None

def load_port_detail(rack_dir: str) -> dict[str, dict]:
    path = os.path.join(rack_dir, "device_unit_map.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        m = json.load(f)

    out: dict[str, dict] = {}
    for d in m.get("devices") or []:
        cls = d.get("class_name")
        u = _u_from_units_list(d.get("units") or [])
        if u is None:
            continue
        if cls == "Switch":       name = f"SW-U{u:02d}"
        elif cls == "Patch Panel": name = f"PP-U{u:02d}"
        elif cls == "Server":      name = f"SRV-U{u:02d}"
        else:                      continue

        dbox = d.get("box") or [0, 0, 0, 0]
        try:
            dx0, dy0 = int(dbox[0]), int(dbox[1])
        except Exception:
            dx0, dy0 = 0, 0

        connected: list[int] = []
        port_global_x: dict[int, int] = {}
        port_global_y: dict[int, int] = {}
        for p in d.get("connected_ports") or []:
            if not isinstance(p, dict):
                continue
            idx = p.get("index")
            if not isinstance(idx, int):
                continue
            connected.append(idx)
            cx, cy = (p.get("center") or [0, 0])[:2]
            port_global_x[idx] = dx0 + int(cx)
            port_global_y[idx] = dy0 + int(cy)
        connected.sort()

        # sfp_ports may be a list of dicts (with status) or just a count.
        sfp_connected: list[int] = []
        sfp_field = d.get("sfp_ports")
        if isinstance(sfp_field, list):
            for p in sfp_field:
                if isinstance(p, dict) and p.get("status") == "connected":
                    idx = p.get("index")
                    if isinstance(idx, int):
                        sfp_connected.append(idx)
        sfp_connected.sort()

        port_count = int(d.get("port_count") or 0)
        connected_set = set(connected)
        empty = [i for i in range(1, port_count + 1) if i not in connected_set]

        out[name] = {
            "connected_indices":     connected,
            "empty_indices":         empty,
            "sfp_connected_indices": sfp_connected,
            "port_global_x":         port_global_x,
            "port_global_y":         port_global_y,
            "device_box":            dbox,
            "scan_port_count":       port_count,
        }
    return out


def merge_port_detail(inv: dict, detail: dict[str, dict]) -> None:
    """Attach port_detail to each switch / panel entry of the inventory in-place."""
    for name, sw in (inv.get("switches") or {}).items():
        d = detail.get(name)
        if d:
            sw["_port_detail"] = d
    for name, pp in (inv.get("panels") or {}).items():
        d = detail.get(name)
        if d:
            pp["_port_detail"] = d


# ─────────────────────────────────────────────────────────────────────────────
# Scan-device → CMDB-name mapping. Every detected switch/panel/server gets a
# stable name keyed off its U-position so re-runs hit the same CIs.
# ─────────────────────────────────────────────────────────────────────────────

def _u_from_position(position: str) -> int | None:
    if not position:
        return None
    m = re.match(r"U(\d{2})", position)
    return int(m.group(1)) if m else None

def cmdb_name_for(scan_dev: dict) -> tuple[str | None, int | None]:
    cls = scan_dev.get("class_name")
    u = _u_from_position(scan_dev.get("position", ""))
    if u is None:
        return None, None
    if cls == "Switch":       return f"SW-U{u:02d}", u
    if cls == "Patch Panel":  return f"PP-U{u:02d}", u
    if cls == "Server":       return f"SRV-U{u:02d}", u
    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# Build the full inventory dict from scan + override.
# Returns a structure suitable for both topology_generate.py and the CMDB push.
# ─────────────────────────────────────────────────────────────────────────────

def build_inventory(rack_id: str, scan: dict, override: dict | None = None) -> dict:
    override = override or {}
    over_switches    = (override.get("switches") or {})
    over_panels      = (override.get("patch_panels") or {})
    over_server      = override.get("server")
    over_agg         = override.get("agg_core")
    rack_name        = override.get("rack_name") or f"RACK-{rack_id}"
    rack_meta        = override.get("rack_meta") or synthesize_rack_meta(rack_id, rack_name)
    u_size           = override.get("u_size") or _u_size_from_scan(scan) or 18

    switches: dict[str, dict] = {}
    panels:   dict[str, dict] = {}
    server:   dict | None     = None

    for d in scan.get("devices") or []:
        name, u = cmdb_name_for(d)
        if not name:
            continue
        d["_cmdb_name"] = name
        d["_u"] = u
        cls = d.get("class_name")
        if cls == "Switch":
            ov = over_switches.get(name)
            switches[name] = ov if ov else synthesize_switch(rack_id, name, u, d)
        elif cls == "Patch Panel":
            ov = over_panels.get(name)
            panels[name] = ov if ov else synthesize_patch_panel(rack_id, name, d)
        elif cls == "Server":
            # Only one server slot in our model; first wins.
            if server is None:
                server = over_server if over_server else synthesize_server(rack_id, name, u, d)

    # If override declares a server but scan doesn't, still include it
    # (curated rack model > scan visibility).
    if server is None and over_server:
        server = over_server

    # If override has switches/panels keyed to U-positions the scan classified
    # as something else (e.g. SW-U07 marked "Unidentified" in scan), include
    # them — the override is the source of truth in that conflict.
    for name, ov in over_switches.items():
        if name not in switches:
            switches[name] = ov
    for name, ov in over_panels.items():
        if name not in panels:
            panels[name] = ov

    agg_core = over_agg if over_agg else synthesize_agg_core(rack_id)
    return {
        "rack_id":   rack_id,
        "rack_name": rack_name,
        "rack_meta": rack_meta,
        "u_size":    u_size,
        "switches":  switches,
        "panels":    panels,
        "server":    server,
        "agg_core":  agg_core,
    }
