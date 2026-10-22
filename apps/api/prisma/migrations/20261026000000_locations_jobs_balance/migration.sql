-- CreateEnum
CREATE TYPE "JobPayType" AS ENUM ('FIXED', 'COMMISSION', 'MIXED', 'PER_SERVICE');

-- CreateEnum
CREATE TYPE "JobPayPeriod" AS ENUM ('DAY', 'WEEK', 'BIWEEKLY', 'MONTH', 'PER_SERVICE');

-- CreateEnum
CREATE TYPE "JobSelectionProcess" AS ENUM ('INTERVIEW', 'TRIAL', 'DIRECT');

-- CreateEnum
CREATE TYPE "JobOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SellerAccountStatus" AS ENUM ('PENDING', 'CONNECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PaymentPayee" AS ENUM ('PLATFORM', 'SELLER');

-- CreateEnum
CREATE TYPE "BalanceMovementType" AS ENUM ('SUBSCRIPTION_PAYMENT', 'PAYOUT', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "barber_profiles" ADD COLUMN     "district_id" UUID;

-- AlterTable
ALTER TABLE "barbershops" ADD COLUMN     "district_id" UUID;

-- AlterTable
ALTER TABLE "job_postings" ADD COLUMN     "district_id" UUID,
ADD COLUMN     "negotiable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pay_max" INTEGER,
ADD COLUMN     "pay_min" INTEGER,
ADD COLUMN     "pay_period" "JobPayPeriod",
ADD COLUMN     "pay_type" "JobPayType",
ADD COLUMN     "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "schedule" TEXT,
ADD COLUMN     "selection_process" "JobSelectionProcess";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "marketplace_fee" INTEGER,
ADD COLUMN     "payee" "PaymentPayee" NOT NULL DEFAULT 'PLATFORM';

-- CreateTable
CREATE TABLE "peru_districts" (
    "id" UUID NOT NULL,
    "ubigeo" CHAR(6) NOT NULL,
    "department" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "peru_districts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_offers" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "barber_profile_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "employment_type" "EmploymentType" NOT NULL,
    "pay_min" INTEGER,
    "pay_max" INTEGER,
    "pay_type" "JobPayType",
    "pay_period" "JobPayPeriod",
    "schedule" TEXT,
    "status" "JobOfferStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "response_note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_accounts" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "SellerAccountStatus" NOT NULL DEFAULT 'PENDING',
    "provider_user_id" TEXT,
    "public_key" TEXT,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "oauth_state" TEXT,
    "oauth_state_expires_at" TIMESTAMPTZ(3),
    "connected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_movements" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "type" "BalanceMovementType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "subscription_id" UUID,
    "reference" TEXT,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "peru_districts_ubigeo_key" ON "peru_districts"("ubigeo");

-- CreateIndex
CREATE INDEX "peru_districts_department_province_idx" ON "peru_districts"("department", "province");

-- CreateIndex
CREATE INDEX "peru_districts_province_idx" ON "peru_districts"("province");

-- CreateIndex
CREATE INDEX "job_offers_barbershop_id_status_idx" ON "job_offers"("barbershop_id", "status");

-- CreateIndex
CREATE INDEX "job_offers_barber_profile_id_status_idx" ON "job_offers"("barber_profile_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "seller_accounts_barbershop_id_key" ON "seller_accounts"("barbershop_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_accounts_oauth_state_key" ON "seller_accounts"("oauth_state");

-- CreateIndex
CREATE INDEX "seller_accounts_provider_provider_user_id_idx" ON "seller_accounts"("provider", "provider_user_id");

-- CreateIndex
CREATE INDEX "balance_movements_barbershop_id_created_at_idx" ON "balance_movements"("barbershop_id", "created_at");

-- CreateIndex
CREATE INDEX "balance_movements_subscription_id_idx" ON "balance_movements"("subscription_id");

-- CreateIndex
CREATE INDEX "barber_profiles_district_id_idx" ON "barber_profiles"("district_id");

-- CreateIndex
CREATE INDEX "barbershops_district_id_idx" ON "barbershops"("district_id");

-- CreateIndex
CREATE INDEX "job_postings_district_id_idx" ON "job_postings"("district_id");

-- AddForeignKey
ALTER TABLE "barbershops" ADD CONSTRAINT "barbershops_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "peru_districts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_profiles" ADD CONSTRAINT "barber_profiles_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "peru_districts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "peru_districts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_accounts" ADD CONSTRAINT "seller_accounts_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_movements" ADD CONSTRAINT "balance_movements_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_movements" ADD CONSTRAINT "balance_movements_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Reglas manuales ─────────────
ALTER TABLE "peru_districts" ADD CONSTRAINT "peru_districts_ubigeo_check" CHECK ("ubigeo" ~ '^[0-9]{6}$');
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_pay_check" CHECK (
  ("pay_min" IS NULL OR "pay_min" >= 0) AND ("pay_max" IS NULL OR "pay_max" >= 0)
  AND ("pay_min" IS NULL OR "pay_max" IS NULL OR "pay_min" <= "pay_max")
  AND cardinality("requirements") <= 20
);
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_pay_check" CHECK (
  ("pay_min" IS NULL OR "pay_min" >= 0) AND ("pay_max" IS NULL OR "pay_max" >= 0)
  AND ("pay_min" IS NULL OR "pay_max" IS NULL OR "pay_min" <= "pay_max")
  AND (("status" = 'PENDING') = ("responded_at" IS NULL) OR "status" IN ('WITHDRAWN', 'EXPIRED'))
);
-- Una oferta pendiente a la vez por barbería y barbero.
CREATE UNIQUE INDEX "job_offers_one_pending" ON "job_offers" ("barbershop_id", "barber_profile_id")
  WHERE "status" = 'PENDING';
ALTER TABLE "seller_accounts" ADD CONSTRAINT "seller_accounts_connected_check" CHECK (
  "status" <> 'CONNECTED' OR ("access_token_enc" IS NOT NULL AND "provider_user_id" IS NOT NULL)
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_marketplace_fee_check" CHECK (
  "marketplace_fee" IS NULL OR ("marketplace_fee" >= 0 AND "marketplace_fee" <= "amount")
);
ALTER TABLE "balance_movements" ADD CONSTRAINT "balance_movements_amount_check" CHECK (
  "amount" <> 0
  AND ("type" <> 'SUBSCRIPTION_PAYMENT' OR ("amount" < 0 AND "subscription_id" IS NOT NULL))
  AND ("type" <> 'PAYOUT' OR "amount" < 0)
);
