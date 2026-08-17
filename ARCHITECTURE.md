# podcast-guest-intel — architecture

Two containers, one durable volume, deployed via Dokploy (Traefik + Let's Encrypt in front).

```
                    ┌──────────────────────── netcup server ───────────────────────┐
 internet ──TLS──►  │ Traefik ──► web (Express, node:22-slim, non-root, tini PID1) │
                    │                 │  /healthz /readyz /healthz/durability      │
                    │                 │  /api/guests  /images/*  /feed/:sha        │
                    │                 │  /admin/* (token-gated import/disk ops)    │
                    │                 ▼                                            │
                    │           [ volume: /app/data ]  ◄── shared ──┐              │
                    │             guest_profile_images.db           │              │
                    │             images/p<id>.<ext>  (7,171)       │              │
                    │             seed_feeds.txt      (4.7M urls)   │              │
                    │             feeds.db            (queue)       │              │
                    │             xml_packs/pack_*.bin + xml_index.db              │
                    │                                               │              │
                    │           collector (same image, CMD collector.js)           │
                    │             seeds queue → fetches feeds 24/7 ─┘              │
                    │             /stats /healthz on :8080 (col.* domain)          │
                    └──────────────────────────────────────────────────────────────┘
```

## Data design
- **Content-addressed XML archive.** Every archived feed snapshot is keyed by
  `sha256(xml content)`. Storage is a few large append-only pack files
  (`pack_<hex>.bin`, capped ~1 GB) plus a SQLite index
  `xml_index(sha,pack,offset,length,partial,compression)`. Migrated historical
  packs occupy ids 0–15; the live collector appends from id 256 — no collision.
  Identical content (across feeds or across refreshes) stores once.
- **Feed queue** `feeds.db`: one row per feed URL with status
  (pending/retry/done/failed), attempt count, next-due time, and HTTP validators
  (`etag`, `last_modified`) for conditional GET. `done` feeds re-enter the queue
  when `next_at` passes (default refresh: 168 h).
- **Guest directory** `guest_profile_images.db` (`guest_images`): 7,171 people
  with staged photos in `images/`, served by the web tier.

## Efficiency choices
- Conditional GET: refreshes send `If-None-Match`/`If-Modified-Since`; a 304
  costs ~zero bandwidth. At millions of feeds this is the difference between
  re-downloading the internet weekly and a light heartbeat.
- Pack writer keeps one append fd open (no open/close per feed) and one shared
  WAL SQLite index (busy_timeout 60 s) between web (read) and collector (write).
- Web keeps a cached read-only guests-DB connection, invalidated by file mtime;
  the pack index handle retries after upload without needing a restart.
- Bulk data transfer is streamed: `/admin/import-tgz` pipes a tar body straight
  into `tar -x` on the volume; `/admin/put?path=` supports byte-offset resume
  for multi-GB files (client checks `/admin/size`, seeks, streams the rest).

## Durability standard
- `DATA_DIR=/app/data` must be a mounted volume; `durability_guard.assertDurable`
  refuses to boot in `DEPLOY_MODE=server` if it isn't. `/healthz/durability`
  reports the live check. Images run as non-root (`node`, uid 1000) with tini as
  PID 1 and a container HEALTHCHECK on `/healthz`.

## Ops
- Deploys: push to GitHub `main` → Dokploy builds Dockerfile. Web and collector
  are two Dokploy apps sharing the image and the `podcast-guest-intel-data`
  volume; the collector overrides the container command.
- Admin endpoints exist only when `IMPORT_TOKEN` is set and respond 404 without
  the `x-admin-token` header.
- Tests: `node --experimental-sqlite test/smoke.test.cjs` (pack roundtrip +
  dedupe, feeds schema/seed, live endpoint checks).
