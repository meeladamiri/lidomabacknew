-- Which cities an attraction is relevant to.
--
-- The first import read `x_attractions.x_city_id` as "where this place is".
-- It is not. It is the city of the *listing that referenced it*, which is why
-- "ایستگاه راه آهن اصفهان" arrived attributed to 28 cities including
-- خور و بیابانک and سمیرم, and why کاخ گلستان — which is in Tehran — was
-- recorded once under تهران and once under ورامین.
--
-- Read as location that column is wrong. Read as *relevance* it is exactly
-- right, and it is the more useful fact: "places that listings in this city
-- actually point their guests at" is a better suggestion than "places whose
-- centroid is inside this city's boundary".
--
-- So the attraction becomes one row per name, and the attributions move here,
-- where a place is allowed to matter to more than one city.

CREATE TABLE IF NOT EXISTS "attraction_cities" (
  "attraction_id" INTEGER NOT NULL,
  "location_id"   INTEGER NOT NULL,
  -- How many Odoo rows made this attribution. A place referenced by forty
  -- listings in a city outranks one referenced once.
  "weight"        INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "attraction_cities_pkey" PRIMARY KEY ("attraction_id", "location_id")
);

-- The read is always "what is relevant to this city", so the location leads.
CREATE INDEX IF NOT EXISTS "attraction_cities_location_id_weight_idx"
  ON "attraction_cities" ("location_id", "weight" DESC);

ALTER TABLE "attraction_cities"
  ADD CONSTRAINT "attraction_cities_attraction_id_fkey"
  FOREIGN KEY ("attraction_id") REFERENCES "attractions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attraction_cities"
  ADD CONSTRAINT "attraction_cities_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
