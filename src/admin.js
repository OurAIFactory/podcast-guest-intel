"use strict";
// Token-gated admin endpoints for bulk data import + disk introspection.
// Disabled entirely unless IMPORT_TOKEN is set in the environment.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cfg = require("./config");

let importMutex = false;

function mountAdmin(app) {
  const TOKEN = process.env.IMPORT_TOKEN;
  if (!TOKEN) return; // feature-flagged off when no token present
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.get("x-admin-token") !== TOKEN) return res.status(404).end();
    next();
  });

  // Free/used space on the data volume — check BEFORE any large upload.
  router.get("/diskinfo", (_req, res) => {
    fs.statfs(cfg.DATA_DIR, (err, st) => {
      if (err) return res.status(500).json({ error: String(err.message) });
      const total = st.blocks * st.bsize;
      const avail = st.bavail * st.bsize;
      res.json({ data_dir: cfg.DATA_DIR, total_gb: +(total / 1e9).toFixed(1), avail_gb: +(avail / 1e9).toFixed(1), used_gb: +((total - st.bfree * st.bsize) / 1e9).toFixed(1) });
    });
  });

  // Shallow directory listing with sizes — verify what landed after upload.
  router.get("/ls", (req, res) => {
    const rel = String(req.query.path || "").replace(/^\/+/, "");
    if (rel.includes("..")) return res.status(400).end();
    const p = path.join(cfg.DATA_DIR, rel);
    if (!p.startsWith(cfg.DATA_DIR)) return res.status(400).end();
    fs.readdir(p, { withFileTypes: true }, (err, ents) => {
      if (err) return res.status(500).json({ error: String(err.message) });
      let count = 0, bytes = 0; const sample = [];
      for (const e of ents) {
        count++;
        if (e.isFile()) { try { bytes += fs.statSync(path.join(p, e.name)).size; } catch {} }
        if (sample.length < 8) sample.push((e.isDirectory() ? "[d] " : "") + e.name);
      }
      res.json({ path: rel || ".", entries: count, bytes_mb: +(bytes / 1e6).toFixed(1), sample });
    });
  });

  // Streamed bulk import: request body is a gzipped tar, piped straight into
  // `tar -xz -C DATA_DIR`. Constant memory regardless of archive size.
  router.post("/import-tgz", (req, res) => {
    if (importMutex) return res.status(429).json({ ok: false, busy: true });
    importMutex = true;

    // GNU tar -x auto-detects gzip/plain, so the client can stream either.
    const child = spawn("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-C", cfg.DATA_DIR], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.on("error", (e) => { importMutex = false; try { res.status(500).json({ ok: false, error: "spawn:" + e.message }); } catch {} });
    child.on("close", (code) => {
      importMutex = false;
      if (code === 0) res.json({ ok: true }); else res.status(500).json({ ok: false, code, stderr: err.slice(-1200) });
    });
    req.on("error", () => { try { child.kill(); } catch {} });
    req.pipe(child.stdin);
    child.stdin.on("error", () => {});
  });

  // Current size of a file on the volume (for resumable large-file upload).
  router.get("/size", (req, res) => {
    const rel = String(req.query.path || "").replace(/^\/+/, "");
    if (rel.includes("..")) return res.status(400).end();
    const p = path.join(cfg.DATA_DIR, rel);
    if (!p.startsWith(cfg.DATA_DIR)) return res.status(400).end();
    fs.stat(p, (err, st) => res.json({ path: rel, size: err ? 0 : st.size }));
  });

  // Byte-level resumable upload: append (default) or truncate+write a raw chunk.
  // Client checks /size, seeks the local file to that offset, and streams the rest
  // in chunks. Constant memory; survives interruptions.
  router.post("/put", (req, res) => {
    const rel = String(req.query.path || "").replace(/^\/+/, "");
    const p = path.join(cfg.DATA_DIR, rel);
    if (!p.startsWith(cfg.DATA_DIR) || rel.includes("..")) return res.status(400).end();
    if (importMutex) return res.status(429).json({ ok: false, busy: true });
    importMutex = true;
    let released = false;
    const release = () => { if (!released) { released = true; importMutex = false; } };
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    const flags = req.query.mode === "truncate" ? "w" : "a";
    const ws = fs.createWriteStream(p, { flags });
    let bytes = 0;
    req.on("data", (d) => { bytes += d.length; });
    ws.on("error", (e) => { release(); try { res.status(500).json({ ok: false, error: String(e.message) }); } catch {} });
    ws.on("finish", () => {
      release();
      let size = 0; try { size = fs.statSync(p).size; } catch {} res.json({ ok: true, path: rel, wrote: bytes, size });
    });
    req.on("error", () => { release(); try { ws.destroy(); } catch {} });
    res.on("close", release);
    req.pipe(ws);
  });

  app.use("/admin", router);
  console.log(JSON.stringify({ msg: "admin endpoints mounted (import enabled)" }));
}

module.exports = { mountAdmin };
