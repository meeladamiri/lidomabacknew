-- Per-city sitemap files, following shab.ir: one file per city holding that
-- city's search page, its tag pages, and its listings — so Search Console
-- reports indexing per city instead of per content type.
ALTER TABLE "sitemap_sections"
  ADD COLUMN "tag_priority"        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN "tag_change_freq"     "ChangeFreq"     NOT NULL DEFAULT 'DAILY',
  ADD COLUMN "listing_priority"    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "listing_change_freq" "ChangeFreq"     NOT NULL DEFAULT 'MONTHLY';

-- The city files replace the three flat per-type sections. Those are disabled
-- rather than deleted, so switching back is a toggle, not a migration.
UPDATE "sitemap_sections" SET "is_enabled" = false
  WHERE "key" IN ('locations', 'tag-pages');

INSERT INTO "sitemap_sections"
  ("key", "label", "change_freq", "priority", "min_residence_count",
   "include_lastmod", "sort_order", "updatedAt")
VALUES
  ('cities', 'سایت‌مپ هر شهر', 'DAILY', 1.0, 1, true, 2, CURRENT_TIMESTAMP);

-- The flat residences section now only carries listings no city file covers.
UPDATE "sitemap_sections"
   SET "label" = 'اقامتگاه‌های بدون شهر'
 WHERE "key" = 'residences';

-- Static pages: shab calls this main-pages and keeps it at a high weight.
UPDATE "sitemap_sections"
   SET "label" = 'صفحات اصلی', "priority" = 1.0, "change_freq" = 'DAILY'
 WHERE "key" = 'static';
