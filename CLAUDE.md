# CLAUDE.md

## MANDATORY: NO DEVIATIONS FROM `docs/test-assignment-14.md`
- The assignment is the single source of truth: stack and versions (Next.js 15, React 19, NestJS, PostgreSQL 16 + Prisma with raw SQL only where locks/constraints are needed, Redis 7 + BullMQ, Socket.IO), statuses, business rules, endpoints, workflows and deliverables.
- Never introduce substitutions or workarounds that contradict it. If something is ambiguous, record the clarification in `plan.md` and `README.md` ("Ambiguities & Decisions") while staying faithful to the spec's wording.
- Re-read the relevant spec section before starting each stage.

## Purpose & Operating Mode
- Monorepo for the concert ticket sales platform (`apps/api`, `apps/worker`, `apps/web`, `packages/shared`).
- PostgreSQL 16 is the source of truth for domain state and money. Redis 7 handles queues, caching, and cross-instance coordination without losing invariants on `FLUSHALL` or restart.
- Track all progress, completed steps, ambiguities, and root causes in `plan.md`. Mirror architectural decisions, status transition tables, indexes, and ledger rules in `README.md`.

## Token & Context Efficiency
- Do not read entire directories, `node_modules`, generated clients, logs, or large dumps unnecessarily; use targeted searches and read only relevant files or line ranges.
- Avoid repeating large code listings already written to disk; report concise summaries of changes, affected files, test/check outcomes, and `plan.md` status.
- Stay focused on the current stage in `plan.md`; avoid unrequested refactors of unrelated code.
- Update `plan.md` after completing major milestones or before risky changes so state is never lost across steps.

## Hard Coding Rules
- Never use `any` or `@ts-ignore` / `@ts-expect-error` without an explicit explanatory comment.
- Never hand-write API response types on the frontend; always use the client generated from OpenAPI.
- Never hardcode secrets; put configuration and flags (including payment stub chaos mode) in environment variables and `.env.example`.
- No real external third-party services (payment gateways, external SMTP, SMS, card processors); use internal project stubs only.
- Store and compute money as integers in minor units (kopecks); every financial operation must post balanced double-entry ledger entries summing to zero.
- Enforce authorization and role checks server-side on every REST endpoint and Socket.IO event.
- Support `uk`, `en`, and `pl` locales (currency formatting, dates/times, pluralization).

## Pre-Commit Checks
- Verify build, `typecheck`, `lint`, up-to-date generated OpenAPI client, tests (Vitest integration tests against real Postgres/Redis and Playwright e2e tests), and CI configuration on every commit.

## Context Compaction Instructions
When compacting context, always preserve:
1. The current active stage and next unchecked item from `plan.md`.
2. Any unresolved failures, root causes, and pending fixes recorded in `plan.md`.
3. Architectural decisions, database invariants, OpenAPI client generation commands, and seeded test credentials.
4. Immediately after compaction, read `plan.md` and `git status` to resume execution from the exact current stage without repeating completed work.

## Strict Spec Compliance (Zero Deviations)
- Follow `docs/test-assignment-14.md` strictly: NO DEVIATIONS FROM `docs/test-assignment-14.md`.
- Do not change specified versions, stack components, endpoints, business rules, schemas, or deliverables unless explicitly instructed by the user.
- If something in `docs/test-assignment-14.md` is unclear or constrained by the environment, do not invent unauthorized substitutions on your own—record the question/ambiguity and any approved decision in `plan.md` and `README.md`.