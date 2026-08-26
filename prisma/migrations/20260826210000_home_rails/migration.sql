-- Home page sliders.
--
-- The listing rails were hardcoded in home.service.ts: the panel could rename a
-- section but not choose which listings it showed, nor add a new rail. These
-- tables move that into the admin panel.
--
-- A RESIDENCE rail names a source and the backend fills it with published
-- listings ordered by Residence.importance. A DESTINATION rail carries its own
-- tiles (a city or tag with its own image and link).

CREATE TYPE "HomeRailKind" AS ENUM ('RESIDENCE', 'DESTINATION');

CREATE TYPE "HomeRailSource" AS ENUM (
  'CITY',       -- source_slug is a location slug; expands through location_includes
  'TAG',        -- source_slug is a seo_tags.key
  'TYPE',       -- source_slug is a ResidenceType value
  'FAST',
  'OFFER',
  'TOP_RATED',
  'ALL'
);

CREATE TABLE "home_rails" (
  "id"            SERIAL NOT NULL,
  "kind"          "HomeRailKind" NOT NULL DEFAULT 'RESIDENCE',
  "title"         TEXT,
  "subtitle"      TEXT,
  "heading_level" INTEGER NOT NULL DEFAULT 2,
  "source_type"   "HomeRailSource",
  "source_slug"   TEXT,
  "take"          INTEGER NOT NULL DEFAULT 15,
  "link_to"       TEXT,
  "is_enabled"    BOOLEAN NOT NULL DEFAULT true,
  "sort_order"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "home_rails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "home_rail_items" (
  "id"         SERIAL NOT NULL,
  "rail_id"    INTEGER NOT NULL,
  "title"      TEXT NOT NULL,
  "subtitle"   TEXT,
  "image_url"  TEXT,
  "alt"        TEXT,
  "link"       TEXT,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "home_rail_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "home_rail_items_rail_id_idx" ON "home_rail_items"("rail_id");

ALTER TABLE "home_rail_items"
  ADD CONSTRAINT "home_rail_items_rail_id_fkey"
  FOREIGN KEY ("rail_id") REFERENCES "home_rails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the three rails the page was rendering from hardcoded queries, so the
-- page looks the same the moment this ships and the editor can then change it.
INSERT INTO "home_rails" ("kind", "title", "source_type", "source_slug", "take", "link_to", "sort_order", "updatedAt")
VALUES
  ('RESIDENCE', 'ویلاهای شمال',        'CITY', 'shomal',    15, '/search/shomal?villa=1', 10, CURRENT_TIMESTAMP),
  ('RESIDENCE', 'اقامتگاه های تهران',  'CITY', 'tehran',    15, '/search/tehran',         20, CURRENT_TIMESTAMP),
  ('RESIDENCE', 'اقامتگاه های بوم گردی', 'TYPE', 'BOOMGARDI', 15, '/search?boomgardi=1',    30, CURRENT_TIMESTAMP);
