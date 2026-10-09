-- Eliminación de cuenta: solicitud con periodo de gracia, anonimización y lista de bloqueo de
-- correos de cuentas deshabilitadas por soporte (solo el índice ciego).

ALTER TABLE "users"
  ADD COLUMN "deletion_requested_at" TIMESTAMPTZ(3),
  ADD COLUMN "deletion_scheduled_for" TIMESTAMPTZ(3),
  ADD COLUMN "deletion_reminded_at" TIMESTAMPTZ(3),
  ADD COLUMN "deletion_final_notice_at" TIMESTAMPTZ(3),
  ADD COLUMN "anonymized_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD CONSTRAINT "users_deletion_complete_check"
  CHECK (("deletion_requested_at" IS NULL) = ("deletion_scheduled_for" IS NULL));
-- Trabajo de eliminación: cuentas pendientes por fecha.
CREATE INDEX "users_deletion_scheduled_for_idx" ON "users" ("deletion_scheduled_for")
  WHERE "deletion_scheduled_for" IS NOT NULL;

CREATE TABLE "email_blocklist" (
  "id" UUID NOT NULL,
  "email_hash" BYTEA NOT NULL,
  "blocked_until" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_blocklist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_blocklist_email_hash_key" ON "email_blocklist" ("email_hash");
CREATE INDEX "email_blocklist_blocked_until_idx" ON "email_blocklist" ("blocked_until");

-- audit_log sigue siendo de solo inserción, con UNA excepción acotada (eliminación de cuenta):
-- borrar la IP (dato personal) de las filas de una cuenta eliminada. Solo se acepta un UPDATE que
-- pone `ip` en NULL y deja todas las demás columnas idénticas; DELETE sigue prohibido.
CREATE OR REPLACE FUNCTION "audit_log_reject_mutation"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."ip" IS NOT NULL
     AND NEW."ip" IS NULL
     AND (to_jsonb(NEW) - 'ip') = (to_jsonb(OLD) - 'ip') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log es de solo inserción' USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Única vía para esa excepción. SECURITY DEFINER: funciona aunque en producción la app no tenga
-- UPDATE sobre audit_log (el dueño de la función, el usuario de migraciones, sí lo tiene).
CREATE FUNCTION "audit_log_redact_ip"(p_actor UUID) RETURNS INTEGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE "audit_log" SET "ip" = NULL WHERE "actor_id" = p_actor AND "ip" IS NOT NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
