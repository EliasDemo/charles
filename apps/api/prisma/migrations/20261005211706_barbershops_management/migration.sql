-- CreateEnum
CREATE TYPE "InvitationKind" AS ENUM ('MEMBER', 'BARBER');

-- AlterEnum
ALTER TYPE "BarbershopStatus" ADD VALUE 'PENDING_REVIEW';

-- AlterTable
ALTER TABLE "barbershops" ADD COLUMN     "closure_reason" TEXT,
ADD COLUMN     "expected_reopen_at" TIMESTAMPTZ(3),
ADD COLUMN     "facebook_url" TEXT,
ADD COLUMN     "instagram_url" TEXT,
ADD COLUMN     "ruc" TEXT,
ADD COLUMN     "website_url" TEXT;

-- CreateTable
CREATE TABLE "barbershop_invitations" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "kind" "InvitationKind" NOT NULL,
    "member_role" "BarbershopMemberRole",
    "barber_id" UUID,
    "invited_user_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barbershop_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "barbershop_invitations_barbershop_id_idx" ON "barbershop_invitations"("barbershop_id");

-- CreateIndex
CREATE INDEX "barbershop_invitations_barber_id_idx" ON "barbershop_invitations"("barber_id");

-- CreateIndex
CREATE INDEX "barbershop_invitations_invited_user_id_idx" ON "barbershop_invitations"("invited_user_id");

-- CreateIndex
CREATE INDEX "barbershop_invitations_invited_by_idx" ON "barbershop_invitations"("invited_by");

-- AddForeignKey
ALTER TABLE "barbershop_invitations" ADD CONSTRAINT "barbershop_invitations_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barbershop_invitations" ADD CONSTRAINT "barbershop_invitations_barber_id_fkey" FOREIGN KEY ("barber_id") REFERENCES "barbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barbershop_invitations" ADD CONSTRAINT "barbershop_invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barbershop_invitations" ADD CONSTRAINT "barbershop_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════
-- SQL manual (Fase 4, CLAUDE.md §4.1).
-- ════════════════════════════════════════════════════════════════════════

-- RUC opcional de 11 dígitos.
ALTER TABLE "barbershops" ADD CONSTRAINT "barbershops_ruc_check" CHECK ("ruc" IS NULL OR "ruc" ~ '^[0-9]{11}$');

-- Enlaces públicos solo https.
ALTER TABLE "barbershops" ADD CONSTRAINT "barbershops_links_check" CHECK (
  ("website_url" IS NULL OR "website_url" LIKE 'https://%') AND
  ("instagram_url" IS NULL OR "instagram_url" LIKE 'https://%') AND
  ("facebook_url" IS NULL OR "facebook_url" LIKE 'https://%')
);

-- Motivo y fecha de reapertura solo con cierre temporal.
ALTER TABLE "barbershops" ADD CONSTRAINT "barbershops_closure_check" CHECK (
  "status" = 'TEMPORARILY_CLOSED' OR ("closure_reason" IS NULL AND "expected_reopen_at" IS NULL)
);

-- Servicios: sin servicios gratuitos; duración de 5 a 480 minutos en múltiplos de 5.
ALTER TABLE "services" ADD CONSTRAINT "services_price_positive_check" CHECK ("price_amount" > 0);
ALTER TABLE "services" ADD CONSTRAINT "services_duration_rule_check" CHECK (
  "duration_minutes" BETWEEN 5 AND 480 AND "duration_minutes" % 5 = 0
);

-- Invitaciones: MEMBER lleva rol; BARBER lleva barbero. Intentos de 0 a 5.
ALTER TABLE "barbershop_invitations" ADD CONSTRAINT "barbershop_invitations_kind_check" CHECK (
  ("kind" = 'MEMBER' AND "member_role" IS NOT NULL AND "barber_id" IS NULL) OR
  ("kind" = 'BARBER' AND "barber_id" IS NOT NULL AND "member_role" IS NULL)
);
ALTER TABLE "barbershop_invitations" ADD CONSTRAINT "barbershop_invitations_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5);
