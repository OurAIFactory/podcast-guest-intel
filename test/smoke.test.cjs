"use strict";
// Offline smoke test: pack write/read roundtrip + dedupe, feeds schema + seeding,
// and a booted web server answering its endpoints. Run:
//   node --experimental-sqlite test/smoke.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert");
const { spawn } = require("node:child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgi-test-"));
process.env.DEPLOY_MODE = "local";
process.env.APP_DATA_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.PORT = String(18000 + Math.floor(Math.random() * 2000));
delete process.env.IMPORT_TOKEN;

const results = [];
const ok = (name) => { results.push("PASS " + name); console.log("PASS " + name); };

(async () => {
  // 1) packwriter: content-addressed write, dedupe, reader roundtrip
  const packs = require("../src/packwriter").init();
  const xmlA = Buffer.from("<rss><channel><title>A</title></channel></rss>");
  const xmlB = Buffer.from("<rss><channel><title>B</title></channel></rss>");
  const shaA1 = packs.store("https://a.example/feed", xmlA);
  const shaA2 = packs.store("https://elsewhere.example/feed", xmlA); // same content, other URL
  const shaB = packs.store("https://b.example/feed", xmlB);
  assert.strictEqual(shaA1, shaA2, "identical content must dedupe to one sha");
  assert.notStrictEqual(shaA1, shaB, "different content must get different shas");
  packs.close();
  const { getXml } = require("../src/packstore");
  const backA = await getXml(shaA1);
  const backB = await getXml(shaB);
  assert.ok(backA && backA.equals(xmlA), "roundtrip A");
  assert.ok(backB && backB.equals(xmlB), "roundtrip B");
  assert.strictEqual(await getXml("0".repeat(64)), null, "unknown sha -> null");
  ok("packwriter/packstore roundtrip + content dedupe");

  // 2) feeds: schema (incl. validator columns) + streamed seeding
  fs.writeFileSync(path.join(tmp, "seed_feeds.txt"), "https://x.example/1\nnot-a-url\nhttps://x.example/2\nhttps://x.example/1\n");
  const feeds = require("../src/feeds");
  const fdb = feeds.open();
  const added = await feeds.seedFromFile(fdb);
  assert.strictEqual(fdb.prepare("SELECT COUNT(*) n FROM feeds").get().n, 2, "2 unique urls seeded");
  const cols = fdb.prepare("PRAGMA table_info(feeds)").all().map((c) => c.name);
  assert.ok(cols.includes("etag") && cols.includes("last_modified"), "validator columns exist");
  fdb.close();
  ok(`feeds schema + seeding (added=${added})`);

  // 3) server boots and answers endpoints (no guests db -> ready=false, guests empty)
  const srv = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", path.join(__dirname, "..", "src", "server.js")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let sout = ""; srv.stdout.on("data", (d) => (sout += d)); srv.stderr.on("data", (d) => (sout += d));
  const base = "http://127.0.0.1:" + process.env.PORT;
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); try { up = (await fetch(base + "/healthz")).ok; } catch {} }
  assert.ok(up, "server did not come up: " + sout.slice(-400));
  assert.strictEqual((await (await fetch(base + "/healthz")).json()).ok, true, "healthz");
  assert.strictEqual((await fetch(base + "/readyz")).status, 503, "readyz 503 without guests db");
  const g = await (await fetch(base + "/api/guests?limit=5")).json();
  assert.strictEqual(g.total, 0, "guests empty without db");
  const fx = await fetch(base + "/feed/" + shaA1);
  assert.strictEqual(fx.status, 200, "feed serves content-addressed sha");
  assert.strictEqual((await fetch(base + "/admin/diskinfo")).status, 404, "admin hidden without IMPORT_TOKEN");
  srv.kill();
  ok("server endpoints (healthz/readyz/guests/feed/admin-gating)");

  console.log("\nALL_TESTS_PASSED (" + results.length + " groups)");
  process.exit(0);
})().catch((e) => { console.error("TEST_FAILED: " + (e.stack || e)); process.exit(1); });
