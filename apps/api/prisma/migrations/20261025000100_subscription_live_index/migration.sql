-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_barber_profile_id_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_barbershop_id_fkey";

-- DropIndex
DROP INDEX "subscriptions_barber_profile_id_status_idx";

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "barber_profile_id",
ALTER COLUMN "barbershop_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Una suscripción viva por barbería; el enlace pendiente (PENDING) puede convivir con el plan
-- vigente mientras se cambia de plan (el servicio deja un solo PENDING a la vez).
DROP INDEX IF EXISTS "subscriptions_live_barbershop";
CREATE UNIQUE INDEX "subscriptions_live_barbershop" ON "subscriptions" ("barbershop_id")
  WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE');
CREATE UNIQUE INDEX "subscriptions_one_pending" ON "subscriptions" ("barbershop_id")
  WHERE "status" = 'PENDING';
