-- Deactivating a residence, without deleting its page.
--
-- Until now "غیرفعال کردن" set `published = false`, and every public read
-- filters on that — so the listing's URL started returning 404. That throws
-- away the one thing worth keeping: a page that has been indexed for years,
-- that guests still arrive on from Google and from their own history. The
-- listing being unbookable this month is not a reason for its address to stop
-- existing.
--
-- So the public detail page now renders a DEACTIVATED residence in full, with
-- the booking box replaced by a panel that says it cannot be booked. Search,
-- sitemap, and "اقامتگاه‌های مشابه" keep excluding it — they answer "what can
-- I book", and it cannot.
--
-- Two columns rather than reading the newest state-change log row: the public
-- page already loads the residence row, and `activity_logs.residence_id` has
-- no index, so per-render log lookups would scan a table that only grows.
-- The log still gets the full entry; these carry the current state.

ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "deactivated_at" TIMESTAMP(3);
ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "deactivation_note" TEXT;

-- Residence-scoped log lines exist now (state changes, and the host/rate edits
-- that will follow). The reservation timeline has its index; this is the same
-- read, keyed by listing.
CREATE INDEX IF NOT EXISTS "activity_logs_residence_id_id_idx"
  ON "activity_logs" ("residence_id", "id");
