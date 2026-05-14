# RackTrack — Work Done Today

**Date:** 4 May 2026
**Branch:** `servicenow-bridge`

This document describes the two main pieces of work completed today:

1. **Light theme development** (minor visual changes across the app — listed below)
2. **APK complete setup and building** (full pipeline from local server → public URL → built Android APK)

---

## 1. Light Theme Development

The app already had a polished dark theme. Today we added a **second, fully-working light theme** so users can switch between dark (default) and a softer lavender / indigo / white look. All the visual changes are minor — colour and contrast tweaks only — but they touch nearly every screen because every page reads from the same set of CSS variables.

### 1.1 How it works (in one paragraph)

A new `ThemeProvider` wraps the whole app at the root. It writes either `data-theme="dark"` or `data-theme="light"` onto the `<html>` element and remembers the user's choice in `localStorage` (key: `racktrack:theme`). The dark palette is defined on `:root`; the light palette is defined on `[data-theme="light"]` and **re-maps the same variable names** (`--bg`, `--card`, `--c1`, `--t1`, etc.). Because every component already styles itself through those variables, switching theme just swaps the values — no component logic needs to change.

### 1.2 Files added

| File | Purpose |
|---|---|
| [client/src/ThemeContext.jsx](client/src/ThemeContext.jsx) | React context — exposes `theme`, `setTheme`, `toggleTheme`. Persists to localStorage. Default = `dark`. |
| [client/src/components/ThemeToggle.jsx](client/src/components/ThemeToggle.jsx) | Sun / moon icon button used in the Profile page. |
| [client/src/components/ThemeToggle.module.css](client/src/components/ThemeToggle.module.css) | Toggle button styling. |

### 1.3 Files modified (every change is minor — colour / variable swap only)

- [client/src/App.jsx](client/src/App.jsx) — wrapped the app tree in `<ThemeProvider>`.
- [client/src/index.css](client/src/index.css) — added the `[data-theme="light"]` block re-mapping every CSS variable (lavender backgrounds, indigo brand, near-black ink).
- [client/src/pages/HomePage.module.css](client/src/pages/HomePage.module.css) — hero card / quick-action tile overrides.
- [client/src/pages/ScanPage.module.css](client/src/pages/ScanPage.module.css) — capture button + frame guides re-tuned for light backgrounds.
- [client/src/pages/ResultsPage.module.css](client/src/pages/ResultsPage.module.css) — chips, badges, table rows, modal surfaces.
- [client/src/pages/HistoryPage.module.css](client/src/pages/HistoryPage.module.css) — list rows + status pills.
- [client/src/pages/ProfilePage.module.css](client/src/pages/ProfilePage.module.css) — settings rows, avatar, theme-toggle row.
- [client/src/pages/AuthPages.module.css](client/src/pages/AuthPages.module.css) — login / signup gradient + input field colours.
- [client/src/components/BottomNav.module.css](client/src/components/BottomNav.module.css) — tab-bar background, active-pill colour, icon contrast.
- [client/src/components/CmdbTicketBanner.module.css](client/src/components/CmdbTicketBanner.module.css) — banner colours per status.
- [client/src/components/RearImagePrompt.module.css](client/src/components/RearImagePrompt.module.css) — prompt card on light backgrounds.

### 1.4 Light-theme palette (for reference)

| Token | Dark value | Light value |
|---|---|---|
| `--bg` | `#010b1f` (midnight) | `#F0EFF5` (lavender) |
| `--card` | `rgba(255,255,255,0.05)` glass | `#FFFFFF` |
| `--c1` (brand) | `#3b82f6` royal blue | `#5B54B0` indigo |
| `--p1` (purple) | `#7c3aed` | `#4B45A0` |
| `--t1` (text) | `#f0f6ff` | `#1A1A2E` |
| Status `--green` / `--red` | `#10b981` / `#f43f5e` | `#22C55E` / `#EF4444` |

### 1.5 How a user switches theme

Profile page → tap the sun / moon icon. The choice is saved per-device, so the next launch opens in whichever theme was last picked.

---

## 2. APK — Complete Setup and Building

This section explains the **full chain** from "code on laptop" to "installable Android APK that talks to the live backend." This is the part that took the most setup; the rest of the document details every step, every file, and every command.

### 2.1 The big picture

```
   ┌─────────────────────┐
   │  Node API server    │     localhost:3001
   │  (server/app.js)    │     started by start.ps1
   └──────────┬──────────┘
              │
              │  Cloudflare quick tunnel
              ▼
   ┌─────────────────────────────────────────────┐
   │  https://<random>.trycloudflare.com         │   public URL (free, no account)
   └──────────┬──────────────────────────────────┘
              │
              │  written into client/.env.production
              ▼
   ┌─────────────────────┐
   │  Vite build         │     npm run build  →  client/dist/
   └──────────┬──────────┘
              │
              │  npx cap sync android  (copies dist → android assets)
              ▼
   ┌─────────────────────┐
   │  Android Studio     │     Build → Build APK(s)
   │  Gradle build       │     →  racktrack.apk
   └─────────────────────┘
```

The app is a React + Vite web app that Capacitor packages into an Android Studio project. Each rebuild flows: **change → npm build → cap sync → Android APK**.

### 2.2 The two helper PowerShell scripts

#### `start.ps1` — boots the whole local stack

[start.ps1](start.ps1) does five things in order:

1. **Kill leftovers.** `Stop-Process` on every running `node` and `cloudflared`. The Node worker pool spawns child Node processes that don't always die with the parent, so we wipe them all to avoid port-3001 conflicts.
2. **Wait for port 3001 to free up.** Loops up to 10 seconds polling `Get-NetTCPConnection`. Without this, the OS can hold the socket in `TIME_WAIT` for several seconds and the new server fails to bind.
3. **Start the API server.** Sets `RACKTRACK_WORKERS=4` (tuned for the i9-14900K / 128 GB workstation), then `Start-Process node app.js` minimised.
4. **Start the Cloudflare tunnel.** Runs `cloudflared.exe tunnel --url http://localhost:3001` and redirects stderr to `cf_temp.log`.
5. **Capture the public URL.** Polls the log file up to 30× at 2-second intervals, regex-matches the first `https://*.trycloudflare.com` URL, prints it in green, and writes it to [current-url.txt](current-url.txt).

After it finishes, `current-url.txt` is the single source of truth for "what URL is the backend exposed on right now."

#### `update-apk-url.ps1` — rebuilds the APK against that URL

[update-apk-url.ps1](update-apk-url.ps1) is the second half. It:

1. Reads `current-url.txt` (errors out if `start.ps1` hasn't been run).
2. Rewrites [client/.env.production](client/.env.production) so `VITE_API_BASE=` points at the new tunnel URL.
3. Runs `npm run build` inside `client/` → produces `client/dist/`.
4. Runs `npx cap sync android` → Capacitor copies `dist/` into `client/android/app/src/main/assets/public/` and refreshes plugin manifests.
5. Prints "Now build APK in Android Studio" — the only manual step left.

### 2.3 The end-to-end build flow

This is the exact sequence we ran today:

```powershell
# 1. Start local server + open public tunnel
.\start.ps1
# →  current-url.txt now contains a fresh https://*.trycloudflare.com URL

# 2. Point the client at the tunnel URL and rebuild the web bundle
.\update-apk-url.ps1
# →  client/.env.production updated
# →  client/dist/ rebuilt
# →  android assets resynced

# 3. Open Android Studio → Build → Build APK(s)
# →  client/android/app/build/outputs/apk/debug/racktrack.apk
```

Today's tunnel ended up at:

```
VITE_API_BASE=https://instruction-planning-truly-webcams.trycloudflare.com
```

(stored in [client/.env.production](client/.env.production))

### 2.4 What Capacitor actually does on `cap sync android`

Capacitor is what turns the React web app into an Android app. The pieces it touches:

| Path | What lives here |
|---|---|
| `client/dist/` | Vite output — the entire bundled web app (HTML, JS, CSS, images). |
| `client/android/app/src/main/assets/public/` | Where `cap sync` copies `dist/` so the WebView can serve it offline. |
| `client/android/app/src/main/assets/capacitor.config.json` | Runtime config — server scheme, allowed origins, plugin defaults. |
| `client/android/app/src/main/assets/capacitor.plugins.json` | Auto-generated plugin manifest. |
| `client/android/capacitor.settings.gradle` | Tells Gradle which Capacitor plugin modules to include. |

After `cap sync`, the Android project is a self-contained build target — no further Node tooling needed.

### 2.5 App icons and branding (refreshed today)

Every Android launcher density was replaced with the new RackTrack icon:

```
client/android/app/src/main/res/
  mipmap-ldpi/      ic_launcher.png, _round.png, _foreground.png
  mipmap-mdpi/      ic_launcher.png, _round.png, _foreground.png
  mipmap-hdpi/      ic_launcher.png, _round.png, _foreground.png
  mipmap-xhdpi/     ic_launcher.png, _round.png, _foreground.png
  mipmap-xxhdpi/    ic_launcher.png, _round.png, _foreground.png
  mipmap-xxxhdpi/   ic_launcher.png, _round.png, _foreground.png
```

Plus the source assets used by Capacitor's regen step:

- [client/assets/icon-foreground.png](client/assets/icon-foreground.png)
- [client/assets/icon-only.png](client/assets/icon-only.png)
- [client/public/dark_logo.png](client/public/dark_logo.png) — used inside the app on dark theme
- [client/public/white_logo.png](client/public/white_logo.png) — used on light theme

The icon background colour (the solid wash behind the foreground vector) was also adjusted in [client/android/app/src/main/res/values/ic_launcher_background.xml](client/android/app/src/main/res/values/ic_launcher_background.xml).

### 2.6 The built APK

Final output: [client/android/app/build/outputs/apk/debug/racktrack.apk](client/android/app/build/outputs/apk/debug/racktrack.apk)

This APK:
- Is a **debug build** (signed with the default debug keystore) — fine for sharing internally, **not** publishable to Play Store.
- Talks to whatever URL was in `.env.production` at build time.
- Bundles the entire web app — works offline for everything except API calls.
- Supports **both themes** (dark default, user-toggleable to light).

### 2.7 The deployment landing page

[DEPLOYMENT.html](DEPLOYMENT.html) is a self-contained HTML page (no build step, no framework) that serves as a public download / install guide. It includes:

- A short product description.
- A direct download link to the APK.
- Step-by-step Android install instructions (enable "Install unknown apps" → tap the file → confirm).
- Notes on the tunnel URL and that the demo backend is workstation-hosted.

### 2.8 What is *not* set up yet (so the picture is honest)

- **Release signing.** The APK is debug-signed. A real keystore + Gradle release config is needed for Play Store.
- **Stable URL.** Cloudflare quick-tunnel URLs change every time `start.ps1` is run — that's why we re-build the APK after each restart. A named Cloudflare tunnel (or AWS deployment per the migration plan) would fix this.
- **Auto-update.** Users have to re-install when a new APK is published. No in-app update mechanism is wired.
- **iOS.** Capacitor *can* target iOS, but only the Android project is configured today.

---

## 3. Quick command reference

```powershell
# Full restart + rebuild + repackage:
.\start.ps1                  # → fresh tunnel URL in current-url.txt
.\update-apk-url.ps1         # → web bundle rebuilt + Android assets synced
# Then in Android Studio: Build → Build APK(s)

# Just web changes (no URL change):
cd client
npm run build
npx cap sync android
# Then rebuild APK in Android Studio

# Toggle theme at runtime: Profile page → sun/moon icon (top right).
```

---

*Generated 4 May 2026. Branch: `servicenow-bridge`.*
