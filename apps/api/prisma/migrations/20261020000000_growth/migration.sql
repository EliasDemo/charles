-- CreateEnum
CREATE TYPE "DiscountFunder" AS ENUM ('CHARLES', 'BARBERSHOP');

-- CreateEnum
CREATE TYPE "SponsorAudience" AS ENUM ('CLIENTS', 'BARBERSHOPS', 'ALL');

-- DropForeignKey
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "coupon_redemptions_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "coupon_redemptions_coupon_id_fkey";

-- DropForeignKey
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "coupon_redemptions_user_id_fkey";

-- AlterTable
ALTER TABLE "featured_listings" ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "created_by" UUID,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "barbershop_id" UUID,
ADD COLUMN     "created_by" UUID,
ADD COLUMN     "requires_coupon" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sponsor_campaigns" ADD COLUMN     "audience" "SponsorAudience" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "sponsor_events" ADD COLUMN     "hour_bucket" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "viewer_hash" BYTEA NOT NULL;

-- DropTable
DROP TABLE "coupon_redemptions";

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "coupon_id" UUID,
    "user_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "discount_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "funded_by" "DiscountFunder" NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsor_products" (
    "id" UUID NOT NULL,
    "sponsor_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "action_url" TEXT NOT NULL,
    "price_text" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "sponsor_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemptions_booking_id_key" ON "promotion_redemptions"("booking_id");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_released_at_idx" ON "promotion_redemptions"("promotion_id", "released_at");

-- CreateIndex
CREATE INDEX "promotion_redemptions_user_id_promotion_id_idx" ON "promotion_redemptions"("user_id", "promotion_id");

-- CreateIndex
CREATE INDEX "promotion_redemptions_coupon_id_idx" ON "promotion_redemptions"("coupon_id");

-- CreateIndex
CREATE INDEX "sponsor_products_sponsor_id_idx" ON "sponsor_products"("sponsor_id");

-- CreateIndex
CREATE INDEX "promotions_barbershop_id_idx" ON "promotions"("barbershop_id");

-- CreateIndex
CREATE INDEX "promotions_created_by_idx" ON "promotions"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_events_placement_id_type_viewer_hash_hour_bucket_key" ON "sponsor_events"("placement_id", "type", "viewer_hash", "hour_bucket");

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_products" ADD CONSTRAINT "sponsor_products_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Restricciones manuales (Fase 13) ─────────────

-- PLATFORM sin barbería; BARBERSHOP y SERVICE con barbería (promotions_scope_check ya exige el
-- destino en scope_id).
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_barbershop_check" CHECK (
  ("scope" = 'PLATFORM') = ("barbershop_id" IS NULL)
);
-- (Valor, moneda, periodo y topes ya los validan las restricciones de core_schema.)
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_discount_amount_check"
  CHECK ("discount_amount" > 0);
ALTER TABLE "featured_listings" ADD CONSTRAINT "featured_listings_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
