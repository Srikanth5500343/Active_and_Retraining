/**
 * Authentication module — SQLite + bcrypt + JWT.
 *
 * Storage:
 *   server/data/auth.db       SQLite database (users + pending_signups)
 *   server/data/jwt.secret    Random 64-byte secret, generated on first run
 *
 * Verification email goes out via SMTP (see getTransporter below). The 6-digit
 * code is also logged to the server console for debugging. If SMTP isn't
 * configured or the send fails, signup/resend return a 502 — the code is
 * never leaked in the API response.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const audit = require('./audit');
const { logger } = require('./lib/observability');

const dataDir   = path.join(__dirname, 'data');
const dbPath    = path.join(dataDir, 'auth.db');
const secretPath = path.join(dataDir, 'jwt.secret');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── JWT secret (generated once, persisted) ──────────────────
function loadOrCreateSecret() {
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = process.env.JWT_SECRET || loadOrCreateSecret();
const TOKEN_TTL  = '30d';

// ── Database schema ──────────────────────────────────────────
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pending_signups (
    email           TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    code            TEXT NOT NULL,
    code_expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    email           TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    code_expires_at INTEGER NOT NULL,
    requested_at    INTEGER NOT NULL
  );
`);

// ── Tenant migration ─────────────────────────────────────────
// Adds tenant_id to users (and the same column to other tables that
// already exist). Idempotent: detects whether the column is already
// there and skips the ALTER if so. On first run, creates a `default`
// tenant and backfills every existing user / audit row into it so the
// app keeps working for legacy data.
function _hasColumn(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}

function _ensureColumn(table, col, ddl) {
  if (!_hasColumn(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

(function migrateTenants() {
  // Default tenant exists exactly once
  let defTenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get('default');
  if (!defTenant) {
    const r = db.prepare(
      'INSERT INTO tenants (slug, name) VALUES (?, ?)'
    ).run('default', 'Default');
    defTenant = { id: r.lastInsertRowid, slug: 'default', name: 'Default' };
  }
  const defaultTenantId = defTenant.id;

  // users.tenant_id (per-user tenant membership). Default to the
  // `default` tenant for any existing users so they don't get locked out.
  _ensureColumn('users', 'tenant_id',
    'tenant_id INTEGER REFERENCES tenants(id)');
  db.prepare('UPDATE users SET tenant_id = ? WHERE tenant_id IS NULL')
    .run(defaultTenantId);

  // pending_signups.tenant_id — captured at the verify step so a user
  // can sign up into a specific tenant (invite flow later).
  _ensureColumn('pending_signups', 'tenant_id',
    'tenant_id INTEGER REFERENCES tenants(id)');

  // audit_log.tenant_id — every audit row carries the actor's tenant
  // so org-wide audit queries are tenant-scoped.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'`).get()) {
    _ensureColumn('audit_log', 'tenant_id',
      'tenant_id INTEGER REFERENCES tenants(id)');
    db.prepare('UPDATE audit_log SET tenant_id = ? WHERE tenant_id IS NULL')
      .run(defaultTenantId);
  }

  // rack_owners — many-to-many between tenants and racks. A rack id is
  // a SHA-256 of the source image, so two tenants scanning the same
  // image get the same RK-id; ownership is recorded per-tenant so the
  // shared output dir doesn't leak.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rack_owners (
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      rack_id     TEXT    NOT NULL,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, rack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rack_owners_rack ON rack_owners(rack_id);
  `);

  // rack_groups — a multi-rack scan: one video upload that produced N
  // best-frames. Each member rack_id still lives independently in the
  // outputs/ dir and the regular rack APIs work on it; the group is
  // just a parent record so the UI can show "this rack was scanned
  // alongside Rack 2 and Rack 3 in the same video".
  db.exec(`
    CREATE TABLE IF NOT EXISTS rack_groups (
      id           TEXT    PRIMARY KEY,
      video_hash   TEXT    NOT NULL,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rack_group_members (
      group_id     TEXT    NOT NULL REFERENCES rack_groups(id) ON DELETE CASCADE,
      rack_id      TEXT    NOT NULL,
      position     INTEGER NOT NULL,
      label        TEXT    NOT NULL,
      device_count INTEGER,
      score        REAL,
      PRIMARY KEY (group_id, rack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rack_group_members_rack
      ON rack_group_members(rack_id);
    CREATE INDEX IF NOT EXISTS idx_rack_groups_tenant_created
      ON rack_groups(tenant_id, created_at DESC);
  `);

  logger.info({
    event: 'auth.tenant_migration',
    defaultTenantId, defaultTenantSlug: defTenant.slug,
  }, 'tenant schema ready');
})();

// Public so other modules (lib/tenant.js, audit.js) can resolve the
// default tenant when migrating legacy rows.
function getDefaultTenantId() {
  const t = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('default');
  return t?.id;
}

// Tenant CRUD — the bare minimum to support signup. A full tenant
// admin UI (name change, member invite, deletion) is a later add.
function findTenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

function createTenant(name) {
  // Slug = lowercase ascii + dash, with a 4-char random suffix to
  // guarantee uniqueness (two "Acme Corp" signups don't collide).
  const base = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'tenant';
  const suffix = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  const slug = `${base}-${suffix}`;
  const r = db.prepare(
    'INSERT INTO tenants (slug, name) VALUES (?, ?)'
  ).run(slug, String(name).trim().slice(0, 120));
  return { id: r.lastInsertRowid, slug, name };
}

// ── Validation ───────────────────────────────────────────────
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// ≥ 8 chars, an upper, a lower, a digit, a special
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a special character';
  return null;
}

// ── Email (nodemailer) ───────────────────────────────────────
// Reads SMTP config from env. For Gmail, use an App Password (16 chars,
// requires 2-Step Verification on the Google account):
//   SMTP_HOST  smtp.gmail.com        (default)
//   SMTP_PORT  465                   (default — SSL; use 587 for STARTTLS)
//   SMTP_USER  your.address@gmail.com
//   SMTP_PASS  abcd efgh ijkl mnop   (App Password — spaces are fine)
//   SMTP_FROM  optional display name <addr>; defaults to SMTP_USER
let _transporter = null;
function getTransporter() {
  if (_transporter !== null) return _transporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    _transporter = false; // marker = "no SMTP configured"
    logger.warn('[auth] SMTP_USER / SMTP_PASS not set — verification codes will only be logged + returned in the API response (dev mode).');
    return false;
  }
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  _transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass: pass.replace(/\s+/g, '') }, // strip spaces from App Password
  });
  logger.info(`[auth] SMTP transporter ready: ${user} via ${host}:${port}`);
  return _transporter;
}

function emailHtml(code) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0EFF5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:48px 20px;">
    <div style="background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(75,69,160,0.08),0 1px 3px rgba(75,69,160,0.06);">
      <div style="background:linear-gradient(135deg,#5B54B0 0%,#7B75C0 100%);padding:28px 32px;text-align:center;">
        <div style="display:inline-block;font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;color:#FFFFFF;font-weight:700;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:#FFFFFF;vertical-align:middle;margin-right:10px;margin-bottom:2px;opacity:.85;"></span>RackTrack
        </div>
      </div>
      <div style="padding:40px 36px 36px;text-align:center;">
        <h1 style="margin:0 0 10px;font-size:1.5rem;font-weight:700;color:#1A1A2E;letter-spacing:-0.015em;">Verify your email</h1>
        <p style="margin:0 0 32px;color:#4A4A5A;font-size:.94rem;line-height:1.6;">Enter this code in the app to finish creating your account.<br>It expires in 1 minute.</p>
        <div style="display:inline-block;padding:20px 28px;border-radius:12px;background:#F8F7FB;border:1px solid rgba(200,196,228,0.55);">
          <div style="font-family:'SF Mono','Roboto Mono',Menlo,Consolas,monospace;font-size:2rem;font-weight:700;letter-spacing:.42em;color:#5B54B0;padding-left:.42em;">${code}</div>
        </div>
        <div style="margin:32px auto 0;width:36px;height:2px;background:linear-gradient(90deg,transparent,rgba(91,84,176,0.35),transparent);"></div>
        <p style="margin:24px 0 0;color:#6B6B7A;font-size:.82rem;line-height:1.5;">Didn't request this? You can safely ignore this email — your account stays untouched.</p>
      </div>
    </div>
    <p style="text-align:center;color:#8A8A99;font-size:.74rem;margin-top:22px;letter-spacing:.02em;">Sent automatically by RackTrack — please do not reply.</p>
  </div>
</body></html>`;
}

// Returns true if email actually went out via SMTP, false otherwise.
async function sendVerificationEmail(email, code) {
  logger.info(`[auth] verification code for ${email}: ${code}`);
  const t = getTransporter();
  if (!t) return false;
  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    await t.sendMail({
      from,
      to: email,
      subject: `Your RackTrack verification code: ${code}`,
      text: `Your RackTrack verification code is ${code}. It expires in 1 minute.`,
      html: emailHtml(code),
    });
    logger.info(`[auth] verification email sent to ${email}`);
    return true;
  } catch (err) {
    logger.error(`[auth] failed to send verification email to ${email}:`, err.message);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────
function genCode() {
  // 6-digit zero-padded
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function makeToken(user) {
  // tenantId baked into the JWT so middleware can read it without a DB
  // round-trip on every request.
  return jwt.sign(
    { sub: user.id, username: user.username, tenantId: user.tenant_id },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function publicUser(user, tenant = null) {
  const out = {
    id: user.id, email: user.email, username: user.username,
    created_at: user.created_at,
    tenant_id: user.tenant_id,
  };
  if (tenant) {
    out.tenant = { id: tenant.id, slug: tenant.slug, name: tenant.name };
  } else if (user.tenant_id) {
    const t = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?')
                .get(user.tenant_id);
    if (t) out.tenant = t;
  }
  return out;
}

// Express middleware: attaches req.user when a valid Bearer token is present.
// req.user is the full user row PLUS .tenant ({id, slug, name}) so route
// handlers don't have to look it up themselves.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match  = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    // Defensive: a token issued before tenancy landed won't carry tenantId.
    // Use the user's row value (backfilled to default tenant) instead.
    if (user.tenant_id) {
      const t = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?')
                  .get(user.tenant_id);
      user.tenant = t || null;
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Routes ───────────────────────────────────────────────────
function registerRoutes(app) {
  // ── Sign up: stage 1 — create pending signup, send code ────
  // Now takes an optional `company` field. If absent / blank, the user
  // joins the `default` tenant (preserves the legacy behavior). If
  // present, the verify step creates a fresh tenant for that company.
  app.post('/api/auth/signup', async (req, res) => {
    const { email, username, password, company } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'invalid email', payload: { email } });
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!username || !USERNAME_RE.test(String(username).trim())) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'invalid username', payload: { email, username } });
      return res.status(400).json({ error: 'Username must be 3–32 chars (letters, digits, . _ -)' });
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: pwErr, payload: { email, username } });
      return res.status(400).json({ error: pwErr });
    }
    // Company name is REQUIRED — every user must belong to a real tenant.
    // Without this, blank-company signups would all collapse into the
    // shared `default` tenant, which is exactly the data-leak multi-
    // tenancy is supposed to prevent.
    const companyNorm = String(company || '').trim().slice(0, 120);
    if (!companyNorm || companyNorm.length < 2) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail',
        error: 'company required', payload: { email, username } });
      return res.status(400).json({ error: 'Company name is required (at least 2 characters)' });
    }

    const emailNorm = String(email).trim().toLowerCase();
    const userNorm  = String(username).trim();

    // Reject if either email or username already maps to a verified user
    const dupEmail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(emailNorm);
    if (dupEmail) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'email taken', payload: { email: emailNorm } });
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    const dupUser = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(userNorm);
    if (dupUser) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'username taken', payload: { username: userNorm } });
      return res.status(409).json({ error: 'That username is taken' });
    }

    const code = genCode();
    const passwordHash = bcrypt.hashSync(password, 10);
    const expiresAt = Date.now() + 60 * 1000; // 1 minute

    // Stash the company name on the pending row so the verify step
    // (which is the only place that actually creates persistent records)
    // has it without re-reading from request input.
    db.prepare(`
      INSERT INTO pending_signups (email, username, password_hash, code, code_expires_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(email) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        code = excluded.code,
        code_expires_at = excluded.code_expires_at,
        tenant_id = NULL
    `).run(emailNorm, userNorm, passwordHash, code, expiresAt);
    // We use a side-channel column (we don't have a `company` column on
    // pending_signups) — easiest is to reuse the `username` row. Add a
    // dedicated `company` column the cheap way: only if pending wasn't
    // already that shape.
    if (!_hasColumn('pending_signups', 'company')) {
      db.exec('ALTER TABLE pending_signups ADD COLUMN company TEXT');
    }
    db.prepare('UPDATE pending_signups SET company = ? WHERE email = ?')
      .run(companyNorm || null, emailNorm);

    const sent = await sendVerificationEmail(emailNorm, code);
    if (!sent) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'smtp send failed', payload: { email: emailNorm } });
      return res.status(502).json({ error: 'Could not send verification email — try again in a minute' });
    }
    audit.log({ req, action: 'auth.signup.start', status: 'ok', payload: { email: emailNorm, username: userNorm, company: companyNorm || null } });
    res.json({ ok: true, email: emailNorm, sent: true });
  });

  // ── Sign up: stage 2 — verify code → create user ───────────
  app.post('/api/auth/verify', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'missing fields' });
      return res.status(400).json({ error: 'email and code required' });
    }
    const emailNorm = String(email).trim().toLowerCase();

    const pending = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(emailNorm);
    if (!pending) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'no pending', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending signup for that email' });
    }
    if (Date.now() > pending.code_expires_at) {
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Verification code has expired — sign up again' });
    }
    if (String(code).trim() !== pending.code) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect verification code' });
    }

    // Final dup check (someone else may have raced us)
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(emailNorm)) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'email taken (race)', payload: { email: emailNorm } });
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(pending.username)) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'username taken (race)', payload: { username: pending.username } });
      return res.status(409).json({ error: 'That username is taken' });
    }

    // Every user MUST belong to a real tenant. Signup validates that
    // `company` is non-empty, so a pending row without one means a
    // pre-tenancy client somehow snuck in — refuse and force a fresh
    // signup. The `default` tenant exists only as a backstop for
    // legacy users that pre-date this migration.
    if (!pending.company || !String(pending.company).trim()) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail',
        error: 'pending row missing company', payload: { email: emailNorm } });
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);
      return res.status(400).json({
        error: 'Signup is missing a company name. Please sign up again.',
      });
    }
    const tenant = createTenant(pending.company);

    const result = db.prepare(`
      INSERT INTO users (email, username, password_hash, email_verified, tenant_id)
      VALUES (?, ?, ?, 1, ?)
    `).run(emailNorm, pending.username, pending.password_hash, tenant.id);
    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    user.tenant = tenant;  // attach so audit + token + response see it
    audit.log({
      req, user, action: 'auth.signup.verify', status: 'ok',
      targetType: 'user', targetId: user.id,
      payload: { tenant_id: tenant.id, tenant_slug: tenant.slug, new_tenant: !!pending.company },
    });
    res.json({ ok: true, token: makeToken(user), user: publicUser(user, tenant) });
  });

  // ── Resend verification code ───────────────────────────────
  app.post('/api/auth/resend-code', async (req, res) => {
    const { email } = req.body || {};
    if (!email) {
      audit.log({ req, action: 'auth.resend', status: 'fail', error: 'missing email' });
      return res.status(400).json({ error: 'email required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const pending = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(emailNorm);
    if (!pending) {
      audit.log({ req, action: 'auth.resend', status: 'fail', error: 'no pending', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending signup for that email' });
    }

    const code = genCode();
    const expiresAt = Date.now() + 60 * 1000; // 1 minute
    db.prepare('UPDATE pending_signups SET code = ?, code_expires_at = ? WHERE email = ?')
      .run(code, expiresAt, emailNorm);
    const sent = await sendVerificationEmail(emailNorm, code);
    if (!sent) {
      audit.log({ req, action: 'auth.resend', status: 'fail', error: 'smtp send failed', payload: { email: emailNorm } });
      return res.status(502).json({ error: 'Could not send verification email — try again in a minute' });
    }
    audit.log({ req, action: 'auth.resend', status: 'ok', payload: { email: emailNorm } });
    res.json({ ok: true, sent: true });
  });

  // ── Login: username OR email + password (+ optional tenant) ─
  // Tenant is optional but, when provided, scopes the lookup so that the
  // same username can exist in different orgs without ambiguity (the
  // existing UNIQUE constraint on users.username still applies globally,
  // but the per-tenant scoping prevents one org's user from signing in
  // with another org's stolen credentials if uniqueness is ever relaxed).
  // Match is case-insensitive against tenant name OR slug.
  app.post('/api/auth/login', (req, res) => {
    const { username, password, tenant } = req.body || {};
    if (!username || !password) {
      audit.log({ req, action: 'auth.login', status: 'fail', error: 'missing fields' });
      return res.status(400).json({ error: 'username and password required' });
    }
    const ident = String(username).trim();
    const tenantArg = String(tenant || '').trim();

    let tenantRow = null;
    if (tenantArg) {
      tenantRow = db.prepare(`
        SELECT * FROM tenants
        WHERE slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
      `).get(tenantArg, tenantArg);
      if (!tenantRow) {
        audit.log({ req, action: 'auth.login', status: 'fail',
          error: 'unknown tenant', payload: { ident, tenant: tenantArg } });
        return res.status(401).json({ error: 'Invalid organization or credentials' });
      }
    }

    const user = tenantRow
      ? db.prepare(`
          SELECT * FROM users
          WHERE (email = ? OR username = ? COLLATE NOCASE)
            AND tenant_id = ?
        `).get(ident.toLowerCase(), ident, tenantRow.id)
      : db.prepare(`
          SELECT * FROM users WHERE email = ? OR username = ? COLLATE NOCASE
        `).get(ident.toLowerCase(), ident);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      audit.log({ req, action: 'auth.login', status: 'fail',
        error: 'invalid credentials',
        payload: { ident, tenant: tenantArg || null } });
      return res.status(401).json({ error: tenantArg ? 'Invalid organization or credentials' : 'Invalid username or password' });
    }
    audit.log({ req, user, action: 'auth.login', status: 'ok',
      targetType: 'user', targetId: user.id,
      payload: { tenant_id: user.tenant_id } });
    res.json({ ok: true, token: makeToken(user), user: publicUser(user) });
  });

  // ── Forgot password — stage 1: request a reset code ─────────
  // Always returns 200 (even when the email is unknown) so attackers can't
  // enumerate registered emails. The code is only created/sent when a user
  // actually exists for that email. 1-minute expiry to match signup.
  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      audit.log({ req, action: 'auth.forgot_password.start', status: 'fail',
        error: 'invalid email', payload: { email } });
      return res.status(400).json({ error: 'Valid email required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);

    if (user) {
      const code = genCode();
      const expiresAt = Date.now() + 60 * 1000; // 1 minute
      db.prepare(`
        INSERT INTO password_resets (email, code, code_expires_at, requested_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          code = excluded.code,
          code_expires_at = excluded.code_expires_at,
          requested_at = excluded.requested_at
      `).run(emailNorm, code, expiresAt, Date.now());

      // Reuse the verification email template — same look, different copy
      // would be nicer but for now the user just sees a 6-digit code.
      const sent = await sendVerificationEmail(emailNorm, code);
      audit.log({ req, action: 'auth.forgot_password.start',
        status: sent ? 'ok' : 'partial',
        payload: { email: emailNorm, sent } });
    } else {
      // Don't reveal that the email isn't registered.
      audit.log({ req, action: 'auth.forgot_password.start',
        status: 'ok', payload: { email: emailNorm, sent: false, reason: 'no_user' } });
    }

    // Always 200 with the same shape — silent on existence.
    res.json({ ok: true, email: emailNorm });
  });

  // ── Forgot password — stage 1.5: verify the code WITHOUT consuming it ─
  // The UI uses this after the user enters the 6-digit code, so it can show
  // a "Do you want to change your password?" confirmation step before
  // collecting the new password. The reset row stays in the DB and is
  // consumed by /reset-password later if the user proceeds.
  app.post('/api/auth/verify-reset-code', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'missing fields' });
      return res.status(400).json({ error: 'email and code required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const reset = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(emailNorm);
    if (!reset) {
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'no pending reset', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending reset for that email — request a new code' });
    }
    if (Date.now() > reset.code_expires_at) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Reset code has expired — request a new one' });
    }
    if (String(code).trim() !== reset.code) {
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect reset code' });
    }
    audit.log({ req, action: 'auth.forgot_password.verify', status: 'ok',
      payload: { email: emailNorm } });
    res.json({ ok: true });
  });

  // ── Forgot password — alternative stage 2: skip the password change and
  // sign in directly with the OTP. The 6-digit code is treated as proof of
  // identity (the user controls the inbox), so we issue a fresh token
  // without touching password_hash. The reset row is consumed so the same
  // code can't be replayed for another login.
  app.post('/api/auth/login-with-code', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'missing fields' });
      return res.status(400).json({ error: 'email and code required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const reset = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(emailNorm);
    if (!reset) {
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'no pending reset', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending reset for that email — request a new code' });
    }
    if (Date.now() > reset.code_expires_at) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Reset code has expired — request a new one' });
    }
    if (String(code).trim() !== reset.code) {
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect reset code' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);
    if (!user) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'user gone', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No account exists for that email' });
    }

    // Consume the reset row — same code can't be replayed.
    db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);

    audit.log({ req, user, action: 'auth.forgot_password.login_with_code',
      status: 'ok', targetType: 'user', targetId: user.id });

    res.json({ ok: true, token: makeToken(user), user: publicUser(user) });
  });

  // ── Forgot password — stage 2: verify code + set new password ─
  app.post('/api/auth/reset-password', (req, res) => {
    const { email, code, password } = req.body || {};
    if (!email || !code || !password) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'missing fields' });
      return res.status(400).json({ error: 'email, code, and new password required' });
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: pwErr, payload: { email } });
      return res.status(400).json({ error: pwErr });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const reset = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(emailNorm);
    if (!reset) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'no pending reset', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending reset for that email — request a new code' });
    }
    if (Date.now() > reset.code_expires_at) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Reset code has expired — request a new one' });
    }
    if (String(code).trim() !== reset.code) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect reset code' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);
    if (!user) {
      // Pending reset for a user that was deleted between stages.
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'user gone', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No account exists for that email' });
    }

    const newHash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);

    audit.log({ req, user, action: 'auth.forgot_password.reset',
      status: 'ok', targetType: 'user', targetId: user.id });

    // Issue a fresh token so the client can sign the user in immediately
    // after they reset — no second login round-trip needed.
    res.json({ ok: true, token: makeToken(user), user: publicUser(user) });
  });

  // ── Whoami ─────────────────────────────────────────────────
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user) });
  });
}

module.exports = { registerRoutes, requireAuth };
