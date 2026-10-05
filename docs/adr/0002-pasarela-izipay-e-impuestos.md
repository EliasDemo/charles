# ADR 0002 — Pasarela de pago Izipay y precios con impuestos incluidos

- **Estado:** aceptada
- **Fecha:** 2026-10-05

## Contexto

CLAUDE.md §4.2 dejaba pendiente la pasarela de pago. El equipo eligió **Izipay** (Perú). Además, el esquema de reservas guarda un precio desglosado (`booking_price_lines` con tipos `SERVICE`, `DISCOUNT`, `FEE`, `TAX`), y faltaba decidir cómo cuentan los impuestos en el total.

## Decisión

### Pasarela

1. La pasarela es **Izipay**.
2. **No se integra nada hasta la Fase 8.** Hasta entonces el pago funciona detrás de la interfaz `PaymentGateway` con `FakeGateway`.
3. El esquema de pagos es **independiente del proveedor**:
   - `payments.provider` y `payment_events.provider` son texto libre (`FAKE`, `IZIPAY`, ...), no un enum ni columnas específicas de Izipay.
   - Los identificadores del proveedor van en `provider_payment_id` y `provider_event_id`, y los datos del aviso en `payload` (JSONB, sin datos de tarjeta).
4. Las credenciales de Izipay, **incluidas las de prueba**, nunca se guardan en el repositorio. Viven en el gestor de secretos.
5. Las referencias y los pendientes para la Fase 8 están en [docs/pagos-izipay.md](../pagos-izipay.md).

### Impuestos

1. **Los precios publicados incluyen impuestos.**
2. Una restricción `CHECK` garantiza `bookings.total_amount = subtotal_amount − discount_total_amount + fee_total_amount`.
3. No existe `tax_total_amount`. Las líneas `TAX` de `booking_price_lines` son **informativas** (por ejemplo, el IGV contenido en el precio) y **no suman al total**.

## Consecuencias

- Cambiar de proveedor o agregar uno nuevo no requiere migrar el esquema de pagos.
- Si en el futuro hay que discriminar impuestos (por ejemplo, para facturación electrónica), se agrega una columna y se ajusta el `CHECK` en una migración nueva.

## Revisión obligatoria antes de la Fase 8

- Confirmar el tratamiento de impuestos (precios con IGV incluido, líneas `TAX` informativas) con la información de facturación y de Izipay.
- Resolver los pendientes de `docs/pagos-izipay.md`.
- Cerrar las políticas de CLAUDE.md §4.2: medios de pago, devoluciones, comisión, no-show y plazo de cancelación.
