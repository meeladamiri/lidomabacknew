-- Reservation commission, VAT and host deposits.
--
-- Hand-written rather than generated: `migrate diff` also wanted to drop the
-- six `_backup_*` tables, which exist only in the live database and are the
-- safety copies kept from the location migration and the 2026-08-27 incident.
-- Nothing here drops or rewrites anything.

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "commission_percent" DOUBLE PRECISION,
ADD COLUMN     "guest_commission" DOUBLE PRECISION,
ADD COLUMN     "guest_commission_percent" DOUBLE PRECISION,
ADD COLUMN     "settled_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "vat_amount" DOUBLE PRECISION,
ADD COLUMN     "vat_percent" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "commission_percent" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "reservation_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "commission_percent" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "vat_percent" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "guest_commission_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "release_on_start_date" BOOLEAN NOT NULL DEFAULT true,
    "min_settlement" INTEGER NOT NULL DEFAULT 50000,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_deposits" (
    "id" SERIAL NOT NULL,
    "host_id" INTEGER NOT NULL,
    "reservation_id" INTEGER,
    "amount" DOUBLE PRECISION NOT NULL,
    "deposited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "txn_id" TEXT,
    "sender" TEXT,
    "description" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "host_deposits_host_id_id_idx" ON "host_deposits"("host_id", "id");

-- CreateIndex
CREATE INDEX "host_deposits_reservation_id_idx" ON "host_deposits"("reservation_id");

-- AddForeignKey
ALTER TABLE "host_deposits" ADD CONSTRAINT "host_deposits_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_deposits" ADD CONSTRAINT "host_deposits_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The single settings row, seeded with the rates Odoo actually charged:
-- 15% commission and VAT at 10% of that commission.
INSERT INTO "reservation_settings" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
