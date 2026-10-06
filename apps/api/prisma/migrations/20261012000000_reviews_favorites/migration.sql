-- Fase 11: valoraciones (edición, respuesta, ocultamiento), reportes con motivo cerrado y
-- promedio por barbero.

CREATE TYPE "ReviewReportReason" AS ENUM ('OFFENSIVE', 'PERSONAL_DATA', 'FAKE', 'SPAM', 'OTHER');
CREATE TYPE "ReviewReportTarget" AS ENUM ('REVIEW', 'RESPONSE');

ALTER TABLE "barbers"
  ADD COLUMN "rating_avg" DECIMAL(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN "rating_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "reviews"
  ADD COLUMN "hidden_reason" TEXT,
  ADD COLUMN "edited_at" TIMESTAMPTZ(3),
  ADD COLUMN "response_text" TEXT,
  ADD COLUMN "response_by" UUID,
  ADD COLUMN "response_at" TIMESTAMPTZ(3),
  ADD COLUMN "response_status" "ReviewStatus";

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_response_by_fkey"
  FOREIGN KEY ("response_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Comentario 3-500 (texto plano, recortado por la API); respuesta 1-500.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_comment_length_check"
  CHECK ("comment" IS NULL OR char_length("comment") BETWEEN 3 AND 500);
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_response_length_check"
  CHECK ("response_text" IS NULL OR char_length("response_text") BETWEEN 1 AND 500);
-- La respuesta va completa o no va.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_response_complete_check"
  CHECK (
    ("response_text" IS NULL AND "response_by" IS NULL AND "response_at" IS NULL AND "response_status" IS NULL)
    OR ("response_text" IS NOT NULL AND "response_by" IS NOT NULL AND "response_at" IS NOT NULL AND "response_status" IS NOT NULL)
  );
-- Solo una oculta tiene motivo de ocultamiento, y solo de la lista conocida.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_hidden_reason_check"
  CHECK (
    ("status" = 'HIDDEN' AND "hidden_reason" IN ('attendance_corrected', 'moderation'))
    OR ("status" <> 'HIDDEN' AND "hidden_reason" IS NULL)
  );

-- Listado público por barbería y por barbero (las más recientes primero; id es UUID v7).
CREATE INDEX "reviews_public_barbershop_idx" ON "reviews" ("barbershop_id", "id" DESC)
  WHERE "deleted_at" IS NULL AND "status" <> 'HIDDEN';

-- Reportes: motivo de lista cerrada, texto opcional, uno por usuario y objetivo.
ALTER TABLE "review_reports" RENAME COLUMN "reason" TO "details";
ALTER TABLE "review_reports" ALTER COLUMN "details" DROP NOT NULL;
ALTER TABLE "review_reports"
  ADD COLUMN "target" "ReviewReportTarget" NOT NULL DEFAULT 'REVIEW',
  ADD COLUMN "reason" "ReviewReportReason" NOT NULL DEFAULT 'OTHER';
ALTER TABLE "review_reports" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_details_length_check"
  CHECK ("details" IS NULL OR char_length("details") <= 500);
DROP INDEX "review_reports_review_id_idx";
CREATE UNIQUE INDEX "review_reports_review_id_target_reported_by_key"
  ON "review_reports" ("review_id", "target", "reported_by");
