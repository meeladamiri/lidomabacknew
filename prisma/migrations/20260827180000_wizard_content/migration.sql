-- Host submission wizard content.
--
-- The step titles were a hardcoded map in the front's bundle, the option tiles
-- were three hardcoded arrays sharing one placeholder image, and there was
-- nowhere at all to explain a step. Odoo had this content configurable; the
-- migration off it did not carry that surface over.
--
-- Seeded below with exactly what the front ships today, so nothing changes
-- until somebody edits it in the panel.

CREATE TYPE "WizardOptionKind" AS ENUM (
  'RES_TYPE',  -- step 1: the kind of place
  'REGION',    -- step 2: which part of the country
  'RENT_TYPE'  -- step 3: whole place or per room
);

CREATE TABLE "wizard_steps" (
  "id"          SERIAL NOT NULL,
  -- Matches the ?step= parameter the wizard runs on.
  "step"        INTEGER NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "help_text"   TEXT,
  "icon_url"    TEXT,
  "is_enabled"  BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wizard_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wizard_steps_step_key" ON "wizard_steps"("step");

CREATE TABLE "wizard_options" (
  "id"          SERIAL NOT NULL,
  "kind"        "WizardOptionKind" NOT NULL,
  -- The string written onto the residence. Not a foreign key: renaming an
  -- option must not rewrite residences already saved under the old name.
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "image_url"   TEXT,
  "sort_order"  INTEGER NOT NULL DEFAULT 0,
  "is_active"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wizard_options_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wizard_options_kind_sort_order_idx"
  ON "wizard_options"("kind", "sort_order");

-- ---------------------------------------------------------------- seed ---

INSERT INTO "wizard_steps" ("step", "title", "updatedAt") VALUES
  (1,  'چه نوع اقامتگاهی دارید ؟',                                  CURRENT_TIMESTAMP),
  (2,  'اقامتگاه شما در چه منطقه ای قرار دارد ؟',                    CURRENT_TIMESTAMP),
  (3,  'اقامتگاه به چه شکل پذیرای مهمانان است ؟',                    CURRENT_TIMESTAMP),
  (4,  'مشخصات اقامتگاه خود را وارد کنید',                           CURRENT_TIMESTAMP),
  (5,  'ظرفیت اقامتگاه خود را مشخص کنید',                            CURRENT_TIMESTAMP),
  (6,  'امکانات اقامتگاه را انتخاب کنید',                            CURRENT_TIMESTAMP),
  (7,  'آدرس اقامتگاه خود را وارد کنید',                             CURRENT_TIMESTAMP),
  (8,  'محل دقیق اقامتگاه',                                          CURRENT_TIMESTAMP),
  (9,  'تصاویر اقامتگاه خود را بارگذاری کنید',                       CURRENT_TIMESTAMP),
  (10, 'مدارک مربوط به اقامتگاه خود را بارگذاری کنید',               CURRENT_TIMESTAMP),
  (11, 'نرخ گذاری کلی',                                              CURRENT_TIMESTAMP),
  (12, 'قوانین و مقررات اقامتگاه خود را مشخص کنید',                  CURRENT_TIMESTAMP),
  (13, 'یکی از حالت های زیر را برای  قوانین لغو رزرو انتخاب کنید',   CURRENT_TIMESTAMP),
  (14, 'قوانین و مقررات اقامتگاه',                                   CURRENT_TIMESTAMP);

INSERT INTO "wizard_options" ("kind", "name", "description", "image_url", "sort_order", "updatedAt") VALUES
  ('RES_TYPE',  'سوئیت',              NULL, '/assets/res-placeholder.jpg', 1, CURRENT_TIMESTAMP),
  ('RES_TYPE',  'اقامتگاه بوم‌گردی',  NULL, '/assets/res-placeholder.jpg', 2, CURRENT_TIMESTAMP),

  ('REGION',    'شمال',               NULL, '/assets/res-placeholder.jpg', 1, CURRENT_TIMESTAMP),
  ('REGION',    'تهران و اطراف',      NULL, '/assets/res-placeholder.jpg', 2, CURRENT_TIMESTAMP),
  ('REGION',    'جنوب',               NULL, '/assets/res-placeholder.jpg', 3, CURRENT_TIMESTAMP),
  ('REGION',    'سایر شهرها',         NULL, '/assets/res-placeholder.jpg', 4, CURRENT_TIMESTAMP),

  ('RENT_TYPE', 'اجاره کل اقامتگاه',  'کل اقامتگاه در اختیار یک مهمان قرار می‌گیرد', '/assets/res-placeholder.jpg', 1, CURRENT_TIMESTAMP),
  ('RENT_TYPE', 'اجاره اتاقی',        'اتاق‌های اقامتگاه به‌صورت جداگانه رزرو می‌شوند', '/assets/res-placeholder.jpg', 2, CURRENT_TIMESTAMP);
