# RackTrack — Production Hosting Plan

**From a Cloudflare quick-tunnel demo to a production AWS deployment.**

This document is for non-engineering stakeholders who need to understand
*what we built*, *what holds it together today*, and *what it will take*
to move it onto a real cloud platform with the licenses required to ship.

---

## 1. Executive Summary

RackTrack is an AI-powered mobile + web application that lets a datacenter
technician point a phone camera at a server rack, automatically identify
every device and port in the image, reconcile that real-world view against
the customer's ServiceNow CMDB, and raise an incident or service request
when reality and records disagree. The technician can also push the rack's
discovered devices into Netdisco for ongoing network monitoring, and share
the resulting report over Slack, Microsoft Teams, or Outlook.

The **demo is fully working** today, hosted out of a single Windows
workstation and exposed to the internet through a free Cloudflare quick
tunnel. The product is *demo-ready, not customer-ready*. To put it in front
of a paying customer, we need real cloud hosting, real authentication
infrastructure, real backups, and the right ServiceNow / Microsoft /
Slack subscriptions in the customer's name.

This document describes both halves: what exists today, and the AWS plan
to take it from a demo to a production deployment.

---

## 2. What We've Built

### 2.1 Core capabilities

| Capability | What it does |
|---|---|
| **Rack scanning** | Phone or browser camera captures a rack image; server detects every U-slot, every device, every port using five trained AI models. |
| **Device identification** | Each detected device is classified (switch / patch panel / server) and its port count is read from the front face of the device. |
| **Cable inspection** | A separate model classifies the cables visible on each port (copper / fibre / unused). |
| **Manual correction loop** | The technician can correct any mis-detection in the UI; corrections are stored as feedback for future model retraining. |
| **CMDB reconciliation** | The scan result is diffed against the ServiceNow CMDB; differences become a draft Service Request the technician can review, accept, or reject. |
| **Incident creation** | A one-click action raises a ServiceNow incident from the scan's findings, pre-populated with affected CIs and the rack image. |
| **Netdisco bridge** | Detected devices can be pushed into a local Netdisco instance for ongoing SNMP-based network discovery and MAC/IP tracking. |
| **Switch console access** | The app can SSH into a discovered switch, run a configurable command set, and embed the transcript in the rack report. |
| **Reporting** | Every scan produces an HTML, JSON, CSV, or PDF report. |
| **Sharing** | The PDF report can be sent over Slack DM, Microsoft Teams DM, or Outlook email — with the recipient prompted by name and remembered per channel. |
| **Authentication** | Email + password sign-up with email verification, JWT sessions, password complexity policy. |

### 2.2 What runs where

| Layer | Technology |
|---|---|
| Web frontend | React + Vite, packaged with Capacitor as an Android APK. |
| API server | Node.js / Express. |
| AI pipeline | Python 3.10 with PyTorch, Ultralytics YOLO, EfficientNet, OpenCV. |
| Worker pool | Custom Node ↔ Python pool — keeps the ML models warm in RAM so each scan finishes in seconds instead of cold-starting per request. |
| Authentication store | SQLite file (`server/data/auth.db`). |
| Scan results | Plain JSON files on the local filesystem (`outputs/`). |
| Uploads | Local filesystem (`server/uploads/`, 340 MB per file). |
| Feedback log | Append-only JSONL file (`server/feedback.jsonl`). |
| External integrations | ServiceNow REST API, Netdisco REST API + Postgres, Microsoft Graph (Teams + Outlook), Slack Web API. |

### 2.3 Where the AI models live

Five trained models, ~480 MB total, are loaded into a worker pool at
startup and held in RAM for the lifetime of the process. They run on
**CPU by default** (no CUDA code is hard-wired); a GPU will accelerate
them automatically if one is present.

---

## 3. How It's Hosted Today

```
   ┌─────────────────────┐
   │  Technician's phone │
   │   (Android APK)     │
   └──────────┬──────────┘
              │  HTTPS to a *.trycloudflare.com URL
              ▼
   ┌─────────────────────┐         ┌──────────────────────┐
   │ Cloudflare quick    │ ◄──────► │ cloudflared.exe      │
   │ tunnel (FREE)       │          │ (running on i9 box)  │
   └──────────┬──────────┘         └─────────┬────────────┘
              │ localhost:3001                │
              ▼                               ▼
   ┌────────────────────────────────────────────────────┐
   │  Windows workstation (i9-14900K, 128 GB RAM)       │
   │  ─────────────────────────────────────────────     │
   │   Node.js Express server  +  4 Python workers      │
   │   SQLite (auth)  +  filesystem (scans, uploads)    │
   │   ServiceNow / Netdisco / Slack / Graph clients    │
   └────────────────────────────────────────────────────┘
```

The deployment script does three things:

1. Starts the Node server with four Python workers.
2. Launches `cloudflared.exe tunnel --url http://localhost:3001`, which
   prints a fresh `https://xyz.trycloudflare.com` URL.
3. Captures that URL, writes it into the Capacitor `.env.production`,
   rebuilds the React bundle, and re-syncs the Android project so the
   APK can be re-built with the new URL hardcoded in.

---

## 4. Pros & Cons of the Current Setup

### Pros

* **Zero hosting cost.** No AWS bill, no domain registration, no certificate
  procurement. Cloudflare quick tunnels are free and unlimited.
* **One command to bring up.** `start.ps1` boots the entire stack in under a
  minute on the workstation.
* **Powerful local hardware.** The i9-14900K with 128 GB RAM is faster than
  most affordable cloud instances we'd realistically rent.
* **Perfect for live demos.** A salesperson can wake the box, run the
  script, and show the product to a prospect on a real phone in minutes.

### Cons

* **The URL changes every restart.** `*.trycloudflare.com` is ephemeral.
  Every time the workstation reboots or the tunnel drops, the APK has to
  be rebuilt and reinstalled. This is unacceptable for a real customer.
* **Single point of failure.** If the workstation is off, the whole product
  is offline. There is no health monitoring, no auto-restart, no failover.
* **No backups.** SQLite (auth), `outputs/`, and `uploads/` live on one
  local disk. A failed drive loses every user account, every scan, every
  uploaded image, every piece of feedback.
* **Security posture is weak.**
  * A Slack user token (`xoxp-…`) is hardcoded in source.
  * MSAL token caches sit unencrypted on disk.
  * Microsoft Azure tenant + client IDs are hardcoded in source.
  * No firewall, no rate limiting, no WAF, no DDoS protection beyond
    whatever Cloudflare's free tier provides.
* **No audit trail beyond a flat JSONL file.** Compliance-conscious
  customers (which most enterprises are) will need centralised, tamper-
  resistant audit logs.
* **Scale ceiling.** A single host with four CPU workers can handle perhaps
  a handful of concurrent technicians; a real rollout to a datacenter
  operations team would saturate it.
* **Cloudflare quick tunnels are explicitly not for production.** Cloudflare
  reserves the right to throttle or kill them; SLAs do not exist.
* **No staging environment.** Every code change is tested directly against
  the same instance the demo runs on.

---

## 5. The AWS Plan

### 5.1 Goals

1. **A stable URL** under a real domain (e.g. `app.racktrack.ai`).
2. **High availability** — the app survives a single host failure.
3. **Real backups** — auth data, scan results, uploads, audit logs.
4. **Per-customer isolation** — each customer's data is scoped to their
   tenant; one customer cannot see another's CMDB or scans.
5. **Scalable AI workers** — capacity grows with demand instead of being
   capped by one workstation.
6. **Secrets out of source code.**

### 5.2 Target architecture

```
                    ┌──────────────────────────────┐
                    │  Route 53  (DNS)             │
                    └─────────────┬────────────────┘
                                  │
                    ┌─────────────▼────────────────┐
                    │  CloudFront + AWS WAF        │
                    │  (CDN, TLS, DDoS, rate-limit)│
                    └─────────────┬────────────────┘
                                  │
                    ┌─────────────▼────────────────┐
                    │  Application Load Balancer   │
                    └─────────────┬────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                                       ▼
     ┌────────────────────┐                ┌─────────────────────┐
     │  ECS Fargate task  │                │  ECS Fargate task   │
     │  (Node API + Py    │       …        │  (Node API + Py     │
     │   workers, GPU)    │                │   workers, GPU)     │
     └────────┬───────────┘                └────────┬────────────┘
              │                                     │
              ├─ S3        (uploads, scan outputs, model files, PDFs)
              ├─ RDS PG    (auth users, scans, audit log, feedback)
              ├─ Secrets   (Slack, Graph, ServiceNow, JWT secret)
              ├─ CloudWatch (logs, metrics, alarms)
              └─ ServiceNow REST API   (customer's instance, over the public internet)

     ┌────────────────────────────────────────────────┐
     │  Netdisco — separate ECS service + RDS PG      │
     │  (only deployed if the customer wants it)      │
     └────────────────────────────────────────────────┘
```

### 5.3 Service-by-service mapping

| What it does today | AWS service | Why |
|---|---|---|
| Cloudflared exposing `localhost:3001` | **Route 53** + **ACM** + **CloudFront** + **ALB** | Stable custom domain, valid TLS, DDoS protection, geo edge caching for the React bundle. |
| Node + Python workers on the i9 box | **ECS Fargate** (or **EC2 g5.xlarge / g4dn.xlarge** if GPU-backed inference is required for speed) | Containerised, restart-on-crash, blue/green deploys, autoscaling. The existing Dockerfile is already 90% of what's needed. |
| ML models in `Models/` (480 MB) | **S3 bucket** (private), pulled by the container at startup | Keeps Docker images slim; new model versions become an S3 upload, not a redeploy. |
| `server/data/auth.db` (SQLite) | **RDS for PostgreSQL** (Multi-AZ, db.t3.medium to start) | Multi-host safe, automatic backups, point-in-time recovery. The auth code needs a small migration from `better-sqlite3` to `pg`. |
| `outputs/` and `server/uploads/` | **S3** (private, server-side encryption, lifecycle to Glacier after 90 days) | Durable, infinite, cheap, cross-AZ. |
| `server/feedback.jsonl` | **DynamoDB** *or* an `events` table in RDS | Append-only, indexable, queryable for analytics. |
| Hardcoded Slack token, MSAL caches, JWT secret | **AWS Secrets Manager** | Rotated, audited, no longer in source. The hardcoded `xoxp-` token must be revoked and re-issued the day we cut over. |
| `cf_temp.log` + `console.log` | **CloudWatch Logs** + **CloudWatch Alarms** | Centralised, retained, alertable. |
| Manual restart on crash | **ECS service auto-recovery** + **health checks on `/api/health`** | Container that fails its health probe is killed and replaced. |
| Netdisco (Docker on workstation) | **Separate ECS service** + **RDS for PostgreSQL** (Netdisco's own DB) | Only deployed for customers who want it; isolated from the main API. |
| Per-customer image / scan separation | **S3 prefixes per tenant** + **RDS row-level tenant_id** | Required if we onboard more than one organisation. |
| APK distribution | **S3 + CloudFront** (or Google Play closed track) | Stable download URL for the Android build. |

### 5.4 Infra delivered as code

* **Terraform** (or AWS CDK in TypeScript) for everything above —
  VPC, subnets, security groups, ECS cluster, RDS, S3 buckets, IAM
  roles, CloudFront distribution, Route 53 records.
* **GitHub Actions** pipeline:
  1. Lint + test on every push.
  2. Build Docker image, tag with the commit SHA, push to ECR.
  3. Update the ECS service to the new image (blue/green via
     CodeDeploy).
  4. Run a smoke test against the new task before shifting traffic.

---

## 6. Licenses, Subscriptions & External Accounts to Procure

The product is heavily integration-driven; AWS is only one of several
bills. Each item below is a real obligation that needs an owner inside
the customer's organisation.

### 6.1 ServiceNow

| Item | Why it's needed | Ballpark |
|---|---|---|
| **A ServiceNow instance** | The whole CMDB / Incident / Service Request feature set runs against the customer's ServiceNow instance. We don't host it for them. | Customer-supplied (existing ServiceNow customers already have it). |
| **ITSM module** | For Incident creation. | Standard in any modern ServiceNow ITSM subscription. |
| **CMDB module + ITOM Visibility** *(recommended)* | For the CMDB tables we read/write (`cmdb_ci`, `cmdb_ci_rack`, `cmdb_rel_ci`). Basic CMDB ships with ITSM, but ITOM Visibility unlocks discovery, identification, and reconciliation features that complement RackTrack's diff. | Add-on. ServiceNow does not publish list pricing — typical enterprise spend is **negotiated per-user / per-CI**. Treat as a six-figure annual line item for enterprise customers. |
| **Service Catalog + Service Request management** | Our reconciliation workflow opens `sc_request` records. Comes with ITSM. | Included in ITSM. |
| **Custom CMDB field `u_racktrack_id`** | One-time admin task on the customer's instance — not a license, but a deployment prerequisite. | Free. |
| **A dedicated integration user** with `rest_service` + `cmdb_admin` roles | Recommended over reusing an admin account. Customer creates this for us. | Free. |

> **Bottom line on ServiceNow:** we do not sell ServiceNow; we integrate
> with it. The customer must already be a ServiceNow ITSM customer with
> CMDB enabled. If they aren't, RackTrack is a non-starter until they
> are. This is the single biggest external dependency.

### 6.2 Microsoft 365 / Azure (for Teams + Outlook sharing)

| Item | Why |
|---|---|
| **Microsoft 365 Business Standard or higher** | Required for Outlook mailbox + Teams chat. Customer-side. |
| **Azure AD app registration** in the *customer's* tenant | One-time admin consent for the Graph scopes `Mail.Send`, `Mail.ReadWrite`, `Chat.ReadWrite`, `ChatMessage.Send`, `Files.ReadWrite`, `User.Read`. The IDs currently hardcoded in source point at *our* Azure tenant — for production we register a new multi-tenant app and document the consent URL. |
| **A service / shared mailbox** *(recommended)* for sending Outlook reports, instead of impersonating a real user. |

### 6.3 Slack

| Item | Why |
|---|---|
| **Slack workspace** (any paid plan; Free works for a pilot) | DM-based file delivery. |
| **Slack app installed in the customer's workspace** with the scopes `users:read.email`, `chat:write`, `files:write`, `im:write`. The current app must be migrated off the personal `xoxp-` token onto a workspace-scoped bot token (`xoxb-`). |

### 6.4 AWS

| Item | Notes |
|---|---|
| AWS account + Organizations setup | One management account, separate `staging` and `production` accounts. |
| Domain registration | Either through Route 53 or transferred in. ~USD 12 / year for `.com`. |
| ACM certificates | Free. |
| Reserved instances / Savings Plans | After 1–2 months of stable usage, lock in 1-year RIs / Savings Plans for 30–50 % off. |

### 6.5 Estimated AWS monthly run-rate (small pilot, single region)

| Component | Approx. monthly cost (USD) |
|---|---|
| ECS Fargate (2 tasks, 4 vCPU, 16 GB each, 24×7, CPU-only inference) | ~ 220 |
| *or* EC2 g4dn.xlarge × 1 (GPU inference, 24×7, on-demand) | ~ 380 |
| RDS PostgreSQL db.t3.medium Multi-AZ + 100 GB storage | ~ 130 |
| S3 (200 GB stored, 50 GB transferred) | ~ 10 |
| CloudFront + WAF (modest traffic) | ~ 40 |
| Route 53 hosted zone + queries | ~ 5 |
| Secrets Manager + CloudWatch + KMS | ~ 25 |
| ALB | ~ 25 |
| **Total (CPU-only)** | **~ 455 / month** |
| **Total (GPU-backed)** | **~ 615 / month** |

Numbers above are **order-of-magnitude estimates** for a single-tenant
pilot. A multi-customer rollout, additional regions, or Netdisco being
co-hosted will scale this up. None of the figures include staff time,
ServiceNow licensing (which dwarfs AWS), or Microsoft / Slack subscriptions.

---

## 7. Migration Phases

| Phase | Duration | Outcome |
|---|---|---|
| **0. Hardening** | 1 week | Revoke and rotate the hardcoded Slack token. Move every secret out of source into Secrets Manager (run locally first). Add a `/api/health` endpoint. Pin all model files into S3. |
| **1. Containerise & validate** | 1 week | Build the existing Dockerfile in CI, run end-to-end on a single EC2 instance. Confirm scan latency on a CPU-only target; decide CPU vs GPU. |
| **2. Stateful migration** | 2 weeks | Port `auth.db` from SQLite to RDS Postgres. Move `outputs/` and `uploads/` writes from local FS to S3 with pre-signed URLs. Stand up RDS, S3, Secrets Manager, CloudWatch via Terraform. |
| **3. Multi-host runtime** | 1 week | Switch to ECS Fargate behind an ALB. Verify worker-pool warm-up time is acceptable on container restart (consider warming via S3-cached models). Wire up health checks and autoscaling. |
| **4. Production cutover** | 1 week | Route 53 + CloudFront + WAF + ACM. Rebuild the Android APK to point at the new domain (one final rebuild — after this, the URL is permanent). Disable the Cloudflare tunnel. |
| **5. Observability & runbooks** | 1 week | CloudWatch alarms (5xx rate, worker-pool saturation, S3 4xx). PagerDuty / email pager. Operational runbook for token rotation, model upload, customer onboarding. |
| **6. Per-tenant onboarding flow** | 2 weeks | Self-service signup → ServiceNow integration setup wizard (instance URL, integration-user creds, Slack/Teams app install links). |

**Total: ~9 weeks of engineering time** to reach a state where the first
external customer can be onboarded.

---

## 8. Security & Compliance Checklist

Before a customer signs:

* [ ] Hardcoded Slack token revoked.
* [ ] All secrets in Secrets Manager, none in Git.
* [ ] Per-tenant data isolation enforced (S3 prefix + RDS `tenant_id`).
* [ ] Audit log written to an append-only store (CloudWatch Logs with
      retention or DynamoDB stream to S3).
* [ ] TLS 1.2+ enforced end-to-end (CloudFront + ALB + RDS).
* [ ] At-rest encryption enabled on S3, RDS, EBS, Secrets Manager.
* [ ] IAM least-privilege per ECS task role (no wildcard S3 access).
* [ ] Backups: RDS automated daily + 7-day PITR, S3 versioning on the
      `outputs/` and `uploads/` buckets.
* [ ] CloudTrail enabled in the production account.
* [ ] WAF rules: rate-limit `/api/auth/login`, geo-block where required,
      AWS-managed common-rules ruleset.
* [ ] Image-upload virus scan (S3 trigger → Lambda + ClamAV / GuardDuty
      Malware Protection).
* [ ] Dependency scanning in CI (npm audit, pip-audit).
* [ ] Penetration test before the first paying customer.

If a customer requires SOC 2 or ISO 27001, plan for an additional
**3–6 months** of audit prep on top of the above.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ServiceNow integration breaks on customer instance variants (HR, ITOM, custom field collisions) | Abstract the table layer in `servicenow/`; run our integration tests against a *fresh* PDI for every release. |
| Cold-start of the Python worker pool is slow (models load from S3) on every container restart | Bake models into the Docker image *or* mount an EFS volume preloaded with the models. EFS is the simpler path. |
| GPU instances quotas are limited per region | Open AWS quota requests early; have a CPU-only fallback path. |
| Customer's ServiceNow instance enforces MFA on the integration user | Switch from basic auth to OAuth + service account before first GA customer. |
| Microsoft Graph token-cache pattern (device flow) doesn't survive in a stateless container | Move to a **client-credentials flow** with a per-tenant Azure app — no human "login once" step needed. |
| Slack `xoxp-` user token policy violation | Migrate to a workspace bot (`xoxb-`) at the same time as production cutover. |
| The Netdisco Postgres push uses raw DB credentials | Replace with Netdisco's REST endpoints if/where they exist; keep DB push behind a VPC peering link, never over the public internet. |

---

## 10. Open Decisions

1. **CPU vs GPU inference.** A g4dn.xlarge cuts scan time roughly 4–6×
   versus a CPU Fargate task, but doubles the bill. Decide based on the
   first customer's expected scans-per-hour.
2. **Single-region or multi-region.** Single-region (us-east-1 or
   eu-west-1, depending on the customer) is the obvious starting point.
   Multi-region is a year-two concern.
3. **Self-service signup or sales-led onboarding.** Self-service requires
   a polished wizard for the ServiceNow / Slack / Teams setup; sales-led
   means a deployment engineer does it once per customer.
4. **Bundle Netdisco or sell separately.** If we bundle it, every
   customer gets a second ECS service + a second RDS Postgres. If we
   sell separately, we save infra but lose a differentiating feature.
5. **Mobile distribution channel.** Sideloaded APK from S3 vs. Google
   Play closed track vs. full Play Store listing. The first is fastest;
   the third is most professional.

---

## 11. Summary

Today, RackTrack is a polished demo running on one workstation behind a
free Cloudflare tunnel. It is good enough to win a sales meeting and not
yet ready to host a paying customer.

The path to production is well understood — **roughly nine weeks of
engineering effort and a few hundred dollars per month of AWS spend** —
and the heavy external lift sits with the customer (ServiceNow, M365,
Slack), not with us. The architecture diagram in section 5.2 is the
target; the migration phases in section 7 are the plan.

The most urgent action regardless of timing is **section 8's first item**:
revoke the hardcoded Slack token in [pipeline/slack_email.py](pipeline/slack_email.py)
and move it to environment-driven configuration before this codebase
is shared any wider.
