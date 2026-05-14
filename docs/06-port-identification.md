# 06. Port Identification — counting and classifying ports

## What it does (junior view)

For every switch found in the rack photo, a separate computer-vision
model looks at just that switch's front panel and figures out:

- **How many ports it has** (24, 48, 8, etc.)
- **Where each port sits** on the chassis (X/Y coordinates)
- **What kind of port** each one is — RJ45 (copper, the typical
  ethernet jack) vs SFP (the slot that takes a transceiver for
  fiber or DAC cables)

This information goes into the device record so the rest of the app
can:
- Show the user "this switch has 24 ports + 2 SFP cages"
- Pick the right SFP recommendations (you can't suggest fiber
  modules for a switch that has no SFP slots — see
  [12-sfp-advisor.md](12-sfp-advisor.md))
- Tell the SSH probe what to expect (a 24-port switch should report
  24 interfaces from `show interface status`)
- Highlight a specific port when the user wants to see "where is
  port 15 physically?"

The user also has a separate flow where they can tap a port on a
detected switch and the app draws a circle around it on the original
photo. That's the "select device + port" flow — used when a
ServiceNow ticket says "go look at port 15 on switch X" and the
field engineer wants the exact location.

## What it doesn't do well

- **PoE ports vs non-PoE ports.** They look identical from the
  outside. The model can't tell.
- **Port speed (1G vs 10G).** Same chassis can have mixed speeds
  on identical-looking cages. Resolved later via the SSH probe.
- **Hidden ports.** A patch cable plugged into port 15 hides port
  15. The CV model sees the cable end, not the cage. Detected
  ports tend to skew toward "free" ports because those are
  visually clearer.

---

## Technical detail (lead view)

### Two related but separate models

| Model | File | Job |
|---|---|---|
| Port counter | `Models/port_count.pt` | YOLO; runs on a chassis crop, outputs bboxes per detected port |
| Port identifier | `Models/port_identify.pth` (legacy, gitignored) | Older classifier — RJ45 vs SFP — mostly superseded |

The active path uses `port_count.pt` only. The output bboxes are
geometrically clustered by Y-coordinate to identify rows, and by
X-spacing to identify SFP cages (which are wider-pitch than RJ45).

### When port detection runs

Three paths invoke it:

1. **At analyze time** — `pipeline/runner.py` runs `port_count`
   on every chassis bbox during the standard scan. The result
   lands inline in `device_unit_map.json` per device:

   ```json
   "port_count": 24,
   "ports": [{"name": "1", "label": "1", "kind": "rj45", "bbox": [...], "connected": false}, ...],
   "sfp_ports": [{"name": "S1", "label": "S1", "kind": "sfp", "bbox": [...]}, ...]
   ```

2. **On-demand via `/api/select`** — when the user picks a device
   in the UI and asks for a specific port to be highlighted.
   `pipeline.runner` is invoked with `--device_index N --port M`,
   producing `selected_device.png` and `selected_device_ports.png`
   debug images.

3. **Re-detection via `pipeline.redetect_ports`** — used to
   re-run port detection on an existing scan when the user
   suspects the original count was wrong. Updates `device_unit_map.json`
   in place.

### Counting heuristic

`pipeline/port.py` (loaded via `pipeline.runner`):

```python
# 1. Run port_count YOLO on chassis crop
ports = run_port_model(chassis_crop, ports_conf=0.23)

# 2. Cluster by Y-coordinate to find rows
rows = cluster_by_y(ports, max_y_gap=20)

# 3. Sort each row left-to-right
for row in rows:
    row.sort(key=lambda p: p.x)

# 4. Detect SFP cages: wider pitch + slightly different aspect ratio
sfp_indices = detect_sfp_cages(rows)

# 5. Number ports 1..N (RJ45) and S1..SN (SFP) using the
#    typical vendor convention (RJ45 first, SFP last)
```

The ports-conf threshold (`0.23`) is in `config.json`. It's
deliberately a bit loose — if a port is partially obscured by a
plugged-in cable, the model's confidence drops, but we still want
to count it.

### `ensurePortCounts(rackId)` (server-side patcher)

`server/app.js:~280` (helper). After analyze, before the canonical
scan-result JSON gets written, this runs `pipeline.redetect_ports`
on devices whose `port_count` looks wrong (zero, or
suspiciously-low for the chassis size). It's a safety net for the
cache-hit path: if an older scan had bad port detection, opening
that scan today re-runs port detection but not the heavy CV
pipeline.

### Port-pattern (deterministic refinement)

`pipeline/port_pattern.py` — applies vendor-specific knowledge to
clean up the YOLO output. Examples:

- **TP-Link 1/0/N convention.** If the OCR text on the chassis
  matches a TP-Link, port labels become `1/0/1`..`1/0/24`.
  Required for the SSH-probe interface-name match later.
- **Cisco short labels.** `Gi1/0/1`, `Te1/0/1`. The pattern
  module knows the prefix-by-port-position rules.
- **MikroTik SFP+ designations.** SFP cages on a CRS328 are
  labelled `sfp+1`..`sfp+4`, not `S1`..`S4`.

`port_pattern.shortLabel(iface)` is the inverse — given a full
interface name, return the short number to display in the UI.
There's a JS mirror at `client/src/pages/PortsPage.jsx:73`
(`shortLabel`) — the two should stay in sync.

### Port classification (RJ45 vs SFP)

Three signals, in priority order:

1. **The switch tells us the medium.** TP-Link's
   `show interface status` includes an `Active-Medium` column
   (`copper`/`fiber`). When present, that's authoritative.
2. **Cisco-style interface naming.** Anything starting with `Te`,
   `Fo`, `Hu` is SFP+ / QSFP / QSFP28. Anything starting with `Gi`
   or `Fa` is copper.
3. **CV port count + SFP count from `device_unit_map.json`.** If
   the switch has 24 RJ45 + 4 SFP, the last 4 entries from the
   SSH probe are SFP.

Logic lives in `client/src/pages/PortsPage.jsx:18` (`classifyPorts`)
which combines probe data + scan data into the final classification
shown in the Available Ports tab.

### `device.ports[]` schema

Each port object emitted by the CV pipeline:

```json
{
  "name": "1",          // canonical name (matches probe iface short)
  "label": "1",         // display label
  "kind": "rj45",       // "rj45" | "sfp" | "nic"
  "bbox": [x1,y1,x2,y2], // pixel coords inside the chassis crop
  "connected": false,    // CV-inferred (cable visible)
  "is_uplink": false     // heuristic; true for the rightmost SFP cages
}
```

The `connected` flag is heuristic — it's based on whether a cable
end is visible at the port's location. Not reliable; the SSH probe
([11-available-ports.md](11-available-ports.md)) is authoritative
for connection state.

### The "highlight port N" flow

`POST /api/select` (`server/app.js:~1542`) is what the UI calls
when a user taps a device + port in the results page or follows
a ServiceNow ticket link. It:

1. Reads `scan_meta.json` to find the original image path.
2. Spawns `pipeline.runner --image <path> --device_index N --port M`.
3. The runner writes `selected_device.png` (chassis crop with the
   port highlighted) and `selected_device_ports.png` (port detail).
4. Returns paths the UI can render.

This is the "physical wayfinding" feature: a tech in the rack room
sees a circle drawn on the photo at the exact port.

### Performance

Port detection runtime is dominated by the YOLO inference. On
CPU, a 24-port switch crop takes ~200-400ms. Across all
detected switches in a rack (typically 3-6), total port-detection
overhead is 1-3s on top of the device-detection pass.

### Files in this feature

| File | Role |
|---|---|
| `pipeline/runner.py` | Drives port detection per device during analyze |
| `pipeline/port.py` | Port-count YOLO + row clustering + SFP cage detection |
| `pipeline/port_pattern.py` | Vendor-aware port naming (TP-Link 1/0/N, Cisco Gi/Te) |
| `pipeline/redetect_ports.py` | Re-run port detection on an existing scan |
| `pipeline/selection.py` | Highlight-a-port image generation |
| `Models/port_count.pt` | YOLO port-detection weights |
| `client/src/pages/PortsPage.jsx:18, 73` | `classifyPorts`, `shortLabel` (must stay in sync with Python) |
| `server/app.js:1542 /api/select` | The highlight-a-port endpoint |
