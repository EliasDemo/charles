-- Fase 8A: la política de devolución quedó definida por las claves refunds.* (300/120 min, 50 %).
-- La clave antigua (sembrada en null como pendiente) ya no se usa.
DELETE FROM "app_settings" WHERE "key" = 'payments.cancellation_refund_policy';
