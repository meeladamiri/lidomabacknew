-- AlterTable
ALTER TABLE "amenities" ADD COLUMN "key" TEXT;

-- AlterTable
ALTER TABLE "rules" ADD COLUMN "key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "amenities_key_key" ON "amenities"("key");

-- CreateIndex
CREATE UNIQUE INDEX "rules_key_key" ON "rules"("key");
