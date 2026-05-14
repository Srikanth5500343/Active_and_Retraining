# 16. Feedback — capturing user corrections

## What it does (junior view)

When the app gets something wrong — wrong cable colour, wrong port
count, wrong device class — the user can correct it directly in
the UI. That correction is logged. **Every correction is free
training data**: with enough of them, the next retrain pass
produces a better model.

This document covers the **capture side**: where the user
corrects something, how the server records it, and what shape the
record takes. The **routing side** (taking these records and
queueing them for retrain) is in
[17-active-learning.md](17-active-learning.md). The **retrain
side** (actually training a new model from the queue) is in
[18-retraining.md](18-retraining.md).

What the user does:

1. Sees a wrong result on the Results page (e.g. "this cable
   isn't blue, it's green") or the per-port detail.
2. Clicks the **Wrong?** button (or equivalent).
3. Picks the correct value from a dropdown / colour swatch /
   number input.
4. Confirms. The correction goes to the server.

What gets stored:
- The original prediction (what the model said)
- The corrected value (what the user said)
- A small image crop of the thing being corrected (so the trainer
  has visual context)
- Metadata: rackId, deviceId/portId, user id, timestamp

The user doesn't see anything special after submitting — it's a
silent capture. Over weeks/months, those captured records
accumulate into a retraining dataset.

## What it doesn't do

- It doesn't immediately retrain the model. The retrain side runs
  on a schedule (or on-demand via CLI) and only fires when there
  are enough new corrections to justify a training run.
- It doesn't validate corrections. If a user wrongly says
  "actually that cable IS green when it's blue", that wrong
  correction enters the training data. The retrain pass has a
  validation step (holdout set, primary-metric comparison) that
  catches the resulting model regression.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `server/feedback.jsonl` | Append-only event log (the "raw" capture) |
| `server/feedback/wrong/` | Per-correction image crops |
| `server/app.js` (around the `/api/feedback` routes) | The capture endpoints |
| `client/src/pages/ResultsPage.jsx:submitFeedback` | The client submitter |

### Endpoints

```
POST /api/feedback                body: { rackId, type, original, corrected, imageRef? }
POST /api/feedback/cable          body: cable-specific
POST /api/feedback/port           body: port-specific
POST /api/feedback/device         body: device-class-specific (when wired)
GET  /api/feedback/recent         (admin only — for debugging)
```

Each POST appends one JSONL row to `server/feedback.jsonl` with a
schema like:

```json
{
  "id": "fb-2026-05-07-001234",
  "ts": "2026-05-07T13:42:11Z",
  "user_id": 17,
  "tenant_id": 3,
  "rack_id": "RK-F74FFCF9",
  "feedback_type": "cable_color",       // 'cable_color'|'port_count'|'device_class'|...
  "is_correct": false,
  "predicted": { "color": "blue", "confidence": 0.71 },
  "actual":    { "color": "green" },
  "device_index": 4,                    // index into device_unit_map.devices
  "port_index":   12,                   // when port-specific
  "device_crop_image": "wrong/RK-F74FFCF9-d4-2026-05-07-...jpg",
  "port_crop_image":   "wrong/RK-F74FFCF9-d4-p12-2026-05-07-...jpg"
}
```

### Where image crops live

`server/feedback/wrong/<crop>.jpg`. Saved by the capture endpoint
when the request includes an image (multipart) or references a
device's bbox (server crops from `outputs/<rackId>/original_image.jpg`
and writes it).

The retraining ingest layer reads these via
`active_learning_Cache.feedback_ingest._resolve_image()` so the
training samples include the actual visual context, not just
JSON.

### Routing to per-model queues

`server/feedback.jsonl` is the **shared inbox**. Different models
care about different feedback types:

| feedback_type | Routes to model |
|---|---|
| `port_count` | `port_count` model |
| `cable_color` / `cable_type` | `cable` model |
| `device_class` / `device_make_model` | `devices` model |

The router is a separate Python module:
`active_learning_Cache.feedback_ingest`. It maintains a cursor
file (`active_learning_Cache/data/.ingest_cursor`) tracking the
last byte offset processed, so re-running the ingest is
idempotent and cheap.

Run manually:

```bash
python -m active_learning_Cache.cli ingest
```

Or schedule via cron / systemd timer. The retraining runner
([18-retraining.md](18-retraining.md)) calls ingest at the start
of each cycle.

### Schema validity

The `is_correct` field exists because some flows want **both**:

- **Negative samples** (`is_correct: false`) — clear corrections
- **Positive samples** (`is_correct: true`) — user confirmed the
  prediction was right

Confirmed-correct rows are useful for the retrain set too (good
positive examples), but the current ingest router drops them — the
incremental value is small compared to the drift risk of training
on a model's own predictions. Tracked as a future enhancement.

### Data retention

`feedback.jsonl` grows unboundedly. There's no rotation today.
After ingest into the active-learning cache, the JSONL row is
**not** deleted (the cursor advances; the row stays). This is
deliberate — the JSONL is the audit trail of "what corrections
came in when, from whom" and is needed for compliance review.

For volume management, a future job could compact the JSONL
periodically (rotate to `feedback.archive.<date>.jsonl.gz`,
truncate the live file) without breaking the cursor — the cursor
is a byte offset into the **live** file.

### Privacy / PII

Capture rows include `user_id` and `tenant_id`. Image crops can
contain rack-rail labels with internal hostnames. Both should be
considered tenant-private data:

- The feedback logs are **never** exposed to other tenants
- The image crops live under the server's `feedback/` folder, not
  under any tenant-scoped path — for now, server admins can read
  all crops. This is acceptable because the only user who can
  upload a crop is one of our customers' employees, but a stricter
  hardening would partition crops by tenant.

### Files in this feature

| File | Role |
|---|---|
| `server/feedback.jsonl` | Append-only capture log |
| `server/feedback/wrong/` | Per-correction crops |
| `server/app.js` `/api/feedback*` | HTTP capture |
| `client/src/pages/ResultsPage.jsx:submitFeedback` | Client submitter |
| `active_learning_Cache/feedback_ingest.py` | Router from JSONL → per-model stores |
