-- Taking a review down without destroying it.
--
-- Reviews had no admin surface at all: 9,427 of them, published the moment a
-- guest submits, with no way for the ops team to act on an abusive one, a
-- duplicate, or one written about the wrong listing. The only tool available
-- was DELETE, which is the wrong tool — a review is a guest's statement, and
-- a host who disputes it, or a guest who says theirs was removed unfairly,
-- both need the row to still exist.
--
-- So hiding, the same shape as voiding a payment: the row stays, marked, with
-- a reason and who did it. `hidden_at IS NULL` is the whole public filter.
--
-- Hiding recomputes the listing's stored `average_rating` and `reviews_count`,
-- which are denormalised — a hidden review that still counted toward the
-- average would be hidden from readers and not from the score.

ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "hidden_at"     TIMESTAMP(3);
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "hidden_reason" TEXT;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "hidden_by_id"  INTEGER;

-- The public read is "this listing's visible reviews, newest first".
CREATE INDEX IF NOT EXISTS "reviews_residence_id_hidden_at_idx"
  ON "reviews" ("residence_id", "hidden_at");
