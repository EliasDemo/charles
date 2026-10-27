-- Foros: temas (ADMIN), hilos de preguntas de cualquier cuenta, respuestas con votos "me sirvió",
-- mejor respuesta y moderación con los mismos reportes de la Comunidad.

ALTER TYPE "ContentReportTarget" ADD VALUE 'FORUM_THREAD';
ALTER TYPE "ContentReportTarget" ADD VALUE 'FORUM_REPLY';

CREATE TABLE "forum_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "thread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "forum_categories_slug_key" ON "forum_categories"("slug");
ALTER TABLE "forum_categories" ADD CONSTRAINT "forum_categories_slug_check"
  CHECK ("slug" ~ '^[a-z0-9-]{2,40}$');
ALTER TABLE "forum_categories" ADD CONSTRAINT "forum_categories_thread_count_check"
  CHECK ("thread_count" >= 0);

CREATE TABLE "forum_threads" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "solution_reply_id" UUID,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "pinned_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "hidden_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_threads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "forum_threads_solution_reply_id_key" ON "forum_threads"("solution_reply_id");
CREATE INDEX "forum_threads_category_id_last_activity_at_idx" ON "forum_threads"("category_id", "last_activity_at");
CREATE INDEX "forum_threads_last_activity_at_idx" ON "forum_threads"("last_activity_at");
CREATE INDEX "forum_threads_author_id_idx" ON "forum_threads"("author_id");
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_title_check"
  CHECK (char_length("title") BETWEEN 8 AND 140);
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_body_check"
  CHECK (char_length("body") BETWEEN 1 AND 5000);
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_counts_check"
  CHECK ("reply_count" >= 0 AND "report_count" >= 0);

CREATE TABLE "forum_replies" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "hidden_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_replies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "forum_replies_thread_id_created_at_idx" ON "forum_replies"("thread_id", "created_at");
CREATE INDEX "forum_replies_author_id_idx" ON "forum_replies"("author_id");
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_body_check"
  CHECK (char_length("body") BETWEEN 1 AND 3000);
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_counts_check"
  CHECK ("helpful_count" >= 0 AND "report_count" >= 0);

CREATE TABLE "forum_reply_votes" (
    "id" UUID NOT NULL,
    "reply_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_reply_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "forum_reply_votes_reply_id_user_id_key" ON "forum_reply_votes"("reply_id", "user_id");
CREATE INDEX "forum_reply_votes_user_id_idx" ON "forum_reply_votes"("user_id");

ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "forum_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_solution_reply_id_fkey"
  FOREIGN KEY ("solution_reply_id") REFERENCES "forum_replies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "forum_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forum_reply_votes" ADD CONSTRAINT "forum_reply_votes_reply_id_fkey"
  FOREIGN KEY ("reply_id") REFERENCES "forum_replies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "forum_reply_votes" ADD CONSTRAINT "forum_reply_votes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
