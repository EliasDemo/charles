# Imagen de producción de la API de Charles (monorepo pnpm).
# Construir desde la raíz del repositorio:  docker build -f docker/api.Dockerfile -t charles-api .

# ───────────── Compilación ─────────────
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10 --activate

# Primero solo los manifiestos: la capa de dependencias se reutiliza si el código cambia.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter api exec prisma generate && pnpm --filter api build

# ───────────── Ejecución ─────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10 --activate \
  && addgroup -S charles && adduser -S charles -G charles

# Se conservan las dependencias completas: `prisma migrate deploy` se ejecuta desde esta imagen.
COPY --from=build --chown=charles:charles /repo /repo

USER charles
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null || exit 1

# Aplica las migraciones pendientes y arranca. Si una migración falla, el contenedor no arranca.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
