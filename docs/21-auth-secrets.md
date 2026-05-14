# 21. Auth + Secrets

## What it does (junior view)

Two related concerns covered here:

1. **User authentication** — who's logged in? JWT-based: user
   logs in with email + password, server returns a token, every
   subsequent request carries that token in the `Authorization`
   header.
2. **Secrets management** — how do we store passwords and keys
   without leaking them? Two layers: encrypted SSH credentials
   (used by the live-port probe) and environment-variable secrets
   (everything else).

The goal: a stolen `.env` file should not give the attacker
working SSH credentials. The encrypted blob in `.env` is useless
without the separate key (which is in a different file or env
var).

For ServiceNow, the current state is **HTTP Basic auth with
password in env** — flagged as a finding for any production
deployment. The fix is OAuth client-credentials grant, tracked
in [24-known-limits.md](24-known-limits.md).

## What it doesn't do

- It doesn't do SSO (SAML/OIDC). Users are local — email +
  password.
- It doesn't rotate keys automatically. The SSH credential key
  has no rotation flow today; rotating means decrypt with old
  key, re-encrypt with new key, and update the env / file.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `server/auth.js` | JWT issue + verify, login/signup/logout routes, role middleware |
| `server/lib/ssh-creds.js` | AES-256-GCM encrypted SSH credential store |
| `server/encrypt-creds.js` | CLI for encrypting credentials (one-shot setup) |
| `server/data/auth.db` | SQLite: users, tenants, sessions |
| `servicenow/.env` | ServiceNow Basic auth credentials |
| `server/.env`, `server/.env.key` | SSH creds blob + decryption key |

### User auth — JWT

`server/auth.js`. Standard pattern:

```js
// On login
const token = jwt.sign(
  { sub: user.id, tenant_id: user.tenant_id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '7d', issuer: 'racktrack' }
);

// On every request
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'auth required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}
```

Token shape:

```json
{
  "sub": 17,                         // user id
  "tenant_id": 3,
  "role": "engineer",                // admin | engineer | viewer
  "iat": 1715090400,
  "exp": 1715695200,
  "iss": "racktrack"
}
```

Stored client-side in localStorage (`racktrack:token`). Read on
mount and attached to every `authFetch` call by
`client/src/utils/api.js`.

### Roles

```js
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth required' });
    const userRole = req.user.role;
    const ranks = { viewer: 1, engineer: 2, admin: 3 };
    if ((ranks[userRole] || 0) < (ranks[role] || 0)) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    next();
  };
}
```

Composable with `tenant.requireRackOwnership` —
[20-multi-tenancy.md](20-multi-tenancy.md) shows the chain.

### Login / signup

```
POST /api/auth/login      { email, password } → { token, user }
POST /api/auth/signup     { email, password, tenantName? } → { token, user }
POST /api/auth/logout     (no-op server-side; client just drops the token)
GET  /api/auth/me         → { user } based on the token
POST /api/auth/refresh    → { token } if current is still valid
```

Password storage: bcrypt with cost 12 (`bcrypt.hash(password, 12)`).
No client-side password hashing — we rely on TLS for transport.

### SSH credential encryption

`server/lib/ssh-creds.js`. AES-256-GCM. Two separate places hold
the two halves:

| Half | Where | Notes |
|---|---|---|
| Encrypted blob | `server/.env`, var `SSH_CREDS_ENC=<base64>` | Safe to check into a private repo — useless without the key |
| Key | `SSH_CREDS_KEY` env var (preferred) or `server/.env.key` (fallback) | 32 bytes hex. **Never** committed |

Layout of `SSH_CREDS_ENC` once base64-decoded:
```
[12 bytes IV][16 bytes auth tag][N bytes ciphertext]
```

Plaintext is JSON:
```json
{
  "defaultUser": "admin",
  "defaultPassword": "...",
  "hostOverrides": {
    "192.168.1.13": { "user": "...", "password": "...", "enable": "..." }
  },
  "lastSuccessfulHost": "192.168.1.13"
}
```

### Encrypting on first setup

`server/encrypt-creds.js` is a one-shot CLI that:

1. Prompts for credentials (or reads JSON from stdin)
2. Generates a random 32-byte key
3. Encrypts the JSON with the key
4. Prints `SSH_CREDS_ENC=<base64>` (paste into `.env`)
5. Prints the key (paste into `SSH_CREDS_KEY` env var or
   `.env.key` file)

Reading on server boot:

```js
function loadKey() {
  const env = process.env.SSH_CREDS_KEY;
  if (env) return Buffer.from(env, 'hex');
  if (fs.existsSync(KEY_PATH)) {
    return Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  }
  throw new Error('SSH key missing — neither SSH_CREDS_KEY env nor .env.key file');
}

function decrypt() {
  const key = loadKey();
  const blob = parseEnv(ENV_PATH).SSH_CREDS_ENC;
  const buf  = Buffer.from(blob, 'base64');
  const iv   = buf.slice(0, 12);
  const tag  = buf.slice(12, 28);
  const ct   = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
}
```

Decrypted plaintext lives in process memory only. Never written
back to disk.

### ServiceNow auth (current state)

HTTP Basic auth, password in env:

```python
# servicenow/cmdb_apply.py:64
self.auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
```

Affects every script in `servicenow/` (8+ files). Fix is OAuth
client-credentials:

1. ServiceNow → System OAuth → Application Registry → New
   "Endpoint client (server-to-server)"
2. Get `client_id` + `client_secret`
3. Replace each `auth=(user, password)` with token-fetching
   helper:
   ```python
   def get_sn_token():
       r = requests.post(f"https://{SN_INSTANCE}/oauth_token.do",
                         data={"grant_type":"client_credentials",
                               "client_id":SN_CLIENT_ID,
                               "client_secret":SN_CLIENT_SECRET})
       return r.json()["access_token"]
   # ...
   headers = {"Authorization": f"Bearer {get_sn_token()}"}
   ```
4. Cache the token + refresh on 401

### Helmet + CORS + CSRF

`server/app.js` early in the file:

```js
app.use(helmet({
  contentSecurityPolicy: { directives: {...} },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
```

CORS origin list is read from env (`ALLOWED_ORIGINS=...,...`).
CSRF: not currently used because every authenticated request
carries a JWT in `Authorization` (cookie auth would need CSRF).

### Audit log

`server/audit.js` records every state-changing API call with:

- Timestamp
- User id, tenant id
- Action (`scan.create`, `cmdb.sync.applied`, `auth.login`,
  `auth.signup`, `feedback.created`, etc.)
- Status (`ok` / `fail`)
- Target type + id (rack id, ticket id, etc.)
- Optional payload (sanitised)
- Optional error string

Mirrored into the structured log stream by the observability
layer ([19-observability.md](19-observability.md)).

### Files in this feature

| File | Role |
|---|---|
| `server/auth.js` | JWT, bcrypt, login/signup/logout, role middleware |
| `server/lib/ssh-creds.js` | AES-256-GCM SSH cred store |
| `server/encrypt-creds.js` | One-shot encryption CLI |
| `server/audit.js` | Audit log writer |
| `server/data/auth.db` | SQLite: users, tenants, sessions |
| `servicenow/.env`, `server/.env`, `server/.env.key` | Secrets at rest |
| `client/src/AuthContext.jsx` | Client-side auth state + token storage |
| `client/src/utils/api.js` | `authFetch` helper that attaches the JWT |
