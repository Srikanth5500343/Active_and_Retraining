# active_learning_Cache

Staging area for user corrections + low-confidence inferences, before they
become a retraining dataset. Every sample that lands here is candidate
training data — durable, never evicted by anything but an explicit retrain
export.

## Layout

```
active_learning_Cache/
├── README.md                 ← this file
├── config.py                 ← thresholds + paths (single source of truth)
├── store.py                  ← Store class: add/list/count/export
├── feedback_ingest.py        ← pulls server/feedback.jsonl → per-model stores
├── cli.py                    ← `python -m active_learning_Cache.cli <cmd>`
├── device_active_learning.py ← (existing) Flask UI for device corrections
├── cable_active_learning.py  ← (existing) Flask UI for cable corrections
└── data/
    ├── devices/              ← one model's queue
    │   ├── samples/          ← image crops + per-sample label.json
    │   ├── corrections.jsonl ← append-only event log
    │   └── manifest.json     ← {count, threshold, last_export, history}
    ├── cable/
    └── port_count/
```

One subdirectory per **model**, not per *feedback type*, so when the
trainer asks "what's queued for the cable model?" the answer is one
directory listing.

## How data flows in

There are three entry points and they all funnel into `store.add()`:

1. **Real production feedback** — when a user corrects a port count or
   cable color in the React app, the server appends to
   `server/feedback.jsonl`. Run `python -m active_learning_Cache.cli ingest`
   to route those rows into the per-model stores.
2. **Interactive Flask UIs** — `device_active_learning.py` and
   `cable_active_learning.py` (the two scripts you wrote). They stay as
   they are; refactor at your pace to call `store.add()` instead of
   writing their own corrections.json.
3. **Low-confidence sampling** — any inference where the top class
   confidence is below a per-model threshold can be queued via
   `store.add(source="low_confidence", ...)` so the user gets prompted
   for the cases the model is most unsure about. (See `config.py`
   `LOW_CONF_THRESHOLDS`.)

## Sample schema

Every row in `corrections.jsonl` is a JSON object with this shape:

```json
{
  "id": "uuid",
  "model": "devices",
  "added_ts": "2026-05-07T13:42:11Z",
  "source": "user_correction" | "low_confidence" | "flask_ui",
  "image_path": "data/devices/samples/<id>.jpg",
  "predicted":  { "class": "Patch Panel", "confidence": 0.42 },
  "actual":     { "class": "Switch" },
  "scan_id":    "RK-XXXXXXXX",
  "device_index": 6,
  "metadata": { "device_box": [...], "feedback_type": "..." }
}
```

`predicted` and `actual` are open dicts — the schema is class-only for
the devices model, port-count + bbox for port_count, etc. Whatever the
trainer needs to reconstruct training pairs.

## Trigger / threshold

Each model has its own threshold (see `config.py`). When
`store.count() >= threshold` the **runner** in `retraining_learning/`
exports the queue, kicks off training, and (on promotion) calls
`store.mark_exported(run_id)` so the same samples don't re-train next
cycle.

## CLI

```
python -m active_learning_Cache.cli status     # how many samples per model + threshold
python -m active_learning_Cache.cli ingest     # pull server/feedback.jsonl
python -m active_learning_Cache.cli export devices --to /tmp/foo  # dump samples for ad-hoc use
python -m active_learning_Cache.cli clear devices --before 2026-01-01  # prune
```

## Conventions

- **Paths are relative to the repo root**, never hardcoded `D:\` or
  `C:\Users\...`. `config.py` resolves `REPO_ROOT` from `__file__`.
- **JSONL append-only** for audit. Don't rewrite existing rows; add
  superseding rows with newer timestamps if needed.
- **Sample IDs are UUIDs**, not paths. Two samples of the same image
  are distinct entries.
- **Never delete a sample mid-cycle.** Marking exported is a flag, not a
  delete — kept for reproducibility (so you can re-train run #N from the
  exact same data).
