"""
Send a file via Outlook (Microsoft Graph /me/sendMail) using MSAL.

Usage:
    python -m pipeline.outlook_send --email user@example.com --file /path/to/report.pdf \
                                    [--subject "Device Report"] [--body "Message body"]

Stdout (one JSON line):
    {"ok": true,  "recipient": "...", "file_name": "..."}
    {"ok": false, "error": "..."}

The token cache at pipeline/shanakr_outlook_cache.json stores just an access
token + expiry — NOT a refresh token. Once the token expires (~1 hour), the
script must be run interactively (pass --interactive) to complete device-flow
login again. Server-invoked runs without a valid cached token return an error.
"""
import os
import sys
import json
import argparse
from datetime import datetime

import msal
import requests

CLIENT_ID = "36a44a36-8eb2-43ef-bd1a-cadad7e6b252"
TENANT_ID = "ee8c7b70-7a3a-4155-b1f2-59ff718e1d5c"

# Mail.ReadWrite is required to create a draft message and open an attachment
# upload session; Mail.Send is required to actually deliver it. The old inline
# /me/sendMail flow only needed Mail.Send, so existing cached tokens that were
# issued before this change are missing Mail.ReadWrite and will hit a 403 on
# draft creation — re-authenticate with `--interactive` to refresh scopes.
SCOPES = ["Mail.Send", "Mail.ReadWrite"]
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
GRAPH_API_URL = "https://graph.microsoft.com/v1.0"

# Keep the historical "shanakr" spelling so the user's existing cache file
# keeps working without re-authentication.
TOKEN_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "shanakr_outlook_cache.json",
)


def _log(*a, **kw):
    print(*a, file=sys.stderr, flush=True, **kw)


def _emit(obj):
    print(json.dumps(obj), flush=True)


def get_access_token(interactive: bool) -> str:
    # When --interactive is explicitly passed, skip the cache and force a fresh
    # device-flow login. This is how you refresh scopes after SCOPES changes —
    # otherwise a token issued with the old scope set would keep being reused
    # until it expires, and every API call needing the new scope would 403.
    if not interactive and os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                token_data = json.load(f)
            if datetime.now().timestamp() < float(token_data.get("expires_at", 0)):
                return token_data["access_token"]
            _log("[!] cached outlook token expired")
        except Exception as e:
            _log(f"[!] could not read cache: {e}")

    if not interactive:
        raise RuntimeError(
            "No valid Outlook token. Run `py -m pipeline.outlook_send --email X --file Y --interactive` "
            "once on a desktop to complete device-flow login and refresh the cache. "
            "Required scopes: " + ", ".join(SCOPES)
        )

    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY)
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"could not start device flow: {flow}")
    _log(flow["message"])
    result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        raise RuntimeError(f"login failed: {result.get('error_description', result)}")

    token_data = {
        "access_token": result["access_token"],
        "expires_at": datetime.now().timestamp() + result["expires_in"],
    }
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(token_data, f)
    return token_data["access_token"]


# Chunk size for upload sessions. Must be a multiple of 320 KiB (Graph spec);
# 4 MiB rounded down to that granularity is a safe default.
_UPLOAD_CHUNK = (4 * 1024 * 1024 // (320 * 1024)) * (320 * 1024)


def send_email(email: str, file_path: str, subject: str, body_text: str) -> dict:
    token = get_access_token(interactive=False)
    headers_json = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    # /me/sendMail caps the entire request body at ~4 MB, so any file bigger
    # than ~3 MB (after base64 bloat) blows past it. Going through draft +
    # attachment upload session lifts the ceiling to 150 MB and works for
    # small files too, so we use one code path for everything.
    _log(f"[~] creating draft and uploading {file_name} ({file_size / 1024 / 1024:.2f} MB)")

    draft = {
        "subject": subject,
        "body": {"contentType": "Text", "content": body_text},
        "toRecipients": [{"emailAddress": {"address": email}}],
    }
    resp = requests.post(f"{GRAPH_API_URL}/me/messages", headers=headers_json, json=draft)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"create draft failed ({resp.status_code}): {resp.text}")
    msg_id = resp.json()["id"]

    session_body = {
        "AttachmentItem": {
            "attachmentType": "file",
            "name": file_name,
            "size": file_size,
        }
    }
    sess = requests.post(
        f"{GRAPH_API_URL}/me/messages/{msg_id}/attachments/createUploadSession",
        headers=headers_json,
        json=session_body,
    )
    if sess.status_code not in (200, 201):
        raise RuntimeError(f"create upload session failed ({sess.status_code}): {sess.text}")
    upload_url = sess.json()["uploadUrl"]

    with open(file_path, "rb") as f:
        offset = 0
        while offset < file_size:
            chunk = f.read(_UPLOAD_CHUNK)
            if not chunk:
                break
            end = offset + len(chunk) - 1
            up = requests.put(
                upload_url,
                headers={
                    "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {offset}-{end}/{file_size}",
                },
                data=chunk,
            )
            if up.status_code not in (200, 201, 202):
                raise RuntimeError(
                    f"chunk upload failed at byte {offset} ({up.status_code}): {up.text}"
                )
            offset = end + 1

    send_resp = requests.post(f"{GRAPH_API_URL}/me/messages/{msg_id}/send", headers=headers_json)
    if send_resp.status_code != 202:
        raise RuntimeError(f"send draft failed ({send_resp.status_code}): {send_resp.text}")

    return {"recipient": email, "file_name": file_name, "size": file_size}


DEFAULT_BODY = (
    "Hello,\n\n"
    "Please find the attached document for your reference.\n\n"
    "If you have any questions, feel free to reach out.\n\n"
    "Regards,\n"
    "racktrack.ai"
)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    p = argparse.ArgumentParser(description="Send a file via Outlook.")
    p.add_argument("--email", required=True, help="Recipient email")
    p.add_argument("--file", required=True, help="Path to file to attach")
    p.add_argument("--subject", default="Device Report - racktrack.ai")
    p.add_argument("--body", default=DEFAULT_BODY)
    p.add_argument(
        "--interactive", action="store_true",
        help="Allow device-flow login when cache is missing or expired (requires a TTY).",
    )
    args = p.parse_args()

    try:
        if not os.path.isfile(args.file):
            raise RuntimeError(f"file not found: {args.file}")

        if args.interactive:
            # Force a fresh login + cache write before sending.
            get_access_token(interactive=True)

        info = send_email(args.email, args.file, args.subject, args.body)
        _emit({"ok": True, **info})
    except Exception as err:
        _emit({"ok": False, "error": str(err)})
        sys.exit(1)


if __name__ == "__main__":
    main()
