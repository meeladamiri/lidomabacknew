-- Image sitemap settings.
ALTER TABLE "sitemap_settings"
  ADD COLUMN "images_enabled"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "image_url_mode"        TEXT    NOT NULL DEFAULT 'optimizer',
  ADD COLUMN "image_optimizer_width" INTEGER NOT NULL DEFAULT 1080;

-- Blocking JS/CSS stops Google rendering the page, which is worse than the
-- crawl budget it saves. Google's own guidance is explicit about this, and the
-- seeded rule was a mistake.
DELETE FROM "robots_rules" WHERE "path" = '/_next/static/chunks/';

-- Explicitly allow what crawlers need to render, plus the listing pages.
-- Allow lines are ordered after the Disallow lines within the "*" group.
INSERT INTO "robots_rules" ("user_agent", "directive", "path", "note", "sort_order", "updatedAt")
VALUES
  ('*', 'Disallow', '/payment/',        'مسیر پرداخت', 7,  CURRENT_TIMESTAMP),
  ('*', 'Disallow', '/chat',            'گفتگو', 8,  CURRENT_TIMESTAMP),
  ('*', 'Disallow', '*/reserve/*',      'مراحل رزرو', 9,  CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/rentals/',        'صفحات اقامتگاه', 20, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/search/',         'صفحات سرچ شهر و تگ', 21, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/_next/static/',   'JS و CSS — گوگل برای رندر لازم داره', 22, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/_next/image',     'عکس‌های بهینه‌شده', 23, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.css',           '', 24, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.js',            '', 25, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.png',           '', 26, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.jpg',           '', 27, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.jpeg',          '', 28, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.webp',          '', 29, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.svg',           '', 30, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.woff2',         '', 31, CURRENT_TIMESTAMP),
  ('*', 'Allow',    '/*.ico',           '', 32, CURRENT_TIMESTAMP);

-- Keep guest/host avatars out of image search: they are people's photos, not
-- content, and they carry no SEO value.
INSERT INTO "robots_rules" ("user_agent", "directive", "path", "note", "sort_order", "updatedAt")
VALUES
  ('Googlebot-Image', 'Disallow', '/uploads/avatars/', 'آواتار کاربران', 1, CURRENT_TIMESTAMP),
  ('Googlebot-Image', 'Disallow', '/uploads/national-cards/', 'مدارک کاربران', 2, CURRENT_TIMESTAMP),
  ('msnbot-media',    'Disallow', '/uploads/avatars/', 'آواتار کاربران', 1, CURRENT_TIMESTAMP),
  ('msnbot-media',    'Disallow', '/uploads/national-cards/', 'مدارک کاربران', 2, CURRENT_TIMESTAMP);

-- The image sitemap gets its own section so it can be tuned independently.
INSERT INTO "sitemap_sections"
  ("key", "label", "change_freq", "priority", "min_residence_count", "include_lastmod", "sort_order", "updatedAt")
VALUES
  ('images', 'عکس‌های اقامتگاه', 'WEEKLY', 0.6, 0, false, 6, CURRENT_TIMESTAMP);
