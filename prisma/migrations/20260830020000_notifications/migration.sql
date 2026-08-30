-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('BOOKING_REQUESTED', 'BOOKING_APPROVED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'BOOKING_EXPIRED', 'BOOKING_COMPLETED', 'BOOKING_NEW_REQUEST', 'REVIEW_RECEIVED', 'RESIDENCE_PUBLISHED', 'RESIDENCE_REJECTED', 'MESSAGE_RECEIVED', 'ACCOUNT_VERIFIED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link_url" TEXT,
    "entity_type" TEXT,
    "entity_id" INTEGER,
    "read_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_archived_at_id_idx" ON "notifications"("user_id", "archived_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_kind_entity_type_entity_id_key" ON "notifications"("user_id", "kind", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
