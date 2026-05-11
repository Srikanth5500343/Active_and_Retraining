/**
 * Web fallback for the RackAR plugin.
 *
 * Browsers don't have ARKit/ARCore. This stub returns ar:false so the UI
 * can route around it (show "AR requires iOS 12+ or Android with ARCore"
 * and fall back to the existing camera scan).
 */

import { WebPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ARSupport, RackARPlugin } from './RackAR';

export class RackARWeb extends WebPlugin implements RackARPlugin {
  async isSupported(): Promise<ARSupport> {
    return { ar: false, camera: 'prompt', platform: 'web' };
  }

  async requestPermissions(): Promise<ARSupport> {
    return { ar: false, camera: 'denied', platform: 'web' };
  }

  async start(): Promise<void> {
    throw this.unavailable('AR is not supported in the browser. Open this on iOS 12+ or an ARCore-capable Android device.');
  }

  async setOverlay(): Promise<void> {
    throw this.unavailable('AR is not active.');
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  // Override the typed addListener with a permissive any-shape so the
  // discriminated-union signature in RackAR.ts doesn't conflict here.
  // The web shim never emits real events; the cleanup handle is still
  // returned so callers can call .remove() unconditionally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addListener(_event: any, _cb: any): Promise<PluginListenerHandle> {
    return Promise.resolve({
      remove: async () => { /* no-op */ },
    } as PluginListenerHandle);
  }
}
