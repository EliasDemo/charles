# Charles

**Charles** es una plataforma peruana para barberías. Le permite al cliente reservar su corte a una hora exacta y pagar desde el celular, y le da a la barbería un sistema para gestionar su local: agenda, caja, clientes, boletas y reportes. Nace en Juliaca (Puno) para resolver un problema concreto: el cliente llega, espera y muchas veces se va sin cortarse.

Este repositorio contiene el **backend** (API) y los tipos compartidos. La app móvil y el panel web de administración están en repositorios aparte.

| Repositorio                                           | Qué es                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| **charles** (este)                                    | API REST en NestJS, base de datos, pagos, notificaciones y tareas programadas |
| [charlesweb](https://github.com/EliasDemo/charlesweb) | Panel web de administración para el equipo de Charles (soporte y ADMIN)       |
| charlesmobile                                         | App móvil (Expo / React Native) para clientes, barberías y barberos           |

- **Manual de usuario de la app:** [docs/MANUAL-USUARIO.md](docs/MANUAL-USUARIO.md)
- **Guía técnica:** [CLAUDE.md](CLAUDE.md) · **Decisiones de arquitectura:** [docs/adr](docs/adr) · **Guías para la app:** [docs/mobile](docs/mobile)

## Qué hace

**Para el cliente**

- Busca barberías cercanas en el mapa o por distrito, con precios, fotos y valoraciones.
- Reserva con el barbero y la hora que elige, y paga con tarjeta o Yape (Mercado Pago).
- Recibe recordatorios, cancela o reprograma según la política de la barbería y valora el servicio.
- Recibe recomendaciones de cortes según la forma de su cara.
- Usa cupones, promociones y membresías (cortes prepagados).
- Participa en la Comunidad: publicaciones, comentarios, me gusta y eventos.

**Para la barbería**

- Agenda, horarios con descansos, barberos, servicios y precios.
- Panel del local: clientes y ranking (Bronce, Plata y Oro), caja, ventas sin reserva y boletas electrónicas.
- Reportes por mes, mapa de horas con más movimiento y comparación con su zona.
- Planes (Gratis, Pro y Premium), promociones, membresías para sus clientes y aparición destacada.
- Cobro directo a su cuenta de Mercado Pago, o saldo a favor con estado de cuenta.
- Bolsa de trabajo y ofertas directas a barberos.

**Para el barbero**

- Perfil profesional propio, con portafolio y ranking, que conserva aunque cambie de barbería.
- Postula a empleos y recibe ofertas directas.

**Para el equipo de Charles** (panel web)

- Revisión de barberías, moderación, tickets, reembolsos, planes, suscripciones, saldos y auspiciadores.
- Búsqueda global, métricas, salud del sistema, auditoría y gestión del personal.

## Tecnología

- **API:** NestJS 11 y TypeScript estricto, organizada en módulos por dominio.
- **Datos:** PostgreSQL 16 con PostGIS (búsquedas por cercanía) y Prisma 7; datos sensibles cifrados (AES-256-GCM) con índices ciegos.
- **Colas y tareas:** Redis y BullMQ (recordatorios, conciliación de pagos, vencimientos), con patrón outbox.
- **Pagos:** Mercado Pago (Checkout Pro, suscripciones y Marketplace) e Izipay, detrás de una interfaz común.
- **Archivos:** almacenamiento compatible con S3 (SeaweedFS en local, Cloudflare R2 en producción).
- **Calidad:** más de 1 200 pruebas unitarias y e2e contra una base real, cobertura mínima del 80 % por módulo y verificación completa antes de cada commit.

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
