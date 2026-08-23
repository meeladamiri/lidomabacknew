-- AlterTable
ALTER TABLE "residences" ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "residences_importance_idx" ON "residences"("importance" DESC);
