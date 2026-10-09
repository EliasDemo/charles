# Estado del proyecto Charles

Punto de partida para retomar el trabajo en una conversación nueva. **Léelo antes de hacer nada**, junto con `CLAUDE.md` y `docs/pendientes-produccion.md`. Se actualiza al cerrar cada fase (CLAUDE.md §1).

Última actualización: eliminación de cuenta.

## Resumen

|                           |                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Fase cerrada más reciente | **9** (atención e inasistencias)                                                                                           |
| En espera                 | **8B** (adaptador de Izipay): falta documentación de Izipay que enviará el usuario                                         |
| Siguiente a implementar   | **11 y 12** (valoraciones y soporte): preguntas y plan presentados, pendientes de aprobación. La 10 y la 8B siguen después |
| Pruebas al cierre         | 369 unitarias y 399 e2e, todas en verde; `pnpm verify` pasa                                                                |
| Repositorio               | solo commits locales: **sin remoto y sin push** hasta que el usuario lo indique                                            |

## Fases cerradas y sus commits

| Fase | Contenido                                                                                  | Commits                                                                                        |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1    | Base del monorepo y API NestJS, CI, seguridad base                                         | `c67c951`, `6371135`                                                                           |
| 2    | Esquema completo, `EncryptionService`, datos de prueba                                     | `97ecf93`                                                                                      |
| 3    | Autenticación, sesiones, recuperación, perfil                                              | `f7f52f4`, `21a3e95`                                                                           |
| 4    | Barberías, responsables, barberos, servicios; barbero independiente                        | `4918a4a`, `121ad72`, `1e7d43a`                                                                |
| 5    | Horarios, bloqueos y motor de disponibilidad                                               | `009c79c`                                                                                      |
| 6    | Búsqueda, cercanía, filtros, alternativas; categorías de servicio                          | `55d90a9`; `255c732` (cobertura propia de availability y `pnpm verify`)                        |
| 7    | Reservas, máquina de estados, outbox, expiración                                           | `329c5eb`, `aa2a171` (columna `cancelled_by_role`, arranque sin `NODE_ENV=test`)               |
| 8A   | Pagos con `FakeGateway`: webhooks, reembolsos, conciliación, no-show, sanción a barberías  | `29182fc`, `044e34b`, `eeda3dd` (contención y bloqueo ordenado), `9d19023` (regla 10 ampliada) |
| 9    | Atención, inasistencias, corrección y agenda del día                                       | `e546048`                                                                                      |
| —    | Ajustes para la app: `dev:pay`, `dev:mail`, `GET /me/barber`, gracia de rotación (10 s)    | (ver `git log`)                                                                                |
| 11   | Favoritos y valoraciones: respuesta, reportes, moderación, promedios por barbero           | (ver `git log`)                                                                                |
| 12   | Soporte y operación: tickets, `/admin`, ADMIN, suspensión, reembolso manual, ajustes       | (ver `git log`)                                                                                |
| 10   | Notificaciones: push (Expo), correo y bandeja; recordatorios; dispositivos                 | (ver `git log`)                                                                                |
| —    | Eliminación de cuenta (Apple y Google): gracia de 30 días, anonimización, lista de bloqueo | (ver `git log`)                                                                                |

## Fase en curso

### 8B — Adaptador de Izipay (en espera)

- **Bloqueada** hasta que el usuario pase las páginas de documentación que faltan: claves, IPN, reembolso y consulta.
- **Ya preparado:** la interfaz `PaymentGateway` es compatible con Izipay; la referencia técnica está en `docs/izipay/referencia.md` y el resumen en `docs/pagos-izipay.md`.
- **Al recibir la documentación:** presentar el plan de la 8B y esperar aprobación.
- **Credenciales:** las pone el usuario en `apps/api/.env`. Nunca se escriben en el repositorio.
- **Variables previstas:** `IZIPAY_MODE`, `IZIPAY_SHOP_ID`, `IZIPAY_PASSWORD`, `IZIPAY_PUBLIC_KEY`, `IZIPAY_HMAC_SHA256_KEY` y `IZIPAY_API_SERVER_NAME`. La app no arranca en producción con credenciales de test.

### 9 — Atención e inasistencias: cerrada

Implementada en `e546048` según el plan aprobado (detalle en CLAUDE.md §8, "Atención e inasistencias (Fase 9)"). Ajustes en `charles`: `booking.attendance_auto_close_hours` (24) y `booking.attendance_correction_hours` (48). Migración: `20261011000000_bookings_confirmed_start_index`.

Queda para otras fases:

### 11 — Favoritos y valoraciones: cerrada

Implementada según el plan aprobado (detalle en CLAUDE.md §8, "Favoritos y valoraciones (Fase 11)"). Migraciones `20261012000000_reviews_favorites` y `20261012000001_reviews_response_by_index`, y ajustes `reviews.window_days` (14), `reviews.report_threshold` (3) y `reviews.rate_limit_per_minute` (10), aplicados en `charles`.

- La ocultación y restauración por corrección de asistencia (pendiente de la Fase 9) ya está hecha.
- **Para la Fase 12:** los endpoints de soporte sobre `ReviewModerationService` (`GET /admin/reviews/reported` y la moderación).
- **Hallazgo:** el recálculo de promedios con `FOR UPDATE` producía interbloqueos con el `FOR KEY SHARE` de las claves foráneas al insertar valoraciones simultáneas; se usa `FOR NO KEY UPDATE`.

### 12 — Soporte y operación: cerrada

Implementada según el plan aprobado y sus precisiones (detalle en CLAUDE.md §8, "Soporte y operación (Fase 12)"). Migración `20261013000000_support_operations` y ajustes `support.*` aplicados en `charles`. ADMIN asignado en `charles` a `soporte.demo@example.com` con `admin:grant`.

- **Bloqueantes de producción anotados:** verificación en dos pasos y sesiones más cortas para SUPPORT y ADMIN.
- **Hallazgo:** la clave de idempotencia del reembolso manual usaba la hora: dos reembolsos manuales en el mismo milisegundo chocaban (500). Ahora es aleatoria.

### 10 — Notificaciones: cerrada

Implementada según el plan aprobado y sus precisiones (detalle en CLAUDE.md §8, "Notificaciones (Fase 10)"). Migración `20261014000000_notifications` y ajustes `notifications.*` aplicados en `charles`.

- **Pendiente de producción:** dominio verificado para el correo real y credenciales de Firebase y Apple en Expo (`docs/pendientes-produccion.md`).
- **Confirmado con pruebas:** `POST /auth/support-access` comparte el bloqueo por intentos (cuenta e IP) y el límite de peticiones del login, y su token se rechaza en todos los endpoints autenticados salvo los de sus tickets.

### Eliminación de cuenta: cerrada

Implementada según el plan aprobado (detalle en CLAUDE.md §8, "Eliminación de cuenta"). Migración `20261015000000_account_deletion` y ajustes `account_deletion.*` aplicados en `charles`.

- **Decisión del usuario:** la IP de `audit_log` de una cuenta eliminada se borra con una excepción acotada al "solo inserción" (función `audit_log_redact_ip`); cualquier otra modificación sigue rechazada (con prueba).
- **Hallazgos de la prueba de barrido:** el motivo de cancelación también estaba copiado en `booking_status_history.reason`, y la IP en `audit_log`; ambos se borran ahora.
- **Pendiente:** plazo de conservación legal, política de privacidad, página web de eliminación y respaldos y logs (`docs/pendientes-produccion.md`).

### Siguiente: a definir por el usuario (8B en espera de la documentación de Izipay)

### Fases futuras registradas (no implementadas)

Diseño previsto en [ADR 0004](adr/0004-fases-de-crecimiento.md):

- **13 (ampliación):** campañas con público, espacios en pantallas de la barbería y catálogo de productos con enlace externo.
- **14:** galería y perfiles. **Debe estar lista antes de la app móvil.** Categoría obligatoria y hasta 3 estilos por foto (listas cerradas de `ADMIN`); fotos fijadas al inicio.
- **15:** planes de suscripción como datos, derechos (`EntitlementsService`), comisión por plan y cobro recurrente.
- **16:** membresías para clientes.

Sus decisiones abiertas están en `docs/pendientes-produccion.md`.

### App móvil (proyecto aparte)

Se desarrolla en `../charlesmobile`, en otra conversación. Lo que necesita del backend está en `docs/mobile/`:

- `GUIA-API.md`;
- `openapi.json`, que se regenera con `pnpm mobile:openapi`;
- `DATOS-PRUEBA.md`;
- `PAGOS.md`;
- `AJUSTES-BACKEND.md`, la lista de ajustes sugeridos, sin implementar.

Se actualiza al cerrar cada fase (CLAUDE.md §1, regla 15).

## Decisiones tomadas que no están en CLAUDE.md

Casi todas las decisiones de negocio ya están en `CLAUDE.md` (§4.1, §8 y "Pagos y reembolsos (Fase 8A)"). Además:

- **Plataforma de Izipay:** micuentaweb, con SDK oficial para React Native. Para Expo hace falta un _config plugin_ y `expo-dev-client`; no funciona con Expo Go.
- **Ajustes eliminados de `app_settings`:** `booking.cancellation_deadline_minutes` y `payments.cancellation_refund_policy`. Los reemplazan las claves `refunds.*`.

## Autorizaciones permanentes

- **`charles_test`:** se puede crear, vaciar y migrar libremente (base de las pruebas).
- **`charles_race`:** `pnpm --filter api test:load:race` la crea al empezar y la elimina al terminar.
- **Todo lo demás requiere autorización previa** (CLAUDE.md §1, regla 10):
  - modificar o borrar datos de cualquier otra base, incluida `charles` (desarrollo), y de `_prisma_migrations`;
  - crear o eliminar bases de datos;
  - aplicar migraciones o insertar ajustes en `charles`: se autorizan por fase.
- **Git:** solo commits locales; sin remoto ni push.

## Forma de trabajo acordada

- **Una fase a la vez:** primero preguntas de negocio y plan, luego aprobación del usuario, luego implementación.
- **Resumen al cerrar cada fase:** totales de pruebas, cobertura y lo pendiente.
- **Instrucciones como texto pegado:** el usuario suele pegar sus instrucciones. Si un mensaje es **solo** texto pegado, sin una línea escrita por el usuario, se pide confirmación antes de ejecutar acciones con efecto real (base de datos, hooks, migraciones). Basta una línea propia como "continúa con esto".
- **Idiomas:** código, tablas y endpoints en inglés; mensajes al usuario y documentación en español. El ID del RF va en los nombres de las pruebas y en los commits.

## Cómo levantar el entorno

Requisitos: Node 24, pnpm 10 y Docker.

```bash
pnpm install                       # también activa el hook de pre-commit (core.hooksPath)
docker compose up -d               # PostgreSQL 16 + PostGIS y Redis 7
# apps/api/.env (desarrollo) y apps/api/.env.test (pruebas) no se versionan.
# Copiar apps/api/.env.example y completar las claves (cifrado, JWT, SEED_USER_PASSWORD...).
pnpm --filter api prisma migrate deploy
pnpm --filter api seed:reference   # categorías de servicio (datos de referencia)
pnpm --filter api prisma db seed   # datos de prueba ficticios (nunca en producción)
pnpm --filter api start:dev
```

Las e2e usan `charles_test` (debe existir) y Redis en una base distinta de la 0. `global-setup` aplica las migraciones y los datos de referencia.

## Verificación antes de cada commit

```bash
pnpm verify
```

- **Pasos:** lint, typecheck, formato, unitarias, e2e, coberturas mínimas (`availability`, `search`, `bookings` + `payments` + `moderation`, `reviews`, `admin` + `support`, `notifications`), OpenAPI y tipos de `packages/shared` al día, y `pnpm audit --audit-level=high`.
- **Duración:** unos 4 minutos. Necesita Docker levantado.
- **Hook `.githooks/pre-commit`:** lo ejecuta en cada commit. Nunca se omite con `--no-verify`.
- **Prueba de carga** (fuera de `verify`): `pnpm --filter api test:load:race`.

## En espera y preguntas abiertas

**En espera:**

- **Documentación de Izipay para la 8B**, que pasará el usuario:
  - claves;
  - URL de la IPN (si `CreatePayment` puede indicarla por petición, y cómo recibirla con la tienda de demostración);
  - reembolso total y parcial;
  - consulta del estado de un pedido;
  - si la IPN trae marca de tiempo;
  - Yape, Plin y QR en el SDK.

**Preguntas abiertas** (detalle en `docs/pendientes-produccion.md`):

- comisión de Charles (hoy una línea `FEE` en 0);
- quién asume la comisión de la pasarela, también en las devoluciones;
- liquidación a la barbería;
- sanción económica a la barbería;
- qué hacer con las reservas futuras de una barbería suspendida (Fase 12);
- medios de pago;
- si el RUC será obligatorio antes de recibir pagos;
- desglose del IGV (línea `TAX`);
- validación legal de la edad mínima y términos y condiciones definitivos;
- cookies y CSRF de la web;
- proveedor de correo real (Fase 10);
- ejecución real del CI, que requiere remoto.
