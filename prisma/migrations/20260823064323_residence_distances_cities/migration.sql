-- AlterTable
ALTER TABLE "residences" ADD COLUMN "invoice_address" TEXT;
ALTER TABLE "residences" ADD COLUMN "host_suggested_name" TEXT;

-- CreateTable
CREATE TABLE "residence_distances" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "place_name" TEXT NOT NULL,
    "distance" TEXT,
    "eta" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "residence_distances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residence_cities" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "city_id" INTEGER NOT NULL,
    CONSTRAINT "residence_cities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "residence_distances_residence_id_idx" ON "residence_distances"("residence_id");
CREATE INDEX "residence_cities_city_id_idx" ON "residence_cities"("city_id");
CREATE UNIQUE INDEX "residence_cities_residence_id_city_id_key" ON "residence_cities"("residence_id", "city_id");

-- AddForeignKey
ALTER TABLE "residence_distances" ADD CONSTRAINT "residence_distances_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "residence_cities" ADD CONSTRAINT "residence_cities_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "residence_cities" ADD CONSTRAINT "residence_cities_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
