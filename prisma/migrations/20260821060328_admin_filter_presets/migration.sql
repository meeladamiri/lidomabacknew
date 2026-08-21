-- CreateTable
CREATE TABLE "admin_filter_presets" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_filter_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_filter_presets_entity_idx" ON "admin_filter_presets"("entity");
