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
- `_worker.js` is slim (~316 KB raw, ~76 KB gzipped), comfortably under the
  1 MB free-plan compressed limit. An earlier version carried ~4.8 MB of inert
  filler text in a trailing comment; that has been removed — it had no effect
  on behavior.

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

## Custom preferred IPs (`CUSTOM_IPS`, optional)

The subscription normally serves IPs drawn at random from the carrier CIDR
list for the **auto-detected** carrier (Cloudflare's `request.cf` data decides
ct / cu / cmcc / cf; a `?cnIspCode=` query parameter can override it). That
list is static and may not match the IPs that are actually fastest on your
local network.

To plug in IPs you measured yourself, set a plain-text variable named
`CUSTOM_IPS` (comma-separated, each entry an IP with an optional port):

```
CUSTOM_IPS = 1.2.3.4:443,5.6.7.8:2083,9.10.11.12
```

- Entries without a port default to `443`. An entry may carry its own `#remark`
  (e.g. `1.2.3.4:443#my-best-ip`); without one it is labelled `自定义优选N`.
- When set, the subscription **adds** these as extra nodes alongside the
  auto-detected carrier nodes — same host/SNI/path/fingerprint as the others.
- When unset, the subscription behaves exactly as before (auto-detected
  carrier list only).
- Nothing about a region or ISP is baked into this: the code never forces a
  carrier. The auto-detection keeps working from whatever local network the
  Worker is reached from, so the same deployment still works if you move or
  change ISP — just re-measure and update `CUSTOM_IPS`.

Set it like any other variable — add
`{"type":"plain_text","name":"CUSTOM_IPS","text":"<your-list>"}` to the
upload metadata, or add it in the dashboard under the Worker's Settings →
Variables. A re-deploy is needed for the change to take effect.

## If the Worker returns Error 1101 (service blocked)

Error 1101 on every path — including a plain hello-world script — means the
**service itself is blocked on the account**, not the code. This was verified
2026-11-08: a minimal hello-world deployed to `edgetunnel-test` still returned
1101, while the same hello-world, a minimal VLESS proxy, and the full
`_worker.js` (without bindings) all returned 200/404 on a fresh service name.
Deploying the full build **with** UUID/KEY/KV bindings to a fresh service
made that service return 1101 too, and it stayed blocked even after the code
or bindings were changed. So a flagged service cannot be recovered by
re-deploying code to it — use a fresh service name (delete and recreate the
service, or pick a new name) and re-bind the custom domain.

**Root cause found 2026-11-09:** on this account, a *static* import of
`cloudflare:sockets` (`import { connect } from "cloudflare:sockets"`) is what
gets a service flagged with 1101. Load it *dynamically at runtime* instead
(`const { connect } = await import("cloudflare:sockets")` inside the async
handler) and the same code loads clean — verified by fetching baidu through
the Worker (HTTP 200). This is why every edgetunnel version with a static
import failed. `_worker.minimal.js` now uses the dynamic import; never put the
static import back.

When the full build keeps getting flagged, use the minimal build instead:
`_worker.minimal.js` is a ~9 KB VLESS-over-WebSocket proxy with a lightweight
`/sub` subscription endpoint (4 nodes, `fp=chrome`). It has no KV binding, no
admin panel, and no env vars. Verified 2026-11-08 on a fresh service: `/`
returns 200 `ok` and `/sub` returns 200 with 4 `vless://` links.

Deploy it like the full build but simpler — replace the placeholder UUID in
the file with your own UUIDv4 first, upload as `application/javascript+module`,
then enable the `workers.dev` subdomain (Step 3). No KV, no UUID/KEY vars.

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
