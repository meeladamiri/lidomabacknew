-- The cancellation process: who cancelled, whether it was justified, who was
-- told, and the money as it was decided at the time.
--
-- Hand-written, like the last four, so the `_backup_*` tables that live only
-- in the database are left alone. Additive only.

-- CreateEnum
CREATE TYPE "CancelNotifyMode" AS ENUM ('BOTH', 'ONLY_GUEST', 'ONLY_HOST', 'NONE');

-- AlterTable
ALTER TABLE "reservation_settings" ADD COLUMN     "cancel_early_hours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "cancel_nights_late" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "cancel_nights_started" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "cancel_penalty_percent" DOUBLE PRECISION NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "cancel_band" TEXT,
ADD COLUMN     "cancel_coordinated_with" TEXT,
ADD COLUMN     "cancel_host_share" DOUBLE PRECISION,
ADD COLUMN     "cancel_justified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancel_notify_mode" "CancelNotifyMode",
ADD COLUMN     "cancel_penalty" DOUBLE PRECISION,
ADD COLUMN     "cancel_refund" DOUBLE PRECISION,
ADD COLUMN     "cancel_site_share" DOUBLE PRECISION,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by_id" INTEGER,
ADD COLUMN     "without_payback" BOOLEAN NOT NULL DEFAULT false;
