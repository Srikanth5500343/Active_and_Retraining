# 17. Active Learning — staging corrections for retrain

## What it does (junior view)

Active learning is the **middle stage** of the learning loop.

- The **front** is feedback capture ([16-feedback-loop.md](16-feedback-loop.md))
  — user corrections land in `server/feedback.jsonl`.
- The **back** is retraining ([18-retraining.md](18-retraining.md))
  — when there are enough corrections for a model, kick off a
  training run.
- This middle stage is the **queue**: take the raw feedback,
  route each correction to the right per-model store, hold them
  there until the retrain runner is ready to pull them.

Why a separate staging queue: feedback comes in continuously and
in mixed forms (some are about cables, some about port counts,
some about device class). Each model wants its own training set
in its own format. The active-learning cache is the place where
"raw correction" becomes "queued training sample for model X".

There's also a **CLI** (`python -m active_learning_Cache.cli ...`)
for inspecting and managing the queues — count what's pending,
list samples, manually export, clear.

Two existing Flask UIs (`device_active_learning.py` and
`cable_active_learning.py`) let a human review and label samples
interactively when low-confidence inferences are surfaced.

## What it doesn't do

- It doesn't train a model. It only stages samples.
- It doesn't validate the corrections. A wrong correction enters
  the queue just like a right one; the retrain stage's holdout
  validation is the safety net.
- It doesn't auto-trigger retraining. The `runner.py` in
  `retraining_learning/` polls the queue counts and decides when
  to fire.

---

## Technical detail (lead view)

### Folder layout

```
active_learning_Cache/
├── README.md                      ← package overview
├── __init__.py
├── config.py                      ← paths, thresholds, model list
├── store.py                       ← Store class: add/list/count/export
├── feedback_ingest.py             ← server/feedback.jsonl → per-model stores
├── cli.py                         ← `python -m active_learning_Cache.cli ...`
├── device_active_learning.py      ← Flask UI for device corrections
├── cable_active_learning.py       ← Flask UI for cable corrections
└── data/
    ├── devices/                   ← one model's queue
    │   ├── samples/<id>.jpg       ← image crops
    │   ├── corrections.jsonl      ← append-only event log
    │   └── manifest.json          ← cached counters
    ├── cable/
    └── port_count/
```

One subdirectory per **model**, not per feedback-type. Tools and
trainers ask "what's queued for the cable model?" and get one
directory listing.

### `Store` class

`active_learning_Cache/store.py`. Public API:

```python
class Store:
    def __init__(self, model: str)
    def add(self, record: dict, image_bytes: bytes | None = None) -> str
    def count(self, only_pending: bool = True) -> int
    def list_pending(self) -> Iterator[dict]
    def list_all(self) -> Iterator[dict]
    def export(self, run_id: str, dest_dir: Path) -> ExportManifest
    def mark_exported(self, run_id: str, ids: list[str]) -> None
    def clear(self, before: str | None = None) -> int
    def stats(self) -> dict
```

The on-disk store is two files plus a samples directory:

- `corrections.jsonl` — append-only event log. Source of truth.
  Three event kinds:
  - `add` — new training candidate
  - `export` — marker that a batch was used in retrain run R
  - `supersede` — a later add() that replaces an earlier id
    (e.g. user re-corrected the same image)
- `manifest.json` — derived view, rebuildable from JSONL. Cached
  so `count()` doesn't replay every event.
- `samples/<id>.<ext>` — image artifact per add() that included
  one. Optional — text-only corrections have no image.

Why JSONL: append-only audit trail, every row is a self-contained
candidate, any tool can read it (`jq`, pandas, the trainers).

### Sample schema

Per `add()`:

```json
{
  "id": "f3a9b1c2d4e5f6a7",
  "ts": "2026-05-07T13:42:11Z",
  "model": "cable",
  "source": "user_correction",      // user_correction | low_confidence | flask_ui | ingest
  "label": "green",                  // the correct value
  "predicted": { "color": "blue", "conf": 0.71 },  // optional
  "metadata": {
    "rack_id": "RK-F74FFCF9",
    "device_index": 4,
    "port_index": 12,
    "user_id": 17,
    "tenant_id": 3
  },
  "image_path": "samples/f3a9b1c2d4e5f6a7.jpg"  // relative to model dir
}
```

`source` enum:
- `user_correction` — from `server/feedback.jsonl` via ingest
- `low_confidence` — system-queued for human review
- `flask_ui` — from the interactive review tools
- `ingest` — generic catch-all for synthesised entries

### Feedback ingest

`active_learning_Cache/feedback_ingest.py`. Pulls
`server/feedback.jsonl` rows into per-model stores. Idempotent:
maintains a byte-offset cursor at
`active_learning_Cache/data/.ingest_cursor`, so re-running is
cheap and safe.

Routing rules:

```python
def _route(row):
    if row.get('is_correct') is True: return None  # skip confirmed-correct for now
    t = row.get('feedback_type', '')
    if 'cable' in t:        return 'cable'
    if 'port_count' in t:   return 'port_count'
    if 'device' in t:       return 'devices'
    return None
```

Image lookup: each row's `device_crop_image` and `port_crop_image`
filenames are resolved against `server/feedback/wrong/<file>` and
embedded as bytes into the stored sample.

Run:
```bash
python -m active_learning_Cache.cli ingest          # process new rows
python -m active_learning_Cache.cli ingest --reset  # rewind cursor to 0
```

### Configuration (`config.py`)

```python
MODELS = ("devices", "cable", "port_count")

RETRAIN_THRESHOLDS = {
    "devices":    200,    # YOLO obj-detect: 200-500/class moves the needle
    "cable":      200,    # 14 cable classes; 200 total to ship something
    "port_count": 100,    # small regression head; 100 typically sufficient
}

LOW_CONF_THRESHOLDS = {
    "devices":    0.55,   # below this conf, queue for human review
    "cable":      0.60,
    "port_count": 0.65,
}
```

The runner checks `store.count(model) >= RETRAIN_THRESHOLDS[model]`
to decide if model X is ready for retrain.

### CLI

```
python -m active_learning_Cache.cli ingest
python -m active_learning_Cache.cli stats             # counts per model
python -m active_learning_Cache.cli stats --model cable
python -m active_learning_Cache.cli list  --model cable [--limit N]
python -m active_learning_Cache.cli clear --model cable [--before YYYY-MM-DD]
python -m active_learning_Cache.cli export --model cable --run-id <id> --dest-dir <path>
```

Used during ops + debugging. The retrain runner calls
`store.export()` directly (Python API), not the CLI.

### Existing Flask UIs

`device_active_learning.py` and `cable_active_learning.py` are
older interactive review tools (pre-existing). They serve a small
web UI that:
- Shows queued samples one at a time
- Lets a human relabel / confirm
- Writes the result back to the store

These predate the `Store` class. They currently maintain their own
`corrections.json` files outside the new layout. Refactor target:
have them call `Store(model).add(...)` and let the rest of the
system see their output the same way it sees feedback-jsonl
output.

### Files in this feature

| File | Role |
|---|---|
| `active_learning_Cache/store.py` | The Store class |
| `active_learning_Cache/feedback_ingest.py` | Routing from feedback.jsonl |
| `active_learning_Cache/config.py` | Single source of truth for paths + thresholds |
| `active_learning_Cache/cli.py` | Ops CLI |
| `active_learning_Cache/device_active_learning.py` | Flask review UI (legacy) |
| `active_learning_Cache/cable_active_learning.py` | Flask review UI (legacy) |
