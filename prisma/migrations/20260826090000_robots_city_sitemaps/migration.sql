-- List each per-city sitemap in robots.txt, as shab.ir does.
ALTER TABLE "sitemap_settings"
  ADD COLUMN "list_city_sitemaps_in_robots" BOOLEAN NOT NULL DEFAULT true;
