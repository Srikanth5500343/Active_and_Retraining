/**
 * Active Learning Module - stores & applies learned cable color corrections
 *
 * When a user corrects a cable color in the UI, we:
 * 1. Store the correction with perceptual hash + embedding
 * 2. Next classification checks against learned corrections first
 * 3. Improves accuracy by learning from user feedback
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

// This would require integrating Python embeddings or running them in Node
// For now, we'll store hash-based corrections and rely on the cable classifier
// to check them. The full embedding approach would require a Node.js binding
// to the PyTorch embedder.

class ActiveLearningManager {
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.correctionsFile = path.join(storeDir, 'cable_corrections.json');
    this.deviceCorrectionsFile = path.join(storeDir, 'device_corrections.json');
    this.ensureDir();
    this.corrections = this.loadCorrections();
    this.deviceCorrections = this.loadJsonFile(this.deviceCorrectionsFile);
  }

  ensureDir() {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  loadCorrections() {
    return this.loadJsonFile(this.correctionsFile);
  }

  loadJsonFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (err) {
      console.warn('[AL] Failed to load corrections:', err.message);
    }
    return {};
  }

  saveCorrections() {
    this.saveJsonFile(this.correctionsFile, this.corrections);
  }

  saveDeviceCorrections() {
    this.saveJsonFile(this.deviceCorrectionsFile, this.deviceCorrections);
  }

  saveJsonFile(filePath, data) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[AL] Failed to save corrections:', err.message);
    }
  }

  /**
   * Compute perceptual hash of a PNG/JPEG buffer
   * Used for fast matching of similar images
   */
  async computePhash(imageBuffer) {
    try {
      const resized = await sharp(imageBuffer)
        .grayscale()
        .resize(16, 16, { fit: 'fill' })
        .raw()
        .toBuffer();

      const mean = resized.reduce((a, b) => a + b, 0) / resized.length;
      let hash = '';
      for (let i = 0; i < resized.length; i++) {
        hash += resized[i] > mean ? '1' : '0';
      }
      return hash;
    } catch (err) {
      console.warn('[AL] phash failed:', err.message);
      return null;
    }
  }

  /**
   * Store a correction: when user corrects a cable color, save it
   */
  async storeCorrection(imageBuffer, actualColor, predictedColor, metadata = {}) {
    try {
      const phash = await this.computePhash(imageBuffer);
      if (!phash) return null;

      this.corrections[phash] = {
        label: actualColor,
        predicted: predictedColor,
        timestamp: new Date().toISOString(),
        metadata: metadata,
      };

      this.saveCorrections();
      return phash;
    } catch (err) {
      console.warn('[AL] storeCorrection failed:', err.message);
      return null;
    }
  }

  /**
   * Store a device-class correction from the React UI.
   * The Python detector reads device_corrections.json and applies the
   * learned class immediately on future detections of a visually similar
   * device crop.
   */
  async storeDeviceCorrection(imageBuffer, actualClass, predictedClass, metadata = {}) {
    try {
      const phash = await this.computePhash(imageBuffer);
      if (!phash) return null;

      this.deviceCorrections[phash] = {
        label: actualClass,
        predicted: predictedClass,
        timestamp: new Date().toISOString(),
        metadata,
      };

      this.saveDeviceCorrections();
      return phash;
    } catch (err) {
      console.warn('[AL] storeDeviceCorrection failed:', err.message);
      return null;
    }
  }

  /**
   * Look up a correction by phash
   * Returns the corrected label if found, null otherwise
   */
  getCorrectionByHash(phash) {
    if (!phash || !this.corrections[phash]) {
      return null;
    }
    return this.corrections[phash].label;
  }

  /**
   * Hamming distance between two hash strings
   */
  hammingDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 999;
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) dist++;
    }
    return dist;
  }

  /**
   * Find a similar correction using perceptual hash (with tolerance)
   * Returns {label, method: 'hash'} or null
   */
  findSimilarCorrection(phash, tolerance = 6) {
    if (!phash) return null;

    let bestLabel = null;
    let bestDist = tolerance + 1;

    for (const [storedHash, record] of Object.entries(this.corrections)) {
      const dist = this.hammingDistance(phash, storedHash);
      if (dist < bestDist) {
        bestLabel = record.label;
        bestDist = dist;
      }
    }

    return bestLabel ? { label: bestLabel, method: 'hash', distance: bestDist } : null;
  }

  /**
   * Get all corrections (for monitoring/debugging)
   */
  getAllCorrections() {
    return this.corrections;
  }

  /**
   * Clear all corrections
   */
  clearCorrections() {
    this.corrections = {};
    this.saveCorrections();
  }
}

module.exports = ActiveLearningManager;
