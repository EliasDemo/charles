# Izipay — Referencia técnica (Fase 8B)

Plataforma: **botón de pagos de Izipay** (`developers.izipay.pe`), la que Izipay ofrece hoy al afiliarse a "izipay online". Leída el 2026-10-11 de:

- especificación OpenAPI oficial: `https://developers.izipay.pe/yaml/api-v1-esp.yaml` (la que usa la página `/api/`);
- SDK web: `https://developers.izipay.pe/web-core/` (inicio rápido, modo redirect, firma, notificaciones, Yape);
- SDK de React Native: `https://developers.izipay.pe/react-native-core/`;
- credenciales: `https://developers.izipay.pe/credentials/`.

> **Descartada:** la referencia anterior se basaba en **micuentaweb** (`api.micuentaweb.pe`, `formToken`, `kr-hash`), otra plataforma de Izipay. El repositorio de ejemplo `izipay-pe/Webview-Redirect-ReactNative` (2024) también es de micuentaweb.

Este archivo **no contiene credenciales**. Van solo en `apps/api/.env` (desarrollo) o en el gestor de secretos (producción).

## 1. Credenciales (panel → Desarrolladores → Claves)

| Panel                                 | Variable               | Uso                                                      |
| ------------------------------------- | ---------------------- | -------------------------------------------------------- |
| Código de comercio                    | `IZIPAY_MERCHANT_CODE` | En todas las llamadas                                    |
| Clave de API del nuevo botón de pagos | `IZIPAY_API_KEY`       | Solo para generar el token de sesión (campo `publicKey`) |
| Clave hash                            | `IZIPAY_HASH_KEY`      | Firma HMAC-SHA256 de respuestas y notificaciones         |
| Clave pública (RSA)                   | `IZIPAY_PUBLIC_KEY`    | `keyRSA` del formulario web (admite `\n` escapados)      |
| RUC del comercio (Charles)            | `IZIPAY_RUC`           | Lo exige la API de devoluciones                          |

Paneles: pruebas `https://sandbox-panel.izipay.pe/`, producción `https://panel.izipay.pe/`. Las credenciales de pruebas las envía el soporte de Izipay por correo tras la afiliación.

Otras variables: `PAYMENTS_GATEWAY=izipay`, `IZIPAY_MODE` (`TEST` | `PRODUCTION`), `PUBLIC_API_URL` (URL pública de la API), y opcionales `IZIPAY_API_URL` e `IZIPAY_CHECKOUT_SCRIPT_URL`.

## 2. Servidores

| Qué                | Pruebas                                                      | Producción                                            |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| API                | `https://sandbox-api-pw.izipay.pe`                           | `https://api-pw.izipay.pe` (citado una vez en la doc) |
| Script del SDK web | `https://sandbox-checkout.izipay.pe/payments/v1/js/index.js` | `https://checkout.izipay.pe/payments/v1/js/index.js`  |

## 3. API REST usada por Charles

Todas con cabecera `transactionId` (5–40, único por operación; debe coincidir con el del token) y `Authorization: Bearer <token>` (salvo el token). Montos en **texto con 2 decimales** sin separador de miles (`"25.00"`). Respuesta `{ code, message, response }`; `code = "00"` es éxito.

| Operación             | Ruta                                    | Notas                                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token de sesión       | `POST /security/v1/Token/Generate`      | Cuerpo: `requestSource` (`ECOMMERCE` o `REFUND`), `merchantCode`, `orderNumber` (5–15), `publicKey` (la clave API), `amount` (`"0.00"` si no es un pago). Dura **15 min** y es de **un solo uso**.                                                                                                      |
| Consulta del pedido   | `POST /orderinfo/v1/Transaction/Search` | `merchantCode`, `numberOrden`, `language`. Responde firmado (`payloadHttp` + `signature`) con `response.order[]`.                                                                                                                                                                                       |
| Devolución            | `POST /refund/v1/Transaction/Refund`    | Token con `requestSource: REFUND`. Cuerpo: `merchantCode`, **`ruc`**, `idUnique` (uniqueId del pago), `order.authorizationCode`, `order.referenceNumber`, `order.currency`, `order.refundAmount` (parcial o total). Devuelve `refundTransactionId`. **Solo en producción** (no hay pruebas en sandbox). |
| Estado de devolución  | `GET /refund/v1/refunds/status`         | `refundId`, `merchantCode`, `language`. Responde `statusName` (p. ej. `AUTORIZADO`) y `rejectionReason`. `404 N01` = no existe; `429` con `Retry-After`.                                                                                                                                                |
| Anulación (no se usa) | `POST /cancel/api/Transaction/Cancel`   | Extorno de preautorizaciones; Charles cobra en un paso (`processType: AT`) y devuelve con la API de devoluciones.                                                                                                                                                                                       |

## 4. Firma

`signature = base64( HMAC-SHA256( payloadHttp, claveHash ) )`, sobre el **texto exacto** de `payloadHttp`. Solo se leen datos de `payloadHttp` (lo firmado), nunca del resto del cuerpo. No se valida cuando `code` es `021` o `COMMUNICATION_ERROR`.

## 5. Formulario web (lo que abre la app)

1. La app recibe `clientAction = { type: "IZIPAY_WEB", data: { paymentUrl, doneUrlPrefix } }` y abre `paymentUrl` en un WebView.
2. `GET /api/v1/payments/izipay/checkout/{paymentId}?e=&s=` (enlace firmado, 30 min): el backend pide un token de sesión y responde una página que carga el script y llama a `new Izipay({ config })` y `LoadForm({ authorization, keyRSA })`.
   - `config`: `transactionId`, `action: "pay"`, `merchantCode`, `order` (`orderNumber`, `currency`, `amount`, `payMethod: "CARD,YAPE_CODE"`, `processType: "AT"`, `merchantBuyerId`, `dateTimeTransaction`), `billing` (obligatorio: nombre, apellido, teléfono, dirección, ciudad, departamento, país, código postal), `urlIPN` y `render: { typeForm: "redirect", redirectUrls: { onSuccess, onError, onCancel } }`.
3. Al terminar, Izipay hace **POST** (`x-www-form-urlencoded`) a `…/payments/izipay/return/{paymentId}?r=success|error|cancel`. Si trae un resultado firmado, el backend **consulta el pedido** a Izipay (nunca confirma por el formulario) y redirige (303) a `…/payments/done?status=&paymentId=&bookingId=` (página final común a todas las pasarelas).
4. La app detecta que el WebView navegó a una URL que empieza con `doneUrlPrefix`, lo cierra y consulta la reserva.

**Yape:** `payMethod: "YAPE_CODE"`; el cliente ingresa su número y el código de aprobación de la app de Yape. Máximo **S/ 2000** por operación. Plin y QR existen en el SDK web pero no se activan todavía.

## 6. Notificación (IPN)

- `POST` JSON a `urlIPN` (se envía en cada pago: `{PUBLIC_API_URL}/api/v1/payments/webhooks/izipay`), con cabecera `transactionId`.
- Cuerpo: `code`, `message`, `messageUser`, `messageUserEng`, `response`, **`payloadHttp`**, **`signature`**, `transactionId`.
- **No trae marca de tiempo**: la protección es la firma más la idempotencia (`payment_events` por `transactionId:orderNumber:code`).
- `code = "00"` → pago aprobado → la reserva se confirma. Otro código → intento fallido: se registra y la reserva **sigue pendiente** (el cliente puede reintentar con otra tarjeta o Yape hasta que venza).

## 7. Lo que guarda Charles

- `payments.provider_payment_id` = número de pedido de Izipay (15 caracteres, derivado de la clave de idempotencia).
- Al aprobarse, `payments.metadata.provider` = `uniqueId`, `codeAuth`, `referenceNumber` y `payMethod` (necesarios para devolver). **Nunca** datos de tarjeta.

## 8. Por validar con una cuenta real

- Que el formulario acepte la dirección genérica de Lima en `billing` (Charles no guarda la dirección del cliente) y si `email` y `document` son obligatorios.
- El formato exacto de los campos que Izipay envía en el POST de regreso (`redirectUrls`).
- El `orderNumber` del token para consultar el estado de una devolución (la doc no lo precisa; se envía uno fijo).
- Los valores de `statusName` de una devolución, aparte de `AUTORIZADO`.
- La primera devolución real (la API no tiene pruebas en sandbox).
