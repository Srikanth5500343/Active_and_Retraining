# retraining_learning

The retrain side of the active-learning loop. Polls per-model staging
queues in `../active_learning_Cache/data/`, kicks off the matching
trainer when a queue is over its threshold, validates the new model
against a holdout set, and promotes it only if it actually wins.

## Layout

```
retraining_learning/
├── README.md            ← this file
├── config.py            ← retrain thresholds, holdout paths, deploy targets
├── runner.py            ← top-level: poll → export → train → validate → promote
├── promotion.py         ← validation-gate logic + registry update
├── registry.py          ← model registry interface
├── registry.json        ← which model version is in production right now
├── runs/                ← one subdir per retrain attempt (auto-created)
│   └── <model>-<run_id>/
│       ├── dataset.jsonl       ← exported samples used (from store.export)
│       ├── train.log           ← stdout/stderr of the trainer
│       ├── val_metrics.json    ← {accuracy, recall, ...} on holdout
│       ├── best.pt             ← the trained artifact
│       └── promoted.flag       ← present iff this run was promoted
├── holdout/             ← frozen validation sets (NEVER touched by retrain)
│   ├── devices/
│   ├── cable/
│   └── port_count/
├── Devices_Retraining/  ← (existing) YOLO trainer — runner calls main.py
└── Cable_retraining/    ← (existing) EfficientNet trainer — runner calls main2.py
```

## Lifecycle of one retrain

```
┌──────────────────────────────────────────────────────────────────────┐
│ runner.py main()                                                     │
│                                                                      │
│   for model in MODELS:                                               │
│     store = Store(model)                                             │
│     if store.count() < threshold:        ── log "not ready", skip   │
│     run_id = make_run_id()                                           │
│     dataset = store.export(run_id, runs/<model>-<run_id>/)           │
│                                                                      │
│     trainer_result = call_trainer(model, dataset.dest_dir)           │
│       └─ subprocess to Devices_Retraining/main.py or Cable_…/main2.py│
│                                                                      │
│     if not trainer_result.ok:           ── log, queue NOT cleared    │
│                                                                      │
│     val = validate(model, trainer_result.model_path,                 │
│                    holdout_dir(model))                               │
│     prod = registry.get_metrics(model)                               │
│                                                                      │
│     if val.beats(prod):                                              │
│       registry.promote(model, trainer_result.model_path, val)        │
│       store.mark_exported(run_id, dataset.sample_ids)                │
│       touch(promoted.flag)                                           │
│     else:                                                            │
│       log "trained but did not beat prod (acc {new} < {old})"        │
│       — queue NOT cleared, samples will be retried next cycle        │
└──────────────────────────────────────────────────────────────────────┘
```

The key safety rules:

1. **Validation gate** — a retrained model is *not* trusted until it
   beats the production model on a holdout the trainer never saw. If it
   loses, the trained `.pt` stays in `runs/<id>/best.pt` for inspection
   and the production model is unchanged.
2. **Queue is only cleared on promotion.** If training fails, or the new
   model loses validation, the samples stay pending — they'll be tried
   again next cycle (with whatever new samples have arrived in the
   meantime).
3. **Mix corrections with the original training set.** This is enforced
   inside each trainer's dataset builder — see the per-trainer scripts.
   The runner only delivers the export; the trainer is responsible for
   blending it with the base dataset to avoid catastrophic forgetting.
4. **Snapshot the dataset.** Every run keeps `dataset.jsonl` so a
   regression in run #N can be reproduced by re-training on the exact
   same data.

## registry.json

The production model registry. The serving side (Python pipeline /
`pipeline/worker.py`) reads `registry.json` to find the active model
file; promotion just rewrites the entry.

```json
{
  "devices": {
    "model_path": "Models/Devices.pt",
    "version":    "20260507-143012",
    "trained_on": "active_learning_Cache/data/devices/exports/20260507-143012/",
    "metrics":    { "accuracy": 0.93, "f1": 0.91, "n_holdout": 412 },
    "promoted_ts": "2026-05-07T14:33:08Z"
  },
  ...
}
```

The initial `registry.json` shipped with this repo points at the
current `Models/*.pt` files with placeholder metrics — fill in the
real holdout metrics on first promotion.

## Running

```
# manual: see what's ready, but don't train yet
python -m retraining_learning.runner --dry-run

# real: poll all models, train+validate any that are over threshold
python -m retraining_learning.runner

# scope to one model
python -m retraining_learning.runner --only devices
```

## Scheduling

The runner is **off-line by design** — it does not sit inside the
serving process. Recommended:

- Cron / systemd timer at off-peak hours (3 AM)
- Or trigger on demand from a CI step
- Or a separate worker container

Don't run it inside the API server; retrain pipelines spike GPU/CPU
and would cause request latency to flap.
