# Pendientes para salir a producción

Lista de todo lo que **bloquea** el lanzamiento de Charles. Se revisa al cerrar cada fase (CLAUDE.md §1, regla 13): se agrega lo nuevo y se marca lo resuelto, indicando la fase o decisión que lo cerró.

Última revisión: cierre de la Fase 9.

## Decisiones de negocio pendientes (CLAUDE.md §4.2)

Resueltas en la Fase 8A: devoluciones al cancelar, plazo para cancelar, no-show y sanción por cancelaciones de la barbería.

| Pendiente                                       | Situación actual                                                                                                                                | Dónde                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Comisión de Charles**                         | Sin definir. Cada reserva lleva una línea `FEE` en 0 (`CHARLES_FEE_AMOUNT`).                                                                    | Fase 8A, `bookings.service.ts` |
| **Comisión de la pasarela en las devoluciones** | Sin definir quién la asume (Charles, la barbería o el cliente). Hoy se devuelve el importe calculado por la política, sin descontar comisiones. | Fase 8B o antes de producción  |
| **Liquidación a la barbería**                   | Fuera de alcance: cuándo y cómo recibe el dinero la barbería (y el de un no-show).                                                              | Por definir                    |
| **Sanción económica a la barbería**             | Solo existe la suspensión por 3 cancelaciones injustificadas en 30 días. La multa o el descuento quedan pendientes.                             | Por definir                    |
| **Corrección de asistencia fuera de plazo**     | Pasadas 48 h del inicio, solo soporte puede corregir `ATTENDED` ↔ `NO_SHOW`; falta la herramienta.                                              | Fase 12                        |
| **Reservas de una barbería suspendida**         | Las reservas futuras se dejan como están. Falta decidir si se cancelan y se devuelven, y cómo se avisa al cliente.                              | Fase 12                        |
| **Medios de pago**                              | `payments.methods = null` (Yape, Plin y QR por confirmar en el SDK).                                                                            | Fase 8B                        |

## Fases de crecimiento (13 a 16, ADR 0004)

| Pendiente                                   | Situación actual                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedor de almacenamiento de imágenes** | Sin decidir. La Fase 14 usará la interfaz `ImageStorage`, con una implementación local para desarrollo.                                                                                      |
| **Planes y precios**                        | Sin definir qué planes habrá ni sus precios mensual y anual.                                                                                                                                 |
| **Beneficios por plan**                     | Sin definir qué derechos y límites tiene cada plan (barberos, sedes, fotos, días destacados, mensajes, membresías, promociones, estadísticas, insignia, soporte prioritario).                |
| **Comisión por plan**                       | Sin definir la comisión de Charles por reserva en cada plan (hoy línea `FEE` en 0).                                                                                                          |
| **Periodo de prueba**                       | Sin definir si habrá prueba gratuita, de cuántos días y en qué planes.                                                                                                                       |
| **Cobro recurrente en Izipay**              | Por confirmar si Izipay ofrece cobros recurrentes programados. Si no, Charles programaría el cobro con un token guardado.                                                                    |
| **Apple y Google**                          | Revisar sus políticas sobre suscripciones dentro de la app: si la suscripción de la barbería y las membresías de clientes pueden cobrarse fuera de las tiendas o exigen su sistema de pagos. |

## Integraciones reales

| Pendiente                                            | Situación actual                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedor de correo real**                         | Solo existe `FakeMailer`, que guarda los correos en Redis. La app no arranca en producción con `MAILER_DRIVER=fake`. Previsto para la Fase 10.                                                                                                                                                                              |
| **Pasarela de pagos real (Izipay, micuentaweb)**     | Solo existe `FakeGateway`. La app no arranca en producción con `payments.provider = FAKE` ni, desde la 8B, con credenciales de test. Sistema de pagos completo en la 8A; el adaptador llega en la 8B (`docs/pagos-izipay.md`, `docs/izipay/referencia.md`).                                                                 |
| **IPN de Izipay en producción**                      | Hay que configurar la URL pública de notificación en el Back Office y confirmar la recepción.                                                                                                                                                                                                                               |
| **Impuestos**                                        | Los precios incluyen impuestos (ADR 0002) y hoy solo se guarda una línea `SERVICE`. Hay que revisar si hace falta desglosar el IGV (línea `TAX`) antes de la Fase 8.                                                                                                                                                        |
| **RUC**                                              | Es opcional. Podría ser obligatorio antes de recibir pagos (Fase 8).                                                                                                                                                                                                                                                        |
| **Dominio propio verificado para el correo**         | El correo real se decide antes de producción (hoy `FakeMailer`, interfaz `Mailer` lista). Para enviar hace falta un dominio propio verificado en el proveedor (SPF, DKIM y DMARC), y luego implementar el `Mailer` real.                                                                                                    |
| **Push real (Expo): credenciales que configuras tú** | En el proyecto de Expo (EAS): credenciales de **Firebase Cloud Messaging** para Android (cuenta de servicio FCM v1) y la **clave de APNs** de Apple (Apple Developer) para iOS. En el backend, `PUSH_DRIVER=expo` y, si activas "enhanced push security", `EXPO_ACCESS_TOKEN` en `apps/api/.env` (nunca en el repositorio). |

## Aspectos legales

| Pendiente                              | Situación actual                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validación legal de la edad mínima** | 18 años, autodeclarados con una casilla al registrarse (ADR 0003). Falta la validación legal.                                                                                           |
| **Términos y condiciones definitivos** | `legal.terms_version` tiene un valor provisional (`borrador-2026-10`). Falta el texto publicado y su versión.                                                                           |
| **URLs de términos y privacidad**      | `legal.terms_url` y `legal.privacy_url` tienen valores provisionales (`https://charles.example/...`). Reemplazarlos por las URLs publicadas (editables por ADMIN en `/admin/settings`). |

## Web y seguridad

| Pendiente                    | Situación actual                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookies y CSRF de la web** | Hoy la sesión usa tokens en cabecera (app móvil). Antes de publicar la web hay que definir las cookies (`HttpOnly`, `Secure`, `SameSite`) y la protección CSRF. |

| **Versión mínima de la app** | Sin mecanismo hoy. Antes del lanzamiento: cabecera `X-App-Version` y respuesta `426` o `APP_UPDATE_REQUIRED` para obligar a actualizar cuando cambie el contrato. |
| **Textos de validación en español** | `VALIDATION_ERROR` devuelve `field` y `constraints` con nombres de reglas en inglés. Definir mensajes por campo en español (backend o tabla en la app) antes del lanzamiento. |

| **Verificación en dos pasos para SUPPORT y ADMIN** (bloqueante) | **No se puede salir a producción sin esto.** Hoy soporte y ADMIN entran solo con contraseña. Exigir un segundo factor (TOTP o similar) a esas cuentas. |
| **Sesiones más cortas para SUPPORT y ADMIN** (bloqueante) | **No se puede salir a producción sin esto.** Hoy usan la misma sesión de 30 días que un cliente. Definir una vida corta del token de renovación y reautenticación para acciones sensibles. |

## Operación

| Pendiente                                | Situación actual                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ejecución real del CI**                | `.github/workflows/ci.yml` existe pero nunca se ejecutó: el proyecto todavía no tiene remoto. Hasta entonces, `pnpm verify` (hook de pre-commit) es la única verificación.  |
| **Privilegios de la base en producción** | `postgis` no es una extensión "trusted": el usuario de migraciones necesita privilegios para crearla (la app no).                                                           |
| **Datos de referencia en producción**    | Las categorías de servicio se cargan con `pnpm --filter api seed:reference`; hay que incluirlo en el despliegue. El seed de datos de prueba nunca se ejecuta en producción. |
