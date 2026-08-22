-- AlterTable
ALTER TABLE "provinces" ADD COLUMN     "title_en" TEXT;

-- CreateTable
CREATE TABLE "legacy_redirects" (
    "id" SERIAL NOT NULL,
    "path" TEXT NOT NULL,
    "target" TEXT NOT NULL,

    CONSTRAINT "legacy_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legacy_redirects_path_key" ON "legacy_redirects"("path");
