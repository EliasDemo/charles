-- Verificación en dos pasos (TOTP) del personal (SUPPORT y ADMIN) y sesiones de personal más
-- cortas: una sesión "mfa" dura como máximo 12 h (absolute_expires_at) y se cierra tras 30 min
-- sin renovarse (vencimiento del token de renovación).

CREATE TABLE "user_mfa" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  -- Secreto TOTP cifrado (EncryptionService). Sin enabled_at = activación pendiente.
  "secret_enc" TEXT NOT NULL,
  "enabled_at" TIMESTAMPTZ(3),
  -- Último paso de 30 s aceptado: el mismo código no se puede usar dos veces.
  "last_used_step" BIGINT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_mfa_user_id_key" ON "user_mfa" ("user_id");
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mfa_recovery_codes" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  -- Solo el HMAC del código (como los códigos de un solo uso).
  "code_hash" BYTEA NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes" ("code_hash");
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes" ("user_id");
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens"
  ADD COLUMN "amr" TEXT NOT NULL DEFAULT 'pwd',
  ADD COLUMN "absolute_expires_at" TIMESTAMPTZ(3);
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_amr_check" CHECK (
  ("amr" = 'pwd' AND "absolute_expires_at" IS NULL)
  OR ("amr" = 'mfa' AND "absolute_expires_at" IS NOT NULL AND "expires_at" <= "absolute_expires_at")
);
