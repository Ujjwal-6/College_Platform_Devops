-- Up Migration
-- Halls (venues) and shared resources (equipment). Member 2: hall booking & resource management.
-- btree_gist lets a plain column (hall_id) be combined with a time range in an exclusion constraint.
-- It is a "trusted" extension: a non-superuser with CREATE on the database can install it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE halls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  location    text NOT NULL DEFAULT '',
  capacity    integer NOT NULL,
  -- Lower-case tags such as 'projector', 'ac', 'stage'. A booking may ask for facilities.
  facilities  text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT halls_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 100),
  CONSTRAINT halls_capacity_check CHECK (capacity BETWEEN 1 AND 100000)
);
CREATE UNIQUE INDEX halls_name_key ON halls (lower(name));

CREATE TABLE resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category    text NOT NULL,
  -- Total units owned. A single shared item is quantity 1.
  quantity    integer NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Only 'available' resources accept new reservations. Existing reservations are never changed by a status change.
  status      text NOT NULL DEFAULT 'available',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resources_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 100),
  CONSTRAINT resources_category_check CHECK (char_length(btrim(category)) BETWEEN 2 AND 50),
  CONSTRAINT resources_quantity_check CHECK (quantity BETWEEN 1 AND 100000),
  CONSTRAINT resources_status_check CHECK (status IN ('available', 'maintenance', 'retired'))
);
CREATE UNIQUE INDEX resources_name_key ON resources (lower(name));

-- Down Migration
DROP TABLE resources;
DROP TABLE halls;
-- The btree_gist extension is left installed: other objects may depend on it.
