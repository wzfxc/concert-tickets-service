# Plan: Concert Tickets Service (test-assignment-14)

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
- [ ] Zod schemas for all inputs; constants (limits, TTLs, percentages); `calcServiceFee`, `calcCommission` (round in organizer's favour = commission rounded down), `calcRefund(order, event, now)`, promo discount calc; QR sign/verify (HMAC-SHA256 over `ticketId.version`, base64url); plural helpers. Vitest unit tests.

### 4. apps/api
- [ ] Auth (JWT, roles guard, per-event ownership checks; seeded logins), global validation pipe → coded errors, Idempotency-Key interceptor (scope+key+body hash; mismatch → 422 `IDEMPOTENCY_KEY_REUSED`).
- [ ] Modules: events/search (filters in query, keyset/offset), venues & layout upload (JSON validate with Zod), pricing by selection, holds (add/remove, 6 max, timer), orders, promo, payments + stub webhook endpoint (HMAC verify, idempotent on `payment_id+event_type`, state machine tolerant of out-of-order), refunds, transfer, tickets/QR, scan (atomic `UPDATE tickets SET used_at WHERE used_at IS NULL`), waitlist, organizer sales reports, finance reports/reconciliation/manual refund/jobs view, queue.
- [ ] **Payment stub module** (`/stub-pay`): payment page with Success/Fail/Close buttons, signed webhooks, chaos mode env (`PAYMENT_CHAOS`): dup, ≤60s delay, reorder, drop; 20 rps limiter (Redis-less in-memory token bucket per instance is wrong with 2 api → keep stub in one process? Decision: stub state & limiter in Postgres/Redis-safe; use Redis Lua token bucket, with fallback in-process if Redis lost); 429, chaos 503 every 10th; refunds API + status endpoints.
- [ ] Socket.IO: Redis adapter; rooms `event:{id}` (seat updates with monotonically increasing per-event `seq` stored in Postgres, `resync(sinceSeq)` catch-up from `seat_events` table), `user:{id}` private rooms (queue position, notifications), auth + role checks on handshake and on each subscribe; server-time sync message for timer.
- [ ] Virtual queue: Postgres is truth (`queue_entries` with `joined_seq` serial, unique(user,event)); admission via `SELECT ... FOR UPDATE SKIP LOCKED` + advisory lock per event limiting `admitted_active<=200`; Redis only as notification/cache and rebuilt from PG; 5-min admitted TTL checked by server clock.
- [ ] OpenAPI at `/docs`, export `openapi.json`; web client generated with `openapi-typescript` + `openapi-fetch`; CI fails on diff.

### 5. apps/worker (BullMQ)
- [ ] Queues: hold-expiry, payment-deadline, waitlist-offer, mass-cancel, refund, payout, email, pdf, reconcile (repeatable every minute), queue-admit.
- [ ] Reliability pattern: PG is source of truth; every job idempotent by natural key; a **DB sweeper** (every 5–10 s, `FOR UPDATE SKIP LOCKED`) re-derives due work from Postgres, so FLUSHALL loses nothing; job enqueue via transactional outbox; jobId = deterministic key.
- [ ] Mass cancel: `cancel_batches` + per-order `refund` rows (status pending/sent/done) processed in chunks with a global stub rate limiter (≤20 rps across replicas, Redis token bucket w/ PG-backed fallback), 429/503 → backoff retry, no double refund because provider call keyed by refund id (idempotent stub) and ledger unique op ref; progress via socket `cancel:{eventId}` + progress endpoint.
- [ ] kill -9 safety: lock-lease via BullMQ stalled detection + PG row lease (`locked_until`); multi-replica safe through SKIP LOCKED.
- [ ] Emails via SMTP to mail stub (nodemailer), PDF with QR (`pdfkit` + `qrcode`), failures visible in jobs view; retries with exponential backoff, exhausted → `failed_jobs` table for finance with retry endpoint.

### 6. apps/web
- [ ] Next.js 15 App Router, React 19, Tailwind, TanStack Query, RHF + zod resolver, next-intl (`uk` default, `en`, `pl`), `Intl` money/date, ICU plural messages.
- [ ] Pages: search (filters/sort/page in URL), event/hall map (canvas/SVG virtualized rendering for 10k seats, keyboard navigation roving tabindex, live updates via socket with seq catch-up), checkout (timer from server offset, promo, stub payment redirect), my tickets (QR, return, transfer), waitlist, queue waiting room, organizer (venue upload+viewer, price painter, events, promos, sales dashboards, cancel/reschedule with live progress), controller (camera via `BarcodeDetector` w/ manual fallback, counters), finance (report with period in URL, reconciliation, manual refund, jobs), mail stub UI link.

### 7. Seed
- [ ] Idempotent script using `COPY`/`generate_series` SQL (not row-by-row): 50k users, 30 venues (one 10k seats w/ dancefloor), 2000 events (some `sales_start = now()+10min` relative at seed time), 1M tickets with matching orders and ledger postings (reconciliation must be zero). Role logins documented. Runs automatically in `seed` container; skip if already seeded.

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
5. Refund windows measured to event `starts_at`; ≥7×24h = 100%, [2d,7d) = 50%, <2d = refused (`REFUND_WINDOW_CLOSED`) — boundaries inclusive on the generous side, tested at exact edges.
6. "Contending >500" = users in queue + active selectors for an event at sales moment; queue mode is latched per event once triggered (and always on for events flagged `queue_enabled`) to avoid flapping.
7. Queue timers: admitted slot valid 5 min of server time or until a hold is created; selector slot freed on hold creation? Decision: slot counts while the user is on the selection page *or* holds seats not yet paid; released on pay/expire/leave.
8. Hold 10 min measured from creation of the order's first seat; seat removal doesn't reset; removing last seat ends the hold.
9. Per-person limit counts seats in `holding|awaiting_payment|paid|partially_refunded` orders; refunded/expired free quota.
10. Waitlist: queue per event (not per seat/zone); when a seat frees, first matching entry gets the offer reserving that exact seat(s); one active offer per seat; dancefloor by quantity.
11. Payout: scheduled at `event.ends_at + 3d` (`starts_at + 3h` if no end), via `payout` job, once per event (unique(event_id)); ledger: organizer_payable → organizer_payout_paid, commission → revenue.
12. Money in API as integer kopecks (JSON numbers within 2^53; DB bigint); formatted only in the UI.
13. Stub provider is the same codebase but its own module + tables (`stub_payments`, `stub_refunds`) and talks to the app only over HTTP/webhooks, so reconciliation compares real divergence. Rate limit 20 rps cluster-wide via Redis Lua; Redis loss resets only the bucket (safe).
14. Test hooks (`/__test/*`, time advance) exist only with `ENABLE_TEST_CONTROLS=true`.
15. Mail stub is a custom small SMTP+HTML app (`apps/mailstub`), not a third-party image.
16. Event time zone `Europe/Kyiv` for display; stored UTC.
(Record new ambiguities as discovered; failures logged as: **cause / root cause / fix status**.)

## Verification
Per stage: `pnpm -r typecheck && pnpm -r lint && pnpm gen:client && git diff --exit-code && pnpm -r test`; stage 1/8/9: `docker compose up --build` smoke + Playwright; finally walk the 20 acceptance checks and reconcile (sum of ledger = 0).

## Risks
- Scale (1M tickets seed time, 10k hall render): bulk SQL, virtualization/canvas.
- Largest effort is the test matrix; build testing harness (compose test profile, fake clock, kill-9 helper) early in stage 2–4.

## Failures & Root Causes
(none yet)

## Progress Log
- Stage 0: done (skeleton, CI skeleton, lint rules, shared pkg stub; checks green locally)
- Stage 1: done. `docker compose up --build` from clean `.env` → 8 services healthy; `scripts/smoke.sh` OK (web 200, /docs 200, mailstub 200, strict api1/api2 alternation). Apps are skeletons (health only): api = NestJS+Swagger, worker = pg/redis connectivity+/health, mailstub = real SMTP (1025) + UI (8025), migrate = SQL runner + idempotent seed marker, web = Next 16 standalone. Ports: nginx 8080, api1 3001, api2 3002, mail UI 8025.


- Stage 2b: DB layer switched to Prisma 7 + targeted raw SQL (see decision in Stage 1 decisions). `tests/integration/schema-invariants.test.ts` now uses Prisma Client + raw wrappers: 15/15 green on real PG16; `docker compose down -v && up --build` clean (migrate applies Prisma migration, seed OK, smoke OK, no Prisma warnings); typecheck/lint/format:check/build green.
- Stage 2: done. `0002_schema.sql` (all tables, enums, indexes, ledger triggers, `hold_seats`/`hold_zone`/`redeem_promo`/`release_promo`/`post_ledger`), `tests/integration/schema-invariants.test.ts` 15/15 green on real PG16 (200-buyer hold race, limit 10×2→3, dancefloor 15→10, promo 150→100, ledger unbalanced/idempotent/immutable, refund cap, seq monotonic, `app_now` expiry). README has the invariant table.

## Stage 1 decisions / ambiguities
- **Prisma + targeted raw SQL (supersedes the earlier "Prisma dropped" deviation; spec says "PostgreSQL 16 + Prisma, raw SQL where locks/constraints are needed").** `packages/db` owns `prisma/schema.prisma` (models, enums, relations, plain/partial/GIN indexes → typed client, snake_case columns mapped to camelCase), Prisma migrations (`prisma migrate deploy` in the `migrate` container) and the client factory (`@prisma/adapter-pg`). Raw SQL is used only where the DB must enforce invariants — CHECKs, expression uniques, deferred ledger-balance trigger, append-only/refund-cap triggers, `hold_seats()`/`hold_zone()`/`redeem_promo()`/`post_ledger()`, advisory locks, `FOR UPDATE`/`SKIP LOCKED` — written inside Prisma migrations and called via typed wrappers in `packages/db/src/raw.ts`. The initial migration (`20261120000000_init`) is the former 0001+0002 SQL verbatim, so no invariant changed; `pnpm --filter @tickets/db drift` (CI) proves `schema.prisma` == migrated DB (verified: empty diff). Division of responsibilities is documented in README "Database layer". Old `schema_migrations` runner removed; pre-Prisma dev volumes must be recreated.
- Next.js is v16 (current `latest`), not 15; React 19. TypeScript pinned to 5.9 and `@types/node` 22 in all packages (pnpm resolved TS 7 / types 26 by default).
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
