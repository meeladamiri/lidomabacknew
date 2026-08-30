-- The activity and communication log.
--
-- Hand-written so the `_backup_*` tables are left alone. Additive only.

-- CreateEnum
CREATE TYPE "ActivityKind" AS ENUM ('CALL', 'NOTE', 'STATE_CHANGE', 'FIELD_CHANGE', 'MESSAGE_SENT');
-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');
-- CreateEnum
CREATE TYPE "CallParty" AS ENUM ('GUEST', 'HOST', 'OTHER');
-- CreateTable
CREATE TABLE "activity_logs" (
    "id" SERIAL NOT NULL,
    "kind" "ActivityKind" NOT NULL,
    "reservation_id" INTEGER,
    "user_id" INTEGER,
    "residence_id" INTEGER,
    "call_direction" "CallDirection",
    "call_party" "CallParty",
    "call_outcome" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "actor_id" INTEGER,
    "actor_name" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "activity_logs_reservation_id_id_idx" ON "activity_logs"("reservation_id", "id");
-- CreateIndex
CREATE INDEX "activity_logs_user_id_id_idx" ON "activity_logs"("user_id", "id");
-- CreateIndex
CREATE INDEX "activity_logs_kind_created_at_idx" ON "activity_logs"("kind", "created_at");
-- CreateIndex
CREATE INDEX "activity_logs_actor_id_created_at_idx" ON "activity_logs"("actor_id", "created_at");
-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Immutability, enforced by the database.
--
-- The requirement is logs that are read-only after creation. "No endpoint
-- updates them" is a property of today's code; this is a property of the data,
-- and it survives the next person who adds an endpoint in a hurry.
--
-- It raises rather than silently ignoring the write. A rule with DO INSTEAD
-- NOTHING would also keep the row safe, but the caller would be told their
-- update succeeded — a lie that is worse than the edit it prevented.
CREATE OR REPLACE FUNCTION activity_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_logs is append-only: % is not permitted', TG_OP
    USING HINT = 'Write a new row instead of changing an existing one.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_logs_no_change
  BEFORE UPDATE OR DELETE ON "activity_logs"
  FOR EACH ROW EXECUTE FUNCTION activity_logs_immutable();
