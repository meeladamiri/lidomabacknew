-- Guest payments, one row per instalment.
--
-- `reservations.paid_amount` stays as the cached total of the payments that
-- still stand, so every existing reader (the deposit panel, the cancellation
-- refund, the reservations list) keeps working untouched.
--
-- Written by hand rather than generated: `prisma migrate diff` wants to drop
-- six `_backup_*` tables that exist in this database on purpose.

CREATE TYPE "ReservationPaymentMethod" AS ENUM (
  'GATEWAY',
  'CARD_TRANSFER',
  'BANK_TRANSFER',
  'CASH',
  'WALLET',
  'OTHER'
);

CREATE TABLE "reservation_payments" (
  "id"               SERIAL PRIMARY KEY,
  "reservation_id"   INTEGER NOT NULL REFERENCES "reservations"("id") ON DELETE CASCADE,
  "amount"           DOUBLE PRECISION NOT NULL,
  "method"           "ReservationPaymentMethod" NOT NULL DEFAULT 'CARD_TRANSFER',
  "paid_at"          TIMESTAMP(3) NOT NULL,
  "reference"        TEXT,
  "note"             TEXT,
  "recorded_by_id"   INTEGER,
  "recorded_by_name" TEXT,
  "voided_at"        TIMESTAMP(3),
  "voided_reason"    TEXT,
  "voided_by_id"     INTEGER,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "reservation_payments_reservation_id_idx" ON "reservation_payments"("reservation_id");
CREATE INDEX "reservation_payments_paid_at_idx" ON "reservation_payments"("paid_at");
