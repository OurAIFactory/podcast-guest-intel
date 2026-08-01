"use strict";
const path = require("node:path");
const DEPLOY_MODE = process.env.DEPLOY_MODE || "local";
const _default = DEPLOY_MODE === "local" ? path.join(__dirname, "..", "data") : "/app/data";
const DATA_DIR = process.env.APP_DATA_DIR || _default;              // == mounted volume in prod
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(DATA_DIR, "images");
const GUESTS_DB = process.env.GUESTS_DB || path.join(DATA_DIR, "guest_profile_images.db");
const PACKS_DIR = process.env.PACKS_DIR || path.join(DATA_DIR, "xml_packs");
const XML_INDEX_DB = process.env.XML_INDEX_DB || path.join(PACKS_DIR, "xml_index.db");
const PORT = Number(process.env.PORT || 8080);
module.exports = { DEPLOY_MODE, DATA_DIR, IMAGES_DIR, GUESTS_DB, PACKS_DIR, XML_INDEX_DB, PORT };
