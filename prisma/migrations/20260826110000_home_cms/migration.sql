-- The home page CMS. Odoo's x_homepage_* tables were never migrated, so
-- pages/index.tsx has been serving an empty bundle since the cutover.
-- Images lived as binary blobs in the Odoo database; these columns hold the
-- object-storage URLs the migration script uploads them to.

CREATE TABLE "home_settings" (
  "id"                     INTEGER NOT NULL DEFAULT 1,
  "hero_title"             TEXT,
  "hero_subtitle"          TEXT,
  "hero_title_mobile"      TEXT,
  "hero_subtitle_mobile"   TEXT,
  "hero_image_url"         TEXT,
  "hero_image_mobile_url"  TEXT,
  "pc_title_color"         TEXT,
  "pc_subtitle_color"      TEXT,
  "pc_title_size"          INTEGER,
  "pc_subtitle_size"       INTEGER,
  "mobile_title_color"     TEXT,
  "mobile_subtitle_color"  TEXT,
  "mobile_title_size"      INTEGER,
  "mobile_subtitle_size"   INTEGER,
  "search_background"      TEXT,
  "search_border_color"    TEXT,
  "h1"                     TEXT,
  "meta_title"             TEXT,
  "meta_description"       TEXT,
  "meta_keywords"          TEXT,
  "app_enabled"            BOOLEAN NOT NULL DEFAULT false,
  "app_title"              TEXT,
  "app_subtitle"           TEXT,
  "app_image_url"          TEXT,
  "app_bazaar_url"         TEXT,
  "app_myket_url"          TEXT,
  "app_sibapp_url"         TEXT,
  "app_direct_url"         TEXT,
  "video_enabled"          BOOLEAN NOT NULL DEFAULT false,
  "video_title"            TEXT,
  "video_description"      TEXT,
  "video_url"              TEXT,
  "video_poster_url"       TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "home_sections" (
  "key"           TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "title"         TEXT,
  "subtitle"      TEXT,
  "heading_level" INTEGER NOT NULL DEFAULT 2,
  "is_enabled"    BOOLEAN NOT NULL DEFAULT true,
  "sort_order"    INTEGER NOT NULL DEFAULT 0,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_sections_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "home_banners" (
  "id"               SERIAL NOT NULL,
  "odoo_id"          INTEGER,
  "name"             TEXT NOT NULL,
  "link"             TEXT,
  "pc_image_url"     TEXT,
  "mobile_image_url" TEXT,
  "alt"              TEXT,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "sort_order"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_banners_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_banners_odoo_id_key" ON "home_banners"("odoo_id");

CREATE TABLE "home_desc_sections" (
  "id"               SERIAL NOT NULL,
  "odoo_id"          INTEGER,
  "title"            TEXT,
  "content_html"     TEXT,
  "pc_image_url"     TEXT,
  "mobile_image_url" TEXT,
  "alt"              TEXT,
  "heading_level"    INTEGER NOT NULL DEFAULT 2,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "sort_order"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_desc_sections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_desc_sections_odoo_id_key" ON "home_desc_sections"("odoo_id");

CREATE TABLE "home_residence_types" (
  "id"             SERIAL NOT NULL,
  "odoo_id"        INTEGER,
  "title"          TEXT NOT NULL,
  "subtitle"       TEXT,
  "image_url"      TEXT,
  "alt"            TEXT,
  "link"           TEXT,
  "show_in_mobile" BOOLEAN NOT NULL DEFAULT true,
  "is_active"      BOOLEAN NOT NULL DEFAULT true,
  "sort_order"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_residence_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_residence_types_odoo_id_key" ON "home_residence_types"("odoo_id");

CREATE TABLE "home_sliders" (
  "id"         SERIAL NOT NULL,
  "odoo_id"    INTEGER,
  "title"      TEXT,
  "image_url"  TEXT,
  "alt"        TEXT,
  "link"       TEXT,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_sliders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_sliders_odoo_id_key" ON "home_sliders"("odoo_id");

CREATE TABLE "home_trust_boxes" (
  "id"         SERIAL NOT NULL,
  "odoo_id"    INTEGER,
  "title"      TEXT NOT NULL,
  "subtitle"   TEXT,
  "icon_url"   TEXT,
  "alt"        TEXT,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_trust_boxes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_trust_boxes_odoo_id_key" ON "home_trust_boxes"("odoo_id");

CREATE TABLE "home_articles" (
  "id"               SERIAL NOT NULL,
  "odoo_id"          INTEGER,
  "title"            TEXT NOT NULL,
  "link"             TEXT,
  "image_url"        TEXT,
  "alt"              TEXT,
  "author_name"      TEXT,
  "author_image_url" TEXT,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "sort_order"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_articles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_articles_odoo_id_key" ON "home_articles"("odoo_id");

CREATE TABLE "home_search_suggestions" (
  "id"         SERIAL NOT NULL,
  "label"      TEXT NOT NULL,
  "href"       TEXT NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "home_search_suggestions_pkey" PRIMARY KEY ("id")
);

INSERT INTO "home_settings" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP);

-- Section keys are matched in code, so they are seeded rather than created.
-- Order mirrors the page top to bottom.
INSERT INTO "home_sections" ("key", "label", "sort_order", "updatedAt") VALUES
  ('types',      'دسته‌بندی نوع اقامتگاه', 1,  CURRENT_TIMESTAMP),
  ('suggest',    'پیشنهادات فصل',          2,  CURRENT_TIMESTAMP),
  ('popular',    'مقصدهای محبوب',          3,  CURRENT_TIMESTAMP),
  ('selected',   'اقامتگاه‌های منتخب',      4,  CURRENT_TIMESTAMP),
  ('taste',      'متناسب با سلیقه شما',    5,  CURRENT_TIMESTAMP),
  ('fast',       'رزرو آنی',               6,  CURRENT_TIMESTAMP),
  ('discount',   'تخفیفات ویژه',           7,  CURRENT_TIMESTAMP),
  ('economical', 'اقامتگاه‌های اقتصادی',    8,  CURRENT_TIMESTAMP),
  ('boomgardi',  'اقامتگاه‌های بوم‌گردی',    9,  CURRENT_TIMESTAMP),
  ('hotel',      'هتل‌های منتخب',          10, CURRENT_TIMESTAMP),
  ('articles',   'مقالات راهنمای سفر',     11, CURRENT_TIMESTAMP),
  ('faq',        'سوالات متداول',          12, CURRENT_TIMESTAMP);
