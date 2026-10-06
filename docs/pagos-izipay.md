# Pagos con Izipay — referencias para la Fase 8

Decisión registrada en [ADR 0002](adr/0002-pasarela-izipay-e-impuestos.md). La **Fase 8A** (cerrada) construyó el sistema de pagos independiente del proveedor con `FakeGateway`; la **8B** agrega el adaptador de Izipay en modo de prueba.

**Referencia técnica detallada:** [docs/izipay/referencia.md](izipay/referencia.md) (API REST, SDK, firma y validaciones obligatorias; leída de la documentación oficial).

> **Credenciales:** ninguna credencial de Izipay, **ni siquiera las de prueba ni las de la tienda de demostración pública**, se guarda en el repositorio, en `.env.example`, en pruebas ni en seeds. En desarrollo viven en `apps/api/.env` (ignorado por git); en producción, en el gestor de secretos.

## Decisiones confirmadas

- **Plataforma: micuentaweb** (Lyra), con API REST V4 en `https://api.micuentaweb.pe/api-payment/V4/…`.
- **App móvil:** existe un **SDK oficial para React Native**, `@lyracom/react-native-sdk-payment-module`. Su ejemplo oficial es `izipay-pe/Embedded-PaymentForm-ReactNative-Sdk`. Su integración con Expo (módulo nativo, _development build_) se resuelve en la Fase 8B o en la de la app.

## Cómo encaja con la interfaz `PaymentGateway` (Fase 8A)

| Método                 | Izipay (8B)                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPayment`        | `Charge/CreatePayment` → `formToken`; `clientAction = IZIPAY_SDK` con `formToken`, clave pública y `apiServerName`                                                |
| `parseWebhook`         | IPN: verificar `kr-hash` (HMAC-SHA-256 de `kr-answer` con la **contraseña**), validar `shopId`, importe, moneda y modo; `providerEventId` = `transactions[].uuid` |
| `verifyClientResult`   | Respuesta de la app: `kr-hash` con la **clave HMAC-SHA-256**; solo dispara `getPayment`                                                                           |
| `getPayment`           | Servicio de consulta del pedido (por confirmar)                                                                                                                   |
| `refund` / `getRefund` | Servicio de reembolso (por confirmar)                                                                                                                             |
| `webhookMaxAgeSeconds` | `null`: la IPN no documenta marca de tiempo; la protección es la idempotencia por evento                                                                          |
| Errores                | La API responde siempre 200: `status = ERROR` → `PaymentGatewayError` con `errorCode`                                                                             |

## Flujo (fuentes: ejemplos oficiales de `github.com/izipay-pe`)

1. **El backend crea el pago:** `POST https://api.micuentaweb.pe/api-payment/V4/Charge/CreatePayment`.
   - Autenticación HTTP Basic con `usuario:contraseña` de la API REST (identificador de la tienda y contraseña de test o producción).
   - Cuerpo: `amount` en la unidad mínima (céntimos), `currency`, `orderId` y `customer`.
   - Si `status = "SUCCESS"`, la respuesta trae `answer.formToken`.
   - El ejemplo de React Native envía además `formTokenVersion` (obtenido con `getFormTokenVersion()` del SDK).
2. **La app recibe el `formToken`.** Con la **clave pública** inicializa el SDK (`initialize(publicKey, { apiServerName })`) y luego llama a `process(formToken, …)`.
3. **Resultado en la app:** el SDK devuelve la respuesta del pago. El ejemplo la envía al servidor para validar la firma: `kr-hash` es el HMAC-SHA-256 en hexadecimal de `kr-answer`, calculado con la **clave HMAC-SHA-256**. La app nunca confirma una reserva por sí misma.
4. **IPN (servidor a servidor):** Izipay envía `kr-answer` y `kr-hash`.
   - El ejemplo oficial calcula el HMAC-SHA-256 de `kr-answer` con la **contraseña** de la API REST, no con la clave HMAC.
   - `kr-answer` es un JSON con `orderStatus` (`PAID`/`UNPAID`), `orderDetails.orderId` y `transactions[0].uuid`.
   - La URL se configura en el Back Office: `Configuración → Reglas de notificaciones → URL de notificación al final del pago`.
5. **Credenciales:** se obtienen en el Back Office Vendedor, en `Configuración → Tiendas → Claves`. Hay claves distintas para el formulario estándar (redirección, iframe, WebView) y para la **API REST** (formulario incrustado, popin y SDK); Charles usa estas últimas.

## Pendiente de confirmar antes de la 8B (no suponer)

- Cómo se configura la URL de la IPN, y si `CreatePayment` permite indicarla por petición.
- Cómo recibir la IPN con la tienda de demostración. Los ejemplos solo muestran un túnel público al puerto local.
- Servicio y parámetros de **reembolso** total y parcial.
- Servicio de **consulta** del estado de un pedido o transacción (lo necesitan `getPayment` y la conciliación).
- Si la IPN trae alguna marca de tiempo.
- Disponibilidad de Yape, Plin y QR en el SDK móvil.
- Formato de las claves de test (si se distinguen por un prefijo), para reforzar la validación de arranque.
- La clave HMAC-SHA-256 de la tienda de demostración figura en la tabla de claves de la página "Prerrequisitos" de la documentación oficial. **Nunca se copia al repositorio.**

## Variables de entorno (Fase 8B)

| Variable                 | Contenido                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `IZIPAY_MODE`            | `TEST` o `PRODUCTION`. En producción la app no arranca si no es `PRODUCTION`.       |
| `IZIPAY_SHOP_ID`         | Usuario de la API REST (identificador de la tienda).                                |
| `IZIPAY_PASSWORD`        | Contraseña de la API REST (test o producción). Autenticación Basic y firma del IPN. |
| `IZIPAY_PUBLIC_KEY`      | Clave pública. El backend la entrega a la app para inicializar el SDK.              |
| `IZIPAY_HMAC_SHA256_KEY` | Clave HMAC-SHA-256. Firma de la respuesta que la app reenvía.                       |
| `IZIPAY_API_SERVER_NAME` | Servidor de la API REST para el SDK (`apiServerName`).                              |

## Requisitos que debe cumplir la integración (CLAUDE.md)

- Nunca usar la "API REST PCI-DSS" (recibe datos de tarjeta en bruto). Solo la API REST estándar con el SDK o el formulario incrustado (SAQ A).

- La reserva pasa a `CONFIRMED` **solo** por un resultado verificado del lado del servidor (IPN firmado, o consulta del pago al proveedor), nunca por lo que reporte la app.
- El IPN se procesa así:
  - se verifica la firma;
  - se rechazan los avisos antiguos;
  - se procesa con idempotencia por `provider_event_id` (`payment_events`).
- Charles nunca almacena ni procesa número de tarjeta, CVV ni vencimiento. Solo guarda identificadores y tokens del proveedor.
- Ninguna llamada a Izipay dentro de una transacción de base de datos (CLAUDE.md §1, regla 12).
- El esquema sigue siendo independiente del proveedor (`provider = 'IZIPAY'`).
