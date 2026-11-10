"use strict";

const fs = require("fs");
const path = require("path");

// Hook electron-builderu: zapíše čas sestavení vedle app.asar, aplikace ho pak ukáže v hlavním okně.
exports.default = async function afterPack(context) {
  const target = path.join(context.appOutDir, "resources", "build-info.json");
  fs.writeFileSync(target, JSON.stringify({ builtAt: new Date().toISOString() }, null, 2));
};
