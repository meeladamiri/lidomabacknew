-- Alt text for residence photos.
--
-- `title` is the caption a visitor reads; `alt` is the description of the
-- picture itself — what a screen reader announces and what Google indexes when
-- the file does not load. Reusing one column for both would mean choosing
-- which of the two jobs to do badly.
--
-- Additive: an existing row keeps NULL, which is exactly "nobody has written
-- one yet".

ALTER TABLE "residence_images" ADD COLUMN IF NOT EXISTS "alt" TEXT;
