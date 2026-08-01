# podcast-guest-intel — deploy notes

Lean web/API over the curated podcast-guest data. Heavy RSS harvesting stays on
the local Windows box; this app serves the curated outputs.

- **Stack:** Node 22 + Express. One multi-stage `Dockerfile`. Non-root, `tini`, `HEALTHCHECK`.
- **Port:** binds `0.0.0.0:$PORT` (default **8080**).
- **Health:** `/healthz` (liveness, no deps), `/readyz` (checks guests DB), `/healthz/durability`.
- **Data (all under the mounted volume `DATA_DIR=/app/data`):**
  - `guest_profile_images.db` — SQLite, table `guest_images`.
  - `images/pID.ext` — guest photos (served at `/images/...`).
  - `xml_packs/pack_*.bin` + `xml_packs/xml_index.db` — packed feed XML (served at `/feed/:sha`).
- **Env names:** see `.env.example`. Real values = Dokploy secrets.

## Dokploy
- Build Type = **Dockerfile**. Internal port **8080**.
- Add a **volume** mounted at `/app/data` (durable). The app hard-fails to boot if it isn't a real mount.
- Deploy on the temporary domain, verify `/healthz` + `/readyz`, then attach the custom subdomain + HTTPS once its DNS `A`/`AAAA` records resolve to the server.
- Seed the volume with the curated data (guest DB, images, packs) via `docker cp` / volume copy.

## Local (Windows + Docker Desktop)
`docker compose up` → http://localhost:8080 (uses a local volume; `DEPLOY_MODE=local` skips the mount guard).
