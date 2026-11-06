"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { createComposeService, trimEndSlash } = require("./composeService");

// Schéma failsafe vrací všechny skaláry jako text, stejně jako netypové čtení YamlDotNet.
const YAML_OPTIONS = { schema: "failsafe", maxAliasCount: -1 };

function asMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  if (value === null || value === undefined)
    return null;
  if (typeof value === "string")
    return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

function asInt(value) {
  if (typeof value === "number" && Number.isInteger(value))
    return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim()))
    return Number.parseInt(value, 10);
  return null;
}

function isBlank(text) {
  return text === null || text === undefined || text.trim().length === 0;
}

function firstText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (!isBlank(text))
      return text;
  }
  return null;
}

function isFullyQualified(target) {
  if (process.platform === "win32")
    return /^[A-Za-z]:[\\/]/.test(target) || /^[\\/]{2}/.test(target);
  return target.startsWith("/");
}

function toPlatformPath(target) {
  return target.replace(/\//g, path.sep);
}

function readEnvironment(node) {
  const result = new Map();
  const map = asMap(node);
  if (map) {
    for (const [key, value] of Object.entries(map)) {
      const text = asText(value);
      if (text !== null)
        result.set(key.toUpperCase(), text);
    }
    return result;
  }

  for (const item of asList(node)) {
    const text = asText(item);
    if (isBlank(text))
      continue;
    const split = text.indexOf("=");
    if (split <= 0)
      continue;
    result.set(text.slice(0, split).toUpperCase(), text.slice(split + 1));
  }
  return result;
}

function readPackages(node) {
  const text = asText(node);
  if (isBlank(text))
    return [];
  return text
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.toUpperCase().includes("PASSWORD"));
}

function readPort(item) {
  const map = asMap(item);
  if (map) {
    const published = asText(map.published);
    const target = asText(map.target);
    if (!isBlank(published) && !isBlank(target))
      return `${published}:${target}`;

    const entries = Object.entries(map);
    if (entries.length === 1) {
      const [key, raw] = entries[0];
      const value = asText(raw);
      return isBlank(value) ? key : `${key}:${value}`;
    }
  }
  return asText(item);
}

function readPorts(node) {
  const ports = asList(node).map(readPort).filter(text => !isBlank(text));
  return ports.length === 0 ? "—" : ports.join(", ");
}

function readAddresses(networks) {
  const map = asMap(networks);
  if (!map)
    return [];
  return Object.values(map)
    .map(network => asText(asMap(network)?.ipv4_address))
    .filter(address => !isBlank(address));
}

function readVolumeSources(node) {
  return asList(node).map(asText).filter(text => !isBlank(text));
}

function splitVolume(volume) {
  let colon = volume.indexOf(":");
  if (colon < 0)
    return null;
  if (colon === 1)
    colon = volume.indexOf(":", 2);
  if (colon <= 0)
    return null;

  const host = volume.slice(0, colon);
  const container = volume.slice(colon + 1).split(":")[0];
  if (isBlank(host) || isBlank(container))
    return null;
  return { host, container };
}

function readMounts(composeDirectory, volumes) {
  const mounts = [];
  for (const volume of volumes) {
    const mapped = splitVolume(volume);
    if (!mapped)
      continue;
    if (!mapped.host.startsWith(".") && !isFullyQualified(mapped.host))
      continue;

    const host = toPlatformPath(mapped.host);
    const full = isFullyQualified(host) ? host : path.resolve(composeDirectory, host);
    mounts.push({ hostPath: full, containerPath: mapped.container });
  }
  return mounts;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function findStreamDirectory(composeDirectory, drafts) {
  for (const volume of drafts.flatMap(draft => draft.volumes)) {
    const mapped = splitVolume(volume);
    if (!mapped || trimEndSlash(mapped.container) !== "/stream")
      continue;

    const host = toPlatformPath(mapped.host);
    const full = path.isAbsolute(host) ? host : path.resolve(composeDirectory, host);
    if (isDirectory(full))
      return full;
  }

  const fallback = path.join(composeDirectory, "gateway", "stream");
  return isDirectory(fallback) ? fallback : null;
}

function readGatewayForwards(composeFilePath, drafts) {
  const composeDirectory = path.dirname(composeFilePath);
  if (!composeDirectory)
    return [];

  const streamDirectory = findStreamDirectory(composeDirectory, drafts);
  if (!streamDirectory)
    return [];

  const forwards = [];
  for (const entry of fs.readdirSync(streamDirectory, { withFileTypes: true })) {
    if (!entry.isFile())
      continue;

    let text;
    try {
      text = fs.readFileSync(path.join(streamDirectory, entry.name), "utf8");
    } catch {
      continue;
    }

    text = text.replace(/#[^\r\n]*/g, "");
    for (const server of text.matchAll(/server\s*\{([^{}]*)\}/gs)) {
      const body = server[1];
      const listen = /listen\s+(\d+)\s*;/.exec(body);
      const proxy = /proxy_pass\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s*;/.exec(body);
      if (!listen || !proxy)
        continue;
      forwards.push({
        listenPort: Number.parseInt(listen[1], 10),
        targetIp: proxy[1],
        targetPort: Number.parseInt(proxy[2], 10)
      });
    }
  }
  return forwards;
}

function toService(draft, forwards, mounts) {
  const endpoints = forwards
    .filter(forward => draft.addresses.includes(forward.targetIp))
    .sort((left, right) => {
      const rank = forward => (forward.targetPort === 1433 || forward.targetPort === 27017 ? 0 : 1);
      return rank(left) - rank(right) || left.listenPort - right.listenPort;
    })
    .map(forward => ({ listenPort: forward.listenPort, target: forward.targetIp + ":" + forward.targetPort }));

  return createComposeService({
    name: draft.name,
    image: draft.image,
    buildContext: draft.buildContext,
    versionLabel: draft.versionLabel,
    appName: draft.appName,
    memoryLimit: draft.memoryLimit,
    portsText: draft.portsText,
    endpoints,
    replicas: draft.replicas,
    packages: draft.packages,
    mounts
  });
}

function parseYaml(composeFilePath) {
  try {
    return YAML.parse(fs.readFileSync(composeFilePath, "utf8"), YAML_OPTIONS);
  } catch (error) {
    if (error instanceof YAML.YAMLError)
      throw new Error(`Soubor docker-compose nejde načíst: ${error.message}`);
    throw error;
  }
}

function read(composeFilePath) {
  if (!fs.existsSync(composeFilePath) || !fs.statSync(composeFilePath).isFile())
    throw new Error("Soubor docker-compose neexistuje.");

  const document = asMap(parseYaml(composeFilePath));
  if (!document || !Object.prototype.hasOwnProperty.call(document, "services"))
    throw new Error("V souboru docker-compose chybí sekce services.");

  const services = asMap(document.services);
  if (!services)
    throw new Error("Sekce services v docker-compose není platná.");

  const drafts = [];
  for (const [name, value] of Object.entries(services)) {
    const spec = asMap(value);
    if (!spec)
      continue;

    const labels = asMap(spec.labels);
    const environment = readEnvironment(spec.environment);
    const buildMap = asMap(spec.build);
    const buildArgs = buildMap ? asMap(buildMap.args) : null;
    const deploy = asMap(spec.deploy);

    drafts.push({
      name,
      image: asText(spec.image),
      buildContext: buildMap ? asText(buildMap.context) : asText(spec.build),
      versionLabel: firstText(
        labels?.["app.version"],
        labels?.["mssql.version"],
        environment.get("APP_VERSION"),
        buildArgs?.MSSQL_BASE_IMAGE_TAG),
      appName: environment.get("APP_NAME") ?? null,
      memoryLimit: asText(spec.mem_limit),
      portsText: readPorts(spec.ports),
      replicas: asInt(deploy?.replicas),
      packages: readPackages(buildArgs?.DACPAC_REFS),
      addresses: readAddresses(spec.networks),
      volumes: readVolumeSources(spec.volumes)
    });
  }

  const forwards = readGatewayForwards(composeFilePath, drafts);
  const composeDirectory = path.dirname(path.resolve(composeFilePath));
  return drafts.map(draft => toService(draft, forwards, readMounts(composeDirectory, draft.volumes)));
}

module.exports = { read };
