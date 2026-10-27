# Despliegue en producción

Guía para publicar Charles (API + panel web) en **un solo servidor** con Docker Compose. Todo corre en contenedores: PostgreSQL con PostGIS, Redis, la API, el panel, Caddy (HTTPS automático) y un respaldo diario de la base.

```
Internet ──443──▶ Caddy ──▶ api:3000   (API_DOMAIN: app móvil, webhooks de pagos)
                        └─▶ web:3001   (PANEL_DOMAIN: panel; reenvía /api/* a la API)
                api ──▶ postgres:5432, redis:6379   (red privada de Docker, sin puertos expuestos)
                backup ──▶ pg_dump diario a ./backups
```

## 1. Requisitos

- Un servidor Linux con Docker y el plugin Compose (2 vCPU y 4 GB de RAM alcanzan para el piloto).
- Dos subdominios apuntando (registro DNS `A`) a la IP del servidor, p. ej. `api.ejemplo.pe` y `panel.ejemplo.pe`. Ambos deben compartir el dominio padre (`COOKIE_DOMAIN`).
- Puertos 80 y 443 abiertos.
- Cuentas externas: Resend (correo, dominio verificado), Expo (push), un almacenamiento S3 compatible (recomendado Cloudflare R2) y la pasarela de pagos (Mercado Pago o Izipay) con credenciales de **producción**.

## 2. Código

Los dos repositorios deben quedar uno al lado del otro, porque el Compose construye el panel desde `../charlesweb`:

```bash
git clone https://github.com/EliasDemo/charles.git
git clone https://github.com/EliasDemo/charlesweb.git
cd charles
```

## 3. Variables de entorno

```bash
cp docker/.env.production.example .env.production
chmod 600 .env.production
```

Completa cada valor. Las claves se generan en el servidor y **nunca** se suben al repositorio:

| Variable                              | Cómo obtenerla                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -base64 32`                                                            |
| `FIELD_ENCRYPTION_KEYS`               | `1:` + `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BLIND_INDEX_KEY`                     | Igual que la anterior, pero otra clave distinta                                      |
| `JWT_PRIVATE_KEY`                     | `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \| base64 -w0`       |
| `RESEND_API_KEY`, `MAIL_FROM`         | Panel de Resend, con el dominio del remitente verificado                             |
| `EXPO_ACCESS_TOKEN`                   | Panel de Expo → Access tokens                                                        |
| `S3_*`, `MEDIA_PUBLIC_BASE_URL`       | Ver «Guía: Cloudflare R2» en `docs/pendientes-produccion.md`                         |
| Pagos                                 | `docs/pagos-izipay.md` y `docs/mercadopago/`                                         |

> **Guarda una copia segura** de `FIELD_ENCRYPTION_KEYS` y `BLIND_INDEX_KEY`. Sin ellas, los datos cifrados de la base no se pueden leer, ni siquiera desde un respaldo.

La API valida todo al arrancar y **se niega a iniciar** si algo es inseguro (correo o pagos simulados, orígenes sin https, credenciales de prueba, etc.). El mensaje indica qué variable corregir.

`PRIVATE_NETWORK=true` permite que la API hable sin TLS **solo** con hosts internos de Docker (`postgres`, `redis`); cualquier host externo sigue exigiendo TLS.

## 4. Arranque

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml logs -f api
```

Al iniciar, la API aplica las migraciones pendientes (`prisma migrate deploy`). Caddy obtiene los certificados HTTPS en el primer acceso.

Comprobación: `https://api.ejemplo.pe/api/v1/health` responde `200` y el panel abre en `https://panel.ejemplo.pe`.

## 5. Primer administrador

El servidor arranca sin usuarios de prueba (la semilla de demostración nunca se ejecuta en producción). Registra la cuenta desde la app, verifica el correo y luego, en el servidor:

```bash
docker compose -f docker-compose.prod.yml exec api pnpm admin:grant correo@ejemplo.pe            # ADMIN
docker compose -f docker-compose.prod.yml exec api pnpm admin:grant correo@ejemplo.pe --role support
```

El cambio queda auditado. El panel exige activar la verificación en dos pasos en el primer ingreso.

## 6. Actualizar

```bash
git -C ../charlesweb pull && git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Las migraciones nuevas se aplican solas al reiniciar la API.

## 7. Respaldos y restauración

El servicio `backup` guarda un `pg_dump` diario en `./backups` (o `BACKUP_DIR`) y borra los de más de `BACKUP_KEEP_DAYS` días. **Copia esa carpeta fuera del servidor** (otro disco, R2, etc.).

Restaurar un respaldo (detén antes la API):

```bash
docker compose -f docker-compose.prod.yml stop api
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U charles -d charles --clean --if-exists < backups/charles-AAAA-MM-DDTHHMMSSZ.dump
docker compose -f docker-compose.prod.yml start api
```

## 8. Monitoreo

- Panel → **Salud del sistema**: base, Redis, colas de trabajo (trabajos fallidos en las últimas 24 h) y latencias.
- Panel → **Auditoría**: cambios hechos por el personal, exportables a CSV.
- Registros: `docker compose -f docker-compose.prod.yml logs --since 1h api`.
