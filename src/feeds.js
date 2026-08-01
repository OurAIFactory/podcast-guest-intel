"use strict";
// Feed queue on the volume. Seeded from DATA_DIR/seed_feeds.txt (one URL per
// line) which is uploaded once; after that the collector runs purely on server.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const cfg = require("./config");

function open() {
  const db = new DatabaseSync(path.join(cfg.DATA_DIR, "feeds.db"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=60000;
    CREATE TABLE IF NOT EXISTS feeds(url TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, http_status INTEGER, last_error TEXT, sha TEXT,
      checked_at TEXT, next_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_feeds_due ON feeds(status,next_at);`);
  return db;
}

function seedFromFile(db) {
  const f = path.join(cfg.DATA_DIR, "seed_feeds.txt");
  if (!fs.existsSync(f)) return 0;
  const ins = db.prepare("INSERT OR IGNORE INTO feeds(url) VALUES(?)");
  let n = 0;
  db.exec("BEGIN");
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const u = line.trim();
    if (/^https?:\/\//i.test(u)) { ins.run(u); n += 1; }
  }
  db.exec("COMMIT");
  return n;
}
module.exports = { open, seedFromFile };
