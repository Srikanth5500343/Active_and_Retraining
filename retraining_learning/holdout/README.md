# holdout/

Frozen validation sets used by the promotion gate. **Never touched by
retraining.** A retrained model only gets promoted if it scores higher
on the matching `holdout/<model>/` set than the production model did.

```
holdout/
├── devices/      ← YOLO-format val set for the device detector
│                   (data.yaml + images/ + labels/)
├── cable/        ← per-class image folders for the cable classifier
│                   cable/<class_name>/*.jpg
└── port_count/   ← image + ground-truth count pairs
                    (jsonl: {"image": "...", "actual_port_count": 24})
```

## How to populate

1. Sample 10–15% of your highest-confidence labeled data from the
   *original* training set (so the holdout reflects the historical
   distribution).
2. Plus a fresh 5% sample from the active-learning queue, to keep the
   holdout reflective of how the data is drifting.
3. Lock the file list (commit it). Once locked, never edit. If you must
   refresh the holdout, version it: `holdout/devices_v2/`, leave v1 in
   place for back-compat.

## Trainer contract

Each per-model trainer in `Devices_Retraining/` and `Cable_retraining/`
is invoked with `--holdout <path-to-this-dir>`. It must:

1. Train on the active-learning export sitting in cwd (`dataset.jsonl` +
   image files), mixed with the original training set (catastrophic-
   forgetting mitigation).
2. Evaluate the trained model on the `--holdout` set.
3. Emit `val_metrics.json` in cwd with at least the model's PRIMARY_METRIC
   (see `retraining_learning/config.py`).
4. Write the trained `.pt` artifact to `cwd/best.pt`.

That's the whole interface. Anything else is internal to the trainer.

## Empty holdout = no promotion possible

The gate is fail-closed. If a model's holdout is empty (no
`val_metrics.json` produced or missing the PRIMARY_METRIC key), the
candidate is logged but NOT promoted. So the first thing to do for a
newly-added model is populate its holdout dir.
