# 📈 Stocktracker API

[![CI](https://github.com/riannbarbosa/stocktracker/actions/workflows/ci.yml/badge.svg)](https://github.com/riannbarbosa/stocktracker/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node-22-5FA04E?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-FF4438?logo=redis&logoColor=white)

REST API for B3 (Brazilian stock exchange) quotes, fetched from
[brapi.dev](https://brapi.dev) and cached in Redis. Each account gets:

- a **watchlist** of tickers;
- **price alerts** that land as in-app notifications, and optionally a webhook;
- an opt-in **email summary** of the watchlist, daily, weekly or monthly.

Built with Fastify 5 on Node 22, running the TypeScript sources directly via
native type stripping — there is no build step.

![stocktracker-api structure map: the api container with its routes, services, repositories and workers, Redis and Postgres in docker compose, and brapi.dev, webhooks and SMTP outside it](docs/structure-map.png)

## 📑 Contents

- [🧱 Stack](#-stack)
- [🚀 Quick start](#-quick-start)
- [📡 Endpoints](#-endpoints)
- [💹 How a quote is resolved](#-how-a-quote-is-resolved)
- [🔔 How an alert fires](#-how-an-alert-fires)
- [📬 How the watchlist summary is sent](#-how-the-watchlist-summary-is-sent)
- [🧪 Worked example: an alert end to end](#-worked-example-an-alert-end-to-end)
- [⚙️ Configuration](#-configuration)
- [🔒 Security posture](#-security-posture)
- [📜 Scripts](#-scripts)
- [🐳 Make targets](#-make-targets)
- [🗂️ Project layout](#-project-layout)
- [📄 License](#-license)

## 🧱 Stack

| Piece | Choice |
| --- | --- |
| Runtime | Node 22 (native `.ts` type stripping, no transpile step) |
| Framework | Fastify 5 + `@fastify/swagger` / `swagger-ui` |
| Cache | Redis 7 (`redis` v6 client) |  
| Database | Postgres 16 (`pg` pool) — users, watchlist, alerts, notifications, summary prices; schema applied on boot |
| Upstream | brapi.dev |
| Email | `nodemailer` over SMTP — watchlist summary and password reset |
| Package manager | Yarn 4 (PnP locally, node-modules in the image) |
| Tests | `node --test` |

## 🚀 Quick start

### Docker (recommended)

```bash
cp .env.example .env
# JWT_SECRET is required; the API will not start without it
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
make up                 # docker compose up --build -d
```

The API listens on `http://localhost:3000`, Swagger UI on
`http://localhost:3000/docs`. Adding a `BRAPI_TOKEN` to `.env` is optional but
avoids brapi's free-tier rate limit.

### First requests

Most routes need a token. Register once and keep the token in a shell variable:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}' \
  | sed 's/.*"token":"\([^"]*\)".*/\1/')

curl http://localhost:3000/quotes/PETR4                          # public
curl http://localhost:3000/watchlist -H "authorization: Bearer $TOKEN"
```

Tokens expire after an hour (`JWT_TTL_SECONDS`); call `/auth/login` with the
same body to get a new one. In Swagger UI, paste the token into **Authorize**.
The examples below assume `$TOKEN` is set.

If Docker isn't installed, `make docker-install` handles it on Debian/Ubuntu
(apt) and Fedora (dnf).

### Local (without containers)

Redis and Postgres still need to be reachable — the easiest path is to start
just those two from compose:

```bash
docker compose up -d redis postgres
cp .env.example .env
```

Then point `.env` at localhost (`REDIS_URL=redis://localhost:6379`,
`DATABASE_URL=postgres://postgres:postgres@localhost:5433/stocktracker` — note
port **5433**, which is what compose publishes), set `JWT_SECRET` as above, and
run:

```bash
yarn install
yarn dev        # watch mode
```

> **Upgrading an existing volume:** `watchlist.owner` became
> `watchlist.owner_id` when authentication landed. `schema.sql` is idempotent
> DDL applied on boot, and `CREATE TABLE IF NOT EXISTS` cannot change an
> existing table, so run `make down` once (it drops the volume) and start again.
> This is the point at which the project would outgrow boot-time DDL and want
> numbered migrations.

> Postgres is **required**: `migrateDatabase()` applies `src/db/schema.sql` on
> every boot, and a failure there aborts startup — a boot without a schema is a
> broken deploy, not a degraded one. Redis is **not** required: `connectRedis()`
> is deliberately not awaited, so a cache outage costs latency, not availability.

## 📡 Endpoints

🔓 public · 🔒 needs `Authorization: Bearer <token>`

| | Method | Route | What |
| --- | --- | --- | --- |
| 🔓 | `GET` | `/quotes/:symbols` | Quotes for up to 10 tickers, Redis-cached |
| 🔓 | `POST` | `/auth/register` | Create an account, get a token |
| 🔓 | `POST` | `/auth/login` | Exchange credentials for a token |
| 🔓 | `POST` | `/auth/forgot-password` | E-mail a password reset token |
| 🔓 | `POST` | `/auth/reset-password` | Choose a new password with that token |
| 🔒 | `POST` | `/auth/logout-all` | Revoke every token issued to the account |
| 🔒 | `GET` | `/watchlist` | Tickers you track |
| 🔒 | `POST` | `/watchlist` | Track a ticker (idempotent) |
| 🔒 | `DELETE` | `/watchlist/:symbol` | Stop tracking one |
| 🔒 | `GET` | `/alerts` | Your price alerts |
| 🔒 | `POST` | `/alerts` | Create a price alert |
| 🔒 | `GET` | `/alerts/:id` | One alert |
| 🔒 | `DELETE` | `/alerts/:id` | Delete one |
| 🔒 | `GET` | `/notifications` | Alert firings, newest first (`?unread=true`) |
| 🔒 | `PATCH` | `/notifications/:id/read` | Mark one read |
| 🔒 | `POST` | `/notifications/read-all` | Mark all read |
| 🔒 | `GET` | `/account/digest` | Your watchlist summary settings |
| 🔒 | `PUT` | `/account/digest` | Set the summary frequency |
| 🔓 | `GET` | `/healthz` · `/readyz` | Liveness · readiness |
| 🔓 | `GET` | `/docs` | Swagger UI (spec at `/docs/json`) |

### `GET /quotes/:symbols`

Comma-separated symbols, up to `QUOTE_MAX_SYMBOLS` (default 10). Symbols are
uppercased and de-duplicated; results come back in request order.

```bash
curl -i http://localhost:3000/quotes/PETR4,VALE3
```

```json
[
  {
    "symbol": "PETR4",
    "name": "PETROBRAS   PN",
    "currency": "BRL",
    "price": 31.42,
    "dayHigh": 31.8,
    "dayLow": 31.05,
    "change": 0.22,
    "changePercent": 0.7,
    "time": "2026-09-15T20:06:00.000Z",
    "marketCap": 410000000000,
    "volume": 38215400,
    "logoUrl": "https://icons.brapi.dev/icons/PETR4.svg",
    "fetchedAt": "2026-09-15T20:07:11.412Z"
  }
]
```

The `x-cache` response header reports `HIT`, `MISS`, or `PARTIAL` for the batch.
`time` is the provider's quote timestamp; `fetchedAt` is when this API produced
the value.

| Status | Meaning |
| --- | --- |
| 200 | Quotes resolved |
| 400 | Symbol list failed schema validation (bad ticker shape, or too many) |
| 404 | brapi does not know one of the symbols |
| 502 | brapi unavailable after retries |

### `POST /auth/register`, `POST /auth/login`

`/quotes`, `/docs` and the health probes are public. Everything marked 🔒 in
the table above needs `Authorization: Bearer <token>`, and every row it touches
belongs to the user in that token.

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}'
```

```json
{ "token": "eyJhbGciOiJIUzI1NiIs...", "expiresIn": 3600 }
```

`login` takes the same body and returns the same shape. Passwords are hashed
with `scrypt` (`node:crypto`, no native dependency) and a per-password salt;
tokens are HS256, signed and verified by `@fastify/jwt`.

| Route | Status | Meaning |
| --- | --- | --- |
| `POST /auth/register` | 201 | Account created, token issued |
| `POST /auth/register` | 400 | Bad address, or password under 12 characters |
| `POST /auth/register` | 409 | Address already registered |
| `POST /auth/login` | 200 | Token issued |
| `POST /auth/login` | 401 | Wrong password **or** unknown address — the reply is identical either way, so the endpoint cannot be used to discover which addresses exist |

Every protected route answers **401** without a token, and Swagger UI has an
**Authorize** button that puts one on each request.

#### `POST /auth/logout-all` 🔒

Revokes every token already issued to the account, including the one used to
make the call:

```bash
curl -X POST http://localhost:3000/auth/logout-all \
  -H "authorization: Bearer $TOKEN"
```

```json
{ "tokenVersion": 1 }
```

Use it after a suspected leak. A password reset does the same — see
[Security posture](#-security-posture) for how it works.

#### `POST /auth/forgot-password` · `POST /auth/reset-password`

Ask for a reset token, which arrives by e-mail (needs `SMTP_URL`):

```bash
curl -X POST http://localhost:3000/auth/forgot-password \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
```

```json
{ "message": "if the address is registered, a reset e-mail is on its way" }
```

Then trade the token for a new password. The reply is a fresh token, and every
token issued before the reset stops working:

```bash
curl -X POST http://localhost:3000/auth/reset-password \
  -H 'content-type: application/json' \
  -d '{"token":"42.<secret from the e-mail>","password":"a-brand-new-password"}'
```

With `PASSWORD_RESET_URL` set, the e-mail carries a link to that page with the
token in the fragment (`…/reset#token=…`) instead of the bare token.

| Route | Status | Meaning |
| --- | --- | --- |
| `POST /auth/forgot-password` | 202 | Always, registered address or not |
| `POST /auth/forgot-password` | 429 | Too many requests from this IP or for this address; see `Retry-After` |
| `POST /auth/reset-password` | 200 | Password changed, older tokens revoked, new token issued |
| `POST /auth/reset-password` | 400 | Password under 12 characters, **or** a token that is malformed, expired, already used or superseded — one message for all of those |
| `POST /auth/reset-password` | 429 | Too many attempts from this IP |
| both | 503 | Redis is down; reset tokens and rate limits live there |

### `GET /watchlist`

Tickers tracked by the authenticated user.

```bash
curl -X POST http://localhost:3000/watchlist -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"symbol":"petr4"}'
curl http://localhost:3000/watchlist -H "authorization: Bearer $TOKEN"
curl -X DELETE http://localhost:3000/watchlist/PETR4 -H "authorization: Bearer $TOKEN"
```

```json
[{ "id": 1, "symbol": "PETR4", "ownerId": 1, "createdAt": "2026-09-22T02:21:58.213Z" }]
```

Tickers are upper-cased on the way in. `POST` is idempotent — re-adding a ticker
returns the existing row rather than erroring.

| Route | Status | Meaning |
| --- | --- | --- |
| `GET /watchlist` | 200 | Tracked tickers, one entry per row |
| `POST /watchlist` | 201 | Added (or already present) |
| `POST /watchlist` | 400 | `symbol` missing or not shaped like a B3 ticker |
| `DELETE /watchlist/:symbol` | 204 | Removed, empty body |
| `DELETE /watchlist/:symbol` | 404 | Ticker was not on the list |

### `GET /alerts`, `POST /alerts`, `GET /alerts/:id`, `DELETE /alerts/:id`

Price alerts. Each one names a ticker, a `direction` (`above` / `below`), a
`targetPrice`, and an optional `webhookUrl`. Every firing creates an in-app
notification (see [`/notifications`](#get-notifications-patch-notificationsidread-post-notificationsread-all));
the webhook, when set, is POSTed to as well.

```bash
curl -X POST http://localhost:3000/alerts -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"symbol":"PETR4","direction":"below","targetPrice":30,
       "webhookUrl":"https://hooks.example.test/petr4"}'
```

```json
{
  "id": 1, "symbol": "PETR4", "direction": "below", "targetPrice": 30,
  "webhookUrl": "https://hooks.example.test/petr4",
  "active": true, "firedAt": null, "lastPrice": null, "lastCheckedAt": null,
  "createdAt": "2026-09-22T02:22:28.381Z", "updatedAt": "2026-09-22T02:22:28.381Z"
}
```

Read that as **"tell me when PETR4 drops to 30 or below"**. That request is the
whole job — you do not poll, acknowledge or close anything afterwards.

Of the eleven fields that come back, you send four. `id`, `active`, `createdAt`
and `updatedAt` come from the database, and `firedAt`, `lastPrice` and
`lastCheckedAt` are the poller's, written as it works. See
[Worked example](#-worked-example-an-alert-end-to-end) for the full lifecycle
with real output.

`GET /alerts` returns only your own alerts, and `GET`/`DELETE /alerts/:id`
answer **404** for someone else's id — not 403, which would confirm the id
exists.

| Route | Status | Meaning |
| --- | --- | --- |
| `GET /alerts` | 200 | Every alert, most recently created first |
| `POST /alerts` | 201 | Created |
| `POST /alerts` | 400 | Schema validation failed, or the webhook URL was rejected |
| `GET /alerts/:id` | 200 / 404 | The alert, or not found |
| `DELETE /alerts/:id` | 204 / 404 | Deleted (empty body), or not found |

### `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all`

One notification per alert firing, written in the same statement that sets the
alert's `firedAt`, so a fired alert always has one. It copies the alert's
symbol, direction and target, and keeps them if the alert is later deleted
(`alertId` becomes `null`).

```json
{
  "id": 1, "alertId": 1, "symbol": "PETR4", "direction": "below",
  "targetPrice": 30, "price": 29.87, "readAt": null,
  "createdAt": "2026-09-22T02:24:00.112Z"
}
```

| Route | Status | Meaning |
| --- | --- | --- |
| `GET /notifications` | 200 | Newest first; `?unread=true`, `?limit=1..100` (default 50) |
| `PATCH /notifications/:id/read` | 200 / 404 | The notification (an already-read one keeps its `readAt`), or not found |
| `POST /notifications/read-all` | 200 | `{ "updated": n }`, how many were unread |

### `GET /account/digest`, `PUT /account/digest`

How often the watchlist summary is emailed to the account address. Every
account starts at `off`.

```bash
curl -X PUT http://localhost:3000/account/digest \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"frequency":"weekly"}'
```

```json
{ "frequency": "weekly", "lastSentAt": null }
```

| Route | Status | Meaning |
| --- | --- | --- |
| `GET /account/digest` | 200 | `frequency` (`off` · `daily` · `weekly` · `monthly`) and `lastSentAt` |
| `PUT /account/digest` | 200 | Saved; the body is the new settings |
| `PUT /account/digest` | 400 | Unknown frequency or extra properties |

See [How the watchlist summary is sent](#-how-the-watchlist-summary-is-sent)
for when it actually goes out.

### `GET /healthz`

Liveness. Always 200 while the process is serving; checks no dependencies.

### `GET /readyz`

Readiness. Pings Postgres and reports Redis connection state. Returns **503**
when the database is unreachable. A down Redis is reported in `checks.redis`
but does **not** fail the probe — quotes still resolve from brapi without the
cache.

```json
{ "status": "ready", "checks": { "database": true, "redis": true } }
```

### `GET /docs`

Swagger UI, generated from the route schemas (OpenAPI 3.1). The raw spec is
served at `GET /docs/json`.

## 💹 How a quote is resolved

1. Symbols are normalized (trimmed, uppercased, de-duplicated).
2. A single `MGET` looks up `quote:<SYMBOL>` for all of them.
3. Misses are fetched from brapi concurrently, one request per symbol, each with
   up to `BRAPI_RETRY_COUNT` attempts. Only 5xx and 429 are retried, with
   exponential backoff plus jitter.
4. Fresh quotes are written back in a `MULTI` with `EX = QUOTE_CACHE_TTL`.

Redis is treated as optional throughout: a failed read logs a warning and falls
through to brapi, and a failed write is swallowed. A cache entry that fails to
parse counts as a miss and gets overwritten.

## 🔔 How an alert fires

`src/workers/alertPoller.ts` runs **in the same process as the API**, started
from `src/server.ts` when `ALERTS_POLLER_ENABLED` is on. Every
`ALERTS_POLL_INTERVAL_MS`:

1. It takes `pg_try_advisory_lock(ALERTS_LOCK_KEY)`. If another instance holds
   it the cycle is skipped, so running several replicas does not notify twice.
2. It reads up to `ALERTS_BATCH_SIZE` active alerts, oldest-checked first.
3. It resolves the distinct symbols through the **same cache-aside path as
   `/quotes`**, so the poller warms and reuses the quote cache.
4. `evaluateAlert()` (`src/services/alerts.ts`) decides per alert. It is pure, so
   the whole rule is unit-testable with no database and no market feed:

   | State | Condition | Outcome |
   | --- | --- | --- |
   | armed (`firedAt` null) | met | **trigger** — notify once, set `fired_at` |
   | fired | no longer met | **rearm** — clear `fired_at`, stay quiet |
   | anything else | | **noop** — just record the observed price |

   The re-arm branch is what stops a price hovering on the target from
   notifying on every interval.
5. A trigger writes an in-app notification in the same statement that sets
   `fired_at` (`markAlertFired()`), then `src/services/notifier.ts` sends a JSON
   `POST` to `webhookUrl` if the alert has one. A webhook failure is logged and
   swallowed — it never kills the cycle, and the interval always survives.

## 📬 How the watchlist summary is sent

Alerts are for "tell me the moment X happens"; the summary is for "how did my
watchlist do". `src/workers/digestWorker.ts` runs in the API process next to
the alert poller, every `DIGEST_CHECK_INTERVAL_MS` (15 minutes by default).

1. **Advisory lock** on its own key (`DIGEST_LOCK_KEY`), so replicas never send
   the same summary twice and it never blocks the alert poller.
2. **Who is due** is decided by `isDigestDue()` (`src/services/digest.ts`),
   pure like `evaluateAlert()`. Nothing goes out before `DIGEST_SEND_HOUR` in
   `DIGEST_TIME_ZONE` (18:00 São Paulo, after the B3 close). After that:

   | Frequency | Due when the last summary went out… |
   | --- | --- |
   | `daily` | on an earlier local day |
   | `weekly` | 7 or more local days ago |
   | `monthly` | in an earlier month |

   It compares **local calendar dates**, not elapsed hours: 01:00 UTC on the
   28th is still the 27th in São Paulo, and a send at 18:40 does not push the
   next one to 18:40.
3. **The email** lists every watchlist ticker with its current price and the
   change since the previous summary. That baseline lives in `digest_prices`,
   one row per owner and ticker. A ticker's first summary shows `new`; one
   whose quote failed shows `price unavailable` and keeps its old baseline.

   ```
   Your weekly watchlist summary

   PETR4        48.72  +2.31%
   VALE3        71.16  -0.84%
   ITUB4        33.10  new
   ```

4. **After sending**, `recordDigestSent()` stores `digest_last_sent_at` and the
   new baseline in one statement, using the worker's clock so the next due
   check reads the same time it wrote.

Failures are per user. A bad address or a quote outage is logged as
`digest failed` and the rest still go out; nothing is recorded, so the next
check retries. An empty watchlist sends nothing and records nothing, so the
summary starts as soon as a ticker is added.

Without `SMTP_URL` every send fails with `SMTP_URL is not configured`. For local
testing, run [Mailpit](https://mailpit.axllent.org)
(`docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit`), set
`SMTP_URL=smtp://localhost:1025` (or the host's address from inside compose),
and read the mail at `http://localhost:8025`.

## 🧪 Worked example: an alert end to end

Real output from a local run. Three settings make it fast and deterministic —
a 3s cycle instead of 60s, a price pinned in the cache so the run does not
depend on brapi, and the private-network escape hatch because the receiver is
on localhost:

```bash
docker compose up -d redis postgres
docker compose exec redis redis-cli set quote:PETR4 \
  '{"symbol":"PETR4","price":48,"name":null,"currency":"BRL","dayHigh":49,"dayLow":47,"change":0,"changePercent":0,"time":null,"marketCap":null,"volume":null,"logoUrl":null,"fetchedAt":"2026-09-22T02:00:00.000Z"}' EX 900

ALERTS_POLL_INTERVAL_MS=3000 \
WEBHOOK_ALLOW_PRIVATE=true WEBHOOK_ALLOWED_SCHEMES=https,http yarn dev
```

**1. Create the alert.** PETR4 is at 48, so a `below 50` alert is already
satisfied and fires on the next cycle:

```bash
curl -X POST http://localhost:3000/alerts -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"symbol":"PETR4","direction":"below","targetPrice":50,
       "webhookUrl":"http://localhost:3099/hook"}'
```

```json
{ "id": 6, "symbol": "PETR4", "direction": "below", "targetPrice": 50,
  "active": true, "firedAt": null, "lastPrice": null, "lastCheckedAt": null }
```

**2. It fires**, 2.3 seconds later. A notification appears in
`GET /notifications`, and the webhook receives an event rather than the alert
row:

```
[03:27:03] {"event":"alert.triggered","alertId":6,"symbol":"PETR4",
            "direction":"below","targetPrice":50,"price":48,
            "triggeredAt":"2026-09-22T03:27:03.354Z"}
```

```
id=6  firedAt=2026-09-22T03:27:03.348Z  lastPrice=48  lastCheckedAt=...03.348Z
```

**3. Three more cycles, price still 48 — nothing is sent.** The condition is
still met every cycle, but `firedAt` is set, so the alert stays quiet. Without
that rule you would get one webhook per interval, forever:

```
deliveries: 1        firedAt: 2026-09-22T03:27:03.348Z
```

**4. Price rises to 60 — the alert re-arms, silently.** `firedAt` goes back to
null and **nothing is delivered**; re-arming is not an event:

```
deliveries: 1        firedAt: null        lastPrice: 60
```

**5. Price falls to 45 — it fires again.** The alert watches the *crossing*, not
the value, so it is reusable:

```
[03:27:03] ... "price":48 ...
[03:27:39] ... "price":45 ...
```

```
created (firedAt null) ──price crosses──> notify once, set firedAt
                                               │
                             price goes back ──┘
                             (re-arm, silent, firedAt -> null)
                                               │
                             price crosses ──> notify again
```

An alert is never "used up" — it fires every time the price crosses the target.
To stop one, `DELETE /alerts/6`.

### Reproducing it without the local receiver

The quickest path with `make up` already running is [webhook.site](https://webhook.site),
which gives you a public `https` URL and shows the payload as it lands — no
escape hatch needed, since the destination is public:

```bash
curl http://localhost:3000/quotes/PETR4          # pick a target that will fire
curl -X POST http://localhost:3000/alerts -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"symbol":"PETR4","direction":"below","targetPrice":999,"webhookUrl":"https://webhook.site/YOUR-ID"}'
curl http://localhost:3000/alerts -H "authorization: Bearer $TOKEN"          # firedAt fills in
curl http://localhost:3000/notifications -H "authorization: Bearer $TOKEN"   # and a notification appears
```

Pinning the cached price by hand, as in step 4 above, is how you force a re-arm
without waiting for the market to move.

## ⚙️ Configuration

Every variable has a default in `src/config.ts`, so `.env` only needs the ones
you want to change. `.env.example` documents the full set.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Bound on `0.0.0.0` |
| `LOG_LEVEL` | `info` | Pino level |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` inside compose |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stocktracker` | compose overrides this for the `api` service |
| `BRAPI_BASE_URL` | `https://brapi.dev/api` | |
| `BRAPI_TOKEN` | *(none)* | Optional; the free tier works unauthenticated but is heavily rate limited. Get one at <https://brapi.dev/dashboard> |
| `BRAPI_TIMEOUT_MS` | `5000` | Per-request `AbortSignal.timeout` |
| `BRAPI_RETRY_COUNT` | `3` | Total attempts, not extra retries |
| `QUOTE_CACHE_TTL` | `60` | Seconds |
| `QUOTE_CACHE_PREFIX` | `quote:` | |
| `QUOTE_MAX_SYMBOLS` | `10` | Enforced by the route's regex, so the failure is a 400 |
| `PG_STARTUP_RETRIES` | `10` | Boot waits this many times for Postgres before giving up |
| `PG_STARTUP_RETRY_DELAY_MS` | `1000` | Delay between those attempts |
| `DB_MAX_POOL_SIZE` | `10` | `pg` pool size |
| `ALERTS_POLLER_ENABLED` | `true` | Set `false` to run the API without the poller |
| `ALERTS_POLL_INTERVAL_MS` | `60000` | Cycle interval — note: **not** `ALERTS_POLLER_INTERVAL_MS` |
| `ALERTS_BATCH_SIZE` | `100` | Alerts evaluated per cycle |
| `ALERTS_LOCK_KEY` | `alerts_poller_lock` | Folded into a bigint for `pg_try_advisory_lock` |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Per-delivery `AbortSignal.timeout` |
| `JWT_SECRET` | **none** | Required. The boot throws without it — see below |
| `JWT_TTL_SECONDS` | `3600` | Token lifetime. `POST /auth/logout-all` revokes early |
| `WEBHOOK_ALLOWED_SCHEMES` | `https` | Accepts `https` or `https:`; comma-separated |
| `WEBHOOK_ALLOWED_HOSTS` | *(empty)* | When set, **only** these hosts are accepted, and they skip the private-range check |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Dev escape hatch — skips the private/loopback check |
| `DIGEST_ENABLED` | `true` | Set `false` to run the API without the summary worker |
| `DIGEST_SEND_HOUR` | `18` | Local hour (1–23) from which summaries go out; `0` falls back to 18 |
| `DIGEST_TIME_ZONE` | `America/Sao_Paulo` | IANA zone for the hour and the calendar |
| `DIGEST_CHECK_INTERVAL_MS` | `900000` | How often the worker looks for due summaries |
| `DIGEST_LOCK_KEY` | `digest_worker_lock` | Folded into a bigint for `pg_try_advisory_lock` |
| `SMTP_URL` | *(none)* | e.g. `smtp://user:pass@host:587`; required for the summary and password reset |
| `EMAIL_FROM` | `stocktracker@localhost` | `From:` on outgoing mail |
| `PASSWORD_RESET_TTL_SECONDS` | `1800` | How long a reset token works |
| `PASSWORD_RESET_URL` | *(none)* | Reset page linked from the e-mail, token in the fragment; without it the e-mail carries the bare token |
| `PASSWORD_RESET_WINDOW_SECONDS` | `3600` | Rate-limit window for both reset routes |
| `PASSWORD_RESET_MAX_PER_IP` | `10` | Requests per IP per window, for each reset route |
| `PASSWORD_RESET_MAX_PER_EMAIL` | `3` | Reset e-mails per address per window |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For`. Only behind a proxy you control |

`JWT_SECRET` is the one variable with **no default**. Every other key falls back
so the app boots out of the box; a signing secret that falls back is a signing
secret that reaches production unchanged, so `src/config.ts` throws instead.
Generate one with `openssl rand -base64 48`.

Two details worth knowing when editing `.env`:

- `docker-compose.yml` sets `BRAPI_BASE_URL` and `DATABASE_URL` for the `api`
  service, and those **override** what `.env` says. The `.env` values are what
  `yarn dev` uses outside Docker.
- `POSTGRES_PORT` (default `5433`) is the *host* port compose publishes;
  inside the network Postgres is still on 5432.

Two `config.alerts` keys look alike: the poller reads **`pollIntervalMs`**
(`ALERTS_POLL_INTERVAL_MS`). `pollerIntervalMs` (`ALERTS_POLLER_INTERVAL_MS`,
the one `.env.example` lists) is not read by anything.

## 🔒 Security posture

What to know before exposing this to anything but localhost: one fixed
finding, one residual risk, and one robustness gap.

### ✅ Webhook destinations are validated (SSRF, fixed)

`webhookUrl` is caller-chosen and the poller POSTs to it from inside the
deployment network, so `format: 'uri'` is not a control — it admits any scheme
and any host, including loopback, RFC1918 and the link-local `169.254.169.254`
that carries cloud instance metadata. `src/lib/webhookUrl.ts` vets every
destination instead, in two places:

- **On write**, in `POST /alerts`, so a bad URL is a 400 with a reason rather
  than a delivery that silently fails a minute later.
- **On send**, in `sendWebhook`, because a stored row may predate a config
  change or have been inserted out of band.

What it rejects, by default: any scheme other than `https`; embedded
credentials; and hosts that resolve into the loopback, link-local, RFC1918,
CGNAT, unspecified, multicast or reserved ranges, for IPv4 and IPv6 alike.
IPv4-mapped IPv6 (`::ffff:169.254.169.254`) is unwrapped and judged as IPv4, and
a name answering with several addresses is rejected if *any* of them is blocked.
Deliveries also run with `redirect: 'manual'`, so a 3xx cannot move the request
to a host that was never validated.

Two operator overrides, both off by default: `WEBHOOK_ALLOWED_HOSTS` is the
supported way to reach an internal collector (when set, only those hosts are
accepted, and they skip the range check), and `WEBHOOK_ALLOW_PRIVATE=true` is
the development escape hatch that lets a local receiver work.

**Residual risk worth knowing:** validation resolves the hostname, then `fetch`
resolves it again, so a DNS entry that changes between the two could still point
the request somewhere else (DNS rebinding). Closing that requires pinning the
validated address with a custom undici dispatcher, which is not implemented.
`WEBHOOK_ALLOWED_HOSTS` is not affected, since it never resolves at all.

### ✅ Authentication and per-user scoping

`/quotes`, `/docs` and the health probes are public. Every other route sits
inside a Fastify plugin that registers the `onRequest` hook from
`src/plugins/authenticate.ts`, so **a route added inside that scope is protected
by default** — there is no per-route flag to forget. The same scope adds
"(Requires Auth)" to each route's summary in Swagger.

The owner never comes from the request body. It is read from the verified token
by `ownerOf()`, which throws if a route somehow ends up outside the
authenticated scope, turning a wiring mistake into a loud failure instead of a
silently undefined owner reaching the SQL. Every HTTP-facing query in
`src/repositories/` carries `WHERE owner_id = $n` (or `WHERE id = $n` on
`users`), and a miss returns 404 rather than 403 so ids cannot be enumerated.

The two workers' queries — `listActiveAlerts`, `markAlertFired`,
`markAlertRearmed`, `touchAlerts`, and `listDigestRecipients`,
`listDigestWatchlist`, `recordDigestSent` — are deliberately **not** scoped to a
request: they run in-process with no user in context. Scoping the poller's by
mistake would stop every alert from ever firing, and its own `catch` would
swallow the error.

**Revocation.** A signature alone cannot be revoked, which is inherent to
stateless JWT rather than a bug — but the consequence is real, so it is closed
here. `users.token_version` starts at 0 and is signed into every token as `ver`;
the hook compares it against the stored value on each request, and
`POST /auth/logout-all` increments it. Every token signed before that call stops
verifying, immediately, even though its signature and `exp` are still fine. A
deleted account reads back as no row at all and also fails closed.

The price is one primary-key `SELECT` per authenticated request — the round trip
stateless verification exists to avoid. At this scale that is the right trade;
at a larger one you would cache the version, or move to refresh tokens with a
session table and a much shorter access-token TTL.

Two ordering notes: the hook is `onRequest`, so it runs **before** schema
validation — an authenticated but malformed request still costs the version
lookup. And tokens issued before this mechanism existed carry no `ver` claim, so
they fail the comparison and are all invalidated, which is the desired outcome.

### ✅ Password reset

The flow is built so that it cannot be used to find out who has an account, to
take one over, or to flood an inbox:

- **No enumeration.** `forgot-password` answers 202 with the same body for every
  address, and answers *before* the lookup runs: finding the user, storing the
  token and talking to SMTP happen after the reply, so response time does not
  depend on whether the address exists. `reset-password` gives one 400 for every
  kind of bad token.
- **Tokens are useless at rest.** A token is `<userId>.<32 random bytes>`. Redis
  holds only the SHA-256 of the secret, under `password-reset:<userId>`, with the
  TTL as the expiry, so a Redis dump cannot be replayed. A 256-bit secret needs
  no slow hash.
- **Single use, latest only.** Redeeming is one Lua script that deletes the key
  only if the digest matches, so two racing requests cannot both win and a
  wrong guess does not burn the real token. One key per user means a new
  request overwrites the previous token.
- **The reset revokes sessions.** The new hash and the `token_version` bump are
  one `UPDATE`, so tokens held by whoever knew the old password die with it.
  The new password is hashed only after the token checks out, so bad tokens do
  not buy scrypt time.
- **Rate limited.** Fixed windows in Redis (`src/lib/rateLimit.ts`): per IP on
  both routes, and per address on `forgot-password`, keyed on a digest so the
  address is not stored. Both routes fail closed with 503 when Redis is down.
- **The link keeps the token out of logs.** With `PASSWORD_RESET_URL`, the token
  travels in the URL fragment, which the browser never sends to a server or in
  a `Referer`.

**Residual risks worth knowing:** the per-address limit also means anyone can
use up an address's reset e-mails for a window (`PASSWORD_RESET_MAX_PER_EMAIL`
trades spam protection against that). Behind a reverse proxy every request
shares the proxy's IP until `TRUST_PROXY=true`, and setting it without a proxy
lets clients pick their own IP. `/auth/login` itself is not rate limited yet;
`hitRateLimit()` is the piece to reuse for it.

### ⚠️ Robustness: database errors reach the client verbatim

No handler wraps its queries and there is no `setErrorHandler`, so a `pg` failure
surfaces through Fastify's default handler with the driver's message and
SQLSTATE — e.g. `POST /alerts` with `targetPrice: -1` returns
`{"statusCode":500,"code":"23514","message":"... violates check constraint
\"alerts_target_price_check\""}`, leaking table and constraint names. Row data,
query text and stack traces are *not* included, and `/docs` already publishes the
schema, so the confidentiality impact is negligible — this is a consistency and
UX gap, not an exploit. `src/routes/quotes.ts` already shows the pattern: log the
real error, return a generic one. A single `app.setErrorHandler` covers every
route, and `exclusiveMinimum: 0` on `targetPrice` would turn that particular 500
into a clean 400.

### ✅ What is solid

Every SQL statement is parameterized (`$n` throughout `src/repositories/`,
including the `UNNEST($1::bigint[])` bulk update) — no injection path. Nothing
builds SQL from request data; `COLUMNS` is a module constant. `SYMBOL_PATTERN` is
anchored and enforced on every route that takes a ticker, and `brapi.ts` also
applies `encodeURIComponent`. `src/db/migrate.ts` reads its schema path
from `import.meta.dirname`, never from input.

## 📜 Scripts

CI runs `typecheck`, `lint` and `test` on every push and pull request
(`.github/workflows/ci.yml`). `yarn install --immutable` fails the run if
`yarn.lock` was not committed alongside a dependency change.

```bash
yarn dev          # watch mode
yarn start        # run once
yarn test         # node --test over tests/**/*.test.ts
yarn test:watch
yarn typecheck    # tsc --noEmit (tsc never emits; Node runs the sources)
yarn lint
yarn lint:fix
```

Tests stub `fetch` and shadow the Redis and pg singletons' commands
(`tests/helpers/`), so nothing connects — the suite runs with no services up,
including the route tests, which drive the real Fastify instance through
`app.inject()`.

## 🐳 Make targets

| Target | What it does |
| --- | --- |
| `make up` | `docker compose up --build -d` |
| `make start` | Start existing containers |
| `make down` | `down -v` — removes the Postgres volume |
| `make nuke` | `down -v --rmi all --remove-orphans` |
| `make docker-install` / `docker-uninstall` | Install/remove Docker on apt or dnf systems |

## 🗂️ Project layout

```
src/
  server.ts          entrypoint: migrates, connects Redis, starts the poller
                     and the digest worker, listens, handles SIGTERM/SIGINT
  app.ts             buildApp() — Fastify instance, swagger, route registration
  config.ts          env parsing, all defaults
  routes/            quotes.ts, health.ts, auth.ts, alerts.ts, watchlist.ts,
                     notifications.ts, digest.ts
                     (+ JSON schemas for docs & serialization)
  plugins/
    authenticate.ts  onRequest hook + ownerOf(), the only source of an owner id
  services/
    brapi.ts         upstream client: retries, BrapiError, normalization
    quotes.ts        cache-aside orchestration over brapi.ts
    alerts.ts        evaluateAlert() — the pure trigger/rearm/noop rule
    auth.ts          scrypt password hashing (token signing is @fastify/jwt)
    notifier.ts      webhook delivery
    digest.ts        isDigestDue() + buildDigestEmail() — pure, no I/O
    mailer.ts        nodemailer transport, created on first send
    passwordReset.ts reset tokens in Redis: issue, consume, e-mail
  repositories/      alerts.ts, watchlists.ts, users.ts, notifications.ts,
                     digest.ts — all SQL lives here
  workers/
    alertPoller.ts   in-process interval, advisory-locked
    digestWorker.ts  summary emails, same pattern with its own lock
  redis/redis.ts     singleton client with reconnect strategy
  db/
    pool.ts          pg pool + pingDatabase()
    migrate.ts       waits for Postgres, applies schema.sql on boot
    schema.sql       idempotent DDL: users, watchlist, alerts, notifications,
                     digest_prices
  lib/symbols.ts     ticker regex, normalization
  lib/rateLimit.ts   fixed-window counter in Redis
  types/             brapi.ts, alerts.ts, notifications.ts, digest.ts
tests/
  services/          brapi, quotes, alerts, notifier, auth, digest, passwordReset
  repositories/      watchlists
  routes/            auth, watchlist, notifications, digest (through app.inject)
  workers/           alertPoller, digestWorker
  helpers/           fetch stub, fake redis, fake pg pool
docs/
  structure-map.png          architecture map shown at the top of this README
```

Note the split: **`repositories/` owns every SQL statement**, routes own
validation and status codes, and `services/` holds logic with no SQL in it.
`evaluateAlert()` and `isDigestDue()` are deliberately pure so the alert rule
and the summary schedule can be tested without a database or a market feed.

Response schemas in `src/routes/` double as Fastify's serializer — **a field
missing from the schema is silently dropped from the payload**, so adding a
field to `StockQuote` means adding it in `src/routes/quotes.ts` too.

## 📄 License

Released under the [MIT License](LICENSE). Copyright © 2026 Rian Barbosa.

You can use, copy, modify and distribute this code, including commercially, as
long as the copyright notice and the license text stay with it. It comes with no
warranty.
