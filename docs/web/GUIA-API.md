# Guía de la API para charlesweb (administración)

Para quien construye la web de administración de Charles (`D:\barberia\charlesweb`, Next.js). El contrato completo está en [`openapi.json`](openapi.json) (se regenera con `pnpm web:openapi`); esta guía explica la sesión, la seguridad y qué endpoint alimenta cada sección.

## 1. Entorno

- API local: `http://localhost:3000/api/v1`. La web en desarrollo: `http://localhost:3001` (ya está en `CORS_ORIGINS`).
- Todas las peticiones con `credentials: 'include'` (las cookies de sesión las pone y lee la API).
- Producción prevista: la web en un subdominio como `admin.charles.pe` y la API en `api.charles.pe` (mismo sitio: `COOKIE_DOMAIN=.charles.pe`).

## 2. Sesión web (cookies `HttpOnly` y CSRF)

La web **nunca** maneja tokens: viajan en cookies que JavaScript no puede leer.

| Cookie         | Contenido                | Visible para JS | Ruta               |
| -------------- | ------------------------ | --------------- | ------------------ |
| `charles_at`   | Token de acceso (15 min) | No (`HttpOnly`) | `/api`             |
| `charles_rt`   | Token de renovación      | No (`HttpOnly`) | `/api/v1/auth/web` |
| `charles_csrf` | Token CSRF               | Sí              | `/`                |

- **CSRF por doble envío:** toda petición que cambia datos (`POST`, `PUT`, `PATCH`, `DELETE`) debe llevar la cabecera **`X-CSRF-Token`** con el valor de la cookie `charles_csrf` (o el `csrfToken` de la última respuesta de sesión). Sin ella: `403 CSRF_INVALID`.
- Los `GET` no lo necesitan.

| Paso                  | Endpoint                        | Notas                                                                                                      |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Iniciar sesión        | `POST /auth/web/login`          | `{ email, password }` → `WebSessionDto` (`user`, `mfa`, vencimientos, `csrfToken`).                        |
| Estado del 2FA        | `GET /auth/mfa`                 | `{ enabled, required, sessionVerified, recoveryCodesRemaining }`.                                          |
| Activar 2FA (1.ª vez) | `POST /auth/mfa/setup`          | `{ secret, otpauthUri }`: muestra el QR (`otpauthUri`) y el secreto.                                       |
|                       | `POST /auth/web/mfa/enable`     | `{ code }` → `{ recoveryCodes, session }`. **Mostrar los 10 códigos una sola vez** y pedir que se guarden. |
| Segundo factor        | `POST /auth/web/mfa/verify`     | `{ code }` o `{ recoveryCode }` → sesión de personal (`mfa: true`).                                        |
| Renovar               | `POST /auth/web/refresh`        | Con `X-CSRF-Token`. Antes de que venza el token de acceso (15 min).                                        |
| Cerrar sesión         | `POST /auth/web/logout`         | Revoca y borra las cookies.                                                                                |
| Códigos nuevos        | `POST /auth/mfa/recovery-codes` | `{ code }` (TOTP) → 10 códigos nuevos (invalida los anteriores).                                           |

**Flujo de entrada:**

1. `login` → si `user.roles` no incluye `SUPPORT` ni `ADMIN`, la web no es para esa cuenta.
2. `GET /auth/mfa`: si `enabled` es `false`, pantalla de activación (QR + primer código + códigos de recuperación); si es `true`, pedir el código de 6 dígitos (o "usar un código de recuperación").
3. Con `mfa: true`, ya se puede usar `/admin`. Sin el segundo factor, `/admin` responde `403 MFA_REQUIRED`.

**Duración de la sesión de personal:** 30 min sin renovar la cierran, y como máximo dura 12 h. La web debe renovar con actividad (por ejemplo, cada 10 min mientras la pestaña esté activa) y, ante `401`, volver al login.

**Errores del 2FA:** `400 INVALID_CODE` (código incorrecto o ya usado: un código vale una vez), `429 MFA_LOCKED` (5 fallos: 15 min de espera), `409 MFA_NOT_ENABLED` / `MFA_ALREADY_ENABLED`.

## 3. Secciones y endpoints

- `GET /admin/me` → `{ id, fullName, roles, role, sections }`. Arma el menú con `sections` (SUPPORT: dashboard, users, barbershops, bookings, refunds, cancellation-reviews, moderation, tickets; ADMIN además: roles, settings, catalog).
- `GET /admin/dashboard` → contadores de la portada (barberías en revisión, tickets abiertos, valoraciones y fotos reportadas, reportes de barberías, cancelaciones por revisar, reembolsos fallidos, reservas de hoy).

| Sección               | Endpoints (`/api/v1/admin/...`)                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cuentas               | `users` (búsqueda), `users/{id}`, `users/{id}/contact` (con motivo), `users/{id}/disable`, `users/{id}/enable`, `users/{id}/roles/{role}` (ADMIN), `users/{id}/mfa/reset` (ADMIN) |
| Barberías             | `barbershops` (cola por espera), `barbershops/{id}`, `approve`, `reject`, `owner-document`, `suspend`, `reactivate`, `reports/resolve`                                            |
| Reservas              | `bookings/{id}`, `bookings/{id}/attendance-correction`                                                                                                                            |
| Reembolsos            | `payments/{id}/refunds` (ADMIN), `refunds/failed`                                                                                                                                 |
| Cancelaciones         | `cancellation-reviews`, `cancellation-reviews/{id}/verdict`                                                                                                                       |
| Moderación            | `reviews/reported`, `reviews/{id}/moderation`, `images/reported`, `images/{id}/moderation`                                                                                        |
| Tickets               | `tickets`, `tickets/{id}` y sus acciones                                                                                                                                          |
| Configuración (ADMIN) | `settings`, `settings/{key}` (con rangos validados; `fees.*` es la comisión de Charles)                                                                                           |
| Catálogos (ADMIN)     | `service-categories`, `service-styles`                                                                                                                                            |

Reglas que la web debe respetar en la interfaz (la API igual las hace cumplir):

- **Motivo obligatorio** en las acciones sensibles (deshabilitar, suspender, ver contacto o documento, reembolsos, moderación): pedirlo en un diálogo.
- **Conflicto de interés:** nadie actúa sobre sí mismo ni sobre una barbería de la que es miembro (`403 CONFLICT_OF_INTEREST`).
- Todo queda en la auditoría.

## 4. Formato

Igual que la app: errores `{ code, message, details, requestId }` (mostrar `message`, decidir por `code`), paginación por cursor (`?limit=&cursor=` → `{ items, nextCursor }`), fechas ISO en UTC y dinero `{ amount, currency }` en céntimos.

## 5. Datos de prueba

`soporte.demo@example.com` (SUPPORT y ADMIN; contraseña: la de `SEED_USER_PASSWORD`). La primera vez pedirá activar el 2FA: escanea el QR con Google Authenticator. Si se pierde el teléfono en desarrollo, otro ADMIN puede reiniciarlo (`users/{id}/mfa/reset`).
