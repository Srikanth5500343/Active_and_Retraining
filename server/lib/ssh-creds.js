// SSH credential store backed by an AES-256-GCM encrypted blob in .env.
//
// Layout:
//   server/.env       SSH_CREDS_ENC=<base64(iv|tag|ciphertext)>
//   server/.env.key   <64-char hex>   (32-byte key, separate from the blob)
//
// The key can also come from the SSH_CREDS_KEY env var (takes precedence),
// which is the preferred path for Docker / systemd / cloud secret managers.
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const ENV_PATH   = path.join(SERVER_DIR, '.env');
const KEY_PATH   = path.join(SERVER_DIR, '.env.key');
const ENV_VAR    = 'SSH_CREDS_ENC';

function parseEnvValue(envText, name) {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm');
  const m = envText.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function loadKey() {
  const envKey = process.env.SSH_CREDS_KEY && process.env.SSH_CREDS_KEY.trim();
  if (envKey) return Buffer.from(envKey, 'hex');
  if (!fs.existsSync(KEY_PATH)) return null;
  const hex = fs.readFileSync(KEY_PATH, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${KEY_PATH} must contain a 32-byte hex key (64 chars)`);
  }
  return Buffer.from(hex, 'hex');
}

function loadEncBlob() {
  if (process.env[ENV_VAR]) return process.env[ENV_VAR].trim();
  if (!fs.existsSync(ENV_PATH)) return null;
  return parseEnvValue(fs.readFileSync(ENV_PATH, 'utf8'), ENV_VAR);
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(blobB64, key) {
  const buf = Buffer.from(blobB64, 'base64');
  if (buf.length < 28) throw new Error('ciphertext too short');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function writeEnvBlob(blobB64) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const line = `${ENV_VAR}=${blobB64}`;
  if (new RegExp(`^\\s*${ENV_VAR}\\s*=`, 'm').test(text)) {
    text = text.replace(new RegExp(`^\\s*${ENV_VAR}\\s*=.*$`, 'm'), line);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += line + '\n';
  }
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
}

function writeKey(keyHex) {
  fs.writeFileSync(KEY_PATH, keyHex + '\n', { mode: 0o600 });
}

let cached = null;
function getCreds() {
  if (cached) return cached;
  const key  = loadKey();
  const blob = loadEncBlob();
  if (!key || !blob) {
    cached = {};
    return cached;
  }
  try {
    cached = JSON.parse(decrypt(blob, key));
  } catch (err) {
    console.error('[ssh-creds] decrypt failed — ignoring env creds:', err.message);
    cached = {};
  }
  return cached;
}

// Normalise a vendor key for lookup so "tp-link", "tplink", "TP_Link" all
// resolve to the same stored entry. This avoids one of the most common
// user errors (storing creds under a slightly different key than the UI
// uses). Comparison is lowercase + strip everything that isn't a-z0-9.
function normVendor(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Returns { username, password, enablePassword } for a vendor, falling back to
// `default` entry, or null if nothing is configured. Lookup is tolerant of
// casing and dash/underscore differences.
function getForVendor(vendor) {
  const all = getCreds();
  if (!vendor) return all.default || null;
  // Exact match first (cheap and preserves original behaviour)
  if (all[vendor]) return all[vendor];
  // Then try normalised match against every stored key
  const want = normVendor(vendor);
  for (const k of Object.keys(all)) {
    if (normVendor(k) === want) return all[k];
  }
  return all.default || null;
}

function clearCache() { cached = null; }

module.exports = {
  getCreds, getForVendor, clearCache,
  encrypt, decrypt,
  writeEnvBlob, writeKey,
  KEY_PATH, ENV_PATH, ENV_VAR,
};
