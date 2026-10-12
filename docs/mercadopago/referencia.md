# Mercado Pago — Referencia técnica

Pasarela activa para pruebas reales (Izipay se mantiene para el futuro). Producto: **Checkout Pro** con la **API de Preferences**, en **Perú** (mercadopago.com.pe). Leída el 2026-10-11 de la documentación oficial (`mercadopago.com.pe/developers/es/docs/checkout-pro-preferences/…`, webhooks, devoluciones, compras de prueba, Expo Go) y del código del SDK oficial de Node (`mercadopago` 3.6.1, `WebhookSignatureValidator`).

Este archivo **no contiene credenciales**. Van solo en `apps/api/.env`.

## 1. Credenciales ("Tus integraciones" → tu aplicación)

| Panel                                                             | Variable                     | Uso                                           |
| ----------------------------------------------------------------- | ---------------------------- | --------------------------------------------- |
| Pruebas → Credenciales de prueba → Access Token (o de producción) | `MERCADOPAGO_ACCESS_TOKEN`   | `Authorization: Bearer` en todas las llamadas |
| Webhooks → Configurar notificación → clave secreta                | `MERCADOPAGO_WEBHOOK_SECRET` | Firma `x-signature` de los webhooks           |

Además: `PAYMENTS_GATEWAY=mercadopago` y `PUBLIC_API_URL` (URL pública https de la API). Opcional `MERCADOPAGO_API_URL` (por defecto `https://api.mercadopago.com`).

## 2. API usada por Charles

| Operación                | Llamada                                                | Notas                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crear el pago            | `POST /checkout/preferences` (`X-Idempotency-Key`)     | `items` (1, `currency_id: PEN`, `unit_price` en soles), `external_reference` = ID del pago en Charles, `notification_url`, `back_urls`, `auto_return: approved`, vencimiento de 30 min. Respuesta: `id` e `init_point`. |
| Consultar un pago        | `GET /v1/payments/{id}`                                | `status`, `transaction_amount`, `currency_id`, `external_reference`, `live_mode`.                                                                                                                                       |
| Buscar pagos del pedido  | `GET /v1/payments/search?external_reference=…`         | Base de la conciliación.                                                                                                                                                                                                |
| Devolver (total/parcial) | `POST /v1/payments/{id}/refunds` (`X-Idempotency-Key`) | Cuerpo `{ amount }` (parcial) o vacío (total). Hasta 180 días. Hace falta saldo en la cuenta.                                                                                                                           |
| Estado de una devolución | `GET /v1/payments/{id}/refunds/{refund_id}`            | `approved`, `rejected`…                                                                                                                                                                                                 |

**Estados de un pago:** `approved` (confirma la reserva); `pending` / `in_process` (Yape y medios "offline": se confirma después); `rejected`, `cancelled` (la reserva sigue pendiente; el cliente puede reintentar hasta que venza); `refunded`.

## 3. Webhook

- `notification_url` = `{PUBLIC_API_URL}/api/v1/payments/webhooks/mercadopago?source_news=webhooks`. Con `source_news=webhooks` llegan solo webhooks firmados (sin las notificaciones IPN antiguas).
- Cuerpo: `{ id, live_mode, type: "payment", action, data: { id } }`. **No trae el monto:** Charles consulta `GET /v1/payments/{data.id}` antes de aplicar nada (fuera de transacciones).
- **Firma** (`x-signature: ts=…,v1=…`, `x-request-id`): `v1 = HMAC-SHA256-hex(secreto, "id:{data.id};request-id:{x-request-id};ts:{ts};")`, omitiendo las partes que falten.
- Responder 200 en menos de 22 s; si no, reintenta cada 15 min. Charles es idempotente por `{id del pago}:{estado}`. Otros temas (`merchant_order`…) se responden 200 y no se procesan.

## 4. App

La app recibe `clientAction = { type: "MERCADOPAGO_WEB", data: { paymentUrl: init_point, doneUrlPrefix } }` y lo abre en un WebView (igual que Izipay). Al terminar, Mercado Pago lleva a `back_urls` (`…/payments/mercadopago/return/{paymentId}?r=success|pending|failure`, GET); Charles consulta el pago y redirige a `…/payments/done?status=…`, que la app detecta. Mercado Pago recomienda en su guía de Expo Go abrir el checkout con `expo-web-browser` (Custom Tabs) y volver con un deep link; con WebView también funciona, y es lo que usa Charles para controlar el cierre.

`back_urls` y el webhook **no pueden ser `localhost`**: en desarrollo hace falta un túnel https (por ejemplo Cloudflare Tunnel) en `PUBLIC_API_URL`.

## 5. Pruebas reales (modo de prueba)

- Cuentas de prueba (vendedor y comprador, Perú) en "Tus integraciones" → Cuentas de prueba. Comprar en una ventana de incógnito, con sesión del **comprador de prueba**.
- Tarjetas de prueba: Mastercard `5031 7557 3453 0604`, Visa `4009 1753 3280 6176`, CVV `123`, vencimiento `11/30`. El **nombre del titular** decide el resultado: `APRO` aprobado, `OTHE` rechazado, `CONT` pendiente, `FUND` fondos insuficientes… (documento `123456789` para `APRO`/`OTHE`).
- Yape en pruebas termina **pendiente** (medio offline).

## 6. Por validar con la prueba real

- Que `init_point` abra bien en el WebView de la app (si no, usar `expo-web-browser`).
- Que lleguen los webhooks por el túnel y que la firma coincida (el manifiesto usa `data.id` del cuerpo, que debe ser igual al de la URL).
- El tiempo real de confirmación de Yape frente al vencimiento de la reserva (10 min): si se paga tarde, Charles devuelve el dinero automáticamente.
