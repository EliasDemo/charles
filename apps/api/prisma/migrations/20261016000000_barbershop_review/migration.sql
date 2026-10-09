-- Alta de barberías con revisión previa: borrador, cambios pedidos, documento cifrado del
-- responsable e historial de envíos. La columna `ruc` (en claro) se migra con un script y se
-- elimina en la migración siguiente.

ALTER TYPE "BarbershopStatus" ADD VALUE 'DRAFT';
ALTER TYPE "BarbershopStatus" ADD VALUE 'CHANGES_REQUESTED';
CREATE TYPE "OwnerDocumentType" AS ENUM ('RUC', 'DNI');
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'CHANGES_REQUESTED');

ALTER TABLE "barbershops"
  ADD COLUMN "owner_document_type" "OwnerDocumentType",
  ADD COLUMN "owner_document_enc" TEXT,
  ADD COLUMN "owner_document_hash" BYTEA,
  ADD COLUMN "submitted_for_review_at" TIMESTAMPTZ(3),
  ADD COLUMN "review_notes" TEXT;
-- El documento va completo o no va.
ALTER TABLE "barbershops" ADD CONSTRAINT "barbershops_owner_document_complete_check"
  CHECK (
    ("owner_document_type" IS NULL AND "owner_document_enc" IS NULL AND "owner_document_hash" IS NULL)
    OR ("owner_document_type" IS NOT NULL AND "owner_document_enc" IS NOT NULL AND "owner_document_hash" IS NOT NULL)
  );
-- Búsqueda de soporte por documento (no es único: una persona puede tener varias barberías).
CREATE INDEX "barbershops_owner_document_hash_idx" ON "barbershops" ("owner_document_hash")
  WHERE "owner_document_hash" IS NOT NULL;

CREATE TABLE "barbershop_review_submissions" (
  "id" UUID NOT NULL,
  "barbershop_id" UUID NOT NULL,
  "submitted_by" UUID NOT NULL,
  "submitted_at" TIMESTAMPTZ(3) NOT NULL,
  "decision" "ReviewDecision",
  "decided_by" UUID,
  "decided_at" TIMESTAMPTZ(3),
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "barbershop_review_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "barbershop_review_submissions_decision_check" CHECK (
    ("decision" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL)
    OR ("decision" IS NOT NULL AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
  ),
  -- Pedir cambios exige motivo.
  CONSTRAINT "barbershop_review_submissions_reason_check" CHECK (
    "decision" IS DISTINCT FROM 'CHANGES_REQUESTED' OR "reason" IS NOT NULL
  )
);
CREATE INDEX "barbershop_review_submissions_barbershop_id_submitted_at_idx"
  ON "barbershop_review_submissions" ("barbershop_id", "submitted_at");
CREATE INDEX "barbershop_review_submissions_submitted_by_idx" ON "barbershop_review_submissions" ("submitted_by");
CREATE INDEX "barbershop_review_submissions_decided_by_idx" ON "barbershop_review_submissions" ("decided_by");
-- Un solo envío sin decidir por barbería.
CREATE UNIQUE INDEX "barbershop_review_submissions_one_open_key"
  ON "barbershop_review_submissions" ("barbershop_id") WHERE "decision" IS NULL;
ALTER TABLE "barbershop_review_submissions" ADD CONSTRAINT "barbershop_review_submissions_barbershop_id_fkey"
  FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "barbershop_review_submissions" ADD CONSTRAINT "barbershop_review_submissions_submitted_by_fkey"
  FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "barbershop_review_submissions" ADD CONSTRAINT "barbershop_review_submissions_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
