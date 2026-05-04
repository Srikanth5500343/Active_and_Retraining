# RackTrack × ServiceNow Bridge

Correlates a ServiceNow incident with a CMDB walk and a RackTrack physical-scan lookup, then posts a reconciliation work note back to the incident.

## Quick start

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env with your ServiceNow PDI credentials
python main.py INC0010001
```

## What the output looks like

```
RackTrack correlation for INC0010001

CMDB: SW-CORE-01 (Cisco) in RACK-04 at U10
Ticket references: Port 12
RackTrack scan RK-DC1RACK4 (2026-04-22 09:15 UTC): switch confirmed at U10 ✓ matches CMDB
  Port 12 visual state: EMPTY (no cable detected)
Neighbors: SW-ACC-01 above (U11), WEB-01 below (U09)

Suggested action: port 12 appears unplugged in the last scan.
Check the physical cable at the switch AND its far end (server or patch panel).
```

## Files

- **PLAN.md** — the full 1-day build plan, hour by hour
- **cmdb_seed.md** — exact CMDB values to type into ServiceNow
- **servicenow.py** — ServiceNow REST client (Table API)
- **racktrack.py** — RackTrack client (mock or live)
- **reconciler.py** — merge logic + work note formatter
- **main.py** — CLI
- **mock_scans/** — sample RackTrack output for testing without a running server

## Mock vs live RackTrack

Set `RACKTRACK_USE_MOCK=true` in `.env` to read scan data from `mock_scans/<rack_scan_id>/device_unit_map.json`.

Set it to `false` and provide `RACKTRACK_URL` + `RACKTRACK_JWT` to hit a real RackTrack server's `/api/scan/:id/report` endpoint.

Switching modes requires no code changes.

## Troubleshooting

See the *Troubleshooting* section at the bottom of **PLAN.md**.
