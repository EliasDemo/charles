-- Nombre de usuario: público (en lugar del nombre real) y para iniciar sesión con usuario o correo.
ALTER TABLE "users" ADD COLUMN "username" CITEXT;
ALTER TABLE "users" ADD COLUMN "username_changed_at" TIMESTAMPTZ(3);

-- Cuentas existentes: usuario automático a partir del nombre (sin tildes ni espacios) más 4 cifras
-- tomadas de su id; si choca, se agregan más cifras. La persona puede cambiarlo después.
WITH base AS (
  SELECT id,
         LEFT(
           NULLIF(
             REGEXP_REPLACE(
               LOWER(TRANSLATE(full_name, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouaeiounnuu')),
               '[^a-z0-9]+', '.', 'g'),
             ''),
           12) AS stem
    FROM users
)
UPDATE users u
   SET username = TRIM(BOTH '.' FROM COALESCE(NULLIF(TRIM(BOTH '.' FROM b.stem), ''), 'usuario'))
                  || '.' || RIGHT(REPLACE(u.id::text, '-', ''), 4)
  FROM base b
 WHERE b.id = u.id;

-- Desempate (muy raro): agrega 4 cifras más del id.
UPDATE users u
   SET username = u.username || RIGHT(REPLACE(u.id::text, '-', ''), 8)
 WHERE EXISTS (
   SELECT 1 FROM users o WHERE o.username = u.username AND o.id < u.id
 );

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
-- Formato: 3 a 20 caracteres, minúsculas, números, punto y guion bajo; sin empezar ni terminar en
-- punto o guion bajo, y sin dos seguidos.
ALTER TABLE "users" ADD CONSTRAINT "users_username_format_check" CHECK (
  "username" ~ '^[a-z0-9]([a-z0-9]|[._](?![._])){1,18}[a-z0-9]$'
);
