# holdout/cable/

Frozen ImageFolder-style validation set for the cable classifier.

The runner passes this directory to `Cable_retraining/runner_adapter.py`
via `--holdout`. The adapter loads it as a standard
`torchvision.datasets.ImageFolder` and computes top-1 accuracy.

## Expected layout

One subdirectory per cable class. Folder names MUST match the canonical
class names exactly (the adapter looks them up in `CLS_INDEX`):

```
holdout/cable/
├── LC_Aqua/
│   ├── img_0001.jpg
│   └── …
├── RJ-45 Violet/
├── RJ_45 Black/
├── RJ_45 Blue/
├── RJ_45 Brown/
├── RJ_45 Green/
├── RJ_45 Grey/
├── RJ_45 Orange/
├── RJ_45 Pink/
├── RJ_45 Red/
├── RJ_45 White/
├── RJ_45 Yellow/
├── SC_Orange/
└── SC_Yellow/
```

Aim for ≥ 20 images per class so per-class precision / recall numbers
are stable. Mix lighting / cable-bundle density / connector types.

## What the adapter does with this

`Cable_retraining/runner_adapter.py:evaluate()`:
1. Loads the ImageFolder (skips classes whose folder name isn't in
   `CLS_INDEX` — so adding a future class doesn't crash old holdouts).
2. Runs the freshly trained `best.pt` over every image.
3. Emits `val_metrics.json` with `accuracy` (the PRIMARY_METRIC) plus
   `n_holdout` and `n_classes`.

If this directory is empty: `val_metrics.json` comes back with
`accuracy: 0.0` and a `note` explaining the empty holdout. The
promotion gate then refuses to promote — fail-closed by design.
