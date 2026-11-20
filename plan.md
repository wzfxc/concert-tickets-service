# Plan: Concert Tickets Service (test-assignment-14)

## MANDATORY RULE: NO DEVIATIONS FROM `docs/test-assignment-14.md`
The assignment is the single source of truth for stack, versions (Next.js 15, React 19, NestJS, PostgreSQL 16 + Prisma with raw SQL only for locks/constraints, Redis 7/BullMQ, Socket.IO), statuses, rules, endpoints, workflows and deliverables. No substitutions or workarounds that contradict it. Where the text is ambiguous, record the clarification under "Ambiguities & Decisions" (plan.md + README) and stay faithful to the wording. Before every stage, re-read the relevant spec section; an audit against the spec was done at the start of stage 3 (see Progress Log).

## Context
Greenfield repo (no commits; only `CLAUDE.md` and `docs/test-assignment-14.md`). Goal: implement the full assignment — NestJS API ×2 behind nginx, BullMQ worker, Next.js web, shared Zod/pricing package, Postgres double-entry ledger, payment + mail stubs, virtual queue, waitlist, mass cancellation, seed of 1M tickets, tests, CI, README. Toolchain found: Node 22.12, pnpm, Docker 29. No exploration agents needed (nothing to explore).

First action after approval: create `plan.md` in repo root (copy of the stages below with checkboxes + "Ambiguities & Decisions" and "Failures & Root Causes" sections) and keep it updated after every milestone. README mirrors decisions.

## Conventions
- pnpm workspaces + Turborepo-free simple scripts (`pnpm -r typecheck|lint|test|build`). TypeScript strict, ESLint ban on `any`/`@ts-ignore` (`ban-ts-comment` requires description).
- Money: `bigint` kopecks in DB, `number` (safe int) in API, never float. Time: a `Clock` service everywhere (`now()` from Postgres `clock_timestamp()` for holds; injectable/fake in tests).
- One commit per stage; CI (GitHub Actions) runs build, typecheck, lint, OpenAPI-client-diff check, vitest integration (service containers pg16/redis7), and Playwright e2e on every commit — CI file added in stage 1 and extended each stage.
- Errors: single `{ error: { code, message, details?, requestId } }` format via global filter; codes enumerated in OpenAPI (`ErrorCode` enum + shared `ApiError` schema on every route). Unknown exceptions mapped to coded 500 `INTERNAL` (never raw).

## Stages (each ends with typecheck + lint + client regen + tests + commit)

### 0. plan.md + repo skeleton + CI
- [x] root `package.json`, `pnpm-workspace.yaml`, tsconfig base, eslint, prettier, `.gitignore`, `.env.example`, GH Actions skeleton.

### 1. Infrastructure (docker compose)
- [x] `postgres:16`, `redis:7`, `api` ×2 (`api1`,`api2`), `nginx` (round-robin, WebSocket upgrade, no sticky sessions so cross-instance is real), `worker` (scalable), `web`, `mailpit`-style mail stub (own tiny SMTP server + web page — external SMTP forbidden; implement `apps/mailstub` with `smtp-server` + `mailparser`, UI page listing mails), one-shot `migrate` + `seed` service (api waits on it).
- [x] Dockerfiles (multi-stage), healthchecks; `cp .env.example .env && docker compose up --build` works with no manual steps.

### 2. DB schema + ledger (Prisma + raw SQL migrations)
Tables: users(role: buyer|organizer|controller|finance), venues(layout JSON), zones, seats(id, zone, row, number; dancefloor zones have capacity), events(status enum, sales_start, per_user_limit, organizer_id, rescheduled_at), event_zone_prices, event_seat_state, orders(status enum, expires_at, idempotency), order_items, tickets(qr_version, status), promo_codes(+ usages), idempotency_keys(key, scope, request_hash, response), order_history(append-only), payments, refunds, ledger_accounts, ledger_entries(+ transaction id), waitlist_entries/offers, queue_entries, entrance_scans, jobs_audit (failed/stuck view), outbox.
Key DB-enforced invariants:
- [x] **Seat sold once**: `seat_holds`/`event_seats` with partial unique index `(event_id, seat_id) WHERE active`; hold uses `INSERT ... ON CONFLICT DO NOTHING` for all seats in one tx → all-or-nothing; expired holds are treated as free by comparing `expires_at > clock_timestamp()` in the same statement (server-clock expiry independent of worker).
- [x] Per-user limit: `pg_advisory_xact_lock(hash(user,event))` then count; dancefloor capacity: `SELECT ... FOR UPDATE` on zone-counter row; promo limit: atomic `UPDATE promo SET used=used+1 WHERE used<limit RETURNING`.
- [x] Ledger: `ledger_transactions` + `ledger_entries(amount bigint, account)`; deferred constraint trigger enforcing SUM=0 per transaction; accounts: `buyer_funds_clearing`/`provider`, `ticket_revenue_liability` (per organizer), `service_fee_revenue`, `commission_revenue`, `organizer_payable`, `refunds`, `payouts`, `promo_discount_expense`. Unique `(operation_type, operation_ref)` makes every posting idempotent. Balances = sum of entries (reconciliation compares cached balance vs sum).
- [x] Refund ≤ paid: row lock on order + `CHECK` via trigger on cumulative refunded; unique refund idempotency key.
- [x] Indexes: events search (trigram on title, city, category, starts_at, partial `on_sale`), tickets(owner), orders(user, status), ledger_entries(account, created_at), hold expiry index.

### 3. packages/shared
- [x] Zod schemas for all inputs (hold ≤6, venue layout JSON, promo, refund, transfer, scan, search query, error envelope); constants (limits, TTLs, percentages, statuses, error codes); `calcServiceFee`, `calcCommission` (floor = organizer favour), `calcPayout`, `calcPromoDiscount`/`distributeDiscount`/`quoteTickets`, `calcRefund` (>7d 100%, 2–7d inclusive 50%, <2d refused, cancelled 100%+fee, rescheduled 14d full); `Clock`/`OffsetClock`; QR sign/verify (HMAC-SHA256 over `ticketId.version`, base64url, constant-time compare; server-only entry `@tickets/shared/qr` so web never bundles node:crypto); plural helpers (uk/pl/en). Vitest unit tests: 26 green incl. exact refund/fee/commission edges.

### 4. apps/api
- [x] Auth (HS256 JWT, global guard + per-route roles, per-resource ownership checks, `scrypt` password format shared with the seed), Zod validation interceptor → coded errors, global exception filter (`{error:{code,message,details?,requestId}}`, unknown → fixed `INTERNAL`), `Idempotency-Key` service (scope+key+body hash in Postgres; mismatch → 422 `IDEMPOTENCY_KEY_REUSED`; applied to hold, payment, refund, transfer, manual refund).
- [x] Modules: events search/detail/map, venues & layout upload (Zod), prices + blocked seats, publish/settings/controllers, holds (add/remove, 6 max, timer not extended, server-clock expiry), orders + history, promo, payments + HMAC webhook (dedup `(providerRef,type)`, out-of-order tolerant), late-payment rule, refunds (user/manual/late/cancellation, provider dispatch with lease + backoff), reconciliation (provider status API), transfer (QR version rotation), scan (atomic admission, refusal reasons, counters), waitlist, queue, organizer reschedule/cancel/progress/promos/sales, finance report/reconciliation/manual refund/jobs+retry.
- [x] **Payment stub** (`/stub-pay`): page (Success/Fail/Close), signed webhooks, `PAYMENT_CHAOS` (dup/≤60 s delay/reorder/drop), Redis Lua token bucket 20 rps (+ in-process fallback), 429 over limit, 503 every 10th in chaos, refund API, status API, request log.
- [x] Socket.IO: Redis adapter, auth on handshake, `user:{id}` rooms joined server-side only, `event:{id}` with `subscribe`/`resync(sinceSeq)` from `seat_events` (monotonic per-event `seq` in Postgres), `cancel:{id}` (organizer-owner only), `time:sync`.
- [x] Virtual queue in Postgres (`joined_seq`, unique(user,event), advisory-locked admission with SKIP LOCKED, 5-min start window, selector limit from env) — Redis only notifies.
- [x] OpenAPI at `/docs`, `openapi.json` export (`pnpm gen:client`: `openapi-typescript` + `openapi-fetch` in `apps/web/src/api`), CI fails on diff; deterministic (verified by running twice).
- [x] Tests (Vitest, real PG+Redis, two api processes): `tests/integration/api-flow.test.ts` (16) + `payment-stub.test.ts` (4) — error format, full purchase→transfer→scan→refund + ledger, concurrent holds/limit/dancefloor/promo, late payment (both branches), webhook dup/bad-signature/out-of-order/dropped→reconcile, concurrent refunds, one ticket two gates, permissions, cross-instance socket <1 s + resync, queue order/limit/5-min window, waitlist offers, cancel registration + repeat, stub 429/503/20 rps/refund cap.
- Not in stage 4 (by plan): refund dispatch for mass cancel, sweeps on a timer, payouts, `finished` transition, emails/PDF → stage 5 worker (the domain functions `sweepOnce`, `dispatchRefund`, `reconcileProvider` already exist in `apps/api/src/domain` and will be moved/shared). Seed + credentials → stage 7.

### 5. apps/worker (BullMQ)
- [x] Domain logic shared via new `packages/domain` (moved from `apps/api/src/domain`): sweeps, refund dispatch, webhook handlers, reconciliation.
- [x] Queues `refund`, `email`, `payout` (BullMQ, deterministic jobIds, attempts + exponential backoff, failures → `failed_jobs`); DB-driven dispatcher loop (sweep: hold/order expiry, payment deadline, waitlist offers, queue admission; finish events; reconcile every minute; enqueue due refunds/emails/payouts) — Redis loss loses nothing.
- [x] Mass cancel: refund rows leased in PG, global BullMQ limiter below the stub's 20 rps, 429 never counted as failure, progress through `cancel_batches` + `cancel:progress` via redis-emitter; kill -9 safe.
- [x] Emails via SMTP to the mail stub (nodemailer), PDF with signed QR (`pdfkit` + `qrcode`), Message-ID dedup in the mail stub; payout (settlement + cash out postings).
- [x] Tests `tests/integration/worker.test.ts`: tickets mail with PDF once; expiry by worker after FLUSHALL; payout = sales − refunds − commission; mass cancel (14 orders) with chaos 503/dup webhooks + kill -9 of a replica + FLUSHALL → each order refunded once, one ledger tx, one stub refund, one mail, ≤ 20 rps, repeat cancel no-op.
- Failure notes: 8 concurrent refund calls hit the strict 50 ms limiter and burned attempts → refund queue paced by a global limiter and 429 no longer consumes attempts (root cause: concurrency vs strict limiter). Security review: stub page HTML-escapes values and `returnUrl` is restricted to same-site relative paths; waitlist join validates zone/qty and an unserviceable entry no longer blocks the ones behind it.

### 6. apps/web
- [x] Next.js 15 App Router, React 19, Tailwind, TanStack Query, RHF + zod resolver, next-intl (`uk` default, `en`, `pl`), `Intl` money/date, ICU plural messages.
- [x] Pages: search (filters/sort/page in URL), event/hall map (canvas/SVG virtualized rendering for 10k seats, keyboard navigation roving tabindex, live updates via socket with seq catch-up), checkout (timer from server offset, promo, stub payment redirect), my tickets (QR, return, transfer), waitlist, queue waiting room, organizer (venue upload+viewer, price painter, events, promos, sales dashboards, cancel/reschedule with live progress), controller (camera via `BarcodeDetector` w/ manual fallback, counters), finance (report with period in URL, reconciliation, manual refund, jobs), mail stub UI link. (stage 6 done: all pages under `apps/web/app/[locale]/`; added `GET /api/controller/events`; OpenAPI now declares path params; e2e verification in stage 8)

### 7. Seed
- [x] Idempotent script using `COPY`/`generate_series` SQL (not row-by-row): 50k users, 30 venues (one 10k seats w/ dancefloor), 2000 events (some `sales_start = now()+10min` relative at seed time), 1M tickets with matching orders and ledger postings (reconciliation must be zero). Role logins documented. Runs automatically in `seed` container; skip if already seeded.

### 8. Tests (Vitest on real PG/Redis via compose/service containers; Playwright)
One suite per invariant 1–15: 200 concurrent holds; limit 10×2→3 pass; promo 150/100; late payment both branches; chaos webhooks (dup/reorder/bad sig/missing→reconcile); concurrent refunds; kill -9 worker (child process) mid-cancel; 3 workers; mass cancel 10k with chaos & repeat; FLUSHALL during ops; queue fairness over two api instances (1000 users); waitlist; transfer/QR/double-gate scan; permissions matrix (REST + socket); error format. Time faking: `Clock` + `TIME_OFFSET`/test-only advance endpoint guarded by `NODE_ENV=test`.
- [ ] Playwright e2e: two browsers/two api instances; hold expiry; queue limit 1; full purchase→transfer→scan flow. Perf checks (<200ms search/map, <500ms reports) as tests on the seed.

### 9. Finalize
- [ ] README: run/tests, hold mechanics, ledger scheme, job list (triggers/retries/dedup/Redis-loss recovery), queue + mass cancel design, event delivery across 2 api, status tables & transitions (who/from→to), indexes/constraints, decisions, seeded credentials. Final acceptance run of table rows 1–20; update plan.md.

## Initial Ambiguities & Decisions (to be mirrored in plan.md/README)
- Event stub `rescheduled` → returns to sellable? Decision: `rescheduled` remains purchasable; refunds window = 14 days from `rescheduled_at`.
- Service fee per ticket: max(5% of ticket price after… promo? ) — decision: 5% of **original** list price (promo does not apply to fee), min 2000 kop; commission 8% of price paid for tickets (after promo), rounded in organizer's favour (floor).
- Partial refund then fee: only ticket price refunded (fee non-refundable) except cancellation.
- "Одновременно претендует > 500" = count of active queue entries + active selectors; queue enabled when ≥500 and `queue_enabled` flag per event.
- Payout runs 3 days after event end; payout = sales − refunds − commission.
- Stub rate limiter is cluster-wide (Redis Lua + PG fallback).
- Package manager pnpm; mail stub custom-built (no external image) — actually allowed to use an image like Mailpit if it's in compose? Spec forbids external *services*, not a local container; decision: custom tiny stub to stay self-contained.

## Execution mode
After approval: first write `plan.md` (this document incl. matrix below), then proceed through stages 0→9 continuously. After each stage: tick checkboxes, log failures (cause / root cause / fix status) in plan.md, run checks, commit (one commit per stage, CI green). Do not stop between stages.

## Cross-cutting acceptance mechanisms

### Seeded credentials (documented in README; password for all = `Passw0rd!` from `SEED_PASSWORD` env)
| Role | Login | Notes |
|-|-|-|
| Buyer | `buyer1@example.com` … `buyer50000@example.com` (50 000 users incl. staff) | `buyer1` has paid orders/tickets; `buyer2`/`buyer3` empty (for queue, transfer, waitlist) |
| Organizer | `organizer1@example.com`, `organizer2@example.com` | org1 owns the 10k-seat venue events; org2 used for cross-tenant denial tests |
| Controller | `controller1@example.com` (assigned to org1 event E1), `controller2@example.com` (event E2) | |
| Financier | `finance1@example.com` | |
Fixed IDs/known events seeded: `E-BIG` (10k-seat hall w/ dancefloor, on_sale), `E-QUEUE` (sales start = seed time + 10 min, queue enabled), `E-SOLDOUT` (for waitlist), `E-CANCEL` (≥10 000 paid orders, for mass cancel).

### Deterministic time control
- `Clock` interface in `packages/shared` (`now(): Date`) with `SystemClock` and `OffsetClock`; every service/worker/job calls it — no bare `Date.now()` (ESLint `no-restricted-properties`). SQL-side expiry uses `app_now()` = `clock_timestamp() + current_setting('app.time_offset')::interval`-equivalent: a single-row table `time_control(offset_ms)` read by `app_now()` SQL function, so DB and Node agree.
- Test-only control: `POST /__test/time/advance {ms}` and `/__test/time/reset`, mounted only when `ENABLE_TEST_CONTROLS=true` (never in prod compose; on in CI/test profile), writes `time_control` + publishes to Redis for cache invalidation (PG remains authoritative, so FLUSHALL-safe). BullMQ delays are not relied on: sweeper re-derives due work from PG using `app_now()`, so advancing time makes holds/offers/deadlines/payouts due immediately.
- Covers: 10-min hold, 5-min queue admission timeout, 30-min waitlist offer, 2/7/14-day refund windows (event dates shifted via advance), 3-day payout, 1-hour transfer cutoff, "payment at 11 minutes".
- Client timer: server sends `serverNow` with every hold response + socket `time:sync`; client uses offset = serverNow − localNow (test with browser clock skewed −5 min via Playwright `page.clock`).

### Performance benchmarks (asserted in Vitest `perf` project against the full seed; p95 of 30 warm requests through nginx)
- Event search (text+city+date+category+price+has_seats, sorted, paged): **< 200 ms**.
- Hall map state for 10 000-seat event (layout + live statuses, one request): **< 200 ms**; payload ≤ ~150 KB gzip (compact status bitmap/arrays by zone).
- Organizer sales report (90 days: hourly, per zone, fill rate, queue→payment funnel): **< 500 ms**; Financier 90-day report (sales, fees, commission, refunds, payouts, per organizer): **< 500 ms**.
- Support: `EXPLAIN` guarded indexes, materialized hourly rollup tables (`sales_hourly`, `ledger_daily`) maintained on write/by worker; perf test fails if budget exceeded.
- Web: Playwright trace check — 10k map scroll with no frame >50 ms long task (Chromium CDP), keyboard select works.

## Acceptance Criteria & Verification Matrix (rows = assignment "Приёмка" 1–20)
Test locations: `tests/integration/*.test.ts` (Vitest, real PG16+Redis7, 2 api + worker processes started by global setup), `tests/e2e/*.spec.ts` (Playwright), `tests/perf/*`, `scripts/smoke.sh`. Invariant # = assignment "Инварианты".

| # | Preconditions / roles / chaos | Pass/fail assertions | Covered by |
|-|-|-|-|
| 1 | Clean checkout, `cp .env.example .env && docker compose up --build`, no extra steps | All services healthy ≤ N min; migrations+seed done (counts: 50k users, 30 venues, 2000 events, 1M tickets); `/docs` 200; web 200 via nginx; mail stub page 200 | `scripts/smoke.sh` in CI job `compose-smoke` |
| 2 | Any commit | build, typecheck, lint, `pnpm gen:client && git diff --exit-code`, vitest, playwright all green; no `any`/`@ts-ignore` without comment (lint rule) | GH Actions on every commit |
| 3 | Buyer A on api1, buyer B on api2 (nginx bypassed; direct ports), same event map | A selects seat → B's DOM shows seat `held` < 1000 ms without reload (measure timestamp); seq numbers monotonic; reconnect catches up missed events | e2e `live-map.spec.ts`; integration `socket-cross-instance.test.ts` (inv.13) |
| 4 | 1 event, 4 seats, 200 buyers, parallel POST /holds half to api1, half api2 | exactly 1 `201`; 199 `409 SEATS_UNAVAILABLE`; multi-seat holds all-or-nothing (no partial rows); DB unique index never violated | `holds-concurrency.test.ts` (inv.1) |
| 5 | Buyer with limit 6, 10 parallel holds×2 seats via both apis | exactly 3 succeed (6 tickets), 7 get `409 PER_USER_LIMIT`; count incl. paid orders; dancefloor capacity variant (capacity 10, 15×1 parallel → 10) | `limits-concurrency.test.ts` (inv.2) |
| 6 | Promo limit 100, 150 buyers parallel apply | exactly 100 succeed, 50 `409 PROMO_EXHAUSTED`; after advancing time 10 min unpaid ones expire → `used` decreases by their number; paid ones don't | `promo-concurrency.test.ts` (inv.2) |
| 7 | (a) hold, advance 11 min with worker stopped, seats free, send success webhook; (b) same but another buyer took the seats | (a) order `paid`, tickets issued, ledger balanced; (b) order `expired`→auto full refund (price+fee), no tickets, refund webhook processed, ledger sums 0; seats not freed by worker lag (inv.3: hold invalid by server clock without worker) | `late-payment.test.ts` |
| 8 | `PAYMENT_CHAOS=on`: duplicate, delayed ≤60s (time-faked), reordered (`failed` after `succeeded`), dropped, bad signature | each payment/refund posted once (1 ledger tx per op ref); `failed` after `succeeded` ignored; bad HMAC → 401 & no state change; dropped webhook found by reconcile job (≤1 min fake time) and applied; refund webhooks likewise | `payment-webhooks-chaos.test.ts` (inv.5) |
| 9 | Paid order 10 000 kop; two+ parallel full/partial refund requests (different keys) through both apis | sum(refunds) ≤ paid; losing request `409 REFUND_EXCEEDS_PAID`; same key → same response (inv.6) | `refund-concurrency.test.ts` (inv.4,6) |
| 10 | Mass cancel in progress, 3 worker replicas; `kill -9` one/all workers mid-run, restart | cancel completes; every order has exactly 1 refund row & 1 refund ledger tx; no duplicate emails (`email_outbox` unique); no duplicate stub refunds | `worker-kill9.test.ts` (inv.7,8) |
| 11 | E-CANCEL with 10 000 paid orders, chaos on (429/503), cancel twice (second call same/other key) | sales & transfers blocked immediately (hold/pay/transfer → `409 EVENT_CANCELLED` right after call returns); all 10 000 refunded once; stub observed max ≤20 req/s over any 1 s window (stub keeps log); progress endpoint+socket monotonically reach 10 000/10 000; second cancel no-op | `mass-cancel.test.ts` (large; nightly + CI w/ scaled-down 10k ok) |
| 12 | Active holds + running mass cancel; `redis-cli FLUSHALL`; restart worker | holds still expire at 10 min (fake time); payment deadlines/waitlist offers fire; cancel resumes from `cancel_progress` in PG; queue order preserved (from PG `joined_seq`); emails once; no dups | `redis-flush.test.ts` (inv.9) |
| 13 | E-QUEUE; 1000 users join through both apis; admit limit 200; second tab/reload per user | positions strictly by join order; max concurrent selectors ≤ 200 sampled continuously; reload keeps same position; 2nd tab/join returns the same entry (unique(user,event)); idle admitted >5 min (fake time) → slot passes on; Redis flush keeps order; queue position only to owner socket | `queue-fairness.test.ts` (inv.10); e2e `queue.spec.ts` with limit 1 |
| 14 | Sold-out event, waitlist users W1,W2; buyer returns ticket | W1 gets offer (30 min), W2 nothing, seat unsellable to others meanwhile (`409 SEAT_OFFERED`); +30 min fake → W1 expires, W2 gets offer; W1 pays → ticket | `waitlist.test.ts` (inv.11) |
| 15 | Buyer transfers ticket (≥1 h before start) to buyer2 by email; controller scans both QRs; transfer <1 h → refused | new QR valid (`200 ADMIT`), old QR `403 TICKET_TRANSFERRED`; tampered QR → `INVALID_SIGNATURE`; returned ticket → `TICKET_REFUNDED`; wrong event → `OTHER_EVENT`; transfer idempotent | `transfer-qr.test.ts`; e2e `purchase-flow.spec.ts` (select→promo→pay stub→ticket→transfer→scan) |
| 16 | One ticket scanned simultaneously at gates 1 & 2 (50 parallel) | exactly one `ADMIT`; others `ALREADY_USED` w/ time+gate | `scan-concurrency.test.ts` (inv.12) |
| 17 | Users: buyer1/2, org1/2, controller1/2, finance1; direct REST + socket subscribe/emit | permission matrix generated from the OpenAPI route list: each endpoint × role → expected 200/403/404; buyer can't read others' orders/tickets; org2 can't see/modify org1 events, buyer PII hidden for organizer; controller only own event, no money endpoints; finance can't mutate events; sockets: join foreign `user:`/`event:` private rooms rejected, no foreign queue/notification payloads | `permissions-matrix.test.ts`, `socket-auth.test.ts` (inv.14); error format test (inv.15) |
| 18 | After all above on same DB | `GET /finance/reconciliation`: global sum of entries = 0; every account balance = sum of its entries; payout = sales − refunds − commission for each paid_out event; discrepancy list empty (provider status vs. ours) | `reconciliation.test.ts` run last + part of e2e teardown |
| 19 | Seeded DB; browser | search, map (10k), reports meet budgets above; URL carries filters/sort/page/period; reload & Back restore state | `tests/perf/*.perf.ts`; e2e `url-state.spec.ts` |
| 20 | Locales uk/en/pl | `1 234,50 ₴` formatting per locale (uk/pl: NBSP thousands, comma decimal; en: `₴1,234.50`—documented), localized dates/times in event time zone (`Europe/Kyiv`), plurals uk (1/2-4/5+), pl, en; README sections present & matches behavior (checklist script greps required headings) | web unit tests (Vitest) + e2e `i18n.spec.ts`; `scripts/check-readme.mjs` |

Additional invariants covered beyond the table: inv.6 idempotency (same key → same result, other body → `422 IDEMPOTENCY_KEY_REUSED`, per endpoint: hold, pay, refund, transfer), inv.7 retries/backoff + failed jobs visible to finance & safe retry (`jobs-retry.test.ts`), inv.15 error shape (`errors.test.ts` fuzzes bad input on every route → never 500 `Internal server error`).

## Ambiguities & Decisions (refined; mirrored in plan.md/README as they evolve)
1. `rescheduled` stays purchasable; full-refund window = 14 days from `rescheduled_at` regardless of time left; ordinary rules apply afterwards.
2. Service fee = max(5% of list price per ticket, 2000 kop), rounded half-up, computed on price *before* promo; promo reduces only ticket price (fixed discount distributed proportionally, remainder to first ticket; never below 0).
3. Commission = 8% of price actually paid for tickets (after promo), `floor` (organizer-favourable); deducted at payout.
4. Ordinary refund returns price paid for that ticket (after promo share) — 100% / 50% by window, fee never refunded except cancellation (100% incl. fee) and late-payment auto-refund (full incl. fee). Promo usage is not restored on refund.
5. Refund windows measured to event `starts_at`, literally per spec: **more than 7 days** before = 100% of ticket price (no fee); **from 2 to 7 days inclusive** = 50%; **less than 2 days** = refused (`REFUND_WINDOW_CLOSED`). Exactly 7×24h is therefore 50%, exactly 2×24h is 50%; edges tested.
6. "Contending >500" = users in queue + active selectors for an event at sales moment; queue mode is latched per event once triggered (and always on for events flagged `queue_enabled`) to avoid flapping.
7. Queue timers: admitted slot valid 5 min of server time or until a hold is created; selector slot freed on hold creation? Decision: slot counts while the user is on the selection page *or* holds seats not yet paid; released on pay/expire/leave.
8. Hold 10 min measured from creation of the order's first seat; seat removal doesn't reset; removing last seat ends the hold.
9. Per-person limit counts seats in `holding|awaiting_payment|paid|partially_refunded` orders; refunded/expired free quota.
10. Waitlist: queue per event (not per seat/zone); when a seat frees, first matching entry gets the offer reserving that exact seat(s); one active offer per seat; dancefloor by quantity.
11. Payout: scheduled at `event.ends_at + 3d` (`starts_at + 3h` if no end), via `payout` job, once per event (unique(event_id)); ledger: organizer_payable → organizer_payout_paid, commission → revenue.
12. Money in API as integer kopecks (JSON numbers within 2^53; DB bigint); formatted only in the UI.
13. Stub provider is the same codebase but its own module + tables (`stub_payments`, `stub_refunds`) and talks to the app only over HTTP/webhooks, so reconciliation compares real divergence. Rate limit 20 rps cluster-wide via Redis Lua; Redis loss resets only the bucket (safe).
14. Test hooks (`/__test/*`, time advance) exist only with `ENABLE_TEST_CONTROLS=true`.
15. Mail stub (spec: "почтовая заглушка — принимает письма по SMTP и показывает их на странице") is the `mailstub` compose service (`apps/mailstub`): an SMTP server (port 1025) that stores received mails and a web page (port 8025) listing them (`/api/messages` JSON for tests). No external service; this directly fulfils the spec.
17. Statuses are exactly the spec lists. Order: `holding, awaiting_payment, paid, expired, partially_refunded, refunded` (a mass-cancelled order ends `refunded`; there is no `cancelled` order status). Event: `draft, on_sale, sold_out, rescheduled, cancelled, finished, paid_out` (`sold_out` is set/cleared by the hold/refund flow and still shows in search without "has seats").
16. Event time zone `Europe/Kyiv` for display; stored UTC.
(Record new ambiguities as discovered; failures logged as: **cause / root cause / fix status**.)

## Verification
Per stage: `pnpm -r typecheck && pnpm -r lint && pnpm gen:client && git diff --exit-code && pnpm -r test`; stage 1/8/9: `docker compose up --build` smoke + Playwright; finally walk the 20 acceptance checks and reconcile (sum of ledger = 0).

## Risks
- Scale (1M tickets seed time, 10k hall render): bulk SQL, virtualization/canvas.
- Largest effort is the test matrix; build testing harness (compose test profile, fake clock, kill-9 helper) early in stage 2–4.

## Failures & Root Causes
- **Local `next build` EPERM symlink (Next 15 standalone on Windows)** — cause: standalone tracing creates symlinks, forbidden in this shell. Root cause: environment. Fix status: FIXED — `output: standalone` only when `NEXT_STANDALONE=1` (set in `docker/web.Dockerfile`); no behaviour change in the image.
- **Lint: `next-env.d.ts` triple-slash and `process` undefined in `next.config.mjs`** — generated file ignored by ESLint; `import process from node:process`.
(none yet)

## Progress Log
- Stage 0: done (skeleton, CI skeleton, lint rules, shared pkg stub; checks green locally)
- Stage 1: done. `docker compose up --build` from clean `.env` → 8 services healthy; `scripts/smoke.sh` OK (web 200, /docs 200, mailstub 200, strict api1/api2 alternation). Apps are skeletons (health only): api = NestJS+Swagger, worker = pg/redis connectivity+/health, mailstub = real SMTP (1025) + UI (8025), migrate = SQL runner + idempotent seed marker, web = Next 16 standalone. Ports: nginx 8080, api1 3001, api2 3002, mail UI 8025.


- Stage 2b: DB layer switched to Prisma 7 + targeted raw SQL (see decision in Stage 1 decisions). `tests/integration/schema-invariants.test.ts` now uses Prisma Client + raw wrappers: 15/15 green on real PG16; `docker compose down -v && up --build` clean (migrate applies Prisma migration, seed OK, smoke OK, no Prisma warnings); typecheck/lint/format:check/build green.
- Stage 2: done. `0002_schema.sql` (all tables, enums, indexes, ledger triggers, `hold_seats`/`hold_zone`/`redeem_promo`/`release_promo`/`post_ledger`), `tests/integration/schema-invariants.test.ts` 15/15 green on real PG16 (200-buyer hold race, limit 10×2→3, dancefloor 15→10, promo 150→100, ledger unbalanced/idempotent/immutable, refund cap, seq monotonic, `app_now` expiry). README has the invariant table.

## Stage 1 decisions / ambiguities
- **Prisma + targeted raw SQL (supersedes the earlier "Prisma dropped" deviation; spec says "PostgreSQL 16 + Prisma, raw SQL where locks/constraints are needed").** `packages/db` owns `prisma/schema.prisma` (models, enums, relations, plain/partial/GIN indexes → typed client, snake_case columns mapped to camelCase), Prisma migrations (`prisma migrate deploy` in the `migrate` container) and the client factory (`@prisma/adapter-pg`). Raw SQL is used only where the DB must enforce invariants — CHECKs, expression uniques, deferred ledger-balance trigger, append-only/refund-cap triggers, `hold_seats()`/`hold_zone()`/`redeem_promo()`/`post_ledger()`, advisory locks, `FOR UPDATE`/`SKIP LOCKED` — written inside Prisma migrations and called via typed wrappers in `packages/db/src/raw.ts`. The initial migration (`20261120000000_init`) is the former 0001+0002 SQL verbatim, so no invariant changed; `pnpm --filter @tickets/db drift` (CI) proves `schema.prisma` == migrated DB (verified: empty diff). Division of responsibilities is documented in README "Database layer". Old `schema_migrations` runner removed; pre-Prisma dev volumes must be recreated.
- Next.js **15** (App Router) and React 19 as the spec requires (an earlier scaffold used Next 16 — corrected in the spec-alignment audit). TypeScript pinned to 5.9 and `@types/node` 22 in all packages (pnpm resolved TS 7 / types 26 by default).
- Images: one `docker/node.Dockerfile` parametrised by `APP` (pnpm `deploy --legacy` prod bundle) + `docker/web.Dockerfile` (Next standalone). Healthchecks use `node -e fetch(...)` (slim images have no curl).
- nginx needs `zone` in the upstream to get true round-robin across worker processes (found via smoke test, see failure log). No ip_hash/sticky.
- `/stub-pay` and `/socket.io` are already routed to api in nginx for later stages.

### Failure log (stage 1)
- **pnpm `ERR_PNPM_IGNORED_BUILDS` / "Ignored build scripts" warning for esbuild** — cause: pnpm 12 blocks dependency install scripts by default; `onlyBuiltDependencies: [esbuild]` in `pnpm-workspace.yaml` is not honoured by pnpm 12 (and msgpackr-extract/@scarf/scarf became blocked once bullmq/nest were added). Root cause: pnpm 12 policy key is `allowBuilds`. Fix status: FIXED — `allowBuilds: {esbuild: true, msgpackr-extract: true, "@scarf/scarf": false}`.
- **Prettier check not wired / failing** — cause: `format:check` script and `.prettierignore` did not exist; 12 files unformatted. Root cause: stage 0 only had a `format` (write) script. Fix status: FIXED — added `format:check`, `.prettierignore` (lockfile, CLAUDE.md, plan.md, docs, .claude), formatted, added to CI.
- **nginx round-robin skewed 9:1** — cause: per-worker upstream counters. Root cause: missing `zone` directive in `upstream`. Fix status: FIXED, smoke test asserts both instances serve requests.

### Failure log
- **Docker daemon not running** (`dockerDesktopLinuxEngine` pipe missing) — cause: Docker Desktop not started. Root cause: environment. Fix status: FIXED — started Docker Desktop (daemon 29.4.1 reachable).


### Stage 2 notes / failures
- **Local tests got `password authentication failed` on localhost:5432** — cause: a native Windows PostgreSQL (pid 6884) listens on 0.0.0.0:5432 and shadows the compose container. Root cause: environment port clash. Fix status: FIXED — compose host port is `POSTGRES_HOST_PORT` (default 5432; local `.env` uses 55432); tests honour `TEST_PG_ADMIN_URL`. The native instance was not touched.
- **Security review: health endpoint leaked raw dependency error text** — cause: `err.message` returned to client. Root cause: unfiltered error passthrough. Fix status: FIXED — logged server-side, client gets fixed `dependency unavailable`. (Stage 4's global error filter must keep this rule.)
- Schema decisions: hold state lives in `seat_holds`/`zone_holds` (status held|sold|released|expired) instead of a separate event_seat_state table; expiry applied lazily by `hold_seats` via `app_now()` (sweeper only tidies). Refund cap = `orders.refunded_kop` CHECK + BEFORE INSERT trigger on `refunds`. Per-user quota is computed from active holds, so refunded/expired free quota automatically.
### Stage 2b notes / failures
- **pnpm `ERR_PNPM_IGNORED_BUILDS` for prisma / @prisma/engines** — cause: pnpm 12 blocks install scripts. Root cause: not in `allowBuilds`. Fix status: FIXED (`prisma`, `@prisma/engines`, `@prisma/client` set to true).
- **Prisma in `node:22-slim`: "failed to detect libssl" warning, then "Can't write to @prisma/engines" as user `node`** — cause: image has no openssl, so engines were fetched for openssl-1.1.x at build and runtime tried to download 3.0.x. Root cause: openssl installed after/without being present at `pnpm install`. Fix status: FIXED — openssl installed in both `base` and `runtime` stages of `docker/node.Dockerfile`.
- **Existing dev DB (old runner, no `_prisma_migrations`) is not adoptable** — P3005 by design. Fix status: ACCEPTED (pre-release; recreate volume).
- Bash heredoc/backtick slips while editing README ran stray commands locally (no repo files changed); README reverted and re-edited with the edit tool.
- Open (low): vitest major versions differ between packages (2.x vs 5.x) — harmless; unify later.

## Spec-alignment audit (start of stage 3) — vs `docs/test-assignment-14.md`
Deviations found and fixed:
- **Next.js 16 → 15** in `apps/web` (spec: "Next.js 15 (App Router), React 19").
- **Event status `sold_out` was missing** from the DB enum/Prisma schema; **order status `cancelled` was extra** (spec lists exactly 6 order statuses). Fixed in the (still unreleased) init migration + `schema.prisma`.
- **Refund boundary** wrote "≥7 days = 100%"; spec says "больше 7 дней" → decision 5 corrected (exactly 7 days = 50%).
- Mail stub decision no longer reads as a deviation: it is the spec's required "почтовая заглушка" (SMTP in, web page out, inside compose).
- Verified OK: PG16 + Prisma (+ raw SQL for locks/constraints), Redis 7, api ×2 behind nginx, worker, web, packages/shared, compose services list (postgres, redis, api×2, nginx, worker, web, mailstub; migrations+seed in a one-shot container), `cp .env.example .env && docker compose up --build`, `POSTGRES_HOST_PORT` only remaps the host port (default 5432), service fee 5% min 20 ₴, commission 8% floor, hold 10 min, limit 6, queue 500/200/5 min, waitlist 30 min, payout +3 days.
- Extra repo dirs (`apps/migrate`, `apps/mailstub`, `tests`, `packages/db`) are additions required by the spec's compose/migration/test/Prisma lines, not contradictions.

- Stage 3: done (`packages/shared`, see checklist). Spec-alignment audit completed first (Next 15, sold_out status, refund boundary, mail stub wording, no-deviation rule in CLAUDE.md + plan.md).

## Stage 4 notes
### Decisions (new ambiguities, mirrored in README "Decisions made in stage 4")
18. Purchase endpoints are buyer-only; draft events visible to their organizer only; each `POST /holds` is its own order.
19. Late payment that cannot be fulfilled: order stays `expired` with `paid_kop` set (refund cap), refund `kind=late_payment` for price + fee.
20. Event cancel: tickets → `cancelled`, one `cancellation` refund per paid order (idempotent key `cancel:<orderId>`), orders end `refunded`; provider sends are the worker's job. Refunds already granted earlier are not repaid.
21. Domain logic shared by api and worker lives in `apps/api/src/domain` as plain functions over `Db`; stage 5 extracts it to a package both import.
22. Ledger: payouts are two postings (settlement, then cash out) — see README table. `promo_discount_expense`/`payouts` accounts stay unused (discount is a reduced price).
23. `BEFORE INSERT` triggers fire before `ON CONFLICT` detection, so refund inserts use an explicit existence check under the order row lock instead of `ON CONFLICT DO NOTHING` (otherwise `refunded_kop` would be bumped for a skipped row).
24. Stub limiter: token bucket capacity 1 / refill 20 per second (so no half-open 1 s window admits more than 20); Redis loss → per-instance bucket at rps/`API_INSTANCES`.

### Failures & root causes (stage 4)
- **`Prisma` namespace unusable as a value from `@tickets/db`** — cause: `client.ts` had `export type { Prisma }`, which shadowed the value re-exported by `export *`. Root cause: type-only re-export. Fix status: FIXED (removed; `Prisma.sql/join` work).
- **Shell heredocs silently truncated `route.ts` (13 lines) and dropped `jwt.ts`** — cause: large heredoc in one command. Root cause: tooling limit on long heredocs. Fix status: FIXED — files written with the editor tool; verified by typecheck.
- **Concurrent double refund returned `INVALID_STATE` for losers** — cause: order status `refunded` was checked before the cap. Root cause: wrong code for "already refunded". Fix status: FIXED (`REFUND_EXCEEDS_PAID`), covered by test.
- **OpenAPI exporter failed ("DATABASE_URL is required")** — cause: config read at import time before placeholder env was set. Root cause: ESM import hoisting. Fix status: FIXED (`export-env.ts` imported first).
- **Stub chaos test never saw 503** — cause: test used a scenario value the test endpoint rejects. Root cause: test bug. Fix status: FIXED.

- **Stub test saw isolated 429s at ~90 ms client spacing** — cause: strict ≤20 rps (≥50 ms between admissions) + host→container latency jitter (Docker Desktop on Windows) compresses client gaps below 50 ms server-side; a Redis clock step back (VM time sync) additionally could drain the bucket. Root cause: jitter, not a limiter defect (probe: 2/200 at 70 ms spacing, never when server gaps ≥ 50 ms). Fix status: FIXED — Lua clamps `now < ts`; clients/tests retry 429 (as `startPayment`/`dispatchRefund` do with backoff). Temporary probe test removed.
- **DB pool timeouts under load surfaced as opaque 500** — Fix: pool `connectionTimeoutMillis` 30 s + coded 503 mapping.

### Progress
- Stage 4: done. typecheck, lint, format, build, `pnpm gen:client` (deterministic) and integration tests green locally; compose smoke verified (see log below).

## Stage 7 notes
- Bulk seed in `apps/migrate/src/seed.ts` (set-based SQL in one transaction, advisory lock + `seed_runs('seed-v1')`): 50 005 users, 30 venues, 33 200 seats, 2 000 events, 1 005 624 tickets, 258 906 orders, 776 718 ledger entries (sum 0). ~205 s on Docker Desktop. Second run skips.
- Fix: `UNION` of text/NULL in ledger accounts step needed `NULL::uuid`. Deferred ledger triggers are disabled during the load and replaced by one set-based balance check before commit.
- Local note: host Postgres port is `POSTGRES_HOST_PORT` (55432 in `.env`).

## Stage 8/9 progress (2026-11-20 afternoon)
- Integration suite (`tests/integration`, 4 files incl. `worker.test.ts`): 39/39 green on real PG + Redis (host PG port 55432 → `TEST_PG_ADMIN_URL`).
- Added perf budgets test `tests/perf/perf.test.ts` (against compose + full seed), Playwright config + `apps/web/e2e/e2e.spec.ts` (two contexts, cross-instance hold conflict, role logins, scan error).
- Security review fix: seed no longer falls back to a hardcoded password (`SEED_PASSWORD` required).
- Pending: full compose run (build + seed + `scripts/smoke.sh`), run perf + e2e against it, record results here. Not done / not claimed: one Vitest suite per each invariant 1–15 at full scale (10k mass cancel etc.), queue-limit-1 and purchase→transfer→scan flows in Playwright, 10k-map long-task trace.

## Security hardening (checkpoint)
- `apps/api/src/rate-limit.ts`: Redis fixed-window limiter (Lua, shared by both api instances) with per-instance in-memory fallback if Redis is down; policies: auth 30/min/IP, holds 30, payments 20, queue/waitlist 30, venue upload 10 (per user), default 1200/min; health, webhook, stub-pay exempt. 429 `RATE_LIMITED` + `Retry-After`.
- Login brute force: per-email (5) and per-IP (30) failure counters, lock doubles per further failure (30 s → 15 min cap), checked before password verification, reset on success. Redis TTL = server-side expiry. Limitation: counters live in Redis, so FLUSHALL clears lockouts.
- Uploads: JSON bodies only (415 otherwise), 256 kb cap (413), strict venue schema (unknown keys, control chars, `/ \ < >`, duplicate zones/rows rejected). `TRUST_PROXY` = one nginx hop; api ports 3001/3002 are test-only.
- Tests: `tests/integration/security.test.ts`; full integration suite 43/43.

## API restructure (checkpoint)
- `apps/api/src` is now `common/` (config, errors, route guards/decorators, idempotency, infra, jwt, rate-limit, dto), `modules/{auth,events,orders,queue,organizer,reporting,gate,stub-pay,health,test-controls}`, `realtime/gateway.ts`; `main/bootstrap/app.module/openapi` stay at the root. Pure move + import rewrite: typecheck, lint, format, build, `gen:client` (no diff) and 43/43 integration tests green. Not done: splitting `organizer.controller.ts` (venues/events/promos/sales) and `buyer.controller.ts` (holds/payments/refunds/tickets/waitlist) into one module per domain.

## Final verification (2026-11-20, ~16:15)
**Environment:** full app-container `docker compose up --build` was NOT verified: image builds were network-bound (`pnpm install` per image, >15 min) and `C:` had ~1.5–5 GB free, so the build was aborted. Verification ran with `postgres` + `redis` in Docker (compose) and the built apps as **host processes**: mailstub, api1 (:3001), api2 (:3002), worker, web (`next start`), fronted by an nginx container (`docker/nginx.conf` with host upstreams) on :8080. Docker Desktop lost its containers/volume once mid-session, so the DB was recreated and re-seeded (136 s) before the final runs.
| Check | Result |
|-|-|
| `typecheck`, `lint`, `format:check`, `pnpm build`, `gen:client` (no diff) | pass |
| `scripts/smoke.sh` (host stack via nginx) | **SMOKE OK**, round-robin api1/api2 (fixed: follows the web `/` → `/uk` redirect) |
| `tests/perf/perf.test.ts` on the full seed | 4/4 pass (search/map < 200 ms, organizer + finance reports < 500 ms; p95 of 30 warm requests) |
| Playwright `apps/web/e2e/e2e.spec.ts` (Chromium) | 4/4 pass: two-context role logins, map canvas for E-BIG, cross-instance hold conflict (409), scan error |
| Vitest integration (`tests/integration`) | 42/43 in the last full run; `invariant 10 — virtual queue › admits strictly in join order…` failed once and passed when re-run alone (earlier full runs: 43/43) — suspected timing flake, **not root-caused** |
- Test fixes found while verifying: perf test used Vite's reserved `BASE_URL` (now `STACK_URL`); map endpoint needs a signed-in buyer; organizer events list is capped at 500 so E-BIG is looked up via public search.
- **Still unchecked / not done (Stage 8–9):** one Vitest suite per invariant at full scale (10k mass cancel, 1000-user queue fairness over 2 api…), Playwright queue-limit-1, hold-expiry and purchase→transfer→scan flows, 10k-map long-task trace, `docker compose up --build` + compose smoke, final acceptance run of table rows 1–20. Perf and e2e were not run in CI.

## Acceptance audit (2026-11-20, ~17:00) — honest status
**Fixed this round**
- `TS2307 @tickets/shared` in `apps/web` typecheck: root cause = `pnpm typecheck` ran before any package `dist/*.d.ts` existed (CI runs typecheck before build). Fix: root `typecheck` = `build:libs` (`pnpm --filter "./packages/*" build`, topological) + `pnpm -r typecheck`. Verified from a clean `dist` (exit 0).
- Seed defect found by the 10k mass cancel: seeded payments did not exist in the payment stub → every refund of a seeded order got `provider answered 404`. The seed now also inserts `stub_payments`.
- Password spraying: lock was per account, so an attacker could lock out the owner. Now per (account, address) + per address overall.
- Real client IP: nginx now overwrites `X-Forwarded-For` with `$remote_addr`; api trusts one hop; api1/api2 host ports bound to 127.0.0.1. Through nginx, 40 requests with rotating spoofed XFF were all counted under the one real address.
- Layout swap: no overwrite route exists; new `layout_immutable` migration makes venue layout / seat / zone identity immutable (tested).
**Rows (evidence)**
| # | Status | Evidence |
|-|-|-|
| 1 | NOT verified | `docker compose up --build` of app images never completed (network/disk); `.env.example` has `SEED_PASSWORD`, compose wiring unchanged |
| 2 | verified locally | typecheck, lint, format, build, `gen:client` (no diff), 48/48 integration; CI file unchanged and not run on a runner |
| 3 | verified | `api-flow` invariant 13: seat via api1 reaches api2 client < 1 s |
| 4, 5, 6 | verified | `schema-invariants` (200 concurrent, 10×2 limit 6 → 3, promo 150/100) + api-level tests |
| 7 | verified | late-payment test, both branches |
| 8 | verified (small scale) | webhook dup/reorder/bad signature/dropped → reconciliation tests |
| 9 | verified | concurrent refunds tests |
| 10 | verified | `worker.test.ts` (kill -9 of a replica, 14 orders) and, at scale, manual `kill -9` of one of 3 workers during the 10k cancel |
| 11 | verified at scale | `tests/perf/mass-cancel.test.ts` on seeded `E-CANCEL`: 10 000 orders, chaos on, 3 workers (1 killed): 10 000 refunds, one per order, stub peak 17 req/s (≤ 20), ledger sum 0, event cancelled before refunds finished, repeat cancel no-op. The live phase was observed by DB queries; the test was re-run on the finished state (a first run failed only on a SQL bug in the test) |
| 12 | partly | FLUSHALL during expiry and mass cancel in `worker.test.ts`; not repeated at 10k scale; queue order after FLUSHALL not tested |
| 13 | verified | new `queue-scale.test.ts`: 1000 users over 2 api instances, exactly 200 admitted, 800 queued with gap-free positions, reload keeps position |
| 14, 15, 16 | verified | waitlist, transfer/QR, 30 simultaneous scans tests |
| 17 | verified | REST permission matrix + new Socket.IO test (bad token disconnected; `cancel:subscribe` refused for a non-owner). Direct seat-map room subscription is public event data by design |
| 18 | verified | ledger sum 0 after the 10k cancel and in schema tests |
| 19 | partly | perf budgets pass (host stack); URL-state/Back not covered by an e2e test |
| 20 | NOT re-verified | locale behaviour not re-tested this round; README not re-audited line by line |
**Extra checks:** 1 layout swap — verified (see above; there is no file/object storage). 2 real IP via nginx — verified through nginx with spoofed XFF; the per-IP *isolation* itself is tested on the api directly (a single host cannot present two real addresses to nginx). 3 per-IP isolation — verified (`security.test.ts`). 4 password spraying — verified.
**Known gaps:** invalid-token requests are rejected before the rate limiter; one earlier full-suite run had a single flaky queue-order test (passed alone and in the last two full runs).
