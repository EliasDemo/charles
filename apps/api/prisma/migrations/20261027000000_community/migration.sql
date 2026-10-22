-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('PROMOTION', 'EVENT', 'WORK', 'ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "EventAttendanceStatus" AS ENUM ('INTERESTED', 'GOING');

-- CreateEnum
CREATE TYPE "ContentReportTarget" AS ENUM ('POST', 'COMMENT', 'USER');

-- CreateEnum
CREATE TYPE "ContentReportReason" AS ENUM ('SPAM', 'OFFENSIVE', 'HARASSMENT', 'NUDITY', 'VIOLENCE', 'FALSE_INFO', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentReportStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "like_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "type" "PostType" NOT NULL,
    "barbershop_id" UUID,
    "author_profile_id" UUID,
    "created_by" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "promotion_id" UUID,
    "barber_profile_id" UUID,
    "service_id" UUID,
    "event_starts_at" TIMESTAMPTZ(3),
    "event_ends_at" TIMESTAMPTZ(3),
    "event_address" TEXT,
    "event_capacity" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "comments_disabled" BOOLEAN NOT NULL DEFAULT false,
    "pinned_at" TIMESTAMPTZ(3),
    "like_count" INTEGER NOT NULL DEFAULT 0,
    "comment_count" INTEGER NOT NULL DEFAULT 0,
    "share_count" INTEGER NOT NULL DEFAULT 0,
    "going_count" INTEGER NOT NULL DEFAULT 0,
    "interested_count" INTEGER NOT NULL DEFAULT 0,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "hidden_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_media" (
    "id" UUID NOT NULL,
    "post_id" UUID,
    "uploaded_by" UUID NOT NULL,
    "variants" JSONB NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comments" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "parent_id" UUID,
    "mention_user_id" UUID,
    "body" TEXT NOT NULL,
    "like_count" INTEGER NOT NULL DEFAULT 0,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "pinned_at" TIMESTAMPTZ(3),
    "hidden_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_likes" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_likes" (
    "id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_likes" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_saves" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_saves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendance" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "EventAttendanceStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "id" UUID NOT NULL,
    "follower_id" UUID NOT NULL,
    "barbershop_id" UUID,
    "barber_profile_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_blocks" (
    "id" UUID NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "target_type" "ContentReportTarget" NOT NULL,
    "target_id" UUID NOT NULL,
    "reason" "ContentReportReason" NOT NULL,
    "note" TEXT,
    "status" "ContentReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "posts"("created_at");

-- CreateIndex
CREATE INDEX "posts_barbershop_id_created_at_idx" ON "posts"("barbershop_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_author_profile_id_created_at_idx" ON "posts"("author_profile_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_created_by_idx" ON "posts"("created_by");

-- CreateIndex
CREATE INDEX "posts_promotion_id_idx" ON "posts"("promotion_id");

-- CreateIndex
CREATE INDEX "posts_barber_profile_id_idx" ON "posts"("barber_profile_id");

-- CreateIndex
CREATE INDEX "posts_service_id_idx" ON "posts"("service_id");

-- CreateIndex
CREATE INDEX "post_media_post_id_sort_order_idx" ON "post_media"("post_id", "sort_order");

-- CreateIndex
CREATE INDEX "post_media_uploaded_by_idx" ON "post_media"("uploaded_by");

-- CreateIndex
CREATE INDEX "post_comments_post_id_parent_id_created_at_idx" ON "post_comments"("post_id", "parent_id", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_author_id_idx" ON "post_comments"("author_id");

-- CreateIndex
CREATE INDEX "post_comments_parent_id_idx" ON "post_comments"("parent_id");

-- CreateIndex
CREATE INDEX "post_comments_mention_user_id_idx" ON "post_comments"("mention_user_id");

-- CreateIndex
CREATE INDEX "post_likes_user_id_idx" ON "post_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_likes_post_id_user_id_key" ON "post_likes"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "comment_likes_user_id_idx" ON "comment_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "comment_likes_comment_id_user_id_key" ON "comment_likes"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "review_likes_user_id_idx" ON "review_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_likes_review_id_user_id_key" ON "review_likes"("review_id", "user_id");

-- CreateIndex
CREATE INDEX "post_saves_user_id_created_at_idx" ON "post_saves"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "post_saves_post_id_user_id_key" ON "post_saves"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "event_attendance_user_id_idx" ON "event_attendance"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_attendance_post_id_user_id_key" ON "event_attendance"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "follows_barbershop_id_idx" ON "follows"("barbershop_id");

-- CreateIndex
CREATE INDEX "follows_barber_profile_id_idx" ON "follows"("barber_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "follows_follower_id_barbershop_id_key" ON "follows"("follower_id", "barbershop_id");

-- CreateIndex
CREATE UNIQUE INDEX "follows_follower_id_barber_profile_id_key" ON "follows"("follower_id", "barber_profile_id");

-- CreateIndex
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_blocks_blocker_id_blocked_id_key" ON "user_blocks"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "content_reports_status_created_at_idx" ON "content_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "content_reports_target_type_target_id_idx" ON "content_reports"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "content_reports_reviewed_by_idx" ON "content_reports"("reviewed_by");

-- CreateIndex
CREATE UNIQUE INDEX "content_reports_reporter_id_target_type_target_id_key" ON "content_reports"("reporter_id", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_profile_id_fkey" FOREIGN KEY ("author_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "post_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_mention_user_id_fkey" FOREIGN KEY ("mention_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "post_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_likes" ADD CONSTRAINT "review_likes_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_likes" ADD CONSTRAINT "review_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_saves" ADD CONSTRAINT "post_saves_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_saves" ADD CONSTRAINT "post_saves_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_barber_profile_id_fkey" FOREIGN KEY ("barber_profile_id") REFERENCES "barber_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Reglas que Prisma no expresa.
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_check" CHECK (
  ("barbershop_id" IS NOT NULL) <> ("author_profile_id" IS NOT NULL)
);
ALTER TABLE "posts" ADD CONSTRAINT "posts_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "posts" ADD CONSTRAINT "posts_event_check" CHECK (
  ("type" = 'EVENT') = ("event_starts_at" IS NOT NULL)
  AND ("event_ends_at" IS NULL OR "event_ends_at" > "event_starts_at")
  AND ("event_capacity" IS NULL OR "event_capacity" > 0)
);
ALTER TABLE "posts" ADD CONSTRAINT "posts_counts_check" CHECK (
  "like_count" >= 0 AND "comment_count" >= 0 AND "share_count" >= 0
  AND "going_count" >= 0 AND "interested_count" >= 0 AND "report_count" >= 0
);
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_body_check" CHECK (char_length("body") BETWEEN 1 AND 1000);
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_counts_check" CHECK (
  "like_count" >= 0 AND "reply_count" >= 0 AND "report_count" >= 0
);
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "follows" ADD CONSTRAINT "follows_target_check" CHECK (
  ("barbershop_id" IS NOT NULL) <> ("barber_profile_id" IS NOT NULL)
);
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_not_self_check" CHECK ("blocker_id" <> "blocked_id");
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_like_count_check" CHECK ("like_count" >= 0);
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500);
-- Feed "cerca de ti": índice espacial sobre la ubicación de la publicación.
CREATE INDEX "posts_geo_idx" ON "posts" USING GIST (
  (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography)
) WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;
