# Izipay (micuentaweb) — Referencia técnica para la Fase 8B

Resumen de dos páginas de la documentación oficial, leídas el 2026-10-06:

- Especificaciones de intercambios REST: `https://secure.micuentaweb.pe/doc/es-PE/rest/V4.0/api/kb/webservice_usage.html`
- Guía de integración para React Native: `https://secure.micuentaweb.pe/doc/es-PE/mobp/integration_guide/react_native/`

Este archivo **no contiene credenciales**. Las claves van solo en `apps/api/.env`.

---

## 1. API REST

- Servidor: `https://api.micuentaweb.pe`
- Ruta base: `/api-payment/V4/`
- **Siempre POST**, con cuerpo JSON. No se envían parámetros en la URL.
- **Autenticación Basic**: `usuario:contraseña` de la API REST, en Base64, en la cabecera `Authorization`.
- **La API responde siempre HTTP 200.** El éxito o el error se lee dentro del JSON, en el campo `status` (`SUCCESS` o `ERROR`). No se puede confiar en el código HTTP.
- Fechas en ISO 8601; el servidor responde siempre en UTC.
- Las propiedades nulas no obligatorias se omiten de la respuesta.

### Servicios vistos

| Servicio               | Uso                                                                  |
| ---------------------- | -------------------------------------------------------------------- |
| `Charge/SDKTest`       | Prueba de conexión y credenciales: devuelve el mismo `value` enviado |
| `Charge/CreatePayment` | Crea el pago y devuelve el `formToken`                               |

### Sobre de respuesta

| Campo                 | Significado                                |
| --------------------- | ------------------------------------------ |
| `webService`          | Servicio llamado                           |
| `version`             | Versión de la API                          |
| `status`              | `SUCCESS` o `ERROR`                        |
| `answer`              | Respuesta de negocio, o el objeto de error |
| `serverDate`          | Fecha del servidor en UTC                  |
| `applicationProvider` | Plataforma (en Perú: `MCW`)                |

### Errores

Con `status = ERROR`, `answer` es un `WebService/WebServiceError`:

| Campo                  | Significado                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `errorCode`            | Código con formato `PREFIJO_CÓDIGO` (ejemplo: `INT_902`, error de validación de entrada) |
| `errorMessage`         | Mensaje                                                                                  |
| `detailedErrorCode`    | Código detallado o nulo                                                                  |
| `detailedErrorMessage` | Mensaje detallado o nulo                                                                 |

---

## 2. Datos de tarjeta (PCI-DSS)

- Con el formulario incrustado o el SDK móvil, los datos de tarjeta los captura la plataforma de pago y **nunca pasan por los sistemas del comercio**. La obligación del comercio se limita al cuestionario SAQ A.
- Existe una "API REST PCI-DSS" que recibe datos de tarjeta en bruto. **Charles no debe usarla nunca**: está reservada a comercios certificados (SAQ D).
- La API REST estándar (reembolsos, anulaciones, consulta y gestión de transacciones) no maneja datos de tarjeta y no añade exigencias. Es la que usa el backend.

---

## 3. SDK móvil para React Native

- Paquete: `@lyracom/react-native-sdk-payment-module`.
- Desde la versión 2.0.0 es un TurboModule: exige la **nueva arquitectura** y **React Native 0.77 o superior**.
- **Expo:**
  - Requiere un _config plugin_ propio que modifica el Podfile de iOS para tratar como frameworks dinámicos: `LyraPaymentSDK`, `LyraMotion`, `LyraMaterial`, `SnapKit`.
  - **No funciona con Expo Go.** Hay que generar una compilación de desarrollo con `expo-dev-client` (EAS Build) e instalarla en el dispositivo.
- El SDK no admite procesos simultáneos: mientras hay una llamada en curso, las demás se ignoran sin error ni callback.

### Flujo

1. El backend llama a `Charge/CreatePayment` y obtiene el `formToken`.
2. La app llama a `initialize(publicKey, { apiServerName })`.
3. La app llama a `process(formToken, options)`.
4. El resultado llega por dos vías: a la app (objeto `LyraResponse`) y al servidor (IPN).

### Opciones de `initialize`

| Opción                 | Uso                                       | Android | iOS |
| ---------------------- | ----------------------------------------- | ------- | --- |
| `apiServerName`        | Obligatoria: `https://api.micuentaweb.pe` | Sí      | Sí  |
| `applePayMerchantId`   | Contrato de Apple Pay                     | No      | Sí  |
| `applePayMerchantName` | Nombre mostrado en Apple Pay              | No      | Sí  |
| `nfcEnabled`           | Lectura de tarjeta por NFC                | Sí      | No  |
| `cardScanningEnabled`  | Escaneo de tarjeta con cámara             | Sí      | Sí  |

### Opciones de `process`

| Opción                 | Uso                                                        |
| ---------------------- | ---------------------------------------------------------- |
| `customPayButtonLabel` | Texto del botón de pagar                                   |
| `customHeaderLabel`    | Texto del encabezado                                       |
| `customPopupLabel`     | Texto mientras se procesa                                  |
| `paymentMethodType`    | `PaymentMethods.ALL` (por defecto) o `PaymentMethods.CARD` |

---

## 4. Resultado del pago y verificación de firma

La respuesta a la app y la IPN traen la misma estructura:

| Campo               | Significado                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `kr-answer`         | Resultado del pago, como texto JSON                                           |
| `kr-answer-type`    | Tipo del objeto (ejemplo: `V4/Payment`)                                       |
| `kr-hash`           | Firma de `kr-answer`                                                          |
| `kr-hash-algorithm` | `sha256_hmac`                                                                 |
| `kr-hash-key`       | Qué clave firmó: `password` en la IPN, `sha256_hmac` en la respuesta a la app |

### Cómo verificar

- Calcular HMAC-SHA-256 de `kr-answer`, en hexadecimal, y compararlo con `kr-hash`.
- **IPN:** la clave es la **contraseña** de la API REST.
- **Respuesta que reenvía la app:** la clave es la **clave HMAC-SHA-256** (la tercera de la tabla de claves de API REST).
- La firma se calcula sobre el texto de `kr-answer` exactamente como llegó, sin volver a serializarlo.
- La comparación debe ser en tiempo constante.

### Campos útiles dentro de `kr-answer`

| Campo                                      | Uso en Charles                               |
| ------------------------------------------ | -------------------------------------------- |
| `shopId`                                   | Debe coincidir con la tienda configurada     |
| `orderStatus`                              | `PAID` o `UNPAID`                            |
| `orderCycle`                               | Ejemplo: `CLOSED`                            |
| `orderDetails.orderId`                     | Referencia propia: el ID del pago en Charles |
| `orderDetails.orderTotalAmount`            | Importe en céntimos                          |
| `orderDetails.orderCurrency`               | Moneda                                       |
| `orderDetails.mode`                        | `TEST` o producción                          |
| `transactions[].uuid`                      | ID de la transacción en la pasarela          |
| `transactions[].status` / `detailedStatus` | Ejemplo: `PAID` / `AUTHORISED`               |
| `transactions[].operationType`             | Ejemplo: `DEBIT`                             |
| `transactions[].paymentMethodType`         | Ejemplo: `CARD`                              |

### Validaciones obligatorias antes de confirmar una reserva

1. Firma válida.
2. `shopId` igual al configurado.
3. `orderId` corresponde a un pago existente en Charles.
4. Importe y moneda iguales a los del pago en Charles.
5. `mode` coherente con el entorno: en producción se rechaza cualquier respuesta con `mode = TEST`.
6. Idempotencia por `transactions[].uuid`.

La respuesta que reenvía la app nunca confirma por sí sola: solo dispara la consulta al proveedor.

---

## 5. Sin confirmar todavía

Estas páginas no lo explican. Hay que buscarlo en el resto de la documentación (páginas "Prerrequisitos", IPN y referencia de la API):

- Cómo configurar la URL de la IPN, y si `CreatePayment` permite indicarla por petición. La guía solo dice que la IPN requiere configurar las reglas de notificación.
- Cómo recibir la IPN usando la tienda de demostración.
- El servicio y los parámetros para reembolsos totales y parciales.
- El servicio para consultar el estado de un pedido o transacción.
- La clave HMAC-SHA-256 de la tienda de demostración (está en la "tabla de claves de API REST" de la página Prerrequisitos).
- Si la IPN incluye alguna marca de tiempo utilizable contra repeticiones.
- Disponibilidad de Yape, Plin y QR a través del SDK móvil.
