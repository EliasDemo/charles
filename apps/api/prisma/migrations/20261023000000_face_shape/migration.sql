-- CreateEnum
CREATE TYPE "FaceShape" AS ENUM ('OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND');

-- CreateEnum
CREATE TYPE "MaintenanceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "HairType" AS ENUM ('STRAIGHT', 'WAVY', 'CURLY', 'COILY');

-- CreateEnum
CREATE TYPE "StyleVibe" AS ENUM ('CLASSIC', 'MODERN');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "style_id" UUID;

-- AlterTable
ALTER TABLE "images" ADD COLUMN     "demo_source" JSONB,
ADD COLUMN     "face_shape" "FaceShape",
ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "label_confirmed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "service_styles" ADD COLUMN     "description" TEXT,
ADD COLUMN     "hair_types" "HairType"[],
ADD COLUMN     "maintenance" "MaintenanceLevel",
ADD COLUMN     "vibe" "StyleVibe";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "face_shape" "FaceShape",
ADD COLUMN     "face_shape_consent_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "face_shape_rules" (
    "id" UUID NOT NULL,
    "face_shape" "FaceShape" NOT NULL,
    "style_id" UUID NOT NULL,
    "score" SMALLINT NOT NULL,
    "note" TEXT,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_shape_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "face_shape_rules_style_id_idx" ON "face_shape_rules"("style_id");

-- CreateIndex
CREATE UNIQUE INDEX "face_shape_rules_face_shape_style_id_key" ON "face_shape_rules"("face_shape", "style_id");

-- CreateIndex
CREATE INDEX "bookings_style_id_idx" ON "bookings"("style_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_shape_rules" ADD CONSTRAINT "face_shape_rules_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Restricciones manuales (forma de cara) ─────────────
ALTER TABLE "face_shape_rules" ADD CONSTRAINT "face_shape_rules_score_check"
  CHECK ("score" BETWEEN 0 AND 100);
-- La forma guardada del cliente siempre va con la fecha de su consentimiento.
ALTER TABLE "users" ADD CONSTRAINT "users_face_shape_consent_check"
  CHECK (("face_shape" IS NULL) = ("face_shape_consent_at" IS NULL));
-- Solo los cortes (galería y portafolio) llevan forma de cara, y una foto de demo nunca cuenta
-- como etiqueta confirmada por un barbero.
ALTER TABLE "images" ADD CONSTRAINT "images_face_shape_kind_check"
  CHECK ("face_shape" IS NULL OR "kind" = 'GALLERY');
ALTER TABLE "images" ADD CONSTRAINT "images_demo_label_check"
  CHECK (NOT ("is_demo" AND "label_confirmed"));
