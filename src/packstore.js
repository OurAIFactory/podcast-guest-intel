"use strict";
// Reads a single feed's XML out of the big pack files using the SQLite index.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const cfg = require("./config");

let idx;
function index() {
  if (idx === undefined) { try { idx = new DatabaseSync(cfg.XML_INDEX_DB, { readOnly: true }); } catch { idx = null; } }
  return idx;
}

async function getXml(sha) {
  const i = index();
  if (!i) return null;
  const row = i.prepare("SELECT pack,offset,length,compression FROM xml_index WHERE sha=?").get(String(sha).toLowerCase());
  if (!row) return null;
  const packPath = path.join(cfg.PACKS_DIR, `pack_${row.pack.toString(16)}.bin`);
  const fd = fs.openSync(packPath, "r");
  try {
    const b = Buffer.alloc(row.length);
    fs.readSync(fd, b, 0, row.length, row.offset);
    return row.compression === "gzip" ? zlib.gunzipSync(b) : b;
  } finally { fs.closeSync(fd); }
}
module.exports = { getXml };
