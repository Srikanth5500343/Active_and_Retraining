# RackTrack — Owner Dashboard

A standalone, owner-only dashboard for inspecting audit logs, scans, and active-learning feedback across all tenants.

## Why it's separate from the main app

- **Owner-only access** — runs on its own port (`4100`) and binds to `127.0.0.1` only. The Cloudflare quick-tunnel started by `start.ps1` only forwards `localhost:3001`, so this port is **unreachable from the public internet**, even when the tunnel is up.
- **Read-only** — only opens `server/data/auth.db` in `readonly` mode and reads JSON files from `outputs/`. It cannot write or mutate state.
- **No login** — access control is "you have a shell on this workstation." If someone else can hit `127.0.0.1` on this box, they already have you.
- **Doesn't touch the user-facing app** — there's no admin route inside the React client; nothing changes in `client/` or `server/app.js`.

## What you can see

- **Audit log** — every state-changing action recorded in `audit_log` (in `server/data/auth.db`). Filter by tenant, user, action, status, rack ID, free-text on payload, and time window.
- **Per-scan view** — click any audit row or scan to see the full `scan_meta.json`, `scan_result.json` (truncated), file listing, and the audit trail just for that rack.
- **Per-tenant rollup** — bar chart of activity by tenant.
- **Top actions** — most frequent actions in the filtered window.
- **48-hour activity sparkline**.
- **Recent scans** — what's actually on disk in `outputs/`.
- **Active-learning feedback** — tail of `server/feedback.jsonl` plus thumbnails of the captured "wrong?" correction images in `server/feedback/wrong/`.
- **Live API health** — pulls `/metrics` and `/healthz` from the running server.

## Run it

```powershell
.\dashboard\start.ps1
# → http://127.0.0.1:4100
```

Optional arguments:
```powershell
.\dashboard\start.ps1 -Port 4200
.\dashboard\start.ps1 -ApiBase http://127.0.0.1:3001
```

Reuses `server/node_modules` (express + better-sqlite3) — no second `npm install` needed.

## Files

- `server.js` — tiny Express read-only API on `127.0.0.1:4100`
- `index.html` — single-page dashboard (no build step, no framework)
- `start.ps1` — launcher
- `README.md` — this file
