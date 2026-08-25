-- Allow a tag page with no location: the "تگ مادر" (nationwide tag page,
-- /search?pool=1). Odoo's tag_url holds 166 such rows with a null category.
ALTER TABLE "tag_pages" ALTER COLUMN "location_id" DROP NOT NULL;

-- The (location_id, tag_id) unique index does not constrain rows where
-- location_id IS NULL — Postgres treats NULLs as distinct — so a tag could
-- collect several nationwide pages. One per tag:
CREATE UNIQUE INDEX "tag_pages_tag_id_nationwide_key"
  ON "tag_pages"("tag_id") WHERE "location_id" IS NULL;
