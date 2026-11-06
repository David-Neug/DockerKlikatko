"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, IS_WINDOWS } = require("../Process/processRunner");

function candidateKeys(registry) {
  const keys = [
    registry,
    "https://" + registry,
    "https://" + registry + "/v1/",
    "https://" + registry + "/v2/",
    "http://" + registry
  ];
  if (registry.toLowerCase() === "docker.io")
    keys.push("https://index.docker.io/v1/");
  return keys;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function findHelper(name) {
  const file = "docker-credential-" + name + (IS_WINDOWS ? ".exe" : "");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.trim().length === 0)
      continue;
    const candidate = path.join(directory.trim(), file);
    if (isFile(candidate))
      return candidate;
  }

  if (!IS_WINDOWS)
    return null;
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const desktop = path.join(programFiles, "Docker", "Docker", "resources", "bin", file);
  return isFile(desktop) ? desktop : null;
}

async function readHelper(program, server) {
  try {
    const result = await run(program, ["get"], { input: server, timeoutMs: 8000 });
    if (!result.success || result.stdOut.trim().length === 0)
      return null;
    const document = JSON.parse(result.stdOut);
    const username = typeof document.Username === "string" ? document.Username : null;
    const secret = typeof document.Secret === "string" ? document.Secret : null;
    if (!username || secret === null)
      return null;
    return Buffer.from(username + ":" + secret, "utf8").toString("base64");
  } catch {
    return null;
  }
}

function findAuth(config, keys) {
  const auths = config.auths;
  if (!auths || typeof auths !== "object")
    return null;
  for (const key of keys) {
    const auth = auths[key]?.auth;
    if (typeof auth === "string" && auth.trim().length > 0)
      return auth;
  }
  return null;
}

function findHelperName(config, keys) {
  const helpers = config.credHelpers;
  if (helpers && typeof helpers === "object") {
    for (const key of keys) {
      const name = helpers[key];
      if (typeof name === "string" && name.trim().length > 0)
        return name;
    }
  }
  return typeof config.credsStore === "string" ? config.credsStore : null;
}

async function tryGetBasic(registry) {
  let config;
  try {
    const configPath = path.join(os.homedir(), ".docker", "config.json");
    if (!isFile(configPath))
      return null;
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }

  const keys = candidateKeys(registry);
  const auth = findAuth(config, keys);
  if (auth)
    return auth;

  const helper = findHelperName(config, keys);
  if (!helper || helper.trim().length === 0)
    return null;

  const program = findHelper(helper);
  if (!program)
    return null;

  for (const key of keys) {
    const basic = await readHelper(program, key);
    if (basic)
      return basic;
  }
  return null;
}

module.exports = { tryGetBasic };
