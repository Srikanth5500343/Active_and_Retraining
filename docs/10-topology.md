# 10. Topology — the 3D rack view

## What it does (junior view)

The **Topology** tab shows a 3D model of the rack with all the
detected devices and the cables between them. The user can:

- **Orbit** (drag) and **zoom** (scroll) around the rack.
- Switch between **3D** and **2D** views (the 2D view is a tier-
  graph: core / distribution / access / endpoint).
- **Filter cables** by type (All / Cat / Fiber / DAC).
- Toggle a **capacity heatmap** that colours each device by how
  many free ports it has (green = lots free, red = nearly full).
- **Trace** a path between two devices — tap two switches and the
  app highlights the cables that connect them.
- Tap any device or cable to see details in a panel at the bottom.

The point of the 3D view: it answers "how is this rack actually
wired?" in a way a flat list of devices can't. A senior tech
glancing at the screen for 5 seconds can spot that the patch panel
on U37 has 24 cables going up to the switch on U36 and 6 going
down to a server on U33 — that's a wiring story, not a database
view.

The data feeding the view comes from:

- The CV scan (which devices, where, how many ports each)
- The SSH probe (which ports are connected on the live switch)
- The patch-panel registry (manually configured patch-panel
  port-to-port cabling)
- LLDP from netdisco (when the switch advertises its peers)

## What it doesn't do

- It doesn't model multiple racks in one view (yet). A datacenter
  with 30 racks shows you 30 separate rack views, not one room.
- It doesn't render power cables (only data: copper, fiber, DAC).
- It doesn't auto-detect cables from the photo. Cable inference
  uses the connection table from CMDB / netdisco / patch-panel
  configs, not pixel-level cable tracing.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `client/src/pages/TopologyPage.jsx` | Page chrome, toolbar, filters, trace mode, bottom panel, 2D view |
| `client/src/pages/TopologyScene3D.jsx` | The 3D scene (lazy-loaded — Three.js is ~200KB) |
| `client/src/pages/TopologyPage.module.css` | All CSS for both views |
| `servicenow/topology_generate.py` | Server-side: assembles the topology JSON from CMDB + scan data |
| `server/app.js:/api/topology/:rackId` | Endpoint that returns the JSON |

### Endpoint

`GET /api/topology/:rackId`. Returns a topology JSON with:

```json
{
  "rackId": "RK-F74FFCF9",
  "rackName": "RACK-RK-...",
  "u_size": 15,
  "devices": [
    {
      "name": "SW-U10",
      "class": "switch",         // 'switch'|'patch_panel'|'server'
      "in_rack": true,
      "u_position": 10,
      "ports": [
        {"name":"1","label":"1","kind":"rj45","connected":true,"is_uplink":false},
        ...
      ],
      "model": "...",
      "mgmt_ip": "..."
    },
    ...
  ],
  "edges": [
    {
      "cable_id": "CBL-001",
      "src": {"device":"SW-U10","port":"1"},
      "dst": {"device":"PP-U12","port":"1"},
      "cable_type": "Cat6",
      "color": "blue",
      "length": "1m",
      "is_uplink": false,
      "kind": "patch"
    },
    ...
  ],
  "stats": { "device_count_in_rack": 5, "edge_count": 27 }
}
```

`crossRackEdges` and `neighbors` are also part of the schema for
multi-rack visualization, but the current 3D view doesn't render
them — see [24-known-limits.md](24-known-limits.md).

### How edges (cables) are produced

`servicenow/topology_generate.py` walks several sources in priority
order and unions the results:

1. **Patch-panel registry** — explicit panel-port-to-panel-port
   mappings configured for the rack
2. **LLDP from netdisco** — switch peer info (when netdisco has it)
3. **Probe correlation** — the SSH probe's connected/disconnected
   state, intersected with the CV port count

Each edge gets a `cable_id` (synthetic if not from CMDB), a
`cable_type` from the cable classifier model, and `kind` (`patch`,
`uplink`, `inter-rack`).

### 2D view (`Graph2D` component)

`client/src/pages/TopologyPage.jsx:558`. SVG-based. Tiers:

```
TIER_ORDER = ['core','distribution','access','endpoint']
TIER_COLOR = { core:'amber', distribution:'cyan',
               access:'blue', endpoint:'violet' }
```

Devices are placed on horizontal rows (one per tier), evenly
spaced. Bezier curves between rows render the cables. Stroke
width grows with cable count (`strokeForCount(n)` ≈ logarithmic).

Aggregated edges: 24 cables between the same SW-PP pair render as
one fat edge with a `24` count badge in the middle, not 24
overlapping bezier curves. Toggling the cable-type filter at the
top regenerates this view.

### 3D view (`TopologyScene3D` component)

Lazy-loaded so the Three.js bundle (~200 KB) only ships when the
user opens the Topology tab:

```jsx
const TopologyScene3D = lazy(() => import('./TopologyScene3D.jsx'));
```

Uses React Three Fiber (`@react-three/fiber`) + drei
(`@react-three/drei`) for camera controls. The scene has:

- A 3D rack frame (extruded box with U-rail markers)
- One coloured 1U slab per detected device, positioned by U-number
- Tube primitives for cables, routed through patch panels with
  curve control points so cables don't pass through devices
- Environment lighting + soft shadows
- `OrbitControls` for drag + zoom; switches to hand-pan when zoomed
  in close

Hovering a device emits a `setHoverInfo` callback to the parent;
the parent renders a `HoverInfoCard` overlay in the top-left
corner with the device's name, class, U-position, model, and
port utilization.

### Trace mode

State: `traceMode`, `traceA`, `traceB`. Logic at lines 160-200.

When `traceMode` is on, clicking a node sets it as endpoint A
(first click) or B (second click), then a BFS over the
device-pair adjacency graph (`aggEdges`) finds the shortest cable
path. The path lights up in cyan in both 2D and 3D views; the
`TraceBanner` at the top shows the hop count and node sequence.

Third click resets — A becomes the new starting node.

### Capacity heatmap

When `heatmap` is on, every device is coloured by its free-port
percentage instead of its tier:

```js
function heatmapColor(freePct) {
  if (freePct >= 0.5)  return '#22c55e'; // green
  if (freePct >= 0.25) return '#f59e0b'; // amber
  return '#ef4444';                       // red
}
```

`freePctByDevice` is derived from `topo.devices[i].ports[]`:
`(total - connected) / total`. When `total === 0` (a device with
no detected ports), the device renders grey (`#475569`) and is
excluded from the heatmap.

### Bottom panel — selection details

When a node is selected, the bottom panel shows:
- Device name, class, U-position, model, mgmt IP
- A horizontal scroll of "peers" (other devices connected to this
  one), sorted by cable count
- A full ports table: port label, status (connected/free), cable
  ID, connector type (RJ45 / SFP+ / LC), the cable's other end

When an edge (aggregated cable bundle) is selected:
- The two endpoints
- A list of every individual cable: cable_id, src port, dst port,
  type, length

When a single cable (within an edge) is selected:
- The cable's full details from the edges array

### Recall gap (currently disabled)

A `RecallGapBanner` was built earlier to surface mismatches
between rack-rail label OCR (`pipeline/side_labels.py`) and
detected switches — *"7 rail labels but only 5 switches identified
— here are the 2 unmatched"*. The banner was removed from the UI
in a later iteration because the matching logic was misfiring on
the labels. The Python side (`side_labels.py`) and the
`/api/scan/:rackId/side-labels` endpoint are still wired up; only
the React render is disabled.

### Prefetch integration

`useEffect` at `TopologyPage.jsx:88` reads the prefetch cache
first. When `scanPrefetch` ran after `/api/analyze`, the topology
JSON is already in `cacheKey.topology(rackId)`, and the page
hydrates synchronously — no loading spinner.

If the cache is empty (e.g. user navigated directly to the
Topology page without going through scan), the page falls back to
fetching from `/api/topology/:rackId` on mount.

### Performance

- Initial render time on a rack with 5 switches + 5 patch panels +
  27 cables: ~150-300ms once the bundle is loaded
- React Three Fiber re-renders only when scene state changes
  (no per-frame React reconciliation)
- The 2D SVG view scales to ~50 devices / ~200 cables before
  performance degrades; beyond that, the 3D view is faster

### Files in this feature

| File | Role |
|---|---|
| `client/src/pages/TopologyPage.jsx` | Page, toolbar, 2D view, trace mode, bottom panel |
| `client/src/pages/TopologyScene3D.jsx` | 3D scene |
| `client/src/utils/scanPrefetch.js:_prefetchTopology` | Prefetch on analyze |
| `servicenow/topology_generate.py` | Server-side topology JSON assembly |
| `server/app.js:/api/topology/:rackId` | HTTP endpoint |
| `pipeline/cable.py` + `Models/best_model_efficientnet.pth` | Cable type classifier |
