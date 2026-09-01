-- How an announcement looks, and how often it is shown.
--
-- The first version had one look and no frequency: a notice appeared until
-- somebody dismissed it. That is right for a standing notice and wrong for
-- everything else — "پرداخت‌ها از فردا کارت به کارت است" should be seen once
-- and then get out of the way.
--
-- `max_views` is the whole frequency model: NULL means show it every time,
-- 1 means once, n means n times. Counted per browser (localStorage), which is
-- the honest limit — there is no per-account read state, and inventing one
-- that only half works is worse than a rule that says what it does.
--
-- The colours are stored as free text rather than an enum of themes. An ops
-- team writing a notice about a payment change wants it to look different
-- from one about Nowruz pricing, and no fixed set of three themes survives
-- contact with that. The panel offers presets and a picker; the column just
-- holds whatever was chosen.

ALTER TABLE "announcements"
  ADD COLUMN IF NOT EXISTS "max_views"        INTEGER,
  ADD COLUMN IF NOT EXISTS "background_color" TEXT,
  ADD COLUMN IF NOT EXISTS "text_color"       TEXT,
  ADD COLUMN IF NOT EXISTS "title_bold"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "dashed_border"    BOOLEAN NOT NULL DEFAULT false,
  -- A wide banner image is unreadable on a phone and a square one wastes a
  -- desktop. Both optional; whichever is missing falls back to the other.
  ADD COLUMN IF NOT EXISTS "image_url_mobile" TEXT;
