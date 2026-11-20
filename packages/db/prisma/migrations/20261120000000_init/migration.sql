-- Initial schema. Authoritative DDL incl. the raw-SQL invariants Prisma cannot express
-- (CHECKs, expression/partial uniques, deferred ledger triggers, hold_seats()/hold_zone()/redeem_promo()/post_ledger()).
-- schema.prisma mirrors the tables/enums/indexes for the typed client; verify with: pnpm --filter @tickets/db drift

-- Deterministic time control (plan.md): PG is authoritative; app_now() = clock + offset.
CREATE TABLE time_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  offset_ms bigint NOT NULL DEFAULT 0
);
INSERT INTO time_control DEFAULT VALUES;

CREATE FUNCTION app_now() RETURNS timestamptz
LANGUAGE sql STABLE AS
$$ SELECT clock_timestamp() + (SELECT offset_ms FROM time_control) * interval '1 millisecond' $$;

CREATE TABLE seed_runs (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Stage 2: domain schema. PostgreSQL is the source of truth; every invariant below is DB-enforced.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────── enums ─────────────────────────
CREATE TYPE user_role AS ENUM ('buyer', 'organizer', 'controller', 'finance');
CREATE TYPE zone_kind AS ENUM ('seated', 'dancefloor');
CREATE TYPE event_status AS ENUM ('draft', 'on_sale', 'sold_out', 'rescheduled', 'cancelled', 'finished', 'paid_out');
CREATE TYPE order_status AS ENUM ('holding', 'awaiting_payment', 'paid', 'partially_refunded', 'refunded', 'expired');
CREATE TYPE hold_status AS ENUM ('held', 'sold', 'released', 'expired');
CREATE TYPE ticket_status AS ENUM ('valid', 'used', 'refunded', 'transferred', 'cancelled');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'cancelled');
CREATE TYPE refund_status AS ENUM ('pending', 'sent', 'done', 'failed');
CREATE TYPE offer_status AS ENUM ('offered', 'accepted', 'expired', 'cancelled');
CREATE TYPE queue_status AS ENUM ('waiting', 'admitted', 'done', 'expired', 'left');

-- ───────────────────────── users / venues ─────────────────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  role user_role NOT NULL DEFAULT 'buyer',
  locale text NOT NULL DEFAULT 'uk' CHECK (locale IN ('uk', 'en', 'pl')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES users (id),
  name text NOT NULL,
  city text NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venues_organizer_idx ON venues (organizer_id);

CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind zone_kind NOT NULL DEFAULT 'seated',
  capacity integer CHECK (capacity > 0),
  CHECK ((kind = 'dancefloor') = (capacity IS NOT NULL))
);
CREATE INDEX zones_venue_idx ON zones (venue_id);

CREATE TABLE seats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  row_label text NOT NULL,
  seat_number integer NOT NULL,
  x real,
  y real,
  UNIQUE (zone_id, row_label, seat_number)
);
CREATE INDEX seats_venue_idx ON seats (venue_id);

-- ───────────────────────── events ─────────────────────────
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE,
  organizer_id uuid NOT NULL REFERENCES users (id),
  venue_id uuid NOT NULL REFERENCES venues (id),
  title text NOT NULL,
  category text NOT NULL,
  city text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  status event_status NOT NULL DEFAULT 'draft',
  sales_start timestamptz,
  per_user_limit integer NOT NULL DEFAULT 6 CHECK (per_user_limit > 0),
  queue_enabled boolean NOT NULL DEFAULT false,
  queue_latched boolean NOT NULL DEFAULT false,
  rescheduled_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_title_trgm ON events USING gin (title gin_trgm_ops);
CREATE INDEX events_city_trgm ON events USING gin (city gin_trgm_ops);
CREATE INDEX events_category_starts_idx ON events (category, starts_at);
CREATE INDEX events_city_starts_idx ON events (city, starts_at);
CREATE INDEX events_starts_idx ON events (starts_at);
CREATE INDEX events_on_sale_starts_idx ON events (starts_at) WHERE status IN ('on_sale', 'rescheduled');
CREATE INDEX events_organizer_idx ON events (organizer_id);

CREATE TABLE event_controllers (
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE event_zone_prices (
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES zones (id),
  price_kop bigint NOT NULL CHECK (price_kop > 0),
  PRIMARY KEY (event_id, zone_id)
);

-- Optional per-seat price override (price painter).
CREATE TABLE event_seat_prices (
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  seat_id bigint NOT NULL REFERENCES seats (id),
  price_kop bigint NOT NULL CHECK (price_kop > 0),
  PRIMARY KEY (event_id, seat_id)
);

-- Per-event monotonically increasing sequence for live seat updates (socket resync).
CREATE TABLE event_seq (
  event_id uuid PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  last_seq bigint NOT NULL DEFAULT 0
);
CREATE TABLE seat_events (
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  seat_id bigint,
  zone_id uuid,
  state text NOT NULL CHECK (state IN ('free', 'held', 'sold', 'offered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, seq)
);

CREATE TABLE promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events (id) ON DELETE CASCADE,
  code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value bigint NOT NULL CHECK (value > 0),
  usage_limit integer NOT NULL CHECK (usage_limit > 0),
  used integer NOT NULL DEFAULT 0,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_used_within_limit CHECK (used >= 0 AND used <= usage_limit),
  CONSTRAINT promo_percent_range CHECK (kind <> 'percent' OR value <= 100)
);
CREATE UNIQUE INDEX promo_codes_code_uq ON promo_codes (event_id, upper(code));

-- ───────────────────────── orders / holds ─────────────────────────
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  event_id uuid NOT NULL REFERENCES events (id),
  status order_status NOT NULL DEFAULT 'holding',
  expires_at timestamptz NOT NULL,
  promo_id uuid REFERENCES promo_codes (id),
  subtotal_kop bigint NOT NULL DEFAULT 0 CHECK (subtotal_kop >= 0),
  discount_kop bigint NOT NULL DEFAULT 0 CHECK (discount_kop >= 0),
  fee_kop bigint NOT NULL DEFAULT 0 CHECK (fee_kop >= 0),
  total_kop bigint NOT NULL DEFAULT 0 CHECK (total_kop >= 0),
  paid_kop bigint NOT NULL DEFAULT 0 CHECK (paid_kop >= 0),
  refunded_kop bigint NOT NULL DEFAULT 0,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Invariant 4/6: cumulative refunds can never exceed what was paid.
  CONSTRAINT orders_refund_le_paid CHECK (refunded_kop >= 0 AND refunded_kop <= paid_kop)
);
CREATE INDEX orders_user_status_idx ON orders (user_id, status);
CREATE INDEX orders_event_status_idx ON orders (event_id, status);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status IN ('holding', 'awaiting_payment');

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events (id),
  zone_id uuid NOT NULL REFERENCES zones (id),
  seat_id bigint REFERENCES seats (id),
  price_kop bigint NOT NULL CHECK (price_kop >= 0),
  discount_kop bigint NOT NULL DEFAULT 0 CHECK (discount_kop >= 0),
  fee_kop bigint NOT NULL DEFAULT 0 CHECK (fee_kop >= 0),
  refunded boolean NOT NULL DEFAULT false
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- Invariant 1: a seat is held/sold by at most one order. Expired holds are flipped to 'expired' by
-- hold_seats() in the same transaction using app_now(), so correctness never depends on a worker.
CREATE TABLE seat_holds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events (id),
  seat_id bigint NOT NULL REFERENCES seats (id),
  order_id uuid NOT NULL REFERENCES orders (id),
  user_id uuid NOT NULL REFERENCES users (id),
  status hold_status NOT NULL DEFAULT 'held',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX seat_holds_active_uq ON seat_holds (event_id, seat_id) WHERE status IN ('held', 'sold');
CREATE INDEX seat_holds_expiry_idx ON seat_holds (expires_at) WHERE status = 'held';
CREATE INDEX seat_holds_user_idx ON seat_holds (user_id, event_id) WHERE status IN ('held', 'sold');
CREATE INDEX seat_holds_order_idx ON seat_holds (order_id);

-- Dancefloor (capacity) holds, serialised through the zone counter row.
CREATE TABLE zone_holds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events (id),
  zone_id uuid NOT NULL REFERENCES zones (id),
  order_id uuid NOT NULL REFERENCES orders (id),
  user_id uuid NOT NULL REFERENCES users (id),
  qty integer NOT NULL CHECK (qty > 0),
  status hold_status NOT NULL DEFAULT 'held',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zone_holds_zone_idx ON zone_holds (event_id, zone_id) WHERE status IN ('held', 'sold');
CREATE INDEX zone_holds_user_idx ON zone_holds (user_id, event_id) WHERE status IN ('held', 'sold');
CREATE INDEX zone_holds_expiry_idx ON zone_holds (expires_at) WHERE status = 'held';

CREATE TABLE event_zone_counters (
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES zones (id),
  capacity integer NOT NULL CHECK (capacity > 0),
  PRIMARY KEY (event_id, zone_id)
);

CREATE TABLE promo_usages (
  promo_id uuid NOT NULL REFERENCES promo_codes (id),
  order_id uuid NOT NULL REFERENCES orders (id),
  user_id uuid NOT NULL REFERENCES users (id),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promo_id, order_id)
);

-- Append-only audit trail of order status transitions.
CREATE TABLE order_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id),
  from_status order_status,
  to_status order_status NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_history_order_idx ON order_history (order_id, id);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ───────────────────────── tickets ─────────────────────────
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items (id),
  event_id uuid NOT NULL REFERENCES events (id),
  owner_id uuid NOT NULL REFERENCES users (id),
  zone_id uuid NOT NULL REFERENCES zones (id),
  seat_id bigint REFERENCES seats (id),
  qr_version integer NOT NULL DEFAULT 1,
  status ticket_status NOT NULL DEFAULT 'valid',
  used_at timestamptz,
  used_gate text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tickets_used_consistent CHECK ((status = 'used') = (used_at IS NOT NULL))
);
CREATE INDEX tickets_owner_idx ON tickets (owner_id, status);
CREATE INDEX tickets_event_idx ON tickets (event_id, status);
CREATE UNIQUE INDEX tickets_order_item_uq ON tickets (order_item_id);

CREATE TABLE ticket_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets (id),
  from_user_id uuid NOT NULL REFERENCES users (id),
  to_user_id uuid NOT NULL REFERENCES users (id),
  old_qr_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entrance_scans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id uuid REFERENCES tickets (id),
  event_id uuid REFERENCES events (id),
  gate text NOT NULL,
  scanner_id uuid REFERENCES users (id),
  result text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entrance_scans_event_idx ON entrance_scans (event_id, scanned_at);

-- ───────────────────────── payments / refunds ─────────────────────────
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  provider_ref text UNIQUE,
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  status payment_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'pending';

-- Webhook dedup: same (payment, event_type) processed once.
CREATE TABLE payment_webhook_events (
  provider_ref text NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_ref, event_type)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  payment_id uuid REFERENCES payments (id),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  kind text NOT NULL CHECK (kind IN ('user', 'cancellation', 'late_payment', 'manual')),
  status refund_status NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,
  locked_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_due_idx ON refunds (locked_until NULLS FIRST) WHERE status IN ('pending', 'sent');

CREATE TABLE cancel_batches (
  event_id uuid PRIMARY KEY REFERENCES events (id),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  total integer NOT NULL DEFAULT 0,
  done integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- ───────────────────────── ledger ─────────────────────────
CREATE TABLE ledger_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL,
  organizer_id uuid REFERENCES users (id),
  CHECK (code IN (
    'provider_clearing', 'ticket_revenue_liability', 'service_fee_revenue', 'commission_revenue',
    'organizer_payable', 'refunds', 'payouts', 'promo_discount_expense'))
);
CREATE UNIQUE INDEX ledger_accounts_uq ON ledger_accounts (code, COALESCE(organizer_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE ledger_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_type text NOT NULL,
  operation_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotent posting: the same operation can only be recorded once.
  UNIQUE (operation_type, operation_ref)
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx_id bigint NOT NULL REFERENCES ledger_transactions (id),
  account_id bigint NOT NULL REFERENCES ledger_accounts (id),
  amount_kop bigint NOT NULL CHECK (amount_kop <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at);

-- Double entry: each transaction must sum to zero (checked at COMMIT, so a tx can insert entries one by one).
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(SUM(amount_kop), 0) INTO s FROM ledger_entries WHERE tx_id = NEW.tx_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: tx % sums to %', NEW.tx_id, s USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- A transaction with no entries is meaningless; and posted ledger rows are immutable.
CREATE FUNCTION ledger_check_nonempty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE tx_id = NEW.id) THEN
    RAISE EXCEPTION 'LEDGER_EMPTY: tx % has no entries', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_tx_nonempty AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_nonempty();

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23000';
END $$;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER order_history_immutable BEFORE UPDATE OR DELETE ON order_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reconciliation helper: balance of every account = sum of its entries (no cached balance to drift).
CREATE VIEW ledger_balances AS
  SELECT a.id AS account_id, a.code, a.organizer_id, COALESCE(SUM(e.amount_kop), 0)::bigint AS balance_kop
  FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
  GROUP BY a.id;

-- Refund cap (invariants 4/6): serialise per order (row lock) and bump the cumulative counter;
-- orders_refund_le_paid then rejects any over-refund, whichever API instance asked.
CREATE FUNCTION refunds_apply_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET refunded_kop = refunded_kop + NEW.amount_kop WHERE id = NEW.order_id;
  RETURN NEW;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'REFUND_EXCEEDS_PAID' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER refunds_cap BEFORE INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_apply_cap();

-- ───────────────────────── waitlist / queue ─────────────────────────
CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events (id),
  user_id uuid NOT NULL REFERENCES users (id),
  zone_id uuid REFERENCES zones (id),
  qty integer NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 6),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'done', 'left')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX waitlist_active_uq ON waitlist_entries (event_id, user_id) WHERE status IN ('waiting', 'offered');
CREATE INDEX waitlist_fifo_idx ON waitlist_entries (event_id, created_at) WHERE status = 'waiting';

CREATE TABLE waitlist_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES waitlist_entries (id),
  event_id uuid NOT NULL REFERENCES events (id),
  seat_id bigint REFERENCES seats (id),
  zone_id uuid REFERENCES zones (id),
  status offer_status NOT NULL DEFAULT 'offered',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One active offer per seat.
CREATE UNIQUE INDEX waitlist_offer_seat_uq ON waitlist_offers (event_id, seat_id) WHERE status = 'offered' AND seat_id IS NOT NULL;
CREATE INDEX waitlist_offer_expiry_idx ON waitlist_offers (expires_at) WHERE status = 'offered';

CREATE TABLE queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  joined_seq bigint GENERATED ALWAYS AS IDENTITY,
  event_id uuid NOT NULL REFERENCES events (id),
  user_id uuid NOT NULL REFERENCES users (id),
  status queue_status NOT NULL DEFAULT 'waiting',
  admitted_at timestamptz,
  admit_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);
CREATE INDEX queue_waiting_idx ON queue_entries (event_id, joined_seq) WHERE status = 'waiting';
CREATE INDEX queue_admitted_idx ON queue_entries (event_id, admit_expires_at) WHERE status = 'admitted';

-- ───────────────────────── jobs: outbox, failures, emails ─────────────────────────
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  dedup_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due_idx ON outbox (available_at) WHERE processed_at IS NULL;

CREATE TABLE email_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key text NOT NULL UNIQUE,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_due_idx ON email_outbox (created_at) WHERE status = 'pending';

CREATE TABLE failed_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue text NOT NULL,
  job_key text NOT NULL,
  payload jsonb,
  error text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  failed_at timestamptz NOT NULL DEFAULT now(),
  retried_at timestamptz,
  UNIQUE (queue, job_key)
);

-- ───────────────────────── domain functions ─────────────────────────
CREATE FUNCTION next_event_seq(p_event uuid) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO event_seq (event_id, last_seq) VALUES (p_event, 1)
  ON CONFLICT (event_id) DO UPDATE SET last_seq = event_seq.last_seq + 1
  RETURNING last_seq
$$;

-- Per-user quota (seats + dancefloor tickets in held/sold state). Caller must hold the advisory lock.
CREATE FUNCTION user_event_quota_used(p_user uuid, p_event uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM seat_holds WHERE user_id = p_user AND event_id = p_event AND status IN ('held', 'sold'))::int
       + (SELECT COALESCE(sum(qty), 0) FROM zone_holds WHERE user_id = p_user AND event_id = p_event AND status IN ('held', 'sold'))::int
$$;

-- All-or-nothing seat hold. Raises SEATS_UNAVAILABLE / PER_USER_LIMIT (SQLSTATE P0001, message = code).
CREATE FUNCTION hold_seats(p_event uuid, p_user uuid, p_order uuid, p_seats bigint[], p_ttl interval)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  v_limit integer;
  v_now timestamptz := app_now();
  v_expires timestamptz;
  v_inserted integer;
BEGIN
  -- Serialise per (user,event) so the quota count + insert is atomic across api instances.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_event::text, 0));
  SELECT per_user_limit INTO v_limit FROM events WHERE id = p_event;
  IF v_limit IS NULL THEN RAISE EXCEPTION 'EVENT_NOT_FOUND'; END IF;
  IF user_event_quota_used(p_user, p_event) + cardinality(p_seats) > v_limit THEN
    RAISE EXCEPTION 'PER_USER_LIMIT';
  END IF;
  -- Order's hold clock starts at its first seat (decision 8).
  SELECT COALESCE(min(expires_at), v_now + p_ttl) INTO v_expires
    FROM seat_holds WHERE order_id = p_order AND status = 'held';
  -- Server-clock expiry: lapsed holds for these seats are released here, no worker needed.
  UPDATE seat_holds SET status = 'expired'
    WHERE event_id = p_event AND seat_id = ANY (p_seats) AND status = 'held' AND expires_at <= v_now;
  INSERT INTO seat_holds (event_id, seat_id, order_id, user_id, expires_at)
    SELECT p_event, s, p_order, p_user, v_expires FROM unnest(p_seats) AS s
    ON CONFLICT (event_id, seat_id) WHERE status IN ('held', 'sold') DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> cardinality(p_seats) THEN
    RAISE EXCEPTION 'SEATS_UNAVAILABLE';  -- rolls back the partial inserts of this call
  END IF;
  RETURN v_expires;
END $$;

-- Dancefloor capacity hold: serialised on the zone counter row.
CREATE FUNCTION hold_zone(p_event uuid, p_zone uuid, p_user uuid, p_order uuid, p_qty integer, p_ttl interval)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  v_cap integer;
  v_limit integer;
  v_now timestamptz := app_now();
  v_taken integer;
  v_expires timestamptz := v_now + p_ttl;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_event::text, 0));
  SELECT capacity INTO v_cap FROM event_zone_counters WHERE event_id = p_event AND zone_id = p_zone FOR UPDATE;
  IF v_cap IS NULL THEN RAISE EXCEPTION 'ZONE_NOT_FOUND'; END IF;
  SELECT per_user_limit INTO v_limit FROM events WHERE id = p_event;
  IF user_event_quota_used(p_user, p_event) + p_qty > v_limit THEN RAISE EXCEPTION 'PER_USER_LIMIT'; END IF;
  UPDATE zone_holds SET status = 'expired'
    WHERE event_id = p_event AND zone_id = p_zone AND status = 'held' AND expires_at <= v_now;
  SELECT COALESCE(sum(qty), 0) INTO v_taken FROM zone_holds
    WHERE event_id = p_event AND zone_id = p_zone AND status IN ('held', 'sold');
  IF v_taken + p_qty > v_cap THEN RAISE EXCEPTION 'SEATS_UNAVAILABLE'; END IF;
  INSERT INTO zone_holds (event_id, zone_id, order_id, user_id, qty, expires_at)
    VALUES (p_event, p_zone, p_order, p_user, p_qty, v_expires);
  RETURN v_expires;
END $$;

-- Atomic promo redemption: exactly `usage_limit` callers win, whatever the concurrency.
CREATE FUNCTION redeem_promo(p_promo uuid, p_order uuid, p_user uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE promo_codes SET used = used + 1
    WHERE id = p_promo AND used < usage_limit AND (valid_until IS NULL OR valid_until > app_now())
    RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;
  INSERT INTO promo_usages (promo_id, order_id, user_id) VALUES (p_promo, p_order, p_user);
  RETURN true;
END $$;

-- Give back the promo slot of an order that expired unpaid (paid orders keep it).
CREATE FUNCTION release_promo(p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_promo uuid;
BEGIN
  UPDATE promo_usages SET released_at = now()
    WHERE order_id = p_order AND released_at IS NULL RETURNING promo_id INTO v_promo;
  IF v_promo IS NOT NULL THEN UPDATE promo_codes SET used = used - 1 WHERE id = v_promo; END IF;
END $$;

-- Idempotent balanced ledger posting. p_lines: [{"account":"service_fee_revenue","organizer":null,"amount":-500}, ...]
-- Returns the tx id, or NULL when (type, ref) was already posted (no duplicate effect).
CREATE FUNCTION post_ledger(p_type text, p_ref text, p_lines jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_tx bigint;
  l jsonb;
  v_acc bigint;
  v_org uuid;
BEGIN
  INSERT INTO ledger_transactions (operation_type, operation_ref) VALUES (p_type, p_ref)
    ON CONFLICT (operation_type, operation_ref) DO NOTHING RETURNING id INTO v_tx;
  IF v_tx IS NULL THEN RETURN NULL; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_org := NULLIF(l ->> 'organizer', '')::uuid;
    INSERT INTO ledger_accounts (code, organizer_id) VALUES (l ->> 'account', v_org)
      ON CONFLICT (code, COALESCE(organizer_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET code = EXCLUDED.code RETURNING id INTO v_acc;
    INSERT INTO ledger_entries (tx_id, account_id, amount_kop) VALUES (v_tx, v_acc, (l ->> 'amount')::bigint);
  END LOOP;
  RETURN v_tx;
END $$;
