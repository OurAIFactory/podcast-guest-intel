"use strict";
const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const cfg = require("./config");
const { assertDurable, isMount } = require("./durability_guard");
const { getXml } = require("./packstore");

assertDurable(cfg.DATA_DIR, cfg.DEPLOY_MODE);
for (const d of [cfg.DATA_DIR, cfg.IMAGES_DIR]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("etag", false);
require("./admin").mountAdmin(app);

// Liveness: fast, no dependencies.
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/healthz/durability", (_req, res) =>
  res.json({ data_dir: cfg.DATA_DIR, data_dir_is_mount: isMount(cfg.DATA_DIR), ok: true }));

// Cached read-only guests DB: one connection reused across requests,
// invalidated when the file changes (e.g. re-uploaded).
const cache = { db: null, mtime: -1, countStmt: null, rowsStmt: null };
function openDb() {
  let st;
  try { st = fs.statSync(cfg.GUESTS_DB); } catch { return null; }
  if (!cache.db || st.mtimeMs !== cache.mtime) {
    if (cache.db) { try { cache.db.close(); } catch {} cache.db = null; }
    try {
      cache.db = new DatabaseSync(cfg.GUESTS_DB, { readOnly: true });
      cache.db.exec("PRAGMA cache_size=-8000");
      cache.db.exec("PRAGMA temp_store=MEMORY");
      try { cache.db.exec("PRAGMA mmap_size=268435456"); } catch {}
      cache.mtime = st.mtimeMs;
      cache.countStmt = cache.db.prepare("SELECT COUNT(*) n FROM guest_images WHERE min_side>=120 AND name LIKE ?");
      cache.rowsStmt = cache.db.prepare(
        "SELECT person_id,name,role,website,image_file,width,height FROM guest_images WHERE min_side>=120 AND name LIKE ? ORDER BY min_side DESC LIMIT ? OFFSET ?"
      );
    }
    catch { cache.db = null; }
  }
  return cache.db;
}
function dropDb() { if (cache.db) { try { cache.db.close(); } catch {} } cache.db = null; cache.mtime = -1; cache.countStmt = null; cache.rowsStmt = null; }

// Readiness: checks the data store.
app.get("/readyz", (_req, res) => {
  const d = openDb();
  if (!d) return res.status(503).json({ ready: false, reason: "guests db not present yet" });
  try { d.prepare("SELECT 1").get(); res.json({ ready: true }); }
  catch (e) { dropDb(); res.status(503).json({ ready: false, reason: String(e.message) }); }
});

const countCache = new Map();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL = 30000; // 30 seconds

app.get("/api/guests", (req, res) => {
  const d = openDb();
  if (!d) return res.json({ total: 0, rows: [] });
  try {
    const limit = Math.min(200, Number(req.query.limit) || 60);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = String(req.query.q || "").trim();
    let total;
    const cacheKey = q;
    const cached = countCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      total = cached.total;
    } else {
      total = cache.countStmt.get(`%${q}%`).n;
      countCache.set(cacheKey, { total, timestamp: Date.now() });
      if (countCache.size > MAX_CACHE_SIZE) {
        const oldestKey = countCache.keys().next().value;
        countCache.delete(oldestKey);
      }
    }
    const rows = cache.rowsStmt.all(`%${q}%`, limit, offset);
    res.json({ total, rows });
  } catch (e) { dropDb(); res.status(500).json({ error: String(e.message) }); }
});

app.get("/feed/:sha", async (req, res) => {
  try { const buf = await getXml(req.params.sha); if (!buf) return res.status(404).end(); res.type("application/xml").send(buf); }
  catch { res.status(500).end(); }
});

app.use("/images", express.static(cfg.IMAGES_DIR, { maxAge: "7d", fallthrough: true, immutable: true }));
app.use("/", express.static(path.join(__dirname, "..", "public"), { maxAge: "1h" }));

const server = app.listen(cfg.PORT, "0.0.0.0", () =>
  console.log(JSON.stringify({ msg: "listening", port: cfg.PORT, data_dir: cfg.DATA_DIR })));
process.on("SIGTERM", () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
