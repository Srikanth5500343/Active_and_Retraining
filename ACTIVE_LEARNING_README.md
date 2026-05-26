# Active Learning (AL) System - Cable Color Corrections

## Overview

The Active Learning system learns from user corrections in the production UI and applies those learned corrections to future cable classifications **without waiting for model retraining**.

When a user corrects a cable color in the UI, we:
1. Compute a perceptual hash of the cable image
2. Store the correction (hash + color) in the AL database
3. Next time a similar cable appears, we check the AL database first
4. If a match is found, use the learned correction instead of the model's prediction

This runs **in parallel with retraining** and improves accuracy immediately.

---

## How It Works

### 1. **Production UI Feedback** (When user corrects a cable color)
```
User selects "Yellow" instead of model's "White"
    â†“
/api/feedback/cable-color endpoint (server/app.js)
    â”œâ†’ Crops the port image
    â”œâ†’ Saves to retraining folder (for eventual model retraining)
    â””â†’ Stores in AL database: server/data/active_learning/cable_corrections.json
         â””â”€ Saved: { phash: "0101010...", label: "Yellow", predicted: "White", ... }
```

### 2. **Pipeline Classification** (When classifying a new cable)
```
classify_cable(image)
    â”œâ†’ Get model prediction (e.g., "White")
    â”œâ†’ Compute perceptual hash of cable image
    â”œâ†’ Check AL database for corrections
    â”‚   â”œâ†’ Hash match within tolerance (6 bits) â†’ use stored correction
    â”‚   â””â†’ Embedding similarity match â†’ use stored correction
    â””â†’ Return corrected label (e.g., "Yellow")
```

### 3. **Synchronized Correction Lookup**
- **Production pipeline** checks: `server/data/active_learning/cable_corrections.json`
- **Flask AL UI** checks: local + server database
- Both systems learn from each other's corrections

---

## Data Flow

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Production UI - User Feedback          â”‚
â”‚  (server/app.js: /api/feedback/...)     â”‚
â”‚  â””â”€ User corrects cable color           â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
               â”‚
               â”œâ”€â†’ Retraining folder (for eventual model update)
               â”‚   Cable_retraining/feedback_dir/<class>/
               â”‚
               â””â”€â†’ AL Database (immediate feedback)
                   server/data/active_learning/cable_corrections.json
                   {
                     "phash_hash_string": {
                       "label": "RJ_45_Yellow",
                       "predicted": "RJ_45_White",
                       "timestamp": "2026-05-25T10:30:00",
                       "metadata": { ... }
                     }
                   }

                   â†“

                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚  Next Classification                    â”‚
                   â”‚  pipeline/cable.py: classify_cable()    â”‚
                   â”‚  â””â”€ Check AL corrections                â”‚
                   â”‚     â””â”€ Return "Yellow" instead of model â”‚
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## Testing the AL System

To verify corrections are being stored and retrieved:

```bash
cd C:\Users\SrikanthMekala\Downloads\RACKTRACK_FINAL_V1
python test_cable_al.py
```

This will show:
- âœ… Number of corrections stored
- âœ… Each correction's hash, label, and timestamp
- âœ… Whether hash computation is working
- âœ… Troubleshooting info if something's wrong

---

## Troubleshooting

### Corrections Aren't Persisting

**Problem**: User corrects a cable color, but next time the same/similar cable is shown, it still shows the original color.

**Checklist**:

1. **Is the AL database being created?**
   - Check: `server/data/active_learning/cable_corrections.json`
   - Should exist after first correction
   - If not, check server logs for `[AL/cable-color]` errors

2. **Are corrections being stored?**
   ```bash
   python test_cable_al.py
   ```
   - Should show: "Total corrections stored: N" (where N > 0)
   - If 0, corrections aren't being saved to the database

3. **Is the pipeline checking corrections?**
   - Watch for logs: `[AL] Hash match` or `[AL] Embedding match`
   - If not appearing, AL lookup might be failing silently
   - Check `pipeline/cable.py` for exception handling

4. **Is the hash matching strict enough?**
   - Default tolerance: 6 bits (Hamming distance)
   - If images are significantly different, hash won't match
   - Fallback to embedding similarity (if enabled)

### Solution Steps

1. **Verify server is storing corrections:**
   ```bash
   # Check if file exists and has content
   cat server/data/active_learning/cable_corrections.json
   ```

2. **Test correction lookup:**
   ```bash
   python test_cable_al.py
   ```

3. **Check pipeline logs:**
   - Run pipeline with verbose logging
   - Look for `[cable.classify_cable]` messages
   - Look for `[AL]` messages

4. **Ensure permissions:**
   - `server/data/active_learning/` must be writable
   - Pipeline must be able to read from it

5. **Clear old corrections if needed:**
   ```bash
   # Via server API (if available)
   DELETE /api/active-learning/corrections

   # Or manually delete
   rm server/data/active_learning/cable_corrections.json
   ```

---

## Architecture

### Core Modules

| Module | Purpose |
|--------|---------|
| `server/lib/active-learning.js` | Manages AL corrections (hash, store, lookup) |
| `pipeline/cable_al.py` | Looks up corrections for classifications |
| `pipeline/cable.py` | Calls `cable_al.get_correction()` after model prediction |
| `active_learning_Cache/embedder.py` | Shared embedding utilities (ResNet18) |
| `active_learning_Cache/cable_active_learning.py` | Flask UI for manual corrections |

### Correction Storage Format

```json
{
  "0101010101010101101010...": {
    "label": "RJ_45_Yellow",
    "predicted": "RJ_45_White",
    "timestamp": "2026-05-25T10:30:47.457Z",
    "metadata": {
      "scanId": "RK-3AF6F047",
      "device_index": 4,
      "predicted_port": 3,
      "cable_connector": "RJ-45",
      "source": "ui_feedback"
    }
  }
}
```

---

## Performance

- **Fast path** (hash-based): ~1ms per lookup
- **Robust path** (embedding): ~50ms per lookup (fallback for hard cases)
- **Caching**: Corrections cached for 5 seconds to reduce disk reads

---

## Future Improvements

1. **Embedding-based matching**: Enable full embedding-based corrections when PyTorch is available
2. **Confidence boosting**: Mark AL corrections with higher confidence than model predictions
3. **Decay mechanism**: Reduce weight of old corrections over time
4. **Conflict resolution**: Handle conflicting corrections for same image
5. **Active learning feedback loop**: Automatically select images to correct based on uncertainty

---
