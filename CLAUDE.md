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
10. Nunca modifiques ni borres datos de la base directamente (incluida `_prisma_migrations`) sin pedir autorización antes. **Crear o eliminar bases de datos también requiere autorización previa**, salvo `charles_test`. Autorización permanente: `pnpm --filter api test:load:race` puede crear y eliminar `charles_race`.
11. **Ningún commit sin que `pnpm verify` pase.** Ejecuta lint, typecheck, formato, pruebas unitarias y e2e, las coberturas mínimas, la verificación de que el OpenAPI y los tipos de `packages/shared` están al día y `pnpm audit --audit-level=high`. Requiere PostgreSQL y Redis levantados. El hook `.githooks/pre-commit` lo ejecuta; `pnpm install` lo activa (`core.hooksPath`). No se omite con `--no-verify`. Las validaciones de producción no tienen interruptores: `main.ts` se niega a arrancar con `NODE_ENV=test` (`bootstrap-guard.ts`), y los reemplazos de proveedores (`overrides`) existen solo en `test/support/create-test-app.ts`.
12. **Ninguna llamada a servicios externos (pasarela de pagos, correo, APIs de terceros) dentro de una transacción de base de datos.** La transacción deja el estado listo (por ejemplo, el pago en `PENDING`); la llamada externa va después del commit, con su clave de idempotencia, y debe poder reintentarse. Los efectos asíncronos van por el outbox.
13. Mantén al día `docs/pendientes-produccion.md`: todo lo que bloquea salir a producción. Revísalo al cerrar cada fase.
14. Al empezar una conversación nueva, lee `docs/ESTADO.md` y `docs/pendientes-produccion.md` antes de hacer nada. Al cerrar cada fase, actualiza `docs/ESTADO.md`.
15. Al cerrar cada fase, regenera `docs/mobile/openapi.json` (`pnpm mobile:openapi`) y actualiza `docs/mobile/GUIA-API.md`. La app móvil se desarrolla aparte (`../charlesmobile`) y depende de esos documentos.

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
`auth`, `users`, `barbershops`, `barbers`, `services`, `invitations`, `availability`, `search`, `bookings`, `payments`, `attendance`, `notifications`, `favorites`, `reviews`, `support`, `admin`, `promotions`, `sponsors`, `settings`.

Cada módulo contiene: `*.controller.ts`, `*.service.ts`, `dto/`, `*.module.ts`, `*.spec.ts`. Un módulo solo accede a otro a través de su servicio exportado o de eventos de dominio, nunca tocando directamente sus tablas.

### Comandos

```
pnpm install
docker compose up -d
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed
pnpm --filter api start:dev
pnpm --filter api seed:reference      # categorías de servicio (datos de referencia)
pnpm test | pnpm test:e2e | pnpm lint | pnpm typecheck
pnpm verify                           # todo lo anterior + coberturas + OpenAPI + audit
pnpm --filter api test:load:race      # carrera por un turno bajo carga (fuera de verify)
pnpm --filter api dev:pay <bookingId> [--reject] | dev:mail <correo> | admin:grant <correo>
```

Los scripts de consola (`dev:pay`, `dev:mail`, `admin:grant`, `openapi:export`) se ejecutan sobre el código fuente con `ts-node --transpile-only` (conserva la metadata de los decoradores; tsx no). **Nunca con `nest build`**: borraría `dist` y tumbaría el `start:dev` en marcha. Por lo mismo, `pnpm verify` no compila a `dist`.

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
- **Pasarela de pago: Izipay (Perú)** (ADR 0002). No se integra hasta la Fase 8; mientras tanto se usa `FakeGateway`. El esquema de `payments` es independiente del proveedor (`provider` es texto, no un enum ni columnas específicas de Izipay). Referencias y pendientes en `docs/pagos-izipay.md`. Las credenciales, incluso las de prueba, nunca van en el repositorio.
- **Los precios incluyen impuestos.** `bookings.total_amount = subtotal_amount − discount_total_amount + fee_total_amount` (restricción `CHECK`). Las líneas `TAX` de `booking_price_lines` son informativas y no suman al total. Se revisa antes de la Fase 8 (ADR 0002).
- **Horarios:** no se admiten horarios que crucen la medianoche en el MVP (`close_time > open_time`, `end_time > start_time`).
- **Valores iniciales de `app_settings`:** intervalo entre turnos 15 minutos (`availability.slot_interval_minutes`), anticipación mínima 0 minutos (`availability.min_lead_time_minutes`), bloqueo de `PENDING_PAYMENT` 10 minutos (`booking.pending_payment_ttl_minutes`). Todos configurables.
- **Identificadores únicos:** `email_hash` único; `document_hash` único solo cuando no es nulo (índice único parcial); `phone_hash` solo indexado, no único.
- **Idempotencia:** `bookings` es única por `(client_id, idempotency_key)`; `payments` tiene su propia `idempotency_key`, única por `(booking_id, idempotency_key)`.

#### Cuentas y autenticación (Fase 3)

- **Inicio de sesión solo con correo.** Se compara por índice ciego (sin distinguir mayúsculas ni espacios).
- **Registro:** obligatorios nombre completo, correo, contraseña y aceptación de términos; opcional el teléfono. No se piden documento ni fecha de nacimiento en el MVP (las columnas quedan para uso futuro).
- **Edad mínima 18 años**, autodeclarada con una casilla obligatoria al aceptar los términos (`users.adult_declared_at`). ⚠️ Pendiente de validación legal (ADR 0003).
- **Correo ya registrado:** el registro responde exactamente igual (código, cuerpo y tiempo comparable) y se avisa por correo al dueño. Se aparta del texto de RF-AUT-001 por seguridad (ADR 0003). El registro no devuelve tokens: después se inicia sesión.
- **Verificación de correo:** el usuario puede entrar sin verificar; el correo verificado se exige para reservar (Fase 7).
- **Roles:** todo registro crea `CLIENT`. `OWNER` se obtiene automáticamente al registrar una barbería (Fase 4). `BARBER` lo asigna el responsable (Fase 4). `SUPPORT` solo por seed o administrador. Nadie elige su rol al registrarse.
- **Términos:** la versión vigente está en `app_settings` (`legal.terms_version`) y el registro exige aceptar exactamente esa versión. La re-aceptación obligatoria al cambiar la versión queda para una fase posterior.
- **Contraseñas:** de 10 a 128 caracteres, sin reglas de composición, rechazando las de una lista local de contraseñas comunes (`modules/auth/password/common-passwords.txt`). Sin HIBP en el MVP.
- **Bloqueo:** bloqueo progresivo de 1, 5 y 15 minutos tras **5 fallos por cuenta** o **20 por IP** (umbral mayor para no bloquear a usuarios que comparten red). Ambos umbrales son configurables en `app_settings` (`auth.lockout.account_max_failures`, `auth.lockout.ip_max_failures`); si faltan o son inválidos se usan 5 y 20. Al bloquearse la cuenta se avisa por correo. Los fallos de códigos (recuperación y verificación) también cuentan.
- **Cuenta deshabilitada:** el mensaje específico solo se muestra después de validar la contraseña; antes, error genérico.
- **Sesión:** 30 días, renovándose con el uso; sin límite de dispositivos. Cierre de sesión en el dispositivo actual o en todos.
- **Recuperación de acceso:** por correo, con código de 6 dígitos, 15 minutos y un solo uso. Solo se guarda su HMAC y se invalida tras 5 intentos fallidos. Lo mismo aplica al código de verificación de correo. Al cambiar la contraseña se cierran todas las sesiones y se envía un correo de aviso.
- **Correo:** interfaz `Mailer` con `FakeMailer` (guarda los correos en Redis; prohibido en producción). El proveedor real se elige en la Fase 10. Los correos se envían desde una cola BullMQ y los trabajos nunca llevan datos personales en claro.
- **Perfil (RF-CLI-002):** editables nombre, teléfono y preferencias (por ahora solo canales de notificación; por defecto todos activos). El correo no se puede cambiar en el MVP.

#### Barberías, barberos y servicios (Fase 4)

- **Publicación:** inmediata por defecto. Si `barbershops.require_review` (`app_settings`, por defecto `false`) es `true`, una barbería nueva queda en `PENDING_REVIEW` y no es visible públicamente hasta que soporte la apruebe (Fase 12).
- **Visibilidad pública:** solo barberías no eliminadas en `OPEN` o `TEMPORARILY_CLOSED`. `PENDING_REVIEW` y `SUSPENDED` nunca aparecen en consultas públicas (detalle, servicios ni barberos); responden 404.
- **Ámbito:** solo Perú. Coordenadas dentro de Perú, zona horaria `America/Lima` por defecto (IANA válida) y precios solo en `PEN`.
- **Datos de la barbería:** obligatorios nombre, dirección, ubicación (latitud/longitud enviadas por la app, sin geocodificación) y teléfono. Opcionales: descripción, enlaces https (sitio web, Instagram, Facebook) y RUC (11 dígitos). ⚠️ Pendiente: el RUC podría ser obligatorio antes de recibir pagos (Fase 8). Fotos y logo quedan para una fase posterior.
- **Estado (RF-BAR-004):** solo un `OWNER` alterna entre `OPEN` y `TEMPORARILY_CLOSED` (con motivo y fecha estimada de reapertura opcionales). `PENDING_REVIEW` y `SUSPENDED` los gestiona soporte. "Fuera de horario" se calcula (Fase 5). El cierre solo bloquea reservas nuevas.
- **Eliminar:** borrado lógico, solo `OWNER`, rechazado si hay reservas futuras activas.
- **Responsables:** un `OWNER` invita por correo a una **cuenta existente** con rol `OWNER` o `MANAGER`. La invitación usa un código con las mismas reglas de la Fase 3 (solo HMAC, un solo uso, vencimiento configurable en `barbershops.invitation_ttl_minutes` —**2880 min (48 h)** por defecto; los códigos de recuperación y verificación de la Fase 3 siguen en 15 min—, inválido tras 5 intentos que cuentan para el bloqueo). La respuesta al invitar es idéntica exista o no la cuenta. Un `MANAGER` puede todo salvo gestionar responsables y cambiar el estado de la barbería. Ser responsable (OWNER o MANAGER) otorga el rol global `OWNER`.
- **Roles globales derivados:** `OWNER` lo tiene quien es miembro de al menos una barbería no eliminada; `BARBER`, quien está vinculado a al menos un perfil de barbero activo y no eliminado. Se recalculan al quitar o retirar un responsable, al aceptar invitaciones, al activar o desactivar un barbero y al eliminar una barbería (que elimina también sus barberos, liberando sus cuentas). El cambio se refleja en el token al renovar la sesión.
- **Siempre al menos un OWNER:** se rechaza quitar o degradar al último `OWNER`, incluso si lo hace él mismo (409 `LAST_OWNER`). Las operaciones bloquean la fila de la barbería (`FOR UPDATE`) para que dos cambios simultáneos no la dejen sin OWNER.
- **Autorización por propiedad:** se verifica la membresía en **esa** barbería (el rol global no basta). Un no miembro recibe 404 para no revelar barberías ajenas; un miembro sin el rol necesario recibe 403.
- **Barberos:** el responsable crea el perfil; puede vincularlo a una cuenta existente por invitación con código (al aceptar recibe el rol `BARBER`). El responsable que también es barbero se vincula a sí mismo sin invitación. Un barbero activo en una barbería no puede vincularse a otra (MVP). Solo el responsable edita el perfil. Desactivar un barbero se rechaza si tiene reservas futuras activas. El teléfono del barbero se guarda cifrado y nunca es público.
- **Barbero independiente:**
  - `barbershops.type` puede ser `BARBERSHOP` (por defecto) o `INDEPENDENT`. Se ve en la consulta pública y en "mis barberías", y no cambia después de crear la barbería (lo impide un trigger en la base; `PATCH` lo rechaza como campo desconocido).
  - `POST /barbershops/independent` hace todo en una sola transacción: crea la barbería `INDEPENDENT`, deja a la cuenta como `OWNER` y crea su perfil de barbero, vinculado y activo, con los roles `OWNER` y `BARBER`.
  - Una barbería `INDEPENDENT` admite **un solo barbero activo** (409 `INDEPENDENT_SINGLE_BARBER`). Lo aplican el servicio, que bloquea la fila de la barbería, y un trigger en la base como respaldo. Se pueden guardar barberos inactivos.
  - Sigue valiendo la regla de un barbero activo en una sola barbería (409 `BARBER_ALREADY_ACTIVE_ELSEWHERE`, sin crear nada).
  - Respeta `barbershops.require_review`.
  - La atención a domicilio queda fuera de alcance.
- **Servicios:** precio mayor que 0 (no hay servicios gratuitos), duración de 5 a 480 minutos en múltiplos de 5 (validado en la API y con `CHECK` en la base), moneda `PEN`. Eliminar es borrado lógico. Un servicio sin barberos asignados se muestra pero no se puede reservar (Fase 5).
- **Consultas públicas** (detalle de barbería, servicios y barberos): sin iniciar sesión, solo datos públicos y con límite de peticiones propio (perfil `public`, 60/min por IP).
- **Auditoría:** para datos no personales (precio, duración, estado de la barbería, roles de responsables, nombre y dirección de la barbería, servicios de un barbero, activación) se guarda el valor anterior y el nuevo (`changes.values`). Para datos personales (teléfonos, RUC, nombre visible y biografía del barbero, datos del perfil de usuario) solo el nombre del campo (`changes.personalFields`).

#### Horarios y disponibilidad (Fase 5)

- **Horario efectivo del barbero** = (su horario semanal, o el de la barbería si no tiene propio) ∩ horario de la barbería − bloqueos de la barbería − bloqueos del barbero − reservas activas. Un horario del barbero fuera del de la barbería se guarda, pero solo cuenta la intersección. Varias filas contiguas de un mismo día forman un tramo continuo. Una semana vacía en el horario del barbero significa "hereda el de la barbería".
- **Días no laborables:** bloqueos de día completo registrados por el responsable (sin calendario de feriados automático).
- **Quién gestiona:** el responsable (OWNER o MANAGER), horarios y bloqueos de todos; el barbero con cuenta vinculada, solo sus propios bloqueos (no su horario semanal ni bloqueos de la barbería o de otros).
- **Bloqueos sobre reservas activas:** se rechazan (409 `BLOCK_OVERLAPS_BOOKINGS`, con el número de reservas afectadas). Cambiar un horario sí se permite: las reservas existentes se mantienen y la respuesta informa cuántas quedan fuera (`bookingsOutsideSchedule`).
- **Turnos:** inicios alineados al reloj local en múltiplos de `availability.slot_interval_minutes` (15); el turno debe caber completo; sin tiempo de limpieza entre citas; horarios y bloqueos en múltiplos de 5 minutos.
- **Horizonte:** `availability.booking_horizon_days` (30). "Hoy", el horizonte y el rechazo de fechas pasadas se evalúan en la **zona horaria de la barbería**, no en la del cliente ni en UTC (400 `DATE_OUT_OF_RANGE`).
- **"Disponible ahora" (RF-DIS-002):** hay un turno que empieza dentro de `availability.now_window_minutes` (30). **"Cualquier barbero":** turnos combinados con la lista de barberos libres. Una barbería `TEMPORARILY_CLOSED` no ofrece turnos en ninguna fecha hasta reabrirse.
- **Día de la semana:** convención 0 = domingo … 6 = sábado; luxon usa 1 = lunes … 7 = domingo. La conversión vive en una sola función (`toDayOfWeek` en `availability/engine/local-time.ts`).
- **Privacidad:** las respuestas públicas de disponibilidad solo incluyen turnos (`startAt`, `endAt`) y los ID de barberos libres. Nunca motivos ni tipos de bloqueo, ni datos de reservas o clientes. El motivo de un bloqueo solo lo ven los responsables y el propio barbero.
- **Carga por lotes:** `AvailabilityService.loadContexts` / `availableNowBatch` aceptan varias barberías en pocas consultas (la Fase 6 calcula "disponible ahora" para barberías cercanas). Sin caché por ahora.
- **"Abierta ahora"** (RF-BAR-004): `GET /barbershops/{id}/business-hours` devuelve el horario semanal e `isOpenNow` (estado OPEN, dentro del horario y sin bloqueo general).

#### Búsqueda, cercanía, filtros y alternativas (Fase 6)

- **Categorías de servicio:** tabla `service_categories`. Todo servicio tiene una categoría activa (`categoryKey` al crear o editar; 400 `activeCategory` si no existe o está inactiva). `GET /service-categories` lista las activas, en orden y sin sesión.
  - Las 9 categorías iniciales son datos de referencia, no de prueba: `pnpm --filter api seed:reference`, idempotente, que también corre en `global-setup` de las e2e y dentro del seed.
  - Con `--settings` crea además las claves de `app_settings` que falten. Nunca modifica ni borra.
- **Búsqueda (`GET /search/barbershops`, pública):**
  - **Visibilidad:** solo barberías visibles (`OPEN` y `TEMPORARILY_CLOSED`, esta última marcada y sin disponibilidad); nunca `PENDING_REVIEW`, `SUSPENDED` ni eliminadas.
  - **Cercanía:** con `lat`/`lng` (ambos y dentro de Perú), `ST_DWithin` sobre `location`. Radio por defecto `search.default_radius_km` (5); uno mayor que `search.max_radius_km` (25) se recorta.
  - **Texto:** `q` de 2 a 80 caracteres, sin distinguir tildes ni mayúsculas, en el nombre de la barbería o de un servicio reservable. Siempre con consultas parametrizadas, y los comodines de LIKE se buscan literalmente.
  - **Filtros:**
    - `category` (clave);
    - `minPrice`/`maxPrice`: algún servicio reservable en el rango, y "precio desde" es el más bajo que cumple;
    - `minRating`: excluye las barberías sin valoraciones;
    - `type` (`BARBERSHOP` o `INDEPENDENT`);
    - `openNow`, `availableNow` y `date` (algún turno en esa fecha local).
  - **Disponibilidad:** los filtros de disponibilidad se evalúan por lotes con el motor de la Fase 5, sobre los servicios de la barbería que cumplen los filtros. Cada petición evalúa como máximo `search.max_candidates` (200) barberías. Si llega al tope sin llenar la página, devuelve lo encontrado con su cursor y `evaluationLimitReached: true`.
  - **Orden:** `distance` (por defecto con ubicación), `rating` (por defecto sin ella; las barberías sin valoraciones van al final con `rating.average: null` y `count: 0`) y `price` (las que no tienen servicios reservables van al final).
  - **Paginación:** por defecto `search.default_page_size` (20), con tope en `search.max_page_size` (50). El cursor es opaco, cifrado y autenticado; uno alterado o de otro orden da 400 `INVALID_CURSOR`.
  - **Respuesta:** cada resultado incluye `isOpenNow`, `availableNow` y `featured`.
- **Ranking separado:** la búsqueda no conoce el orden; se lo pide a `RankingStrategy` (`search/ranking/ranking.ts`, token `RANKING_STRATEGY`).
  - `orderKeys(sort)` da el orden orgánico que la consulta aplica con el cursor.
  - `arrange(page, {sort, firstPage})` compone la página final.
  - En la Fase 13, una estrategia con `featured_listings` reemplaza a `OrganicRankingStrategy` sin tocar la búsqueda. Los destacados siempre van con `featured: true` (hoy siempre `false`).
- **Alternativas (RF-BUS-004, `GET /barbershops/{id}/alternatives?serviceId=&date=`):**
  - Devuelve otras barberías visibles, dentro de `search.max_radius_km` de la consultada y más cercanas primero, que tengan un servicio reservable de la **misma categoría** y un turno real en la fecha. Por defecto, la fecha es hoy en la zona de la barbería.
  - Devuelve como máximo 5, sin paginación. De cada una, el servicio con el turno más temprano (a igual turno, el más barato) y ese primer turno.
  - Nunca se muestra como disponible una barbería sin turnos calculados.
- **Privacidad de la ubicación:** `lat`/`lng` solo existen durante la petición. No se guardan ni se auditan, no vuelven en la respuesta (solo la distancia en metros redondeados) y no van en el cursor. El logger enmascara `lat`, `lng` y `cursor` en las URL.
- **Límite de peticiones:** perfil `search`, 60/min por IP, configurable en `search.rate_limit_per_minute`. Se relee cada minuto, sin consultar la base en cada petición.

### 4.2 Pendientes (NO las inventes; deja el punto configurable y pregunta)

- Medios de pago (la pasarela ya está decidida: Izipay, plataforma micuentaweb).
- Comisión de Charles: sin definir. El desglose ya lleva una línea `FEE` en 0.
- Quién asume la comisión de la pasarela, también en las devoluciones.
- Liquidación a la barbería (cuándo recibe el dinero): fuera de alcance.
- Sanción económica a la barbería por cancelar.

Hasta que se definan: la pasarela se implementa detrás de la interfaz `PaymentGateway` (`FakeGateway`, luego Izipay), y las políticas se leen desde `app_settings`. **Resueltas en la Fase 8A:** devoluciones al cancelar, plazo para cancelar, no-show y sanción por cancelaciones de la barbería (ver "Pagos y reembolsos (Fase 8A)"). Lo que bloquea salir a producción está en `docs/pendientes-produccion.md`.

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
- El **contexto (AAD)** de cada campo cifrado es una **constante estable definida en código** (por ejemplo `charles/user.email/v1`), nunca derivada del nombre real de la tabla o columna: un renombrado futuro no debe impedir descifrar datos existentes. Esas constantes no se modifican jamás. Lo mismo aplica al separador de dominio de cada índice ciego.
- Las claves viven en un gestor de secretos / KMS, separadas de la base de datos. La clave de cifrado y la de índice son distintas.
- **Contraseñas:** hash con **Argon2id**. Jamás cifrado reversible, jamás en logs.
- **Tarjetas:** Charles **nunca** almacena ni procesa número de tarjeta, CVV ni vencimiento. Solo se guardan identificadores/tokens entregados por la pasarela.

### 6.3 Autenticación y sesiones

- Token de acceso JWT de vida corta (15 min) firmado con algoritmo asimétrico (ES256 o RS256).
- Token de renovación opaco y aleatorio, guardado **solo como hash**, con **rotación en cada uso** y detección de reutilización (si se reutiliza uno ya rotado, se revoca toda la familia de sesiones), con una **gracia configurable** (`REFRESH_TOKEN_GRACE_SECONDS`, 10 s) en que el mismo token devuelve el mismo sucesor, nunca uno distinto.
- Web: tokens en cookies `HttpOnly`, `Secure`, `SameSite`, con protección CSRF. Móvil: almacenamiento seguro del sistema (Keychain / Keystore).
  - **Pendiente (fase del frontend web):** hoy los tokens viajan solo en el cuerpo (móvil). Las cookies y el CSRF se agregarán sin cambiar los endpoints: el cliente web se identificará con una cabecera, y `login`/`refresh` escribirán los tokens en cookies en vez del cuerpo. `refresh` y `logout` los leerán de la cookie cuando no vengan en el cuerpo, y los métodos que cambian estado exigirán el token CSRF (_double submit_).
- Revocación inmediata: al cerrar sesión, el ID de sesión (`sid` del JWT = `refresh_tokens.family_id`) se marca en Redis durante la vida del token de acceso, y el guard lo rechaza en cada petición. Si Redis no responde, el guard falla de forma cerrada (503).
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

- **Pool de PostgreSQL:** `DATABASE_POOL_MAX` (por defecto y recomendado: 10 por instancia, mínimo 2, máximo 100). La suma de todas las instancias más las migraciones y los trabajos debe quedar por debajo de `max_connections` del servidor, con margen. Las transacciones de reserva retienen una conexión como máximo 20 s; las esperas de bloqueo, como máximo 5 s.
- **Errores 500:** el filtro global registra los de base de datos con el código de Prisma, el SQLSTATE de PostgreSQL y la restricción, nunca con el mensaje (puede contener valores de la consulta).

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

| Tabla                      | Columnas clave                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                    | `email_enc`, `email_hash` (único), `password_hash`, `full_name`, `phone_enc`, `phone_hash` (indexado, no único), `document_number_enc`, `document_hash` (único si no es nulo, índice parcial), `birth_date_enc`, `status` (`ACTIVE`, `DISABLED`), `email_verified_at`, `adult_declared_at`, `terms_accepted_at`, `terms_version`, `preferences` JSONB |
| `user_roles`               | `user_id`, `role` — único por par                                                                                                                                                                                                                                                                                                                     |
| `refresh_tokens`           | `user_id`, `token_hash`, `family_id`, `expires_at`, `revoked_at`, `replaced_by`, `device_info`                                                                                                                                                                                                                                                        |
| `password_reset_tokens`    | `user_id`, `token_hash` (HMAC del código), `attempts` (máx. 5), `expires_at`, `used_at`                                                                                                                                                                                                                                                               |
| `email_verification_codes` | `user_id`, `code_hash` (HMAC del código), `attempts` (máx. 5), `expires_at`, `used_at`                                                                                                                                                                                                                                                                |
| `device_tokens`            | `user_id`, `platform` (`IOS`, `ANDROID`, `WEB`), `push_token`, `last_seen_at`                                                                                                                                                                                                                                                                         |

**Barberías, barberos y servicios**

| Tabla                    | Columnas clave                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `barbershops`            | `name`, `description`, `address`, `latitude`, `longitude`, `location` (`geography(Point,4326)` **generada** desde latitud/longitud, índice GiST), `timezone`, `phone`, `ruc` (11 dígitos, opcional), `website_url`, `instagram_url`, `facebook_url`, `type` (`BARBERSHOP`, `INDEPENDENT`; inmutable), `status` (`OPEN`, `TEMPORARILY_CLOSED`, `SUSPENDED`, `PENDING_REVIEW`), `closure_reason`, `expected_reopen_at`, `rating_avg`, `rating_count`, `metadata` |
| `barbershop_members`     | `barbershop_id`, `user_id`, `role` (`OWNER`, `MANAGER`) — único por par                                                                                                                                                                                                                                                                                                                                                                                        |
| `barbershop_invitations` | `barbershop_id`, `kind` (`MEMBER`, `BARBER`), `member_role`, `barber_id`, `invited_user_id`, `invited_by`, `code_hash` (HMAC), `attempts` (máx. 5), `expires_at`, `accepted_at`, `revoked_at`                                                                                                                                                                                                                                                                  |
| `barbers`                | `barbershop_id`, `user_id` (opcional), `display_name`, `phone_enc`, `bio`, `photo_url`, `is_active`                                                                                                                                                                                                                                                                                                                                                            |
| `services`               | `barbershop_id`, `category_id` (obligatoria), `name`, `description`, `price_amount`, `currency`, `duration_minutes`, `is_available`                                                                                                                                                                                                                                                                                                                            |
| `service_categories`     | `key` (único, estable, p. ej. `haircut`), `name`, `sort_order`, `is_active` — tabla (no enum) para ampliarla sin migrar                                                                                                                                                                                                                                                                                                                                        |
| `barber_services`        | `barber_id`, `service_id` — qué barbero realiza qué servicio                                                                                                                                                                                                                                                                                                                                                                                                   |

**Horarios y disponibilidad**

| Tabla              | Columnas clave                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `business_hours`   | `barbershop_id`, `day_of_week` (0–6), `open_time`, `close_time`                                                                          |
| `barber_schedules` | `barber_id`, `day_of_week`, `start_time`, `end_time` (varias filas por día permiten descansos)                                           |
| `time_blocks`      | `barbershop_id`, `barber_id` (nulo = toda la barbería), `start_at`, `end_at`, `type` (`BREAK`, `ABSENCE`, `HOLIDAY`, `MANUAL`), `reason` |

**Reservas**

| Tabla                    | Columnas clave                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookings`               | `client_id`, `barbershop_id`, `barber_id`, `service_id`, `start_at`, `end_at`, `status`, `barber_chosen_by_client` (bool), `service_name_snapshot`, `duration_minutes_snapshot`, `subtotal_amount`, `discount_total_amount`, `fee_total_amount`, `total_amount`, `currency`, `expires_at`, `cancelled_by`, `cancel_reason`, `idempotency_key` (único por `client_id`) |
| `booking_price_lines`    | `booking_id`, `type` (`SERVICE`, `DISCOUNT`, `FEE`, `TAX`), `description`, `amount`, `source_type`, `source_id`                                                                                                                                                                                                                                                       |
| `booking_status_history` | `booking_id`, `from_status`, `to_status`, `changed_by`, `reason`, `created_at`                                                                                                                                                                                                                                                                                        |

**Pagos**

| Tabla            | Columnas clave                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`       | `booking_id`, `provider`, `provider_payment_id` (único por proveedor), `status` (`PENDING`, `SUCCEEDED`, `REJECTED`, `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`), `amount`, `currency`, `method`, `idempotency_key` (único por `booking_id`), `confirmed_at` |
| `payment_events` | `provider`, `provider_event_id` (único), `payment_id`, `type`, `payload` JSONB (sin datos de tarjeta), `processed_at`                                                                                                                                           |
| `refunds`        | `payment_id`, `amount`, `reason`, `status`, `provider_refund_id`                                                                                                                                                                                                |

**Experiencia del cliente**

| Tabla            | Columnas clave                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `favorites`      | `client_id`, `barbershop_id` — único por par                                                                                                                                                                                                               |
| `reviews`        | `booking_id` (**único**), `client_id`, `barbershop_id`, `barber_id`, `rating` (1–5), `comment`, `status` (`VISIBLE`, `HIDDEN`, `UNDER_REVIEW`), `hidden_reason`, `edited_at`, respuesta (`response_text`, `response_by`, `response_at`, `response_status`) |
| `review_reports` | `review_id`, `target` (`REVIEW`, `RESPONSE`), `reported_by` (único por valoración y objetivo), `reason` (lista cerrada), `details`, `resolved_at`, `resolution`                                                                                            |
| `notifications`  | `user_id`, `type`, `title`, `body`, `data` JSONB, `channel` (`PUSH`, `EMAIL`, `IN_APP`), `sent_at`, `read_at`                                                                                                                                              |

**Soporte y operación**

| Tabla                | Columnas clave                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support_tickets`    | `user_id`, `category` (`ACCOUNT`, `BOOKING`, `PAYMENT`, `BARBERSHOP`, `REVIEW`, `APP`, `OTHER`), `subject`, `status` (`OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`), `assigned_to`, `related_type`, `related_id` |
| `ticket_messages`    | `ticket_id`, `author_id`, `body_enc`, `is_internal`                                                                                                                                                             |
| `barbershop_reports` | `barbershop_id`, `reported_by`, `reason`, `status`, `resolution`                                                                                                                                                |
| `audit_log`          | `actor_id`, `action`, `entity_type`, `entity_id`, `changes` JSONB (sin datos sensibles), `ip`, `created_at` — solo inserción (trigger que rechaza `UPDATE`, `DELETE` y `TRUNCATE`; sin FK a `users`)            |

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
| `app_settings`       | `key` (único), `value` JSONB (`null` = política pendiente), `description`                                                                                                 |
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

Además, la migración `core_schema` incluye en SQL manual: `CHECK` de moneda ISO 4217, montos no negativos, `total = subtotal − discount_total + fee_total` (ADR 0002), `expires_at` obligatorio en `PENDING_PAYMENT`, horarios sin cruzar la medianoche, `day_of_week` 0–6 (0 = domingo), rangos de coordenadas, reglas de promociones; los índices únicos parciales `users_document_hash_key` y `barbers_user_id_active_key` (un barbero activo en una sola barbería, MVP); y el trigger de solo inserción de `audit_log`. La migración `independent_barber` agrega los triggers `barbershops_type_immutable` y `barbers_independent_single_active`; la migración `search_categories` agrega `unaccent`, `pg_trgm`, la función inmutable `charles_normalize(text)` (sin tildes y en minúsculas) con índices GIN trigram sobre los nombres de barberías y servicios, y crea la categoría `other` con ID fijo para asignarla a los servicios existentes. Prisma no detecta _drift_ por estos objetos; una prueba de integración lo verifica (`prisma migrate diff`).

Si la restricción de exclusión rechaza una inserción, el backend responde `409 Conflict` con código `SLOT_NOT_AVAILABLE`.

---

## 8. Ciclo de vida de la reserva

```
PENDING_PAYMENT ──pago confirmado──▶ CONFIRMED ──▶ ATTENDED
       │                                 ├──▶ CANCELLED
       ├──▶ EXPIRED (venció el tiempo)   └──▶ NO_SHOW
       └──▶ CANCELLED (pago rechazado o cancelado)
```

- Las transiciones se implementan en **un solo lugar** (`BookingStateMachine`, `modules/bookings/booking-state-machine.ts`). Cualquier transición no listada lanza `INVALID_STATE_TRANSITION` (409). Además de las del diagrama: `CONFIRMED → CANCELLED`.
- Cada transición escribe en `booking_status_history` y publica un evento de dominio, todo en la misma transacción.
- `ATTENDED` y `NO_SHOW` solo pueden marcarse después de `start_at`.
- Solo una reserva `ATTENDED` permite crear una valoración (RF-VAL-001).
- **Outbox (entrega "al menos una vez"):** `OutboxService.publish(tx, …)` dentro de la transacción del cambio. `OutboxRelay` reclama lotes con `FOR UPDATE SKIP LOCKED`, cada 5 s como trabajo repetible de BullMQ.
  - Si un consumidor falla, el evento se reintenta con espera creciente (2^n s, máximo 10 min) y queda `FAILED` tras 8 intentos.
  - Un evento "en proceso" abandonado durante más de 5 min se reentrega.
  - Cada evento tiene un ID único y el payload lleva solo IDs, nunca datos personales.
  - **Todo consumidor debe ser idempotente por ese ID**: `IdempotentConsumerStore.runOnce(consumidor, eventId, efecto)`, con la marca en Redis por 30 días. Si el efecto debe ser idempotente para siempre (por ejemplo, un cobro), se apoya además en una restricción única en la base.
- **Eventos:** `booking.created`, `booking.confirmed`, `booking.cancelled`, `booking.expired`, `booking.attended`, `booking.no_show`, `booking.attendance_corrected`, `payment.orphaned`, `refund.requested`, `refund.succeeded`, `refund.failed`, `barbershop.cancellation_recorded` y `barbershop.suspended`.
- **Trabajos programados** (`SCHEDULED_JOBS_ENABLED`, activo por defecto; las e2e los apagan y los ejecutan a mano con el reloj fijo): el relay del outbox y el vencimiento de reservas sin pago.

#### Reservas (Fase 7)

- **Crear (`POST /bookings`):**
  - **Plazos de la transacción:** `BOOKING_TX_OPTIONS` da 10 s para obtener conexión y 20 s de duración, y `SET LOCAL lock_timeout` limita cada espera de bloqueo a 5 s (`LOCK_TIMEOUT_MS`).
  - **Orden de bloqueos, siempre el mismo:**
    1. consultivo del cliente;
    2. reservas vencidas que se solapan, en **una** consulta `FOR UPDATE` ordenada por id;
    3. inserción (restricción de exclusión).

    PostgreSQL vuelve a evaluar la condición tras esperar, así que una reserva que otra transacción ya venció no se procesa dos veces.

  - **Contención:**
    - bloqueo mutuo `40P01`, serialización `40001` y espera de bloqueo `55P03` (y los equivalentes de Prisma `P2034`/`P2028`): se reintenta una vez dentro del servidor; si persiste, 503 `SERVICE_UNAVAILABLE` con `retryable: true`;
    - exclusión `23P01`: 409 `SLOT_NOT_AVAILABLE`;
    - ningún error de contención llega como 500 (`common/errors/db-error.ts`);
  - **Prueba de carga** (no forma parte de `verify`): `pnpm --filter api test:load:race`, con `RACE_ROUNDS` (200), `RACE_EXPIRE_ROUNDS` (100) y `RACE_POOL_MAX`. Usa su propia base, `charles_race`, para correr en paralelo con la suite e2e.
  - **Cabecera `Idempotency-Key` (UUID) obligatoria:** la misma petición devuelve la misma reserva (200); otra petición con la misma clave da 409 `IDEMPOTENCY_KEY_REUSED`.
  - **Correo verificado:** obligatorio (403 `EMAIL_NOT_VERIFIED`).
  - **Validación del turno:** `startAt` debe ser futuro, respetar la anticipación mínima y coincidir exactamente con un turno del motor. Si no, 409 `SLOT_NOT_AVAILABLE`, también para fechas pasadas, fuera del horizonte o en una barbería no `OPEN`.
  - **En una transacción:**
    1. bloqueo consultivo por cliente;
    2. límite de pendientes;
    3. expirar las `PENDING_PAYMENT` vencidas que se solapan con el turno (por la máquina de estados);
    4. insertar copiando del servicio el nombre, la duración y el precio, más una línea `SERVICE` en `booking_price_lines` (el precio incluye impuestos);
    5. historial y evento;
    6. pago `PENDING`.

    La restricción de exclusión es la garantía final contra la doble reserva.
- **"Cualquier barbero":** el libre con menos reservas activas ese día y, a igualdad, por ID. Hasta 3 candidatos, con un savepoint entre intentos. Guarda `barber_chosen_by_client = false`.
- **Abuso:**
  - como máximo `booking.max_pending_per_client` (2) reservas `PENDING_PAYMENT` vigentes por cliente (409 `TOO_MANY_PENDING_BOOKINGS`); las vencidas no cuentan;
  - `booking.rate_limit_per_minute` (20) creaciones por minuto **por cliente**, además del límite por IP;
  - sí se permiten reservas del mismo cliente que se solapen (acompañante) y no hay máximo de reservas futuras.
- **Plazo para pagar:** `booking.pending_payment_ttl_minutes` (10). Un trabajo cada minuto pasa a `EXPIRED` las vencidas, con `FOR UPDATE SKIP LOCKED`; es idempotente.
- **Pago (punto de unión, Fase 7):**
  - La fila `payments` (`PENDING`) se crea en la transacción de la reserva.
  - `PaymentGateway.createPayment` se llama después del commit, con `idempotencyKey = booking:{id}`. Si falla, la reserva existe igual y se reintenta con `POST /bookings/{id}/payment` (502 `PAYMENT_PROVIDER_ERROR` mientras siga fallando).
  - La reserva pasa a `CONFIRMED` **solo** desde `PaymentsService.applyPaymentResult`, que llaman el webhook verificado y la conciliación (nunca la app). Ver Fase 8A.
  - Un pago rechazado o cancelado lleva la reserva a `CANCELLED`, con el sistema como actor.
  - Un pago confirmado sobre una reserva vencida o cancelada no la reactiva: queda `refundDecision: ORPHANED`, se emite `payment.orphaned` y se devuelve completo.
  - La app no arranca en producción con `payments.provider = FAKE`.
- **Cancelar (`POST /bookings/{id}/cancel`):**
  - el cliente, o el OWNER/MANAGER con motivo obligatorio; el barbero no (403);
  - el cliente cancela una `PENDING_PAYMENT` siempre y una `CONFIRMED` hasta la hora de inicio; la devolución depende de la anticipación (Fase 8A). `booking.cancellation_deadline_minutes` se eliminó;
  - la barbería cancela hasta la hora de inicio;
  - se guarda quién canceló (`cancelled_by`) y con qué rol (columna `cancelled_by_role`: `CLIENT`, `BARBERSHOP` o `SYSTEM`; un `CHECK` exige que exista si y solo si la reserva está `CANCELLED`);
  - la respuesta incluye la devolución aplicada; `GET /bookings/{id}/cancellation-preview` la muestra antes de confirmar.
- **Consultar:**
  - `GET /me/bookings`, `GET /me/barber/bookings` y `GET /barbershops/{id}/bookings`, con `scope=upcoming|history` y cursor;
  - `GET /bookings/{id}`;
  - el barbero y el responsable ven solo el **nombre** del cliente (ni teléfono, ni correo, ni documento);
  - quien no tiene relación con la reserva recibe 404.

#### Pagos y reembolsos (Fase 8A)

- **Devolución al cancelar** (`refund-policy.ts`, función pura que usan la vista previa y la cancelación):
  - la barbería cancela: total, siempre, con motivo obligatorio;
  - el cliente cancela con `refunds.full_min_minutes` (300) o más de anticipación: total;
  - con `refunds.partial_min_minutes` (120) o más: `refunds.partial_percent` (50 %), redondeado hacia abajo al céntimo;
  - con menos: sin devolución, pero puede cancelar hasta la hora de inicio;
  - la anticipación se mide desde la cancelación hasta `start_at`, con límites inclusivos;
  - pago huérfano: devolución total automática.
- **Reembolsos:**
  - en la transacción de la cancelación se crea el `refund` `PENDING`, con `idempotency_key` única y `reason_type` (`CLIENT_CANCELLATION`, `BARBERSHOP_CANCELLATION`, `ORPHANED_PAYMENT` o `MANUAL`), y se publica `refund.requested`;
  - el consumidor del outbox (`RefundExecutor`, idempotente) llama a `PaymentGateway.refund` fuera de la transacción; si la pasarela falla, el outbox reintenta;
  - el webhook o la conciliación aplican el resultado (`applyRefundResult`); el pago pasa a `PARTIALLY_REFUNDED` o `REFUNDED`;
  - un trigger impide que los reembolsos no fallidos de un pago superen su importe;
  - el reembolso manual (`requestManualRefund`) queda auditado.
- **Webhooks (`POST /payments/webhooks/{provider}`, público):**
  - **Límite que no depende solo de la IP** (el proveedor envía desde pocas direcciones); la ruta omite el límite global por IP:
    - avisos con firma válida: cupo por proveedor, `payments.webhook_rate_limit_per_minute` (600/min);
    - avisos con firma inválida: 30/min por IP, sin consumir el cupo del proveedor.
  1. firma verificada sobre el cuerpo **exacto** (`req.rawBody`, solo en las rutas de webhooks y de verificación), con comparación en tiempo constante; si es inválida, 401 sin efectos;
  2. ventana de antigüedad **opcional por proveedor** (`webhookMaxAgeSeconds`; Izipay no envía marca de tiempo, así que ahí la protección es la idempotencia);
  3. coherencia: pago existente, importe, moneda y modo (en producción nunca `TEST`); si no coincide, 409 auditado;
  4. en una transacción, registro en `payment_events` (único por proveedor y evento) y aplicación. Un evento repetido responde 200 `duplicate: true`.
- **Respuesta que reenvía la app** (`POST /bookings/{id}/payment/verify`): se verifica la firma, pero solo dispara la consulta al proveedor. Nunca confirma por sí sola.
- **Conciliación (`ReconciliationService`):**
  - la revisión rápida solo toma pagos iniciados cuya reserva sigue pendiente (los abandonados no acaparan el lote); la diaria recorre todo por páginas (hasta 2000);
  - corrección y auditoría van en la misma transacción: dos ejecuciones simultáneas corrigen y auditan una sola vez;
  - corrige solo los casos inequívocos (pagado o reembolsado en la pasarela y `PENDING` en Charles), siempre mediante `applyPaymentResult` o `applyRefundResult`;
  - los casos ambiguos (rechazado, importe distinto, reembolso fallido) solo se registran;
  - todo queda en `audit_log`;
  - corre cada `payments.pending_check_interval_minutes` (2) sobre los pagos iniciados (`payments.started_at`) y a diario a las 04:00 de Lima sobre todo lo pendiente antiguo, incluidos los reembolsos nunca enviados.
- **Antes de vencer** una `PENDING_PAYMENT` con el pago iniciado (en el trabajo de vencimiento y al crear otra reserva sobre el turno), se consulta la pasarela fuera de la transacción: si estaba pagada, se confirma; si no responde, se vence y un pago posterior queda huérfano y se devuelve.
- **Consulta:** `GET /bookings/{id}/payment` muestra el pago y sus reembolsos (solo el cliente).
- **Comisión:** cada reserva lleva una línea `FEE` "Comisión de Charles" en 0 (`CHARLES_FEE_AMOUNT`).
- **Cancelaciones de la barbería (sanción):**
  - toda cancelación de la barbería, pagada o no, crea una fila en `barbershop_cancellation_reviews` (`PENDING_REVIEW`) en la misma transacción;
  - `CancellationReviewsService.review` (solo `SUPPORT`; la pantalla es de la Fase 12) la califica `JUSTIFIED` o `UNJUSTIFIED`, una sola vez;
  - con `barbershops.unjustified_cancellations_limit` (3) injustificadas en `barbershops.unjustified_cancellations_window_days` (30), contadas por fecha de cancelación, la barbería pasa a `SUSPENDED` en la misma transacción, con auditoría y evento;
  - las reservas futuras de una barbería suspendida se dejan como están (Fase 12).

#### Atención e inasistencias (Fase 9, RF-ATE-001…003)

- **Marcar atendida (`POST /bookings/{id}/attended`):** el barbero asignado o la barbería (OWNER o MANAGER), sobre una reserva `CONFIRMED`, desde la hora de inicio y hasta `booking.attendance_auto_close_hours` (24) después, con límites inclusivos. No hay devolución.
- **No-show:** el de la Fase 8A (ver abajo), sin cambios; la agenda y la corrección lo integran.
- **Cierre automático:** un trabajo cada hora (cola `bookings`, `FOR UPDATE SKIP LOCKED`, idempotente) pasa a `ATTENDED` las `CONFIRMED` cuyo inicio + 24 h ya pasó, con el sistema como actor y el motivo `auto_close` en el historial.
  - **Valoraciones:** el cliente podrá valorar.
  - **Pagos:** no cambia nada; en `ATTENDED` y en `NO_SHOW` no hay devolución.
- **Corrección `ATTENDED` ↔ `NO_SHOW` (`POST /bookings/{id}/attendance-correction` con `{ status, reason }`):**
  - solo OWNER o MANAGER (el barbero no), con motivo obligatorio, hasta `booking.attendance_correction_hours` (48) después del inicio; el cierre automático también se corrige;
  - va en una tabla aparte de la máquina de estados (`ATTENDANCE_CORRECTIONS`, método `correct()`), así las transiciones normales nunca deshacen un estado final;
  - queda en el historial (`correction: <motivo>`), en `audit_log` y en el evento `booking.attendance_corrected`;
  - pasado el plazo, solo soporte (Fase 12);
  - si se corrige a `NO_SHOW` y había valoración, la valoración se oculta, y se reactiva si se vuelve a `ATTENDED` (Fase 11);
  - sin efecto en pagos.
- **Agenda del día (RF-ATE-001):** `GET /me/barber/agenda?date=` (perfil activo del barbero) y `GET /barbershops/{id}/agenda?date=&barberId=` (OWNER o MANAGER).
  - Usa el día local de la barbería, por defecto hoy.
  - Incluye las reservas `CONFIRMED`, `ATTENDED` y `NO_SHOW`, y las `PENDING_PAYMENT` vigentes (`awaitingPayment`); nunca las canceladas.
  - Incluye los bloqueos del día y el contador `pendingAttention` (las `CONFIRMED` que ya empezaron y siguen sin marcar).
  - Por reserva, las acciones permitidas ahora: `canMarkAttended`, `canMarkNoShow` y `canCorrect` (este último solo para el responsable).
  - Del cliente, solo el nombre.

- **No-show (`POST /bookings/{id}/no-show`):** lo marca el barbero asignado o la barbería, sobre una reserva `CONFIRMED`, desde `booking.no_show_after_minutes` (15) y hasta `booking.no_show_window_hours` (24) después del inicio. No hay devolución. Marcar asistencia es de la Fase 9.
- **Compatibilidad con Izipay:**
  - la interfaz `PaymentGateway` no asume errores HTTP (`PaymentGatewayError`);
  - `parseWebhook` y `verifyClientResult` reciben el cuerpo sin procesar;
  - el evento normalizado trae importe, moneda, modo e ID de transacción;
  - referencia técnica en `docs/izipay/referencia.md`.

### Favoritos y valoraciones (Fase 11)

- **`isFavorite`:** `GET /barbershops/{id}` y `GET /search/barbershops` son públicos con sesión opcional (el guard adjunta la cuenta si el token es válido, no está revocado ni es restringido; si no, sigue anónimo sin error). Una sola consulta de favoritos por página (`FavoritesService.favoriteIds`); sin sesión, `false`.
- **Favoritos (RF-FAV-001…003):** `PUT` y `DELETE /me/favorites/{barbershopId}` (idempotentes) y `GET /me/favorites` (por cursor, los más recientes primero).
  - Solo se marca una barbería visible públicamente.
  - Una barbería suspendida, pendiente de revisión o eliminada desaparece de la lista sin borrar el favorito: vuelve si se reactiva.
- **Valorar (RF-VAL-001):** `POST /bookings/{id}/review` con `{ rating, comment? }`.
  - Solo el cliente, sobre su reserva `ATTENDED`, una vez, dentro de `reviews.window_days` (14) desde la primera vez que quedó `ATTENDED` (incluido el cierre automático).
  - `rating` entero 1–5; comentario opcional de 3 a 500 caracteres, texto plano (se recortan los espacios, no se interpreta HTML).
  - Se bloquea la reserva: dos valoraciones simultáneas de la misma reserva, una sola gana (y además `booking_id` es único).
  - `PATCH /reviews/{id}`: **una sola edición**, en el mismo plazo, sin cambiar la fecha original (`edited_at`).
  - `DELETE /reviews/{id}`: retirarla en cualquier momento (borrado lógico); no se puede volver a valorar esa reserva.
- **Público (RF-VAL-002):** `GET /barbershops/{id}/reviews?barberId=&rating=` (por cursor, las más recientes primero). Autor como "Ana R." (nombre e inicial del apellido); nunca el contacto. Se muestran `VISIBLE` y `UNDER_REVIEW`; nunca `HIDDEN`.
- **Respuesta de la barbería:** `PUT /reviews/{id}/response` (OWNER o MANAGER; el barbero no). Una por valoración, editable, hasta 500 caracteres, auditada. Editarla no cambia la visibilidad decidida por soporte.
- **Reportes:** `POST /reviews/{id}/reports` con `{ target: REVIEW | RESPONSE, reason, details? }`.
  - Motivos: `OFFENSIVE`, `PERSONAL_DATA`, `FAKE`, `SPAM`, `OTHER`. Uno por usuario y objetivo.
  - Nadie reporta lo propio: el autor no reporta su valoración ni la barbería su respuesta.
  - Con `reviews.report_threshold` (3) reportes abiertos, el objetivo pasa a `UNDER_REVIEW`, **sigue visible** y queda en la cola de soporte.
  - Límite propio por cuenta para valoraciones y reportes: `reviews.rate_limit_per_minute` (10).
- **Moderación:** solo `ReviewModerationService` cambia la visibilidad (soporte la usa en la Fase 12): `KEEP` (vuelve a `VISIBLE`), `HIDE` y `RESTORE`, para la valoración o para la respuesta por separado; resuelve los reportes abiertos y queda auditada.
- **Corrección de asistencia:** consumidor idempotente de `booking.attendance_corrected` que lee el estado actual de la reserva:
  - a `NO_SHOW` oculta la valoración (`hidden_reason = attendance_corrected`);
  - de vuelta a `ATTENDED` la restaura solo si la ocultó esa corrección, nunca si la ocultó soporte.
- **Promedios (RF-VAL-003):** `barbershops` y `barbers` (`rating_avg`, `rating_count`).
  - Se recalculan con una consulta agregada sobre las visibles (`UNDER_REVIEW` cuenta) en la misma transacción que el cambio; nunca con sumas incrementales.
  - Se bloquea la barbería y luego el barbero con `FOR NO KEY UPDATE` (no `FOR UPDATE`: chocaría con el `FOR KEY SHARE` de las claves foráneas y daría interbloqueos).
  - Una verificación nocturna (03:30 de Lima) corrige descuadres y los audita (`rating.corrected`).

### Soporte y operación (Fase 12)

- **Roles:** `ADMIN` se suma a `SUPPORT`. `/api/v1/admin` exige SUPPORT o ADMIN (`@SupportOrAdmin()`); roles, ajustes, categorías y reembolso manual, solo ADMIN (`@AdminOnly()`). `AdminAccessGuard` **relee de la base** roles y estado en cada petición (no confía en el JWT).
  - Primer ADMIN: `pnpm --filter api admin:grant <correo> [--role admin|support]` en el servidor, auditado sin actor; nunca un endpoint.
  - Nadie se quita a sí mismo un rol; nunca quedan cero ADMIN activos (`LAST_ADMIN`, serializado con un bloqueo).
- **Conflicto de interés:** soporte y ADMIN nunca actúan sobre su propia cuenta, sobre una barbería de la que son miembros, ni sobre reservas, pagos, valoraciones o tickets que los involucran (403 `CONFLICT_OF_INTEREST`).
- **Motivo y auditoría:** toda acción sensible lleva `reason` y queda en `audit_log` con el actor y su rol (`actorRole`).
- **Tickets (RF-SOP):** cola común (`GET /admin/tickets`), tomar o reasignar, respuesta o nota interna (`isInternal`), estados `OPEN → IN_PROGRESS → RESOLVED → CLOSED`; cerrar sin resolver exige motivo.
  - El usuario reabre un `RESOLVED` respondiendo dentro de `support.ticket_reopen_days` (7); se cierran solos tras `support.ticket_auto_close_days` (7). Máximo `support.max_open_tickets_per_user` (5) abiertos.
  - Mensajes cifrados (`TICKET_MESSAGE_BODY`); el usuario nunca ve notas internas ni quién respondió.
  - Cuenta deshabilitada: `POST /auth/support-access` da un token restringido (`scp: support`, sin renovación) válido solo en los endpoints con `@AllowRestrictedSession()` (sus tickets).
- **Cuentas:** datos mínimos; contacto en `POST /admin/users/{id}/contact` con motivo, sin caché y auditado. Deshabilitar revoca las sesiones al instante, mantiene sus reservas, marca para revisión (`flagged_reason = owner_disabled`) las barberías donde era el único OWNER y publica `user.disabled`. Soporte no deshabilita cuentas de soporte ni ADMIN.
- **Barberías:** aprobar (`PENDING_REVIEW → OPEN`), reactivar y resolver reportes (los usuarios reportan con `POST /barbershops/{id}/reports`, motivo cerrado, uno por cuenta).
  - Suspender: por defecto `KEEP_UPCOMING` (se mantienen las de las próximas `support.suspension_keep_hours`, 48 h, y se cancelan las demás), o `CANCEL_ALL` / `KEEP_ALL`. Las pendientes de pago se cancelan siempre. Cancelación con rol `SUPPORT` y devolución total (`SUPPORT_CANCELLATION`), sin revisión de cancelación de la barbería; todo en una transacción, con `barbershop.suspended` y `booking.cancelled` en el outbox (los avisos llegan con la Fase 10).
- **Reservas y pagos:** vista mínima, corrección de asistencia sin plazo, reembolso manual (solo ADMIN, con motivo, hasta lo cobrado y no devuelto: `REFUND_EXCEEDS_PAID`, con el pago bloqueado), calificación de cancelaciones de la barbería y moderación de valoraciones (`ReviewModerationService`).
- **Ajustes:** `PUT /admin/settings/{key}` con esquema y rango por clave (`SETTING_RULES`), reglas cruzadas (p. ej. devolución parcial ≤ total) y valor anterior y nuevo en `audit_log`. Seguridad, pagos sensibles y decisiones pendientes: solo lectura (`SETTING_READ_ONLY`). Una prueba exige que toda clave sembrada tenga regla.
- **Categorías:** crear, editar y desactivar (nunca borrar).

### Notificaciones (Fase 10)

- **Canales:** push por Expo Push Service (`PushSender`: `ExpoPushSender` en producción, `FakePushSender` en desarrollo y pruebas; `PUSH_DRIVER=fake` prohibido en producción), correo (`Mailer`, hoy `FakeMailer`) y bandeja en la app.
- **Flujo:** un consumidor idempotente del outbox (`booking.*`, `refund.*`, `review.created`, `ticket.replied`, `user.disabled`, `barbershop.suspended`) planifica los avisos con un catálogo puro (`notification-catalog.ts`) y los guarda en `notifications`, uno por persona y canal (`dedupe_key` única). La entrega corre aparte, **fuera de toda transacción**: reclama un lote (`FOR UPDATE SKIP LOCKED`), llama al proveedor y registra `SENT`, `SKIPPED` o `FAILED`; reintenta con espera creciente hasta 5 intentos.
- **Contenido:** el push nunca lleva montos, nombres ni motivos; la bandeja y el correo dan el detalle. Todo aviso lleva `resource` (tipo e ID) para navegar. Solo español, con plantillas en el backend.
- **Preferencias:** por canal (`preferences.notificationChannels`) y `preferences.reminders`. Seguridad y pagos se envían siempre. Una cuenta deshabilitada solo recibe el aviso de su deshabilitación.
- **Horario silencioso:** `notifications.quiet_start` y `quiet_end` (22:00–08:00, zona de la barbería). Los push no urgentes esperan a su fin; los urgentes (citas de las próximas 24 h, pago rechazado) no.
- **Recordatorios:** `notifications.reminder_hours` ([24, 2]). Si caen en el horario silencioso, se adelantan al último minuto permitido. Nunca de una reserva cancelada o que ya empezó (se vuelve a comprobar al entregar), ni si su momento ya había pasado al confirmarse.
- **Dispositivos:** `PUT /me/devices` con el token en el cuerpo (cifrado, índice ciego, `pushToken` redactado en logs) y `DELETE /me/devices/{id}`. Ligado a la sesión: `SessionsService` lo borra al revocarla. Máximo `notifications.max_devices_per_user` (10). Los tokens que Expo marca `DeviceNotRegistered` (en el envío o en los recibos) se borran.
- **Bandeja:** `GET /me/notifications`, contador de no leídos, marcar leído uno o todos; se conservan `notifications.retention_days` (90).
- **Soporte:** `GET /admin/refunds/failed` lista los reembolsos fallidos.

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
- La búsqueda (Fase 6) usa el cálculo por lotes: `availableNowBatch`, `availableOnDateBatch` y `openNowBatch`.
- La función central debe ser **pura** (recibe datos, devuelve turnos) para probarla sin base de datos: `computeSlots` en `modules/availability/engine/`, con "ahora" como parámetro. El servicio obtiene la hora de un reloj inyectable (`CLOCK`).
- Zonas horarias con `luxon` (IANA): los horarios semanales (hora local) se convierten a UTC **para cada fecha**; el día local es [00:00, 24:00) en la zona de la barbería (23 o 25 h en días de cambio de hora); una hora local inexistente se omite de la cuadrícula y una repetida aparece una vez; la duración de un turno es tiempo real.
- Además de los casos fijos, hay **pruebas basadas en propiedades** (fast-check) con horarios, bloqueos, reservas, duraciones y zonas generados al azar; invariantes: ningún turno se solapa con reservas o bloqueos, todo turno cabe en el horario efectivo, ninguno empieza antes de now + anticipación, todo inicio está en la cuadrícula, salida ordenada y sin duplicados, y determinismo.
- **Requisito para la Fase 7:** una reserva `PENDING_PAYMENT` vencida (`expires_at` pasado) **no bloquea en el cálculo**, pero **sí en la restricción de exclusión** (§7.3) hasta que se marque `EXPIRED`. Al crear una reserva hay que expirar, **dentro de la misma transacción**, las `PENDING_PAYMENT` vencidas que solapen con el nuevo turno; si no, la inserción fallaría con `SLOT_NOT_AVAILABLE` aunque el turno se haya mostrado como libre.
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

- Unitarias para toda la lógica de negocio. Cobertura mínima 80 % en `availability`, `bookings`, `payments`, `reviews`, `admin`, `support` y `notifications`. En `availability` se mide con `pnpm --filter api test:cov:availability` (unitarias del motor + e2e) en `search` con `pnpm --filter api test:cov:search` y en `bookings` + `payments` + `moderation` con `pnpm --filter api test:cov:bookings`, en `reviews` con `pnpm --filter api test:cov:reviews` en `admin` + `support` con `pnpm --filter api test:cov:admin` y en `notifications` con `pnpm --filter api test:cov:notifications`; CI y `pnpm verify` fallan si alguna baja del 80 %.
- e2e por cada RF de prioridad Alta, contra PostgreSQL real en Docker (no simular la base de datos).
- **Prueba de concurrencia obligatoria** (RF-RES-007): dos peticiones simultáneas por el mismo turno → exactamente una tiene éxito. Está en `test/bookings/bookings.e2e-spec.ts`: 10 rondas por API, más las variantes de "cualquier barbero" y de la misma clave de idempotencia.
- Pruebas de autorización: por cada endpoint privado, un caso que verifique que otro usuario **no** puede acceder.
- Pruebas de webhook: firma inválida rechazada y evento duplicado procesado una sola vez.

---

## 12. Fases de construcción

| Fase | Entregable                                                                                                                                                                                                                                                                                                  | RF                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Monorepo, NestJS, Docker Compose, Prisma, configuración validada, Swagger, logs, manejo de errores, `helmet`, CORS, límite de peticiones, CI                                                                                                                                                                | —                                              |
| 2    | Esquema completo, migraciones (incluida la sección 7.3), `EncryptionService` con pruebas, datos de prueba                                                                                                                                                                                                   | —                                              |
| 3    | Registro, inicio y cierre de sesión, recuperación, roles, perfil                                                                                                                                                                                                                                            | RF-AUT-001…004, RF-CLI-001…002                 |
| 4    | Barberías, miembros, barberos, servicios                                                                                                                                                                                                                                                                    | RF-BAR-001…004, RF-BRB-001…002, RF-SER-001…003 |
| 5    | Horarios, bloqueos y motor de disponibilidad                                                                                                                                                                                                                                                                | RF-DIS-001…004, RF-BRB-003                     |
| 6    | Búsqueda, cercanía, filtros, alternativas                                                                                                                                                                                                                                                                   | RF-BUS-001…004                                 |
| 7    | Reservas, máquina de estados, outbox, expiración, historial                                                                                                                                                                                                                                                 | RF-RES-001…008                                 |
| 8    | Pagos con `FakeGateway`, webhooks, reembolsos; luego pasarela real                                                                                                                                                                                                                                          | RF-PAG-001…004                                 |
| 9    | Atención e inasistencias                                                                                                                                                                                                                                                                                    | RF-ATE-001…003                                 |
| 10   | Notificaciones y recordatorios                                                                                                                                                                                                                                                                              | RF-NOT-001…004                                 |
| 11   | Favoritos y valoraciones                                                                                                                                                                                                                                                                                    | RF-FAV-001…003, RF-VAL-001…003                 |
| 12   | Soporte y operación de la plataforma                                                                                                                                                                                                                                                                        | RF-SOP-001…003, RF-OPE-001…003                 |
| 13   | Promociones, cupones, auspiciadores y destacados. Campañas con público (clientes, barberías o ambos), espacios también en las pantallas de la barbería y catálogo de productos por auspiciador con enlace externo (Charles no vende ni cobra productos)                                                     | (crecimiento)                                  |
| 14   | Galería y perfiles: imágenes detrás de `ImageStorage` (logo, portada, foto del barbero, galería por barbero con categoría obligatoria y hasta 3 estilos), consulta pública filtrable y reserva desde la foto, perfil del barbero ampliado, consentimiento, reportes y moderación. **Antes de la app móvil** | (crecimiento)                                  |
| 15   | Planes de suscripción para barberías como datos, beneficios como derechos (`EntitlementsService`), comisión por plan y cobro recurrente sobre `PaymentGateway`                                                                                                                                              | (crecimiento)                                  |
| 16   | Membresías para clientes con créditos periódicos (solo si el plan de la barbería lo incluye)                                                                                                                                                                                                                | (crecimiento)                                  |

La fase 8 con pasarela real y la fase 13 requieren que las decisiones de la sección 4.2 estén cerradas. Las fases 13 a 16 siguen el diseño previsto en [ADR 0004](docs/adr/0004-fases-de-crecimiento.md) (no implementado) y sus decisiones abiertas están en `docs/pendientes-produccion.md`.

### Una fase está terminada cuando

- Todos los RF de la fase tienen pruebas e2e que pasan.
- `lint`, `typecheck` y `test` pasan sin advertencias.
- Los endpoints nuevos aparecen en Swagger.
- Se revisó la lista de la sección 6 para el código nuevo.
- No hay secretos ni datos personales en el código, los logs o las pruebas.
