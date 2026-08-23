-- AlterTable
ALTER TABLE "residences" ADD COLUMN "extra_guests_peak_price" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "peak_days" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "peak_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "peak_day_cities" (
    "id" SERIAL NOT NULL,
    "peak_day_id" INTEGER NOT NULL,
    "city_id" INTEGER NOT NULL,
    CONSTRAINT "peak_day_cities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "peak_days_start_date_end_date_idx" ON "peak_days"("start_date", "end_date");
CREATE UNIQUE INDEX "peak_day_cities_peak_day_id_city_id_key" ON "peak_day_cities"("peak_day_id", "city_id");

-- AddForeignKey
ALTER TABLE "peak_day_cities" ADD CONSTRAINT "peak_day_cities_peak_day_id_fkey" FOREIGN KEY ("peak_day_id") REFERENCES "peak_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "peak_day_cities" ADD CONSTRAINT "peak_day_cities_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
