# Charles

Plataforma de reservas para barberías. La guía técnica está en [CLAUDE.md](CLAUDE.md) y las decisiones de arquitectura en [docs/adr](docs/adr).

## Requisitos

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable` o `npm i -g pnpm@10`)
- Docker con Compose

## Puesta en marcha

```bash
pnpm install
docker compose up -d                     # PostgreSQL/PostGIS + Redis (solo en 127.0.0.1)
cp apps/api/.env.example apps/api/.env
cp apps/api/.env.test.example apps/api/.env.test
# Completa en apps/api/.env las claves de cifrado y SEED_USER_PASSWORD (ver comentarios del archivo)
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed
pnpm --filter api start:dev              # http://localhost:3000/api/v1/health
```

Los correos (verificación, recuperación, avisos) se simulan con `FakeMailer` hasta la Fase 10: quedan en Redis, en la lista `fake-mailer:inbox` (`docker compose exec redis redis-cli LRANGE fake-mailer:inbox 0 4`).

Swagger se publica en `http://localhost:3000/api/docs` si `SWAGGER_ENABLED=true`. En producción está prohibido.

## Comandos

| Comando                                  | Qué hace                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm lint`                              | ESLint, sin advertencias permitidas                                         |
| `pnpm typecheck`                         | TypeScript en modo estricto                                                 |
| `pnpm test`                              | Pruebas unitarias                                                           |
| `pnpm test:e2e`                          | Pruebas e2e contra PostgreSQL y Redis reales (`charles_test`, Redis base 1) |
| `pnpm format`                            | Prettier                                                                    |
| `pnpm audit --audit-level=high`          | Auditoría de dependencias (falla con severidad alta o crítica)              |
| `pnpm --filter @charles/shared generate` | Regenera `openapi.json` y los tipos de `packages/shared`                    |

La base `charles_test` se crea automáticamente la primera vez que se inicializa el volumen de Docker. Si el volumen ya existía, créala con:

```bash
docker compose exec postgres psql -U charles -c 'CREATE DATABASE charles_test'
```
