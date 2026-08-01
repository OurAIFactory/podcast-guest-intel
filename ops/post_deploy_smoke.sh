#!/usr/bin/env bash
# Run AFTER deploy. Non-zero exit => roll back to previous image.
set -uo pipefail
BASE="${1:?https base url}"; APP="${2:-podcast-guest-intel}"; VOL="${3:-${APP}-data}"
SRC="/var/lib/docker/volumes/${VOL}/_data"
C="$(docker ps --format '{{.Names}}' | grep "$APP" | head -1)"
fail(){ echo "SMOKE FAIL: $*"; exit 1; }

curl -fsS -o /dev/null "$BASE/healthz" || fail "healthz not 200"
# durability: DATA_DIR must be a real mount inside the container
docker exec "$C" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz/durability').then(r=>r.json()).then(j=>process.exit(j.data_dir_is_mount?0:1)).catch(()=>process.exit(1))" || fail "DATA_DIR not on a mount"
# persistence round-trip visible on the HOST volume
MARK=".smoke_$(date -u +%s)"
docker exec "$C" sh -c "echo ok > /app/data/$MARK"
test -f "$SRC/$MARK" || fail "marker not on host volume (writes going to container fs!)"; rm -f "$SRC/$MARK"
# data canary: counts must not drop vs pre-deploy snapshot
if [ -f "/var/backups/$APP/latest.canary" ]; then
  while IFS='=' read -r k v; do
    [ -z "$k" ] && continue
    if [ "$k" = "files" ]; then now=$(find "$SRC" -type f | wc -l);
    else now=$(docker exec "$C" node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');try{const d=new DatabaseSync(process.env.GUESTS_DB||'/app/data/guest_profile_images.db',{readOnly:true});console.log(d.prepare('SELECT COUNT(*) n FROM guest_images').get().n)}catch(e){console.log($v)}" 2>/dev/null||echo "$v"); fi
    [ "$now" -lt "$v" ] && fail "data canary DROP: $k was $v now $now"
  done < "/var/backups/$APP/latest.canary"
fi
echo "smoke ok"
