-- CreateTable
CREATE TABLE "legacy_image_redirects" (
    "id" SERIAL NOT NULL,
    "model" TEXT NOT NULL,
    "odoo_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "legacy_image_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legacy_image_redirects_model_odoo_id_key" ON "legacy_image_redirects"("model", "odoo_id");
