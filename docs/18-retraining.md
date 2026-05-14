# 18. Retraining — closing the learning loop

## What it does (junior view)

This is the **final stage** of the active-learning loop. It's
where queued user corrections actually train a new model.

The flow:

1. **Check thresholds.** For each model (devices, cable,
   port_count), look at the queue size. If a queue has crossed
   its retrain threshold (e.g. 200 corrections), it's ready.
2. **Export the queue.** Dump every queued sample — image + label
   — into a fresh run directory under `runs/<model>-<timestamp>/`.
3. **Train.** Spawn the matching trainer subprocess (YOLO for
   devices, EfficientNet for cables, etc.). The trainer reads
   the dataset and produces a new `best.pt`.
4. **Validate.** Run the new model against a **frozen holdout
   set** that never participates in training. Get back metrics
   (accuracy, recall, mAP).
5. **Promotion gate.** Compare the new metric to the production
   model's recorded score. Promote only if the new model wins by
   at least the configured margin.
6. **Promote or shelve.** If promoted, copy `best.pt` to
   `Models/`, update the registry, mark the queue as exported. If
   not, leave the candidate in the run directory for inspection
   and **don't** clear the queue (so the same samples roll into
   the next attempt).

Everything is logged. Each retrain attempt has its own folder
with the dataset used, the train log, the validation metrics,
the candidate model, and a `promoted.flag` file iff it was
actually shipped.

The whole cycle is **non-destructive** — the production model
isn't touched until the new one passes the gate. A bad batch of
corrections produces a bad candidate that fails validation and
never reaches users.

## What it doesn't do

- It doesn't run continuously. The runner is called manually or
  from cron — there's no in-process background scheduler.
- It doesn't deploy the new model to clients. Production weights
  live at `Models/*.pt`, which the server reads on the next
  pipeline subprocess. **A server restart picks up the new
  weights.** Hot-reload isn't implemented.
- It doesn't auto-merge across multiple model variants. If
  the trainer produces several candidates with different
  hyperparameters, the runner picks one (typically the best on
  the holdout) but doesn't ensemble them.

---

## Technical detail (lead view)

### Folder layout

```
retraining_learning/
├── README.md
├── __init__.py
├── config.py              ← thresholds, holdout paths, deploy targets, primary metrics
├── runner.py              ← top-level: poll → export → train → validate → promote
├── promotion.py           ← validation-gate logic + registry update
├── registry.py            ← model registry interface
├── registry.json          ← which version is in production right now
├── runs/                  ← one subdir per retrain attempt (auto-created)
│   └── <model>-<run_id>/
│       ├── dataset.jsonl       ← exported samples used (from store.export)
│       ├── train.log           ← stdout/stderr of the trainer
│       ├── val_metrics.json    ← {accuracy, recall, ...} on holdout
│       ├── best.pt             ← the trained artifact
│       └── promoted.flag       ← present iff this run was promoted
├── holdout/               ← frozen validation sets — NEVER touched by retrain
│   ├── devices/
│   ├── cable/
│   └── port_count/
├── Devices_Retraining/    ← YOLO trainer (existing tooling)
└── Cable_retraining/      ← EfficientNet trainer (existing tooling)
```

### Runner contract (`runner.py`)

```bash
python -m retraining_learning.runner             # all models
python -m retraining_learning.runner --only devices
python -m retraining_learning.runner --dry-run   # report only, no work
```

Per model:

```
1. Ingest fresh feedback.jsonl rows into the store
   (delegated to active_learning_Cache.feedback_ingest)
2. count = Store(model).count(only_pending=True)
3. if count < THRESHOLDS[model]: skip, log "not ready"
4. run_id = "YYYYMMDD-HHMMSS"
5. run_dir = runs/<model>-<run_id>/
6. dataset = Store(model).export(run_id, run_dir)
   → writes run_dir/dataset.jsonl + samples/
7. spawn trainer:
     subprocess.run([python, trainer_entry, "--holdout", holdout_dir],
                    cwd=run_dir, timeout=TRAINER_TIMEOUT_SEC,
                    stdout=run_dir/train.log)
8. if exit != 0: log failure, queue stays pending
9. result = promotion.evaluate(model, run_dir, registry)
10. if promoted:
     Registry.promote(model, run_dir/best.pt, val_metrics)
     copy best.pt → Models/<model>.pt
     Store(model).mark_exported(run_id, sample_ids)
     touch run_dir/promoted.flag
   else:
     log reason, leave run_dir intact, queue stays pending
```

### Trainer contract

The runner is **trainer-agnostic** — it spawns a Python entry
point and inspects the output files. Each model has a
configured trainer in `config.trainer_path(model)`:

| Model | Trainer entry |
|---|---|
| `devices` | `retraining_learning/Devices_Retraining/main.py` |
| `cable` | `retraining_learning/Cable_retraining/main2.py` |
| `port_count` | (TBD — same shape as devices) |

The trainer must:

- Run with `cwd = runs/<model>-<run_id>/`
- Read `dataset.jsonl` + image files from cwd
- Take `--holdout <path>` as an argument
- Write `best.pt`, `val_metrics.json`, `train.log` into cwd
- Exit 0 on success, non-zero on failure

This contract isolates the runner from trainer implementation
details — swap YOLO for a different detector by only changing
the entry path.

### Promotion gate (`promotion.py`)

```python
def evaluate(model, run_dir, registry):
    # 1. Load val_metrics.json
    metric_key = config.PRIMARY_METRIC[model]   # e.g. "mAP_0.5" for devices
    new_score  = val_metrics[metric_key]

    # 2. Get production score
    old_score = registry.score(model, metric_key)  # None if no prior

    # 3. Compare
    if old_score is None:
        # First-ever model — promote if it clears absolute floor
        if new_score >= config.MIN_FLOOR[model]: return promote
        else: return shelve
    delta = new_score - old_score
    if delta < config.MIN_DELTA[model]: return shelve
    return promote
```

`PRIMARY_METRIC` per model:

```python
PRIMARY_METRIC = {
    "devices":    "mAP_0.5",           # YOLO standard
    "cable":      "macro_f1",          # multi-class classifier
    "port_count": "rmse",              # regression — lower is better
}
```

For `port_count`, the comparison is inverted: a candidate is
better if `new_score + MIN_DELTA <= old_score` (lower RMSE
wins). The promotion module handles the directionality per
metric.

### Registry (`registry.py` + `registry.json`)

`registry.json`:

```json
{
  "devices": {
    "version": "20260507-134220",
    "path":    "Models/best 32.pt",
    "metric":  "mAP_0.5",
    "score":   0.842,
    "promoted_at": "2026-05-07T13:42:20Z",
    "n_samples": 1834,
    "history": [
      {"version":"20260420-093011","score":0.831,"promoted_at":"...","n_samples":1604},
      ...
    ]
  },
  "cable":      {...},
  "port_count": {...}
}
```

`Registry.promote(model, candidate_path, metrics)`:

1. Read the existing entry; copy current to `history[]`
2. Copy candidate → `Models/<production_path>` (atomic via
   write-temp-then-rename)
3. Update entry with new score + version + path
4. Write `registry.json`

History keeps the last 20 promotions per model. Older entries
roll off but the run directories remain on disk forever (no
auto-cleanup) so you can roll back manually by copying any
`runs/<model>-<id>/best.pt` into `Models/`.

### Holdout sets

`retraining_learning/holdout/<model>/`. **Never** participate in
training. Hand-curated samples that test what we care about:

- 50 device crops covering the rare classes (CRS518 wavy
  fascia, blade enclosures, weird PoE injectors)
- 30 cable images per type (CAT, fiber, DAC, fiber-bend,
  high-glare cases)
- 100 port-count images at varying chassis sizes (8, 16, 24,
  48, 96)

The validation step always evaluates against the same holdout —
that's why a regression in real-world performance shows up as a
metric drop. If the holdout itself goes stale (new equipment
classes show up in the wild but not in holdout), the gate will
incorrectly bless a model that's actually getting worse on the
new gear. Keep holdout fresh; rotate ~10% per quarter.

### Ops cycle (manual)

For now, retraining is operator-triggered:

```bash
# 1. Pull fresh corrections
python -m active_learning_Cache.cli ingest

# 2. See what's queued
python -m active_learning_Cache.cli stats

# 3. Run a retrain attempt (all models)
python -m retraining_learning.runner

# 4. Inspect the latest run
ls -la retraining_learning/runs/ | tail -5
cat retraining_learning/runs/<latest>/val_metrics.json

# 5. If you want to roll back manually
cp retraining_learning/runs/<earlier>/best.pt 'Models/best 32.pt'
```

Future: cron `runner` nightly, or trigger from a webhook when
queue thresholds cross.

### Hot-reload caveat

The server's pipeline subprocesses load `Models/*.pt` on every
spawn — there's no in-process model cache. So once `Models/best
32.pt` is replaced, the **next** rack scan picks up the new
weights. No server restart needed for the pipeline modules; the
in-process Node side doesn't load `.pt` files at all.

The exception is the worker pool (`server/worker-pool.js`) which
keeps Python workers warm. After a model promotion, those
warm workers are still using the old weights. Either restart
the workers or run `python -m worker_pool.refresh` (TBD) — for
now, restart the Node server when promoting.

### Files in this feature

| File | Role |
|---|---|
| `retraining_learning/runner.py` | Top-level orchestration |
| `retraining_learning/promotion.py` | Validation gate |
| `retraining_learning/registry.py` | Production model registry |
| `retraining_learning/registry.json` | Current production model state |
| `retraining_learning/config.py` | Thresholds, deltas, primary metrics |
| `retraining_learning/holdout/` | Frozen validation sets |
| `retraining_learning/Devices_Retraining/` | YOLO trainer |
| `retraining_learning/Cable_retraining/` | EfficientNet trainer |
