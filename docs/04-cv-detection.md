# 04. CV Detection — finding devices in the photo

## What it does (junior view)

Given a rack photo, computer vision draws boxes around each thing
inside it (each switch, server, patch panel, UPS, blank panel, etc.)
and labels each box with a class name and a U-position.

That sounds simple. The reasons it's hard:

- A 1080p rack photo can have **30+ rectangles** that look like
  network gear at a glance — including patch panels, blank
  filler panels, cable channels, UPS units, PDUs.
- Some chassis have an unusual face — the MikroTik CRS518 has a
  decorative wavy front, the HP MicroServer is a cube-shaped
  thing, NETGEAR ProSafe has a glossy blue plastic. A model
  trained on "switch = 1U with a row of square copper ports"
  misses these.
- Devices need to be matched to **rack-unit slots** (U1, U2, …) so
  the rest of the system has a position for them. This means
  detecting the U-rail numbers separately and intersecting their
  Y-coordinates with each device bbox.

The output of this stage feeds **everything else**: OCR runs on
each detected switch, port-detection runs on each detected switch,
topology uses positions to render the 3D rack, CMDB sync uses
positions and counts.

## What it doesn't do

- It doesn't read text. That's OCR (next doc).
- It doesn't decide whether a switch is "the same one" as a previously
  scanned one. That happens later, by serial number / position
  matching against the CMDB.
- It doesn't currently distinguish a real switch from a PoE injector
  or a media converter — both look 1U with ports and get classified
  as Switch.

---

## Technical detail (lead view)

### Models used (in order)

All weights live in `Models/` (gitignored as `.pt` files; ship in
the repo for now). Config is in `config.json` at the project root.

| Model | File | Job |
|---|---|---|
| Devices (general) | `Models/best 32.pt` | YOLO; classes incl. Switch, Router, Patch Panel, PDU, UPS, Storage Unit, Closed Unit, Empty, Unidentified |
| Devices (server class) | `Models/best 33.pt` | YOLO trained specifically on Server / blade-enclosure shapes; runs in parallel with the general model and IoU-deduped against it |
| Units | `Models/unit.pt` | YOLO; finds U-rail tick marks so we can label each device with its U-position |
| Port count | `Models/port_count.pt` | YOLO on a chassis crop; counts visible ports |
| Cable classifier | `Models/best_model_efficientnet.pth` | Image classifier; CAT/fiber/DAC label for visible cables |

There are extra weights in `Models/` (`Device_final.pt`, `Units.pt`,
`switch_patch.pt`, `port_identify.pth`) that are either historical
or used by tools other than the main pipeline.

### Pipeline entry point

`pipeline/runner.py:main()` — invoked as
`python -m pipeline.runner --image <path> --output_dir <outputs/<rackId>> [--detect_only]`.

Used by:
- `server/app.js` `runPipelineAnalyze()` for the standard scan path
- `pipeline/benchmark_full.py` for the per-device benchmark
- CLI for one-off debugging

### Two-stage device detection

`pipeline/runner.py:170-200`:

```python
# Primary: dual-model
devices = detect_devices_dual(rack_crop, server_model, device_model,
                              conf_server=0.25, conf_general=0.20,
                              iou_thresh=0.5)
primary_n = len(devices)

# Low-confidence retry pass (catches missed UPS / PDU / unusual chassis)
devices_low = detect_devices_dual(rack_crop, server_model, device_model,
                                  conf_server=0.08, conf_general=0.08,
                                  iou_thresh=0.5)
# Anything new (not IoU-overlapping a primary hit) gets tagged `+lowconf`
```

The low-confidence retry exists because the primary 0.20/0.25
threshold misses unusual chassis (CRS518, NETGEAR PoE switches).
Tagged hits are kept but their downstream weight is deliberately
lower (the OCR stage doesn't distinguish, but the topology layer
draws them with reduced confidence).

### Rack-bounds detection

`detect_rack_bounds(img)` in `pipeline/detection.py` runs Hough
line detection over the full image to find the leftmost and
rightmost vertical lines (the rack rails). If found, the device
detector runs only on the cropped rack region — this drops a lot
of cabinet-edge / wall noise.

If no rack rails are found, the full image is used as the "rack
crop". This happens when the user took a tight close-up where the
rails are out of frame.

### U-position mapping

`pipeline/runner.py:215-260` (approx). Steps:

1. Run `unit_model` on the rack crop. It produces bboxes for U-rail
   tick marks plus their associated U-number from the model's
   class labels.
2. Build an ordered list `[(U01, y1), (U02, y2), …]`.
3. For each device bbox, find the U-numbers whose Y-range
   intersects the device's Y-range. The device is tagged with the
   list of overlapping U-numbers (e.g. a 2U server might be `["U10",
   "U11"]`).

Result lands in `device_unit_map.json` per device:

```json
{
  "name": "Switch-1",
  "class_name": "Switch",
  "box": [x1, y1, x2, y2],
  "units": ["U10"],
  "u_position": "U10",
  "port_count": 24,
  "sfp_ports": [...],
  "low_conf": false
}
```

The `units_detected` array at the top level is the union of all
U-numbers found by the unit_model — used for the rack-banner
"U01-U15 / 15 units" subtitle.

### Output schema (`device_unit_map.json`)

```json
{
  "image_size": { "w": 4032, "h": 3024 },
  "rack_box": [120, 60, 3900, 2980],
  "u_size": 15,
  "units_detected": ["U01","U02",...,"U15"],
  "units_range": "U01-U15",
  "devices": [ <device objects above> ],
  "stats": {
    "device_count_total": 26,
    "device_count_in_rack": 17
  }
}
```

`device_count_total` includes `Closed Unit`, `Empty`, `Patch
Panel` etc. `device_count_in_rack` is the user-meaningful subset
(switches, servers, routers, etc.).

### Class taxonomy

Used everywhere downstream. Casing matters — these are the exact
strings the CV model emits.

```
Switch
Server
Router
Firewall
Aggregation Core
Patch Panel
PDU
UPS
Storage Unit
Closed Unit
Empty
Unidentified
```

Downstream filters reference these by exact match (e.g.
`OCR_CLASSES` in `ocr_devices.py`, the network-class filter in
`SwitchInformationPage.jsx`'s `useSwitchData`). If the class names
ever change, those filters break.

### Per-bbox port subdivision

After devices are detected, every bbox classified as `Switch` or
`Router` is fed to `port_count.pt` for port detection (see
[06-port-identification.md](06-port-identification.md)).
That model emits its own bboxes per port within the chassis crop;
those get attached to the device as `device.ports[]` and
`device.sfp_ports[]`.

### Honest accuracy

Per-device CV recall on the 12-image benchmark:

- Total devices CV emitted: **157** across 12 images
- Of those, classified as one of the OCR target classes (Switch /
  Server / Router / Firewall / Unidentified / Closed Unit): **108**
- Real switches present (manual ground truth): roughly **30**

So we're over-detecting at ~5× the true switch count. Most of the
extra are correctly-classified non-switches (patch panels, UPS,
empty slots) which the OCR stage filters out, but the
`Unidentified` class is a recall problem in both directions —
some are missed switches, some are misclassified non-switches.

The `pipeline/side_labels.py` cross-check (rack-rail green chips)
is the safety net for missed switches; it's not currently wired
into the UI (see [11-known-limits.md](11-known-limits.md)).

### Performance numbers

On a CPU-only host with `pythonCmd` resolving to a venv'd Python:

- CV pipeline: ~12-22s for a 1080p photo (most of the time is the
  general device model, which runs at ~5 FPS on CPU)
- Quality check: 0.5-1.5s
- Total `/api/analyze` round trip: typically 18-28s on cache miss,
  <500ms on cache hit

### Files in this feature

| File | Role |
|---|---|
| `pipeline/runner.py` | Top-level CV pipeline |
| `pipeline/detection.py` | YOLO model loading + dual-model dedup + Hough rack-bounds |
| `pipeline/annotation.py` | Renders annotated debug image (`device_unit_annotation.png`) |
| `pipeline/config_loader.py` | Reads `config.json` |
| `Models/best 32.pt`, `Models/best 33.pt`, `Models/unit.pt` | YOLO weights for devices + unit rails |
| `config.json` | Confidence thresholds + model paths |
