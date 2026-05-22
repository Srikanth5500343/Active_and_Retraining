"""
RackTrack client.

Two modes, switchable via the RACKTRACK_USE_MOCK env var:

  mock: reads ./mock_scans/<rack_scan_id>/device_unit_map.json and merges
        scan_meta.json (rackId, timestamp, imageHash, quality) into one dict.
  live: calls http://<RACKTRACK_URL>/api/scan/<rack_scan_id>/report
        with Bearer <RACKTRACK_JWT>

The correlator doesn't care which mode is active — it just calls get_scan()
and expects rackId, scannedAt, and devices[] in the returned dict.
"""
import json
import os
from pathlib import Path

import requests


def _use_mock() -> bool:
    return os.environ.get("RACKTRACK_USE_MOCK", "true").lower() == "true"


def get_scan(rack_scan_id: str) -> dict:
    """Return the merged scan data for the given RackTrack scan ID.

    Raises FileNotFoundError (mock) or HTTPError (live) if the scan doesn't exist.
    """
    if _use_mock():
        return _get_scan_mock(rack_scan_id)
    return _get_scan_live(rack_scan_id)


def _get_scan_mock(rack_scan_id: str) -> dict:
    folder = Path(__file__).parent / "mock_scans" / rack_scan_id
    device_map_path = folder / "device_unit_map.json"
    if not device_map_path.exists():
        raise FileNotFoundError(
            f"Mock scan not found at {device_map_path}. "
            f"Either create the file or set RACKTRACK_USE_MOCK=false."
        )
    with open(device_map_path) as f:
        scan = json.load(f)

    meta_path = folder / "scan_meta.json"
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)
        scan.setdefault("rackId", meta.get("rackId"))
        scan.setdefault("scannedAt", meta.get("timestamp"))
        scan.setdefault("imageHash", meta.get("imageHash"))
        scan.setdefault("quality", meta.get("quality"))

    return scan


def _get_scan_live(rack_scan_id: str) -> dict:
    # Localhost is fine for dev/in-container calls; production deployments
    # should set RACKTRACK_URL explicitly (and use https). We refuse to fall
    # back to http://localhost when NODE_ENV / RACKTRACK_ENV says production
    # so a misconfig fails loudly instead of silently leaking traffic.
    base = os.environ.get("RACKTRACK_URL")
    if not base:
        env = (os.environ.get("RACKTRACK_ENV")
               or os.environ.get("NODE_ENV") or "").lower()
        if env == "production":
            raise RuntimeError(
                "RACKTRACK_URL is not set in production "
                "(refusing to fall back to http://localhost:3000)"
            )
        base = "http://localhost:3000"
    jwt = os.environ.get("RACKTRACK_JWT", "")
    headers = {"Accept": "application/json"}
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"
    r = requests.get(
        f"{base}/api/scan/{rack_scan_id}/report",
        headers=headers,
        timeout=15,
    )
    r.raise_for_status()
    return r.json()
