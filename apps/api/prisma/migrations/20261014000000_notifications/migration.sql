-- Fase 10: notificaciones. Tokens de dispositivo cifrados y ligados a la sesión; entrega con
-- estado, idempotencia, horario silencioso y reintentos. Ambas tablas estaban vacías.

CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- device_tokens: el token ya no se guarda en claro.
DROP INDEX "device_tokens_push_token_key";
DROP INDEX "device_tokens_user_id_idx";
ALTER TABLE "device_tokens" DROP COLUMN "push_token";
ALTER TABLE "device_tokens"
  ADD COLUMN "push_token_enc" TEXT NOT NULL,
  ADD COLUMN "push_token_hash" BYTEA NOT NULL,
  ADD COLUMN "app_version" TEXT,
  ADD COLUMN "session_id" UUID;
CREATE UNIQUE INDEX "device_tokens_push_token_hash_key" ON "device_tokens" ("push_token_hash");
CREATE INDEX "device_tokens_user_id_last_seen_at_idx" ON "device_tokens" ("user_id", "last_seen_at");
CREATE INDEX "device_tokens_session_id_idx" ON "device_tokens" ("session_id");
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_app_version_length_check"
  CHECK ("app_version" IS NULL OR char_length("app_version") <= 40);

-- notifications: entrega idempotente y con estado.
ALTER TABLE "notifications"
  ADD COLUMN "dedupe_key" TEXT NOT NULL,
  ADD COLUMN "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "send_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimed_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "provider_data" JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_channel_key"
  ON "notifications" ("user_id", "dedupe_key", "channel");
CREATE INDEX "notifications_created_at_idx" ON "notifications" ("created_at");
-- Cola de entrega (push y correo pendientes) y bandeja (en la app, las más recientes primero).
CREATE INDEX "notifications_delivery_idx" ON "notifications" ("send_after")
  WHERE "status" IN ('PENDING', 'SENDING') AND "channel" <> 'IN_APP';
CREATE INDEX "notifications_inbox_idx" ON "notifications" ("user_id", "id" DESC)
  WHERE "channel" = 'IN_APP';
