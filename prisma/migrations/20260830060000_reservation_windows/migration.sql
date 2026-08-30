-- Approval and payment deadlines.
--
-- Hand-written, same as the last one: `migrate diff` also wants to drop the
-- `_backup_*` tables that exist only in the live database.
--
-- Defaults are 120 minutes because that is what Odoo's stored deadlines
-- clustered at — 85,000 bookings at ~120, 47,000 at ~60, 26,000 at ~720. It
-- kept a single field for both stages ("مهلت تایید یا پرداخت"); these are two,
-- because a host deciding and a guest paying are not the same wait.

-- AlterTable
ALTER TABLE "reservation_settings" ADD COLUMN     "approval_window_minutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "payment_window_minutes" INTEGER NOT NULL DEFAULT 120;
