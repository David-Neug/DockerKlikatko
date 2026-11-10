"use strict";

const fs = require("fs");
const path = require("path");

const BUILD_INFO_FILE = "build-info.json";

// Čas sestavení zapisuje scripts/afterPack.js. Starší build bez souboru vezme čas změny app.asar.
function readBuildInfo(app) {
  const info = { version: app.getVersion(), packaged: app.isPackaged, builtAt: null };
  if (!app.isPackaged)
    return info;

  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, BUILD_INFO_FILE), "utf8"));
    const builtAt = Date.parse(parsed.builtAt);
    if (!Number.isNaN(builtAt))
      return { ...info, builtAt };
  } catch {
    // Soubor chybí nebo je poškozený.
  }

  try {
    return { ...info, builtAt: fs.statSync(path.join(process.resourcesPath, "app.asar")).mtimeMs };
  } catch {
    return info;
  }
}

module.exports = { readBuildInfo };
