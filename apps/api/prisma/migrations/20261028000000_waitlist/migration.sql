-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('ACTIVE', 'NOTIFIED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "barbershop_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "barber_id" UUID,
    "date" DATE NOT NULL,
    "from_minute" SMALLINT,
    "to_minute" SMALLINT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'ACTIVE',
    "notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entries_barbershop_id_date_status_idx" ON "waitlist_entries"("barbershop_id", "date", "status");

-- CreateIndex
CREATE INDEX "waitlist_entries_user_id_status_idx" ON "waitlist_entries"("user_id", "status");

-- CreateIndex
CREATE INDEX "waitlist_entries_service_id_idx" ON "waitlist_entries"("service_id");

-- CreateIndex
CREATE INDEX "waitlist_entries_barber_id_idx" ON "waitlist_entries"("barber_id");

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_barbershop_id_fkey" FOREIGN KEY ("barbershop_id") REFERENCES "barbershops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_barber_id_fkey" FOREIGN KEY ("barber_id") REFERENCES "barbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Reglas que Prisma no expresa.
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_window_check" CHECK (
  ("from_minute" IS NULL OR "from_minute" BETWEEN 0 AND 1439)
  AND ("to_minute" IS NULL OR "to_minute" BETWEEN 1 AND 1440)
  AND ("from_minute" IS NULL OR "to_minute" IS NULL OR "from_minute" < "to_minute")
);
-- Una sola inscripción activa por persona, barbería, servicio y día.
CREATE UNIQUE INDEX "waitlist_entries_one_active" ON "waitlist_entries" ("user_id", "barbershop_id", "service_id", "date")
  WHERE "status" = 'ACTIVE';
