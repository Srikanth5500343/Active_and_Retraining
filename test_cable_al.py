#!/usr/bin/env python3
"""
Test script to verify active learning corrections are being stored and retrieved correctly.

Run this to debug AL issues:
    python test_cable_al.py
"""

import json
import sys
from pathlib import Path

# Add repo root to path
REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT))

from pipeline.cable_al import get_corrections_summary, load_corrections, hamming_distance


def test_al_system():
    """Test the active learning system."""
    print("=" * 70)
    print("Active Learning (AL) System Verification")
    print("=" * 70)

    # 1. Check if AL database exists
    print("\n1. Checking AL database location...")
    from pipeline.cable_al import CORRECTIONS_FILE, CORRECTIONS_DIR
    print(f"   AL Database: {CORRECTIONS_FILE}")
    print(f"   Directory exists: {CORRECTIONS_DIR.exists()}")
    print(f"   File exists: {CORRECTIONS_FILE.exists()}")

    # 2. Load corrections
    print("\n2. Loading corrections...")
    corrections = load_corrections()
    print(f"   Total corrections stored: {len(corrections)}")

    if corrections:
        print("\n   Stored corrections:")
        for i, (h, rec) in enumerate(list(corrections.items())[:5]):  # Show first 5
            print(f"     [{i+1}] Hash: {h[:16]}...")
            print(f"         Label: {rec.get('label', 'N/A')}")
            print(f"         Predicted: {rec.get('predicted', 'N/A')}")
            print(f"         Timestamp: {rec.get('timestamp', 'N/A')}")
        if len(corrections) > 5:
            print(f"     ... and {len(corrections) - 5} more")
    else:
        print("   âš ï¸  No corrections found in database")

    # 3. Test summary
    print("\n3. AL System Summary:")
    summary = get_corrections_summary()
    print(f"   {json.dumps(summary, indent=2)}")

    # 4. Test hash computation
    print("\n4. Testing hash computation...")
    from PIL import Image
    from pipeline.cable_al import phash

    # Create a test image
    test_img = Image.new('RGB', (256, 256), color='red')
    h1 = phash(test_img)
    print(f"   Test image hash: {h1[:16]}... (length={len(h1)})")

    # Create similar image
    test_img2 = Image.new('RGB', (256, 256), color=(255, 0, 0))
    h2 = phash(test_img2)
    dist = hamming_distance(h1, h2)
    print(f"   Similar image hash: {h2[:16]}... (hamming_distance={dist})")

    # 5. Test correction lookup
    print("\n5. Testing correction lookup...")
    from pipeline.cable_al import get_correction

    # Try with test image (should have no correction)
    result = get_correction(test_img, "RJ_45_White")
    print(f"   Lookup result: {result}")

    # 6. Recommendations
    print("\n6. Troubleshooting Guide:")
    if not CORRECTIONS_FILE.exists():
        print("   âŒ AL database doesn't exist at:", CORRECTIONS_FILE)
        print("      â†’ Make sure the server has run and stored at least one feedback")
        print("      â†’ Check server logs for AL storage errors")
    elif len(corrections) == 0:
        print("   âš ï¸  AL database exists but is empty")
        print("      â†’ Provide cable color feedback in the UI first")
        print("      â†’ Wait for server to store the correction")
    else:
        print("   âœ… AL system appears to be working!")
        print("      â†’ Next cable classification should use stored corrections")

    print("\n" + "=" * 70)


if __name__ == "__main__":
    test_al_system()
