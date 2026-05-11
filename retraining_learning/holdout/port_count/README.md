# holdout/port_count/

Frozen validation set for the port-count regression head.

A `port_count` adapter is not yet wired (`config.TRAINER_ENTRY['port_count']`
is `None`). When the third trainer is added, it should consume this
directory in the format below.

## Expected layout

```
holdout/port_count/
├── images/
│   ├── switch_001.jpg          ← cropped device faceplate
│   └── …
└── labels.jsonl                 ← one row per image
```

Each `labels.jsonl` row:
```json
{ "image": "switch_001.jpg", "actual_port_count": 24 }
{ "image": "switch_002.jpg", "actual_port_count": 48 }
```

The adapter's eval loop should compute **exact_match** (the model's
PRIMARY_METRIC for port_count) — fraction of images where the
predicted port count equals the actual port count. ±1 tolerance is
acceptable as a secondary metric but exact-match is what gates
promotion.

## Filling this in

Crop the device boxes from your existing `outputs/RK-XXX/` scans where
the port count was confirmed correct (or corrected via feedback). Aim
for ≥ 50 cropped device images covering the common port counts (4, 8,
16, 24, 48).

Empty holdout → `val_metrics.json` lacks `exact_match` → gate refuses
promotion (fail-closed).
