# Documentation

This folder is the engineering reference for the rack-scan app. Every
document is split in two halves:

- **Top half** — plain English. What the feature does, why it exists,
  what it looks like to a user. Hand this to a junior engineer.
- **Bottom half** — technical detail. File paths, line numbers,
  schemas, edge cases, known issues, performance numbers. Hand this
  to the team lead or any reviewer evaluating trade-offs.

The two sections are separated by a horizontal rule (`---`) inside
each file.

For a single non-segmented document covering everything (no
junior/lead split, structured for personal study and demo prep),
see [demo.html](demo.html) in this folder.

## Index

### Foundations

| File | Topic |
|---|---|
| [01-overview.md](01-overview.md) | What the app does end-to-end, the user journey, the parts |
| [23-architecture.md](23-architecture.md) | Server / pipeline / client topology, request flow |
| [24-known-limits.md](24-known-limits.md) | Honest scoreboard — what works, what doesn't, real numbers |

### Scan pipeline (photo → inventory)

| File | Topic |
|---|---|
| [02-rack-scan.md](02-rack-scan.md) | The end-to-end scan flow — what `/api/analyze` actually does |
| [03-quality-check.md](03-quality-check.md) | The photo-quality gate that runs before CV |
| [04-cv-detection.md](04-cv-detection.md) | YOLO models, U-position mapping, low-conf retry pass |
| [05-ocr.md](05-ocr.md) | Per-bbox OCR, three-pass preprocessing, fuzzy parser |
| [06-port-identification.md](06-port-identification.md) | Port detection + RJ45/SFP classification |

### Switch information (per-device enrichment)

| File | Topic |
|---|---|
| [07-switch-info.md](07-switch-info.md) | The Switches tab: cards, manual entry, source badges |
| [08-firmware.md](08-firmware.md) | Latest-version detection, version-tuple comparison, IP-vs-version trap |
| [09-specifications.md](09-specifications.md) | Vendor product-page scraping, domain aliases, spec extraction |

### Live data

| File | Topic |
|---|---|
| [10-topology.md](10-topology.md) | The 3D rack view, cable rendering, trace mode |
| [11-available-ports.md](11-available-ports.md) | SSH probe of the live switch, parsing `show interface status` |
| [12-sfp-advisor.md](12-sfp-advisor.md) | SFP procurement: slot type detection + module recommendations |

### Integrations

| File | Topic |
|---|---|
| [13-cmdb-servicenow.md](13-cmdb-servicenow.md) | CMDB sync, ticket lifecycle, dev-approve bypass |
| [14-netdisco.md](14-netdisco.md) | The netdisco LLDP proxy and what it adds |
| [15-share-slack-teams-outlook.md](15-share-slack-teams-outlook.md) | PDF generation + sharing |

### Learning loop

| File | Topic |
|---|---|
| [16-feedback-loop.md](16-feedback-loop.md) | Capturing user corrections into `feedback.jsonl` |
| [17-active-learning.md](17-active-learning.md) | Per-model staging queues, ingest, CLI |
| [18-retraining.md](18-retraining.md) | Polling thresholds, training, validation gate, promotion |

### Platform

| File | Topic |
|---|---|
| [19-observability.md](19-observability.md) | Logs (pino), metrics (prom-client), tracing (`withSpan`), audit mirror |
| [20-multi-tenancy.md](20-multi-tenancy.md) | `rack_owners` table, ownership middleware, tenant scoping |
| [21-auth-secrets.md](21-auth-secrets.md) | JWT user auth, AES-encrypted SSH creds, ServiceNow Basic auth |
| [22-ios-ar.md](22-ios-ar.md) | RackAR Capacitor plugin, AR overlay design, native pending |

## How to read these

- **New to the codebase**: start with [01-overview.md](01-overview.md),
  then [23-architecture.md](23-architecture.md), then whichever
  feature doc matches what you're working on.
- **Reviewing for trade-offs**: read the bottom half of each feature
  doc, and read [24-known-limits.md](24-known-limits.md) in full.
- **Preparing for a demo**: open [demo.html](demo.html) — single
  document, white-themed, every feature in one scrollable page.
- **Debugging a specific bug**: jump straight to the feature doc;
  each one ends with a "Files in this feature" table.

## Conventions

- Code references use `path:line` so they're navigable from a
  terminal.
- "Junior view" never assumes the reader has read code; it explains
  the feature as a black-box behaviour.
- "Lead view" never repeats what's in the junior section; it goes
  straight to schema, file paths, edge cases, performance numbers,
  and known issues.
- When a number appears (e.g. "10.8% per-device vendor recall"),
  it's measured against the 12-image test set in
  `clear_vendors_racks/`, not estimated. Benchmark scripts:
  `pipeline/benchmark_ocr.py` and `pipeline/benchmark_full.py`.
