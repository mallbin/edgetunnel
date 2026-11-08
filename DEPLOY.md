# Deploying edgetunnel via the Cloudflare API

This guide covers deploying `_worker.js` to Cloudflare Workers **using only the
Cloudflare API** (no dashboard clicks, no wrangler). Follow the steps in order —
skipping a step is the cause of the most common silent failures.

> **Prerequisites**
> - A Cloudflare API token with **Workers Scripts: Edit** and **Workers KV Storage:
>   Edit** on the account, plus **Workers Routes: Edit** on the zone if you bind a
>   custom domain. A token with only "Edit Cloudflare Workers" is enough for
>   steps 1–3; step 4 needs the zone permission.
> - Your Cloudflare **account ID**.
> - A **UUID** (UUIDv4) for the VLESS user ID and a **KEY** (short string) for the
>   quick-subscription path. Keep both secret — the KEY is also the fallback
>   admin-panel password when `ADMIN` is not set.
> - Python 3 with no extra dependencies for `deploy-edgetunnel.py`, or `curl`
>   if you prefer to call the API by hand.

## Step 1 — Upload `_worker.js` with UUID + KEY

Upload the script as an ES module with the two plain-text vars:

```bash
# See deploy-edgetunnel.py for the full multipart upload. By hand (curl):
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -F 'metadata={"main_module":"_worker.js","bindings":[{"type":"plain_text","name":"UUID","text":"<UUID>"},{"type":"plain_text","name":"KEY","text":"<KEY>"}],"compatibility_date":"2026-10-24"};type=application/json' \
  -F "_worker.js=@_worker.js;type=application/javascript+module"
```

Notes:
- The script part **must** use content type `application/javascript+module`.
  Using plain `application/javascript` makes Cloudflare parse the file as a
  classic service worker and reject it with `SyntaxError: Unexpected token
  'export'`.
- `_worker.js` is ~5 MB (~1.07 MB gzipped). That is just over the 1 MB free-plan
  compressed limit, but the upload is accepted; if a future release grows past
  the limit, use Workers Paid or deploy via Pages instead.

## Step 2 — Create and bind a KV namespace named `KV` (required)

The subscription endpoint (`/{KEY}`) and the `/admin` panel **only work when a
KV namespace is bound as `KV`**. The code guards them with
`if (env.KV && typeof env.KV.get === 'function')`. Without the binding, those
requests silently fall through to the disguise page with no error — the node
looks fine while the subscription is dead.

```bash
# 1. Create the namespace (returns an id):
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/storage/kv/namespaces" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"title":"<SCRIPT_NAME>-kv"}'

# 2. Bind it by re-uploading the script with the KV binding added to metadata:
#    "bindings": [..., {"type":"kv_namespace","name":"KV","namespace_id":"<NAMESPACE_ID>"}]
#    (deploy-edgetunnel.py does both steps for you.)
```

Verify the binding with:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>/settings" \
  -H "Authorization: Bearer <API_TOKEN>"
# → result.bindings must contain {"name":"KV","type":"kv_namespace",...}
```

## Step 3 — Enable the `workers.dev` route (fixes error 1042)

Workers created through the API do **not** get a `workers.dev` route by
default. Until you enable it, every request returns Cloudflare error **1042**
("workers.dev URL with no Worker serving it"). Setting `workers_dev: true` in
the upload metadata does **not** enable it — use the dedicated endpoint:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>/subdomain" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"enabled":true}'
# → {"result":{"enabled":true,"previews_enabled":true},"success":true}
```

After this, `https://<SCRIPT_NAME>.<YOUR_SUBDOMAIN>.workers.dev/` should answer
with the disguise page (HTTP 200), not 1042.

## Step 4 — Bind a custom domain (mainland China)

`*.workers.dev` is blocked or heavily throttled on many mainland-China
networks. For users in China, bind a custom domain on a zone you control:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/domains" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"zone_id":"<ZONE_ID>","hostname":"<HOSTNAME>","service":"<SCRIPT_NAME>","environment":"production"}'
# → {"result":{"hostname":"<HOSTNAME>","service":"<SCRIPT_NAME>","enabled":true},"success":true}
```

Cloudflare provisions the certificate and DNS for the hostname automatically.
Wait a minute for propagation, then confirm `https://<HOSTNAME>/` returns HTTP
200.

## Step 5 — Verify the subscription returns VLESS links

```bash
curl -s "https://<HOSTNAME>/<KEY>" -o /dev/null -w "%{http_code}\n"
# Expect a 302 redirect to /sub?token=... ; follow it:
curl -sL "https://<HOSTNAME>/<KEY>" | head -c 300
# Expect one or more lines starting with vless://
```

If `https://<HOSTNAME>/<KEY>` returns the disguise page instead of a
subscription, the KV binding from Step 2 is missing. With the KV fix in this
fork, a request to `/{KEY}` or `/admin` without a bound KV now returns a
clear JSON error instead of the disguise page:

```json
{"error":"KV_NOT_BOUND","message":"KV namespace 'KV' is not bound — bind a KV namespace named KV to enable subscription and admin panel"}
```

## Quick checklist

1. [ ] Script uploaded with `UUID` + `KEY` vars (ES-module content type).
2. [ ] KV namespace created and bound as `KV`.
3. [ ] `workers.dev` enabled via the subdomain endpoint (no more 1042).
4. [ ] Custom domain bound (for China).
5. [ ] `/{KEY}` returns `vless://` links; `/admin` shows the login page.

## Automated deploy

`deploy-edgetunnel.py` performs steps 1–4 in order. It reads the API token
from the `CLOUDFLARE_API_TOKEN` environment variable and never prints it, the
UUID, or the KEY:

```bash
export CLOUDFLARE_API_TOKEN="<your-token>"
python3 deploy-edgetunnel.py \
  --account-id <ACCOUNT_ID> \
  --script-name edgetunnel-test \
  --uuid <UUIDv4> --key <KEY> \
  --domain edt.example.com --zone-id <ZONE_ID>   # --domain/--zone-id optional
```

Run `python3 deploy-edgetunnel.py --help` for all options.
