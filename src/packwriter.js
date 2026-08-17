"use strict";
// Append-mode rolling pack writer for the live collector. Writes gzipped feed
// XML into pack_<id>.bin (rolling at PACK_CAP_BYTES) and records offsets in the
// shared xml_index.db, so the web tier reads them back the same way as the
// migrated historical packs.
//
// Content-addressed: entries are keyed by sha256 of the XML CONTENT (matching
// the migrated packs), so refreshed feeds with new episodes are archived as new
// entries while identical content is deduplicated across feeds and time.
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
  // live packs start at id 256 so they never collide with the migrated 0..15 packs
  const last = db.prepare("SELECT pack,size FROM pack_meta WHERE pack>=256 ORDER BY pack DESC LIMIT 1").get();
  let cur = last && last.size < CAP ? { id: last.pack, size: last.size } : { id: last ? last.pack + 1 : 256, size: 0 };
  let fd = null, fdId = -1;
  function packFd(id) {
    if (fd !== null && fdId === id) return fd;
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    fd = fs.openSync(path.join(cfg.PACKS_DIR, `pack_${id.toString(16)}.bin`), "a");
    fdId = id;
    return fd;
  }
  // Returns the content sha; writes only when this exact content is new.
  function store(_url, xmlBuf) {
    const sha = crypto.createHash("sha256").update(xmlBuf).digest("hex");
    if (hasStmt.get(sha)) return sha; // dedupe: identical content already archived
    const gz = zlib.gzipSync(xmlBuf, { level: 6 });
    if (cur.size >= CAP) { metaStmt.run(cur.id, cur.size); cur = { id: cur.id + 1, size: 0 }; }
    const f = packFd(cur.id);
    const off = fs.fstatSync(f).size;
    fs.writeSync(f, gz, 0, gz.length, off);
    insStmt.run(sha, cur.id, off, gz.length, 0, "gzip");
    cur.size = off + gz.length;
    metaStmt.run(cur.id, cur.size);
    return sha;
  }
  function close() { try { if (fd !== null) fs.closeSync(fd); } catch {} try { db.close(); } catch {} }
  return { store, close };
}
module.exports = { init };
