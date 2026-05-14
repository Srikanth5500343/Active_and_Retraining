# 14. Netdisco — LLDP / SNMP discovery proxy

## What it does (junior view)

[Netdisco](https://netdisco.org) is an open-source network
discovery tool — point it at a network range, give it SNMP
read-only credentials, and it walks every switch and router it
can find, learning:

- Which ports on switch A are connected to which ports on switch
  B (via LLDP / CDP neighbour discovery)
- Which MACs are seen on which ports
- Software versions, port descriptions, VLAN assignments

We run a netdisco container in Docker (`netdisco-docker/`) and the
app **proxies a small set of read-only queries** through to it,
surfacing the data inside the **Network** tab on the Results page.

What the user sees:

- A list of every neighbour the scanned rack's switches see
- Cross-rack peer hints (so the topology view knows there's a
  link to another rack across the room)
- Port-level MAC seen-here data for tracing where a server lives

The main reason the proxy exists: netdisco's UI is a separate web
app with its own login, and we want this data inside the same
flow as the rack scan, not a side trip.

## What it doesn't do

- It doesn't replace netdisco. We don't run discovery from the
  app — netdisco does its own scheduled walks (typically every
  4-24 hours). We just read the results.
- It doesn't write to netdisco. Read-only.
- It doesn't fall back if netdisco isn't running. If the netdisco
  container is down, the Network tab simply shows no data with a
  "netdisco offline" notice.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `server/netdisco_proxy.js` | Express router, 7 routes |
| `client/src/pages/NetdiscoPage.jsx` | Network tab UI |
| `netdisco-docker/` | Compose stack for the netdisco container |
| `pipeline/redetect_ports.py` | Netdisco-aware port re-detection |

### Routes (`server/netdisco_proxy.js`)

```
GET  /api/netdisco/health
GET  /api/netdisco/devices
GET  /api/netdisco/device/:ip
GET  /api/netdisco/device/:ip/ports
GET  /api/netdisco/device/:ip/neighbours
GET  /api/netdisco/rack/:rackId/neighbours
POST /api/netdisco/sync/:rackId
```

All gated by `auth.requireAuth`. Each route is a thin pass-through
to the netdisco container's REST API (which itself is a thin shim
over the netdisco database).

`scheduleNetdiscoSync(rackId)` is called from `app.js` after
per-bbox OCR completes — it tells netdisco to re-walk this rack's
switches so the next read picks up the freshly-OCR'd vendor /
model values that just landed in CMDB.

### How netdisco itself runs

`netdisco-docker/docker-compose.yml` defines:

- `netdisco` web — the UI + REST API (port 5000 by default)
- `netdisco-worker` — the discovery worker
- `netdisco-postgres` — PostgreSQL backend

SNMP credentials configured per-environment in
`netdisco-docker/.env`. Default community is `public` with v2c.
For production, switch to v3 with auth + priv.

### What we read

The proxy exposes only the read-only endpoints we need:

| Endpoint | Returns |
|---|---|
| `/health` | netdisco container health |
| `/devices` | all known devices (filterable by IP, vendor, etc.) |
| `/device/:ip` | one device's full record |
| `/device/:ip/ports` | per-port info (description, VLAN, status) |
| `/device/:ip/neighbours` | LLDP/CDP peers |
| `/rack/:rackId/neighbours` | union of neighbours across all switches in this rack |

`/rack/:rackId/neighbours` is the one the topology layer cares
about — it merges per-device neighbour info into a rack-level
view, then `topology_generate.py` uses it to label cross-rack
edges as `kind: 'inter-rack'`.

### Data merge: scan + netdisco + CMDB

Three sources can claim "switch X is at U10":

1. The scan (CV + OCR detected it)
2. Netdisco (discovered it via SNMP)
3. CMDB (someone created the record manually)

The reconciler in `servicenow/reconciler.py` matches them by:
- Serial number (highest-trust)
- MAC address (high-trust)
- IP address + position (medium-trust)
- Position alone (lowest-trust, only when neighbours agree)

When sources disagree, the priority is: CMDB → scan/OCR →
netdisco. Netdisco's vendor/model strings are sometimes wrong
(the SNMP `sysDescr` includes funky vendor variants like "Cisco
Systems, Inc." vs "Cisco IOS Software"), so we trust the scan's
OCR over netdisco's `sysDescr` parse.

### Performance + caching

Netdisco queries are fast (millisecond-range) because netdisco's
postgres is local. The proxy adds ~5ms per request. No caching
layer at the proxy level — the data is already cached in
netdisco.

### Files in this feature

| File | Role |
|---|---|
| `server/netdisco_proxy.js` | All 7 proxy routes |
| `client/src/pages/NetdiscoPage.jsx` | UI |
| `netdisco-docker/` | Container stack |
| `servicenow/reconciler.py` | Source-merge logic |
| `pipeline/redetect_ports.py` | Re-runs port detection using netdisco port info |
