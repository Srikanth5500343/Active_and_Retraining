"""
Send a file via Microsoft Teams DM using MSAL + Graph API.

Usage:
    python -m pipeline.teams_send --email user@example.com --file /path/to/report.pdf \
                                  [--message "Hi, please find the attached file."]

Stdout (one JSON line):
    {"ok": true,  "chat_id": "...", "file_name": "...", "web_url": "..."}
    {"ok": false, "error": "..."}

Progress output goes to stderr so the parent process can parse stdout cleanly.

The MSAL token cache lives at pipeline/shankar_teams_cache.json. Silent refresh
works as long as that cache has a valid refresh token — run this script once
interactively to seed it via device flow.
"""
import os
import sys
import json
import uuid
import argparse

import msal
import requests

CLIENT_ID = "a58b8e87-442d-47a4-8694-87b30bf03efd"
TENANT_ID = "ee8c7b70-7a3a-4155-b1f2-59ff718e1d5c"

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPES = [
    "Chat.ReadWrite",
    "ChatMessage.Send",
    "Files.ReadWrite",
    "User.Read",
]

TOKEN_CACHE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "shankar_teams_cache.json",
)


def _log(*a, **kw):
    print(*a, file=sys.stderr, flush=True, **kw)


def _emit(obj):
    print(json.dumps(obj), flush=True)


def get_access_token(interactive: bool):
    cache = msal.SerializableTokenCache()
    if os.path.exists(TOKEN_CACHE_FILE):
        with open(TOKEN_CACHE_FILE, "r", encoding="utf-8") as f:
            cache.deserialize(f.read())
        _log(f"[+] loaded token cache {TOKEN_CACHE_FILE}")
    else:
        _log(f"[!] no token cache at {TOKEN_CACHE_FILE}")

    app = msal.PublicClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        token_cache=cache,
    )

    result = None
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])

    if not result:
        if not interactive:
            raise RuntimeError(
                "No valid Teams token. Run `python -m pipeline.teams_send --email X --file Y --interactive` "
                "once on a desktop to complete device-flow login and cache a refresh token."
            )
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"could not start device flow: {flow}")
        _log("=" * 60)
        _log(f"  STEP 1 -> Open   : {flow['verification_uri']}")
        _log(f"  STEP 2 -> Enter  : {flow['user_code']}")
        _log("=" * 60)
        result = app.acquire_token_by_device_flow(flow)

    if cache.has_state_changed:
        with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            f.write(cache.serialize())

    if not result or "access_token" not in result:
        raise RuntimeError(f"login failed: {result.get('error_description', 'unknown') if result else 'no result'}")
    return result["access_token"]


def get_me(token):
    resp = requests.get(f"{GRAPH_BASE}/me", headers={"Authorization": f"Bearer {token}"})
    if resp.status_code != 200:
        raise RuntimeError(f"could not fetch /me: {resp.text}")
    return resp.json()


def get_or_create_chat(token, my_id, recipient_email):
    body = {
        "chatType": "oneOnOne",
        "members": [
            {
                "@odata.type": "#microsoft.graph.aadUserConversationMember",
                "roles": ["owner"],
                "user@odata.bind": f"https://graph.microsoft.com/v1.0/users/{my_id}",
            },
            {
                "@odata.type": "#microsoft.graph.aadUserConversationMember",
                "roles": ["owner"],
                "user@odata.bind": f"https://graph.microsoft.com/v1.0/users/{recipient_email}",
            },
        ],
    }
    resp = requests.post(
        f"{GRAPH_BASE}/chats",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"create chat failed: {resp.text}")
    return resp.json()["id"]


def upload_and_share_file(token, file_path, recipient_email):
    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    headers = {"Authorization": f"Bearer {token}"}

    with open(file_path, "rb") as f:
        data = f.read()

    if file_size <= 4 * 1024 * 1024:
        resp = requests.put(
            f"{GRAPH_BASE}/me/drive/root:/{file_name}:/content",
            headers={**headers, "Content-Type": "application/octet-stream"},
            data=data,
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"upload failed: {resp.text}")
        item = resp.json()
    else:
        sess_resp = requests.post(
            f"{GRAPH_BASE}/me/drive/root:/{file_name}:/createUploadSession",
            headers={**headers, "Content-Type": "application/json"},
            json={"item": {"@microsoft.graph.conflictBehavior": "rename"}},
        )
        if sess_resp.status_code != 200:
            raise RuntimeError(f"create upload session failed: {sess_resp.text}")
        upload_url = sess_resp.json()["uploadUrl"]
        resp = requests.put(
            upload_url,
            headers={
                "Content-Range": f"bytes 0-{file_size - 1}/{file_size}",
                "Content-Length": str(file_size),
            },
            data=data,
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"large-file upload failed: {resp.text}")
        item = resp.json()

    item_id = item["id"]

    link_resp = requests.post(
        f"{GRAPH_BASE}/me/drive/items/{item_id}/createLink",
        headers={**headers, "Content-Type": "application/json"},
        json={"type": "view", "scope": "organization"},
    )
    if link_resp.status_code in (200, 201):
        web_url = link_resp.json()["link"]["webUrl"]
    else:
        web_url = item.get("webUrl", "")

    # Best-effort: grant explicit read permission to the recipient. Non-fatal —
    # the organisation-scoped link above already covers tenant members.
    requests.post(
        f"{GRAPH_BASE}/me/drive/items/{item_id}/invite",
        headers={**headers, "Content-Type": "application/json"},
        json={
            "recipients": [{"email": recipient_email}],
            "message": "",
            "requireSignIn": True,
            "sendInvitation": False,
            "roles": ["read"],
        },
    )

    return {"name": file_name, "webUrl": web_url, "itemId": item_id}


def send_message(token, chat_id, file_meta, message_text):
    attach_id = str(uuid.uuid4())
    body = {
        "body": {
            "contentType": "html",
            "content": f"{message_text}<br/><attachment id=\"{attach_id}\"></attachment>",
        },
        "attachments": [
            {
                "id": attach_id,
                "contentType": "reference",
                "contentUrl": file_meta["webUrl"],
                "name": file_meta["name"],
            }
        ],
    }
    resp = requests.post(
        f"{GRAPH_BASE}/chats/{chat_id}/messages",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"send message failed: {resp.text}")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    p = argparse.ArgumentParser(description="Send a file via Teams DM.")
    p.add_argument("--email", required=True, help="Recipient email/UPN")
    p.add_argument("--file", required=True, help="Path to file to send")
    p.add_argument("--message", default="Hi, please find the attached file.")
    p.add_argument("--interactive", action="store_true", help="Allow device-flow login if cache missing")
    args = p.parse_args()

    try:
        if not os.path.isfile(args.file):
            raise RuntimeError(f"file not found: {args.file}")

        token = get_access_token(interactive=args.interactive)
        me = get_me(token)
        my_id = me["id"]
        my_upn = (me.get("userPrincipalName") or "").lower()

        if args.email.lower() == my_upn:
            raise RuntimeError("recipient is the signed-in user — Teams does not allow self-DM")

        chat_id = get_or_create_chat(token, my_id, args.email)
        file_meta = upload_and_share_file(token, args.file, args.email)
        send_message(token, chat_id, file_meta, args.message)

        _emit({
            "ok": True,
            "chat_id": chat_id,
            "file_name": file_meta["name"],
            "web_url": file_meta["webUrl"],
        })
    except Exception as err:
        _emit({"ok": False, "error": str(err)})
        sys.exit(1)


if __name__ == "__main__":
    main()
