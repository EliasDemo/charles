# Estado del proyecto Charles

Punto de partida para retomar el trabajo en una conversación nueva. **Léelo antes de hacer nada**, junto con `CLAUDE.md` y `docs/pendientes-produccion.md`. Se actualiza al cerrar cada fase (CLAUDE.md §1).

Última actualización: tras cerrar la Fase 8A y aprobar el plan de la Fase 9 (sin implementar).

## Resumen

|                           |                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Fase cerrada más reciente | **8A** (pagos independientes del proveedor)                                        |
| En espera                 | **8B** (adaptador de Izipay): falta documentación de Izipay que enviará el usuario |
| Siguiente a implementar   | **9** (atención e inasistencias): plan **aprobado**, sin implementar               |
| Pruebas al cierre         | 360 unitarias y 386 e2e, todas en verde; `pnpm verify` pasa                        |
| Repositorio               | solo commits locales: **sin remoto y sin push** hasta que el usuario lo indique    |

## Fases cerradas y sus commits

| Fase | Contenido                                                                                 | Commits                                                                                        |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | Base del monorepo y API NestJS, CI, seguridad base                                        | `c67c951`, `6371135`                                                                           |
| 2    | Esquema completo, `EncryptionService`, datos de prueba                                    | `97ecf93`                                                                                      |
| 3    | Autenticación, sesiones, recuperación, perfil                                             | `f7f52f4`, `21a3e95`                                                                           |
| 4    | Barberías, responsables, barberos, servicios; barbero independiente                       | `4918a4a`, `121ad72`, `1e7d43a`                                                                |
| 5    | Horarios, bloqueos y motor de disponibilidad                                              | `009c79c`                                                                                      |
| 6    | Búsqueda, cercanía, filtros, alternativas; categorías de servicio                         | `55d90a9`; `255c732` (cobertura propia de availability y `pnpm verify`)                        |
| 7    | Reservas, máquina de estados, outbox, expiración                                          | `329c5eb`, `aa2a171` (columna `cancelled_by_role`, arranque sin `NODE_ENV=test`)               |
| 8A   | Pagos con `FakeGateway`: webhooks, reembolsos, conciliación, no-show, sanción a barberías | `29182fc`, `044e34b`, `eeda3dd` (contención y bloqueo ordenado), `9d19023` (regla 10 ampliada) |

## Fase en curso

### 8B — Adaptador de Izipay (en espera)

- **Bloqueada** hasta que el usuario pase las páginas de documentación que faltan: claves, IPN, reembolso y consulta.
- **Ya preparado:** la interfaz `PaymentGateway` es compatible con Izipay; la referencia técnica está en `docs/izipay/referencia.md` y el resumen en `docs/pagos-izipay.md`.
- **Al recibir la documentación:** presentar el plan de la 8B y esperar aprobación.
- **Credenciales:** las pone el usuario en `apps/api/.env`. Nunca se escriben en el repositorio.
- **Variables previstas:** `IZIPAY_MODE`, `IZIPAY_SHOP_ID`, `IZIPAY_PASSWORD`, `IZIPAY_PUBLIC_KEY`, `IZIPAY_HMAC_SHA256_KEY` y `IZIPAY_API_SERVER_NAME`. La app no arranca en producción con credenciales de test.

### 9 — Atención e inasistencias (RF-ATE-001…003): plan aprobado, no implementado

Aprobado con todas las recomendaciones (preguntas 1 a 6), incluidas la migración y los ajustes:

1. **Marcar `ATTENDED`:** el barbero asignado o el responsable (OWNER o MANAGER).
2. **Ventana:** desde la hora de inicio y hasta 24 h después del inicio, la misma que el no-show. No se puede marcar antes del inicio.
3. **Cierre automático:** las `CONFIRMED` sin marcar pasan a `ATTENDED` al terminar la ventana.
   - Lo hace un trabajo cada hora, con el sistema como actor y el motivo `auto_close`; ajuste `booking.attendance_auto_close_hours` (**24**).
   - Consecuencias: el cliente podrá valorar; en pagos no cambia nada (en `ATTENDED` y en `NO_SHOW` no hay devolución).
4. **Corrección `ATTENDED` ↔ `NO_SHOW`:**
   - solo OWNER o MANAGER, con motivo obligatorio, hasta 48 h después del inicio (`booking.attendance_correction_hours` = **48**);
   - el cierre automático también se puede corregir; pasado el plazo, solo soporte (Fase 12);
   - siempre con historial, auditoría y el evento `booking.attendance_corrected`;
   - si se corrige a `NO_SHOW` y había valoración, la valoración se oculta y se reactiva si se vuelve a `ATTENDED` (se implementa en la Fase 11);
   - sin efecto en pagos.
5. **Agenda del día:**
   - muestra las reservas `CONFIRMED`, `ATTENDED` y `NO_SHOW`, y las `PENDING_PAYMENT` vigentes marcadas "por confirmar"; las canceladas no;
   - incluye los bloqueos del día;
   - usa el día local de la barbería, por defecto hoy.
6. **Datos del cliente en la agenda:** solo el nombre.

**Plan técnico aprobado:**

- **Máquina de estados:** transición `CONFIRMED → ATTENDED`. Las correcciones van en una tabla aparte y un método `correct()`, no en las transiciones normales.
- **Endpoints:**
  - `POST /bookings/{id}/attended`;
  - `POST /bookings/{id}/attendance-correction` con `{ status, reason }`;
  - `GET /me/barber/agenda?date=` y `GET /barbershops/{id}/agenda?date=&barberId=`.

  La agenda devuelve las acciones permitidas (`canMarkAttended`, `canMarkNoShow`, `canCorrect`) y los pendientes de atención (RF-ATE-001).

- **No-show:** ya existe desde la 8A (`POST /bookings/{id}/no-show`); solo se integra en la agenda y en la corrección.
- **Trabajo de cierre automático:** cada hora, con `FOR UPDATE SKIP LOCKED`, idempotente.
- **Migración autorizada:** índice parcial de las `CONFIRMED` por `start_at`.
- **Inserción autorizada en `charles`:** `booking.attendance_auto_close_hours` (24) y `booking.attendance_correction_hours` (48).
- **Pruebas:** permisos, límites de ventana, cierre automático e idempotencia, corrección dentro y fuera de plazo, agenda por rol y día local, privacidad, concurrencia entre `ATTENDED` y `NO_SHOW`. Cobertura de `bookings` de 80 % o más.

## Decisiones tomadas que no están en CLAUDE.md

Casi todas las decisiones de negocio ya están en `CLAUDE.md` (§4.1, §8 y "Pagos y reembolsos (Fase 8A)"). Además:

- **Fase 9:** las decisiones de arriba, pendientes de implementar.
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

- **Pasos:** lint, typecheck, formato, unitarias, e2e, coberturas mínimas (`availability`, `search`, `bookings` + `payments` + `moderation`), OpenAPI y tipos de `packages/shared` al día, y `pnpm audit --audit-level=high`.
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
