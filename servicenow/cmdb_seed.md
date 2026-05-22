# CMDB Seed Data — exact values to type into ServiceNow UI

Use this as your source of truth while populating. Every field listed here matters to the correlator — if you change a name, change it everywhere (including the mock scan JSON).

## 1. Rack (1 record)

**Table**: `cmdb_ci_rack` — filter navigator: `cmdb_ci_rack.list`

| Field              | Value              |
|--------------------|--------------------|
| Name               | RACK-04            |
| Location           | (pick any, e.g. DC-East)  |
| Rack Units         | 42                 |
| RackTrack scan ID (u_racktrack_scan_id) | RK-DC1RACK4 |

> The `u_racktrack_scan_id` field won't exist yet when you first try this — follow step 0:45 in PLAN.md to add the column first.

## 2. Switches (2 records)

**Table**: `cmdb_ci_ip_switch` — filter navigator: `cmdb_ci_ip_switch.list`

### SW-CORE-01
| Field                | Value        |
|----------------------|--------------|
| Name                 | SW-CORE-01   |
| Manufacturer         | Cisco        |
| Model number         | Catalyst 9300 |
| Rack units           | 1            |
| Rack unit position   | 10           |
| Serial number        | FXS1234CORE  |
| Operational status   | Operational  |

### SW-ACC-01
| Field                | Value        |
|----------------------|--------------|
| Name                 | SW-ACC-01    |
| Manufacturer         | Cisco        |
| Model number         | Catalyst 2960 |
| Rack units           | 1            |
| Rack unit position   | 11           |
| Serial number        | FXS5678ACC   |
| Operational status   | Operational  |

## 3. Patch Panel (1 record)

**Table**: `cmdb_ci_patch_panel` — filter navigator: `cmdb_ci_patch_panel.list` (if this table doesn't exist on your PDI, use `cmdb_ci_network_gear` with category = Patch Panel)

| Field              | Value      |
|--------------------|------------|
| Name               | PP-01      |
| Manufacturer       | Panduit    |
| Rack unit position | 12         |
| Ports              | 48         |

## 4. Servers (5 records)

**Table**: `cmdb_ci_server` — filter navigator: `cmdb_ci_server.list`

| Name    | OS          | CPUs | RAM (GB) | Rack unit position |
|---------|-------------|------|----------|---------------------|
| WEB-01  | Ubuntu 22.04 | 8   | 32       | 9                   |
| WEB-02  | Ubuntu 22.04 | 8   | 32       | 8                   |
| APP-01  | RHEL 9      | 16   | 64       | 7                   |
| APP-02  | RHEL 9      | 16   | 64       | 6                   |
| DB-01   | RHEL 9      | 32   | 128      | 5                   |

For all: Manufacturer = Dell, Operational status = Operational.

## 5. Relationships (8 rows)

**Table**: `cmdb_rel_ci` — filter navigator: `cmdb_rel_ci.list`

All relationships use the type **`Contains::Contained by`**.

| Parent   | Type                     | Child       |
|----------|--------------------------|-------------|
| RACK-04  | Contains::Contained by   | SW-CORE-01  |
| RACK-04  | Contains::Contained by   | SW-ACC-01   |
| RACK-04  | Contains::Contained by   | PP-01       |
| RACK-04  | Contains::Contained by   | WEB-01      |
| RACK-04  | Contains::Contained by   | WEB-02      |
| RACK-04  | Contains::Contained by   | APP-01      |
| RACK-04  | Contains::Contained by   | APP-02      |
| RACK-04  | Contains::Contained by   | DB-01       |

## 6. Test Incident (1 record)

**Table**: `incident` — filter navigator: `incident.list`

| Field              | Value                                                                |
|--------------------|----------------------------------------------------------------------|
| Short description  | Port 12 on SW-CORE-01 down — WEB-01 unreachable                      |
| Description        | User reports WEB-01 unreachable since 9am. Switch port 12 appears down. |
| Configuration item | SW-CORE-01                                                           |
| Priority           | 3 - Moderate                                                         |
| State              | New                                                                  |

After saving, **note the incident number** (e.g. `INC0010001`). You'll pass this to `main.py`.

---

## Why these specific values matter

- **RACK-04 name** → referenced by the rack lookup in `reconciler.py`
- **RK-DC1RACK4** → must match the folder name under `mock_scans/` exactly
- **SW-CORE-01** → must match the device label inside `device_unit_map.json`
- **Port 12 in the incident description** → the regex in `reconciler.py` extracts this; the mock scan has port 12 marked as empty (cable disconnected), which is what drives the "possible disconnect" reconciliation line

If you change any name, update:
1. The mock scan JSON (`mock_scans/RK-DC1RACK4/device_unit_map.json`)
2. The reconciler's display strings (optional — it reads names dynamically)
