# CHARLES — Guía del proyecto para Claude Code

Charles es una plataforma de reservas para barberías. Los clientes buscan barberías cercanas, consultan disponibilidad real, reservan y pagan. Las barberías gestionan sedes, barberos, servicios, horarios y atención.

Este archivo es la fuente de verdad técnica. Los requerimientos funcionales (55 RF) están en `docs/requerimientos.pdf`. Si algo de este archivo contradice al PDF, pregunta antes de decidir.

---

## 1. Cómo debes trabajar

1. Trabaja **una fase a la vez** (sección 12). No adelantes fases.
2. Antes de escribir código en cada fase, presenta el plan y espera aprobación.
3. Cada funcionalidad se entrega con pruebas. No des una fase por terminada si `pnpm test`, `pnpm lint` y `pnpm typecheck` no pasan.
4. No inventes reglas de negocio. Si un RF es ambiguo o depende de la sección 4.2 (decisiones pendientes), pregunta.
5. Nunca escribas secretos, claves ni datos reales en el repositorio, ni en pruebas, ni en seeds.
6. Todo cambio de esquema va por migración de Prisma. Nunca edites una migración ya aplicada.
7. Código, nombres de tablas, columnas y endpoints en **inglés**. Mensajes al usuario final y documentación en **español**.
8. Cita el ID del RF (por ejemplo `RF-RES-007`) en el nombre de las pruebas y en los commits.
9. Al terminar una fase, resume: qué se hizo, qué RF cubre, qué quedó pendiente.
10. Nunca modifiques ni borres datos de la base directamente (incluida `_prisma_migrations`) sin pedir autorización antes.

---

## 2. Stack

| Capa               | Tecnología                                                                   |
| ------------------ | ---------------------------------------------------------------------------- |
| Lenguaje           | TypeScript (modo `strict`) en todo el proyecto                               |
| Backend            | NestJS sobre Node.js LTS, API REST                                           |
| Base de datos      | PostgreSQL 16+ con extensiones `postgis`, `btree_gist`, `pgcrypto`, `citext` |
| ORM                | Prisma (SQL manual en migraciones cuando Prisma no alcance)                  |
| Colas y tareas     | Redis + BullMQ                                                               |
| Documentación API  | OpenAPI / Swagger generado desde el código                                   |
| Validación         | `class-validator` + `class-transformer` en DTOs                              |
| Pruebas            | Jest (unitarias) + Supertest (e2e) con base de datos real en Docker          |
| Gestor de paquetes | pnpm workspaces (monorepo)                                                   |
| Entorno local      | Docker Compose (PostgreSQL/PostGIS + Redis)                                  |
| Futuro: móvil      | React Native + Expo (iOS y Android)                                          |
| Futuro: web        | Next.js                                                                      |

El backend es una **API pura**: no genera pantallas ni contiene lógica de presentación. Web y móvil consumen exactamente los mismos endpoints.

---

## 3. Estructura del repositorio

```
charles/
├── CLAUDE.md
├── docs/                      # requerimientos, decisiones (ADR), diagramas
├── docker-compose.yml
├── apps/
│   ├── api/                   # backend NestJS
│   │   ├── prisma/            # schema.prisma, migrations/, seed.ts
│   │   ├── src/
│   │   │   ├── common/        # guards, interceptors, filtros, cifrado, config
│   │   │   ├── modules/       # un directorio por módulo de negocio
│   │   │   └── main.ts
│   │   └── test/              # pruebas e2e
│   ├── mobile/                # (futuro) Expo
│   └── web/                   # (futuro) Next.js
└── packages/
    └── shared/                # tipos, enums y cliente de API generados desde OpenAPI
```

Módulos de `apps/api/src/modules/`:
`auth`, `users`, `barbershops`, `barbers`, `services`, `availability`, `search`, `bookings`, `payments`, `attendance`, `notifications`, `favorites`, `reviews`, `support`, `admin`, `promotions`, `sponsors`, `settings`.

Cada módulo contiene: `*.controller.ts`, `*.service.ts`, `dto/`, `*.module.ts`, `*.spec.ts`. Un módulo solo accede a otro a través de su servicio exportado o de eventos de dominio, nunca tocando directamente sus tablas.

### Comandos

```
pnpm install
docker compose up -d
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed
pnpm --filter api start:dev
pnpm test | pnpm test:e2e | pnpm lint | pnpm typecheck
```

---

## 4. Decisiones de negocio

### 4.1 Cerradas (aplícalas)

- **Roles:** `CLIENT`, `BARBER`, `OWNER` (responsable de barbería), `SUPPORT`. Un usuario puede tener más de un rol.
- Una cuenta puede administrar **varias barberías** (cada sede es una barbería). Una barbería puede tener **varios responsables**.
- Un barbero pertenece a **una sola barbería** en el MVP. El modelo debe permitir ampliarlo después sin romper reservas.
- El cliente puede elegir un barbero o **"cualquier barbero disponible"**; en ese caso el sistema asigna uno al crear la reserva.
- La disponibilidad **se calcula, no se almacena**.
- Estados de reserva: `PENDING_PAYMENT`, `CONFIRMED`, `ATTENDED`, `CANCELLED`, `NO_SHOW`, `EXPIRED`.
- Una reserva en `PENDING_PAYMENT` bloquea el horario durante un tiempo configurable (por defecto 10 minutos) y luego pasa a `EXPIRED`.
- Una reserva solo pasa a `CONFIRMED` por un aviso verificado de la pasarela de pago, nunca por lo que diga el cliente.

### 4.2 Pendientes (NO las inventes; deja el punto configurable y pregunta)

- Medios de pago y pasarela definitiva.
- Política de devolución, retención y comisión al cancelar.
- Quién asume la comisión y cuándo recibe el dinero la barbería.
- Tratamiento del pago ante un no-show.
- Plazo límite para cancelar.

Hasta que se definan: la pasarela se implementa detrás de la interfaz `PaymentGateway` con una implementación simulada (`FakeGateway`), y las políticas se leen desde `app_settings`.

---

## 5. Diseño para crecer (auspiciadores, promociones y lo que venga)

El objetivo es agregar funciones nuevas **sin modificar los módulos existentes**.

1. **Eventos de dominio.** Los módulos publican eventos (`booking.confirmed`, `booking.cancelled`, `payment.succeeded`, `review.created`...). Notificaciones, promociones y analítica se suscriben. Implementa el patrón _outbox_: el evento se guarda en la tabla `outbox_events` dentro de la misma transacción y un worker de BullMQ lo despacha.
2. **Precio desglosado.** Una reserva nunca guarda un solo número. Guarda `subtotal`, `discount_total`, `fee_total`, `total` y el detalle en `booking_price_lines`. Así un cupón, una promoción o una comisión nueva es una línea más, no un cambio de esquema.
3. **Promociones genéricas.** `promotions` define tipo (`PERCENTAGE`, `FIXED_AMOUNT`), alcance (plataforma, barbería o servicio), vigencia, límites y condiciones en `rules` (JSONB validado con esquema). `coupons` y `coupon_redemptions` cubren códigos.
4. **Auspiciadores.** `sponsors` → `sponsor_campaigns` → `sponsor_placements`. Un _placement_ es un espacio con clave (`HOME_BANNER`, `SEARCH_TOP`, `BOOKING_CONFIRMATION`...). El frontend pide "qué mostrar en este espacio"; agregar un espacio nuevo es insertar una fila. Se registran impresiones y clics en `sponsor_events`.
5. **Destacados pagados.** `featured_listings` permite que una barbería aparezca destacada en la búsqueda durante un periodo.
6. **Configuración y banderas.** `app_settings` (clave/valor tipado) y `feature_flags` permiten activar funciones sin desplegar código.
7. **API versionada** bajo `/api/v1`. Los cambios incompatibles van a `/api/v2`; nunca se rompe una versión publicada (las apps móviles instaladas no se actualizan al instante).
8. **Enums ampliables.** Agregar valores a un enum nunca debe requerir migrar datos existentes.
9. **Campo `metadata` JSONB** en entidades principales para datos opcionales futuros. No usarlo para datos que necesiten filtros o integridad.

---

## 6. Seguridad (obligatoria, no opcional)

### 6.1 Datos en tránsito

- **HTTPS obligatorio** (TLS 1.2 como mínimo, preferir 1.3) entre clientes y backend. En producción el backend rechaza HTTP.
- Cabecera **HSTS** con `includeSubDomains` y `preload`.
- Conexiones a PostgreSQL y Redis **con TLS** (`sslmode=verify-full` en producción) y dentro de red privada; nunca expuestas a internet.
- `helmet` activado. **CORS con lista blanca** de orígenes por entorno; prohibido `*`.
- En la app móvil (fase futura): fijación de certificado (_certificate pinning_) y bloqueo de tráfico en claro.

### 6.2 Datos en reposo

- Cifrado de disco y de respaldos activado en el proveedor de base de datos.
- **Cifrado a nivel de campo** con AES-256-GCM (IV aleatorio por valor, etiqueta de autenticación) para datos personales sensibles. Campos mínimos: `users.email`, `users.phone`, `users.document_number`, `users.birth_date`, `barbers.phone`, y el contenido de `ticket_messages`.
- Para buscar por un campo cifrado se guarda además un **índice ciego**: `HMAC-SHA256(valor_normalizado, clave_de_indice)` en una columna `*_hash` con índice único cuando aplique (por ejemplo `email_hash` para el inicio de sesión).
- Implementa esto en un único `EncryptionService` en `common/crypto`. Formato almacenado: `v{versión}:{iv}:{tag}:{cifrado}` en base64, para permitir **rotación de claves**.
- Las claves viven en un gestor de secretos / KMS, separadas de la base de datos. La clave de cifrado y la de índice son distintas.
- **Contraseñas:** hash con **Argon2id**. Jamás cifrado reversible, jamás en logs.
- **Tarjetas:** Charles **nunca** almacena ni procesa número de tarjeta, CVV ni vencimiento. Solo se guardan identificadores/tokens entregados por la pasarela.

### 6.3 Autenticación y sesiones

- Token de acceso JWT de vida corta (15 min) firmado con algoritmo asimétrico (ES256 o RS256).
- Token de renovación opaco y aleatorio, guardado **solo como hash**, con **rotación en cada uso** y detección de reutilización (si se reutiliza uno ya rotado, se revoca toda la familia de sesiones).
- Web: tokens en cookies `HttpOnly`, `Secure`, `SameSite`, con protección CSRF. Móvil: almacenamiento seguro del sistema (Keychain / Keystore).
- Cerrar sesión (RF-AUT-003) revoca el token de renovación en el servidor.
- Límite de intentos y bloqueo temporal progresivo en inicio de sesión y recuperación.
- Recuperación de acceso (RF-AUT-004): token de un solo uso, de vida corta, guardado como hash. La respuesta es **idéntica exista o no la cuenta**.
- Los mensajes de error de inicio de sesión no revelan si falló el usuario o la contraseña.

### 6.4 Autorización

- Denegar por defecto: todo endpoint requiere autenticación salvo que lleve el decorador `@Public()`.
- `RolesGuard` para el rol y **verificación de propiedad** en cada recurso: un cliente solo ve sus reservas, un responsable solo su barbería, un barbero solo sus citas.
- Soporte accede únicamente a lo necesario para la incidencia (RF-OPE-003) y cada acceso queda en `audit_log`.
- Nunca confíes en IDs de usuario, precios o estados enviados por el cliente: se toman del token y de la base de datos.

### 6.5 Protección de la API

- Validación estricta de entrada: `ValidationPipe` con `whitelist`, `forbidNonWhitelisted` y `transform`.
- Límite de peticiones global y más estricto en `auth`, `payments` y `search`.
- Límite de tamaño del cuerpo de la petición. Paginación obligatoria con máximo.
- Consultas solo mediante Prisma o SQL parametrizado. Prohibido concatenar texto en SQL.
- Las respuestas se construyen con DTOs de salida explícitos; nunca se devuelve la entidad completa de la base de datos.
- **Webhooks de pago:** verificar firma, rechazar avisos antiguos, e idempotencia por ID de evento.
- Cabecera `Idempotency-Key` obligatoria al crear reservas y pagos.
- Swagger deshabilitado o protegido en producción.

### 6.6 Operación

- Variables de entorno validadas al arrancar; la aplicación no inicia si falta alguna. Se entrega `.env.example` sin valores reales.
- Logs estructurados con ID de petición. **Prohibido** registrar contraseñas, tokens, datos personales o cuerpos de pago; aplicar enmascarado automático.
- `audit_log` para acciones sensibles: cambios de estado de cuenta, cancelaciones, reembolsos, acciones de soporte, cambios de precio.
- El usuario de base de datos de la aplicación tiene privilegios mínimos (sin `SUPERUSER`, sin DDL en producción).
- `pnpm audit` en CI y dependencias con versiones fijadas.

---

## 7. Base de datos

### 7.1 Convenciones

- Tablas en `snake_case` plural. Clave primaria `id` UUID (v7 si está disponible).
- `created_at` y `updated_at` (`timestamptz`) en todas las tablas. Borrado lógico con `deleted_at` en entidades de negocio.
- Todas las fechas y horas en **UTC**. Cada barbería tiene `timezone` (IANA). Los horarios semanales se guardan como hora local + día de la semana.
- **Dinero:** enteros en la unidad mínima (`*_amount` en céntimos) + `currency` (ISO 4217). Nunca `float`.
- Claves foráneas siempre con índice. Restricciones `CHECK` para invariantes (por ejemplo `end_at > start_at`, `rating BETWEEN 1 AND 5`).
- Columnas cifradas llevan sufijo `_enc`; índices ciegos, sufijo `_hash`.

### 7.2 Tablas

**Cuentas**

| Tabla                   | Columnas clave                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                 | `email_enc`, `email_hash` (único), `password_hash`, `full_name`, `phone_enc`, `phone_hash`, `document_number_enc`, `document_hash`, `birth_date_enc`, `status` (`ACTIVE`, `DISABLED`), `terms_accepted_at`, `terms_version`, `preferences` JSONB |
| `user_roles`            | `user_id`, `role` — único por par                                                                                                                                                                                                                |
| `refresh_tokens`        | `user_id`, `token_hash`, `family_id`, `expires_at`, `revoked_at`, `replaced_by`, `device_info`                                                                                                                                                   |
| `password_reset_tokens` | `user_id`, `token_hash`, `expires_at`, `used_at`                                                                                                                                                                                                 |
| `device_tokens`         | `user_id`, `platform` (`IOS`, `ANDROID`, `WEB`), `push_token`, `last_seen_at`                                                                                                                                                                    |

**Barberías, barberos y servicios**

| Tabla                | Columnas clave                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `barbershops`        | `name`, `description`, `address`, `location` (`geography(Point,4326)`, índice GiST), `timezone`, `phone`, `status` (`OPEN`, `TEMPORARILY_CLOSED`, `SUSPENDED`), `rating_avg`, `rating_count`, `metadata` |
| `barbershop_members` | `barbershop_id`, `user_id`, `role` (`OWNER`, `MANAGER`) — único por par                                                                                                                                  |
| `barbers`            | `barbershop_id`, `user_id` (opcional), `display_name`, `phone_enc`, `bio`, `photo_url`, `is_active`                                                                                                      |
| `services`           | `barbershop_id`, `name`, `description`, `price_amount`, `currency`, `duration_minutes`, `is_available`                                                                                                   |
| `barber_services`    | `barber_id`, `service_id` — qué barbero realiza qué servicio                                                                                                                                             |

**Horarios y disponibilidad**

| Tabla              | Columnas clave                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `business_hours`   | `barbershop_id`, `day_of_week` (0–6), `open_time`, `close_time`                                                                          |
| `barber_schedules` | `barber_id`, `day_of_week`, `start_time`, `end_time` (varias filas por día permiten descansos)                                           |
| `time_blocks`      | `barbershop_id`, `barber_id` (nulo = toda la barbería), `start_at`, `end_at`, `type` (`BREAK`, `ABSENCE`, `HOLIDAY`, `MANUAL`), `reason` |

**Reservas**

| Tabla                    | Columnas clave                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookings`               | `client_id`, `barbershop_id`, `barber_id`, `service_id`, `start_at`, `end_at`, `status`, `barber_chosen_by_client` (bool), `service_name_snapshot`, `duration_minutes_snapshot`, `subtotal_amount`, `discount_total_amount`, `fee_total_amount`, `total_amount`, `currency`, `expires_at`, `cancelled_by`, `cancel_reason`, `idempotency_key` (único) |
| `booking_price_lines`    | `booking_id`, `type` (`SERVICE`, `DISCOUNT`, `FEE`, `TAX`), `description`, `amount`, `source_type`, `source_id`                                                                                                                                                                                                                                       |
| `booking_status_history` | `booking_id`, `from_status`, `to_status`, `changed_by`, `reason`, `created_at`                                                                                                                                                                                                                                                                        |

**Pagos**

| Tabla            | Columnas clave                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`       | `booking_id`, `provider`, `provider_payment_id` (único por proveedor), `status` (`PENDING`, `SUCCEEDED`, `REJECTED`, `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`), `amount`, `currency`, `method`, `confirmed_at` |
| `payment_events` | `provider`, `provider_event_id` (único), `payment_id`, `type`, `payload` JSONB (sin datos de tarjeta), `processed_at`                                                                                               |
| `refunds`        | `payment_id`, `amount`, `reason`, `status`, `provider_refund_id`                                                                                                                                                    |

**Experiencia del cliente**

| Tabla            | Columnas clave                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `favorites`      | `client_id`, `barbershop_id` — único por par                                                                                                   |
| `reviews`        | `booking_id` (**único**), `client_id`, `barbershop_id`, `barber_id`, `rating` (1–5), `comment`, `status` (`VISIBLE`, `HIDDEN`, `UNDER_REVIEW`) |
| `review_reports` | `review_id`, `reported_by`, `reason`, `resolved_at`, `resolution`                                                                              |
| `notifications`  | `user_id`, `type`, `title`, `body`, `data` JSONB, `channel` (`PUSH`, `EMAIL`, `IN_APP`), `sent_at`, `read_at`                                  |

**Soporte y operación**

| Tabla                | Columnas clave                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support_tickets`    | `user_id`, `category` (`ACCOUNT`, `BOOKING`, `PAYMENT`, `BARBERSHOP`, `REVIEW`, `APP`, `OTHER`), `subject`, `status` (`OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`), `assigned_to`, `related_type`, `related_id` |
| `ticket_messages`    | `ticket_id`, `author_id`, `body_enc`, `is_internal`                                                                                                                                                             |
| `barbershop_reports` | `barbershop_id`, `reported_by`, `reason`, `status`, `resolution`                                                                                                                                                |
| `audit_log`          | `actor_id`, `action`, `entity_type`, `entity_id`, `changes` JSONB (sin datos sensibles), `ip`, `created_at` — solo inserción                                                                                    |

**Crecimiento**

| Tabla                | Columnas clave                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promotions`         | `scope` (`PLATFORM`, `BARBERSHOP`, `SERVICE`), `scope_id`, `name`, `type`, `value`, `starts_at`, `ends_at`, `max_redemptions`, `max_per_user`, `rules` JSONB, `is_active` |
| `coupons`            | `promotion_id`, `code` (único, `citext`)                                                                                                                                  |
| `coupon_redemptions` | `coupon_id`, `user_id`, `booking_id`                                                                                                                                      |
| `sponsors`           | `name`, `logo_url`, `contact_enc`, `is_active`                                                                                                                            |
| `sponsor_campaigns`  | `sponsor_id`, `name`, `starts_at`, `ends_at`, `target` JSONB (zona, servicio), `status`                                                                                   |
| `sponsor_placements` | `campaign_id`, `slot_key`, `title`, `image_url`, `action_url`, `priority`                                                                                                 |
| `sponsor_events`     | `placement_id`, `user_id` (opcional), `type` (`IMPRESSION`, `CLICK`), `created_at`                                                                                        |
| `featured_listings`  | `barbershop_id`, `starts_at`, `ends_at`, `priority`                                                                                                                       |
| `app_settings`       | `key` (único), `value` JSONB, `description`                                                                                                                               |
| `feature_flags`      | `key` (único), `enabled`, `rules` JSONB                                                                                                                                   |
| `outbox_events`      | `type`, `payload` JSONB, `status`, `attempts`, `available_at`, `processed_at`                                                                                             |

### 7.3 Restricciones que Prisma no genera (SQL manual en migración)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- RF-RES-007: imposible solapar reservas activas del mismo barbero
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    barber_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED'));

ALTER TABLE bookings ADD CONSTRAINT bookings_time_check CHECK (end_at > start_at);
ALTER TABLE reviews  ADD CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5);

CREATE INDEX barbershops_location_idx ON barbershops USING gist (location);
```

Si la restricción de exclusión rechaza una inserción, el backend responde `409 Conflict` con código `SLOT_NOT_AVAILABLE`.

---

## 8. Ciclo de vida de la reserva

```
PENDING_PAYMENT ──pago confirmado──▶ CONFIRMED ──▶ ATTENDED
       │                                 ├──▶ CANCELLED
       ├──▶ EXPIRED (venció el tiempo)   └──▶ NO_SHOW
       └──▶ CANCELLED (pago rechazado o cancelado)
```

- Las transiciones se implementan en **un solo lugar** (`BookingStateMachine`). Cualquier transición no listada lanza error.
- Cada transición escribe en `booking_status_history` y publica un evento de dominio, todo en la misma transacción.
- `ATTENDED` y `NO_SHOW` solo pueden marcarse después de `start_at`.
- Solo una reserva `ATTENDED` permite crear una valoración (RF-VAL-001).

---

## 9. Motor de disponibilidad (RF-DIS-001 a 004, RF-BRB-003)

Servicio único `AvailabilityService`. Para una barbería, servicio, fecha y (opcional) barbero:

1. Si la barbería no está `OPEN`, no hay horarios.
2. Tomar el horario de la barbería para ese día, en su zona horaria.
3. Por cada barbero activo que realice el servicio: intersectar con su `barber_schedules`.
4. Restar `time_blocks` (del barbero y de la barbería) y reservas en `PENDING_PAYMENT` (no vencidas) o `CONFIRMED`.
5. Dividir los huecos en turnos según `duration_minutes` y un intervalo configurable (`app_settings`).
6. Descartar turnos en el pasado o con menos anticipación que la mínima configurada.
7. Convertir a UTC para responder.

- "Disponible ahora" (RF-DIS-002) y "siguiente disponibilidad" (RF-DIS-004) reutilizan este mismo cálculo.
- La función central debe ser **pura** (recibe datos, devuelve turnos) para probarla sin base de datos.
- Pruebas obligatorias: cambio de día, zonas horarias, descansos, bloqueos parciales, reservas contiguas, servicio más largo que el hueco, barbería cerrada.
- El cálculo es informativo: la garantía final contra la doble reserva es la restricción de la sección 7.3.

---

## 10. Convenciones de la API

- Prefijo `/api/v1`. Recursos en plural y `kebab-case`.
- Respuesta de error uniforme: `{ "code": "SLOT_NOT_AVAILABLE", "message": "...", "details": [...], "requestId": "..." }`. El `code` es estable y en inglés; el `message` en español.
- Paginación por cursor: `?limit=&cursor=` → `{ "items": [...], "nextCursor": "..." }`.
- Fechas en ISO 8601 UTC. Dinero como `{ "amount": 2500, "currency": "PEN" }`.
- Todo endpoint documentado en Swagger con DTOs de entrada y salida.
- El cliente tipado de `packages/shared` se genera desde el OpenAPI; no se escribe a mano.

---

## 11. Pruebas

- Unitarias para toda la lógica de negocio. Cobertura mínima 80 % en `availability`, `bookings` y `payments`.
- e2e por cada RF de prioridad Alta, contra PostgreSQL real en Docker (no simular la base de datos).
- **Prueba de concurrencia obligatoria** (RF-RES-007): dos peticiones simultáneas por el mismo turno → exactamente una tiene éxito.
- Pruebas de autorización: por cada endpoint privado, un caso que verifique que otro usuario **no** puede acceder.
- Pruebas de webhook: firma inválida rechazada y evento duplicado procesado una sola vez.

---

## 12. Fases de construcción

| Fase | Entregable                                                                                                                                   | RF                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Monorepo, NestJS, Docker Compose, Prisma, configuración validada, Swagger, logs, manejo de errores, `helmet`, CORS, límite de peticiones, CI | —                                              |
| 2    | Esquema completo, migraciones (incluida la sección 7.3), `EncryptionService` con pruebas, datos de prueba                                    | —                                              |
| 3    | Registro, inicio y cierre de sesión, recuperación, roles, perfil                                                                             | RF-AUT-001…004, RF-CLI-001…002                 |
| 4    | Barberías, miembros, barberos, servicios                                                                                                     | RF-BAR-001…004, RF-BRB-001…002, RF-SER-001…003 |
| 5    | Horarios, bloqueos y motor de disponibilidad                                                                                                 | RF-DIS-001…004, RF-BRB-003                     |
| 6    | Búsqueda, cercanía, filtros, alternativas                                                                                                    | RF-BUS-001…004                                 |
| 7    | Reservas, máquina de estados, outbox, expiración, historial                                                                                  | RF-RES-001…008                                 |
| 8    | Pagos con `FakeGateway`, webhooks, reembolsos; luego pasarela real                                                                           | RF-PAG-001…004                                 |
| 9    | Atención e inasistencias                                                                                                                     | RF-ATE-001…003                                 |
| 10   | Notificaciones y recordatorios                                                                                                               | RF-NOT-001…004                                 |
| 11   | Favoritos y valoraciones                                                                                                                     | RF-FAV-001…003, RF-VAL-001…003                 |
| 12   | Soporte y operación de la plataforma                                                                                                         | RF-SOP-001…003, RF-OPE-001…003                 |
| 13   | Promociones, cupones, auspiciadores y destacados                                                                                             | (crecimiento)                                  |

La fase 8 con pasarela real y la fase 13 requieren que las decisiones de la sección 4.2 estén cerradas.

### Una fase está terminada cuando

- Todos los RF de la fase tienen pruebas e2e que pasan.
- `lint`, `typecheck` y `test` pasan sin advertencias.
- Los endpoints nuevos aparecen en Swagger.
- Se revisó la lista de la sección 6 para el código nuevo.
- No hay secretos ni datos personales en el código, los logs o las pruebas.
