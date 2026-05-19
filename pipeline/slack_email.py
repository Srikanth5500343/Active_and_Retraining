"""
Uploads a single file to a Slack user's DM via email lookup.

Usage:
    python -m pipeline.slack_email --email user@example.com --file /path/to/report.pdf \
                                   [--comment "Here is your report"]

Environment:
    SLACK_TOKEN   Slack Bot/User token (xoxp-... or xoxb-...).  REQUIRED.
                  Falls back to the module-level DEFAULT_TOKEN below if unset,
                  but relying on the fallback is discouraged (secrets should
                  not live in source).
"""

import argparse
import json
import os
import sys
import time

import requests


# ⚠️ SECURITY: Prefer setting SLACK_TOKEN as an environment variable.
# Hardcoded tokens in source files are a real leak risk — remove this
# before committing to a public repo or sharing the file.
DEFAULT_TOKEN = ""  # set SLACK_TOKEN env var instead


def _emit(payload):
    """Print a single JSON line so a parent process can parse the result."""
    print(json.dumps(payload), flush=True)


def get_user_id_by_email(token: str, email: str) -> str:
    r = requests.get(
        "https://slack.com/api/users.lookupByEmail",
        headers={"Authorization": f"Bearer {token}"},
        params={"email": email},
        timeout=15,
    ).json()
    if not r.get("ok"):
        raise RuntimeError(f"users.lookupByEmail failed: {r.get('error')}")
    return r["user"]["id"]


def open_dm_channel(token: str, user_id: str) -> str:
    r = requests.post(
        "https://slack.com/api/conversations.open",
        headers={"Authorization": f"Bearer {token}"},
        data={"users": user_id},
        timeout=15,
    ).json()
    if not r.get("ok"):
        raise RuntimeError(f"conversations.open failed: {r.get('error')}")
    return r["channel"]["id"]


def get_upload_url(token: str, file_path: str):
    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    r = requests.post(
        "https://slack.com/api/files.getUploadURLExternal",
        headers={"Authorization": f"Bearer {token}"},
        data={"filename": file_name, "length": file_size},
        timeout=15,
    ).json()
    if not r.get("ok"):
        raise RuntimeError(f"files.getUploadURLExternal failed: {r.get('error')}")
    return r["upload_url"], r["file_id"]


def upload_file(upload_url: str, file_path: str) -> None:
    with open(file_path, "rb") as f:
        r = requests.post(
            upload_url,
            headers={"Content-Type": "application/octet-stream"},
            data=f,
            timeout=120,
        )
    if r.status_code != 200:
        raise RuntimeError(f"binary upload failed: HTTP {r.status_code}")


def complete_and_share(token: str, file_id: str, channel_id: str, file_name: str, comment: str) -> dict:
    # Slack's completion endpoint is eventually consistent — short delay avoids
    # "file not found" races when the upload URL just finished.
    time.sleep(2)
    r = requests.post(
        "https://slack.com/api/files.completeUploadExternal",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "files": [{"id": file_id, "title": file_name}],
            "channel_id": channel_id,
            "initial_comment": comment,
        },
        timeout=15,
    ).json()
    if not r.get("ok"):
        raise RuntimeError(f"files.completeUploadExternal failed: {r.get('error')}")
    return r


def send_file_to_dm(token: str, email: str, file_path: str, comment: str = "") -> dict:
    if not token:
        raise RuntimeError("SLACK_TOKEN is not set (env var or DEFAULT_TOKEN)")
    if not os.path.isfile(file_path):
        raise RuntimeError(f"File not found: {file_path}")

    user_id    = get_user_id_by_email(token, email)
    channel_id = open_dm_channel(token, user_id)
    upload_url, file_id = get_upload_url(token, file_path)
    upload_file(upload_url, file_path)
    result = complete_and_share(token, file_id, channel_id, os.path.basename(file_path), comment)

    return {
        "user_id": user_id,
        "channel_id": channel_id,
        "file_id": file_id,
        "file_name": os.path.basename(file_path),
        "slack_response": result,
    }


def parse_args():
    p = argparse.ArgumentParser(description="Send a file to a Slack user's DM via email.")
    p.add_argument("--email",   required=True, help="Recipient Slack email.")
    p.add_argument("--file",    required=True, help="Path to the file to upload.")
    p.add_argument("--comment", default="",    help="Optional initial comment in the DM.")
    return p.parse_args()


def main():
    args = parse_args()
    token = os.environ.get("SLACK_TOKEN") or DEFAULT_TOKEN
    try:
        info = send_file_to_dm(token, args.email, args.file, args.comment)
        _emit({"ok": True, **{k: info[k] for k in ("user_id", "channel_id", "file_id", "file_name")}})
    except Exception as err:
        _emit({"ok": False, "error": str(err)})
        sys.exit(1)


if __name__ == "__main__":
    main()
