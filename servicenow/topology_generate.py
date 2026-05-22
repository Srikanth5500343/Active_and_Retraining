"""
Auto-generate topology.json for any rack from its scan_result.json.

Usage:
    python topology_generate.py --rack-id RK-XXXXX

Produces outputs/<rackId>/topology.json — the snapshot the topology view
fetches via /api/topology/:rackId. Pure file I/O, no ServiceNow API calls,
so it's safe to run on every scan.

Inventory is built from synth.py:
  - real values from servicenow/overrides/<rackId>.json (if present)
  - synthesized deterministic dummy values for everything else (model strings,
    MACs, IPs, AGG-CORE, individual cable wiring)

If the rack already has a hand-curated override file, those values win — so
RK-00A187E2 keeps its existing model strings + cable IDs after this script
runs. New racks get fully-synthesized but plausible topologies.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from synth import build_inventory, load_override, load_port_detail, merge_port_detail, SYNTH_TAG

OUTPUTS_BASE = os.path.normpath(os.path.join(HERE, "..", "outputs"))


# ─────────────────────────────────────────────────────────────────────────────
# Cable wiring derivation — same logic as bootstrap_cmdb_full.py but scoped to
# the inventory dict produced by synth.build_inventory(). Deterministic given
# the same scan + inventory.
# ─────────────────────────────────────────────────────────────────────────────

def derive_wiring(scan: dict, inv: dict) -> list[tuple]:
    """Return list of (src_dev, src_port, dst_dev, dst_port, cable_id, cable_type, length).

    Cable endpoints come from per-port detection in device_unit_map.json:
      - Only ports detected as "connected" get a cable.
      - Switch→panel pairs are matched by image-x alignment when bbox data
        exists (cables typically run vertically, so smallest |Δx| is the most
        likely physical peer).
      - When no bbox data is available we fall back to first-N-connected
        order and U-distance pairing (the old synthetic behaviour).
    """
    switches  = inv["switches"]
    panels    = inv["panels"]
    server    = inv["server"]
    agg_core  = inv["agg_core"]
    agg_name  = agg_core["name"]

    def _u(name: str) -> int:
        return int(name.split("-U")[1])

    # Connected indices per device — from per-port detection, not just count.
    def _connected_main(name: str, kind: str) -> list[int]:
        host = switches.get(name) if kind == "switch" else panels.get(name)
        if not host:
            return []
        det = host.get("_port_detail") or {}
        idxs = list(det.get("connected_indices") or [])
        cap = (int(host.get("ports") or 0)
               + (int(host.get("sfp_ports") or 0) if kind == "switch" else 0))
        idxs = [i for i in idxs if 1 <= i <= cap]
        if idxs:
            return idxs
        # Fallback: scan only gave us a count, not specific indices.
        # Use the integer count from scan_result.json devices[].connected_ports.
        by_u: dict[int, dict] = {}
        for d in scan.get("devices") or []:
            m = re.match(r"U(\d{2})", d.get("position", ""))
            if m:
                by_u[int(m.group(1))] = d
        d = by_u.get(_u(name))
        n = int(d.get("connected_ports") or 0) if d else 0
        return list(range(1, min(n, cap) + 1))

    sw_connected: dict[str, list[int]] = {sw: _connected_main(sw, "switch") for sw in switches}
    pp_connected: dict[str, list[int]] = {pp: _connected_main(pp, "panel")  for pp in panels}

    used: dict[str, set] = {n: set() for n in list(switches) + list(panels) + [agg_name]}

    def total_ports(name: str) -> int:
        if name in switches:
            return int(switches[name].get("ports") or 0) + int(switches[name].get("sfp_ports") or 0)
        if name in panels:
            return int(panels[name].get("ports") or 0)
        if name == agg_name:
            return int(agg_core.get("ports") or 0) + int(agg_core.get("sfp_ports") or 0)
        return 0

    def alloc_from(name: str, candidates: list[int]) -> int | None:
        """Pick the first unused port from the candidate list."""
        for i in candidates:
            if i not in used[name]:
                used[name].add(i)
                return i
        return None

    def alloc_any(name: str, prefer: int | None = None) -> int:
        cap = total_ports(name)
        if prefer is not None and prefer not in used[name] and 1 <= prefer <= cap:
            used[name].add(prefer)
            return prefer
        for i in range(1, cap + 1):
            if i not in used[name]:
                used[name].add(i)
                return i
        raise RuntimeError(f"out of ports on {name} (cap={cap})")

    def port_label(device: str, port_num: int) -> str:
        if device in switches:
            prefix = switches[device].get("port_prefix") or "p"
            return f"{device}:{prefix}{port_num}" if prefix else f"{device}:p{port_num}"
        if device in panels:
            return f"{device}:Port{port_num}"
        if device == agg_name:
            prefix = agg_core.get("port_prefix") or "Up"
            return f"{device}:{prefix}{port_num}"
        raise ValueError(f"unknown device {device}")

    def port_x(device: str, port_num: int) -> int | None:
        host = switches.get(device) or panels.get(device)
        if not host:
            return None
        det = host.get("_port_detail") or {}
        gx = det.get("port_global_x") or {}
        return gx.get(port_num)

    cables: list[tuple] = []
    counter = [200]
    def next_cable_id() -> str:
        counter[0] += 1
        return f"C-{counter[0]:04d}"

    # ─── 1. Uplinks: top SFP/uplink ports per active switch fan up to AGG-CORE.
    UPLINKS_PER_SW = 4
    active_switches = sorted(
        [sw for sw, idxs in sw_connected.items() if idxs],
        key=lambda n: -_u(n),
    )
    for sw in active_switches:
        # Prefer the *highest-numbered* connected ports as uplinks (they map
        # to SFP cages on most switches we model).
        uplink_candidates = sorted(sw_connected[sw], reverse=True)
        for _ in range(min(UPLINKS_PER_SW, len(sw_connected[sw]))):
            sp = alloc_from(sw, uplink_candidates)
            if sp is None:
                break
            ap = alloc_any(agg_name)
            cables.append((sw, port_label(sw, sp), agg_name, port_label(agg_name, ap),
                           next_cable_id(), "Cat6a", "5m"))

    # ─── 2. RK-00A187E2 demo chains (preserved storyline for that scan).
    if server and "SW-U10" in switches and "PP-U08" in panels \
       and len(sw_connected.get("SW-U10", [])) >= 5:
        sp = alloc_any("SW-U10", prefer=12)
        pp = alloc_any("PP-U08", prefer=12)
        cables.append(("SW-U10", port_label("SW-U10", sp),
                       "PP-U08", port_label("PP-U08", pp),
                       "C-0142", "Cat6a", "2m"))
        cables.append(("PP-U08", port_label("PP-U08", pp),
                       server["name"], f"{server['name']}:eth0",
                       "C-0143", "Cat6a", "3m"))

    if server and "SW-U02" in switches and "PP-U06" in panels \
       and len(sw_connected.get("SW-U02", [])) >= 5:
        sp = alloc_any("SW-U02", prefer=5)
        pp = alloc_any("PP-U06", prefer=5)
        cables.append(("SW-U02", port_label("SW-U02", sp),
                       "PP-U06", port_label("PP-U06", pp),
                       "C-0144", "Cat6a", "2m"))
        cables.append(("PP-U06", port_label("PP-U06", pp),
                       server["name"], f"{server['name']}:eth1",
                       "C-0145", "Cat6a", "3m"))

    # ─── 3. Pair remaining connected switch ports with connected patch-panel
    # ports. Strategy: per (switch, panel) sorted by U-distance, take all
    # remaining connected switch ports; for each, pick the panel port whose
    # image-x is closest (cables run vertically, so |Δx| ≈ cable straightness).
    # Falls back to U-order pairing if bbox data is missing.
    def _remaining(host_name: str, idxs: list[int]) -> list[int]:
        return [i for i in idxs if i not in used[host_name]]

    for sw in active_switches:
        sw_u = _u(sw)
        # Active panels = those still with at least one unused connected port.
        active_pps = sorted(
            [pp for pp in panels if _remaining(pp, pp_connected.get(pp, []))],
            key=lambda n: abs(_u(n) - sw_u),
        )
        for pp in active_pps:
            while True:
                sw_left = _remaining(sw, sw_connected[sw])
                pp_left = _remaining(pp, pp_connected[pp])
                if not sw_left or not pp_left:
                    break
                sp = sw_left[0]                        # next available switch port
                spx = port_x(sw, sp)
                if spx is not None:
                    # Pick panel port with closest pixel-x — that's the cable
                    # most likely to be running straight up between them.
                    pp_left.sort(key=lambda i: abs((port_x(pp, i) or 0) - spx))
                pp_p = pp_left[0]
                used[sw].add(sp)
                used[pp].add(pp_p)
                length = f"{1 + ((sp + pp_p) % 5)}m"
                cables.append((sw, port_label(sw, sp), pp, port_label(pp, pp_p),
                               next_cable_id(), "Cat6a", length))

    # ─── 4. Switches with leftover connected ports (no panel free) — overflow
    # uplinks to AGG-CORE. Stop when AGG-CORE runs out — leftover switch
    # ports just stay unwired (no realistic peer is known).
    agg_cap = total_ports(agg_name)
    for sw in active_switches:
        for sp in _remaining(sw, sw_connected[sw]):
            if len(used[agg_name]) >= agg_cap:
                break
            used[sw].add(sp)
            ap = alloc_any(agg_name)
            cables.append((sw, port_label(sw, sp), agg_name, port_label(agg_name, ap),
                           next_cable_id(), "Cat6a", "5m"))
        if len(used[agg_name]) >= agg_cap:
            break

    return cables


# ─────────────────────────────────────────────────────────────────────────────
# Topology snapshot writer (same schema as before, generalised over inv).
# ─────────────────────────────────────────────────────────────────────────────

def _is_synth(d: dict) -> bool:
    return bool(d.get("_synthetic"))

def write_topology_snapshot(scan: dict, inv: dict, cables: list[tuple], output_dir: str) -> dict:
    rack_id   = inv["rack_id"]
    rack_name = inv["rack_name"]
    u_size    = int(inv.get("u_size") or 18)
    switches  = inv["switches"]
    panels    = inv["panels"]
    server    = inv["server"]
    agg_core  = inv["agg_core"]
    agg_name  = agg_core["name"]

    devices: list[dict] = []

    # Switches in rack
    for sw_name, details in switches.items():
        u = int(sw_name.split("-U")[1])
        total = int(details.get("ports") or 0) + int(details.get("sfp_ports") or 0)
        prefix = details.get("port_prefix") or ""
        det = details.get("_port_detail") or {}
        connected_set = set(det.get("connected_indices") or [])
        sfp_connected_set = set(det.get("sfp_connected_indices") or [])
        has_detection = bool(connected_set or det)
        ports = []
        for i in range(1, total + 1):
            is_sfp = i > int(details.get("ports") or 0)
            sfp_idx = i - int(details.get("ports") or 0) if is_sfp else None
            if has_detection:
                if is_sfp:
                    is_connected = sfp_idx in sfp_connected_set
                else:
                    is_connected = i in connected_set
            else:
                is_connected = True  # no per-port data — assume populated
            ports.append({
                "name":  f"{sw_name}:{prefix}{i}" if prefix else f"{sw_name}:p{i}",
                "label": f"{prefix}{i}" if prefix else f"p{i}",
                "kind":  "sfp" if is_sfp else "main",
                "is_uplink": i >= total - 1 and total > 0,
                "connected": is_connected,
            })
        devices.append({
            "name":       sw_name,
            "class":      "switch",
            "u_position": u,
            "u_size":     1,
            "model":      details.get("model_number"),
            "mgmt_ip":    details.get("mgmt_ip"),
            "in_rack":    True,
            "synthetic":  _is_synth(details),
            "ports":      ports,
            "summary":    f"{total} port{'s' if total != 1 else ''}" if total else "no ports detected",
        })

    # Patch panels
    for pp_name, details in panels.items():
        u = int(pp_name.split("-U")[1])
        nports = int(details.get("ports") or 0)
        det = details.get("_port_detail") or {}
        connected_set = set(det.get("connected_indices") or [])
        has_detection = bool(connected_set or det)
        ports = [
            {
                "name":  f"{pp_name}:Port{i}",
                "label": f"Port{i}",
                "kind":  "main",
                "is_uplink": False,
                "connected": (i in connected_set) if has_detection else True,
            }
            for i in range(1, nports + 1)
        ]
        devices.append({
            "name":       pp_name,
            "class":      "patch_panel",
            "u_position": u,
            "u_size":     1,
            "model":      details.get("model_number"),
            "mgmt_ip":    None,
            "in_rack":    True,
            "synthetic":  _is_synth(details),
            "ports":      ports,
            "summary":    f"{nports} ports",
        })

    # Server (optional)
    if server:
        nics = server.get("nics") or []
        server_ports = [
            {
                "name": nic["name"],
                "label": nic.get("alias") or nic["name"],
                "kind": "nic",
                "is_uplink": False,
                "connected": True,
            }
            for nic in nics
        ]
        # First NIC's IP is shown as the device's mgmt_ip in the topology view
        mgmt_ip = nics[0]["ip"] if nics else None
        # Server's u_position: prefer scan-derived if available, else 1
        srv_u = 1
        for d in scan.get("devices") or []:
            if d.get("class_name") == "Server":
                m = re.match(r"U(\d{2})", d.get("position", ""))
                if m:
                    srv_u = int(m.group(1))
                    break
        devices.append({
            "name":       server["name"],
            "class":      "server",
            "u_position": srv_u,
            "u_size":     1,
            "model":      (server.get("meta") or {}).get("model_number"),
            "mgmt_ip":    mgmt_ip,
            "in_rack":    True,
            "synthetic":  _is_synth(server),
            "ports":      server_ports,
            "summary":    f"{(server.get('meta') or {}).get('model_number') or 'Server'} — {len(nics)} NIC{'s' if len(nics) != 1 else ''}",
            "extras": {
                "disks": [
                    {
                        "name": d["name"],
                        "size_bytes": d.get("size_bytes"),
                        "partitions": [{"name": p["name"], "size_bytes": p.get("size_bytes")}
                                       for p in (d.get("partitions") or [])],
                    }
                    for d in (server.get("disks") or [])
                ],
            },
        })

    # Closed units / Unidentified — visual placeholders so the rack reads at correct U size
    occupied_u = {d["u_position"] for d in devices if d.get("u_position") is not None}
    for d in scan.get("devices") or []:
        if d.get("class_name") in ("Closed Unit", "Unidentified"):
            m = re.match(r"U(\d{2})", d.get("position", ""))
            if not m:
                continue
            u = int(m.group(1))
            if u in occupied_u:
                continue
            klass = "closed_unit" if d["class_name"] == "Closed Unit" else "unidentified"
            devices.append({
                "name":       d.get("label") or f"U{u:02d}",
                "class":      klass,
                "u_position": u,
                "u_size":     1,
                "model":      None,
                "mgmt_ip":    None,
                "in_rack":    True,
                "synthetic":  False,
                "ports":      [],
                "summary":    d["class_name"],
            })

    # AGG-CORE (out of rack)
    agg_total = int(agg_core.get("ports") or 0) + int(agg_core.get("sfp_ports") or 0)
    agg_prefix = agg_core.get("port_prefix") or "Up"
    agg_ports = [
        {"name":  f"{agg_name}:{agg_prefix}{i}",
         "label": f"{agg_prefix}{i}",
         "kind":  "uplink",
         "is_uplink": True,
         "connected": True}
        for i in range(1, agg_total + 1)
    ]
    devices.append({
        "name":       agg_name,
        "class":      "switch",
        "u_position": None,
        "u_size":     None,
        "model":      agg_core.get("model_number"),
        "mgmt_ip":    agg_core.get("mgmt_ip"),
        "in_rack":    False,
        "synthetic":  _is_synth(agg_core),
        "ports":      agg_ports,
        "summary":    "Adjacent-rack aggregation switch",
    })

    edges = [
        {
            "src": {"device": src_d, "port": src_p},
            "dst": {"device": dst_d, "port": dst_p},
            "cable_id":   cid,
            "cable_type": ctype,
            "length":     length,
        }
        for src_d, src_p, dst_d, dst_p, cid, ctype, length in cables
    ]

    snapshot = {
        "schema":       "topology.v1",
        "rackId":       rack_id,
        "rackName":     rack_name,
        "u_size":       u_size,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image":        scan.get("image"),
        "devices":      devices,
        "edges":        edges,
        "stats": {
            "device_count_in_rack": sum(1 for d in devices if d["in_rack"]),
            "edge_count":           len(edges),
            "synthetic_device_count": sum(1 for d in devices if d.get("synthetic")),
        },
    }

    out_path = os.path.join(output_dir, "topology.json")
    os.makedirs(output_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=2)
    return snapshot


# ─────────────────────────────────────────────────────────────────────────────
# Sidecar synthesis log — list of every device whose data is auto-generated,
# so a future "promote synthetic → real" script knows what to replace.
# ─────────────────────────────────────────────────────────────────────────────

def write_synthesis_log(inv: dict, output_dir: str) -> dict:
    log = {
        "rack_id":   inv["rack_id"],
        "rack_name": inv["rack_name"],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "marker":    SYNTH_TAG,
        "synthetic": [],
    }
    for name, sw in inv["switches"].items():
        if sw.get("_synthetic"):
            log["synthetic"].append({"name": name, "kind": "switch",
                                     "fields": sw.get("_synthetic_fields") or []})
    for name, pp in inv["panels"].items():
        if pp.get("_synthetic"):
            log["synthetic"].append({"name": name, "kind": "patch_panel",
                                     "fields": pp.get("_synthetic_fields") or []})
    if inv["server"] and inv["server"].get("_synthetic"):
        log["synthetic"].append({"name": inv["server"]["name"], "kind": "server",
                                 "fields": inv["server"].get("_synthetic_fields") or []})
    if inv["agg_core"].get("_synthetic"):
        log["synthetic"].append({"name": inv["agg_core"]["name"], "kind": "agg_core",
                                 "fields": inv["agg_core"].get("_synthetic_fields") or []})

    out_path = os.path.join(output_dir, "cmdb_synthesis.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2)
    return log


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="Generate topology.json for a scanned rack.")
    p.add_argument("--rack-id", required=True, help="Rack ID, e.g. RK-00A187E2")
    args = p.parse_args()

    rack_id = args.rack_id
    output_dir = os.path.join(OUTPUTS_BASE, rack_id)
    scan_path = os.path.join(output_dir, "scan_result.json")
    if not os.path.exists(scan_path):
        print(f"ERROR: no scan_result.json at {scan_path}", file=sys.stderr)
        return 1

    with open(scan_path, "r", encoding="utf-8") as f:
        scan = json.load(f)

    override = load_override(rack_id)
    inv = build_inventory(rack_id, scan, override)

    # Attach per-port connected/empty + bbox data from device_unit_map.json
    # so derive_wiring can place cables on real connected ports and pair by
    # image-x alignment.
    port_detail = load_port_detail(output_dir)
    merge_port_detail(inv, port_detail)

    # Size AGG-CORE to comfortably absorb every connected switch port that
    # isn't matched to a panel — the synthesised default of 32 ports is too
    # small for densely-cabled racks.
    agg = inv.get("agg_core") or {}
    sum_sw_connected = 0
    for sw in (inv.get("switches") or {}).values():
        det = sw.get("_port_detail") or {}
        sum_sw_connected += len(det.get("connected_indices") or [])
    if sum_sw_connected:
        # Round up to next 8 with a small safety margin.
        needed = sum_sw_connected + 4
        needed = ((needed + 7) // 8) * 8
        agg["ports"] = max(int(agg.get("ports") or 0), needed)

    cables = derive_wiring(scan, inv)
    snapshot = write_topology_snapshot(scan, inv, cables, output_dir)
    log = write_synthesis_log(inv, output_dir)

    n_synth = len(log["synthetic"])
    print(f"[topology] {rack_id} → {output_dir}/topology.json")
    print(f"  devices in rack: {snapshot['stats']['device_count_in_rack']}")
    print(f"  cables (edges):  {snapshot['stats']['edge_count']}")
    print(f"  synthetic CIs:   {n_synth} ({'override file present' if override else 'no override file — fully synthesized'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
