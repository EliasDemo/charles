-- Fase 8B: comisión de Charles por reserva, calculada al reservar y congelada en la reserva.
-- Si la paga el cliente, también va como línea FEE (fee_total_amount y total la incluyen); si la
-- asume la barbería, el cliente paga solo el servicio y la comisión queda registrada aquí.

CREATE TYPE "CommissionPayer" AS ENUM ('CLIENT', 'BARBERSHOP');

ALTER TABLE "bookings"
  ADD COLUMN "commission_amount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "commission_payer" "CommissionPayer";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_commission_check" CHECK (
  "commission_amount" >= 0
  AND "commission_amount" <= "subtotal_amount"
  -- Si la paga el cliente, es exactamente lo cobrado como comisión.
  AND ("commission_payer" IS DISTINCT FROM 'CLIENT' OR "fee_total_amount" = "commission_amount")
);
