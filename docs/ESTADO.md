# Estado del proyecto Charles

Punto de partida para retomar el trabajo en una conversación nueva. **Léelo antes de hacer nada**, junto con `CLAUDE.md` y `docs/pendientes-produccion.md`. Se actualiza al cerrar cada fase (CLAUDE.md §1).

Última actualización: backend preparado para charlesweb (2FA del personal, sesión web con cookies y CSRF).

## Resumen

|                           |                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fase cerrada más reciente | **8B** (pagos con Izipay, probado con simulador)                                                                                         |
| En espera                 | credenciales de prueba de Mercado Pago para la prueba real (guía en `docs/pendientes-produccion.md`); cuenta de Izipay (sin negocio aún) |
| Siguiente a implementar   | **charlesweb** (web de administración, Next.js, en `D:\barberia\charlesweb`): plan pendiente de presentar; luego Fase 13                 |
| Pruebas al cierre         | 488 unitarias y 569 e2e, todas en verde; `pnpm verify` pasa                                                                              |
| Repositorio               | solo commits locales: **sin remoto y sin push** hasta que el usuario lo indique                                                          |

## Fases cerradas y sus commits

| Fase | Contenido                                                                                                                                                    | Commits                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1    | Base del monorepo y API NestJS, CI, seguridad base                                                                                                           | `c67c951`, `6371135`                                                                           |
| 2    | Esquema completo, `EncryptionService`, datos de prueba                                                                                                       | `97ecf93`                                                                                      |
| 3    | Autenticación, sesiones, recuperación, perfil                                                                                                                | `f7f52f4`, `21a3e95`                                                                           |
| 4    | Barberías, responsables, barberos, servicios; barbero independiente                                                                                          | `4918a4a`, `121ad72`, `1e7d43a`                                                                |
| 5    | Horarios, bloqueos y motor de disponibilidad                                                                                                                 | `009c79c`                                                                                      |
| 6    | Búsqueda, cercanía, filtros, alternativas; categorías de servicio                                                                                            | `55d90a9`; `255c732` (cobertura propia de availability y `pnpm verify`)                        |
| 7    | Reservas, máquina de estados, outbox, expiración                                                                                                             | `329c5eb`, `aa2a171` (columna `cancelled_by_role`, arranque sin `NODE_ENV=test`)               |
| 8A   | Pagos con `FakeGateway`: webhooks, reembolsos, conciliación, no-show, sanción a barberías                                                                    | `29182fc`, `044e34b`, `eeda3dd` (contención y bloqueo ordenado), `9d19023` (regla 10 ampliada) |
| 9    | Atención, inasistencias, corrección y agenda del día                                                                                                         | `e546048`                                                                                      |
| —    | Ajustes para la app: `dev:pay`, `dev:mail`, `GET /me/barber`, gracia de rotación (10 s)                                                                      | (ver `git log`)                                                                                |
| 11   | Favoritos y valoraciones: respuesta, reportes, moderación, promedios por barbero                                                                             | (ver `git log`)                                                                                |
| 12   | Soporte y operación: tickets, `/admin`, ADMIN, suspensión, reembolso manual, ajustes                                                                         | (ver `git log`)                                                                                |
| 10   | Notificaciones: push (Expo), correo y bandeja; recordatorios; dispositivos                                                                                   | (ver `git log`)                                                                                |
| —    | Eliminación de cuenta (Apple y Google): gracia de 30 días, anonimización, lista de bloqueo                                                                   | (ver `git log`)                                                                                |
| —    | Alta con revisión previa: documento del responsable, cambios pedidos y reenvío; categoryKey en reservas                                                      | (ver `git log`)                                                                                |
| 14   | Galería y perfiles: imágenes en S3 (R2), sharp sin EXIF, estilos, especialidades, reportes                                                                   | (ver `git log`)                                                                                |
| 8B   | Pagos con Izipay: formulario web (tarjeta y Yape), IPN firmada, consulta, devoluciones; comisión configurable                                                | (ver `git log`)                                                                                |
| —    | Mercado Pago (Checkout Pro): pasarela activa para pruebas reales; Izipay se mantiene                                                                         | (ver `git log`)                                                                                |
| —    | Preparación de charlesweb: 2FA obligatorio del personal, sesión de personal (12 h / 30 min), sesión web con cookies y CSRF, `/admin/me` y `/admin/dashboard` | (ver `git log`)                                                                                |

## Fase en curso

### 8B — Pagos con Izipay: cerrada (sin cuenta real)

Implementada según el plan aprobado (detalle en CLAUDE.md §8, "Pagos con Izipay (Fase 8B)"). Migración `20261018000000_commission` y ajustes `fees.*` aplicados en `charles`.

- **Cambio de plataforma:** se usó el botón de pagos de developers.izipay.pe (la que ofrece hoy la afiliación "izipay online"). La referencia anterior era de micuentaweb y quedó descartada.
- **Sin cuenta de Izipay:** es un proyecto universitario y aún no hay negocio. Todo está probado con un simulador que firma como Izipay; en desarrollo sigue `FakeGateway` (`dev:pay`). Pasos para activarlo en `docs/pendientes-produccion.md` ("Guía: activar Izipay").
- **Decisiones del usuario:** tarjeta y Yape; formulario web en la app; comisión configurable por ADMIN (por defecto la barbería, en 0); la comisión de Izipay en devoluciones la asume la barbería; la barbería usa DNI o RUC (el RUC de Izipay es el de Charles).
- **Hallazgo:** un rechazo de la pasarela cancelaba la reserva. Con Izipay se registra como intento fallido y el cliente puede reintentar hasta que venza.
- **Por validar con cuenta real:** ver `docs/izipay/referencia.md` §8.

### Preparación de charlesweb: cerrada

Decisiones del usuario: la web es un proyecto aparte (`D:\barberia\charlesweb`, Next.js) bajo supervisión de Claude; por ahora solo administración; 2FA obligatorio para SUPPORT y ADMIN; sesión de personal de 12 h con cierre por 30 min de inactividad; dominio de producción tipo `admin.charles.pe`. Detalle en CLAUDE.md §6.3. Migración `20261019000000_staff_mfa` aplicada en `charles`.

- **Diseño:** el login de la app no cambia; el segundo factor es un paso extra (`/auth/mfa/verify`) que emite la sesión de personal. La web usa rutas propias `/auth/web/*` (cookies) para no tocar el contrato de la app.
- **Guía para la web:** `docs/web/GUIA-API.md` y `docs/web/openapi.json` (`pnpm web:openapi`).
- `soporte.demo@example.com` deberá activar el 2FA la primera vez que entre a la administración.

### Mercado Pago: integrado (pendiente la prueba real)

Por decisión del usuario, **Mercado Pago** es la pasarela para pruebas reales (da credenciales y usuarios de prueba sin negocio) e **Izipay se mantiene** para el futuro. Detalle en CLAUDE.md §8, "Pagos con Mercado Pago (Checkout Pro)".

- Probado con un simulador que firma como el SDK oficial. **Falta la prueba real** con las credenciales de prueba del usuario y un túnel https (guía en `docs/pendientes-produccion.md`).
- La página final del pago ahora es común: `/payments/done` (antes `/payments/izipay/done`).
- **Decisión técnica:** `parseWebhook` puede consultar al proveedor (Mercado Pago no envía el monto en el aviso), siempre fuera de transacciones.

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

### Alta con revisión previa: cerrada

Implementada según el plan aprobado (detalle en CLAUDE.md §8, "Alta con revisión previa"). Migraciones `20261016000000_barbershop_review` y `20261016000001_drop_barbershop_ruc` aplicadas en `charles`; `migrate:ruc` ejecutado entre ambas (0 RUC que migrar). En `charles`: `barbershops.require_review = true` y `barbershops.require_photo = false`. Las 2 barberías existentes siguen aprobadas (`OPEN`) sin documento; si lo registran, quedan marcadas para soporte.

### 14 — Galería y perfiles: cerrada

Implementada según el plan aprobado (detalle en CLAUDE.md §8, "Galería y perfiles (Fase 14)"). Migración `20261017000000_images`, estilos iniciales y ajustes `images.*` aplicados en `charles`; `barbershops.require_photo = true` en `charles` (la portada es la foto del local).

- **Cambio sobre lo aprobado:** el almacenamiento local es **SeaweedFS** (`chrislusf/seaweedfs:3.97`, S3, Apache 2.0) en lugar de MinIO, que ya no publica imágenes gratuitas. Mismo puerto (9000) y mismo cliente S3; la consola web de MinIO (9001) no existe. Credenciales locales en `docker/seaweedfs/s3.json` (solo locales; producción las rechaza).
- **Producción:** Cloudflare R2; guía en `docs/pendientes-produccion.md`.
- **Hasta 3 estilos por foto** (ADR 0004); especialidades del barbero, hasta 5.
- **Pendiente sin decidir:** la ADR 0004 menciona "categoría obligatoria" por foto; hoy la categoría se deduce de los estilos y no se exige.

### Siguiente: a definir por el usuario

### Fases futuras registradas (no implementadas)

Diseño previsto en [ADR 0004](adr/0004-fases-de-crecimiento.md):

- **13 (ampliación):** campañas con público, espacios en pantallas de la barbería y catálogo de productos con enlace externo.
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
docker compose up -d               # PostgreSQL 16 + PostGIS, Redis 7 y almacenamiento S3 (SeaweedFS)
# apps/api/.env (desarrollo) y apps/api/.env.test (pruebas) no se versionan.
# Copiar apps/api/.env.example y completar las claves (cifrado, JWT, SEED_USER_PASSWORD...).
pnpm --filter api prisma migrate deploy
pnpm --filter api seed:reference   # categorías y estilos de servicio (datos de referencia)
pnpm --filter api prisma db seed   # datos de prueba ficticios (nunca en producción)
pnpm --filter api start:dev
```

Las e2e usan `charles_test` (debe existir) y Redis en una base distinta de la 0. `global-setup` aplica las migraciones y los datos de referencia.

## Verificación antes de cada commit

```bash
pnpm verify
```

- **Pasos:** lint, typecheck, formato, unitarias, e2e, coberturas mínimas (`availability`, `search`, `bookings` + `payments` + `moderation`, `reviews`, `admin` + `support`, `notifications`, `images`), OpenAPI y tipos de `packages/shared` al día, y `pnpm audit --audit-level=high`.
- **Duración:** unos 4 minutos. Necesita Docker levantado.
- **Hook `.githooks/pre-commit`:** lo ejecuta en cada commit. Nunca se omite con `--no-verify`.
- **Prueba de carga** (fuera de `verify`): `pnpm --filter api test:load:race`.

## En espera y preguntas abiertas

**En espera:**

- **Prueba real con Mercado Pago:** credenciales de prueba del usuario en `.env`, túnel https y la guía de `docs/pendientes-produccion.md`.
- **Cuenta de Izipay** (afiliación con RUC y credenciales): no hay negocio todavía.

**Preguntas abiertas** (detalle en `docs/pendientes-produccion.md`):

- valor real de la comisión de Charles (hoy 0) y liquidación a la barbería (descontar comisiones);
- sanción económica a la barbería;
- qué hacer con las reservas futuras de una barbería suspendida (Fase 12);
- desglose del IGV (línea `TAX`);
- validación legal de la edad mínima y términos y condiciones definitivos;
- cookies y CSRF de la web;
- proveedor de correo real (Fase 10);
- ejecución real del CI, que requiere remoto.
