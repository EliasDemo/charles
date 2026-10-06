-- Fase 7: límite de reservas PENDING_PAYMENT vigentes por cliente (booking.max_pending_per_client).
-- Índice parcial: solo las pendientes de pago, que son pocas y se consultan al crear cada reserva.
CREATE INDEX "bookings_client_pending_idx" ON "bookings" ("client_id", "expires_at")
  WHERE "status" = 'PENDING_PAYMENT';
