# 20. Multi-Tenancy — keeping customer data separated

## What it does (junior view)

A single deployment of this app can serve **multiple customers**
(tenants) safely. Customer A's racks are visible only to
Customer A's users; Customer B can't see them, can't query them,
can't list them, even though they're sitting on the same server
and database.

The mechanism is straightforward:

- Every user belongs to exactly one tenant (set at signup or by
  admin).
- When a user scans a rack, the server records "tenant N owns
  rack RK-XXX" in a `rack_owners` table.
- Every API endpoint that takes a `:rackId` checks "is this
  rack owned by the requesting user's tenant?" — if not, 404.
- Every API endpoint that lists racks ("show me all racks I've
  scanned") filters by tenant.

A **subtle case**: two tenants who scan the same physical rack
get the same `rackId` (because rackId = SHA-256 of the image,
which is content-addressable). The pipeline output on disk
under `outputs/RK-XXX/` is **shared** — efficient, we don't
re-run the pipeline twice. But the **API surface** treats them
as if each tenant has their own rack; the output files happen to
be the same, but neither tenant can see that the other tenant
has also scanned it.

## What it doesn't do

- It doesn't isolate **storage** — `outputs/` is one folder for
  everyone. The isolation happens at the API layer, not the
  filesystem.
- It doesn't isolate **compute** — pipeline subprocesses are a
  shared resource pool. A tenant submitting many concurrent scans
  can saturate workers and slow other tenants. (Per-tenant rate
  limiting is a roadmap item.)
- It doesn't enforce isolation on the **CMDB**. Two tenants
  pushing the same rack to the same ServiceNow instance both
  write to the same CI rows. Multi-tenant CMDB integrations
  typically use separate ServiceNow tenants per customer; that's
  the expected deployment shape.

---

## Technical detail (lead view)

### File

`server/lib/tenant.js`. ~140 lines, plus migration in
`server/auth.js`.

### Schema

Two relevant tables in `server/data/auth.db` (SQLite,
`better-sqlite3`):

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT,
  created_at TEXT
);

CREATE TABLE rack_owners (
  tenant_id  INTEGER NOT NULL,
  rack_id    TEXT    NOT NULL,
  created_by INTEGER,                 -- user id who first scanned
  created_at TEXT,
  PRIMARY KEY (tenant_id, rack_id)
);
```

Plus a `tenants` table tracking the tenant itself:

```sql
CREATE TABLE tenants (
  id INTEGER PRIMARY KEY,
  name TEXT,
  created_at TEXT
);
```

### Public API of `tenant.js`

```js
const tenant = require('./lib/tenant');

tenant.claimRack(tenantId, rackId, userId);         // idempotent INSERT OR IGNORE
tenant.tenantOwnsRack(tenantId, rackId);            // → bool
tenant.tenantRackIds(tenantId);                     // → Set<string>
tenant.listRacksForTenant(tenantId, limit);         // → [{rack_id, created_at, created_by}]
tenant.requireRackOwnership(req, res, next);        // Express middleware
```

### Where it's wired

Three integration points in `app.js`:

1. **After successful analyze** — claim ownership:
   ```js
   tenant.claimRack(req.user.tenant_id, rackId, req.user.id);
   ```
   `INSERT OR IGNORE` so a second tenant scanning the same rack
   gets their own row without disturbing the first.

2. **On any `:rackId` route** — middleware:
   ```js
   app.get('/api/scan/:rackId/result', auth.requireAuth,
                                       tenant.requireRackOwnership,
                                       handler);
   ```
   `requireRackOwnership` reads `req.params.rackId` and
   `req.user.tenant_id`, returns 404 if no ownership row exists.

3. **List endpoints** — explicit filter:
   ```js
   const racks = tenant.listRacksForTenant(req.user.tenant_id, 100);
   ```
   Used by the History page (`GET /api/scans/recent`) and the
   home dashboard.

### What "owns" means precisely

The `rack_owners` row says "tenant T has scanned rack R at least
once." Implications:

- **Tenant T can read** any data derived from that rack — scan
  result, OCR devices, topology, ports, switch info.
- **Tenant T can mutate** rack-scoped state — sync to CMDB, share
  the report, cancel a ticket, re-trigger OCR.
- **Tenant T does NOT own the underlying image** in any
  filesystem sense — `outputs/RK-XXX/original_image.jpg` is
  shared between tenants who scanned the same rack.

If tenant T needs to delete their data:
- Drop the `rack_owners` row → API will 404 for them
- The `outputs/RK-XXX/` folder stays for any other tenant that
  also owns it
- A later GC step (not yet implemented — see [24-known-limits.md](24-known-limits.md))
  could prune folders that have zero owners

### The 404 instead of 403 choice

`requireRackOwnership` returns 404, not 403, on ownership miss.
Reason: a 403 leaks information ("this rackId exists, you just
can't see it"). A 404 is indistinguishable from "this rack was
never scanned by anyone." Privacy by API design.

### Roles within a tenant

`users.role` enum: `admin | engineer | viewer`. Role checks are
separate middleware (`requireRole('admin')`) that compose with
ownership:

```js
app.delete('/api/scan/:rackId',
           auth.requireAuth,
           tenant.requireRackOwnership,
           auth.requireRole('admin'),
           handler);
```

Rule of thumb: ownership is "is this rack mine?", role is "am I
allowed to do dangerous things?".

### Performance

`tenantOwnsRack` is a single-row SQLite lookup with a primary-
key index — sub-millisecond. The middleware adds ~0.3ms to every
rack-scoped request. `listRacksForTenant` is a `WHERE tenant_id
= ?` scan; SQLite handles a few thousand rows trivially.

For a deployment with millions of racks across thousands of
tenants, the right next step is partitioning rack_owners by
tenant_id (multi-row sharded SQLite or moving to PostgreSQL).
Today's scale: comfortable.

### Onboarding a new tenant

```bash
# Create tenant + first admin user
sqlite3 server/data/auth.db <<EOF
INSERT INTO tenants (name, created_at) VALUES ('Acme Corp', datetime('now'));
INSERT INTO users (tenant_id, email, password_hash, role, created_at)
VALUES (last_insert_rowid(), 'admin@acme.example', '<bcrypt>', 'admin', datetime('now'));
EOF
```

A self-serve signup flow that creates the tenant + first admin
in one transaction is on the roadmap.

### Files in this feature

| File | Role |
|---|---|
| `server/lib/tenant.js` | All ownership helpers + middleware |
| `server/auth.js` | Migration creates the `rack_owners` and `tenants` tables; `tenant_id` on `users` |
| `server/app.js` | Wiring: `tenant.claimRack` after analyze, `tenant.requireRackOwnership` on `:rackId` routes |
| `server/data/auth.db` | SQLite database with the actual rows |
