# RackTrack Inspector

Per-ticket inspection app. Pick an active incident, upload a rack photo, see
what the agent and vision pipeline produce — side by side.

**No autonomous loop, no dashboard, no anomalies, no batches, no posting.**
Just one ticket + one image → four result panels.


## What it shows

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ AGENT — Extraction          │  │ VISION — Annotated Image    │
│ device, port, mode,         │  │ devices + target + ports +  │
│ confidence, signals used    │  │ target port highlighted     │
└─────────────────────────────┘  └─────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ AGENT — Reasoning chain (step-by-step, confidence per step)  │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ PREVIEW — Work note text (preview only, NOT posted to SN)    │
└──────────────────────────────────────────────────────────────┘
```


## Files

| File                      | What it does |
|---------------------------|---|
| `inspector.py`            | Flask backend. Two endpoints: list active incidents, analyze one. |
| `templates/inspector.html`| The UI. |
| `agent.py`                | Text reasoning agent (extraction + reasoning chain). |
| `action_templates.py`     | Suggested-action templates used in the work-note preview. |
| `vision_pipeline.py`      | YOLO orchestrator (devices → target device → ports → target port). |
| `full.py`, `port.py`, `port_pattern.py` | Detection modules. |
| `.env.example`            | Copy to `.env`, fill in PDI credentials. |
| `requirements.txt`        | `pip install -r requirements.txt` |


## Setup (once)

```powershell
pip install -r requirements.txt
copy .env.example .env
notepad .env                    # SN_INSTANCE, SN_USER, SN_PASSWORD
```

Also: your `Models/` folder must be in this directory with:
- `device_server.pt`
- `device_general.pt`
- `unit.pt`
- `port_count.pt`


## Run

```powershell
python inspector.py
```

Open **http://127.0.0.1:5003**.

1. Pick an incident from the dropdown (loaded live from your PDI)
2. Upload a rack/switch photo
3. Click **Analyze**

Within a few seconds, four panels populate:
- **Agent — Extraction**: what the text agent extracted (device, port, failure mode, confidence, all the signal pills that contributed)
- **Vision — Annotated**: the uploaded image with detection boxes overlaid (devices, target device, ports, target port highlighted)
- **Agent — Reasoning chain**: the step-by-step reasoning the agent would post
- **Preview — Work note**: the exact work-note text that *would* be posted to ServiceNow (preview only, never actually posts)


## What this app does NOT do

- ❌ Post work notes to ServiceNow
- ❌ Auto-create CMDB records
- ❌ Run a poll loop
- ❌ Show batches, anomalies, or rack drift
- ❌ Score or rank multiple tickets

It's a pure inspector. Use the `agent-only/` bundle for autonomous mode and the
dashboard.
