/**
 * OrtNative — Capacitor plugin TypeScript bridge.
 *
 * Talks to the Android-side OrtNativePlugin which runs ONNX models through
 * native onnxruntime-android with NNAPI acceleration. Drop-in performance
 * alternative to onnxruntime-web (WASM) for inference on the phone.
 *
 * Models are loaded from app assets — the BenchmarkPage's "/models/foo.onnx"
 * path maps to "public/models/foo.onnx" inside the APK after `npx cap sync`.
 *
 * Usage:
 *   import { OrtNative } from '@/plugins/OrtNative';
 *   const s = await OrtNative.loadSession({ modelPath: '/models/unit_int8.onnx' });
 *   const r = await OrtNative.runFromDataUrl({
 *     sessionId: s.sessionId, dataUrl: photo.dataUrl, inputSize: 640,
 *   });
 *   // r.output is a flat number[]; reshape with r.dims for decoding.
 *   await OrtNative.releaseSession({ sessionId: s.sessionId });
 */

import { registerPlugin } from '@capacitor/core';

export type OrtSessionHandle = {
  sessionId: string;
  inputName: string;
  outputName: string;
  loadMs: number;
  /** 'nnapi' if NNAPI added cleanly; 'cpu' if it fell back. */
  backend: 'nnapi' | 'cpu';
};

export type OrtRunResult = {
  /** Flat output values, row-major. Reshape using `dims`. */
  output: number[];
  /** Tensor shape, e.g. [1, 5, 8400] for YOLO heads. */
  dims: number[];
  /** Wall-clock inference time on the native side (ms). Excludes the
   *  JS↔native bridge cost — measure that separately on the JS side. */
  inferMs: number;
  outputName: string;
};

export interface OrtNativePlugin {
  loadSession(opts: { modelPath: string; useNnapi?: boolean }): Promise<OrtSessionHandle>;
  runFromDataUrl(opts: {
    sessionId: string;
    dataUrl: string;
    inputSize: number;
  }): Promise<OrtRunResult>;
  releaseSession(opts: { sessionId: string }): Promise<{ released: boolean }>;
}

const web: OrtNativePlugin = {
  async loadSession() {
    throw new Error('OrtNative is Android-only — use onnxruntime-web on this platform');
  },
  async runFromDataUrl() {
    throw new Error('OrtNative is Android-only — use onnxruntime-web on this platform');
  },
  async releaseSession() {
    return { released: false };
  },
};

export const OrtNative = registerPlugin<OrtNativePlugin>('OrtNative', { web: () => web });

/** True if the native plugin is callable on the current platform. */
export async function isOrtNativeAvailable(): Promise<boolean> {
  try {
    // Cheap probe — loading a non-existent model fails, but it fails on the
    // native side, which means the bridge is wired up. On web, our stub
    // throws synchronously with a 'Android-only' message.
    await OrtNative.loadSession({ modelPath: '/__probe__.onnx' });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Android-only')) return false;
    // Any other error (file not found etc.) means the plugin IS wired up.
    return true;
  }
}
