-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "reservation_id" INTEGER NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "guest_id" INTEGER NOT NULL,
    "cleaning" INTEGER NOT NULL,
    "location" INTEGER NOT NULL,
    "quality" INTEGER NOT NULL,
    "integrity" INTEGER NOT NULL,
    "greeting" INTEGER NOT NULL,
    "delivery" INTEGER NOT NULL,
    "average_rating" DOUBLE PRECISION NOT NULL,
    "comment" TEXT NOT NULL,
    "host_answer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reviews_reservation_id_key" ON "reviews"("reservation_id");

-- CreateIndex
CREATE INDEX "reviews_residence_id_idx" ON "reviews"("residence_id");

-- CreateIndex
CREATE INDEX "reviews_guest_id_idx" ON "reviews"("guest_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
