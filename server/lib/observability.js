/**
 * Central observability module — logging, metrics, tracing, audit mirroring.
 *
 * Imported once during server boot, then exposed everywhere via:
 *   const o11y = require('./lib/observability');
 *   o11y.logger.info({ ... }, 'message');
 *   await o11y.withSpan('pipeline.analyze', async (log) => { ... });
 *   o11y.recordEvent('scan.created', { rackId });
 *
 * What you get out of the box:
 *   - Structured JSON logs (pino) with secret redaction
 *   - Per-request correlation: every log line in a request's lifecycle
 *     carries the same `requestId` so you can grep one thread end-to-end
 *   - Prometheus metrics: HTTP duration histogram, in-flight gauge,
 *     error counters, business-event counters, op-duration histogram
 *   - `withSpan` wrapper that times any async fn, records duration,
 *     emits start/end log lines, increments error counter on throw
 *   - Process-level handlers so the server never dies silently
 *
 * Wire-up (in app.js):
 *   const o11y = require('./lib/observability');
 *   app.use(o11y.requestId);          // first
 *   app.use(o11y.httpLogger);         // logs every request/response
 *   app.use(o11y.httpMetrics);        // counts every request/response
 *   ...                               // your routes
 *   app.get('/metrics', o11y.metricsHandler);
 *   app.get('/healthz', o11y.healthHandler);
 *   app.use(o11y.errorHandler);       // last — catches anything that throws
 */

const { randomUUID } = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');
const promClient = require('prom-client');

const isDev = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

// ── Logger ────────────────────────────────────────────────────────────
// Pretty in dev (human-readable), pure JSON in prod (machine-ingestable).
// Always carries service/env/version so logs aggregated across services
// are filterable. Redaction list catches the obvious secret-y fields so
// they never end up in a log aggregator.
const loggerOpts = {
  level: logLevel,
  base: {
    service: 'racktrack-server',
    env: process.env.NODE_ENV || 'development',
    version: (() => {
      try { return require('../package.json').version; } catch { return '0.0.0'; }
    })(),
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password', 'enablePassword', 'secret', 'token', 'apiKey', 'api_key',
      'body.password', 'body.enablePassword', 'body.secret', 'body.token',
      'creds.password', 'creds.enablePassword',
      '*.password', '*.enablePassword', '*.token', '*.secret',
    ],
    censor: '[REDACTED]',
  },
};

if (isDev) {
  loggerOpts.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      singleLine: false,
      ignore: 'pid,hostname,service,env,version',
    },
  };
}

const logger = pino(loggerOpts);

// ── Metrics registry ──────────────────────────────────────────────────
const registry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: registry, prefix: 'racktrack_' });

const httpDuration = new promClient.Histogram({
  name: 'racktrack_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method/route/status',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

const httpInflight = new promClient.Gauge({
  name: 'racktrack_http_requests_in_flight',
  help: 'HTTP requests currently being processed',
  registers: [registry],
});

const errorsTotal = new promClient.Counter({
  name: 'racktrack_errors_total',
  help: 'Errors by kind and route',
  labelNames: ['kind', 'route'],
  registers: [registry],
});

const businessEvents = new promClient.Counter({
  name: 'racktrack_events_total',
  help: 'Business events: scans, ticket actions, ML runs, audit, etc.',
  labelNames: ['event'],
  registers: [registry],
});

const opDuration = new promClient.Histogram({
  name: 'racktrack_operation_duration_seconds',
  help: 'Duration of named operations: pipeline calls, SSH probes, etc.',
  labelNames: ['op', 'outcome'],
  buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600],
  registers: [registry],
});

const workerEvents = new promClient.Counter({
  name: 'racktrack_worker_events_total',
  help: 'Python worker lifecycle events (spawn, exit, error)',
  labelNames: ['event'],
  registers: [registry],
});

// ── Request ID middleware ─────────────────────────────────────────────
// Honours an upstream X-Request-Id header (LB-injected) when present, else
// mints a fresh UUID. Always echoes it back so the client can quote it
// when reporting issues. Stamped onto req.id before pino-http reads it.
function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(incoming))
    ? incoming
    : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// ── HTTP request logging middleware ───────────────────────────────────
// Every request gets one start log + one finish log. Children created via
// req.log.child({...}) inherit requestId so all in-request logs are linked.
const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.id || randomUUID(),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) =>
    `${req.method} ${req.url} → ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} → ${res.statusCode} (${err?.message || 'error'})`,
  customAttributeKeys: { req: 'req', res: 'res', err: 'err', responseTime: 'durationMs' },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.socket?.remoteAddress,
      userAgent: req.headers?.['user-agent'],
      userId: req.userId || req.user?.id,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
  // Skip noisy paths from logs (still measured by metrics middleware)
  autoLogging: {
    ignore: (req) => {
      const u = req.url || '';
      return u === '/metrics' || u === '/healthz' || u === '/api/health'
          || u.startsWith('/uploads/') || u.startsWith('/outputs/')
          || u.startsWith('/assets/');
    },
  },
});

// ── HTTP metrics middleware ───────────────────────────────────────────
// Records duration + status-code labels for every request. Routes are
// canonicalized (UUID-ish path segments → :id) so cardinality stays low —
// otherwise every unique rack ID would explode the label set.
function httpMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  httpInflight.inc();
  res.on('finish', () => {
    httpInflight.dec();
    const durSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = canonicalRoute(req);
    httpDuration.labels(req.method, route, String(res.statusCode)).observe(durSec);
    if (res.statusCode >= 500) errorsTotal.labels('http_5xx', route).inc();
    else if (res.statusCode >= 400) errorsTotal.labels('http_4xx', route).inc();
  });
  next();
}

function canonicalRoute(req) {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    return (base + req.route.path) || 'unknown';
  }
  // Fallback for routes that didn't match an Express handler: collapse
  // hex/UUID-ish segments to :id so we don't blow out cardinality.
  const path = (req.path || req.url || 'unknown').split('?')[0];
  return path
    .replace(/\/RK-[A-Z0-9]{4,}/g, '/:rackId')
    .replace(/\/[a-f0-9-]{8,}/gi, '/:id')
    .replace(/\/\d{4,}/g, '/:n');
}

// ── /metrics handler ──────────────────────────────────────────────────
async function metricsHandler(req, res) {
  try {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    logger.error({ err: err.message }, 'metrics endpoint failed');
    res.status(500).end('# metrics export failed');
  }
}

// ── /healthz handler ──────────────────────────────────────────────────
// Lightweight liveness — uptime + version + pid. Doesn't reach external
// systems, so it stays fast even when downstream is degraded.
function healthHandler(req, res) {
  res.json({
    ok: true,
    service: 'racktrack-server',
    version: loggerOpts.base.version,
    env: loggerOpts.base.env,
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    ts: new Date().toISOString(),
  });
}

// ── withSpan: time + log + count any async operation ──────────────────
//   await withSpan('pipeline.analyze', async (log) => {
//     log.debug({ inputPath }, 'analyzing');
//     return await pool.request('analyze', { ... });
//   }, { rackId });
// Returns whatever the inner fn returns. On throw: counts an error,
// records duration with outcome='error', re-throws so callers see it.
async function withSpan(name, fn, meta = {}) {
  const spanId = randomUUID().slice(0, 16);
  const start = process.hrtime.bigint();
  const childLog = (meta.parentLogger || logger).child({
    span: name, spanId, ...stripParent(meta),
  });
  childLog.debug({ event: 'span.start' }, `→ ${name}`);
  try {
    const result = await fn(childLog);
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    opDuration.labels(name, 'success').observe(dur);
    childLog.debug({ event: 'span.end', durationSec: round(dur), outcome: 'success' },
      `✓ ${name} (${round(dur)}s)`);
    return result;
  } catch (err) {
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    opDuration.labels(name, 'error').observe(dur);
    errorsTotal.labels('span', name).inc();
    childLog.error({
      event: 'span.error', err: err.message, stack: err.stack,
      durationSec: round(dur), outcome: 'error',
    }, `✗ ${name}: ${err.message}`);
    throw err;
  }
}

function stripParent(m) {
  const { parentLogger, ...rest } = m || {};
  return rest;
}

function round(n, p = 4) { return Math.round(n * 10 ** p) / 10 ** p; }

// ── recordEvent: business metric + log line ───────────────────────────
//   recordEvent('scan.created', { rackId, userId });
// Use for: scans, ticket lifecycle, ML inference results, auth events,
// CMDB pushes, anything you'd want to count on a dashboard.
function recordEvent(event, meta = {}) {
  businessEvents.labels(event).inc();
  logger.info({ event, ...meta }, `event: ${event}`);
}

// ── Audit shim: structured log mirror for security-relevant actions ───
// The SQLite audit_log table (audit.js) remains the canonical store; this
// just makes sure the same event also flows through the log pipeline so
// SOC tooling / aggregators see it.
function emitAudit(row) {
  const safe = { ...row };
  if (safe.payload && typeof safe.payload === 'string' && safe.payload.length > 4096) {
    safe.payload = safe.payload.slice(0, 4096) + '…';
  }
  businessEvents.labels(`audit.${row.action || 'unknown'}`).inc();
  logger.info({ kind: 'audit', ...safe }, `audit: ${row.action} ${row.status || ''}`.trim());
}

// ── Error handler middleware ──────────────────────────────────────────
// Mounted last, after all routes. Logs with full context, increments
// counter, returns a sanitized JSON body to the client (with requestId
// so users can quote it in support tickets).
function errorHandler(err, req, res, next) {
  const route = canonicalRoute(req);
  errorsTotal.labels('uncaught', route).inc();
  const log = req.log || logger;
  log.error({
    err: err.message,
    stack: err.stack,
    route,
    method: req.method,
    statusCode: err.statusCode || 500,
  }, `unhandled: ${err.message}`);
  if (res.headersSent) return next(err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: isDev ? err.message : (status >= 500 ? 'Internal server error' : err.message || 'Request failed'),
    requestId: req.id,
  });
}

// ── Process-level safety net ──────────────────────────────────────────
// Without these, an unhandled promise rejection or uncaught throw silently
// terminates the Node process with no log. Now: fatal log line + counter,
// then graceful exit so an orchestrator can restart us.
process.on('unhandledRejection', (reason) => {
  errorsTotal.labels('unhandled_rejection', 'process').inc();
  logger.fatal({
    err: reason?.message || String(reason),
    stack: reason?.stack,
  }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  errorsTotal.labels('uncaught_exception', 'process').inc();
  logger.fatal({
    err: err?.message || String(err),
    stack: err?.stack,
  }, 'uncaughtException');
  // Give pino a chance to flush before exit.
  setTimeout(() => process.exit(1), 250);
});

// ── Banner — logged at boot so ops can confirm wiring ─────────────────
function logBootBanner({ port, workers, env } = {}) {
  logger.info({
    event: 'server.boot',
    port, workers, env: env || loggerOpts.base.env,
    logLevel,
    pid: process.pid,
    metricsPath: '/metrics',
    healthPath: '/healthz',
  }, `racktrack-server up on :${port || '?'} (${workers || '?'} workers)`);
}

module.exports = {
  // Logger
  logger,
  // Metrics
  registry,
  metrics: { httpDuration, httpInflight, errorsTotal, businessEvents, opDuration, workerEvents },
  // Middleware
  requestId, httpLogger, httpMetrics, errorHandler,
  // Endpoints
  metricsHandler, healthHandler,
  // Helpers
  withSpan, recordEvent, emitAudit, logBootBanner,
};
