-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_CONFIRMED', 'CHECKING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ResidenceType" AS ENUM ('BOOMGARDI', 'SUIT');

-- CreateEnum
CREATE TYPE "ResidenceState" AS ENUM ('DRAFT', 'PENDING', 'PUBLISHED', 'REJECTED', 'DEACTIVATED', 'DELETED');

-- CreateEnum
CREATE TYPE "BedRoomType" AS ENUM ('NONE', 'SHARED', 'DEDICATED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_PRICE');

-- CreateEnum
CREATE TYPE "AmenityFieldType" AS ENUM ('TEXT', 'DROPDOWN', 'SWITCH', 'CHECKBOX');

-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('HOST_APPROVAL', 'SECOND_PAYMENT', 'DONE', 'CANCEL', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationCancelledBy" AS ENUM ('HOST_CANCELLED', 'LIDOMA_CANCELLED', 'GUEST_CANCELLED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'SIGNUP', 'RESET_PASSWORD');

-- CreateTable
CREATE TABLE "provinces" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provinces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "title_en" TEXT,
    "image_url" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "province_id" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT,
    "name" TEXT,
    "email" TEXT,
    "national_code" TEXT,
    "address" TEXT,
    "city_id" INTEGER,
    "zip" TEXT,
    "fax" TEXT,
    "job" TEXT,
    "education" TEXT,
    "birth_day" INTEGER,
    "birth_month" INTEGER,
    "birth_year" INTEGER,
    "emergency_phone" TEXT,
    "contact_phone" TEXT,
    "avatar_url" TEXT,
    "national_card_url" TEXT,
    "description" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'NOT_CONFIRMED',
    "is_host" BOOLEAN NOT NULL DEFAULT false,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "card_number" TEXT,
    "card_owner_name" TEXT,
    "shaba_number" TEXT,
    "shaba_owner_name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "user_id" INTEGER,
    "code_hash" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amenities" (
    "id" SERIAL NOT NULL,
    "category" TEXT,
    "name" TEXT NOT NULL,
    "icon_url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amenities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amenity_features" (
    "id" SERIAL NOT NULL,
    "amenity_id" INTEGER NOT NULL,
    "field_type" "AmenityFieldType" NOT NULL,
    "name" TEXT NOT NULL,
    "placeholder" TEXT,
    "values" TEXT,
    "in_filter" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "amenity_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" SERIAL NOT NULL,
    "category" TEXT,
    "name" TEXT NOT NULL,
    "icon_url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residences" (
    "id" SERIAL NOT NULL,
    "reference" TEXT NOT NULL,
    "host_id" INTEGER NOT NULL,
    "type" "ResidenceType" NOT NULL,
    "state" "ResidenceState" NOT NULL DEFAULT 'DRAFT',
    "step" INTEGER,
    "completion_percent" INTEGER,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "name2" TEXT,
    "description" TEXT,
    "city_id" INTEGER,
    "neighborhood" TEXT,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "floor" TEXT,
    "foundation_area" DOUBLE PRECISION,
    "total_area" DOUBLE PRECISION,
    "capacity" INTEGER,
    "max_capacity" INTEGER,
    "checkin_from" TEXT,
    "checkin_to" TEXT,
    "checkout" TEXT,
    "min_reservable_days" INTEGER,
    "cancel_commission" DOUBLE PRECISION,
    "reserve_commission" DOUBLE PRECISION,
    "cancellation_policy_desc" TEXT,
    "full_return_time" INTEGER,
    "before_start_time" INTEGER,
    "host_share_total_amount" DOUBLE PRECISION,
    "host_share_past_nights" DOUBLE PRECISION,
    "host_share_future_nights" DOUBLE PRECISION,
    "week_price" DOUBLE PRECISION,
    "weekend_price" DOUBLE PRECISION,
    "peak_price" DOUBLE PRECISION,
    "extra_price" DOUBLE PRECISION,
    "extra_guests_price" DOUBLE PRECISION,
    "weekly_discount" DOUBLE PRECISION,
    "monthly_discount" DOUBLE PRECISION,
    "video_url" TEXT,
    "is_fast" BOOLEAN NOT NULL DEFAULT false,
    "is_full" BOOLEAN NOT NULL DEFAULT false,
    "is_offer" BOOLEAN NOT NULL DEFAULT false,
    "sales_count" INTEGER NOT NULL DEFAULT 0,
    "average_rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviews_count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "residences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residence_images" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "residence_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image" TEXT,
    "capacity" INTEGER,
    "max_capacity" INTEGER,
    "single_bed" INTEGER NOT NULL DEFAULT 0,
    "double_bed" INTEGER NOT NULL DEFAULT 0,
    "traditional_bed" INTEGER NOT NULL DEFAULT 0,
    "extra_beds" INTEGER NOT NULL DEFAULT 0,
    "week_price" DOUBLE PRECISION,
    "weekend_price" DOUBLE PRECISION,
    "peak_price" DOUBLE PRECISION,
    "extra_price" DOUBLE PRECISION,
    "extra_peak_price" DOUBLE PRECISION,
    "weekly_discount" DOUBLE PRECISION,
    "monthly_discount" DOUBLE PRECISION,
    "cooling_system" BOOLEAN,
    "heating_system" BOOLEAN,
    "refrigerator" "BedRoomType",
    "wc" "BedRoomType",
    "separate_bathroom" BOOLEAN,
    "free_breakfast" BOOLEAN,
    "is_fast" BOOLEAN NOT NULL DEFAULT false,
    "sales_count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residence_amenities" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "amenity_id" INTEGER NOT NULL,
    "extra_features" JSONB,

    CONSTRAINT "residence_amenities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residence_rules" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "rule_id" INTEGER NOT NULL,
    "value" JSONB,

    CONSTRAINT "residence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_days" (
    "id" SERIAL NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "room_id" INTEGER,
    "date" DATE NOT NULL,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "is_fast" BOOLEAN,
    "is_peak" BOOLEAN NOT NULL DEFAULT false,
    "special_price" DOUBLE PRECISION,
    "discount_amount" DOUBLE PRECISION,
    "discount_type" "DiscountType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" SERIAL NOT NULL,
    "reference" TEXT NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "guest_id" INTEGER NOT NULL,
    "host_id" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "expiry_date" TIMESTAMP(3),
    "days_count" INTEGER NOT NULL,
    "guests_count" INTEGER NOT NULL,
    "extra_guests_count" INTEGER NOT NULL DEFAULT 0,
    "state" "ReservationState" NOT NULL DEFAULT 'HOST_APPROVAL',
    "cancelled_by" "ReservationCancelledBy",
    "cancel_reason" TEXT,
    "cancel_desc" TEXT,
    "total_amount" DOUBLE PRECISION NOT NULL,
    "paid_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remaining_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "host_share" DOUBLE PRECISION,
    "website_share" DOUBLE PRECISION,
    "voucher_code" TEXT,
    "guest_name_override" TEXT,
    "guest_phone_override" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_rooms" (
    "id" SERIAL NOT NULL,
    "reservation_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,

    CONSTRAINT "reservation_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favourites" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "residence_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favourites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cities_province_id_idx" ON "cities"("province_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_city_id_idx" ON "users"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_user_id_key" ON "bank_accounts"("user_id");

-- CreateIndex
CREATE INDEX "otp_codes_phone_purpose_idx" ON "otp_codes"("phone", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "amenity_features_amenity_id_idx" ON "amenity_features"("amenity_id");

-- CreateIndex
CREATE UNIQUE INDEX "residences_reference_key" ON "residences"("reference");

-- CreateIndex
CREATE INDEX "residences_host_id_idx" ON "residences"("host_id");

-- CreateIndex
CREATE INDEX "residences_city_id_idx" ON "residences"("city_id");

-- CreateIndex
CREATE INDEX "residences_state_published_idx" ON "residences"("state", "published");

-- CreateIndex
CREATE INDEX "residence_images_residence_id_idx" ON "residence_images"("residence_id");

-- CreateIndex
CREATE INDEX "rooms_residence_id_idx" ON "rooms"("residence_id");

-- CreateIndex
CREATE INDEX "residence_amenities_amenity_id_idx" ON "residence_amenities"("amenity_id");

-- CreateIndex
CREATE UNIQUE INDEX "residence_amenities_residence_id_amenity_id_key" ON "residence_amenities"("residence_id", "amenity_id");

-- CreateIndex
CREATE INDEX "residence_rules_rule_id_idx" ON "residence_rules"("rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "residence_rules_residence_id_rule_id_key" ON "residence_rules"("residence_id", "rule_id");

-- CreateIndex
CREATE INDEX "calendar_days_residence_id_date_idx" ON "calendar_days"("residence_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_days_residence_id_room_id_date_key" ON "calendar_days"("residence_id", "room_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_reference_key" ON "reservations"("reference");

-- CreateIndex
CREATE INDEX "reservations_residence_id_idx" ON "reservations"("residence_id");

-- CreateIndex
CREATE INDEX "reservations_guest_id_idx" ON "reservations"("guest_id");

-- CreateIndex
CREATE INDEX "reservations_host_id_idx" ON "reservations"("host_id");

-- CreateIndex
CREATE INDEX "reservations_state_idx" ON "reservations"("state");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_rooms_reservation_id_room_id_key" ON "reservation_rooms"("reservation_id", "room_id");

-- CreateIndex
CREATE UNIQUE INDEX "favourites_user_id_residence_id_key" ON "favourites"("user_id", "residence_id");

-- AddForeignKey
ALTER TABLE "cities" ADD CONSTRAINT "cities_province_id_fkey" FOREIGN KEY ("province_id") REFERENCES "provinces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amenity_features" ADD CONSTRAINT "amenity_features_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residences" ADD CONSTRAINT "residences_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residences" ADD CONSTRAINT "residences_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residence_images" ADD CONSTRAINT "residence_images_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residence_amenities" ADD CONSTRAINT "residence_amenities_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residence_amenities" ADD CONSTRAINT "residence_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residence_rules" ADD CONSTRAINT "residence_rules_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residence_rules" ADD CONSTRAINT "residence_rules_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_residence_id_fkey" FOREIGN KEY ("residence_id") REFERENCES "residences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
