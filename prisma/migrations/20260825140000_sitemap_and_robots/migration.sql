-- Rule-driven sitemap + robots.txt configuration.
-- Nothing is stored per URL: these tables say WHICH families of URLs belong in
-- the sitemap and under what thresholds; the files are generated from live data.

CREATE TYPE "ChangeFreq" AS ENUM ('ALWAYS', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'NEVER');

CREATE TABLE "sitemap_settings" (
  "id"                 INTEGER NOT NULL DEFAULT 1,
  "site_url"           TEXT NOT NULL DEFAULT 'https://lidomatrip.com',
  "allow_indexing"     BOOLEAN NOT NULL DEFAULT true,
  "sitemap_enabled"    BOOLEAN NOT NULL DEFAULT true,
  "robots_enabled"     BOOLEAN NOT NULL DEFAULT true,
  "max_urls_per_file"  INTEGER NOT NULL DEFAULT 45000,
  "robots_extra"       TEXT,
  "crawl_delay"        INTEGER,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sitemap_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sitemap_sections" (
  "id"                  SERIAL NOT NULL,
  "key"                 TEXT NOT NULL,
  "label"               TEXT NOT NULL,
  "is_enabled"          BOOLEAN NOT NULL DEFAULT true,
  "change_freq"         "ChangeFreq" NOT NULL DEFAULT 'WEEKLY',
  "priority"            DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "min_residence_count" INTEGER NOT NULL DEFAULT 0,
  "include_lastmod"     BOOLEAN NOT NULL DEFAULT true,
  "sort_order"          INTEGER NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sitemap_sections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sitemap_sections_key_key" ON "sitemap_sections"("key");

CREATE TABLE "robots_rules" (
  "id"         SERIAL NOT NULL,
  "user_agent" TEXT NOT NULL DEFAULT '*',
  "directive"  TEXT NOT NULL DEFAULT 'Disallow',
  "path"       TEXT NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "note"       TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "robots_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "robots_rules_user_agent_idx" ON "robots_rules"("user_agent");

-- Seed the single settings row.
INSERT INTO "sitemap_settings" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP);

-- Seed the URL families. Keys are matched in code, so they are seeded rather
-- than created by admins. Priorities follow the usual shape: the money pages
-- (listings, city pages) above the long tail.
INSERT INTO "sitemap_sections"
  ("key", "label", "change_freq", "priority", "min_residence_count", "include_lastmod", "sort_order", "updatedAt")
VALUES
  ('static',     'صفحات ثابت',          'MONTHLY', 0.8, 0, false, 1, CURRENT_TIMESTAMP),
  ('locations',  'صفحات شهر و استان',   'DAILY',   0.9, 1, true,  2, CURRENT_TIMESTAMP),
  ('tag-pages',  'صفحات تگ × مکان',     'WEEKLY',  0.7, 3, true,  3, CURRENT_TIMESTAMP),
  ('residences', 'صفحات اقامتگاه',      'DAILY',   0.8, 0, true,  4, CURRENT_TIMESTAMP),
  ('hosts',      'صفحات میزبان',        'WEEKLY',  0.5, 1, true,  5, CURRENT_TIMESTAMP);

-- Default robots rules: keep crawlers out of authenticated and non-content
-- areas. These are the paths that would otherwise waste crawl budget or expose
-- user-scoped pages.
INSERT INTO "robots_rules" ("user_agent", "directive", "path", "note", "sort_order", "updatedAt")
VALUES
  ('*', 'Disallow', '/admin',        'پنل مدیریت', 1, CURRENT_TIMESTAMP),
  ('*', 'Disallow', '/api/',         'API', 2, CURRENT_TIMESTAMP),
  ('*', 'Disallow', '/auth/',        'صفحات ورود و ثبت‌نام', 3, CURRENT_TIMESTAMP),
  ('*', 'Disallow', '/profile',      'ناحیه‌ی کاربری', 4, CURRENT_TIMESTAMP),
  ('*', 'Disallow', '/host/panel',   'پنل میزبان', 5, CURRENT_TIMESTAMP),
  ('*', 'Disallow', '/_next/static/chunks/', 'فایل‌های بیلد', 6, CURRENT_TIMESTAMP);
