#!/usr/bin/env python3
"""Bulk-test firmware_check.fetch_firmware_info against many vendors.

Skips the NVD CVE call to avoid 5-req/30s rate limits — we only want to
verify the release-notes-URL + version-extraction half of the pipeline.

Usage:
  python -m pipeline.test_firmware_all_vendors            # run full matrix
  python -m pipeline.test_firmware_all_vendors --vendor cisco
  python -m pipeline.test_firmware_all_vendors --workers 6 --csv out.csv
"""

import argparse
import csv
import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

# Allow running as a script from the repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline import firmware_check
from pipeline.all_vendor import (
    SESSION,
    DEFAULT_EXCEL,
    load_vendors,
    _pick_vendor_strict,
    normalize_model,
    _root_domain,
)


# ─────────────────────────────────────────────
# Test matrix:  (vendor_query, model, current_version, tier)
#
# `tier` mirrors the user's classification:
#   "strong"  — should reliably detect latest version
#   "medium"  — public info available, may need session/PDF/dynamic rendering
#   "hard"    — login walls, support contracts, etc.
# ─────────────────────────────────────────────
TEST_CASES = [
    # ===== STRONG TIER =====
    ("Cisco",                    "C9300-48T",         "17.6.1",     "strong"),
    ("Cisco",                    "Catalyst 9200",     "17.9.1",     "strong"),
    ("Juniper",                  "EX4300-48T",        "22.4R3",     "strong"),
    ("Juniper",                  "QFX5100-48S",       "20.4R3",     "strong"),
    ("Aruba (HPE)",              "JL675A",            "10.10.1000", "strong"),
    ("Aruba (HPE)",              "6300M",             "10.10.1000", "strong"),
    ("Arista",                   "DCS-7050SX-72",     "4.30.0F",    "strong"),
    ("Fortinet",                 "FortiGate-100F",    "7.4.4",      "strong"),
    ("Fortinet",                 "FortiSwitch-148E",  "7.4.1",      "strong"),
    ("Extreme",                  "X465-48P",          "31.7.1",     "strong"),
    ("MikroTik",                 "CRS326-24G-2S+RM",  "7.10",       "strong"),
    ("MikroTik",                 "CCR2004-1G-12S+2XS","7.11",       "strong"),
    ("TP-Link",                  "TL-SG3428",         "4.0.0",      "strong"),
    ("D-Link",                   "DGS-3120-24TC",     "4.10.B005",  "strong"),
    ("Netgear",                  "GS108Tv3",          "7.0.4.4",    "strong"),
    ("Netgear",                  "M4250-26G4XF-PoE+", "13.0.6.4",   "strong"),
    ("Ubiquiti",                 "USW-Pro-48",        "6.5.59",     "strong"),
    ("ZyXEL",                    "GS1900-48HPv2",     "V2.50",      "strong"),
    ("Allied Telesis",           "AT-x230-28GT",      "5.5.2-2.1",  "strong"),
    ("Alcatel-Lucent",           "OmniSwitch 6860",   "8.7.2",      "strong"),
    ("ADTRAN",                   "NetVanta 1638P",    "R12.10",     "strong"),
    ("Huawei",                   "S5720-28X-PWR-LI",  "V200R022",   "strong"),
    ("ZTE",                      "ZXR10 5960",        "V3.0",       "strong"),
    ("Edgecore",                 "AS5912-54X",        "11.0.1",     "strong"),
    ("DrayTek",                  "VigorSwitch G1280", "2.5.1",      "strong"),
    ("Linksys",                  "LGS552",            "3.0.0",      "strong"),
    ("Edimax",                   "GS-5424PLG",        "1.0.0",      "strong"),
    ("TRENDnet",                 "TPE-3012LS",        "4.10",       "strong"),
    ("TOTOLINK",                 "SG24DE",            "1.0",        "strong"),
    ("FS",                       "S3900-24F4S",       "2.5.0",      "strong"),
    ("H3C",                      "S5500-EI",          "R7607",      "strong"),
    ("Westermo",                 "RedFox-5528",       "4.18.0",     "strong"),
    ("Buffalo",                  "BS-GS2024",         "1.04",       "strong"),
    ("Avaya",                    "ERS 4500",          "5.10.0",     "strong"),
    ("Yamaha",                   "SWX2310",           "Rev.2.04",   "strong"),
    ("Teltonika",                "RUTX12",            "07.04",      "strong"),
    ("QNAP",                     "QSW-1208-8C",       "1.0.4",      "strong"),
    ("Dell",                     "PowerSwitch S5248F","10.5.4.4",   "strong"),
    ("Supermicro",               "SSE-G3648B",        "1.4.10",     "strong"),
    ("Belden",                   "Hirschmann RSP35",  "8.7.0",      "strong"),
    ("Ruijie",                   "RG-S2910",          "11.4(1)B70", "strong"),
    ("Lantronix",                "SLB-882",           "8.4.0",      "strong"),

    # ===== MEDIUM TIER =====
    ("Hikvision",                "DS-3E0518P",        "1.1.4",      "medium"),
    ("Phoenix Contact",          "FL SWITCH 2308",    "3.30",       "medium"),
    ("Schneider Electric",       "ConneXium TCSESM",  "9.0.1",      "medium"),
    ("Moxa",                     "EDS-518A",          "5.2",        "medium"),
    ("Vertiv",                   "Avocent ADX",       "5.4.1",      "medium"),
    ("Lenovo",                   "ThinkSystem DB620S","9.0.1",      "medium"),
    ("Advantech",                "EKI-7706E-2FP",     "1.04",       "medium"),
    ("Antaira",                  "LMP-0501G",         "3.16",       "medium"),
    ("EtherWan",                 "EX17000",           "1.1.0",      "medium"),
    ("Brainboxes",               "SW-805",            "1.0",        "medium"),
    ("Beckhoff",                 "CU2008",            "1.0",        "medium"),

    # ===== HARD TIER =====
    ("Brocade",                  "ICX 7150-48",       "8.0.95",     "hard"),
    ("Nokia",                    "7750 SR-1",         "21.10.R3",   "hard"),
    ("NVIDIA",                   "SN3700",            "5.4.0",      "hard"),
    ("Versa",                    "FlexVNF",           "21.2.3",     "hard"),
]


def run_one(vendor_query, model_query, current_version, tier, *, deep=False):
    """Run firmware_check end-to-end (skipping NVD CVE lookups, which are
    rate-limited). Returns a dict with the same shape as fetch_firmware_info
    plus diagnostic fields the test harness uses."""
    result = {
        "vendor_query": vendor_query,
        "model_query": model_query,
        "current_version": current_version,
        "tier": tier,
        "vendor_resolved": None,
        "vendor_url": None,
        "model_normalized": None,
        "rn_url": None,
        "rn_followed_from": None,
        "latest_version": None,
        "up_to_date": None,
        "versions_found_count": 0,
        "changelog_sections": 0,
        "error": None,
        "elapsed_sec": None,
    }
    t0 = time.time()
    try:
        info = firmware_check.fetch_firmware_info(
            vendor_query, model_query, current_version,
            skip_cves=True,
        )
        if not info.get("ok"):
            result["error"] = info.get("error")
            result["vendor_resolved"] = info.get("vendor")
            result["vendor_url"] = info.get("vendorUrl")
            return result
        result["vendor_resolved"] = info.get("vendor")
        result["vendor_url"] = info.get("vendorUrl")
        result["model_normalized"] = info.get("model")
        result["rn_url"] = info.get("releaseNotesUrl")
        result["rn_followed_from"] = info.get("releaseNotesIndexUrl")
        result["latest_version"] = info.get("latestVersion")
        result["up_to_date"] = info.get("upToDate")
        result["versions_found_count"] = len(info.get("versionsFound") or [])
        result["changelog_sections"] = len(info.get("changelog") or [])
        if info.get("releaseNotesError"):
            result["error"] = info["releaseNotesError"]
    except Exception as e:
        result["error"] = f"unexpected: {e}\n{traceback.format_exc()}"
    finally:
        result["elapsed_sec"] = round(time.time() - t0, 1)
    return result


def classify(r):
    """PASS / PARTIAL / FAIL bucketing.

    PASS:   release-notes URL found AND a plausible latest_version was extracted.
    PARTIAL: vendor + RN URL found but no version (URL likely valid, parser
             couldn't pull a version — usually a layout issue).
    FAIL:   no RN URL (search/alias miss) or vendor not in Excel.
    """
    if r.get("error") and not r.get("rn_url"):
        return "FAIL"
    if r.get("rn_url") and r.get("latest_version"):
        return "PASS"
    if r.get("rn_url"):
        return "PARTIAL"
    return "FAIL"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--vendor", help="Run only test cases whose vendor query contains this substring")
    ap.add_argument("--tier", choices=("strong", "medium", "hard"))
    ap.add_argument("--csv", default="firmware_test_results.csv")
    ap.add_argument("--json", default="firmware_test_results.json")
    args = ap.parse_args()

    cases = TEST_CASES
    if args.tier:
        cases = [c for c in cases if c[3] == args.tier]
    if args.vendor:
        sub = args.vendor.lower()
        cases = [c for c in cases if sub in c[0].lower()]

    print(f"Running {len(cases)} test cases with {args.workers} workers...\n")

    rows = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(run_one, *c): c for c in cases}
        for fut in as_completed(futs):
            r = fut.result()
            verdict = classify(r)
            r["verdict"] = verdict
            rows.append(r)
            ver = r.get("latest_version") or "—"
            err = r.get("error") or ""
            rn = r.get("rn_url") or ""
            print(f"[{verdict:<7}] {r['tier']:<6} {r['vendor_query']:<22} "
                  f"{r['model_query']:<25} latest={ver:<14} "
                  f"({r['elapsed_sec']}s)  rn={rn[:60]}  {err[:60]}")

    # Order results to match TEST_CASES so failures cluster by tier
    order = {(c[0], c[1]): i for i, c in enumerate(cases)}
    rows.sort(key=lambda r: order.get((r["vendor_query"], r["model_query"]), 9999))

    pass_n = sum(1 for r in rows if r["verdict"] == "PASS")
    part_n = sum(1 for r in rows if r["verdict"] == "PARTIAL")
    fail_n = sum(1 for r in rows if r["verdict"] == "FAIL")
    print(f"\nSummary: PASS={pass_n}  PARTIAL={part_n}  FAIL={fail_n}  total={len(rows)}")

    by_tier = {}
    for r in rows:
        t = r["tier"]
        by_tier.setdefault(t, [0, 0, 0])
        idx = {"PASS": 0, "PARTIAL": 1, "FAIL": 2}[r["verdict"]]
        by_tier[t][idx] += 1
    for t, (p, pp, f) in sorted(by_tier.items()):
        print(f"  {t:<7}  PASS={p}  PARTIAL={pp}  FAIL={f}")

    # CSV + JSON outputs for triage
    if rows:
        cols = list(rows[0].keys())
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for r in rows:
                w.writerow(r)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2)
        print(f"\nWrote {args.csv} and {args.json}")


if __name__ == "__main__":
    main()
