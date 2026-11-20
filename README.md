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

Status transition tables, job list and seeded credentials are added as the corresponding stages land (see `plan.md`).
