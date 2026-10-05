-- DropIndex
DROP INDEX "password_reset_tokens_token_hash_key";

-- AlterTable
ALTER TABLE "password_reset_tokens" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "adult_declared_at" TIMESTAMPTZ(3),
ADD COLUMN     "email_verified_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "email_verification_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_verification_codes_user_id_idx" ON "email_verification_codes"("user_id");

-- AddForeignKey
ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SQL manual: invariantes de los códigos de un solo uso.
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5);
ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5);
