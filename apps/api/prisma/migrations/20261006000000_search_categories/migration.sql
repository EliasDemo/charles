-- Fase 6: categorías de servicio y búsqueda de texto (unaccent + pg_trgm).

-- ───────────── Categorías de servicio ─────────────
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_categories_key_key" ON "service_categories"("key");

ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_key_check"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_name_check"
  CHECK (length(btrim("name")) BETWEEN 2 AND 60);

-- "Otros" con ID fijo: se necesita aquí para asignarlo a los servicios existentes. El resto de
-- categorías iniciales las carga el seed de datos de referencia (prisma/seed/categories.ts).
INSERT INTO "service_categories" ("id", "key", "name", "sort_order")
VALUES ('01990000-0000-7000-8000-000000000909', 'other', 'Otros', 90);

-- Servicios existentes → "Otros"; luego la columna pasa a obligatoria.
ALTER TABLE "services" ADD COLUMN "category_id" UUID;
UPDATE "services" SET "category_id" = '01990000-0000-7000-8000-000000000909';
ALTER TABLE "services" ALTER COLUMN "category_id" SET NOT NULL;

CREATE INDEX "services_category_id_idx" ON "services"("category_id");

ALTER TABLE "services" ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Búsqueda de texto ─────────────
-- unaccent y pg_trgm son extensiones "trusted" (no requieren superusuario).
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() no es IMMUTABLE (depende del diccionario por defecto); este envoltorio fija el
-- diccionario y permite usarlo en índices. Normaliza: sin tildes y en minúsculas.
CREATE FUNCTION charles_normalize(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, $1)) $$;

CREATE INDEX "barbershops_name_trgm_idx" ON "barbershops"
  USING GIN (charles_normalize("name") gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "services_name_trgm_idx" ON "services"
  USING GIN (charles_normalize("name") gin_trgm_ops) WHERE "deleted_at" IS NULL;

-- Filtros por servicio/categoría/precio dentro de la barbería.
CREATE INDEX "services_bookable_idx" ON "services" ("barbershop_id", "category_id", "price_amount")
  WHERE "deleted_at" IS NULL AND "is_available";
