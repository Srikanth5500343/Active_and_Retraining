# 13. CMDB / ServiceNow — sync, ticketing, approval

## What it does (junior view)

ServiceNow is the database your IT department uses to track every
piece of hardware they own ("CMDB" = Configuration Management
Database). After a rack scan, the user can **push the scan result
to ServiceNow** so the office team sees exactly what's in the rack
without anyone retyping serial numbers into a form.

The push isn't direct — it goes through ServiceNow's normal
**change-ticket workflow**:

1. The user taps **Sync to CMDB** on the rack's results page.
2. The app builds a **diff** between the new scan and what
   ServiceNow currently has for this rack (added devices, removed
   devices, changed firmware, etc.).
3. A change ticket is created on the ServiceNow side with the diff
   attached.
4. The change goes through whatever approval flow your CMDB admin
   has set up (typically: assign to an approver, approver looks
   at it, clicks Approve or Reject).
5. Once approved, the diff is **applied** — CMDB rows are
   updated/inserted/deleted to match.

The user can poll the ticket from inside the app (refresh the
ticket card) and see when it goes Approved → Applied.

There's also a **dev-approve** shortcut for demo / sandbox use
that skips the approval workflow and applies the diff directly —
**this should be disabled in production** (see the lead-view
section).

## What it doesn't do

- The app doesn't **manage** the CMDB schema. ServiceNow's
  Configuration Item (CI) table classes are assumed to exist —
  `cmdb_ci_ip_switch`, `cmdb_ci_server`, `cmdb_ci_rack`, etc.
- It doesn't **bidirectionally sync** in real time. Changes made
  inside ServiceNow aren't pushed back to the app until the next
  scan + diff.
- It doesn't write to ServiceNow without the user explicitly
  triggering a sync. No background writes.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `server/cmdb_ticket_proxy.js` | Express router; 6 routes |
| `servicenow/cmdb_ticket.py` | Ticket lifecycle (create, refresh, cancel, dev-approve) |
| `servicenow/cmdb_apply.py` | Applies a diff to ServiceNow (insert/update/delete CIs) |
| `servicenow/synth.py` | Builds a "what should be in CMDB for this rack" structure from scan + OCR + overrides |
| `servicenow/diff_cmdb.py` | Computes added/removed/changed between live CMDB and synth |
| `servicenow/reconciler.py` | Used during diff to match CMDB rows to scan devices by serial / position |
| `servicenow/bootstrap_cmdb.py`, `bootstrap_cmdb_full.py` | Seed scripts; populate a fresh ServiceNow instance |
| `servicenow/cmdb_size.py` | Size + capacity helpers for rack records |
| `servicenow/list_rack_switches.py` | CLI dump of switches per rack |
| `servicenow/topology_generate.py` | Used by the Topology tab — see [10-topology.md](10-topology.md) |

### Routes (`server/cmdb_ticket_proxy.js`)

All gated by `auth.requireAuth`:

| Method | Path | Action |
|---|---|---|
| GET | `/api/cmdb/ticket/:rackId` | read local `outputs/<rackId>/ticket_state.json` |
| POST | `/api/cmdb/ticket/:rackId/refresh` | re-poll ServiceNow for ticket state |
| POST | `/api/cmdb/ticket/:rackId/create` | compute diff + create change ticket |
| POST | `/api/cmdb/ticket/:rackId/cancel` | drop the local state file |
| POST | `/api/cmdb/ticket/poll` | sweep every open ticket |
| POST | `/api/cmdb/ticket/:rackId/dev-approve` | skip approval, apply diff directly (DEMO ONLY) |

Each route shells out to `servicenow/cmdb_ticket.py <subcommand>`
through `runTicketCmd()` which is a `child_process.spawn` wrapper
with a 15-second timeout (`server/app.js:2205`).

### State file — `outputs/<rackId>/ticket_state.json`

Lifecycle:

```
create  → ticket_state.json with {status:'new', ticket_id, created_at, diff_summary}
refresh → polls SNOW; updates {status:'in_review'|'approved'|'rejected'|'applied'}
apply   → on approval, runs cmdb_apply.py; status:'applied' + 'applied_at'
cancel  → deletes the file
```

The state file lets the UI tab survive page reloads — the user
can come back later and see "ticket from yesterday is still in
review."

### Synth → diff → apply

`servicenow/synth.py` builds the "what we want CMDB to look like"
JSON from:

- `outputs/<rackId>/ocr_devices.json` (per-bbox make/model/version)
- `outputs/<rackId>/device_unit_map.json` (CV-detected positions
  and port counts)
- `servicenow/overrides/<rackId>.json` if present (manual
  corrections)
- The user-entered manual values from localStorage are NOT
  consumed by synth currently — see [24-known-limits.md](24-known-limits.md).

Output schema: a list of devices with normalized fields
(`name`, `manufacturer`, `model_number`, `os_version`,
`serial_number`, `mac_address`, `ip_address`, `position`,
`u_size`, `port_count`, etc.).

`servicenow/diff_cmdb.py` then queries ServiceNow for the rack's
current CIs and produces three lists:

- **add**: present in synth but not in CMDB
- **remove**: present in CMDB but not in synth
- **update**: same device (matched by serial/position) but with
  changed fields

`servicenow/cmdb_apply.py` applies the diff in this order:
update → add → remove. Each operation is one ServiceNow REST call
(`PATCH cmdb_ci_X/<sys_id>` for update, `POST cmdb_ci_X` for
insert, `DELETE` for remove). HTTP Basic auth using
`SN_USER` / `SN_PASSWORD` from `servicenow/.env`.

### ServiceNow auth (current state)

HTTP Basic auth, password-in-env. Used by every script in
`servicenow/`:

```python
self.auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
```

`.env` contents (`servicenow/.env`):
```
SN_INSTANCE=<instance>.service-now.com
SN_USER=admin
SN_PASSWORD=<password>
```

Basic auth is supported by ServiceNow but flagged in any
IT-security review. Modern integrations should use **OAuth
client-credentials grant**:

1. ServiceNow → System OAuth → Application Registry → New
2. Endpoint client (server-to-server)
3. Store `client_id` / `client_secret` (env or secrets manager)
4. Exchange for `access_token`, refresh as needed

Migrating is a config change on the SNOW side and a request-helper
change on the Python side. Tracked in [24-known-limits.md](24-known-limits.md).

### The dev-approve bypass

`server/cmdb_ticket_proxy.js:131`:

```js
// POST dev-approve — demo flow: skip ServiceNow approval, apply scan to CMDB
router.post('/api/cmdb/ticket/:rackId/dev-approve', safeAsync(async (req, res) => {
  const r = await runTicketCmd(['dev-approve', '--rack-id', req.params.rackId], ...);
  ...
}));
```

What it does: runs `cmdb_ticket.py dev-approve --rack-id <X>`,
which:
1. Reads `outputs/<rackId>/ticket_state.json` (the diff)
2. Calls `cmdb_apply.py` directly to apply the diff
3. Updates ticket_state to `applied`

This skips the actual ServiceNow approval step. **Authenticated**
(behind `auth.requireAuth`) but auditors will flag it as an
authorization-gap finding.

What to do for production:

```js
if (process.env.NODE_ENV === 'production') {
  return res.status(404).json({ error: 'Not found' });
}
```

Or — better — wire dev-approve to a real ServiceNow approval flow
that auto-approves in the demo tenant only (so the code path is
the same in dev and prod, just the SNOW config differs).

### Rack ownership / multi-tenancy

A separate concern: in a multi-tenant deployment, two tenants who
scan the same physical rack get the same `rackId` (SHA-256 of
the image). The CMDB push flow doesn't currently scope by tenant;
both tenants would push to the same `cmdb_ci_rack` row. Tenant
ownership is enforced at the API layer via `tenant.js`
middleware — see [20-multi-tenancy.md](20-multi-tenancy.md).

### Bootstrap / seed scripts

`servicenow/bootstrap_cmdb.py` and `bootstrap_cmdb_full.py` are
one-shot scripts that populate a fresh ServiceNow tenant with:

- Sample racks (rack name, location, U-size)
- Sample switches with known make/model/firmware
- Sample patch panels and cables

Used during demo setup; not part of normal request flow.

### CLI / debug entry points

| Command | Purpose |
|---|---|
| `python -m servicenow.cmdb_ticket create --rack-id RK-...` | Manually create a ticket |
| `python -m servicenow.cmdb_ticket refresh --rack-id RK-...` | Manually refresh a ticket |
| `python -m servicenow.cmdb_ticket dev-approve --rack-id RK-...` | Skip approval (demo) |
| `python -m servicenow.list_rack_switches --rack-id RK-...` | Dump current CMDB switches for a rack |
| `python -m servicenow.diff_cmdb --rack-id RK-...` | Compute the diff without creating a ticket |

### Files in this feature

(See table at top of doc.)
