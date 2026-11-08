#!/usr/bin/env python3
"""Deploy edgetunnel (_worker.js) to Cloudflare Workers via the API.

Performs the full checklist from DEPLOY.md in order:
  1. Upload _worker.js with UUID + KEY vars (ES-module format).
  2. Create a KV namespace and bind it as `KV` (required for the
     subscription endpoint and the /admin panel).
  3. Enable the workers.dev route (fixes Cloudflare error 1042).
  4. Optionally bind a custom domain (needed in mainland China, where
     *.workers.dev is blocked).
  5. Verify the subscription at /{KEY} returns vless:// links.

The API token is read from the CLOUDFLARE_API_TOKEN environment variable.
It is never printed, and neither are the UUID or KEY values — output only
confirms lengths and success/failure per step.

Usage:
    export CLOUDFLARE_API_TOKEN="<your-token>"
    python3 deploy-edgetunnel.py --account-id <ACCOUNT_ID> \
        --script-name edgetunnel-test --uuid <UUIDv4> --key <KEY> \
        [--worker-file _worker.js] \
        [--domain edt.example.com --zone-id <ZONE_ID>]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = "https://api.cloudflare.com/client/v4"


def mask(value):
    """Return a non-revealing length hint for a secret value."""
    return f"<{len(value)} chars>" if value else "<empty>"


def api(method, path, token, body=None, content_type="application/json"):
    url = BASE + path
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        raw = e.read()[:2000].decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {raw}")


def upload_script(account_id, token, script_name, worker_file, bindings):
    """Upload _worker.js as an ES module. Returns True on success."""
    with open(worker_file, "rb") as f:
        script = f.read()
    metadata = {
        "main_module": os.path.basename(worker_file),
        "bindings": bindings,
        "compatibility_date": "2026-10-24",
    }
    boundary = "----edgedeploy" + os.urandom(8).hex()
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="metadata"\r\n'
    body += b"Content-Type: application/json\r\n\r\n"
    body += json.dumps(metadata).encode() + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += (
        f'Content-Disposition: form-data; name="{os.path.basename(worker_file)}"; '
        f'filename="{os.path.basename(worker_file)}"\r\n'
    ).encode()
    # ES-module content type is required; plain application/javascript is
    # parsed as a classic service worker and rejected with "Unexpected token
    # 'export'".
    body += b"Content-Type: application/javascript+module\r\n\r\n"
    body += script + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    _, data = api(
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{script_name}",
        token,
        body=body,
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    if not data.get("success"):
        raise RuntimeError(f"script upload failed: {data.get('errors')}")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True, help="Cloudflare account ID")
    parser.add_argument("--script-name", required=True, help="Worker script name")
    parser.add_argument("--uuid", required=True, help="VLESS user ID (UUIDv4)")
    parser.add_argument("--key", required=True, help="Quick-subscription path key")
    parser.add_argument("--worker-file", default="_worker.js", help="Worker source file")
    parser.add_argument("--domain", help="Custom hostname to bind (e.g. edt.example.com)")
    parser.add_argument("--zone-id", help="Zone ID of --domain (required with --domain)")
    args = parser.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        print("error: CLOUDFLARE_API_TOKEN is not set", file=sys.stderr)
        return 2
    try:
        uuid.UUID(args.uuid, version=4)
    except ValueError:
        print("error: --uuid must be a valid UUIDv4", file=sys.stderr)
        return 2
    if args.domain and not args.zone_id:
        print("error: --zone-id is required when --domain is given", file=sys.stderr)
        return 2

    base_bindings = [
        {"type": "plain_text", "name": "UUID", "text": args.uuid},
        {"type": "plain_text", "name": "KEY", "text": args.key},
    ]
    print(f"[1/5] Uploading {args.worker_file} as {args.script_name} ...")
    print(f"      UUID {mask(args.uuid)}, KEY {mask(args.key)}")
    upload_script(args.account_id, token, args.script_name, args.worker_file, base_bindings)
    print("      ok: script uploaded")

    print("[2/5] Creating KV namespace and binding it as KV ...")
    _, ns = api(
        "POST",
        f"/accounts/{args.account_id}/storage/kv/namespaces",
        token,
        body={"title": f"{args.script_name}-kv"},
    )
    if not ns.get("success"):
        raise RuntimeError(f"KV namespace creation failed: {ns.get('errors')}")
    namespace_id = ns["result"]["id"]
    bindings = base_bindings + [
        {"type": "kv_namespace", "name": "KV", "namespace_id": namespace_id}
    ]
    upload_script(args.account_id, token, args.script_name, args.worker_file, bindings)
    print("      ok: KV namespace created and bound as KV")

    print("[3/5] Enabling workers.dev route ...")
    _, sub = api(
        "POST",
        f"/accounts/{args.account_id}/workers/scripts/{args.script_name}/subdomain",
        token,
        body={"enabled": True},
    )
    if not sub.get("success") or not sub["result"].get("enabled"):
        raise RuntimeError(f"enabling workers.dev failed: {sub.get('errors')}")
    print("      ok: workers.dev enabled")

    host = f"{args.script_name}.workers.dev"
    if args.domain:
        print(f"[4/5] Binding custom domain {args.domain} ...")
        _, dom = api(
            "PUT",
            f"/accounts/{args.account_id}/workers/domains",
            token,
            body={
                "zone_id": args.zone_id,
                "hostname": args.domain,
                "service": args.script_name,
                "environment": "production",
            },
        )
        if not dom.get("success"):
            raise RuntimeError(f"custom domain binding failed: {dom.get('errors')}")
        host = args.domain
        print("      ok: custom domain bound (certificate/DNS may take a minute)")
    else:
        print("[4/5] No custom domain requested, skipping")

    print("[5/5] Verifying subscription ...")
    sub_url = f"https://{host}/{args.key}"
    req = urllib.request.Request(sub_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "replace")
            final_url = resp.geturl()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        final_url = sub_url
    if "vless://" in body:
        count = body.count("vless://")
        print(f"      ok: subscription returned {count} vless link(s) via {final_url}")
    elif "KV_NOT_BOUND" in body:
        print("      FAILED: subscription reports KV_NOT_BOUND — KV binding did not take effect")
        return 1
    else:
        print(f"      FAILED: subscription did not return vless links (got {len(body)} bytes)")
        print(f"      first bytes: {body[:200]!r}")
        return 1

    print()
    print(f"Done. Worker: {args.script_name}")
    print(f"  workers.dev: https://{args.script_name}.workers.dev/")
    if args.domain:
        print(f"  custom domain: https://{args.domain}/")
    print("  Subscription URL and admin-panel password are the KEY value you supplied;")
    print("  they are not printed here. Keep them secret.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
