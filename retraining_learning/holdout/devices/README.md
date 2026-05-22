# holdout/devices/

Frozen YOLO validation set for the device detector.

The runner passes this directory to `Devices_Retraining/runner_adapter.py`
via `--holdout`. The adapter resolves images at `holdout/devices/images/`
when present, else uses the directory directly as the image folder.

## Expected layout

```
holdout/devices/
├── images/                          ← validation images
│   ├── rack_001.jpg
│   ├── rack_002.jpg
│   └── …
└── labels/                          ← YOLO labels (one .txt per image)
    ├── rack_001.txt                 ← `<class> <xc> <yc> <w> <h>` per row
    ├── rack_002.txt
    └── …
```

Class IDs in the label files must match the production model's class
indices — keep `Models/best 32.pt`'s class list as the source of truth.

## Filling this in

1. Pick 50-200 images that are **representative** of the production
   distribution: a mix of rack sizes, vendors, lighting conditions,
   and camera angles.
2. Label them with the same tooling you use for training (LabelImg,
   CVAT, or your in-house Flask annotator).
3. Commit the result. **Once committed, do not edit.** A floating
   holdout breaks the promotion-gate's apples-to-apples comparison.
4. To version: `holdout/devices_v2/`, leave v1 in place. The runner
   uses whichever path `config.HOLDOUT_DIR / model` resolves to.

If this directory is empty, the trainer adapter still runs and produces
a `val_metrics.json` from its own internal split — but the promotion
gate's measurement is methodologically weaker (train/val data leakage
risk). Populate this dir before the first promotion you'd actually
trust to ship.
