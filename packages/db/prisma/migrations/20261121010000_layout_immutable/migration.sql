-- A validated venue layout can never be swapped afterwards: the layout JSON and the seat / zone identity are
-- immutable once inserted (a changed hall is a new venue). Defence in depth below the API, which has no overwrite route.
CREATE FUNCTION forbid_layout_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'venue layout is immutable once validated (%.%)', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;

CREATE TRIGGER venues_layout_immutable BEFORE UPDATE ON venues
  FOR EACH ROW WHEN (OLD.layout IS DISTINCT FROM NEW.layout OR OLD.organizer_id IS DISTINCT FROM NEW.organizer_id)
  EXECUTE FUNCTION forbid_layout_change();

CREATE TRIGGER seats_identity_immutable BEFORE UPDATE ON seats
  FOR EACH ROW WHEN (OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.zone_id IS DISTINCT FROM NEW.zone_id
                     OR OLD.row_label IS DISTINCT FROM NEW.row_label OR OLD.seat_number IS DISTINCT FROM NEW.seat_number)
  EXECUTE FUNCTION forbid_layout_change();

CREATE TRIGGER zones_identity_immutable BEFORE UPDATE ON zones
  FOR EACH ROW WHEN (OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.kind IS DISTINCT FROM NEW.kind
                     OR OLD.capacity IS DISTINCT FROM NEW.capacity)
  EXECUTE FUNCTION forbid_layout_change();
