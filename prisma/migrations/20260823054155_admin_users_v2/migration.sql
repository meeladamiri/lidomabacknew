-- AlterTable
ALTER TABLE "users" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "is_special_host" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_yellow_cards" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "admin_id" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_yellow_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_yellow_cards_user_id_idx" ON "user_yellow_cards"("user_id");

-- AddForeignKey
ALTER TABLE "user_yellow_cards" ADD CONSTRAINT "user_yellow_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
