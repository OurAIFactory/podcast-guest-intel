"use strict";
// Continuous, memory-bounded RSS collector. Runs 24/7 as its own service.
// Fetches due feeds, stores gzipped XML into rolling packs + index on the volume,
// re-checks each feed on a refresh interval. Checkpointed in SQLite (resumable).
const cfg = require("./config");
const { assertDurable } = require("./durability_guard");
const feeds = require("./feeds");
const packwriter = require("./packwriter");
const fs = require("fs").promises;

assertDurable(cfg.DATA_DIR, cfg.DEPLOY_MODE);
const CONC = Number(process.env.COLLECTOR_CONCURRENCY || 24);
const TIMEOUT = Number(process.env.COLLECTOR_TIMEOUT_MS || 15000);
const MAXBYTES = Number(process.env.COLLECTOR_MAX_MB || 20) * 1024 * 1024;
const REFRESH_MS = Number(process.env.COLLECTOR_REFRESH_HOURS || 168) * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = feeds.open();
const packs = packwriter.init();
// Minimal health/stats server: satisfies the container HEALTHCHECK and exposes live progress.
let statsCache = { at: 0, body: null };
require("node:http").createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
  if (req.url === "/stats") {
    try {
      if (Date.now() - statsCache.at > 15000) {
        statsCache.body = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(status='done'),0) done, COALESCE(SUM(status IN('pending','retry')),0) pending, COALESCE(SUM(status='failed'),0) failed FROM feeds").get();
        statsCache.at = Date.now();
      }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(statsCache.body));
    } catch (e) { res.writeHead(500); return res.end(String(e.message)); }
  }
  res.writeHead(404); res.end();
}).listen(cfg.PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "collector health/stats listening", port: cfg.PORT })));

const pick = db.prepare("SELECT url,sha,etag,last_modified FROM feeds WHERE status IN('pending','retry','done') AND next_at<=? ORDER BY next_at LIMIT ?");
const mark = db.prepare("UPDATE feeds SET status=?,attempts=attempts+1,http_status=?,last_error=?,sha=COALESCE(?,sha),checked_at=?,next_at=?,etag=COALESCE(?,etag),last_modified=COALESCE(?,last_modified) WHERE url=?");

async function fetchOne(row) {
  const url = row.url;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  const now = () => new Date().toISOString();
  try {
    const headers = { "user-agent": "PodcastRSSCollector/1.0", accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5", "accept-encoding": "gzip" };
    // Conditional GET: unchanged feeds answer 304 with no body — near-free refresh.
    if (row.etag) headers["if-none-match"] = row.etag;
    else if (row.last_modified) headers["if-modified-since"] = row.last_modified;
    const r = await fetch(url, { redirect: "follow", signal: c.signal, headers });
    const next = Date.now() + REFRESH_MS + Math.floor(Math.random()*REFRESH_MS*0.1);
    if (r.status === 304) { mark.run("done", 304, null, null, now(), next, null, null, url); return; }
    if (!r.ok) { const perm = r.status >= 400 && r.status < 500 && r.status !== 429; mark.run(perm ? "failed" : "retry", r.status, `http_${r.status}`, null, now(), perm ? next : Date.now() + 3600e3, null, null, url); return; }
    const contentLength = r.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAXBYTES) { mark.run("failed", r.status, "too_large", null, now(), next, null, null, url); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAXBYTES) { mark.run("failed", r.status, "too_large", null, now(), next, null, null, url); return; }
    if (!/<(rss|feed|rdf)/i.test(buf.subarray(0, 2000).toString("utf8"))) { mark.run("failed", r.status, "not_feed", null, now(), next, null, null, url); return; }
    try {
      const sha = packs.store(url, buf); // content-addressed; dedupes identical content
      mark.run("done", r.status, null, sha, now(), next, r.headers.get("etag"), r.headers.get("last-modified"), url);
    } catch (e) {
      if (e.message.includes("disk_full")) {
        mark.run("retry", r.status, "disk_full", null, now(), Date.now() + 6*3600e3, null, null, url);
      } else {
        throw e;
      }
    }
  } catch (e) {
    mark.run("retry", 0, String(e.message || e).slice(0, 120), null, now(), Date.now() + 3600e3, null, null, url);
  } finally { clearTimeout(t); }
}

async function loop() {
  let batchCounter = 0;
  for (;;) {
    const rows = pick.all(Date.now(), 400);
    if (!rows.length) { await sleep(15000); continue; }
    const stats = await fs.statfs(cfg.DATA_DIR);
    if (stats.bavail * stats.bsize < 3 * 1024 * 1024 * 1024) {
      console.log(JSON.stringify({ msg: "disk_low_paused" }));
      await sleep(10 * 60 * 1000);
      continue;
    }
    let i = 0;
    const worker = async () => { while (i < rows.length) { await fetchOne(rows[i++]); } };
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
    if (batchCounter++ % 10 === 0) {
      const s = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(status='done'),0) done, COALESCE(SUM(status IN('pending','retry')),0) pending FROM feeds").get();
      console.log(JSON.stringify({ msg: "progress", total: s.n, stored: s.done, pending: s.pending }));
    }
  }
}
process.on("SIGTERM", () => { try { packs.close(); } catch {} process.exit(0); });
(async () => {
  const added = await feeds.seedFromFile(db);
  console.log(JSON.stringify({ msg: "seed_done", added }));
  loop().catch((e) => { console.error("[FATAL]", e.stack || e); process.exit(1); });
})();
