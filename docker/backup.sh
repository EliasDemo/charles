#!/bin/sh
# Respaldo diario de la base de Charles (pg_dump comprimido). Conserva BACKUP_KEEP_DAYS días.
# Corre dentro del servicio `backup` de docker-compose.prod.yml; los archivos quedan en ./backups.
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"

while true; do
  STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
  FILE="/backups/charles-$STAMP.dump"
  if pg_dump -h postgres -U charles -d charles -Fc -f "$FILE.tmp"; then
    mv "$FILE.tmp" "$FILE"
    echo "Respaldo listo: $FILE ($(du -h "$FILE" | cut -f1))"
  else
    rm -f "$FILE.tmp"
    echo "ERROR: el respaldo falló" >&2
  fi
  # Borra solo respaldos de Charles más antiguos que KEEP días.
  find /backups -maxdepth 1 -name 'charles-*.dump' -mtime +"$KEEP" -print -delete
  sleep 86400
done
