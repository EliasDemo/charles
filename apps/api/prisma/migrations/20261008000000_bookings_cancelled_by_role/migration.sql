-- Quién canceló una reserva, como columna propia (antes en metadata.cancelledByRole).
CREATE TYPE "CancelledByRole" AS ENUM ('CLIENT', 'BARBERSHOP', 'SYSTEM');

ALTER TABLE "bookings" ADD COLUMN "cancelled_by_role" "CancelledByRole";

-- Migrar los valores guardados en metadata y quitar la clave.
UPDATE "bookings"
   SET "cancelled_by_role" = ("metadata" ->> 'cancelledByRole')::"CancelledByRole",
       "metadata" = "metadata" - 'cancelledByRole'
 WHERE "metadata" ? 'cancelledByRole';

-- Canceladas sin rol registrado (anteriores a la Fase 7): sin usuario = sistema; con usuario, cliente
-- si es el propio cliente y barbería en otro caso.
UPDATE "bookings"
   SET "cancelled_by_role" = CASE
         WHEN "cancelled_by" IS NULL THEN 'SYSTEM'::"CancelledByRole"
         WHEN "cancelled_by" = "client_id" THEN 'CLIENT'::"CancelledByRole"
         ELSE 'BARBERSHOP'::"CancelledByRole"
       END
 WHERE "status" = 'CANCELLED' AND "cancelled_by_role" IS NULL;

-- El rol existe si y solo si la reserva está cancelada.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_role_check"
  CHECK (("status" = 'CANCELLED') = ("cancelled_by_role" IS NOT NULL));
