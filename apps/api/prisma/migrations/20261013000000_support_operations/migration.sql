-- Fase 12: soporte y operación. Rol ADMIN, cancelación por soporte, reportes de barberías con
-- motivo cerrado, marca de revisión en barberías y fechas de resolución y cierre de tickets.

ALTER TYPE "Role" ADD VALUE 'ADMIN';
ALTER TYPE "CancelledByRole" ADD VALUE 'SUPPORT';
ALTER TYPE "RefundReason" ADD VALUE 'SUPPORT_CANCELLATION';

CREATE TYPE "BarbershopReportReason" AS ENUM (
  'FRAUD', 'MISLEADING_INFO', 'INAPPROPRIATE', 'NOT_OPERATING', 'SAFETY', 'OTHER'
);

-- Barberías marcadas para revisión por el sistema (por ejemplo, su único OWNER fue deshabilitado).
ALTER TABLE "barbershops"
  ADD COLUMN "flagged_reason" TEXT,
  ADD COLUMN "flagged_at" TIMESTAMPTZ(3);
ALTER TABLE "barbershops" ADD CONSTRAINT "barbershops_flag_complete_check"
  CHECK (("flagged_reason" IS NULL) = ("flagged_at" IS NULL));

-- Tickets: fechas de resolución y cierre, asunto acotado, relación con un tipo conocido.
ALTER TABLE "support_tickets"
  ADD COLUMN "resolved_at" TIMESTAMPTZ(3),
  ADD COLUMN "closed_at" TIMESTAMPTZ(3);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_subject_length_check"
  CHECK (char_length("subject") BETWEEN 3 AND 120);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_related_check"
  CHECK (
    ("related_type" IS NULL AND "related_id" IS NULL)
    OR ("related_type" IN ('booking', 'payment', 'barbershop') AND "related_id" IS NOT NULL)
  );
CREATE INDEX "support_tickets_status_created_at_idx" ON "support_tickets" ("status", "created_at");

-- Reportes de barberías: motivo de lista cerrada, texto opcional, uno por usuario y barbería.
ALTER TABLE "barbershop_reports" RENAME COLUMN "reason" TO "details";
ALTER TABLE "barbershop_reports" ALTER COLUMN "details" DROP NOT NULL;
ALTER TABLE "barbershop_reports"
  ADD COLUMN "reason" "BarbershopReportReason" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "resolved_by" UUID,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(3);
ALTER TABLE "barbershop_reports" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "barbershop_reports" ADD CONSTRAINT "barbershop_reports_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "barbershop_reports" ADD CONSTRAINT "barbershop_reports_details_length_check"
  CHECK ("details" IS NULL OR char_length("details") <= 500);
DROP INDEX "barbershop_reports_barbershop_id_idx";
CREATE UNIQUE INDEX "barbershop_reports_barbershop_id_reported_by_key"
  ON "barbershop_reports" ("barbershop_id", "reported_by");
CREATE INDEX "barbershop_reports_resolved_by_idx" ON "barbershop_reports" ("resolved_by");
CREATE INDEX "barbershop_reports_status_created_at_idx" ON "barbershop_reports" ("status", "created_at");
