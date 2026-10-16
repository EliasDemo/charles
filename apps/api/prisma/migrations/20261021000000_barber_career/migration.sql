-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('CLIENT', 'PROFESSIONAL');

-- CreateEnum
CREATE TYPE "MessageSide" AS ENUM ('BARBERSHOP', 'USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'SCAM', 'OTHER');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'WEEKENDS', 'COMMISSION', 'FREELANCE');

-- CreateEnum
CREATE TYPE "JobPostingStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobApplicationStatus" AS ENUM ('APPLIED', 'SHORTLISTED', 'REJECTED', 'HIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- DropForeignKey
ALTER TABLE "images" DROP CONSTRAINT "images_barbershop_id_fkey";

-- AlterTable
ALTER TABLE "barbers" ADD COLUMN     "barber_profile_id" UUID,
ADD COLUMN     "ended_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "barber_profile_id" UUID;

-- AlterTable
ALTER TABLE "images" ADD COLUMN     "barber_profile_id" UUID,
ALTER COLUMN "barbershop_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "barber_profile_id" UUID;

-- CreateTable
CREATE TABLE "barber_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "headline" TEXT,
    "bio" TEXT,
    "photo_variants" JSONB,
    "years_experience" SMALLINT,
    "district" TEXT,
    "available_for_work" BOOLEAN NOT NULL DEFAULT false,
    "rating_avg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "barber_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barber_profile_specialties" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "style_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_profile_specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "barbershop_read_at" TIMESTAMPTZ(3),
    "user_read_at" TIMESTAMPTZ(3),
    "blocked_by" "MessageSide",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "side" "MessageSide" NOT NULL,
    "sender_id" UUID,
    "body_enc" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reports" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" "MessageReportReason" NOT NULL,
    "details" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "employment_type" "EmploymentType" NOT NULL,
    "compensation_text" TEXT,
    "style_ids" UUID[],
    "status" "JobPostingStatus" NOT NULL DEFAULT 'OPEN',
    "closes_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" UUID NOT NULL,
    "posting_id" UUID NOT NULL,
    "barber_profile_id" UUID NOT NULL,
    "message" TEXT,
    "status" "JobApplicationStatus" NOT NULL DEFAULT 'APPLIED',
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "barbershop_id" UUID,
    "barber_profile_id" UUID,
    "uploaded_by" UUID NOT NULL,
    "status" "VideoStatus" NOT NULL DEFAULT 'PROCESSING',
    "caption" TEXT,
    "variants" JSONB NOT NULL DEFAULT '{}',
    "duration_ms" INTEGER,
    "failure_reason" TEXT,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_reports" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" "ImageReportReason" NOT NULL,
    "details" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "barber_profiles_user_id_key" ON "barber_profiles"("user_id");

-- CreateIndex
CREATE INDEX "barber_profiles_available_for_work_idx" ON "barber_profiles"("available_for_work");

-- CreateIndex
CREATE INDEX "barber_profile_specialties_style_id_idx" ON "barber_profile_specialties"("style_id");

-- CreateIndex
CREATE UNIQUE INDEX "barber_profile_specialties_profile_id_style_id_key" ON "barber_profile_specialties"("profile_id", "style_id");

-- CreateIndex
CREATE INDEX "conversations_user_id_last_message_at_idx" ON "conversations"("user_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_barbershop_id_last_message_at_idx" ON "conversations"("barbershop_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_barbershop_id_user_id_kind_key" ON "conversations"("barbershop_id", "user_id", "kind");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");

-- CreateIndex
CREATE INDEX "message_reports_resolved_at_idx" ON "message_reports"("resolved_at");

-- CreateIndex
CREATE INDEX "message_reports_reporter_id_idx" ON "message_reports"("reporter_id");

-- CreateIndex
CREATE INDEX "message_reports_resolved_by_idx" ON "message_reports"("resolved_by");

-- CreateIndex
CREATE UNIQUE INDEX "message_reports_message_id_reporter_id_key" ON "message_reports"("message_id", "reporter_id");

-- CreateIndex
CREATE INDEX "job_postings_barbershop_id_status_idx" ON "job_postings"("barbershop_id", "status");

-- CreateIndex
CREATE INDEX "job_postings_status_created_at_idx" ON "job_postings"("status", "created_at");

-- CreateIndex
CREATE INDEX "job_postings_created_by_idx" ON "job_postings"("created_by");

-- CreateIndex
CREATE INDEX "job_applications_barber_profile_id_idx" ON "job_applications"("barber_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_posting_id_barber_profile_id_key" ON "job_applications"("posting_id", "barber_profile_id");

-- CreateIndex
CREATE INDEX "videos_barbershop_id_created_at_idx" ON "videos"("barbershop_id", "created_at");

-- CreateIndex
CREATE INDEX "videos_barber_profile_id_created_at_idx" ON "videos"("barber_profile_id", "created_at");

-- CreateIndex
CREATE INDEX "videos_uploaded_by_idx" ON "videos"("uploaded_by");

-- CreateIndex
CREATE INDEX "video_reports_resolved_at_idx" ON "video_reports"("resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_reports_video_id_reporter_id_key" ON "video_reports"("video_id", "reporter_id");

-- CreateIndex
CREATE INDEX "barbers_barber_profile_id_idx" ON "barbers"("barber_profile_id");

-- CreateIndex
CREATE INDEX "bookings_barber_profile_id_start_at_idx" ON "bookings"("barber_profile_id", "start_at");

-- CreateIndex
CREATE INDEX "images_barber_profile_id_idx" ON "images"("barber_profile_id");

-- CreateIndex
CREATE INDEX "reviews_barber_profile_id_idx" ON "reviews"("barber_profile_id");

-- AddForeignKey
ALTER TABLE "barbers" ADD CONSTRAINT "barbers_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_profiles" ADD CONSTRAINT "barber_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_profile_specialties" ADD CONSTRAINT "barber_profile_specialties_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "barber_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_profile_specialties" ADD CONSTRAINT "barber_profile_specialties_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "service_styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "job_postings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_reports" ADD CONSTRAINT "video_reports_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Restricciones manuales (Carrera del barbero) ─────────────

-- Un barbero puede trabajar en varias barberías: un vínculo vigente por barbería y cuenta.
DROP INDEX "barbers_user_id_active_key";
CREATE UNIQUE INDEX "barbers_shop_user_active_key" ON "barbers" ("barbershop_id", "user_id")
  WHERE "user_id" IS NOT NULL AND "deleted_at" IS NULL;

-- La misma persona no puede tener dos citas a la vez, aunque sean en barberías distintas.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_profile_no_overlap"
  EXCLUDE USING gist (
    "barber_profile_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  ) WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED') AND "barber_profile_id" IS NOT NULL);

-- Una imagen es de una barbería, del portafolio de un barbero o de ambos (cortes subidos en el local).
ALTER TABLE "images" ADD CONSTRAINT "images_owner_required_check"
  CHECK ("barbershop_id" IS NOT NULL OR "barber_profile_id" IS NOT NULL);

-- Un video es de una barbería o de un perfil, nunca de ambos.
ALTER TABLE "videos" ADD CONSTRAINT "videos_owner_check"
  CHECK (("barbershop_id" IS NULL) <> ("barber_profile_id" IS NULL));
ALTER TABLE "videos" ADD CONSTRAINT "videos_duration_check"
  CHECK ("duration_ms" IS NULL OR ("duration_ms" > 0 AND "duration_ms" <= 31000));

ALTER TABLE "barber_profiles" ADD CONSTRAINT "barber_profiles_rating_avg_check" CHECK ("rating_avg" BETWEEN 0 AND 5);
ALTER TABLE "barber_profiles" ADD CONSTRAINT "barber_profiles_rating_count_check" CHECK ("rating_count" >= 0);
ALTER TABLE "barber_profiles" ADD CONSTRAINT "barber_profiles_years_check"
  CHECK ("years_experience" IS NULL OR "years_experience" BETWEEN 0 AND 60);

-- ───────────── Datos existentes ─────────────

-- 1. Un perfil por cada cuenta que hoy es barbero (con los datos de su vínculo más reciente).
INSERT INTO "barber_profiles" ("id", "user_id", "display_name", "bio", "years_experience", "created_at", "updated_at")
SELECT DISTINCT ON (b."user_id")
       gen_random_uuid(), b."user_id", b."display_name", b."bio", b."years_experience", now(), now()
  FROM "barbers" b
  JOIN "users" u ON u."id" = b."user_id" AND u."anonymized_at" IS NULL
 WHERE b."user_id" IS NOT NULL
 ORDER BY b."user_id", b."deleted_at" NULLS FIRST, b."created_at" DESC;

-- 2. Vínculos, reservas, valoraciones y cortes de la galería pasan a contar para su perfil.
UPDATE "barbers" b SET "barber_profile_id" = p."id"
  FROM "barber_profiles" p WHERE p."user_id" = b."user_id";
UPDATE "barbers" SET "ended_at" = COALESCE("deleted_at", "updated_at")
 WHERE ("deleted_at" IS NOT NULL OR "is_active" = false) AND "ended_at" IS NULL;
UPDATE "bookings" k SET "barber_profile_id" = b."barber_profile_id"
  FROM "barbers" b WHERE b."id" = k."barber_id" AND b."barber_profile_id" IS NOT NULL;
UPDATE "reviews" r SET "barber_profile_id" = b."barber_profile_id"
  FROM "barbers" b WHERE b."id" = r."barber_id" AND b."barber_profile_id" IS NOT NULL;
UPDATE "images" i SET "barber_profile_id" = b."barber_profile_id"
  FROM "barbers" b
 WHERE b."id" = i."barber_id" AND b."barber_profile_id" IS NOT NULL AND i."kind" = 'GALLERY';

-- 3. Especialidades y foto del vínculo más reciente.
INSERT INTO "barber_profile_specialties" ("id", "profile_id", "style_id", "created_at", "updated_at")
SELECT gen_random_uuid(), s."profile_id", s."style_id", now(), now()
  FROM (SELECT DISTINCT b."barber_profile_id" AS profile_id, bs."style_id"
          FROM "barber_specialties" bs JOIN "barbers" b ON b."id" = bs."barber_id"
         WHERE b."barber_profile_id" IS NOT NULL) s;
UPDATE "barber_profiles" p SET "photo_variants" = x."variants"
  FROM (SELECT DISTINCT ON (b."barber_profile_id") b."barber_profile_id", i."variants"
          FROM "images" i JOIN "barbers" b ON b."id" = i."barber_id"
         WHERE i."kind" = 'BARBER_PHOTO' AND i."deleted_at" IS NULL AND b."barber_profile_id" IS NOT NULL
         ORDER BY b."barber_profile_id", i."created_at" DESC) x
 WHERE x."barber_profile_id" = p."id";

-- 4. Promedio de la carrera (valoraciones visibles en todas sus barberías).
UPDATE "barber_profiles" p SET "rating_avg" = s.avg, "rating_count" = s.cnt
  FROM (SELECT "barber_profile_id", ROUND(AVG("rating")::numeric, 2) AS avg, COUNT(*)::int AS cnt
          FROM "reviews"
         WHERE "barber_profile_id" IS NOT NULL AND "deleted_at" IS NULL AND "status" <> 'HIDDEN'
         GROUP BY "barber_profile_id") s
 WHERE s."barber_profile_id" = p."id";
