-- جاذبه‌های گردشگری — the catalogue, recovered from Odoo.
--
-- `residence_distances` stores a free-text `place_name`: 14,866 rows across
-- 1,212 listings, 4,040 distinct spellings of what are really the same few
-- hundred places. "ایستگاه راه آهن اصفهان" appears on 82 listings as 82
-- unrelated strings.
--
-- It was not free text in Odoo. `x_residence_place_distance.x_place` is a
-- foreign key to `x_attractions`, which holds 18,448 places with a city and —
-- on 720 of them — real coordinates. The migration flattened the key into its
-- label and left the catalogue behind, which is why nothing could answer "what
-- is near this listing".
--
-- So the catalogue comes across, and a distance row can point at it while
-- keeping the text it already displays. Both, not either: the text is what
-- 14,866 existing rows have, and rewriting them to catalogue entries would be
-- a guess about which of 4,040 spellings meant which of 18,448 places.
--
-- Coordinates are nullable and mostly absent. That is the honest state of the
-- data and it decides how "nearby" works: proximity where both sides have
-- coordinates, same-city everywhere else. A NOT NULL here would mean either
-- discarding 17,728 real places or inventing positions for them.

CREATE TABLE IF NOT EXISTS "attractions" (
  "id"          SERIAL       PRIMARY KEY,
  -- Legacy x_attractions.id, so a re-run of the import updates rather than
  -- duplicates, and so a row can be traced back to what it came from.
  "odoo_id"     INTEGER      UNIQUE,
  "name"        TEXT         NOT NULL,
  "latitude"    DOUBLE PRECISION,
  "longitude"   DOUBLE PRECISION,
  "location_id" INTEGER,
  "is_active"   BOOLEAN      NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The two reads: "attractions in this city" for the picker, and "attractions
-- with coordinates" for the proximity search.
CREATE INDEX IF NOT EXISTS "attractions_location_id_idx"  ON "attractions" ("location_id");
CREATE INDEX IF NOT EXISTS "attractions_latitude_longitude_idx" ON "attractions" ("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "attractions_name_idx" ON "attractions" ("name");

ALTER TABLE "attractions"
  ADD CONSTRAINT "attractions_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A distance row may now name a catalogue entry. Nullable, and ON DELETE SET
-- NULL: removing a place from the catalogue must not delete the distances
-- listings already show, it should just leave them as the text they always
-- were.
ALTER TABLE "residence_distances" ADD COLUMN IF NOT EXISTS "attraction_id" INTEGER;

ALTER TABLE "residence_distances"
  ADD CONSTRAINT "residence_distances_attraction_id_fkey"
  FOREIGN KEY ("attraction_id") REFERENCES "attractions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "residence_distances_attraction_id_idx"
  ON "residence_distances" ("attraction_id");
