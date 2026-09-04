-- Three independent, additive pieces of the residence-management overhaul:
--
-- 1. Admin suspension (suspended_at / suspension_internal_note /
--    suspension_reason) — a second, separate reason a listing can be off
--    `published`, distinct from the host's own deactivation. `state` is not
--    touched by suspension; a suspended listing's `state` stays PUBLISHED.
--
-- 2. Live-edit review (pending_changes / pending_changes_submitted_at) — a
--    host-submitted edit to an already-published listing sits here until an
--    admin approves or rejects it. The real columns (what the public site
--    reads) are untouched until approval merges this JSON onto them.
--
-- 3. residence_defects — itemized, per-section issues an admin can raise
--    against a listing (new or already published) without a blunt reject.
--    MANDATORY defects keep `published` false until resolved; SUGGESTED ones
--    are just shown to the host.
--
-- Only the statements this feature actually needs — `prisma migrate diff`
-- also surfaced unrelated pre-existing drift (backup-table drops, an
-- unrelated FK rebuild on reservation_payments, an index rename, two
-- updated_at default changes) that is out of scope here and not applied.

ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP(3);
ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "suspension_internal_note" TEXT;
ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "suspension_reason" TEXT;
ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "pending_changes" JSONB;
ALTER TABLE "residences" ADD COLUMN IF NOT EXISTS "pending_changes_submitted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "residences_suspended_at_idx" ON "residences"("suspended_at");

DO $$ BEGIN
  CREATE TYPE "ResidenceDefectSection" AS ENUM ('DETAILS', 'SPECS', 'LOCATION', 'CAPACITY', 'AMENITIES', 'PRICING', 'GALLERY', 'DOCUMENTS', 'RULES', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResidenceDefectSeverity" AS ENUM ('MANDATORY', 'SUGGESTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "residence_defects" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "section" "ResidenceDefectSection" NOT NULL,
    "severity" "ResidenceDefectSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "reported_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_requested_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" INTEGER,

    CONSTRAINT "residence_defects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "residence_defects_residence_id_resolved_at_idx" ON "residence_defects"("residence_id", "resolved_at");

DO $$ BEGIN
  ALTER TABLE "residence_defects" ADD CONSTRAINT "residence_defects_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
