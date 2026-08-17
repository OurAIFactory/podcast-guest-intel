"use strict";
// Continuous, memory-bounded RSS collector. Runs 24/7 as its own service.
// Fetches due feeds, stores gzipped XML into rolling packs + index on the volume,
// re-checks each feed on a refresh interval. Checkpointed in SQLite (resumable).
const cfg = require("./config");
const { assertDurable } = require("./durability_guard");
const feeds = require("./feeds");
const packwriter = require("./packwriter");

assertDurable(cfg.DATA_DIR, cfg.DEPLOY_MODE);
const CONC = Number(process.env.COLLECTOR_CONCURRENCY || 24);
const TIMEOUT = Number(process.env.COLLECTOR_TIMEOUT_MS || 15000);
const MAXBYTES = Number(process.env.COLLECTOR_MAX_MB || 20) * 1024 * 1024;
const REFRESH_MS = Number(process.env.COLLECTOR_REFRESH_HOURS || 168) * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = feeds.open();
const packs = packwriter.init();
const seeded = feeds.seedFromFile(db);
if (seeded) console.log(JSON.stringify({ msg: "seeded", added: seeded }));

// Minimal health/stats server: satisfies the container HEALTHCHECK and exposes live progress.
require("node:http").createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
  if (req.url === "/stats") {
    try {
      const s = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(status='done'),0) done, COALESCE(SUM(status IN('pending','retry')),0) pending, COALESCE(SUM(status='failed'),0) failed FROM feeds").get();
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(s));
    } catch (e) { res.writeHead(500); return res.end(String(e.message)); }
  }
  res.writeHead(404); res.end();
}).listen(cfg.PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "collector health/stats listening", port: cfg.PORT })));

const pick = db.prepare("SELECT url FROM feeds WHERE status IN('pending','retry') AND next_at<=? ORDER BY next_at LIMIT ?");
const mark = db.prepare("UPDATE feeds SET status=?,attempts=attempts+1,http_status=?,last_error=?,sha=?,checked_at=?,next_at=? WHERE url=?");

async function fetchOne(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  const now = () => new Date().toISOString();
  try {
    const r = await fetch(url, { redirect: "follow", signal: c.signal, headers: { "user-agent": "PodcastRSSCollector/1.0", accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5" } });
    const next = Date.now() + REFRESH_MS;
    if (!r.ok) { const perm = r.status >= 400 && r.status < 500 && r.status !== 429; mark.run(perm ? "failed" : "retry", r.status, `http_${r.status}`, null, now(), perm ? next : Date.now() + 3600e3, url); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAXBYTES) { mark.run("failed", r.status, "too_large", null, now(), next, url); return; }
    if (!/<(rss|feed|rdf)/i.test(buf.subarray(0, 2000).toString("utf8"))) { mark.run("failed", r.status, "not_feed", null, now(), next, url); return; }
    const sha = packs.store(url, buf);
    mark.run("done", r.status, null, sha, now(), next, url);
  } catch (e) {
    mark.run("retry", 0, String(e.message || e).slice(0, 120), null, now(), Date.now() + 3600e3, url);
  } finally { clearTimeout(t); }
}

async function loop() {
  for (;;) {
    const rows = pick.all(Date.now(), 400);
    if (!rows.length) { await sleep(15000); continue; }
    let i = 0;
    const worker = async () => { while (i < rows.length) { await fetchOne(rows[i++].url); } };
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
    const s = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(status='done'),0) done, COALESCE(SUM(status IN('pending','retry')),0) pending FROM feeds").get();
    console.log(JSON.stringify({ msg: "progress", total: s.n, stored: s.done, pending: s.pending }));
  }
}
process.on("SIGTERM", () => { try { packs.close(); } catch {} process.exit(0); });
loop().catch((e) => { console.error("[FATAL]", e.stack || e); process.exit(1); });
