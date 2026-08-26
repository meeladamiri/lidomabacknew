-- The two "مهم نیست اهل کدوم دیاری" blocks each render an Aparat video beside
-- their text, but the video was a hardcoded <iframe> in components/Home/index.tsx
-- with the videohash inlined. Nothing in the panel pointed at it, so an editor
-- had no way to find or change it.
--
-- The video belongs to the text block it sits next to, so it lives here rather
-- than in home_settings (which holds the separate standalone intro video).

ALTER TABLE "home_desc_sections" ADD COLUMN "video_url" TEXT;

-- Keep the page identical: these are the two hashes that were hardcoded.
UPDATE "home_desc_sections" SET "video_url" = 'https://www.aparat.com/v/lCSq8' WHERE "sort_order" = (
  SELECT MIN("sort_order") FROM "home_desc_sections"
);
UPDATE "home_desc_sections" SET "video_url" = 'https://www.aparat.com/v/73Nt6' WHERE "video_url" IS NULL AND "sort_order" = (
  SELECT MAX("sort_order") FROM "home_desc_sections"
);
