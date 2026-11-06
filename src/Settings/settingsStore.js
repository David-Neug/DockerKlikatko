"use strict";

const fs = require("fs");
const path = require("path");
const { createDefault, normalize } = require("./appSettings");

const SETTINGS_FILE_NAME = "settings.json";
const SEED_PATH = path.join(__dirname, SETTINGS_FILE_NAME);

function applicationDirectory(app) {
  if (!app.isPackaged)
    return app.getAppPath();
  if (process.env.PORTABLE_EXECUTABLE_DIR)
    return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.env.APPIMAGE)
    return path.dirname(process.env.APPIMAGE);
  return path.dirname(process.execPath);
}

function isWritableDirectory(directory) {
  const probe = path.join(directory, `.klikatko-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveSettingsPath(app) {
  const directory = applicationDirectory(app);
  if (directory && isWritableDirectory(directory))
    return path.join(directory, SETTINGS_FILE_NAME);
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

function readSeed() {
  try {
    return JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  } catch {
    return createDefault();
  }
}

function createSettingsStore(app) {
  const settingsPath = resolveSettingsPath(app);

  function save(settings) {
    const normalized = normalize(settings);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const temporary = settingsPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(temporary, settingsPath);
    return normalized;
  }

  function load() {
    if (!fs.existsSync(settingsPath))
      return save(readSeed());

    try {
      const text = fs.readFileSync(settingsPath, "utf8").replace(/^﻿/, "");
      return normalize(JSON.parse(text) ?? createDefault());
    } catch (error) {
      if (error instanceof SyntaxError)
        return normalize(createDefault());
      throw error;
    }
  }

  return { settingsPath, load, save };
}

module.exports = { createSettingsStore };
