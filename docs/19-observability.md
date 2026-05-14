# 19. Observability — logs, metrics, tracing

## What it does (junior view)

When something breaks in production, observability is what tells
you **what broke, when, and why**. This app has three pillars:

1. **Structured logs** — every interesting event is a JSON row,
   not a print statement. Every log line in a request's lifecycle
   carries the same `requestId`, so you can `grep` one user's
   journey from request start to error.
2. **Metrics** — counters and histograms exported in Prometheus
   format at `/metrics`. Histograms for HTTP request duration,
   pipeline duration, ML inference duration. Counters for errors
   per endpoint, business events (scans created, CMDB syncs,
   shares).
3. **Tracing** — `withSpan('name', async fn)` wraps any async
   function, times it, logs start/end with the requestId, and
   bumps an error counter on throw.

Plus an **audit-log mirror** so security-relevant events
(authentication, CMDB writes) get logged in two places: the
structured log stream and a separate immutable audit file.

The goal: when a user says "scans were slow this morning," you
have a histogram you can look at, not vibes. When a user says
"my CMDB push failed," you have a request ID you can use to find
every log line for that exact request.

## What it doesn't do

- It doesn't ship logs to a SaaS (Datadog, New Relic, etc.) by
  default. Logs go to stdout in JSON; the deployment picks where
  they end up.
- It doesn't auto-instrument outgoing HTTP calls. Pipeline
  subprocesses are timed via `withSpan`; vendor scrapes inside
  Python are not yet instrumented (see [24-known-limits.md](24-known-limits.md)).
- It doesn't define SLOs. Histograms are there; the SLO targets
  (p95 < N ms) are an org decision, not a code constant.

---

## Technical detail (lead view)

### File

`server/lib/observability.js`. ~600 lines. Single-import API:

```js
const o11y = require('./lib/observability');
o11y.logger.info({ rackId, n_devices }, 'scan completed');
await o11y.withSpan('pipeline.analyze', async (log) => { ... });
o11y.recordEvent('scan.created', { rackId });
```

### Wiring (in `server/app.js`)

```js
const o11y = require('./lib/observability');
app.use(o11y.requestId);     // first
app.use(o11y.httpLogger);    // logs every request/response
app.use(o11y.httpMetrics);   // counts every request/response
// ...routes...
app.get('/metrics', o11y.metricsHandler);
app.get('/healthz',  o11y.healthHandler);
app.get('/readyz',   o11y.readinessHandler);
```

### Logging — pino + redaction

Backend: `pino` with JSON output. Configured for:

- Pretty-printing in dev (`pino-pretty`) when stdout is a TTY,
  raw JSON in production
- Built-in serializers for `req`, `res`, `err`
- **Redaction paths** so secrets never hit the log stream:

  ```js
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentVersion',     // user-supplied; could leak per scan
      '*.SN_PASSWORD',
      '*.SSH_CREDS_KEY',
      'env.SSH_CREDS_KEY',
    ],
    censor: '[REDACTED]',
  }
  ```

- Per-request child logger via `req.log` so every log line in
  that request's lifecycle carries `requestId`, `userId`,
  `tenantId`.

### `requestId` middleware

```js
function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  req.log = logger.child({ requestId: req.id, userId: req.user?.id, tenantId: req.user?.tenant_id });
  next();
}
```

Echoes `x-request-id` back so the client can log it too. Useful
for "user reports problem at 14:03; their request ID was X;
grep X in logs."

### Metrics — prom-client

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status_class` | every request |
| `http_request_duration_seconds` | histogram | same labels | response time |
| `http_in_flight` | gauge | — | concurrent requests |
| `http_errors_total` | counter | `route`, `status` | 4xx + 5xx |
| `op_duration_seconds` | histogram | `name`, `status` | every `withSpan` call |
| `op_errors_total` | counter | `name` | thrown errors in `withSpan` |
| `business_events_total` | counter | `event` | scan.created, cmdb.sync.applied, … |

Histogram buckets are tuned for an Express+pipeline app:
`[0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120]` seconds. The
30/60/120s buckets exist because pipeline subprocesses can
realistically take that long.

`/metrics` is wide-open by default — restrict via reverse-proxy
or basic auth in production.

### `withSpan(name, fn)`

```js
async function withSpan(name, fn) {
  const start = Date.now();
  const log = currentRequestLog().child({ span: name });
  log.debug('span:start');
  try {
    const result = await fn(log);
    const ms = Date.now() - start;
    opDuration.observe({ name, status: 'ok' }, ms / 1000);
    log.debug({ duration_ms: ms }, 'span:end');
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    opDuration.observe({ name, status: 'error' }, ms / 1000);
    opErrors.inc({ name });
    log.error({ duration_ms: ms, err: err.message }, 'span:error');
    throw err;
  }
}
```

Use it around any non-trivial async block:

```js
const result = await o11y.withSpan('pipeline.analyze', async (log) => {
  log.info({ rackId }, 'spawning pipeline');
  return runPipelineAnalyze(imagePath, rackDir);
});
```

`currentRequestLog()` uses async-local-storage to find the
per-request logger; works across `await` boundaries without
needing to thread `log` through every function signature.

### Process-level handlers

```js
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  // optionally trigger graceful-shutdown sequence
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
```

Without these, Node would silently exit on an uncaught throw or
a rejected promise — you'd see "process died" in your container
logs with no clue why.

### Audit mirroring

`server/audit.js` was the original audit log (per-action records
in a separate file). The observability module mirrors every
`audit.log(...)` call into the structured log stream too, so:

- Compliance review reads the dedicated audit file
- Operations search the structured log stream
- Both contain the same events with the same correlation IDs

`o11y.recordEvent(name, fields)` is a convenience wrapper that
both increments `business_events_total` and writes a structured
log row.

### Health + readiness

```
GET /healthz   — liveness (always 200 if process is up)
GET /readyz    — readiness (200 only when deps are reachable)
```

`/readyz` checks:
- DB ping (`auth.db` SQLite)
- Worker pool has at least one warm Python worker
- Outputs directory is writable

In Kubernetes you'd point `livenessProbe` at `/healthz` and
`readinessProbe` at `/readyz`. Without the readiness gate, traffic
hits the server before the worker pool warms, leading to
artificial latency on the first N requests after deploy.

### What's not yet covered

- **Tracing across processes** — `withSpan` is in-process. The
  Python subprocess inside `runPipelineModule` doesn't propagate
  the `requestId`. Adding it would mean prepending the request ID
  as an env var or argument and emitting it in Python logs.
- **Vendor scrape outbound HTTP timing** — done via Python
  `requests` / `cloudscraper`; no instrumentation captures
  per-call duration. Could add via `pipeline/all_vendor.py`'s
  `SESSION` hook.
- **OpenTelemetry exporters** — the structure is OTel-shaped
  (spans, attributes, status), but we're not exporting OTLP
  traces yet. Adding an exporter is a one-import wire-up.

### Files in this feature

| File | Role |
|---|---|
| `server/lib/observability.js` | The whole module — logger, metrics, withSpan, middleware, handlers |
| `server/audit.js` | Audit log writer (mirrored by observability) |
| `server/package.json` | `pino`, `pino-http`, `pino-pretty`, `prom-client` deps |
| `server/app.js` (early in the file) | The wiring: `app.use(o11y.requestId)`, etc. |
