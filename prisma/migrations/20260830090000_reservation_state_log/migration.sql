-- DRAFT, and a log of every state change with the reason behind it.
--
-- Hand-written so the `_backup_*` tables stay put. Additive only.
--
-- `ALTER TYPE ... ADD VALUE` inside a transaction is allowed from PostgreSQL
-- 12 and the server here is 18, so this is safe. The new value is not used by
-- any statement in this same migration, which is the other half of that rule.

-- AlterEnum
ALTER TYPE "ReservationState" ADD VALUE 'DRAFT';

-- CreateTable
CREATE TABLE "reservation_state_changes" (
    "id" SERIAL NOT NULL,
    "reservation_id" INTEGER NOT NULL,
    "from_state" "ReservationState",
    "to_state" "ReservationState" NOT NULL,
    "note" TEXT,
    "changed_by_id" INTEGER,
    "changed_by_name" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_state_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservation_state_changes_reservation_id_id_idx" ON "reservation_state_changes"("reservation_id", "id");

-- AddForeignKey
ALTER TABLE "reservation_state_changes" ADD CONSTRAINT "reservation_state_changes_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
