"use strict";
// Append-mode rolling pack writer for the live collector. Writes gzipped feed
// XML into pack_<id>.bin (rolling at PACK_CAP_BYTES) and records offsets in the
// shared xml_index.db, so the web tier reads them back the same way as the
// migrated historical packs.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const cfg = require("./config");
const CAP = Number(process.env.PACK_CAP_BYTES || 1073741824); // 1 GB per pack

function init() {
  fs.mkdirSync(cfg.PACKS_DIR, { recursive: true });
  const db = new DatabaseSync(cfg.XML_INDEX_DB);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=60000;
    CREATE TABLE IF NOT EXISTS xml_index(sha TEXT PRIMARY KEY,pack INTEGER,offset INTEGER,length INTEGER,partial INTEGER,compression TEXT);
    CREATE TABLE IF NOT EXISTS pack_meta(pack INTEGER PRIMARY KEY,size INTEGER);`);
  const hasStmt = db.prepare("SELECT 1 FROM xml_index WHERE sha=?");
  const insStmt = db.prepare("INSERT OR IGNORE INTO xml_index(sha,pack,offset,length,partial,compression) VALUES(?,?,?,?,?,?)");
  const metaStmt = db.prepare("INSERT OR REPLACE INTO pack_meta(pack,size) VALUES(?,?)");
  const last = db.prepare("SELECT pack,size FROM pack_meta ORDER BY pack DESC LIMIT 1").get();
  // live packs start at id 256 so they never collide with the migrated 0..15 packs
  let cur = last && last.size < CAP ? { id: last.pack, size: last.size } : { id: last ? last.pack + 1 : 256, size: 0 };
  function store(url, xmlBuf) {
    const sha = crypto.createHash("sha256").update(url).digest("hex");
    if (hasStmt.get(sha)) return sha;
    const gz = zlib.gzipSync(xmlBuf, { level: 6 });
    if (cur.size >= CAP) { metaStmt.run(cur.id, cur.size); cur = { id: cur.id + 1, size: 0 }; }
    const packPath = path.join(cfg.PACKS_DIR, `pack_${cur.id.toString(16)}.bin`);
    const fd = fs.openSync(packPath, "a");
    let off;
    try { off = fs.fstatSync(fd).size; fs.writeSync(fd, gz, 0, gz.length, off); } finally { fs.closeSync(fd); }
    insStmt.run(sha, cur.id, off, gz.length, 0, "gzip");
    cur.size = off + gz.length; metaStmt.run(cur.id, cur.size);
    return sha;
  }
  function close() { try { db.close(); } catch {} }
  return { store, close };
}
module.exports = { init };
