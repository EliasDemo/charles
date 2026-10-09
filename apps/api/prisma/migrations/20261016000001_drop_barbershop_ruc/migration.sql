-- La columna `ruc` (en claro) se migró al documento cifrado del responsable con
-- `pnpm --filter api migrate:ruc`, que debe ejecutarse antes de esta migración.
ALTER TABLE "barbershops" DROP COLUMN "ruc";
