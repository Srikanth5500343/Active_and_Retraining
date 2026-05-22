/**
 * RackAR — Capacitor plugin TypeScript bridge.
 *
 * Wraps the native ARKit (iOS) / ARCore (Android) implementations of the
 * AR rack-overlay view. The native side opens a fullscreen camera with
 * device tracking; this JS side ships frames to the existing `/api/analyze`
 * pipeline (or an on-device model later) and posts back the device list as
 * AR labels anchored to the live image.
 *
 * Usage:
 *   import { RackAR } from '@/plugins/RackAR';
 *   const supported = await RackAR.isSupported();
 *   if (!supported.ar) { ...fall back to /scan }
 *   await RackAR.start();                    // opens fullscreen AR view
 *   RackAR.addListener('frame', (f) => ...) // raw camera frames
 *   RackAR.addListener('tap',   (t) => ...) // user tapped a label
 *   await RackAR.setOverlay({                // push detection result
 *     devices: [{ id, label, bbox: [x,y,w,h], color }]
 *   });
 *   await RackAR.stop();
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type ARSupport = {
  /** Native AR (ARKit/ARCore) is available + permitted on this device. */
  ar: boolean;
  /** Camera permission state — 'granted' | 'denied' | 'prompt'. */
  camera: 'granted' | 'denied' | 'prompt';
  /** Platform: 'ios' | 'android' | 'web'. */
  platform: string;
};

export type ARDeviceLabel = {
  /** Stable id (e.g. server-issued) so subsequent frames update the
   *  same anchor instead of recreating it. */
  id: string;
  /** Text shown above the bounding box. */
  label: string;
  /** Image-space bounding box (px) at the time of capture: [x, y, w, h].
   *  Native side uses the captured frame's dimensions to convert this
   *  into a world-space anchor. */
  bbox: [number, number, number, number];
  /** Optional color hint for the label background (#RRGGBB). */
  color?: string;
  /** Optional secondary line (e.g. U-position, port count). */
  sublabel?: string;
};

export type ARFrameEvent = {
  /** Capture timestamp (ms). */
  ts: number;
  /** JPEG-encoded camera frame as base64 (no data: prefix). The native
   *  side throttles frames so JS isn't flooded — see `frameRateHz` in
   *  start() options. */
  jpegBase64: string;
  /** Frame dimensions for bbox math. */
  width: number;
  height: number;
};

export type ARTapEvent = {
  /** Id of the device label that was tapped (matches ARDeviceLabel.id). */
  id: string;
};

export interface RackARPlugin {
  /** Probe device capabilities. Always returns; doesn't throw. */
  isSupported(): Promise<ARSupport>;

  /** Request camera + AR permissions. Resolves with the new state. */
  requestPermissions(): Promise<ARSupport>;

  /** Open the fullscreen AR view. The WebView is hidden behind it.
   *  options.frameRateHz: how many frames/second to forward to JS via
   *    'frame' events. Default 1 (cheap; tune up for live tracking). */
  start(options?: { frameRateHz?: number }): Promise<void>;

  /** Replace the labels currently anchored to the AR scene. */
  setOverlay(payload: { devices: ARDeviceLabel[] }): Promise<void>;

  /** Tear down the AR session and re-show the WebView. */
  stop(): Promise<void>;

  /** Frame from the AR camera (base64 JPEG + dims). Subscribe with
   *  RackAR.addListener('frame', ...). */
  addListener(
    event: 'frame',
    cb: (e: ARFrameEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** User tapped a device label. */
  addListener(
    event: 'tap',
    cb: (e: ARTapEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Lifecycle: native AR session ended (user backed out, error, etc.). */
  addListener(
    event: 'ended',
    cb: (e: { reason: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const RackAR = registerPlugin<RackARPlugin>('RackAR', {
  // Web fallback: AR isn't available in a browser. Expose a no-op shim
  // so dev builds + browser preview don't crash. Pages should check
  // `isSupported().ar` before calling start().
  web: () => import('./RackAR.web').then((m) => new m.RackARWeb()),
});
