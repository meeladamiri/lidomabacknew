-- A review is two things to moderate, not one.
--
-- Earlier today this table got `hidden_at` — one flag for the whole row. The
-- panel's design makes clear that is not the shape of the problem: the guest's
-- comment and the host's reply are approved separately, each carries its own
-- badge, and the list's single most useful state is "the guest's review is
-- already live and the host has just replied" — which one flag cannot say.
--
-- So each part gets a status. The three renames below are of columns added a
-- few hours ago with zero non-null values anywhere; nothing is deployed
-- against them, and a rename cannot lose data in any case. They keep serving
-- as the audit trail, now for the comment specifically.
--
-- Existing rows are live on the site right now, so they backfill to PUBLISHED.
-- Defaulting them to PENDING would take 9,427 real reviews off the site in one
-- statement.

CREATE TYPE "ReviewModerationStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

ALTER TABLE "reviews" RENAME COLUMN "hidden_at"     TO "moderated_at";
ALTER TABLE "reviews" RENAME COLUMN "hidden_reason" TO "moderation_note";
ALTER TABLE "reviews" RENAME COLUMN "hidden_by_id"  TO "moderated_by_id";

ALTER TABLE "reviews"
  ADD COLUMN "comment_status" "ReviewModerationStatus" NOT NULL DEFAULT 'PENDING',
  -- Null means the host has not replied. An empty reply and an unreviewed one
  -- are different facts, and a NOT NULL default would collapse them.
  ADD COLUMN "host_answer_status" "ReviewModerationStatus",
  ADD COLUMN "host_answered_at" TIMESTAMP(3),
  ADD COLUMN "host_answer_moderated_at" TIMESTAMP(3);

-- Everything already on the site stays on the site.
UPDATE "reviews" SET "comment_status" = 'PUBLISHED' WHERE "moderated_at" IS NULL;
UPDATE "reviews" SET "comment_status" = 'REJECTED'  WHERE "moderated_at" IS NOT NULL;

-- A reply that exists is a reply that was visible, so it is published too.
-- `created_at` is the only timestamp these rows have; the exact minute a host
-- replied was never recorded, and inventing one would be worse than admitting
-- it is the row's own date.
UPDATE "reviews"
   SET "host_answer_status" = 'PUBLISHED',
       "host_answered_at"   = "createdAt"
 WHERE "host_answer" IS NOT NULL;

DROP INDEX IF EXISTS "reviews_residence_id_hidden_at_idx";

-- The public read: this listing's published reviews, newest first.
CREATE INDEX "reviews_residence_id_comment_status_idx"
  ON "reviews" ("residence_id", "comment_status");

-- The panel's default view is the moderation queue, across every listing.
CREATE INDEX "reviews_comment_status_createdAt_idx"
  ON "reviews" ("comment_status", "createdAt" DESC);

-- "The host just replied and nobody has approved it" — the state the design
-- wants sorted to the top.
CREATE INDEX "reviews_host_answer_status_idx"
  ON "reviews" ("host_answer_status");

-- The two buttons on the review detail page need a notification kind of their
-- own. ADD VALUE is safe inside a transaction on PG 12+ as long as the value
-- is not used in the same transaction — it is not; the first row using it is
-- written by a later request.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'REVIEW_PUBLISHED';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'REVIEW_ANSWER_PUBLISHED';
