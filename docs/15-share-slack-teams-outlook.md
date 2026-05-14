# 15. Share — Slack, Teams, Outlook

## What it does (junior view)

After a rack scan, the user can **share the results report** to:

- **Slack** — DM or channel
- **Microsoft Teams** — chat or channel
- **Outlook** — email

The shared content is a **PDF of the rack report**: the rack
photo, detected devices, port utilization, firmware status, and
any flagged CVEs. Generated on demand from the same data the
Results page renders.

This is for handing off to a teammate who isn't on the app — a
field engineer scans a rack, then sends the report to the office
team for review or to a vendor for support context.

The recipient enters their Slack channel / Teams chat / email
address; the user clicks **Send**; the server generates the PDF
and posts it. A success toast confirms delivery.

If credentials for that platform aren't configured (no Slack
webhook, no Teams webhook, no Outlook account), the option is
hidden or disabled.

## What it doesn't do

- It doesn't pull threading info from the recipient platform. No
  "reply to ticket #123 on Slack" — every share is a fresh post.
- It doesn't track delivery once sent. We get a 200 from the
  Slack/Teams webhook, then we're done.
- It doesn't include raw scan data (just the rendered PDF). If
  the recipient wants the JSON, they get it from the app.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `pipeline/slack_email.py` | Slack webhook poster |
| `pipeline/teams_send.py` | Teams webhook poster |
| `pipeline/outlook_send.py` | Outlook (Microsoft Graph) sender + cache of last-used recipient |
| `server/app.js:/api/scan/:rackId/{slack,teams,outlook}` | The three endpoints |
| `pipeline/shanakr_outlook_cache.json`, `shankar_teams_cache.json` | Per-developer recipient caches (legacy filenames) |

### Routes

```
POST /api/scan/:rackId/slack    body: { email, message? }
POST /api/scan/:rackId/teams    body: { email, message? }
POST /api/scan/:rackId/outlook  body: { email, message? }
```

Each route runs `runShareSender(req, res, ...)` which:

1. Validates the recipient email (`EMAIL_RE`)
2. Generates the PDF (see below)
3. Spawns the matching Python sender with the PDF path + recipient
4. Forwards the sender's JSON result to the client

Timeout: `SHARE_PDF_TIMEOUT_MS = 120_000` (2 min). Most shares
complete in 5-15s; the timeout is set high to absorb slow
Microsoft Graph token refreshes.

### PDF generation

The PDF is rendered server-side via headless Chromium using
Puppeteer (`puppeteer-core`). The flow:

1. Spawn a Chromium instance (or reuse a long-lived one if
   available)
2. Navigate to a special print-mode URL (`/results/:rackId/print`)
3. Wait for the page to fire its `window.__printReady = true`
   sentinel (set after all data has loaded)
4. Call `page.pdf({ format: 'A4', printBackground: true, ... })`
5. Save to a temp file
6. Pass the path to the sender script

The print-mode page is the same Results component but with a
different stylesheet that strips navigation, expands collapsibles,
and forces light-mode colours so the PDF prints cleanly.

### Slack sender

`pipeline/slack_email.py`. Posts to a Slack incoming webhook URL
(configured per-tenant or global in env). Payload:

```json
{
  "channel": "<recipient or channel>",
  "text": "Rack RK-... scanned",
  "attachments": [...summary blocks...],
  "files": [...uploaded via files.upload (separate call)...]
}
```

Slack file uploads use the multi-step `files.upload` flow:
`getUploadURLExternal` → POST file → `completeUploadExternal`.

### Teams sender

`pipeline/teams_send.py`. Two paths:

1. **Incoming webhook** — simpler; posts a card with summary
   text and a link to the PDF (uploaded to a shared blob). Card
   format is the Adaptive Card schema.
2. **Microsoft Graph** — when configured with a Graph app
   credential, posts directly to a chat or channel including
   attachments.

Most installs use the webhook path. Graph requires extra app
registration in Azure AD.

### Outlook sender

`pipeline/outlook_send.py`. Uses Microsoft Graph (`/me/sendMail`):

1. Acquire token via OAuth client-credentials grant (server-to-
   server) or device-code (interactive setup)
2. Build MIME multipart message with the PDF attached
3. POST to `https://graph.microsoft.com/v1.0/me/sendMail`

Token cache: `pipeline/shanakr_outlook_cache.json` (per-developer
filename — needs renaming for production).

### Recipient caching

After a successful send, the recipient is added to a recents list
so the user gets autocomplete next time. Cached in
`{user-cache-dir}/recipients.json` per user. Invalidated only on
explicit clear.

### Failure modes

| Failure | What user sees |
|---|---|
| PDF generation timeout | "Couldn't generate report in time" |
| Webhook 4xx | "Slack rejected the message — check the channel" |
| Microsoft Graph auth expired | "Please re-authenticate Outlook" with a re-auth flow |
| No recipient configured | option button disabled with a tooltip |

### Files in this feature

(See table at top of doc.)
