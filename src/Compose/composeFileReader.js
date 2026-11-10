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
  for (const { volume, directory } of drafts.flatMap(draft => draft.volumes.map(volume => ({ volume, directory: draft.directory })))) {
    const mapped = splitVolume(volume);
    if (!mapped || trimEndSlash(mapped.container) !== "/stream")
      continue;

    const host = toPlatformPath(mapped.host);
    const full = path.isAbsolute(host) ? host : path.resolve(directory, host);
    if (isDirectory(full))
      return full;
  }

  const fallback = path.join(composeDirectory, "gateway", "stream");
  return isDirectory(fallback) ? fallback : null;
}

function readNginxForwards(composeFilePath, drafts) {
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

function findHaproxyConfig(drafts) {
  for (const draft of drafts) {
    for (const mount of readMounts(draft.directory, draft.volumes)) {
      if (mount.containerPath.endsWith("/haproxy.cfg") && fs.existsSync(mount.hostPath) && !isDirectory(mount.hostPath))
        return mount.hostPath;
    }
  }
  return null;
}

// Gateway s HAProxy: frontend/listen (bind *:port) → backend → server IP:port.
function readHaproxyForwards(drafts) {
  const configPath = findHaproxyConfig(drafts);
  if (!configPath)
    return [];

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return [];
  }

  const sections = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const header = /^(frontend|backend|listen|global|defaults|resolvers|peers|userlist)\b\s*(\S*)/.exec(line);
    if (header) {
      current = { kind: header[1], name: header[2], ports: [], backends: [], servers: [] };
      sections.push(current);
      continue;
    }
    if (!current)
      continue;

    const bind = /^bind\s+\S*:(\d+)\b/.exec(line);
    const backend = /^(?:default_backend|use_backend)\s+(\S+)/.exec(line);
    const server = /^server\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\b/.exec(line);
    if (bind)
      current.ports.push(Number.parseInt(bind[1], 10));
    else if (backend)
      current.backends.push(backend[1]);
    else if (server)
      current.servers.push({ targetIp: server[1], targetPort: Number.parseInt(server[2], 10) });
  }

  const backends = new Map(sections.filter(section => section.kind === "backend").map(section => [section.name, section]));
  const forwards = [];
  for (const section of sections.filter(item => item.kind === "frontend" || item.kind === "listen")) {
    const servers = [
      ...section.servers,
      ...section.backends.flatMap(name => backends.get(name)?.servers ?? [])
    ];
    for (const listenPort of section.ports) {
      for (const server of servers)
        forwards.push({ listenPort, ...server });
    }
  }
  return forwards;
}

function readGatewayForwards(composeFilePath, drafts) {
  return [...readNginxForwards(composeFilePath, drafts), ...readHaproxyForwards(drafts)];
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

function readEnvFile(filePath) {
  const variables = {};
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return variables;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    const split = line.indexOf("=");
    if (line.startsWith("#") || split <= 0)
      continue;
    let value = line.slice(split + 1).trim();
    if (/^(["']).*\1$/.test(value))
      value = value.slice(1, -1);
    else
      value = value.replace(/\s+#.*$/, "");
    variables[line.slice(0, split).trim()] = value;
  }
  return variables;
}

function findClosingBrace(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{")
      depth++;
    else if (text[i] === "}" && --depth === 0)
      return i;
  }
  return -1;
}

function resolveVariable(expression, variables) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])(.*))?$/s.exec(expression);
  if (!match)
    return "";

  const [, name, operator, argument = ""] = match;
  const value = variables[name];
  const isSet = value !== undefined && (!operator?.startsWith(":") || value !== "");
  if (operator?.endsWith("+"))
    return isSet ? interpolate(argument, variables) : "";
  if (isSet)
    return value;
  return operator?.endsWith("-") ? interpolate(argument, variables) : "";
}

// Dosazení proměnných jako v docker compose: $$, $VAR, ${VAR}, ${VAR:-výchozí}, ${VAR:?chyba}, ${VAR:+jiná}.
function interpolate(text, variables) {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const dollar = text.indexOf("$", index);
    if (dollar < 0 || dollar === text.length - 1)
      return result + text.slice(index);

    result += text.slice(index, dollar);
    const next = text[dollar + 1];
    if (next === "$") {
      result += "$";
      index = dollar + 2;
    } else if (next === "{") {
      const end = findClosingBrace(text, dollar + 2);
      if (end < 0)
        return result + text.slice(dollar);
      result += resolveVariable(text.slice(dollar + 2, end), variables);
      index = end + 1;
    } else {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(dollar + 1));
      result += name ? resolveVariable(name[0], variables) : "$";
      index = dollar + 1 + (name ? name[0].length : 0);
    }
  }
  return result;
}

function interpolateTree(node, variables) {
  if (typeof node === "string")
    return interpolate(node, variables);
  if (Array.isArray(node))
    return node.map(item => interpolateTree(item, variables));
  const map = asMap(node);
  if (!map)
    return node;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, interpolateTree(value, variables)]));
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

function readIncludes(node, directory) {
  const includes = [];
  for (const item of asList(node)) {
    const map = asMap(item);
    const files = (map ? [map.path].flat() : [item])
      .map(asText)
      .filter(text => !isBlank(text))
      .map(file => path.resolve(directory, toPlatformPath(file)));
    if (files.length === 0)
      continue;

    const projectDirectory = asText(map?.project_directory);
    const envFiles = [map?.env_file].flat().map(asText).filter(text => !isBlank(text));
    includes.push({
      files,
      directory: isBlank(projectDirectory) ? path.dirname(files[0]) : path.resolve(directory, toPlatformPath(projectDirectory)),
      envFiles: envFiles.map(file => path.resolve(directory, toPlatformPath(file)))
    });
  }
  return includes;
}

// Projde soubor i soubory z include: (i vnořené). Relativní cesty v includovaném souboru platí
// vůči jeho složce, proměnné hlavního projektu mají přednost před .env includovaného souboru.
function collectDrafts(filePath, directory, variables, visited, drafts) {
  const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  if (visited.has(key))
    return;
  visited.add(key);

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
    throw new Error(`Soubor docker-compose neexistuje: ${filePath}`);

  const document = asMap(interpolateTree(parseYaml(filePath), variables));
  if (!document)
    throw new Error(`Soubor docker-compose není platný: ${filePath}`);

  for (const include of readIncludes(document.include, path.dirname(filePath))) {
    const envFiles = include.envFiles.length > 0 ? include.envFiles : [path.join(include.directory, ".env")];
    const includeVariables = Object.assign({}, ...envFiles.map(readEnvFile), variables);
    for (const file of include.files)
      collectDrafts(file, include.directory, includeVariables, visited, drafts);
  }

  const services = asMap(document.services);
  if (document.services !== undefined && document.services !== null && !services)
    throw new Error(`Sekce services v docker-compose není platná: ${filePath}`);

  for (const [name, value] of Object.entries(services ?? {})) {
    const spec = asMap(value);
    if (!spec || drafts.some(draft => draft.name === name))
      continue;

    const labels = asMap(spec.labels);
    const environment = readEnvironment(spec.environment);
    const buildMap = asMap(spec.build);
    const buildArgs = buildMap ? asMap(buildMap.args) : null;
    const deploy = asMap(spec.deploy);

    drafts.push({
      name,
      composeFile: filePath,
      directory,
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
}

function readDrafts(composeFilePath) {
  if (!fs.existsSync(composeFilePath) || !fs.statSync(composeFilePath).isFile())
    throw new Error("Soubor docker-compose neexistuje.");

  const fullPath = path.resolve(composeFilePath);
  const composeDirectory = path.dirname(fullPath);
  const variables = { ...readEnvFile(path.join(composeDirectory, ".env")), ...process.env };
  const drafts = [];
  collectDrafts(fullPath, composeDirectory, variables, new Set(), drafts);
  if (drafts.length === 0)
    throw new Error("V souboru docker-compose ani v souborech z include: nejsou žádné služby.");
  return drafts;
}

function read(composeFilePath) {
  const drafts = readDrafts(composeFilePath);
  const forwards = readGatewayForwards(composeFilePath, drafts);
  return drafts.map(draft => toService(draft, forwards, readMounts(draft.directory, draft.volumes)));
}

// Soubor, ve kterém je služba definovaná (u include: jiný než hlavní docker-compose).
function serviceFile(composeFilePath, serviceName) {
  const draft = readDrafts(composeFilePath).find(item => item.name === serviceName);
  if (!draft)
    throw new Error(`V docker-compose není služba ${serviceName}.`);
  return draft.composeFile;
}

module.exports = { read, serviceFile };
