-- Up Migration
-- A reservation holds `quantity` units of one resource for a time window, for one approved event.
-- Unlike halls, several reservations may overlap as long as the units in use at any instant never
-- exceed the resource's total. That cannot be written as a table constraint, so the service locks
-- the resource row and checks peak usage before inserting (see docs/booking-design.md).
CREATE TABLE resource_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id    uuid NOT NULL REFERENCES resources (id),
  event_id       uuid NOT NULL REFERENCES events (id),
  requested_by   uuid NOT NULL REFERENCES users (id),
  quantity       integer NOT NULL,
  start_at       timestamptz NOT NULL,
  end_at         timestamptz NOT NULL,
  notes          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'confirmed',
  release_reason text,
  released_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_reservations_quantity_check CHECK (quantity BETWEEN 1 AND 100000),
  CONSTRAINT resource_reservations_time_order CHECK (end_at > start_at),
  CONSTRAINT resource_reservations_status_check CHECK (status IN ('confirmed', 'released')),
  CONSTRAINT resource_reservations_notes_check CHECK (char_length(notes) <= 1000)
);
CREATE INDEX resource_reservations_active_idx ON resource_reservations (resource_id, start_at, end_at) WHERE status = 'confirmed';
CREATE INDEX resource_reservations_event_idx ON resource_reservations (event_id);

-- Down Migration
DROP TABLE resource_reservations;
