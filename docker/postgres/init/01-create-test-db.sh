#!/bin/sh
# Crea la base de datos de pruebas e2e. Solo se ejecuta al inicializar el volumen.
# Las extensiones las crea la primera migración de Prisma en cada base.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE DATABASE charles_test OWNER "$POSTGRES_USER";
SQL
