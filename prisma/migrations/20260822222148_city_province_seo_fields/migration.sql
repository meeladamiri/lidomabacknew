-- AlterTable
ALTER TABLE "cities" ADD COLUMN     "content_html" TEXT,
ADD COLUMN     "content_title" TEXT,
ADD COLUMN     "meta_description" TEXT,
ADD COLUMN     "meta_title" TEXT;

-- AlterTable
ALTER TABLE "provinces" ADD COLUMN     "content_html" TEXT,
ADD COLUMN     "content_title" TEXT,
ADD COLUMN     "meta_description" TEXT,
ADD COLUMN     "meta_title" TEXT;
