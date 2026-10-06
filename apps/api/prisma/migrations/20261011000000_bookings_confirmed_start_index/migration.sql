-- Fase 9: cierre automático de reservas CONFIRMED sin marcar (busca por start_at) y agenda.
CREATE INDEX "bookings_confirmed_start_idx" ON "bookings" ("start_at")
  WHERE "status" = 'CONFIRMED';
