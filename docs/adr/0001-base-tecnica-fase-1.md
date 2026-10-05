# ADR 0001 — Base técnica (Fase 1)

- **Estado:** aceptada
- **Fecha:** 2026-10-05

## Contexto

En la Fase 1 se fija el stack de CLAUDE.md §2 con versiones concretas. Algunas versiones "latest" del registro no son compatibles entre sí.

## Decisiones

| Tema                        | Decisión                                                                                                         | Motivo                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                     | 24 LTS (`.nvmrc`)                                                                                                | LTS vigente.                                                                                                                                                                         |
| TypeScript                  | 6.0.x (no 7.x)                                                                                                   | TS 7 aún no lo soportan `ts-jest`, `typescript-eslint` ni `@nestjs/swagger`.                                                                                                         |
| NestJS                      | 11.x (no 12.x)                                                                                                   | `@nest-lab/throttler-storage-redis` todavía no soporta Nest 12.                                                                                                                      |
| Prisma                      | 7.10 (no 8.0 RC)                                                                                                 | Última versión estable. Generador `prisma-client` en CJS, imports sin extensión (sirve igual para `dist` y Jest) y driver adapter `@prisma/adapter-pg`.                              |
| Jest                        | Se ejecuta con `--experimental-vm-modules`                                                                       | El cliente Prisma 7 carga su runtime WASM con `import()` dinámico.                                                                                                                   |
| Extensiones de PostgreSQL   | Se crean en la primera migración (`20261005000000_init_extensions`)                                              | Deben existir en todos los entornos (local, CI, producción) sin depender del script de Docker. Se comprobó que Prisma no detecta _drift_ por `spatial_ref_sys` de PostGIS.           |
| Base de pruebas             | `charles_test` (script de Docker en local; paso explícito en CI)                                                 | El script de inicialización de Docker no corre en CI.                                                                                                                                |
| IP del cliente              | `TRUST_PROXY` → `app.set('trust proxy')`; el límite de peticiones usa `req.ip`                                   | Detrás de un proxy se usa la IP real del cliente; `X-Forwarded-For` solo se acepta desde proxies de confianza. `TRUST_PROXY=true` está prohibido porque permitiría falsificar la IP. |
| Auditoría                   | `pnpm audit --audit-level=high` en CI                                                                            | Se bloquean las vulnerabilidades altas y críticas.                                                                                                                                   |
| `pnpm.overrides`            | `mysql2@3.24.5`, `deepmerge-ts@8.0.2`                                                                            | Vulnerabilidades altas transitivas del CLI de Prisma (GHSA-3f6p-5ww8-9rcr y otra en `deepmerge-ts`). Hay que revisarlas al actualizar Prisma y quitarlas cuando Prisma las incluya.  |
| HTTPS                       | En producción, una petición sin `req.secure` responde `403 HTTPS_REQUIRED`                                       | CLAUDE.md §6.1. `X-Forwarded-Proto` solo se considera si llega desde un proxy de confianza.                                                                                          |
| Configuración de producción | La app no arranca sin `sslmode=verify-full`, con Redis sin TLS, con Swagger activo o con orígenes CORS sin https | CLAUDE.md §6.1 y §6.5.                                                                                                                                                               |

## Pendiente para fases siguientes

- El guard global de autenticación (denegar por defecto) llega en la Fase 3; `@Public()` ya existe.
- Los perfiles de límite `auth`, `payments` y `search` (`@RateLimit(...)`) se aplican en sus fases.
- ~~Fijar las GitHub Actions por SHA~~: hecho (checkout v5.1.0, pnpm/action-setup v4.4.0, setup-node v5.0.0). Existen versiones mayores nuevas (checkout v7, action-setup v6, setup-node v7); se evaluarán cuando el CI pueda ejecutarse.
