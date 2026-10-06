-- Barbero independiente: tipo de barbería (complemento de la Fase 4).
CREATE TYPE "BarbershopType" AS ENUM ('BARBERSHOP', 'INDEPENDENT');

ALTER TABLE "barbershops" ADD COLUMN "type" "BarbershopType" NOT NULL DEFAULT 'BARBERSHOP';

-- El tipo no cambia después de crear la barbería.
CREATE FUNCTION barbershops_type_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."type" <> OLD."type" THEN
    RAISE EXCEPTION 'barbershop type is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER barbershops_type_immutable
  BEFORE UPDATE OF "type" ON "barbershops"
  FOR EACH ROW EXECUTE FUNCTION barbershops_type_immutable();

-- Una barbería INDEPENDENT admite un solo barbero activo (no borrado). Se bloquea la fila de la
-- barbería para serializar altas y reactivaciones concurrentes.
CREATE FUNCTION barbers_independent_single_active() RETURNS trigger AS $$
DECLARE
  shop_type "BarbershopType";
BEGIN
  IF NOT NEW."is_active" OR NEW."deleted_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT "type" INTO shop_type FROM "barbershops" WHERE "id" = NEW."barbershop_id" FOR UPDATE;
  IF shop_type = 'INDEPENDENT' AND EXISTS (
    SELECT 1 FROM "barbers"
    WHERE "barbershop_id" = NEW."barbershop_id" AND "id" <> NEW."id"
      AND "is_active" AND "deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'independent barbershop allows a single active barber'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'barbers_independent_single_active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER barbers_independent_single_active
  BEFORE INSERT OR UPDATE OF "is_active", "deleted_at", "barbershop_id" ON "barbers"
  FOR EACH ROW EXECUTE FUNCTION barbers_independent_single_active();
