-- Fase 8A: reembolsos, revisión de cancelaciones de la barbería y conciliación.

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('CLIENT_CANCELLATION', 'BARBERSHOP_CANCELLATION', 'ORPHANED_PAYMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CancellationReviewStatus" AS ENUM ('PENDING_REVIEW', 'JUSTIFIED', 'UNJUSTIFIED');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "started_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "processed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reason_type" "RefundReason",
ADD COLUMN     "requested_at" TIMESTAMPTZ(3);
-- Filas previas (si las hubiera): reembolsos manuales con clave propia.
UPDATE "refunds" SET "idempotency_key" = 'legacy:' || "id"::text, "reason_type" = 'MANUAL'
 WHERE "idempotency_key" IS NULL;
ALTER TABLE "refunds" ALTER COLUMN "idempotency_key" SET NOT NULL,
                      ALTER COLUMN "reason_type" SET NOT NULL;

-- CreateTable
CREATE TABLE "barbershop_cancellation_reviews" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "cancelled_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "CancellationReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barbershop_cancellation_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "barbershop_cancellation_reviews_booking_id_key" ON "barbershop_cancellation_reviews"("booking_id");

-- CreateIndex
CREATE INDEX "barbershop_cancellation_reviews_barbershop_id_status_cancel_idx" ON "barbershop_cancellation_reviews"("barbershop_id", "status", "cancelled_at");

-- CreateIndex
CREATE INDEX "barbershop_cancellation_reviews_cancelled_by_idx" ON "barbershop_cancellation_reviews"("cancelled_by");

-- CreateIndex
CREATE INDEX "barbershop_cancellation_reviews_reviewed_by_idx" ON "barbershop_cancellation_reviews"("reviewed_by");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at");

-- AddForeignKey
ALTER TABLE "barbershop_cancellation_reviews" ADD CONSTRAINT "barbershop_cancellation_reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barbershop_cancellation_reviews" ADD CONSTRAINT "barbershop_cancellation_reviews_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barbershop_cancellation_reviews" ADD CONSTRAINT "barbershop_cancellation_reviews_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barbershop_cancellation_reviews" ADD CONSTRAINT "barbershop_cancellation_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────── SQL manual ─────────────

-- La suma de los reembolsos no fallidos de un pago nunca supera su importe. Bloquea la fila del
-- pago para que dos reembolsos simultáneos no la superen entre ambos.
CREATE FUNCTION refunds_within_payment_amount() RETURNS trigger AS $$
DECLARE
  paid INTEGER;
  refunded INTEGER;
BEGIN
  IF NEW."status" = 'FAILED' THEN
    RETURN NEW;
  END IF;
  SELECT "amount" INTO paid FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;
  SELECT COALESCE(SUM("amount"), 0) INTO refunded FROM "refunds"
   WHERE "payment_id" = NEW."payment_id" AND "status" <> 'FAILED' AND "id" <> NEW."id";
  IF refunded + NEW."amount" > paid THEN
    RAISE EXCEPTION 'refunds exceed payment amount'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_within_payment_amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_within_payment_amount
  BEFORE INSERT OR UPDATE OF "amount", "status", "payment_id" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION refunds_within_payment_amount();

-- Revisión coherente: calificada si y solo si tiene revisor y fecha.
ALTER TABLE "barbershop_cancellation_reviews" ADD CONSTRAINT "barbershop_cancellation_reviews_reviewed_check"
  CHECK (("status" = 'PENDING_REVIEW') = ("reviewed_by" IS NULL AND "reviewed_at" IS NULL));
ALTER TABLE "barbershop_cancellation_reviews" ADD CONSTRAINT "barbershop_cancellation_reviews_reason_check"
  CHECK (length(btrim("reason")) >= 3);

-- Fase 8A: el plazo de cancelación quedó sin efecto (la devolución depende de la anticipación).
DELETE FROM "app_settings" WHERE "key" = 'booking.cancellation_deadline_minutes';
