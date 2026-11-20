# Concert Tickets Service

Monorepo: `apps/api` (NestJS), `apps/worker` (BullMQ), `apps/web` (Next.js 15, React 19), `apps/mailstub` (the spec's "почтовая заглушка": accepts mail over SMTP, lists it on a web page), `apps/migrate` (`prisma migrate deploy` + seed), `packages/db` (Prisma schema, migrations, client, raw-SQL wrappers), `packages/shared`, `tests/`.

## Run

```bash
cp .env.example .env
docker compose up --build
```

| URL                        | What                                 |
| -------------------------- | ------------------------------------ |
| http://localhost:8080      | web via nginx (round-robin to 2 api) |
| http://localhost:8080/docs | OpenAPI (Swagger)                    |
| http://localhost:8025      | mail stub UI (SMTP on :1025)         |
| :3001 / :3002              | api1 / api2 directly (tests)         |

`migrate` is a one-shot service (migrations + idempotent seed); `api`/`worker` wait for it to complete.
`nginx` uses plain round-robin with a shared `zone` and **no sticky sessions**, so cross-instance behaviour is real.
The mail stub (`mailstub` service) accepts SMTP on :1025 and shows received emails at http://localhost:8025 — no external mail service is used.
Smoke check: `bash scripts/smoke.sh`. If a local Postgres already owns 5432 set `POSTGRES_HOST_PORT` in `.env`.

## Checks

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test`
Integration tests (`tests/`) run against a real Postgres (fresh `tickets_it` database created per run);
override with `TEST_PG_ADMIN_URL` if needed.

## Rule: no deviations from the assignment

`docs/test-assignment-14.md` is authoritative for stack, versions, rules and deliverables. Ambiguities are resolved below ("Decisions") without contradicting its wording.

## Architecture decisions

- Statuses follow the spec exactly. Order: `holding, awaiting_payment, paid, expired, partially_refunded, refunded`. Event: `draft, on_sale, sold_out, rescheduled, cancelled, finished, paid_out`.
- `packages/shared` holds what `api`, `worker` and `web` must agree on: Zod input schemas, rule constants, `calcServiceFee` (5% half-up, min 20 ₴, on the pre-promo price), `calcCommission` (8%, rounded down = organizer's favour), `calcPayout` (sales − refunds − commission), promo discount (ticket price only, never the fee; fixed/percent; remainder to the first ticket), `calcRefund`, `Clock`/`OffsetClock` (tests shift time), plural helpers, and QR sign/verify (`@tickets/shared/qr`, server-only: HMAC-SHA256 over `ticketId.version`, base64url).
- Refund: >7 days before start = 100% of ticket price; 2–7 days inclusive = 50%; <2 days = not allowed; cancelled event = 100% incl. fee; rescheduled = 14 days full refund.

- PostgreSQL 16 is the source of truth for domain state and money; Redis only coordinates (queues, caches) and
  can be flushed without losing invariants.
- **Prisma + targeted raw SQL** (`packages/db`) — see "Database layer" below.
- Time: `app_now()` (SQL) = `clock_timestamp()` + `time_control.offset_ms`, so expiry is decided by the DB clock and
  can be advanced deterministically in tests (`ENABLE_TEST_CONTROLS`). No worker is needed for correctness of holds.

### Database layer: Prisma + raw SQL

PostgreSQL 16 stays the source of truth. Prisma 7 (`@prisma/adapter-pg`) is the schema, migration and query layer; raw SQL is used **only** where the database itself must enforce an invariant.

| Concern                                                                                                                                                                              | Owner                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tables, columns, enums, relations/FKs, plain / unique / GIN-trigram / partial indexes, generated client types                                                                        | `packages/db/prisma/schema.prisma` (mirrors the DB); CRUD and reads go through Prisma Client                                                                                   |
| Migration history and deploy                                                                                                                                                         | Prisma migrations `packages/db/prisma/migrations/*/migration.sql`, applied by `prisma migrate deploy` in the one-shot `migrate` container (Prisma takes its own advisory lock) |
| CHECK constraints, expression uniques (`lower(email)`), deferred ledger-balance trigger, append-only triggers, refund-cap trigger, `app_now()`                                       | Hand-written SQL **inside Prisma migrations** (Prisma cannot model these)                                                                                                      |
| Locks and atomic multi-row checks: `pg_advisory_xact_lock`, `FOR UPDATE`, `SKIP LOCKED` sweeps, `hold_seats()`, `hold_zone()`, `redeem_promo()`, `post_ledger()`, `next_event_seq()` | Postgres functions + typed wrappers in `packages/db/src/raw.ts` (`$queryRaw`). Raw SQL lives there or in a migration, never ad hoc in feature code                             |

Workflow: for modelled changes edit `schema.prisma` and run `prisma migrate dev --create-only`, then append any raw SQL (triggers, checks, functions) to the generated migration; for SQL-only changes create an empty migration with `--create-only`. `pnpm --filter @tickets/db drift` (CI runs it after `migrate deploy`) fails if `schema.prisma` and the migrated DB diverge. The generated client (`packages/db/src/generated`) is git-ignored and produced by `pnpm typecheck` / `pnpm build` (`prisma generate`). Money columns are `bigint` (Prisma `BigInt`). Dev volumes created before the Prisma switch must be recreated (`docker compose down -v`). pnpm needs `allowBuilds` for `prisma` / `@prisma/engines` (already set in `pnpm-workspace.yaml`); the Docker images install `openssl` so Prisma uses the right engine.

### Database invariants (stage 2)

| Invariant                          | Mechanism                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat sold once                     | partial unique index `seat_holds_active_uq (event_id, seat_id) WHERE status IN ('held','sold')`; `hold_seats()` expires lapsed holds (by `app_now()`) and inserts all seats with `ON CONFLICT DO NOTHING`; fewer rows than requested ⇒ `SEATS_UNAVAILABLE` and the whole call rolls back |
| Per-user limit                     | `pg_advisory_xact_lock(user,event)` then quota count (seat + dancefloor holds in `held`/`sold`) inside `hold_seats()`/`hold_zone()` ⇒ `PER_USER_LIMIT`                                                                                                                                   |
| Dancefloor capacity                | `hold_zone()` locks the `event_zone_counters` row (`FOR UPDATE`), sums active holds ⇒ `SEATS_UNAVAILABLE`                                                                                                                                                                                |
| Promo limit                        | `redeem_promo()`: `UPDATE … SET used = used+1 WHERE used < usage_limit`; `CHECK (used <= usage_limit)`; `release_promo()` returns the slot of expired unpaid orders                                                                                                                      |
| Refund ≤ paid                      | `refunds` BEFORE INSERT trigger bumps `orders.refunded_kop` (row lock serialises per order); `CHECK (refunded_kop <= paid_kop)` ⇒ `REFUND_EXCEEDS_PAID`; `refunds.idempotency_key` UNIQUE                                                                                                |
| Ledger balanced                    | `ledger_entries` deferred constraint trigger: `SUM(amount_kop)=0` per transaction (and no empty transactions); entries/transactions/`order_history` are append-only                                                                                                                      |
| Idempotent postings                | `UNIQUE (operation_type, operation_ref)` on `ledger_transactions`, used by `post_ledger()`                                                                                                                                                                                               |
| One queue entry per user/event     | `UNIQUE (event_id, user_id)`; order by `joined_seq` identity                                                                                                                                                                                                                             |
| Live-map ordering                  | `next_event_seq()` per-event gap-free sequence, `seat_events` keyed `(event_id, seq)`                                                                                                                                                                                                    |
| One active waitlist offer per seat | partial unique `waitlist_offer_seat_uq`                                                                                                                                                                                                                                                  |

Money is stored as integer kopecks (`bigint`); balances are never cached — they are `SUM(entries)` (`ledger_balances` view).

## API (stage 4: `apps/api`)

NestJS (REST + OpenAPI at `/docs`, Socket.IO). All routes are under `/api`, except the payment stub (`/stub-pay`) and the test-only controls (`/__test`, mounted only when `ENABLE_TEST_CONTROLS=true`).
`pnpm gen:client` exports `openapi.json` (repo root) and regenerates the typed web client (`apps/web/src/api/schema.d.ts`, `openapi-typescript` + `openapi-fetch`); CI runs it and fails on `git diff`.

**Auth and roles.** `POST /api/auth/login` returns a JWT (HS256, `JWT_SECRET`). A global guard requires a valid token on every route that is not explicitly `public`, and checks the role declared on the route (`buyer | organizer | controller | finance`); ownership is checked per resource in the handlers (someone else's order, event, venue is `404`, a role that may not call an endpoint is `403`). Socket.IO checks the token on the handshake and again on every subscribe. Seeded logins are listed below. Passwords are `scrypt$salt$hash` (`@tickets/shared/password`; the seed must use the same format).

**Errors.** Every failure, on every endpoint, has one shape: `{ "error": { "code", "message", "details?", "requestId" } }` (`x-request-id` header too). `code` is the `ErrorCode` enum from `packages/shared`, repeated in OpenAPI (`ErrorCode` + `ApiError` schemas, attached to all 4xx/5xx responses). Zod validation errors → `VALIDATION_ERROR` with `details.issues`; Postgres invariant violations are mapped to their domain code; anything unknown becomes a fixed `INTERNAL` ("Unexpected server error"), the cause is only in the server log.

**Idempotency.** `POST /holds`, `/payments`, `/orders/:id/refunds`, `/tickets/:id/transfer`, `/finance/refunds` require an `Idempotency-Key` header. State is in Postgres (`idempotency_keys`, key = scope(route+user[+resource]) + key + SHA-256 of the canonical body): the same key + body returns the stored result (also across both api instances), the same key with another body → `422 IDEMPOTENCY_KEY_REUSED`, a failed attempt releases the key, an attempt that died mid-flight is taken over after 60 s.

### Endpoints

| Area                       | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                       | `POST /auth/login`, `POST /auth/register` (buyer), `GET /me`                                                                                                                                                                                                                                                                                                                                                                                   |
| Events (any logged user)   | `GET /events` (q, city, category, dateFrom/To, priceMin/Max, hasSeats, sort, order, page, pageSize), `GET /events/:id`, `GET /events/:id/map` (columnar layout + live states + `seq`)                                                                                                                                                                                                                                                          |
| Buyer                      | `POST /holds`, `PATCH /orders/:id/seats`, `DELETE /orders/:id`, `POST /orders/:id/promo`, `GET /orders`, `GET /orders/:id`, `GET /orders/:id/history`, `POST /payments`, `POST /orders/:id/refunds`, `GET /tickets`, `POST /tickets/:id/transfer`                                                                                                                                                                                              |
| Queue / waitlist           | `POST/GET/DELETE /events/:id/queue`, `POST/GET/DELETE /events/:id/waitlist`                                                                                                                                                                                                                                                                                                                                                                    |
| Organizer                  | `POST/GET /venues` (layout JSON validated by Zod), `GET /venues/:id`, `POST /events`, `PUT /events/:id/prices` (zone/seat prices + blocked seats), `POST /events/:id/publish`, `PATCH /events/:id/settings`, `POST /events/:id/controllers`, `POST /events/:id/reschedule`, `POST /events/:id/cancel`, `GET /events/:id/cancel-progress`, `POST /promos`, `GET /events/:id/promos`, `GET /organizer/events`, `GET /organizer/events/:id/sales` |
| Controller                 | `POST /scan`, `GET /events/:id/gate-stats` (own event only)                                                                                                                                                                                                                                                                                                                                                                                    |
| Finance                    | `GET /finance/report?from&to`, `GET /finance/reconciliation`, `POST /finance/reconciliation/run`, `POST /finance/refunds`, `GET /finance/jobs`, `POST /finance/jobs/:id/retry`                                                                                                                                                                                                                                                                 |
| Provider (not user-facing) | `POST /payments/webhook` (HMAC), `/stub-pay/*`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Socket.IO                  | `subscribe`/`unsubscribe`/`resync`/`time:sync`/`cancel:subscribe` (acks), server events `seat:update`, `event:status`, `queue:update`, `waitlist:offer`, `order:update`, `cancel:progress`, `time:sync`                                                                                                                                                                                                                                        |

### How seat holds work

1. `POST /holds` creates an order and calls `hold_seats()` / `hold_zone()` in **one transaction**. Seats are rows of `seat_holds` guarded by the partial unique index `(event_id, seat_id) WHERE status IN ('held','sold')`; the function inserts all requested seats with `ON CONFLICT DO NOTHING` and raises `SEATS_UNAVAILABLE` unless every seat was inserted — the transaction rolls back, so a multi-seat order is held entirely or not at all. A per-(user,event) advisory lock makes the quota check (`PER_USER_LIMIT`) and the insert atomic across both api instances. Blocked seats (`event_blocked_seats`) and seats reserved by a waitlist offer for someone else (`SEAT_OFFERED`) are rejected inside the same function. Dancefloor tickets lock the `event_zone_counters` row and compare capacity with active holds and offers.
2. The 10-minute timer starts at the order's first seat (`orders.expires_at`, DB clock). Adding seats (`PATCH /orders/:id/seats`) copies the existing deadline to the new holds — the timer is never extended; removing the last seat releases the order.
3. **Expiry is decided by the server clock, not by a job**: `hold_seats()` first flips lapsed holds of the requested seats to `expired` using `app_now()`, the seat map ignores `held` rows whose `expires_at` has passed, and a payment that arrives late is handled by rule (below). The worker's sweep (`sweepOnce`) only tidies state (`orders → expired`, promo slot returned, live `free` events, waitlist offers, queue windows).
4. Every state change appends a row to `seat_events` with a gap-free per-event `seq` (`next_event_seq`) inside the same transaction, then is published to the Socket.IO room `event:{id}`.

### Payments, late payment, refunds

- `POST /payments` creates a `payments` row (`order → awaiting_payment`) and asks the stub for a payment keyed by our payment id (idempotent); the buyer is sent to `/stub-pay/pay/:ref` (Success / Fail / Close without response). Provider 429/503 are retried with backoff, then `503 SERVICE_UNAVAILABLE`.
- The stub reports through an **HMAC-SHA256-signed webhook** (`x-stub-signature` over the raw body) to `POST /api/payments/webhook`. A bad signature is `403 INVALID_SIGNATURE` and changes nothing. Each `(providerRef, eventType)` is claimed in `payment_webhook_events` in the same transaction as its effect, so duplicates are no-ops; `payment.failed` after `succeeded` is ignored; a dropped webhook is found by **reconciliation** (`reconcileProvider`: pending payments / `sent` refunds are compared with the provider's status API and applied through the same handlers; `POST /finance/reconciliation/run`, and the worker runs it every minute).
- **Late payment** (after the 10 minutes): if the seats are still free (or still ours) they are re-held in the same transaction and tickets are issued; if taken (or the event was cancelled) the order stays `expired`, the payment is booked and a full refund (price + service fee, kind `late_payment`) is registered automatically.
- Refund rows (`refunds`): the DB trigger caps `Σ refunds ≤ paid` under any concurrency (`REFUND_EXCEEDS_PAID`); user refunds follow `calcRefund`; the provider call is made by `dispatchRefund` (lease `locked_until`, exponential backoff on 429/503, `failed` + `failed_jobs` after 8 attempts, idempotent on the refund id); the ledger is posted when the provider confirms (webhook or reconciliation).
- **Payment stub** (`/stub-pay`, own tables `stub_*`): `PAYMENT_CHAOS=on` makes webhooks arrive twice, delayed up to 60 s, reordered (`failed` after `succeeded`) or never (`PAYMENT_CHAOS_SCENARIO` pins one behaviour, default random); every API request passes a **cluster-wide token bucket in Redis (Lua)**, 20 rps, over the limit `429 RATE_LIMITED`; in chaos mode every 10th request is `503`. If Redis is down each instance falls back to an in-process bucket at `rps / API_INSTANCES`. Every request is logged in `stub_request_log` (tests assert ≤ 20 per second).

### Ledger (double entry, kopecks; debit +, credit −)

| Operation                           | Entries (sum 0)                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment (`payment:<orderId>`)       | `provider_clearing +total`, `ticket_revenue_liability[org] −(subtotal−discount)`, `service_fee_revenue −fee`                                        |
| Refund (`refund:<refundId>`)        | `provider_clearing −amount`, `refunds[org] +(amount−fee part)`, `service_fee_revenue +fee part` (fee part ≠ 0 only for cancellation / late payment) |
| Payout settlement (worker, stage 5) | `ticket_revenue_liability[org] +sales`, `refunds[org] −refunds`, `commission_revenue −commission`, `organizer_payable[org] −payout`                 |
| Payout paid (worker, stage 5)       | `organizer_payable[org] +payout`, `provider_clearing −payout`                                                                                       |

Every posting is idempotent through `UNIQUE (operation_type, operation_ref)`; the deferred trigger rejects an unbalanced transaction at COMMIT.

### Virtual queue, waitlist, live updates

- **Queue**: Postgres is the truth (`queue_entries`: `joined_seq` identity, `UNIQUE(event,user)`; re-joining returns the same entry, so reload / second tab never give a second place). `admitNext` runs in a transaction under a per-event advisory lock, admits `waiting` rows by `joined_seq` with `FOR UPDATE SKIP LOCKED` while fewer than `QUEUE_MAX_SELECTORS` (200) are `admitted`, and expires admissions that did not start selecting within 5 minutes (server clock). It is called on join / leave / state read / sweep, from either api instance. A hold requires an admission whenever the queue is active (flag, latched, or contention > `QUEUE_TRIGGER_THRESHOLD` = 500). Redis/sockets only deliver `queue:update` to `user:{id}`; nothing is stored there, so `FLUSHALL` changes nothing.
- **Waitlist**: only for `sold_out` events (status maintained by the hold/pay/refund/expiry flows). When seats free up, `processWaitlist` (advisory-locked per event) gives the first waiting entry an offer for the exact seats (`waitlist_offers`, 30 min); other buyers get `409 SEAT_OFFERED` meanwhile (checked in `hold_seats`); a lapsed offer sends its entry to `left` and the next entry is offered; paying the held seats accepts the offer.
- **Live updates**: Socket.IO + `@socket.io/redis-adapter`, so an emit from api1 reaches clients connected to api2. `GET /events/:id/map` returns `seq` read _before_ the states; `subscribe` returns the current `seq`; after a reconnect `resync {eventId, sinceSeq}` returns the missed rows of `seat_events` (or `full: true` when too far behind). Clients ignore messages with `seq` ≤ the one they hold. Timers use `serverNow` (REST responses and `time:sync`), so a skewed client clock does not matter.

### Status transitions (who / from → to)

Order:

| From                          | To                   | Who / trigger                                                                  |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| — (new)                       | `holding`            | buyer `POST /holds`                                                            |
| `holding`                     | `awaiting_payment`   | buyer `POST /payments`                                                         |
| `awaiting_payment`            | `holding`            | system: `payment.failed` (and no other pending payment)                        |
| `holding`, `awaiting_payment` | `expired`            | system sweep / buyer release / last seat removed / organizer cancels the event |
| `holding`, `awaiting_payment` | `paid`               | system: `payment.succeeded` (webhook or reconciliation) before the deadline    |
| `expired`                     | `paid`               | system: late payment while the seats are still free                            |
| `expired`                     | `expired` (+ refund) | system: late payment while the seats are taken → automatic full refund         |
| `paid`                        | `partially_refunded` | buyer returns some tickets / finance partial manual refund                     |
| `paid`, `partially_refunded`  | `refunded`           | buyer returns the rest / finance refund of the full amount / event cancelled   |

Event:

| From                                 | To                        | Who / trigger                                           |
| ------------------------------------ | ------------------------- | ------------------------------------------------------- |
| `draft`                              | `on_sale`                 | organizer `publish` (needs prices)                      |
| `on_sale`, `rescheduled`             | `sold_out`                | system: nothing left (held + sold + blocked ≥ capacity) |
| `sold_out`                           | `on_sale` / `rescheduled` | system: a seat/hold freed                               |
| `on_sale`                            | `rescheduled`             | organizer `reschedule` (buyers e-mailed, 14-day window) |
| `on_sale`, `sold_out`, `rescheduled` | `cancelled`               | organizer `cancel` (sales/transfers stop at once)       |
| `on_sale`, `rescheduled`             | `finished`                | worker after the event (stage 5)                        |
| `finished`                           | `paid_out`                | worker payout, 3 days after the event (stage 5)         |

### Decisions made in stage 4

- Purchase endpoints are for the `buyer` role only; organizers/controllers/finance cannot hold or pay. Draft events are visible to their organizer only.
- Each `POST /holds` creates a new order (its own 10-minute clock); the per-person limit counts all active/paid seats of the user.
- A late payment that cannot be fulfilled keeps the order `expired` (it never completed) with `paid_kop` set so the refund cap holds; the refund row is `kind = late_payment`.
- Event cancellation: tickets become `cancelled`, every paid order gets one refund row (`cancel:<orderId>`, price + fee of its not-yet-refunded tickets, capped by paid − refunded) and ends `refunded`; sending the refunds to the provider is the worker's job (stage 5), progress is `cancel_batches` (`GET …/cancel-progress`, room `cancel:{id}`).
- Waitlist is per event (not per seat); offers reserve the exact freed seats (or dancefloor quantity). The queue's selector slot lives from admission until the user's order is paid / expired / released.
- `QUEUE_MAX_SELECTORS`, `PAYMENT_CHAOS*`, `API_INSTANCES`, `DB_POOL_SIZE` are env-configurable (`.env.example`).

### Test hooks (`ENABLE_TEST_CONTROLS=true` only)

`POST /__test/time/advance {ms}` / `time/reset` (shifts `time_control.offset_ms`, seen by every process), `POST /__test/sweep`, `POST /__test/stub/chaos {on, scenario}`, `GET /__test/stub/max-rps`.

## Background jobs (stage 5: `apps/worker`)

Postgres holds every obligation; Redis (BullMQ) is only the execution channel. Each worker replica runs a **DB-driven dispatcher** (`WORKER_TICK_MS`, default 2 s, plain in-process timer, not a Redis feature) that (1) runs `sweepOnce`, (2) marks ended events `finished`, (3) re-derives what is due from tables and enqueues it with a deterministic `jobId` (`refund-<id>-<attempt>`, `email-<id>-<attempt>`, `payout-<eventId>`). So after `FLUSHALL` or a Redis restart the next tick simply enqueues the work again; nothing was only in Redis.

| Job                                                    | When it is queued                                                                                                                 | Retries / backoff                                                                                                                                                                                | Duplicate protection                                                                                                                                                                                                        | Redis-loss recovery                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| hold / order expiry (`sweepOnce`, in the dispatcher)   | every tick: orders `holding/awaiting_payment` with `expires_at <= app_now()`                                                      | re-run every tick                                                                                                                                                                                | `FOR UPDATE SKIP LOCKED`, status guard `UPDATE ... WHERE status IN (...)`; correctness never depends on it (hold_seats uses the DB clock)                                                                                   | none needed (no Redis state)                  |
| payment deadline                                       | same sweep (a payment still pending after expiry is handled by the late-payment rule when it arrives, or by reconciliation)       | —                                                                                                                                                                                                | `payment_webhook_events (providerRef,type)`                                                                                                                                                                                 | none needed                                   |
| waitlist offer expiry / next offer                     | same sweep (`processWaitlist`, 30 min offers)                                                                                     | each tick                                                                                                                                                                                        | advisory lock per event, partial unique index per seat offer                                                                                                                                                                | none needed                                   |
| queue admission                                        | same sweep (`admitNext`, 5 min start window)                                                                                      | each tick                                                                                                                                                                                        | advisory lock per event, `SKIP LOCKED`, `joined_seq` order                                                                                                                                                                  | order lives in `queue_entries`                |
| `refund` (user, manual, late payment, **mass cancel**) | refund rows `pending` and not leased                                                                                              | 429 → short jittered retry, never counted; 503/network → exponential backoff (2^n s ≤ 60 s) up to 8 attempts, then `failed` + `failed_jobs` (visible to finance, `POST /finance/jobs/:id/retry`) | row lease `locked_until` (kill -9 safe: lease expires, dispatcher re-queues), provider call idempotent on the refund id (`stub_refunds.merchant_ref` unique), `refunds.idempotency_key` unique, ledger `UNIQUE(refund, id)` | refunds are rows; the dispatcher re-adds them |
| mass cancel progress                                   | after each refund job; `cancel_batches.done` advanced inside `completeRefund`                                                     | —                                                                                                                                                                                                | `completeRefund` is idempotent (status guard under row lock)                                                                                                                                                                | progress is in PG; sockets only display it    |
| `email` (+ PDF with QR via `pdfkit` + `qrcode`)        | `email_outbox` rows `pending` (tickets, refund, cancel, reschedule, transfer, waitlist offer)                                     | 5 attempts, backoff 2^n s, then `failed` + `failed_jobs`                                                                                                                                         | `dedup_key` unique per mail; lease; SMTP `Message-ID` derived from the key and dropped by the mail stub if repeated (covers a crash between SMTP delivery and marking the row sent)                                         | rows in PG                                    |
| `reconcile`                                            | every `RECONCILE_INTERVAL_MS` (60 s) by one replica (advisory lock)                                                               | next interval                                                                                                                                                                                    | goes through the same idempotent webhook handlers                                                                                                                                                                           | no Redis state                                |
| `payout`                                               | events `finished` and `COALESCE(ends_at, starts_at+3h) + 3 days <= app_now()`; postponed while a refund of the event is in flight | next tick                                                                                                                                                                                        | `UNIQUE(operation_type, operation_ref)` ledger postings, status guard `finished → paid_out` under event row lock                                                                                                            | derived from events                           |
| event `finished`                                       | tick: `COALESCE(ends_at, starts_at+3h) <= app_now()`                                                                              | —                                                                                                                                                                                                | status guard                                                                                                                                                                                                                | derived                                       |

Provider pacing for mass cancel: the refund queue has a **global BullMQ limiter** (one job per ~55 ms across all replicas) below the stub's strict 20 rps; the stub's own limiter answers 429 for anything above and the refund row backs off; live progress is `cancel:progress` on room `cancel:{eventId}` (published through `@socket.io/redis-emitter`, so api clients receive it) and `GET /events/:id/cancel-progress`.

Seeded credentials arrive with the seed (stage 7), see `plan.md`.

## Web (stage 6: `apps/web`)

Next.js 15 App Router + React 19, Tailwind, TanStack Query, React Hook Form + the shared zod schemas, `next-intl` (`uk` default, `en`, `pl`; all routes under `/[locale]/…`, `localePrefix: always`). Money is formatted with `Intl` (UAH, per-locale), dates in Europe/Kyiv, plurals are ICU messages. All API calls use the client generated from OpenAPI (`pnpm gen:client`); no hand-written response types.

| Route          | What it does                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`            | search; filters, sort and page live in the URL (reload/Back restore them)                                                                                                                 |
| `/login`       | login + registration (server-side field errors mapped onto form fields)                                                                                                                   |
| `/events/[id]` | event details, canvas seat map (virtualised, keyboard + aria-live), live updates over Socket.IO with `seq` catch-up and `resync`, dancefloor quantity, hold, queue waiting room, waitlist |
| `/orders/[id]` | server-clock countdown, promo form, remove seat, release, redirect to the payment stub, polling while the webhook is pending, history                                                     |
| `/tickets`     | QR codes, refund, transfer by email                                                                                                                                                       |
| `/organizer`   | venue JSON upload (with sample), events, price painter on the map, publish, settings (queue), promos, controllers, reschedule, cancel with live refund progress, sales dashboard          |
| `/controller`  | assigned events (`GET /api/controller/events`), gate scan with `BarcodeDetector` camera or manual input, counters, localised refusal reasons                                              |
| `/finance`     | report (period in URL), reconciliation + run, manual refund, failed/stuck jobs with retry                                                                                                 |

Role pages redirect to `/login` for other roles; the API enforces roles again on every endpoint and socket event.
