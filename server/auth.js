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
`);

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
    console.warn('[auth] SMTP_USER / SMTP_PASS not set — verification codes will only be logged + returned in the API response (dev mode).');
    return false;
  }
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  _transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass: pass.replace(/\s+/g, '') }, // strip spaces from App Password
  });
  console.log(`[auth] SMTP transporter ready: ${user} via ${host}:${port}`);
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
  console.log(`[auth] verification code for ${email}: ${code}`);
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
    console.log(`[auth] verification email sent to ${email}`);
    return true;
  } catch (err) {
    console.error(`[auth] failed to send verification email to ${email}:`, err.message);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────
function genCode() {
  // 6-digit zero-padded
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function makeToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function publicUser(user) {
  return { id: user.id, email: user.email, username: user.username, created_at: user.created_at };
}

// Express middleware: attaches req.user when a valid Bearer token is present.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match  = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Routes ───────────────────────────────────────────────────
function registerRoutes(app) {
  // ── Sign up: stage 1 — create pending signup, send code ────
  app.post('/api/auth/signup', async (req, res) => {
    const { email, username, password } = req.body || {};
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

    db.prepare(`
      INSERT INTO pending_signups (email, username, password_hash, code, code_expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        code = excluded.code,
        code_expires_at = excluded.code_expires_at
    `).run(emailNorm, userNorm, passwordHash, code, expiresAt);

    const sent = await sendVerificationEmail(emailNorm, code);
    if (!sent) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'smtp send failed', payload: { email: emailNorm } });
      return res.status(502).json({ error: 'Could not send verification email — try again in a minute' });
    }
    audit.log({ req, action: 'auth.signup.start', status: 'ok', payload: { email: emailNorm, username: userNorm } });
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

    const result = db.prepare(`
      INSERT INTO users (email, username, password_hash, email_verified)
      VALUES (?, ?, ?, 1)
    `).run(emailNorm, pending.username, pending.password_hash);
    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    audit.log({ req, user, action: 'auth.signup.verify', status: 'ok', targetType: 'user', targetId: user.id });
    res.json({ ok: true, token: makeToken(user), user: publicUser(user) });
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

  // ── Login: username OR email + password ────────────────────
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      audit.log({ req, action: 'auth.login', status: 'fail', error: 'missing fields' });
      return res.status(400).json({ error: 'username and password required' });
    }
    const ident = String(username).trim();

    const user = db.prepare(`
      SELECT * FROM users WHERE email = ? OR username = ? COLLATE NOCASE
    `).get(ident.toLowerCase(), ident);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      audit.log({ req, action: 'auth.login', status: 'fail', error: 'invalid credentials', payload: { ident } });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    audit.log({ req, user, action: 'auth.login', status: 'ok', targetType: 'user', targetId: user.id });
    res.json({ ok: true, token: makeToken(user), user: publicUser(user) });
  });

  // ── Whoami ─────────────────────────────────────────────────
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user) });
  });
}

module.exports = { registerRoutes, requireAuth };
