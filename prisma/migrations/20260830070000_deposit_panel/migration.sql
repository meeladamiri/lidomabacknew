-- The deposit panel (Odoo's /deposit page).
--
-- Hand-written so the `_backup_*` tables the generated diff wants to drop stay
-- where they are. Additive only.

-- CreateEnum
CREATE TYPE "HostDepositKind" AS ENUM ('REMAINDER', 'DEPOSIT', 'HOST_DEBIT', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "host_deposits" ADD COLUMN     "kind" "HostDepositKind" NOT NULL DEFAULT 'REMAINDER',
ADD COLUMN     "pay_with" TEXT,
ADD COLUMN     "payer_name" TEXT;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "clear_remainder" DOUBLE PRECISION,
ADD COLUMN     "sales_description" TEXT;

-- Seed the remaining figure for bookings that already have a host share, so
-- the panel opens with real numbers instead of nulls it has to guess at.
-- Only DONE bookings: anything earlier has not been paid for.
UPDATE "reservations"
SET "clear_remainder" = GREATEST("host_share" - COALESCE("settled_amount", 0), 0)
WHERE "clear_remainder" IS NULL
  AND "host_share" IS NOT NULL
  AND state = 'DONE';
