-- AlterTable
ALTER TABLE "billing_events" ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "invoicing_configs" DROP CONSTRAINT "invoicing_configs_pkey",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD CONSTRAINT "invoicing_configs_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "local_sale_lines" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "membership_credit_lots" ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "membership_credit_uses" ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "membership_plan_services" DROP CONSTRAINT "membership_plan_services_pkey",
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD CONSTRAINT "membership_plan_services_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "plan_entitlements" DROP CONSTRAINT "plan_entitlements_pkey",
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "style_interactions" ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "invoicing_configs_barbershop_id_key" ON "invoicing_configs"("barbershop_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_plan_services_membership_plan_id_service_id_key" ON "membership_plan_services"("membership_plan_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_entitlements_plan_id_key_key" ON "plan_entitlements"("plan_id", "key");

-- CreateIndex
CREATE INDEX "services_style_id_idx" ON "services"("style_id");

-- CreateIndex
CREATE INDEX "services_cover_image_id_idx" ON "services"("cover_image_id");


-- Las filas existentes ya recibieron su id; en adelante lo genera la aplicación (UUID v7).
ALTER TABLE "invoicing_configs" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "membership_plan_services" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "plan_entitlements" ALTER COLUMN "id" DROP DEFAULT;
