"use strict";
// Refuses to boot in production if DATA_DIR is not on a real mounted volume,
// so user data can never be written to disposable container storage.
const fs = require("node:fs");
const path = require("node:path");

function isMount(p) {
  try {
    let cur = path.resolve(p);
    while (!fs.existsSync(cur)) { const par = path.dirname(cur); if (par === cur) return false; cur = par; }
    let dev = fs.statSync(cur).dev;
    let parent = path.dirname(cur);
    while (parent !== cur) {
      if (!fs.existsSync(parent)) break;
      if (fs.statSync(parent).dev !== dev) return true; // device boundary => mount point
      cur = parent; parent = path.dirname(cur);
    }
    return false;
  } catch { return false; }
}

function assertDurable(dataDir, mode) {
  if (mode === "local") return;
  const problems = [];
  if (dataDir.startsWith("/tmp")) problems.push(`DATA_DIR under /tmp (ephemeral): ${dataDir}`);
  if (!isMount(dataDir)) problems.push(`DATA_DIR is not on a mounted volume: ${dataDir}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const m = path.join(dataDir, ".durability_probe");
    fs.writeFileSync(m, "ok"); fs.readFileSync(m); fs.rmSync(m);
  } catch (e) { problems.push(`DATA_DIR not writable: ${e.message}`); }
  if (problems.length) {
    for (const p of problems) console.error("DURABILITY GUARD:", p);
    console.error("Refusing to start: user data would be written to disposable storage.");
    process.exit(1);
  }
  console.log("Durability guard OK:", dataDir);
}
module.exports = { assertDurable, isMount };
