# 22. iOS + AR — RackAR Capacitor plugin

## What it does (junior view)

The standard scan flow asks the user to take a photo, upload it,
wait for results. **AR mode** makes that interactive: the user
points the phone camera at the rack and sees device labels float
in real-time over the camera feed, anchored to each chassis as
they move around the rack.

User flow with AR:

1. Open the app, tap **AR Scan**.
2. The phone opens a fullscreen AR view with the live camera.
3. As the user pans across the rack, frames are sent to the
   detection pipeline (initially server-side, on-device later).
4. Detected devices come back as labelled bounding boxes anchored
   to the camera view — they stick to the chassis even as the user
   moves.
5. The user can **tap a label** to drill in — see specs, ports,
   firmware, etc.
6. Tap **Stop** to exit AR.

Why AR instead of a static photo:
- Field engineers walk the rack and want to see what's where as
  they go, not after a 30-second roundtrip
- Tapping a real-world device is more natural than tapping a
  thumbnail of a photo
- Live tracking surfaces problems (a missed device) the moment
  the user moves their phone, not after they're done scanning

The plugin handles iOS (ARKit) and Android (ARCore) natively;
the JS side is a TypeScript bridge that talks to the native
view through Capacitor.

## What it doesn't do

- It doesn't run inference on-device yet. Frames go up to the
  server, results come back over the WebSocket / fetch. On-device
  inference (CoreML / TFLite) is the next step — the plugin is
  designed to swap in a local detector without changing the
  JS contract.
- It doesn't handle multi-rack stitching in one AR session.
  Each AR session is one rack at a time.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `client/src/plugins/RackAR.ts` | Capacitor plugin TS bridge (the JS API) |
| `client/src/plugins/RackAR.web.ts` | Web fallback — surfaces `ar: false` |
| `client/ios/...` (TBD) | Native ARKit view (Swift) |
| `client/android/.../RackAR*.java` | Native ARCore view |
| `client/capacitor.config.json` | Plugin registration |

### JS API

```ts
import { RackAR } from '@/plugins/RackAR';

// 1. Capability check
const supported = await RackAR.isSupported();
// supported = { ar: true, camera: 'granted', platform: 'ios' }
if (!supported.ar) {
  // Fall back to /scan (photo upload)
  return navigate('/scan');
}

// 2. Open the AR view
await RackAR.start();

// 3. Listen for live frames (when streaming to a server / on-device)
const frameListener = await RackAR.addListener('frame', (frame) => {
  // frame = { width, height, jpeg: Uint8Array, timestamp }
});

// 4. Listen for taps on rendered labels
const tapListener = await RackAR.addListener('tap', (e) => {
  // e = { id: 'device-4', point: {x, y} }
  // -> open the SwitchCard for device-4
});

// 5. Push detection results back to be rendered as overlays
await RackAR.setOverlay({
  devices: [
    { id: 'device-4', label: 'MikroTik CRS326', bbox: [x, y, w, h], color: '#22d3ee' },
    ...
  ],
});

// 6. Stop
await RackAR.stop();
await frameListener.remove();
await tapListener.remove();
```

### Native shape (iOS / ARKit)

Native side opens a fullscreen camera with `ARSession`
(world-tracking config). Steps per frame:

1. Capture pixel buffer
2. Resize + JPEG-encode at ~640x480 to keep bandwidth manageable
3. Emit `frame` event with the JPEG bytes
4. When `setOverlay` is called from JS, project the supplied
   image-space bboxes into 3D world anchors using the camera's
   intrinsic matrix at capture time — labels stay attached to
   the chassis as the user moves
5. On tap, hit-test the overlay in screen space, find the
   nearest anchor, emit `tap` with the anchor id

The bbox-to-3D projection is the hard part — without correct
depth, labels drift as the user changes angle. ARKit's plane
detection helps when the rack face is roughly planar (which it
usually is); the labels anchor to the detected vertical plane
and stay glued.

### Native shape (Android / ARCore)

Mirrors the iOS path — `Session` + `Frame` + `Pose` from
ARCore. Same `frame`/`tap`/`setOverlay` event surface so the JS
layer doesn't care which platform is underneath.

### Web fallback

`RackAR.web.ts`:

```ts
export const RackAR = {
  async isSupported() {
    return { ar: false, camera: 'denied', platform: 'web' };
  },
  async start() { throw new Error('AR not supported in web build'); },
  // ... stubs
};
```

The app calls `isSupported()` first; web builds skip the AR
button entirely.

### Frame → detection roundtrip

Initial design: every frame (or every Nth frame, throttled to
~1-2 Hz) is sent to `/api/analyze` as a JPEG. The detection
result comes back, then `setOverlay({ devices })` updates the
AR view.

This is **slow on cellular** (network roundtrip dominates).
Targeting:

- 4G, server-side inference: 800-2000ms latency per frame
- WiFi, server-side inference: 200-500ms
- On-device inference (next step): 50-100ms, no network

For 1-2 Hz UX we want sub-500ms. WiFi works; cellular is
borderline. The proper answer is **on-device inference** —
ship a quantized YOLO weights as a CoreML / TFLite asset, run
inference in-process, fall back to the server only when the
on-device confidence is low.

### What's there today vs aspirational

| Component | Status |
|---|---|
| TypeScript plugin bridge (`RackAR.ts`) | done |
| Web fallback | done |
| Capacitor plugin registration | done |
| Native iOS scaffold (`client/ios/`) | not yet generated — `npx cap add ios` is the half-day starter |
| Native Android scaffold | started; ARCore wiring partial |
| On-device inference | not yet — next milestone |
| Plane-anchored overlay rendering | spec'd; native impl pending |

### Building for iOS (when ready)

```bash
cd client
npx cap add ios
npx cap sync ios
npx cap open ios   # opens Xcode
```

In Xcode:
1. Configure signing (team + bundle id)
2. Add the `NSCameraUsageDescription` plist entry
3. Build to a real device (ARKit doesn't run in the simulator)

### Building for Android (current path)

`client/android/` already exists. Add ARCore via:

```gradle
implementation "com.google.ar:core:1.43.0"
```

And the `<uses-feature android:name="android.hardware.camera.ar" />`
manifest entry. The Android side can also fall back to a
non-AR camera capture flow; the plugin emits `ar: false` if the
device doesn't support ARCore.

### Files in this feature

| File | Role |
|---|---|
| `client/src/plugins/RackAR.ts` | TS bridge |
| `client/src/plugins/RackAR.web.ts` | Web fallback |
| `client/capacitor.config.json` | Plugin registration |
| `client/android/.../RackAR*.java` | Android native |
| `client/ios/.../RackAR.swift` (TBD) | iOS native |
