-- Extensiones requeridas por Charles (CLAUDE.md §2 y §7.3).
-- Se crean aquí para que existan en cualquier entorno (local, CI, producción),
-- sin depender de scripts de inicialización de Docker.
-- Nota: postgis no es una extensión "trusted"; en producción el usuario de
-- migraciones necesita privilegios para crearla (la app no).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
