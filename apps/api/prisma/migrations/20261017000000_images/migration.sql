-- Fase 14: imágenes (logo, portada, foto de barbero y galería), estilos por categoría,
-- especialidades y años de experiencia del barbero, y reportes de imágenes. Los estilos iniciales
-- y los ajustes `images.*` los carga el seed (datos de referencia).

CREATE TYPE "ImageKind" AS ENUM ('BARBERSHOP_LOGO', 'BARBERSHOP_COVER', 'BARBER_PHOTO', 'GALLERY');
CREATE TYPE "ImageReportReason" AS ENUM ('NOT_MY_PHOTO', 'NO_CONSENT', 'INAPPROPRIATE', 'MISLEADING', 'OTHER');

ALTER TABLE "barbers" ADD COLUMN "years_experience" SMALLINT;
ALTER TABLE "barbers" ADD CONSTRAINT "barbers_years_experience_check"
  CHECK ("years_experience" IS NULL OR "years_experience" BETWEEN 0 AND 60);

CREATE TABLE "service_styles" (
  "id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_styles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "service_styles_key_check" CHECK ("key" ~ '^[a-z0-9_]{2,40}$')
);
CREATE UNIQUE INDEX "service_styles_key_key" ON "service_styles" ("key");
CREATE INDEX "service_styles_category_id_idx" ON "service_styles" ("category_id");
ALTER TABLE "service_styles" ADD CONSTRAINT "service_styles_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "barber_specialties" (
  "id" UUID NOT NULL,
  "barber_id" UUID NOT NULL,
  "style_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "barber_specialties_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "barber_specialties_barber_id_style_id_key" ON "barber_specialties" ("barber_id", "style_id");
CREATE INDEX "barber_specialties_style_id_idx" ON "barber_specialties" ("style_id");
ALTER TABLE "barber_specialties" ADD CONSTRAINT "barber_specialties_barber_id_fkey"
  FOREIGN KEY ("barber_id") REFERENCES "barbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_specialties" ADD CONSTRAINT "barber_specialties_style_id_fkey"
  FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "images" (
  "id" UUID NOT NULL,
  "barbershop_id" UUID NOT NULL,
  "barber_id" UUID,
  "kind" "ImageKind" NOT NULL,
  "variants" JSONB NOT NULL,
  "uploaded_by" UUID NOT NULL,
  "consent_given" BOOLEAN NOT NULL DEFAULT false,
  "consent_by_user_id" UUID,
  "consent_timestamp" TIMESTAMPTZ(3),
  "caption" TEXT,
  "service_id" UUID,
  "pinned_at" TIMESTAMPTZ(3),
  "removed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "images_pkey" PRIMARY KEY ("id"),
  -- La foto de barbero y la galería pertenecen a un barbero; logo y portada, a la barbería.
  -- (barber_id puede quedar NULL si el barbero se elimina: la imagen se borra con él.)
  CONSTRAINT "images_owner_check" CHECK (
    "kind" IN ('BARBER_PHOTO', 'GALLERY') OR "barber_id" IS NULL
  ),
  -- Consentimiento declarado: quién y cuándo, o nada.
  CONSTRAINT "images_consent_check" CHECK (
    ("consent_given" = false AND "consent_timestamp" IS NULL)
    OR ("consent_given" = true AND "consent_timestamp" IS NOT NULL)
  ),
  CONSTRAINT "images_gallery_consent_check" CHECK ("kind" <> 'GALLERY' OR "consent_given"),
  CONSTRAINT "images_gallery_only_check" CHECK (
    "kind" = 'GALLERY' OR ("pinned_at" IS NULL AND "caption" IS NULL AND "service_id" IS NULL)
  ),
  CONSTRAINT "images_caption_length_check" CHECK ("caption" IS NULL OR char_length("caption") <= 200)
);
CREATE INDEX "images_barbershop_id_kind_idx" ON "images" ("barbershop_id", "kind");
CREATE INDEX "images_barber_id_kind_idx" ON "images" ("barber_id", "kind");
CREATE INDEX "images_uploaded_by_idx" ON "images" ("uploaded_by");
CREATE INDEX "images_consent_by_user_id_idx" ON "images" ("consent_by_user_id");
CREATE INDEX "images_service_id_idx" ON "images" ("service_id");
-- Un solo logo y una sola portada vigentes por barbería; una foto vigente por barbero.
CREATE UNIQUE INDEX "images_one_shop_kind_key" ON "images" ("barbershop_id", "kind")
  WHERE "deleted_at" IS NULL AND "kind" IN ('BARBERSHOP_LOGO', 'BARBERSHOP_COVER');
CREATE UNIQUE INDEX "images_one_barber_photo_key" ON "images" ("barber_id")
  WHERE "deleted_at" IS NULL AND "kind" = 'BARBER_PHOTO';
ALTER TABLE "images" ADD CONSTRAINT "images_barbershop_id_fkey"
  FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "images" ADD CONSTRAINT "images_barber_id_fkey"
  FOREIGN KEY ("barber_id") REFERENCES "barbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "images" ADD CONSTRAINT "images_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "images" ADD CONSTRAINT "images_consent_by_user_id_fkey"
  FOREIGN KEY ("consent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "images" ADD CONSTRAINT "images_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "image_styles" (
  "id" UUID NOT NULL,
  "image_id" UUID NOT NULL,
  "style_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "image_styles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_styles_image_id_style_id_key" ON "image_styles" ("image_id", "style_id");
CREATE INDEX "image_styles_style_id_idx" ON "image_styles" ("style_id");
ALTER TABLE "image_styles" ADD CONSTRAINT "image_styles_image_id_fkey"
  FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "image_styles" ADD CONSTRAINT "image_styles_style_id_fkey"
  FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "image_reports" (
  "id" UUID NOT NULL,
  "image_id" UUID NOT NULL,
  "reported_by" UUID NOT NULL,
  "reason" "ImageReportReason" NOT NULL,
  "details" TEXT,
  "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
  "resolution" TEXT,
  "resolved_by" UUID,
  "resolved_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "image_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "image_reports_details_length_check" CHECK ("details" IS NULL OR char_length("details") <= 500)
);
CREATE UNIQUE INDEX "image_reports_image_id_reported_by_key" ON "image_reports" ("image_id", "reported_by");
CREATE INDEX "image_reports_reported_by_idx" ON "image_reports" ("reported_by");
CREATE INDEX "image_reports_resolved_by_idx" ON "image_reports" ("resolved_by");
CREATE INDEX "image_reports_status_created_at_idx" ON "image_reports" ("status", "created_at");
-- Cuenta de reportes abiertos por imagen (ocultamiento automático).
CREATE INDEX "image_reports_open_idx" ON "image_reports" ("image_id") WHERE "status" <> 'RESOLVED';
ALTER TABLE "image_reports" ADD CONSTRAINT "image_reports_image_id_fkey"
  FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "image_reports" ADD CONSTRAINT "image_reports_reported_by_fkey"
  FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_reports" ADD CONSTRAINT "image_reports_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
