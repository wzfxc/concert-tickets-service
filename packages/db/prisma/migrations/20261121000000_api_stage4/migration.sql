-- Stage 4 (apps/api): blocked seats, refund fee split/provider ref, payment-stub tables,
-- hold functions aware of blocked seats and waitlist offers, ledger time index.

-- Seats an organizer withdraws from sale (guests, tech zone). Checked inside hold_seats().
CREATE TABLE event_blocked_seats (
  event_id uuid NOT NULL,
  seat_id bigint NOT NULL,
  PRIMARY KEY (event_id, seat_id)
);

-- Refund detail: part of amount that is service fee (cancellation / late payment), provider ref, reason.
ALTER TABLE refunds
  ADD COLUMN fee_kop bigint NOT NULL DEFAULT 0,
  ADD COLUMN provider_ref text,
  ADD COLUMN reason text,
  ADD CONSTRAINT refunds_fee_within_amount CHECK (fee_kop >= 0 AND fee_kop <= amount_kop);
CREATE UNIQUE INDEX refunds_provider_ref_uq ON refunds (provider_ref);

CREATE INDEX ledger_entries_created_idx ON ledger_entries (created_at);

-- ───────────── payment stub (own tables; talks to the app only over HTTP / signed webhooks) ─────────────
CREATE TABLE stub_payments (
  provider_ref text PRIMARY KEY,
  merchant_ref text NOT NULL UNIQUE,
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  return_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stub_refunds (
  provider_ref text PRIMARY KEY,
  merchant_ref text NOT NULL UNIQUE,
  payment_ref text NOT NULL,
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stub_refunds_payment_idx ON stub_refunds (payment_ref);
CREATE TABLE stub_webhooks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_ref text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stub_webhooks_due_idx ON stub_webhooks (due_at) WHERE delivered_at IS NULL;
CREATE TABLE stub_settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
-- Every request accepted/rejected by the stub API (lets tests assert the 20 rps ceiling).
CREATE TABLE stub_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  path text NOT NULL,
  status integer NOT NULL
);
CREATE INDEX stub_request_log_at_idx ON stub_request_log (at);

-- ───────────── hold functions: blocked seats + waitlist offers ─────────────
CREATE OR REPLACE FUNCTION hold_seats(p_event uuid, p_user uuid, p_order uuid, p_seats bigint[], p_ttl interval)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  v_limit integer;
  v_now timestamptz := app_now();
  v_expires timestamptz;
  v_inserted integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_event::text, 0));
  SELECT per_user_limit INTO v_limit FROM events WHERE id = p_event;
  IF v_limit IS NULL THEN RAISE EXCEPTION 'EVENT_NOT_FOUND'; END IF;
  IF user_event_quota_used(p_user, p_event) + cardinality(p_seats) > v_limit THEN
    RAISE EXCEPTION 'PER_USER_LIMIT';
  END IF;
  IF EXISTS (SELECT 1 FROM event_blocked_seats WHERE event_id = p_event AND seat_id = ANY (p_seats)) THEN
    RAISE EXCEPTION 'SEATS_UNAVAILABLE';
  END IF;
  -- Waitlist offer in force for someone else: seat is reserved for them (invariant 11).
  IF EXISTS (SELECT 1 FROM waitlist_offers o JOIN waitlist_entries w ON w.id = o.entry_id
              WHERE o.event_id = p_event AND o.seat_id = ANY (p_seats) AND o.status = 'offered'
                AND o.expires_at > v_now AND w.user_id <> p_user) THEN
    RAISE EXCEPTION 'SEAT_OFFERED';
  END IF;
  SELECT COALESCE(min(expires_at), v_now + p_ttl) INTO v_expires
    FROM seat_holds WHERE order_id = p_order AND status = 'held';
  UPDATE seat_holds SET status = 'expired'
    WHERE event_id = p_event AND seat_id = ANY (p_seats) AND status = 'held' AND expires_at <= v_now;
  INSERT INTO seat_holds (event_id, seat_id, order_id, user_id, expires_at)
    SELECT p_event, s, p_order, p_user, v_expires FROM unnest(p_seats) AS s
    ON CONFLICT (event_id, seat_id) WHERE status IN ('held', 'sold') DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> cardinality(p_seats) THEN
    RAISE EXCEPTION 'SEATS_UNAVAILABLE';
  END IF;
  RETURN v_expires;
END $$;

CREATE OR REPLACE FUNCTION hold_zone(p_event uuid, p_zone uuid, p_user uuid, p_order uuid, p_qty integer, p_ttl interval)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  v_cap integer;
  v_limit integer;
  v_now timestamptz := app_now();
  v_taken integer;
  v_offered integer;
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
  -- Capacity reserved by waitlist offers of other users.
  SELECT COALESCE(sum(w.qty), 0) INTO v_offered FROM waitlist_offers o JOIN waitlist_entries w ON w.id = o.entry_id
    WHERE o.event_id = p_event AND o.zone_id = p_zone AND o.status = 'offered' AND o.expires_at > v_now
      AND w.user_id <> p_user;
  IF v_taken + v_offered + p_qty > v_cap THEN
    IF v_taken + p_qty <= v_cap THEN RAISE EXCEPTION 'SEAT_OFFERED'; END IF;
    RAISE EXCEPTION 'SEATS_UNAVAILABLE';
  END IF;
  INSERT INTO zone_holds (event_id, zone_id, order_id, user_id, qty, expires_at)
    VALUES (p_event, p_zone, p_order, p_user, p_qty, v_expires);
  RETURN v_expires;
END $$;
