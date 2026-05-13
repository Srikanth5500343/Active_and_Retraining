/**
 * Smoke tests — exercise the most load-bearing routes without spinning the
 * full worker pool or hitting external services. Run with:
 *
 *   node --test test/smoke.test.js
 *
 * Required env:
 *   JWT_SECRET   — any non-empty string (overrides server/data/jwt.secret)
 *   NODE_ENV=test, PORT=0
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Background pollers (cmdb-ticket, port-poller wiring, log rotation timers)
// keep the event loop alive past the last test. Force-exit once all tests
// have reported — equivalent to Node 22's --test-force-exit flag but works
// on the Node 20 baseline the repo currently targets.
after(() => { setImmediate(() => process.exit(0)); });

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PORT = process.env.PORT || '0';
process.env.RACKTRACK_SKIP_WORKER_POOL = '1';

const { app } = require('../app');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function fetchPath(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

test('GET /healthz returns 200', async (t) => {
  const { server, port } = await listen();
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetchPath(port, '/healthz');
  assert.equal(res.status, 200);
});

test('GET /metrics returns Prometheus exposition', async (t) => {
  const { server, port } = await listen();
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetchPath(port, '/metrics');
  assert.equal(res.status, 200);
  assert.match(res.body, /^# HELP /m, 'metrics body should contain Prometheus HELP lines');
});

test('Protected API route rejects unauthenticated request', async (t) => {
  const { server, port } = await listen();
  t.after(() => new Promise((r) => server.close(r)));
  // /api/scans is auth-required; without a Bearer token it should reject
  // with 401 (or 403) — anything other than 2xx is acceptable here.
  const res = await fetchPath(port, '/api/scans');
  assert.ok(
    res.status === 401 || res.status === 403 || res.status === 404,
    `expected 401/403/404 for unauthenticated /api/scans, got ${res.status}`,
  );
});
