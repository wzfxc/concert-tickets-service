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
