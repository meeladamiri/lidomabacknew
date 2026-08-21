-- AlterTable
ALTER TABLE "residences" ADD COLUMN     "cancellation_policy" TEXT,
ADD COLUMN     "document_url" TEXT,
ADD COLUMN     "host_national_card_url" TEXT,
ADD COLUMN     "other_amenities" TEXT,
ADD COLUMN     "owner_national_card_url" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "rent_type" TEXT;
