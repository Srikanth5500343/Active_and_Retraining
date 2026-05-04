#!/usr/bin/env node
// Manage SSH credentials stored in server/.env as an AES-256-GCM blob.
//
// Usage:
//   node encrypt-creds.js init
//       Create a new key in server/.env.key if one does not already exist.
//
//   node encrypt-creds.js set <vendor>
//       Interactively prompt for username / password / enable password and
//       encrypt them under the given vendor name (e.g. tp-link, cisco-ios).
//
//   node encrypt-creds.js remove <vendor>
//       Drop a vendor entry.
//
//   node encrypt-creds.js show
//       Print the decrypted creds with passwords masked.
//
//   node encrypt-creds.js import <file.json>
//       Replace the whole blob with the contents of a JSON file.
const crypto = require('crypto');
const fs     = require('fs');
const readline = require('readline');
const {
  encrypt, decrypt, writeEnvBlob, writeKey,
  KEY_PATH, ENV_PATH, ENV_VAR, clearCache,
} = require('./lib/ssh-creds');

function keyExists() { return fs.existsSync(KEY_PATH); }

function loadKeyOrDie() {
  if (!keyExists()) {
    console.error(`Missing ${KEY_PATH}. Run: node encrypt-creds.js init`);
    process.exit(1);
  }
  const hex = fs.readFileSync(KEY_PATH, 'utf8').trim();
  return Buffer.from(hex, 'hex');
}

function loadBlobOrEmpty(key) {
  if (!fs.existsSync(ENV_PATH)) return {};
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const m = text.match(new RegExp(`^\\s*${ENV_VAR}\\s*=\\s*(.*)$`, 'm'));
  if (!m) return {};
  const blob = m[1].trim().replace(/^["']|["']$/g, '');
  if (!blob) return {};
  try { return JSON.parse(decrypt(blob, key)); }
  catch (e) {
    console.error(`Could not decrypt existing ${ENV_VAR} — wrong key?`, e.message);
    process.exit(1);
  }
}

function saveBlob(key, obj) {
  writeEnvBlob(encrypt(JSON.stringify(obj), key));
  clearCache();
}

function mask(s) {
  if (!s) return '';
  if (s.length <= 2) return '*'.repeat(s.length);
  return s[0] + '*'.repeat(Math.max(1, s.length - 2)) + s[s.length - 1];
}

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Best-effort password prompt that suppresses echo on TTYs.
      process.stdout.write(question);
      let input = '';
      const onData = (ch) => {
        ch = ch.toString('utf8');
        if (ch === '\n' || ch === '\r' || ch === '') {
          process.stdin.removeListener('data', onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (ch === '') { // Ctrl-C
          process.exit(130);
        } else if (ch === '' || ch === '\b') {
          if (input.length) input = input.slice(0, -1);
        } else {
          input += ch;
        }
      };
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (ans) => { rl.close(); resolve(ans); });
    }
  });
}

async function cmdInit() {
  if (keyExists()) {
    console.log(`Key already exists at ${KEY_PATH} — leaving it untouched.`);
    return;
  }
  const hex = crypto.randomBytes(32).toString('hex');
  writeKey(hex);
  console.log(`Generated new 32-byte key at ${KEY_PATH} (mode 0600).`);
  console.log('Back this file up separately from .env; losing it means re-entering every credential.');
}

async function cmdSet(vendor) {
  if (!vendor) { console.error('Usage: node encrypt-creds.js set <vendor>'); process.exit(1); }
  if (!keyExists()) await cmdInit();
  const key = loadKeyOrDie();
  const creds = loadBlobOrEmpty(key);
  const existing = creds[vendor] || {};
  const username = (await prompt(`Username [${existing.username || ''}]: `)).trim() || existing.username || '';
  const password = await prompt(`Password: `, { hidden: true });
  const enablePassword = await prompt(`Enable password (blank to skip): `, { hidden: true });
  if (!username || !password) {
    console.error('Username and password are required.'); process.exit(1);
  }
  creds[vendor] = { username, password, ...(enablePassword ? { enablePassword } : {}) };
  saveBlob(key, creds);
  console.log(`Saved credentials for "${vendor}" to ${ENV_PATH}.`);
}

async function cmdRemove(vendor) {
  const key = loadKeyOrDie();
  const creds = loadBlobOrEmpty(key);
  if (!(vendor in creds)) { console.log(`No entry for "${vendor}".`); return; }
  delete creds[vendor];
  saveBlob(key, creds);
  console.log(`Removed "${vendor}".`);
}

async function cmdShow() {
  const key = loadKeyOrDie();
  const creds = loadBlobOrEmpty(key);
  if (!Object.keys(creds).length) { console.log('(no credentials stored)'); return; }
  const masked = {};
  for (const [k, v] of Object.entries(creds)) {
    masked[k] = {
      username: v.username,
      password: mask(v.password),
      ...(v.enablePassword ? { enablePassword: mask(v.enablePassword) } : {}),
    };
  }
  console.log(JSON.stringify(masked, null, 2));
}

async function cmdImport(file) {
  if (!file) { console.error('Usage: node encrypt-creds.js import <file.json>'); process.exit(1); }
  if (!keyExists()) await cmdInit();
  const key = loadKeyOrDie();
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  saveBlob(key, obj);
  console.log(`Imported ${Object.keys(obj).length} vendor entries into ${ENV_PATH}.`);
}

(async () => {
  const [,, cmd, ...args] = process.argv;
  switch (cmd) {
    case 'init':   await cmdInit(); break;
    case 'set':    await cmdSet(args[0]); break;
    case 'remove': await cmdRemove(args[0]); break;
    case 'show':   await cmdShow(); break;
    case 'import': await cmdImport(args[0]); break;
    default:
      console.error('Usage: node encrypt-creds.js <init|set|remove|show|import> [args]');
      process.exit(1);
  }
})().catch(err => { console.error(err); process.exit(1); });
