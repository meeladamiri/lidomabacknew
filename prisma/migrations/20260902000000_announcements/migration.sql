-- اطلاعیه‌ها — what the ops team wants to tell people on their dashboard.
--
-- The dashboard already read `announcement` and rendered it in a dialog; there
-- was no table behind it and no way to write one, so the field was always
-- null and the feature existed only as dead code on the page.
--
-- Two shapes on purpose, because the two jobs are different:
--   BANNER — a line of text with an optional link. Sits inline on the page,
--            dismissible, for "پرداخت‌ها از فردا کارت به کارت است".
--   MODAL  — opens over the page once. For the rare thing somebody must not
--            scroll past. Abused, it trains people to close dialogs unread,
--            which is why the panel makes it the deliberate choice rather
--            than the default.
--
-- Audience is a filter, not a copy: one row shown to hosts, guests, or both,
-- rather than two rows to keep in step with each other.

CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'HOSTS', 'GUESTS');
CREATE TYPE "AnnouncementStyle"    AS ENUM ('BANNER', 'MODAL');

CREATE TABLE IF NOT EXISTS "announcements" (
  "id"         SERIAL       PRIMARY KEY,
  "title"      TEXT         NOT NULL,
  "body"       TEXT,
  "image_url"  TEXT,
  "link_url"   TEXT,
  "link_label" TEXT,

  "audience"   "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
  "style"      "AnnouncementStyle"    NOT NULL DEFAULT 'BANNER',

  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  -- Both optional. An announcement with no dates runs until switched off,
  -- which is what most of them are; the window is for the ones that should
  -- stop on their own, so nobody has to remember to go and turn them off.
  "starts_at"  TIMESTAMP(3),
  "ends_at"    TIMESTAMP(3),

  -- Lower shows first, so a new urgent one can be put above a standing notice
  -- without editing the other.
  "sort_order" INTEGER      NOT NULL DEFAULT 0,

  "created_by_id" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The dashboard read: active, in window, for this audience, in order.
CREATE INDEX IF NOT EXISTS "announcements_is_active_audience_idx"
  ON "announcements" ("is_active", "audience", "sort_order");

ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
