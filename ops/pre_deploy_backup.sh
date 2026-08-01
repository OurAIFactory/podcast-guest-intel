#!/usr/bin/env bash
# Run BEFORE every deploy. Backs up the data volume + records a data canary. Abort deploy on failure.
set -euo pipefail
APP="${1:-podcast-guest-intel}"; VOL="${2:-${APP}-data}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="/var/backups/$APP"; mkdir -p "$DEST"
SRC="/var/lib/docker/volumes/${VOL}/_data"
C="$(docker ps --format '{{.Names}}' | grep "$APP" | head -1 || true)"

tar -C "$SRC" -czf "$DEST/${APP}_${STAMP}.tgz" .
test -s "$DEST/${APP}_${STAMP}.tgz"; tar -tzf "$DEST/${APP}_${STAMP}.tgz" >/dev/null

# canary: file count + guest_images row count (via the container's node; host may lack sqlite3)
rows=0
if [ -n "$C" ]; then
  rows=$(docker exec "$C" node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');try{const d=new DatabaseSync(process.env.GUESTS_DB||'/app/data/guest_profile_images.db',{readOnly:true});console.log(d.prepare('SELECT COUNT(*) n FROM guest_images').get().n);}catch(e){console.log(0)}" 2>/dev/null || echo 0)
fi
{ echo "files=$(find "$SRC" -type f | wc -l)"; echo "guest_images=$rows"; } > "$DEST/${APP}_${STAMP}.canary"
ln -sf "$DEST/${APP}_${STAMP}.canary" "$DEST/latest.canary"
# TODO: off-box copy (EU S3/R2): rclone copy "$DEST/${APP}_${STAMP}.tgz" remote:backups/$APP/
echo "backup ok: $DEST/${APP}_${STAMP}.tgz"
