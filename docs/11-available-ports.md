# 11. Available Ports — live SSH probe of the switch

## What it does (junior view)

The **Ports** tab shows which ports on the live switch are
currently free, used, or reserved — based on what the switch
itself reports right now, not what the photo shows.

The app opens an SSH session to the switch, runs
`show interface status`, parses the output, and decides per port:

- **Connected** (in use)
- **Free** (link down, no description set)
- **Reserved** (link down, but the port has a description set —
  someone has assigned it to something even though nothing's
  plugged in right now)

The Ports tab summary card shows:

- A big number for the count of available ports
- ETH and SFP breakdown (so the user knows whether they have
  copper or fiber capacity)
- A utilization bar (how full is this switch overall)
- Expandable list of every available port with its interface name

This runs **in parallel with the rack scan**. The moment the user
taps "Analyze Rack", the SSH probe kicks off as a background
fire-and-forget. By the time they navigate to the Ports tab, the
probe result is usually ready and the page renders instantly.

If the probe failed (switch unreachable, wrong credentials, SSH
port blocked), the user sees an error with a Retry button.

## What it doesn't do

- It doesn't write to the switch. Read-only — `show interface
  status` and similar.
- It doesn't probe every switch in the rack — only the configured
  primary switch (typically the management switch). Multi-switch
  probing is a roadmap item.
- It doesn't speak vendor-specific commands. `show interface
  status` works for Cisco, TP-Link, MikroTik, and most other
  managed switches; the output format varies and the parser is
  tolerant but not perfect.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `client/src/utils/portsProbe.js` | Singleton state machine, localStorage persistence, subscribe API |
| `client/src/pages/PortsPage.jsx` | The Ports tab UI |
| `client/src/pages/PortsPage.module.css` | Card styling |
| `server/app.js:~2288` `runSwitchCommand()` | SSH session helper using `ssh2` |
| `server/lib/ssh-creds.js` | Encrypted SSH credential store |
| `server/app.js:/api/switch/console/run` | The endpoint the probe calls |
| `server/app.js:/api/switch/default-host` | Returns the user's last successful host |

### State machine

`portsProbe.js` keeps one in-memory state object and persists `ok`
states to localStorage so a re-visit after a reload gets cached
data instantly:

```js
state = {
  status: 'idle' | 'running' | 'ok' | 'error',
  ports: [{iface, status, medium, description}, ...] | null,
  error: string | null,
  host: string | null,
  startedAt: number,
  finishedAt: number,
}
```

Three triggers:

1. **`triggerBackgroundProbe()`** — fire-and-forget, idempotent.
   Called from `ScanPage.jsx` on Analyze Rack click. Skips if a
   probe is already running or the last result was `ok`.
2. **`triggerBackgroundProbe({ force: true })`** — bypasses the
   skip-if-ok check. Called from the Retry button.
3. **`subscribeProbe(fn)`** — used by `PortsPage.jsx` to react to
   state changes.

The cache is intentional: re-running an SSH probe on every
navigation to the Ports tab was the previous behaviour and
created visible spinners every time. Now: probe once at scan
time, persist, render from cache.

### SSH execution

`runSwitchCommand()` at `server/app.js:2288`. Uses `ssh2`. Steps:

```
1. Connect to host:port (default port 22, default user from creds)
2. Send the "paging off" command (`terminal length 0` for Cisco,
   vendor-specific for others)
3. If the device requires `enable` mode, send enable + password
4. Wait for prompt (`>` or `#`)
5. Send the actual command
6. Buffer output until next prompt or timeout
7. Disconnect
```

Vendor-specific paging-off variants live in
`server/console_commands.json`. The default is `terminal length 0`
which works for Cisco, Aruba, and most TP-Link models; MikroTik
RouterOS uses `:put` differently and is mostly handled by
parsing.

### Credential store

Credentials are AES-256-GCM encrypted in `server/.env`:

```
SSH_CREDS_ENC=<base64(iv|tag|ciphertext)>
```

The 32-byte key lives in either:
- The `SSH_CREDS_KEY` env var (preferred, for Docker/systemd)
- Or `server/.env.key` as a 64-char hex string (fallback)

The encrypted blob holds JSON with per-host or per-user defaults:
`{ defaultUser, defaultPassword, hostOverrides: { '192.168.1.13': {...} } }`.

Decrypted lazily on first use; never written to disk plaintext.
See [21-auth-secrets.md](21-auth-secrets.md).

### Output parser

`pipeline/portsProbe.js:parseInterfaceStatusTable(text)` (also
duplicated server-side in `server/app.js`).

Tolerant to multiple vendor formats:

- **TP-Link `show interface status`** — has columns Port / Status
  / Speed / Duplex / Active-Medium / Description
- **Cisco `show interface status`** — Port / Name / Status / VLAN /
  Duplex / Speed / Type
- **MikroTik `interface print`** — different table; not currently
  parsed (use the SwOS `show ports` variant instead)

The parser:
1. Strips control bytes left by paging prompts (`\x00` after
   "Press any key to continue", "--More--" lines, etc.)
2. Splits on newlines, trims, drops headers and ruler rows
3. Regex per row: `^(\S+)\s+(\S+)(?:\s+(\S+))?...`
4. Validates the iface looks like a real interface name
   (`Te1/0/1`, `1/0/24`, `Gi1/0/1`, etc.)
5. Pulls `medium` (`copper` or `fiber`) and `description` if the
   columns line up

### Verdict logic — `logicalVerdict(row)`

Used by both server and client:

```js
function logicalVerdict(row) {
  const s = row.status.toLowerCase();
  const hasDesc = !!(row.description?.trim());
  if (/(linkup|connected|^up$)/i.test(s)) return 'used';
  if (/(err|disable|shutdown|admin)/i.test(s)) return 'reserved';
  return hasDesc ? 'reserved' : 'available';
}
```

- `linkup` / `connected` / `up` → in use
- `err-disabled`, `disabled`, `shutdown`, `admin down` → reserved
  (the device is administratively held out of service)
- Otherwise: a description means "someone planned this port"
  (reserved); no description means the port is genuinely free

### Probe response schema

`POST /api/switch/console/run`:

```json
{
  "host": "192.168.1.13",
  "command": "show interface status",
  "vendor": "tplink",
  "timeoutMs": 45000
}
```

Response on success:

```json
{
  "ok": true,
  "entry": { "output": "<raw text>", "exitCode": 0, "duration_ms": 1820 },
  "host": "192.168.1.13"
}
```

The probe wraps this and post-processes the `output` through
`parseInterfaceStatusTable` to produce the structured port list.

### UI summary card

`PortsPage.jsx:PortsSummaryCard`. Hero badge with the available
count, ETH + SFP chips, utilization bar (gradient green→amber→red).
When expanded: full table of available ports with per-row
interface name and an ETH/SFP type pill.

### Failure modes

| Failure | Detection | UI |
|---|---|---|
| Wrong credentials | SSH `auth failed` | "Probe failed: authentication" + Retry |
| Switch unreachable | timeout, ECONNREFUSED | "Probe failed: <reason>" + Retry |
| Default host wrong | gateway IP, not switch — long timeout | Suggested in [21-auth-secrets.md](21-auth-secrets.md): default to a configured fallback (`192.168.1.13`) instead of the gateway |
| Output empty / no rows parsed | parser returned `[]` | "Probe returned no port rows" |
| Vendor/format unknown | row regex doesn't match | rows silently dropped, count looks low |

### SFP advisor integration

The probe also feeds the SFP procurement advisor — see
[12-sfp-advisor.md](12-sfp-advisor.md). The advisor needs the SFP
port interface names so it can ask the vendor scraper "what slot
type is this?" The probe is the only source for those interface
names — without it, the advisor falls back to inferring the slot
type from the switch model alone.

### Files in this feature

| File | Role |
|---|---|
| `client/src/utils/portsProbe.js` | State machine + persistence + parser |
| `client/src/pages/PortsPage.jsx` | UI |
| `server/lib/ssh-creds.js` | Encrypted credential store |
| `server/app.js` | `runSwitchCommand`, `/api/switch/console/run`, `/api/switch/default-host` |
| `server/console_commands.json` | Per-vendor paging-off + prompt regex |
