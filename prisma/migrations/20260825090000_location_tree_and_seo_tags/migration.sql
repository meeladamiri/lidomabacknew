-- Location tree + data-driven SEO tags.
--
-- The `cities` table is RENAMED (never recreated) so every city id survives:
-- residences.location_id keeps pointing at the same rows and every indexed
-- /search/<title_en> URL keeps resolving to the same place. Provinces are
-- merged in as PROVINCE rows with fresh ids (cities max id 519, provinces max
-- id 28 — they would otherwise collide).
--
-- Verified before/after with scripts/verify-location-slugs.ts.

-- ---------------------------------------------------------------- enum
CREATE TYPE "LocationType" AS ENUM ('COUNTRY', 'PROVINCE', 'CITY', 'REGION', 'VILLAGE', 'NEIGHBORHOOD');

-- ------------------------------------------------- cities -> locations
ALTER TABLE "cities" RENAME TO "locations";
ALTER SEQUENCE "cities_id_seq" RENAME TO "locations_id_seq";
ALTER INDEX "cities_pkey" RENAME TO "locations_pkey";

ALTER TABLE "locations"
  ADD COLUMN "odoo_id"       INTEGER,
  ADD COLUMN "type"          "LocationType" NOT NULL DEFAULT 'CITY',
  ADD COLUMN "parent_id"     INTEGER,
  ADD COLUMN "canonical_id"  INTEGER,
  ADD COLUMN "banner_url"    TEXT,
  ADD COLUMN "is_active"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "is_published"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "is_primary"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sort_order"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "popular_index" INTEGER,
  ADD COLUMN "shomal_index"  INTEGER,
  ADD COLUMN "keywords"      TEXT,
  -- dropped at the end of this migration; only used to map old province ids
  ADD COLUMN "legacy_province_id" INTEGER;

-- --------------------------------------------------------- location_seo
CREATE TABLE "location_seo" (
  "id"               SERIAL NOT NULL,
  "location_id"      INTEGER NOT NULL,
  "residence_type"   "ResidenceType",
  "page_title"       TEXT,
  "meta_title"       TEXT,
  "meta_description" TEXT,
  "meta_keywords"    TEXT,
  "content_title"    TEXT,
  "content_html"     TEXT,
  "phone"            TEXT,
  "show_phone"       BOOLEAN NOT NULL DEFAULT false,
  "show_phone_from"  INTEGER,
  "show_phone_to"    INTEGER,
  "show_in_homepage" BOOLEAN NOT NULL DEFAULT false,
  "homepage_index"   INTEGER,
  CONSTRAINT "location_seo_pkey" PRIMARY KEY ("id")
);

-- Carry the already-migrated city SEO across into the default (NULL) set.
INSERT INTO "location_seo" ("location_id", "residence_type", "meta_title", "meta_description", "content_title", "content_html")
SELECT "id", NULL, "meta_title", "meta_description", "content_title", "content_html"
FROM "locations"
WHERE "meta_title" IS NOT NULL OR "meta_description" IS NOT NULL
   OR "content_title" IS NOT NULL OR "content_html" IS NOT NULL;

-- ------------------------------------------- provinces -> PROVINCE rows
-- NOTE: timestamp columns are camelCase here — the original models declared
-- createdAt/updatedAt without @map, so Prisma never snake_cased them.
INSERT INTO "locations" ("name", "title_en", "latitude", "longitude", "type", "legacy_province_id", "createdAt", "updatedAt")
SELECT "name", "title_en", "latitude", "longitude", 'PROVINCE', "id", "createdAt", "updatedAt"
FROM "provinces";

INSERT INTO "location_seo" ("location_id", "residence_type", "meta_title", "meta_description", "content_title", "content_html")
SELECT l."id", NULL, p."meta_title", p."meta_description", p."content_title", p."content_html"
FROM "locations" l
JOIN "provinces" p ON p."id" = l."legacy_province_id"
WHERE p."meta_title" IS NOT NULL OR p."meta_description" IS NOT NULL
   OR p."content_title" IS NOT NULL OR p."content_html" IS NOT NULL;

-- province_id becomes the breadcrumb parent
UPDATE "locations" c
SET "parent_id" = p."id"
FROM "locations" p
WHERE p."legacy_province_id" = c."province_id"
  AND c."province_id" IS NOT NULL;

ALTER TABLE "locations" DROP CONSTRAINT "cities_province_id_fkey";
DROP INDEX "cities_province_id_idx";
ALTER TABLE "locations"
  DROP COLUMN "legacy_province_id",
  DROP COLUMN "province_id",
  DROP COLUMN "meta_title",
  DROP COLUMN "meta_description",
  DROP COLUMN "content_title",
  DROP COLUMN "content_html";

DROP TABLE "provinces";

-- ------------------------------------------------ city_id -> location_id
ALTER TABLE "residences" RENAME COLUMN "city_id" TO "location_id";
ALTER TABLE "residences" RENAME CONSTRAINT "residences_city_id_fkey" TO "residences_location_id_fkey";
ALTER INDEX "residences_city_id_idx" RENAME TO "residences_location_id_idx";

ALTER TABLE "users" RENAME COLUMN "city_id" TO "location_id";
ALTER TABLE "users" RENAME CONSTRAINT "users_city_id_fkey" TO "users_location_id_fkey";
ALTER INDEX "users_city_id_idx" RENAME TO "users_location_id_idx";

ALTER TABLE "residence_cities" RENAME TO "residence_locations";
ALTER SEQUENCE "residence_cities_id_seq" RENAME TO "residence_locations_id_seq";
ALTER INDEX "residence_cities_pkey" RENAME TO "residence_locations_pkey";
ALTER TABLE "residence_locations" RENAME COLUMN "city_id" TO "location_id";
ALTER TABLE "residence_locations" RENAME CONSTRAINT "residence_cities_city_id_fkey" TO "residence_locations_location_id_fkey";
ALTER TABLE "residence_locations" RENAME CONSTRAINT "residence_cities_residence_id_fkey" TO "residence_locations_residence_id_fkey";
ALTER INDEX "residence_cities_city_id_idx" RENAME TO "residence_locations_location_id_idx";
ALTER INDEX "residence_cities_residence_id_city_id_key" RENAME TO "residence_locations_residence_id_location_id_key";

ALTER TABLE "peak_day_cities" RENAME TO "peak_day_locations";
ALTER SEQUENCE "peak_day_cities_id_seq" RENAME TO "peak_day_locations_id_seq";
ALTER INDEX "peak_day_cities_pkey" RENAME TO "peak_day_locations_pkey";
ALTER TABLE "peak_day_locations" RENAME COLUMN "city_id" TO "location_id";
ALTER TABLE "peak_day_locations" RENAME CONSTRAINT "peak_day_cities_city_id_fkey" TO "peak_day_locations_location_id_fkey";
ALTER TABLE "peak_day_locations" RENAME CONSTRAINT "peak_day_cities_peak_day_id_fkey" TO "peak_day_locations_peak_day_id_fkey";
ALTER INDEX "peak_day_cities_peak_day_id_city_id_key" RENAME TO "peak_day_locations_peak_day_id_location_id_key";

-- ------------------------------------------- new location constraints
CREATE UNIQUE INDEX "locations_odoo_id_key" ON "locations"("odoo_id");
CREATE INDEX "locations_type_idx"      ON "locations"("type");
CREATE INDEX "locations_parent_id_idx" ON "locations"("parent_id");
CREATE INDEX "locations_title_en_idx"  ON "locations"("title_en");

ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "locations" ADD CONSTRAINT "locations_canonical_id_fkey"
  FOREIGN KEY ("canonical_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "location_seo" ADD CONSTRAINT "location_seo_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "location_seo_location_id_residence_type_key"
  ON "location_seo"("location_id", "residence_type");
-- Postgres treats NULLs as distinct, so the index above would allow several
-- default rows per location. This partial index closes that hole; Prisma does
-- not model it, so keep it when hand-writing future migrations.
CREATE UNIQUE INDEX "location_seo_location_id_default_key"
  ON "location_seo"("location_id") WHERE "residence_type" IS NULL;

-- ------------------------------------------------------ location_includes
CREATE TABLE "location_includes" (
  "id"        SERIAL NOT NULL,
  "parent_id" INTEGER NOT NULL,
  "child_id"  INTEGER NOT NULL,
  CONSTRAINT "location_includes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "location_includes_parent_id_child_id_key" ON "location_includes"("parent_id", "child_id");
CREATE INDEX "location_includes_child_id_idx" ON "location_includes"("child_id");
ALTER TABLE "location_includes" ADD CONSTRAINT "location_includes_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "location_includes" ADD CONSTRAINT "location_includes_child_id_fkey"
  FOREIGN KEY ("child_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------- seo_tags
CREATE TABLE "seo_tags" (
  "id"               SERIAL NOT NULL,
  "odoo_id"          INTEGER,
  "key"              TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "short_label"      TEXT,
  "description"      TEXT,
  "residence_type"   "ResidenceType",
  "price_min"        DOUBLE PRECISION,
  "price_max"        DOUBLE PRECISION,
  "match_is_fast"    BOOLEAN NOT NULL DEFAULT false,
  "content_title"    TEXT,
  "content_html"     TEXT,
  "image_url"        TEXT,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "is_suggested"     BOOLEAN NOT NULL DEFAULT false,
  "show_in_homepage" BOOLEAN NOT NULL DEFAULT false,
  "show_in_shomal"   BOOLEAN NOT NULL DEFAULT false,
  "sort_order"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seo_tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seo_tags_odoo_id_key" ON "seo_tags"("odoo_id");
CREATE UNIQUE INDEX "seo_tags_key_key"     ON "seo_tags"("key");

CREATE TABLE "seo_tag_conditions" (
  "id"          SERIAL NOT NULL,
  "tag_id"      INTEGER NOT NULL,
  "group_index" INTEGER NOT NULL DEFAULT 0,
  "amenity_key" TEXT,
  "rule_key"    TEXT,
  "value_name"  TEXT,
  CONSTRAINT "seo_tag_conditions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "seo_tag_conditions_tag_id_idx" ON "seo_tag_conditions"("tag_id");
ALTER TABLE "seo_tag_conditions" ADD CONSTRAINT "seo_tag_conditions_tag_id_fkey"
  FOREIGN KEY ("tag_id") REFERENCES "seo_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -------------------------------------------------------------- tag_pages
CREATE TABLE "tag_pages" (
  "id"               SERIAL NOT NULL,
  "odoo_id"          INTEGER,
  "location_id"      INTEGER NOT NULL,
  "tag_id"           INTEGER,
  "legacy_path"      TEXT,
  "meta_title"       TEXT,
  "meta_description" TEXT,
  "meta_keywords"    TEXT,
  "content_title"    TEXT,
  "content_html"     TEXT,
  "show_in_sitemap"  BOOLEAN NOT NULL DEFAULT false,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "residence_count"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tag_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tag_pages_odoo_id_key"     ON "tag_pages"("odoo_id");
CREATE UNIQUE INDEX "tag_pages_legacy_path_key" ON "tag_pages"("legacy_path");
CREATE UNIQUE INDEX "tag_pages_location_id_tag_id_key" ON "tag_pages"("location_id", "tag_id");
CREATE INDEX "tag_pages_tag_id_idx" ON "tag_pages"("tag_id");
ALTER TABLE "tag_pages" ADD CONSTRAINT "tag_pages_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tag_pages" ADD CONSTRAINT "tag_pages_tag_id_fkey"
  FOREIGN KEY ("tag_id") REFERENCES "seo_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
