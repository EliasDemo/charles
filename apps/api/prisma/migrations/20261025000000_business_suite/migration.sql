-- CreateEnum
CREATE TYPE "PlanAudience" AS ENUM ('BARBERSHOP', 'BARBER');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingPurpose" AS ENUM ('SUBSCRIPTION', 'SPONSOR_PACKAGE', 'MEMBERSHIP');

-- CreateEnum
CREATE TYPE "BillingChargeStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "SponsorPurchaseStatus" AS ENUM ('PENDING', 'PAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "ClientTier" AS ENUM ('NONE', 'BRONZE', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "SalePaymentMethod" AS ENUM ('CASH', 'YAPE', 'CARD', 'TRANSFER', 'MEMBERSHIP_CREDIT');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'ISSUED', 'REJECTED', 'FAILED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StyleInteractionKind" AS ENUM ('VIEW', 'SAVE', 'BOOK');

-- AlterTable
ALTER TABLE "barbers" ADD COLUMN     "commission_bp" INTEGER,
ADD COLUMN     "plan_suspended_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "featured_listings" ADD COLUMN     "from_plan" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "images" ADD COLUMN     "face_ratio_forehead" REAL,
ADD COLUMN     "face_ratio_jaw" REAL,
ADD COLUMN     "face_ratio_length" REAL,
ADD COLUMN     "plan_hidden_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "cover_image_id" UUID,
ADD COLUMN     "style_id" UUID;

-- AlterTable
ALTER TABLE "sponsor_campaigns" ADD COLUMN     "impressions_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "impressions_limit" INTEGER;

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audience" "PlanAudience" NOT NULL,
    "price_monthly" INTEGER NOT NULL,
    "price_yearly" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "trial_days" SMALLINT NOT NULL DEFAULT 0,
    "commission_bp" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_entitlements" (
    "plan_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER,

    CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("plan_id","key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "barbershop_id" UUID,
    "barber_profile_id" UUID,
    "payer_user_id" UUID NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "price_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "next_price_amount" INTEGER,
    "next_price_from" TIMESTAMPTZ(3),
    "provider" TEXT NOT NULL,
    "provider_subscription_id" TEXT,
    "checkout_url" TEXT,
    "trial_ends_at" TIMESTAMPTZ(3),
    "current_period_start" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "past_due_since" TIMESTAMPTZ(3),
    "grace_until" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_charges" (
    "id" UUID NOT NULL,
    "purpose" "BillingPurpose" NOT NULL,
    "subscription_id" UUID,
    "membership_id" UUID,
    "sponsor_purchase_id" UUID,
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "BillingChargeStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsor_packages" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "impressions_limit" INTEGER,
    "placements_limit" SMALLINT NOT NULL,
    "duration_days" SMALLINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsor_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsor_package_purchases" (
    "id" UUID NOT NULL,
    "sponsor_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "campaign_id" UUID,
    "price_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "SponsorPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "checkout_url" TEXT,
    "payer_email_enc" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsor_package_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_clients" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "user_id" UUID,
    "display_name" TEXT NOT NULL,
    "phone_enc" TEXT,
    "notes" TEXT,
    "preferences" TEXT,
    "is_regular" BOOLEAN NOT NULL DEFAULT false,
    "tier" "ClientTier" NOT NULL DEFAULT 'NONE',
    "score" INTEGER NOT NULL DEFAULT 0,
    "visits_count" INTEGER NOT NULL DEFAULT 0,
    "total_spent" INTEGER NOT NULL DEFAULT 0,
    "first_visit_at" TIMESTAMPTZ(3),
    "last_visit_at" TIMESTAMPTZ(3),
    "ranked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "shop_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "opening_amount" INTEGER NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "expected_amount" INTEGER,
    "counted_amount" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_sales" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "shop_client_id" UUID,
    "barber_id" UUID,
    "cash_session_id" UUID,
    "membership_id" UUID,
    "subtotal_amount" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL DEFAULT 0,
    "total_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_method" "SalePaymentMethod" NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "void_reason" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "created_by" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "sold_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_sale_lines" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "service_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" SMALLINT NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "total_amount" INTEGER NOT NULL,

    CONSTRAINT "local_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoicing_configs" (
    "barbershop_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "series" VARCHAR(4) NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "api_url_enc" TEXT,
    "token_enc" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoicing_configs_pkey" PRIMARY KEY ("barbershop_id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "series" VARCHAR(4) NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "customer_name" TEXT,
    "customer_doc_type" TEXT,
    "customer_doc_enc" TEXT,
    "total_amount" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_data" JSONB NOT NULL DEFAULT '{}',
    "pdf_url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "issued_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_plans" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "credits_per_period" SMALLINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "membership_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_plan_services" (
    "membership_plan_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,

    CONSTRAINT "membership_plan_services_pkey" PRIMARY KEY ("membership_plan_id","service_id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "membership_plan_id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'PENDING',
    "price_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "credits_per_period" SMALLINT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subscription_id" TEXT,
    "checkout_url" TEXT,
    "current_period_start" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_credit_lots" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "charge_id" UUID,
    "granted" SMALLINT NOT NULL,
    "remaining" SMALLINT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_credit_uses" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "booking_id" UUID,
    "sale_id" UUID,
    "restored_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_credit_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_interactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "image_id" UUID,
    "style_id" UUID,
    "kind" "StyleInteractionKind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "plans_audience_sort_order_idx" ON "plans"("audience", "sort_order");

-- CreateIndex
CREATE INDEX "subscriptions_barbershop_id_status_idx" ON "subscriptions"("barbershop_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_barber_profile_id_status_idx" ON "subscriptions"("barber_profile_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "subscriptions_payer_user_id_idx" ON "subscriptions"("payer_user_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_grace_until_idx" ON "subscriptions"("status", "grace_until");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_provider_subscription_id_key" ON "subscriptions"("provider", "provider_subscription_id");

-- CreateIndex
CREATE INDEX "billing_charges_subscription_id_idx" ON "billing_charges"("subscription_id");

-- CreateIndex
CREATE INDEX "billing_charges_membership_id_idx" ON "billing_charges"("membership_id");

-- CreateIndex
CREATE INDEX "billing_charges_sponsor_purchase_id_idx" ON "billing_charges"("sponsor_purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_charges_provider_provider_payment_id_key" ON "billing_charges"("provider", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_provider_provider_event_id_key" ON "billing_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_packages_code_key" ON "sponsor_packages"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_package_purchases_campaign_id_key" ON "sponsor_package_purchases"("campaign_id");

-- CreateIndex
CREATE INDEX "sponsor_package_purchases_sponsor_id_idx" ON "sponsor_package_purchases"("sponsor_id");

-- CreateIndex
CREATE INDEX "sponsor_package_purchases_package_id_idx" ON "sponsor_package_purchases"("package_id");

-- CreateIndex
CREATE INDEX "shop_clients_barbershop_id_tier_score_idx" ON "shop_clients"("barbershop_id", "tier", "score");

-- CreateIndex
CREATE INDEX "shop_clients_user_id_idx" ON "shop_clients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_clients_barbershop_id_user_id_key" ON "shop_clients"("barbershop_id", "user_id");

-- CreateIndex
CREATE INDEX "cash_sessions_barbershop_id_opened_at_idx" ON "cash_sessions"("barbershop_id", "opened_at");

-- CreateIndex
CREATE INDEX "local_sales_barbershop_id_sold_at_idx" ON "local_sales"("barbershop_id", "sold_at");

-- CreateIndex
CREATE INDEX "local_sales_shop_client_id_idx" ON "local_sales"("shop_client_id");

-- CreateIndex
CREATE INDEX "local_sales_barber_id_idx" ON "local_sales"("barber_id");

-- CreateIndex
CREATE INDEX "local_sales_cash_session_id_idx" ON "local_sales"("cash_session_id");

-- CreateIndex
CREATE INDEX "local_sales_membership_id_idx" ON "local_sales"("membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "local_sales_barbershop_id_idempotency_key_key" ON "local_sales"("barbershop_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "local_sale_lines_sale_id_idx" ON "local_sale_lines"("sale_id");

-- CreateIndex
CREATE INDEX "local_sale_lines_service_id_idx" ON "local_sale_lines"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_sale_id_key" ON "invoices"("sale_id");

-- CreateIndex
CREATE INDEX "invoices_status_updated_at_idx" ON "invoices"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_barbershop_id_series_number_key" ON "invoices"("barbershop_id", "series", "number");

-- CreateIndex
CREATE INDEX "membership_plans_barbershop_id_idx" ON "membership_plans"("barbershop_id");

-- CreateIndex
CREATE INDEX "membership_plan_services_service_id_idx" ON "membership_plan_services"("service_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_status_idx" ON "memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "memberships_barbershop_id_status_idx" ON "memberships"("barbershop_id", "status");

-- CreateIndex
CREATE INDEX "memberships_membership_plan_id_idx" ON "memberships"("membership_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_provider_provider_subscription_id_key" ON "memberships"("provider", "provider_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_credit_lots_charge_id_key" ON "membership_credit_lots"("charge_id");

-- CreateIndex
CREATE INDEX "membership_credit_lots_membership_id_expires_at_idx" ON "membership_credit_lots"("membership_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "membership_credit_uses_booking_id_key" ON "membership_credit_uses"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_credit_uses_sale_id_key" ON "membership_credit_uses"("sale_id");

-- CreateIndex
CREATE INDEX "membership_credit_uses_lot_id_idx" ON "membership_credit_uses"("lot_id");

-- CreateIndex
CREATE INDEX "style_interactions_user_id_created_at_idx" ON "style_interactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "style_interactions_image_id_idx" ON "style_interactions"("image_id");

-- CreateIndex
CREATE INDEX "style_interactions_style_id_kind_idx" ON "style_interactions"("style_id", "kind");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_cover_image_id_fkey" FOREIGN KEY ("cover_image_id") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payer_user_id_fkey" FOREIGN KEY ("payer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_sponsor_purchase_id_fkey" FOREIGN KEY ("sponsor_purchase_id") REFERENCES "sponsor_package_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_package_purchases" ADD CONSTRAINT "sponsor_package_purchases_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_package_purchases" ADD CONSTRAINT "sponsor_package_purchases_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "sponsor_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_package_purchases" ADD CONSTRAINT "sponsor_package_purchases_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sponsor_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_clients" ADD CONSTRAINT "shop_clients_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_clients" ADD CONSTRAINT "shop_clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_shop_client_id_fkey" FOREIGN KEY ("shop_client_id") REFERENCES "shop_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_barber_id_fkey" FOREIGN KEY ("barber_id") REFERENCES "barbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sale_lines" ADD CONSTRAINT "local_sale_lines_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "local_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_sale_lines" ADD CONSTRAINT "local_sale_lines_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoicing_configs" ADD CONSTRAINT "invoicing_configs_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "local_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_plan_services" ADD CONSTRAINT "membership_plan_services_membership_plan_id_fkey" FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_plan_services" ADD CONSTRAINT "membership_plan_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_membership_plan_id_fkey" FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_credit_lots" ADD CONSTRAINT "membership_credit_lots_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_credit_lots" ADD CONSTRAINT "membership_credit_lots_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "billing_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_credit_uses" ADD CONSTRAINT "membership_credit_uses_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "membership_credit_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_credit_uses" ADD CONSTRAINT "membership_credit_uses_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_credit_uses" ADD CONSTRAINT "membership_credit_uses_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "local_sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_interactions" ADD CONSTRAINT "style_interactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_interactions" ADD CONSTRAINT "style_interactions_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_interactions" ADD CONSTRAINT "style_interactions_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Reglas manuales (CHECK e índices parciales) ─────────────

-- Planes: precios y comisión válidos; un solo plan por defecto por público.
ALTER TABLE "plans" ADD CONSTRAINT "plans_prices_check"
  CHECK ("price_monthly" >= 0 AND ("price_yearly" IS NULL OR "price_yearly" >= 0) AND "trial_days" BETWEEN 0 AND 90);
ALTER TABLE "plans" ADD CONSTRAINT "plans_commission_check"
  CHECK ("commission_bp" IS NULL OR "commission_bp" BETWEEN 0 AND 3000);
ALTER TABLE "plans" ADD CONSTRAINT "plans_code_check" CHECK ("code" ~ '^[a-z0-9_]{2,40}$');
CREATE UNIQUE INDEX "plans_one_default_per_audience" ON "plans" ("audience") WHERE "is_default";

ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_value_check"
  CHECK ("value" IS NULL OR "value" >= 0);

-- Suscripción: de una barbería o de un barbero (exactamente uno); una viva por titular.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_check"
  CHECK (num_nonnulls("barbershop_id", "barber_profile_id") = 1);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_check" CHECK ("price_amount" >= 0);
CREATE UNIQUE INDEX "subscriptions_live_barbershop" ON "subscriptions" ("barbershop_id")
  WHERE "barbershop_id" IS NOT NULL AND "status" IN ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE');
CREATE UNIQUE INDEX "subscriptions_live_barber" ON "subscriptions" ("barber_profile_id")
  WHERE "barber_profile_id" IS NOT NULL AND "status" IN ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE');

-- Cobros: exactamente un origen, según el propósito.
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_target_check" CHECK (
  ("purpose" = 'SUBSCRIPTION' AND "subscription_id" IS NOT NULL AND num_nonnulls("membership_id", "sponsor_purchase_id") = 0)
  OR ("purpose" = 'MEMBERSHIP' AND "membership_id" IS NOT NULL AND num_nonnulls("subscription_id", "sponsor_purchase_id") = 0)
  OR ("purpose" = 'SPONSOR_PACKAGE' AND "sponsor_purchase_id" IS NOT NULL AND num_nonnulls("subscription_id", "membership_id") = 0)
);
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_amount_check" CHECK ("amount" >= 0);

ALTER TABLE "sponsor_packages" ADD CONSTRAINT "sponsor_packages_values_check" CHECK (
  "price_amount" >= 0 AND ("impressions_limit" IS NULL OR "impressions_limit" > 0)
  AND "placements_limit" BETWEEN 1 AND 20 AND "duration_days" BETWEEN 1 AND 365
);
ALTER TABLE "sponsor_campaigns" ADD CONSTRAINT "sponsor_campaigns_impressions_check"
  CHECK ("impressions_count" >= 0 AND ("impressions_limit" IS NULL OR "impressions_limit" > 0));

-- Panel: clientes, caja, ventas y boletas.
ALTER TABLE "shop_clients" ADD CONSTRAINT "shop_clients_values_check"
  CHECK ("score" >= 0 AND "visits_count" >= 0 AND "total_spent" >= 0 AND length("display_name") BETWEEN 1 AND 80);
CREATE UNIQUE INDEX "cash_sessions_one_open" ON "cash_sessions" ("barbershop_id") WHERE "closed_at" IS NULL;
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_amounts_check" CHECK (
  "opening_amount" >= 0 AND ("counted_amount" IS NULL OR "counted_amount" >= 0)
  AND (("closed_at" IS NULL) = ("closed_by" IS NULL))
);
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_amounts_check" CHECK (
  "subtotal_amount" >= 0 AND "discount_amount" >= 0 AND "discount_amount" <= "subtotal_amount"
  AND "total_amount" = "subtotal_amount" - "discount_amount"
);
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_void_check" CHECK (
  ("status" = 'VOIDED') = ("voided_at" IS NOT NULL) AND ("status" <> 'VOIDED' OR "void_reason" IS NOT NULL)
);
ALTER TABLE "local_sales" ADD CONSTRAINT "local_sales_credit_check"
  CHECK (("payment_method" = 'MEMBERSHIP_CREDIT') = ("membership_id" IS NOT NULL));
ALTER TABLE "local_sale_lines" ADD CONSTRAINT "local_sale_lines_amounts_check"
  CHECK ("quantity" BETWEEN 1 AND 99 AND "unit_amount" >= 0 AND "total_amount" = "quantity" * "unit_amount");
ALTER TABLE "invoicing_configs" ADD CONSTRAINT "invoicing_configs_series_check"
  CHECK ("series" ~ '^B[0-9A-Z]{3}$' AND "next_number" >= 1);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_check"
  CHECK ("total_amount" >= 0 AND "tax_amount" >= 0 AND "tax_amount" <= "total_amount" AND "number" >= 1);
ALTER TABLE "barbers" ADD CONSTRAINT "barbers_commission_check"
  CHECK ("commission_bp" IS NULL OR "commission_bp" BETWEEN 0 AND 10000);

-- Membresías: créditos y cobro válidos; una viva por persona y membresía.
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_values_check"
  CHECK ("price_amount" > 0 AND "credits_per_period" BETWEEN 1 AND 60);
CREATE UNIQUE INDEX "memberships_live_per_user_plan" ON "memberships" ("user_id", "membership_plan_id")
  WHERE "status" IN ('PENDING', 'ACTIVE', 'PAST_DUE');
ALTER TABLE "membership_credit_lots" ADD CONSTRAINT "membership_credit_lots_values_check"
  CHECK ("granted" > 0 AND "remaining" BETWEEN 0 AND "granted");
ALTER TABLE "membership_credit_uses" ADD CONSTRAINT "membership_credit_uses_target_check"
  CHECK (num_nonnulls("booking_id", "sale_id") = 1);

-- Interacciones: con foto o con corte.
ALTER TABLE "style_interactions" ADD CONSTRAINT "style_interactions_target_check"
  CHECK (num_nonnulls("image_id", "style_id") >= 1);

-- Proporciones de la cara: las tres o ninguna, en rangos de una cara humana.
ALTER TABLE "images" ADD CONSTRAINT "images_face_ratios_check" CHECK (
  num_nonnulls("face_ratio_length", "face_ratio_forehead", "face_ratio_jaw") IN (0, 3)
  AND ("face_ratio_length" IS NULL OR "face_ratio_length" BETWEEN 0.7 AND 2.3)
  AND ("face_ratio_forehead" IS NULL OR "face_ratio_forehead" BETWEEN 0.5 AND 1.5)
  AND ("face_ratio_jaw" IS NULL OR "face_ratio_jaw" BETWEEN 0.4 AND 1.4)
);
