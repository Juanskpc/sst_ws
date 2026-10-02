#!/usr/bin/env bash
# A0-02 · Respaldo diario de producción (base + archivos), con retención y
# comprobación. Va en el crontab del usuario `orbita` del VPS de producción.
# Instalación y restauración: docs/4-despliegue/respaldos-automaticos.md (repo del frontend).
#
# Por qué existe: la base vive en el mismo disco del VPS y los backups de Vultr
# están apagados (despliegue-vultr.md §7.1). Hasta ahora solo había respaldos
# manuales antes de cada despliegue.
#
# Variables (todas con valor por defecto):
#   RESPALDO_DIR      carpeta de destino               (~/respaldos/auto)
#   RESPALDO_DIAS     días que se conservan            (7)
#   APP_DIR           backend con su .env               (/opt/orbita/sst_ws)
#   STORAGE_DIR       soportes y PDF subidos            (/opt/orbita/storage, o $APP_DIR/storage)
#   RESPALDO_REMOTO   copia FUERA de la máquina: un destino de rclone ("remoto:carpeta").
#                     Vacío = solo copia local (avisa en el registro). Ver la guía.
set -euo pipefail

RESPALDO_DIR="${RESPALDO_DIR:-$HOME/respaldos/auto}"
RESPALDO_DIAS="${RESPALDO_DIAS:-7}"
APP_DIR="${APP_DIR:-/opt/orbita/sst_ws}"
STORAGE_DIR="${STORAGE_DIR:-/opt/orbita/storage}"
[ -d "$STORAGE_DIR" ] || STORAGE_DIR="$APP_DIR/storage"
RESPALDO_REMOTO="${RESPALDO_REMOTO:-}"

mkdir -p "$RESPALDO_DIR"
REGISTRO="$RESPALDO_DIR/respaldo.log"
SELLO="$(date +%Y%m%d-%H%M)"
log() { echo "$(date '+%F %T') $*" >> "$REGISTRO"; }

# La URL de la base sale del .env del backend, igual que en los runbooks de despliegue.
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)"
if [ -z "$DATABASE_URL" ]; then log "ERROR sin DATABASE_URL en $APP_DIR/.env"; exit 1; fi

DUMP="$RESPALDO_DIR/orbita-$SELLO.dump"
TGZ="$RESPALDO_DIR/storage-$SELLO.tgz"

# 1. Base: formato custom (comprimido, se restaura con pg_restore).
if ! pg_dump -Fc --no-owner "$DATABASE_URL" -f "$DUMP.tmp" 2>> "$REGISTRO"; then
  log "ERROR pg_dump falló"; rm -f "$DUMP.tmp"; exit 1
fi
# Un dump ilegible no es un respaldo: se lee su índice antes de darlo por bueno.
if ! pg_restore --list "$DUMP.tmp" > /dev/null 2>> "$REGISTRO"; then
  log "ERROR el dump no se puede leer"; rm -f "$DUMP.tmp"; exit 1
fi
mv "$DUMP.tmp" "$DUMP"

# 2. Archivos subidos (soportes, órdenes, PDF de facturas).
if [ -d "$STORAGE_DIR" ]; then
  tar -czf "$TGZ.tmp" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")" 2>> "$REGISTRO" && mv "$TGZ.tmp" "$TGZ"
else
  log "AVISO no existe $STORAGE_DIR: solo se respaldó la base"
fi

ARCHIVOS="$(basename "$DUMP") $(du -h "$DUMP" | cut -f1)"
[ -f "$TGZ" ] && ARCHIVOS="$ARCHIVOS + $(basename "$TGZ") $(du -h "$TGZ" | cut -f1)"
log "OK $ARCHIVOS"

# 3. Copia fuera de la máquina: sin ella, el respaldo se pierde con el mismo disco.
if [ -n "$RESPALDO_REMOTO" ]; then
  if command -v rclone > /dev/null; then
    if rclone copy "$RESPALDO_DIR" "$RESPALDO_REMOTO" --include "*-$SELLO.*" 2>> "$REGISTRO"; then
      log "OK copia remota en $RESPALDO_REMOTO"
    else
      log "ERROR la copia remota falló"
    fi
  else
    log "ERROR RESPALDO_REMOTO está definido pero rclone no está instalado"
  fi
else
  log "AVISO sin copia fuera de la máquina (RESPALDO_REMOTO vacío)"
fi

# 4. Retención local: solo los automáticos (los manuales de ~/respaldos no se tocan).
find "$RESPALDO_DIR" -maxdepth 1 -type f \( -name 'orbita-*.dump' -o -name 'storage-*.tgz' \) -mtime +"$RESPALDO_DIAS" -delete
