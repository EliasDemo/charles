# Pendientes para salir a producción

Lista de todo lo que **bloquea** el lanzamiento de Charles. Se revisa al cerrar cada fase (CLAUDE.md §1, regla 13): se agrega lo nuevo y se marca lo resuelto, indicando la fase o decisión que lo cerró.

Última revisión: cierre de la Fase 7.

## Decisiones de negocio pendientes (CLAUDE.md §4.2)

Hasta que se definan, el sistema lee cada punto desde `app_settings` y no inventa reglas.

| Pendiente                                                                 | Situación actual                                                                                                                                                                                 | Dónde                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **Plazo para cancelar**                                                   | `booking.cancellation_deadline_minutes = null`. Regla provisional: el cliente cancela una `PENDING_PAYMENT` siempre y una `CONFIRMED` hasta que empiece.                                         | Fase 7, `booking-policy.ts` |
| **Política de devolución** (devolución, retención y comisión al cancelar) | `payments.cancellation_refund_policy = null`. No se devuelve dinero: los pagos cobrados de reservas canceladas quedan con `refundDecision: PENDING_POLICY` y los pagos huérfanos con `ORPHANED`. | Fases 7 y 8                 |
| **Comisión** (quién la asume)                                             | `payments.commission_policy = null`.                                                                                                                                                             | Fase 8                      |
| **Liquidación** (cuándo recibe el dinero la barbería)                     | `payments.payout_policy = null`.                                                                                                                                                                 | Fase 8                      |
| **No-show** (qué pasa con el pago)                                        | `payments.no_show_policy = null`.                                                                                                                                                                | Fase 9                      |
| **Medios de pago**                                                        | `payments.methods = null`.                                                                                                                                                                       | Fase 8                      |

## Integraciones reales

| Pendiente                           | Situación actual                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedor de correo real**        | Solo existe `FakeMailer`, que guarda los correos en Redis. La app no arranca en producción con `MAILER_DRIVER=fake`. Previsto para la Fase 10.                                                                                    |
| **Pasarela de pagos real (Izipay)** | Solo existe `FakeGateway`. La app no arranca en producción con `payments.provider = FAKE`. Previsto para la Fase 8: elección de plataforma, SDK con Expo, webhooks firmados y reembolsos (ver `docs/pagos-izipay.md` y ADR 0002). |
| **Impuestos**                       | Los precios incluyen impuestos (ADR 0002) y hoy solo se guarda una línea `SERVICE`. Hay que revisar si hace falta desglosar el IGV (línea `TAX`) antes de la Fase 8.                                                              |
| **RUC**                             | Es opcional. Podría ser obligatorio antes de recibir pagos (Fase 8).                                                                                                                                                              |

## Aspectos legales

| Pendiente                              | Situación actual                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Validación legal de la edad mínima** | 18 años, autodeclarados con una casilla al registrarse (ADR 0003). Falta la validación legal.                 |
| **Términos y condiciones definitivos** | `legal.terms_version` tiene un valor provisional (`borrador-2026-10`). Falta el texto publicado y su versión. |

## Web y seguridad

| Pendiente                    | Situación actual                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookies y CSRF de la web** | Hoy la sesión usa tokens en cabecera (app móvil). Antes de publicar la web hay que definir las cookies (`HttpOnly`, `Secure`, `SameSite`) y la protección CSRF. |

## Operación

| Pendiente                                | Situación actual                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ejecución real del CI**                | `.github/workflows/ci.yml` existe pero nunca se ejecutó: el proyecto todavía no tiene remoto. Hasta entonces, `pnpm verify` (hook de pre-commit) es la única verificación.  |
| **Privilegios de la base en producción** | `postgis` no es una extensión "trusted": el usuario de migraciones necesita privilegios para crearla (la app no).                                                           |
| **Datos de referencia en producción**    | Las categorías de servicio se cargan con `pnpm --filter api seed:reference`; hay que incluirlo en el despliegue. El seed de datos de prueba nunca se ejecuta en producción. |
