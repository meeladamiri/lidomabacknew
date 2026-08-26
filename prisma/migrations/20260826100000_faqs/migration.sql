-- "سوالات متداول" as data instead of four hardcoded strings in the search
-- service. Placeholders keep the interpolation those strings had, so one
-- question can still serve all 440 city pages.

CREATE TYPE "FaqScope" AS ENUM (
  'GLOBAL', 'SEARCH', 'LOCATION', 'TAG', 'TAG_LOCATION', 'RESIDENCE', 'PAGE'
);

CREATE TABLE "faqs" (
  "id"          SERIAL NOT NULL,
  "scope"       "FaqScope" NOT NULL DEFAULT 'SEARCH',
  "location_id" INTEGER,
  "tag_id"      INTEGER,
  "path"        TEXT,
  "question"    TEXT NOT NULL,
  "answer"      TEXT NOT NULL,
  "is_active"   BOOLEAN NOT NULL DEFAULT true,
  "sort_order"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "faqs_scope_idx" ON "faqs"("scope");
CREATE INDEX "faqs_location_id_idx" ON "faqs"("location_id");
CREATE INDEX "faqs_tag_id_idx" ON "faqs"("tag_id");

ALTER TABLE "faqs" ADD CONSTRAINT "faqs_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_tag_id_fkey"
  FOREIGN KEY ("tag_id") REFERENCES "seo_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The four questions the search service used to build inline, moved across
-- verbatim with {location} where the place name was interpolated. Seeding them
-- means the live pages keep the same content through this change.
INSERT INTO "faqs" ("scope", "question", "answer", "sort_order", "updatedAt") VALUES
('SEARCH',
 'چطور در {location} اقامتگاه رزرو کنم؟',
 'کافیه از بین اقامتگاه‌های {location} در همین صفحه، مورد دلخواهتون رو انتخاب کنید، وارد صفحه‌ی اقامتگاه بشید و تاریخ ورود و خروج رو مشخص و درخواست رزرو رو رایگان ثبت کنید. تیم پشتیبانی لیدوماتریپ هم به‌صورت ۲۴ ساعته پاسخگوی شماست.',
 1, CURRENT_TIMESTAMP),
('SEARCH',
 'قیمت اجاره اقامتگاه در {location} شبی چنده؟',
 'قیمت بر اساس نوع اقامتگاه، ظرفیت، امکانات و فصل سفر متفاوته. با فیلتر «قیمت برای یک شب» در همین صفحه می‌تونید بازه‌ی قیمتی موردنظرتون رو مشخص کنید و نتایج رو مقایسه کنید.',
 2, CURRENT_TIMESTAMP),
('SEARCH',
 'آیا رزرو در لیدوماتریپ قطعیه و ضمانت داره؟',
 'بله — لیدوماتریپ صحت اطلاعات اقامتگاه، تحویل به‌موقع و نظافت رو تضمین می‌کنه و برای هر رزرو فاکتور رسمی صادر می‌شه. در صورت بروز هر مشکلی، پشتیبانی ۲۴ ساعته پیگیری می‌کنه.',
 3, CURRENT_TIMESTAMP),
('SEARCH',
 'امکان کنسل‌کردن رزرو در {location} هست؟',
 'بله، طبق سیاست کنسلی هر اقامتگاه (که در صفحه‌ی همون اقامتگاه ذکر شده) می‌تونید رزرو رو لغو کنید. جزئیات کامل در صفحه‌ی «قوانین کنسلی رزرو» سایت اومده.',
 4, CURRENT_TIMESTAMP);
