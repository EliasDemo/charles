-- Tienda de auspiciadores: ficha de la marca, ofertas reales en los productos, videos de marcas y
-- clics a la tienda. Se elimina `sponsor_campaigns.target`, que nunca se usó.

CREATE TYPE "SponsorCategory" AS ENUM ('COSMETICS', 'TOOLS', 'FURNITURE', 'SUPPLIES', 'EDUCATION', 'OTHER');

ALTER TABLE "sponsors"
  ADD COLUMN "category" "SponsorCategory" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "website_url" TEXT,
  ADD COLUMN "cover_url" TEXT;
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_description_check"
  CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 600);
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_website_check"
  CHECK ("website_url" IS NULL OR "website_url" ~ '^https://');

ALTER TABLE "sponsor_campaigns" DROP COLUMN "target";

ALTER TABLE "sponsor_products"
  ADD COLUMN "audience" "SponsorAudience" NOT NULL DEFAULT 'ALL',
  ADD COLUMN "price_amount" INTEGER,
  ADD COLUMN "offer_price_amount" INTEGER,
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
  ADD COLUMN "coupon_code" TEXT,
  ADD COLUMN "offer_ends_at" TIMESTAMPTZ(3),
  ADD COLUMN "click_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sponsor_products" ADD CONSTRAINT "sponsor_products_price_check"
  CHECK ("price_amount" IS NULL OR "price_amount" > 0);
-- Una oferta exige precio normal y es estrictamente menor.
ALTER TABLE "sponsor_products" ADD CONSTRAINT "sponsor_products_offer_check"
  CHECK ("offer_price_amount" IS NULL
    OR ("price_amount" IS NOT NULL AND "offer_price_amount" > 0 AND "offer_price_amount" < "price_amount"));
ALTER TABLE "sponsor_products" ADD CONSTRAINT "sponsor_products_coupon_check"
  CHECK ("coupon_code" IS NULL OR "coupon_code" ~ '^[A-Z0-9-]{3,30}$');
ALTER TABLE "sponsor_products" ADD CONSTRAINT "sponsor_products_click_count_check"
  CHECK ("click_count" >= 0);
CREATE INDEX "sponsor_products_audience_is_active_idx" ON "sponsor_products"("audience", "is_active");

CREATE TABLE "sponsor_product_clicks" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "viewer_hash" BYTEA NOT NULL,
    "hour_bucket" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsor_product_clicks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sponsor_product_clicks_product_id_viewer_hash_hour_bucket_key"
  ON "sponsor_product_clicks"("product_id", "viewer_hash", "hour_bucket");
ALTER TABLE "sponsor_product_clicks" ADD CONSTRAINT "sponsor_product_clicks_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "sponsor_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Videos: ahora también de una marca. Exactamente un dueño.
ALTER TABLE "videos" ADD COLUMN "sponsor_id" UUID;
ALTER TABLE "videos" ADD CONSTRAINT "videos_sponsor_id_fkey"
  FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "videos_sponsor_id_created_at_idx" ON "videos"("sponsor_id", "created_at");
ALTER TABLE "videos" DROP CONSTRAINT "videos_owner_check";
ALTER TABLE "videos" ADD CONSTRAINT "videos_owner_check"
  CHECK (num_nonnulls("barbershop_id", "barber_profile_id", "sponsor_id") = 1);
