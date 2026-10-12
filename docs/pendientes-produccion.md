# Pendientes para salir a producción

Lista de todo lo que **bloquea** el lanzamiento de Charles. Se revisa al cerrar cada fase (CLAUDE.md §1, regla 13): se agrega lo nuevo y se marca lo resuelto, indicando la fase o decisión que lo cerró.

Última revisión: cierre de la Fase 8B (pagos con Izipay).

## Decisiones de negocio pendientes (CLAUDE.md §4.2)

Resueltas en la Fase 8A: devoluciones al cancelar, plazo para cancelar, no-show y sanción por cancelaciones de la barbería.

| Pendiente                                       | Situación actual                                                                                                                                                         | Dónde       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| **Comisión de Charles**                         | **Resuelto (Fase 8B):** configurable por ADMIN (`fees.percent_bp`, `fees.fixed_amount`, `fees.payer`), congelada en cada reserva. Hoy en 0. Falta decidir el valor real. |
| **Comisión de la pasarela en las devoluciones** | **Decidido:** la asume la barbería. Se aplica en la liquidación (pendiente).                                                                                             |
| **Liquidación a la barbería**                   | Fuera de alcance: cuándo y cómo recibe el dinero la barbería (y el de un no-show).                                                                                       | Por definir |
| **Sanción económica a la barbería**             | Solo existe la suspensión por 3 cancelaciones injustificadas en 30 días. La multa o el descuento quedan pendientes.                                                      | Por definir |
| **Corrección de asistencia fuera de plazo**     | Pasadas 48 h del inicio, solo soporte puede corregir `ATTENDED` ↔ `NO_SHOW`; falta la herramienta.                                                                       | Fase 12     |
| **Reservas de una barbería suspendida**         | Las reservas futuras se dejan como están. Falta decidir si se cancelan y se devuelven, y cómo se avisa al cliente.                                                       | Fase 12     |
| **Medios de pago**                              | **Decidido (Fase 8B):** tarjeta y Yape (formulario web de Izipay). Plin y QR existen en el SDK web: evaluar con la cuenta real.                                          |

## Fases de crecimiento (13 a 16, ADR 0004)

| Pendiente                                         | Situación actual                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Almacenamiento de imágenes en producción (R2)** | Decidido: Cloudflare R2 (capa gratuita de 10 GB, sin costo de salida). Implementado en la Fase 14 con S3 (en local, SeaweedFS). Falta crear el bucket y las credenciales: ver «Guía: Cloudflare R2» abajo. La app no arranca en producción con credenciales locales, endpoint local ni sin `MEDIA_PUBLIC_BASE_URL` https. |
| **Planes y precios**                              | Sin definir qué planes habrá ni sus precios mensual y anual.                                                                                                                                                                                                                                                              |
| **Beneficios por plan**                           | Sin definir qué derechos y límites tiene cada plan (barberos, sedes, fotos, días destacados, mensajes, membresías, promociones, estadísticas, insignia, soporte prioritario).                                                                                                                                             |
| **Comisión por plan**                             | Sin definir la comisión de Charles por reserva en cada plan (hoy línea `FEE` en 0).                                                                                                                                                                                                                                       |
| **Periodo de prueba**                             | Sin definir si habrá prueba gratuita, de cuántos días y en qué planes.                                                                                                                                                                                                                                                    |
| **Cobro recurrente en Izipay**                    | Por confirmar si Izipay ofrece cobros recurrentes programados. Si no, Charles programaría el cobro con un token guardado.                                                                                                                                                                                                 |
| **Apple y Google**                                | Revisar sus políticas sobre suscripciones dentro de la app: si la suscripción de la barbería y las membresías de clientes pueden cobrarse fuera de las tiendas o exigen su sistema de pagos.                                                                                                                              |

## Integraciones reales

| Pendiente                                            | Situación actual                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedor de correo real**                         | Solo existe `FakeMailer`, que guarda los correos en Redis. La app no arranca en producción con `MAILER_DRIVER=fake`. Previsto para la Fase 10.                                                                                                                                                                                                                    |
| **Pasarela de pagos real (Izipay)**                  | **Implementada (Fase 8B)** y probada con un simulador. Falta: afiliación a "izipay online" (con RUC: la API de devoluciones lo exige), credenciales de pruebas y producción en `.env`, `PAYMENTS_GATEWAY=izipay`, `payments.provider = IZIPAY`, `PUBLIC_API_URL` https, y un pago real de punta a punta. Ver `docs/izipay/referencia.md` §8 (puntos por validar). |
| **IPN de Izipay en producción**                      | La URL se envía en cada pago (`urlIPN` = `PUBLIC_API_URL/api/v1/payments/webhooks/izipay`); no hay que configurarla en el panel. Verificar que llegue con la cuenta real.                                                                                                                                                                                         |
| **Impuestos**                                        | Los precios incluyen impuestos (ADR 0002) y hoy solo se guarda una línea `SERVICE`. Hay que revisar si hace falta desglosar el IGV (línea `TAX`) antes de la Fase 8.                                                                                                                                                                                              |
| **RUC**                                              | **Decidido:** la barbería registra DNI o RUC. El RUC que exige Izipay para devolver es el de Charles (`IZIPAY_RUC`).                                                                                                                                                                                                                                              |
| **Dominio propio verificado para el correo**         | El correo real se decide antes de producción (hoy `FakeMailer`, interfaz `Mailer` lista). Para enviar hace falta un dominio propio verificado en el proveedor (SPF, DKIM y DMARC), y luego implementar el `Mailer` real.                                                                                                                                          |
| **Push real (Expo): credenciales que configuras tú** | En el proyecto de Expo (EAS): credenciales de **Firebase Cloud Messaging** para Android (cuenta de servicio FCM v1) y la **clave de APNs** de Apple (Apple Developer) para iOS. En el backend, `PUSH_DRIVER=expo` y, si activas "enhanced push security", `EXPO_ACCESS_TOKEN` en `apps/api/.env` (nunca en el repositorio).                                       |

## Aspectos legales

| Pendiente                                                                | Situación actual                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validación legal de la edad mínima**                                   | 18 años, autodeclarados con una casilla al registrarse (ADR 0003). Falta la validación legal.                                                                                                                                             |
| **Términos y condiciones definitivos**                                   | `legal.terms_version` tiene un valor provisional (`borrador-2026-10`). Falta el texto publicado y su versión.                                                                                                                             |
| **URLs de términos y privacidad**                                        | `legal.terms_url` y `legal.privacy_url` tienen valores provisionales (`https://charles.example/...`). Reemplazarlos por las URLs publicadas (editables por ADMIN en `/admin/settings`).                                                   |
| **Plazo de conservación tras eliminar una cuenta** (decisión del asesor) | `account_deletion.legal_retention_days` está en `null`. Definir cuánto se conservan pagos, reembolsos y reservas anonimizados (obligación tributaria y contable) y, al vencer, purgarlos.                                                 |
| **Política de privacidad: eliminación de cuenta**                        | Describir qué se borra, qué se anonimiza y qué se conserva y por cuánto (pagos, reservas, auditoría sin IP, puntuación de valoraciones), los 30 días de gracia y el bloqueo de 12 meses del correo de cuentas deshabilitadas por soporte. |
| **Página web para pedir la eliminación** (Google Play)                   | Google exige una URL donde pedir la eliminación sin la app. Hoy solo existe desde la app.                                                                                                                                                 |
| **Respaldos y logs respetan la eliminación**                             | Los respaldos de la base y los logs (y sus copias) deben dejar de contener los datos de una cuenta eliminada dentro de su plazo de retención: definir esos plazos y documentarlos en la política de privacidad.                           |

## Web y seguridad

| Pendiente                    | Situación actual                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookies y CSRF de la web** | Hoy la sesión usa tokens en cabecera (app móvil). Antes de publicar la web hay que definir las cookies (`HttpOnly`, `Secure`, `SameSite`) y la protección CSRF. |

| **Versión mínima de la app** | Sin mecanismo hoy. Antes del lanzamiento: cabecera `X-App-Version` y respuesta `426` o `APP_UPDATE_REQUIRED` para obligar a actualizar cuando cambie el contrato. |
| **Textos de validación en español** | `VALIDATION_ERROR` devuelve `field` y `constraints` con nombres de reglas en inglés. Definir mensajes por campo en español (backend o tabla en la app) antes del lanzamiento. |

| **Verificación en dos pasos para SUPPORT y ADMIN** (bloqueante) | **No se puede salir a producción sin esto.** Hoy soporte y ADMIN entran solo con contraseña. Exigir un segundo factor (TOTP o similar) a esas cuentas. |
| **Sesiones más cortas para SUPPORT y ADMIN** (bloqueante) | **No se puede salir a producción sin esto.** Hoy usan la misma sesión de 30 días que un cliente. Definir una vida corta del token de renovación y reautenticación para acciones sensibles. |

## Operación

| Pendiente                                | Situación actual                                                                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ejecución real del CI**                | `.github/workflows/ci.yml` existe pero nunca se ejecutó: el proyecto todavía no tiene remoto. Hasta entonces, `pnpm verify` (hook de pre-commit) es la única verificación.                                                                                           |
| **Privilegios de la base en producción** | `postgis` no es una extensión "trusted": el usuario de migraciones necesita privilegios para crearla (la app no).                                                                                                                                                    |
| **Datos de referencia en producción**    | Las categorías y los estilos de servicio se cargan con `pnpm --filter api seed:reference`; hay que incluirlo en el despliegue. El seed de datos de prueba nunca se ejecuta en producción.                                                                            |
| **Dueño de `audit_log_redact_ip`**       | La función `SECURITY DEFINER` que borra la IP de la auditoría de una cuenta eliminada debe pertenecer al usuario de migraciones (con UPDATE sobre `audit_log`), aunque a la app se le revoque UPDATE/DELETE en producción. Es la única excepción a "solo inserción". |

## Guía: Cloudflare R2 para las imágenes (Fase 14)

Las credenciales van **solo** en el `.env` del servidor; nunca en el repositorio ni en la documentación.

1. En Cloudflare, **R2 → Crear bucket** (por ejemplo `charles-media`), región automática.
2. **Acceso público de lectura:** conectar un dominio propio al bucket (por ejemplo `img.tudominio.pe`); el subdominio `r2.dev` es solo para pruebas. Ese dominio es `MEDIA_PUBLIC_BASE_URL` (https).
3. **R2 → Administrar tokens de API → Crear token** con permiso _Lectura y escritura de objetos_ limitado a ese bucket. Copiar el _Access Key ID_ y el _Secret Access Key_ (se muestran una sola vez).
4. Variables en el `.env` de producción: `S3_ENDPOINT=https://<id-de-cuenta>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE=false` y `MEDIA_PUBLIC_BASE_URL`.
5. En producción la API no crea el bucket ni sirve `/api/v1/media/...`: las imágenes se leen del dominio público, con caché larga (las claves nunca cambian).
6. **Capa gratuita:** 10 GB guardados, 1 millón de escrituras y 10 millones de lecturas al mes, sin costo de salida. Cada foto de galería ocupa unos 150–400 KB (dos variantes WebP). Vigilar el uso desde el panel de R2.
7. **Pendiente:** CORS no hace falta para la app móvil; para la web, permitir el origen de la web en el bucket si se leen imágenes con `fetch`.

## Guía: activar Izipay (Fase 8B)

1. **Afiliación:** en izipay.pe → "izipay online" (S/ 0), **con RUC** (persona natural con negocio o empresa). Pedir a Izipay: acceso de pruebas (`sandbox-panel.izipay.pe`), botón de pagos/SDK con **Yape** y la **API de devoluciones** habilitada.
2. **Credenciales** (panel → Desarrolladores → Claves) en `apps/api/.env`: `IZIPAY_MERCHANT_CODE`, `IZIPAY_API_KEY`, `IZIPAY_HASH_KEY`, `IZIPAY_PUBLIC_KEY`, `IZIPAY_RUC`, `IZIPAY_MODE=TEST`, `PAYMENTS_GATEWAY=izipay` y `PUBLIC_API_URL` (en local, un túnel https, por ejemplo Cloudflare Tunnel, para que Izipay alcance la IPN).
3. **Ajuste:** `payments.provider = IZIPAY` (en producción la app no arranca con `FAKE`).
4. **Prueba de punta a punta** con tarjetas de prueba y Yape: reserva, pago, IPN, conciliación y cancelación.
5. **Producción:** credenciales de producción, `IZIPAY_MODE=PRODUCTION` (la app no arranca en producción con TEST, con URLs de sandbox ni sin `PUBLIC_API_URL` https) y **vigilar la primera devolución** (no se puede probar en sandbox).
6. **Pendiente de la liquidación a la barbería:** descontar la comisión de Charles (`commission_amount` cuando `payer = BARBERSHOP`) y la comisión de Izipay en las devoluciones.

## Guía: prueba real con Mercado Pago (modo de prueba)

1. En **mercadopago.com.pe/developers** → "Tus integraciones" → **Crear aplicación** → **Checkout Pro**, tipo de API **Preferences**.
2. **Pruebas → Credenciales de prueba:** copia el **Access Token** a `MERCADOPAGO_ACCESS_TOKEN` en `apps/api/.env`.
3. **Cuentas de prueba:** crea un **vendedor** y un **comprador** (Perú). Guarda sus usuarios y contraseñas fuera del repositorio.
4. **Túnel https** a la API local (por ejemplo `cloudflared tunnel --url http://localhost:3000`) y pon su URL en `PUBLIC_API_URL`.
5. **Webhooks → Configurar notificación:** URL `{PUBLIC_API_URL}/api/v1/payments/webhooks/mercadopago`, evento **Pagos**; copia la **clave secreta** a `MERCADOPAGO_WEBHOOK_SECRET`.
6. `PAYMENTS_GATEWAY=mercadopago` y reinicia la API. En `app_settings`, `payments.provider` puede quedar como está en desarrollo (la validación de `FAKE` solo aplica en producción).
7. Reserva desde la app, abre el pago, inicia sesión con el **comprador de prueba** (ventana de incógnito si es en el navegador) y paga con la tarjeta de prueba y titular `APRO`. Verifica que la reserva pase a `CONFIRMED`; luego cancela y verifica la devolución.
8. **Producción:** credenciales de producción, `PUBLIC_API_URL` https propia y `payments.provider = MERCADOPAGO`. La app no arranca en producción con un token `TEST-`.
