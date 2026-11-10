"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("../Process/processRunner");
const { readJsonValues, prop, parseDockerTime } = require("./dockerJson");
const { createDockerCli, runDockerCommand } = require("./dockerCli");
const wslCli = require("../Wsl/wslCli");

const MINUTE = 60000;
const INSPECT_CHUNK = 100;
const REMOVE_CHUNK = 50;
const NONE = "<none>";
const SIZE_UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
const VERSION_LABELS = ["app.version", "mssql.version", "com.microsoft.version", "org.opencontainers.image.version"];
const LXSS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";

const SAFE = "safe";
const ON_REQUEST = "request";
const IN_USE = "inUse";

const REASON_LEVELS = {
  imageUsed: IN_USE,
  imageOldVersion: SAFE,
  imageCompose: ON_REQUEST,
  imageOtherTag: ON_REQUEST,
  imageUnused: ON_REQUEST,
  containerRunning: IN_USE,
  containerStopped: ON_REQUEST,
  volumeUsed: IN_USE,
  volumeOrphanAnonymous: SAFE,
  volumeComposeNamed: ON_REQUEST,
  volumeNamed: ON_REQUEST,
  buildCache: SAFE,
  buildCacheUsed: IN_USE
};

const REMOVE_COMMANDS = {
  container: targets => ["rm", ...targets],
  image: targets => ["image", "rm", ...targets],
  volume: targets => ["volume", "rm", ...targets]
};

let servicesCache = null;

function parseSize(text) {
  const match = /^\s*(?<value>\d+(?:\.\d+)?)\s*(?<unit>[a-z]+)\s*$/i.exec(text ?? "");
  if (!match)
    return 0;
  const factor = SIZE_UNITS[match.groups.unit.toLowerCase()];
  return factor ? Math.round(Number.parseFloat(match.groups.value) * factor) : 0;
}

// Časy v "docker system df" mají tvar "2026-10-15 13:57:16 +0200 CEST".
function parseDfTime(text) {
  const match = /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2})(?:\.\d+)? (?<hours>[+-]\d{2})(?<minutes>\d{2})/.exec(text ?? "");
  if (!match)
    return null;
  const parsed = Date.parse(`${match.groups.date}T${match.groups.time}${match.groups.hours}:${match.groups.minutes}`);
  return Number.isNaN(parsed) ? null : parsed;
}

function labelsOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function versionOf(labels) {
  for (const name of VERSION_LABELS) {
    const value = labels[name];
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
  }
  return null;
}

function stripSha(id) {
  return (id ?? "").toLowerCase().replace(/^sha256:/, "");
}

function normalizeRepository(image) {
  let value = (image ?? "").trim().toLowerCase();
  const digest = value.indexOf("@");
  if (digest >= 0)
    value = value.slice(0, digest);
  if (value.lastIndexOf(":") > value.lastIndexOf("/"))
    value = value.slice(0, value.lastIndexOf(":"));
  for (const prefix of ["docker.io/library/", "docker.io/"]) {
    if (value.startsWith(prefix))
      return value.slice(prefix.length);
  }
  return value;
}

function normalizeReference(image) {
  const value = (image ?? "").trim().toLowerCase().split("@")[0];
  const tag = value.lastIndexOf(":") > value.lastIndexOf("/") ? value.slice(value.lastIndexOf(":") + 1) : "latest";
  return `${normalizeRepository(value)}:${tag}`;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function createRunner(composePath, signal) {
  const docker = composePath && isFile(composePath) ? createDockerCli(composePath) : null;
  return {
    docker,
    exec: (args, timeoutMs, onLine) => runDockerCommand(docker?.workingDirectory, args, signal, timeoutMs, onLine)
  };
}

// "docker inspect" vypíše nalezené objekty i tehdy, když některý mezitím zmizel a příkaz skončí chybou.
async function inspectAll(exec, kind, names) {
  const items = [];
  for (const part of chunks(names, INSPECT_CHUNK)) {
    const result = await exec([kind, "inspect", ...part], 2 * MINUTE);
    items.push(...readJsonValues(result.stdOut).filter(item => item && typeof item === "object"));
  }
  return items;
}

function readContainers(dfContainers, inspected) {
  const byId = new Map(inspected.map(item => [stripSha(prop(item, "Id")), item]));
  return dfContainers.map(row => {
    const id = stripSha(prop(row, "ID"));
    const info = byId.get(id) ?? {};
    const labels = labelsOf(info.Config?.Labels);
    const mounts = Array.isArray(info.Mounts) ? info.Mounts : [];
    return {
      id,
      name: (prop(row, "Names") ?? prop(info, "Name") ?? id.slice(0, 12)).replace(/^\/+/, ""),
      image: prop(row, "Image") ?? "",
      imageId: stripSha(prop(info, "Image")),
      state: (prop(row, "State") ?? prop(info.State, "Status") ?? "").toLowerCase(),
      status: prop(row, "Status") ?? "",
      sizeBytes: parseSize(prop(row, "Size")),
      createdAt: parseDockerTime(prop(info, "Created")) ?? parseDfTime(prop(row, "CreatedAt")),
      project: labels["com.docker.compose.project"] ?? null,
      service: labels["com.docker.compose.service"] ?? null,
      volumes: mounts.filter(mount => prop(mount, "Type") === "volume").map(mount => ({
        name: prop(mount, "Name"),
        destination: prop(mount, "Destination")
      }))
    };
  });
}

function isActiveContainer(container) {
  return ["running", "restarting", "paused", "removing"].includes(container.state);
}

function createContext(project, services, containers) {
  const serviceByName = new Map(services.map(service => [service.name.toLowerCase(), service]));
  const servicesByRepository = new Map();
  const referenceByService = new Map();
  for (const service of services) {
    // Sestavený image bez "image:" pojmenuje compose <projekt>-<služba>.
    const reference = service.image && service.image.trim().length > 0
      ? service.image
      : service.usesBuild && project ? `${project}-${service.name}` : null;
    if (!reference)
      continue;
    const repository = normalizeRepository(reference);
    if (!servicesByRepository.has(repository))
      servicesByRepository.set(repository, []);
    servicesByRepository.get(repository).push(service);
    referenceByService.set(service.name, normalizeReference(reference));
  }

  // Repozitář sdílený více službami (např. společný runtime image) nejde přiřadit jedné službě.
  function serviceByRepository(repository) {
    const found = servicesByRepository.get(normalizeRepository(repository)) ?? [];
    return found.length === 1 ? found[0] : null;
  }

  function sharingServices(repository) {
    return (servicesByRepository.get(normalizeRepository(repository)) ?? []).map(service => service.name);
  }

  // Služba kontejneru z labelů compose; jen když patří k načtenému projektu.
  function composeService(labelProject, labelService) {
    if (!labelService || (project && labelProject && labelProject !== project))
      return null;
    return serviceByName.get(labelService.toLowerCase()) ?? null;
  }

  const containersByImage = new Map();
  const containersByVolume = new Map();
  for (const container of containers) {
    container.serviceName = composeService(container.project, container.service)?.name ?? null;
    if (!containersByImage.has(container.imageId))
      containersByImage.set(container.imageId, []);
    containersByImage.get(container.imageId).push(container);
    for (const volume of container.volumes) {
      if (!containersByVolume.has(volume.name))
        containersByVolume.set(volume.name, []);
      containersByVolume.get(volume.name).push(container);
    }
  }

  return { project, serviceByRepository, sharingServices, referenceByService, composeService, containersByImage, containersByVolume };
}

function userOf(container) {
  return { name: container.name, running: isActiveContainer(container), serviceName: container.serviceName };
}

function digestRepository(info) {
  const digests = Array.isArray(info.RepoDigests) ? info.RepoDigests : [];
  const first = digests.find(item => typeof item === "string" && item.includes("@"));
  return first ? first.slice(0, first.indexOf("@")) : null;
}

function imageReason(reference, usedByContainer, composeServices, sharedBy) {
  if (usedByContainer)
    return "imageUsed";
  if (!reference)
    return "imageOldVersion";
  if (composeServices.length > 0)
    return "imageCompose";
  return sharedBy.length > 0 ? "imageOtherTag" : "imageUnused";
}

function readImages(dfImages, inspected, context) {
  const infoById = new Map(inspected.map(item => [stripSha(prop(item, "Id")), item]));
  const tagCounts = new Map();
  for (const row of dfImages) {
    const id = stripSha(prop(row, "ID"));
    const tagged = prop(row, "Repository") !== NONE && prop(row, "Tag") !== NONE;
    tagCounts.set(id, (tagCounts.get(id) ?? 0) + (tagged ? 1 : 0));
  }

  const items = new Map();
  for (const row of dfImages) {
    const id = stripSha(prop(row, "ID"));
    const repo = prop(row, "Repository");
    const tag = prop(row, "Tag");
    const tagged = repo !== NONE && tag !== NONE;
    const reference = tagged ? `${repo}:${tag}` : null;
    const key = "image:" + (reference ?? id);
    if (items.has(key))
      continue;

    const info = infoById.get(id) ?? {};
    const labels = labelsOf(info.Config?.Labels);
    const repository = repo !== NONE ? repo : digestRepository(info);
    const users = (context.containersByImage.get(id) ?? []).map(userOf);
    const labelService = context.composeService(labels["com.docker.compose.project"], labels["com.docker.compose.service"]);
    const userServices = [...new Set(users.map(user => user.serviceName).filter(Boolean))];
    const sharedBy = repository ? context.sharingServices(repository) : [];
    const composeServices = reference
      ? [...context.referenceByService].filter(([, item]) => item === normalizeReference(reference)).map(([name]) => name)
      : [];
    const serviceName = labelService?.name
      ?? (userServices.length === 1 ? userServices[0] : null)
      ?? (composeServices.length === 1 ? composeServices[0] : null)
      ?? (repository ? context.serviceByRepository(repository)?.name : null)
      ?? null;
    const usedByContainer = users.length > 0 || (Number.parseInt(prop(row, "Containers") ?? "0", 10) || 0) > 0;
    const reason = imageReason(reference, usedByContainer, composeServices, sharedBy);
    const composeReference = serviceName ? context.referenceByService.get(serviceName) ?? null : null;
    const knownRepository = repository ?? composeReference?.slice(0, composeReference.lastIndexOf(":")) ?? NONE;

    items.set(key, {
      key,
      kind: "image",
      reason,
      level: REASON_LEVELS[reason],
      removeTarget: reference ?? id,
      title: reference ?? `${knownRepository} · stará verze · ${id.slice(0, 12)}`,
      imageId: id,
      shortId: id.slice(0, 12),
      repository,
      tag: tagged ? tag : null,
      version: versionOf(labels),
      serviceName,
      foreignService: !serviceName && labels["com.docker.compose.service"]
        ? `${labels["com.docker.compose.project"] ?? "?"}/${labels["com.docker.compose.service"]}`
        : null,
      composeServices,
      sharedBy,
      composeReference,
      users,
      tagCount: tagCounts.get(id) ?? 0,
      createdAt: parseDockerTime(prop(info, "Created")) ?? parseDfTime(prop(row, "CreatedAt")),
      sizeBytes: parseSize(prop(row, "Size")),
      uniqueBytes: parseSize(prop(row, "UniqueSize")),
      sharedBytes: parseSize(prop(row, "SharedSize"))
    });
  }
  return [...items.values()];
}

function readContainerItems(containers) {
  return containers.map(container => {
    const reason = isActiveContainer(container) ? "containerRunning" : "containerStopped";
    return {
      key: "container:" + container.id,
      kind: "container",
      reason,
      level: REASON_LEVELS[reason],
      removeTarget: container.id,
      title: container.name,
      image: container.image,
      state: container.state,
      status: container.status,
      serviceName: container.serviceName,
      foreignService: !container.serviceName && container.service ? `${container.project ?? "?"}/${container.service}` : null,
      anonymousVolumes: container.volumes.filter(volume => /^[0-9a-f]{64}$/i.test(volume.name ?? "")).length,
      volumes: container.volumes,
      createdAt: container.createdAt,
      sizeBytes: container.sizeBytes,
      reclaimBytes: container.sizeBytes
    };
  });
}

function volumeReason(users, links, anonymous, composeVolume) {
  if (users.length > 0 || links > 0)
    return "volumeUsed";
  if (anonymous)
    return "volumeOrphanAnonymous";
  return composeVolume ? "volumeComposeNamed" : "volumeNamed";
}

function readVolumes(dfVolumes, inspected, context) {
  const infoByName = new Map(inspected.map(item => [prop(item, "Name"), item]));
  return dfVolumes.map(row => {
    const name = prop(row, "Name") ?? "";
    const info = infoByName.get(name) ?? {};
    const labels = labelsOf(info.Labels);
    const users = context.containersByVolume.get(name) ?? [];
    const labelProject = labels["com.docker.compose.project"] ?? null;
    const composeVolume = labels["com.docker.compose.volume"] ?? null;
    const anonymous = "com.docker.volume.anonymous" in labels || (!composeVolume && /^[0-9a-f]{64}$/i.test(name));
    const ownProject = composeVolume && (!context.project || labelProject === context.project);
    const reason = volumeReason(users, Number.parseInt(prop(row, "Links") ?? "0", 10) || 0, anonymous, ownProject);
    const sizeBytes = parseSize(prop(row, "Size"));
    return {
      key: "volume:" + name,
      kind: "volume",
      reason,
      level: REASON_LEVELS[reason],
      removeTarget: name,
      title: anonymous ? name.slice(0, 12) : name,
      name,
      anonymous,
      composeProject: labelProject,
      composeVolume,
      mountpoint: prop(info, "Mountpoint") ?? prop(row, "Mountpoint"),
      users: users.map(userOf),
      destinations: users.flatMap(user => user.volumes.filter(volume => volume.name === name).map(volume => volume.destination)),
      serviceName: users.map(user => user.serviceName).find(Boolean) ?? null,
      createdAt: parseDockerTime(prop(info, "CreatedAt")),
      sizeBytes,
      reclaimBytes: sizeBytes
    };
  });
}

// Sdílené záznamy jsou vrstvy, které patří i obrazům. Jejich smazáním se nic neuvolní, proto se nepočítají.
function readBuildCache(entries) {
  const parsed = entries.map(entry => ({
    description: prop(entry, "Description") ?? "",
    type: prop(entry, "CacheType") ?? "",
    inUse: prop(entry, "InUse") === "true",
    shared: prop(entry, "Shared") === "true",
    sizeBytes: parseSize(prop(entry, "Size")),
    createdAt: parseDfTime(prop(entry, "CreatedAt")),
    lastUsedAt: parseDfTime(prop(entry, "LastUsedAt"))
  })).filter(entry => !entry.shared);
  const unused = parsed.filter(entry => !entry.inUse);
  const used = parsed.filter(entry => entry.inUse);
  const sum = list => list.reduce((total, entry) => total + entry.sizeBytes, 0);
  const largest = list => [...list].sort((left, right) => right.sizeBytes - left.sizeBytes).slice(0, 15);
  const times = unused.map(entry => entry.lastUsedAt ?? entry.createdAt).filter(time => time !== null);

  const items = [];
  if (unused.length > 0) {
    items.push({
      key: "buildCache:unused",
      kind: "buildCache",
      reason: "buildCache",
      level: SAFE,
      title: "Nepoužívaná build cache",
      count: unused.length,
      entries: largest(unused),
      createdAt: times.length > 0 ? Math.max(...times) : null,
      sizeBytes: sum(unused),
      reclaimBytes: sum(unused)
    });
  }
  if (used.length > 0) {
    items.push({
      key: "buildCache:used",
      kind: "buildCache",
      reason: "buildCacheUsed",
      level: IN_USE,
      title: "Build cache právě používaná buildem",
      count: used.length,
      entries: largest(used),
      createdAt: null,
      sizeBytes: sum(used),
      reclaimBytes: 0
    });
  }
  return items;
}

function readSummary(output) {
  const types = { Images: "image", Containers: "container", "Local Volumes": "volume", "Build Cache": "buildCache" };
  return readJsonValues(output).map(row => ({
    kind: types[prop(row, "Type")] ?? prop(row, "Type"),
    total: Number.parseInt(prop(row, "TotalCount") ?? "0", 10) || 0,
    active: Number.parseInt(prop(row, "Active") ?? "0", 10) || 0,
    sizeBytes: parseSize(prop(row, "Size")),
    reclaimableBytes: parseSize((prop(row, "Reclaimable") ?? "").replace(/\s*\(.*\)\s*$/, "")),
    reclaimablePercent: /\((?<percent>\d+)%\)/.exec(prop(row, "Reclaimable") ?? "")?.groups.percent ?? null
  }));
}

async function load(composePath, services, signal) {
  const { docker, exec } = createRunner(composePath, signal);
  const verbose = await exec(["system", "df", "-v", "--format", "json"], 5 * MINUTE);
  const df = readJsonValues(verbose.stdOut).find(item => item && typeof item === "object" && Array.isArray(item.Images));
  if (!df) {
    return {
      success: false,
      error: verbose.success
        ? "Docker nevrátil využití místa ve formátu JSON (docker system df -v --format json). Je potřeba Docker 23 nebo novější."
        : verbose.errorText
    };
  }

  const summary = await exec(["system", "df", "--format", "json"], 5 * MINUTE);
  const project = docker ? await docker.projectName(signal) : null;
  const dfContainers = Array.isArray(df.Containers) ? df.Containers : [];
  const dfImages = Array.isArray(df.Images) ? df.Images : [];
  const dfVolumes = Array.isArray(df.Volumes) ? df.Volumes : [];

  const containers = readContainers(dfContainers, await inspectAll(exec, "container", dfContainers.map(row => prop(row, "ID")).filter(Boolean)));
  const context = createContext(project, services ?? [], containers);
  const images = readImages(dfImages, await inspectAll(exec, "image", [...new Set(dfImages.map(row => prop(row, "ID")).filter(Boolean))]), context);
  const volumes = readVolumes(dfVolumes, await inspectAll(exec, "volume", dfVolumes.map(row => prop(row, "Name")).filter(Boolean)), context);

  return {
    success: true,
    error: "",
    project,
    loadedAt: Date.now(),
    summary: readSummary(summary.stdOut),
    items: [
      ...images,
      ...readContainerItems(containers),
      ...volumes,
      ...readBuildCache(Array.isArray(df.BuildCache) ? df.BuildCache : [])
    ]
  };
}

// Kolik místa uvolní smazání všech vybraných obrazů. Image s více tagy se uvolní až se všemi tagy.
function reclaimOf(items) {
  const imageRows = new Map();
  let total = 0;
  for (const item of items) {
    if (item.kind !== "image") {
      total += item.reclaimBytes ?? 0;
      continue;
    }
    if (!imageRows.has(item.imageId))
      imageRows.set(item.imageId, []);
    imageRows.get(item.imageId).push(item);
  }
  for (const rows of imageRows.values()) {
    if (rows.length >= Math.max(1, rows[0].tagCount))
      total += rows[0].uniqueBytes;
  }
  return total;
}

function summarizeServices(model, services) {
  const result = services.map(service => {
    const own = model.items.filter(item => item.serviceName === service.name);
    const pick = level => own.filter(item => item.level === level);
    const brief = item => ({ kind: item.kind, title: item.title, version: item.version ?? null, reason: item.reason, bytes: reclaimOf([item]), createdAt: item.createdAt });
    const containers = own.filter(item => item.kind === "container");
    // Image sdílený více službami nemá serviceName, patří službě i přes její kontejnery.
    const usedImages = [...new Map(model.items
      .filter(item => item.kind === "image" && item.level === IN_USE &&
        (item.serviceName === service.name || item.users.some(user => user.serviceName === service.name)))
      .map(item => [item.imageId, item])).values()];
    const volumes = own.filter(item => item.kind === "volume");
    const safe = pick(SAFE);
    const request = pick(ON_REQUEST);
    return {
      name: service.name,
      imageBytes: usedImages.reduce((total, item) => total + item.sizeBytes, 0),
      containerBytes: containers.reduce((total, item) => total + item.sizeBytes, 0),
      volumeCount: volumes.length,
      volumeBytes: volumes.reduce((total, item) => total + item.sizeBytes, 0),
      safeBytes: reclaimOf(safe),
      requestBytes: reclaimOf(request),
      safe: safe.map(brief).sort((left, right) => right.bytes - left.bytes),
      request: request.map(brief).sort((left, right) => right.bytes - left.bytes)
    };
  });

  return {
    loadedAt: model.loadedAt,
    services: result,
    safeBytes: reclaimOf(model.items.filter(item => item.level === SAFE)),
    requestBytes: reclaimOf(model.items.filter(item => item.level === ON_REQUEST))
  };
}

async function serviceSpace(composePath, services, maxAgeMs, signal) {
  const key = composePath.toLowerCase();
  if (servicesCache && servicesCache.key === key && Date.now() - servicesCache.model.loadedAt <= maxAgeMs)
    return summarizeServices(servicesCache.model, services);

  const model = await load(composePath, services, signal);
  if (!model.success)
    return { error: model.error, services: [] };
  servicesCache = { key, model };
  return summarizeServices(model, services);
}

function invalidate() {
  servicesCache = null;
}

// Mazání bez --force: Docker sám odmítne vše, co používá nějaký kontejner.
async function remove(composePath, items, signal, onLine) {
  const { exec } = createRunner(composePath, signal);
  const errors = [];
  for (const kind of ["container", "image", "volume"]) {
    const targets = items.filter(item => item.kind === kind).map(item => item.removeTarget);
    for (const part of chunks(targets, REMOVE_CHUNK)) {
      const result = await exec(REMOVE_COMMANDS[kind](part), 10 * MINUTE, onLine);
      if (!result.success)
        errors.push(result.errorText);
    }
  }
  if (items.some(item => item.kind === "buildCache")) {
    const result = await exec(["builder", "prune", "--all", "--force"], 30 * MINUTE, onLine);
    if (!result.success)
      errors.push(result.errorText);
  }
  invalidate();
  return { success: errors.length === 0, errorText: errors.join("\n") };
}

function parseLxss(output) {
  const distros = [];
  let current = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.toUpperCase().startsWith("HKEY_")) {
      current = {};
      distros.push(current);
      continue;
    }
    const match = /^(?<name>\S+)\s+REG_\w+\s+(?<value>.*)$/.exec(line);
    if (match && current)
      current[match.groups.name] = match.groups.value.trim();
  }
  return distros.filter(distro => distro.DistributionName && distro.BasePath);
}

function freeSpace(target) {
  let current = target;
  while (current) {
    try {
      const stats = fs.statfsSync(current);
      return { path: current, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
      const parent = path.dirname(current);
      if (parent === current)
        return null;
      current = parent;
    }
  }
  return null;
}

async function wslDisk(signal) {
  const status = await wslCli.getStatus(signal);
  if (!status.defaultDistro)
    return null;
  const version = await wslCli.getVersion(signal);
  const registry = await run("reg", ["query", LXSS_KEY, "/s"], { signal, timeoutMs: 20000 });
  const distro = parseLxss(registry.stdOut).find(item => item.DistributionName.toLowerCase() === status.defaultDistro.toLowerCase());
  if (!distro)
    return { distro: status.defaultDistro, version, vhdxPath: null, vhdxBytes: null, host: null };

  const vhdxPath = path.join(distro.BasePath.replace(/^\\\\\?\\/, ""), distro.VhdFileName ?? "ext4.vhdx");
  let vhdxBytes = null;
  try {
    vhdxBytes = fs.statSync(vhdxPath).size;
  } catch {
    // Disk může ležet jinde nebo k němu není přístup.
  }
  return { distro: status.defaultDistro, version, vhdxPath, vhdxBytes, host: freeSpace(path.parse(vhdxPath).root) };
}

async function storage(composePath, signal) {
  const { exec } = createRunner(composePath, signal);
  const info = await exec(["info", "--format", "{{json .}}"], MINUTE);
  const item = readJsonValues(info.stdOut)[0] ?? {};
  const rootDir = prop(item, "DockerRootDir");
  const daemonName = prop(item, "Name");
  // Docker Desktop (VM) nebo vzdálený daemon má jiné jméno než tento počítač; jeho disk odsud nejde zjistit.
  const local = !daemonName || daemonName.toLowerCase() === os.hostname().toLowerCase();
  const result = {
    platform: process.platform,
    rootDir,
    driver: prop(item, "Driver"),
    operatingSystem: prop(item, "OperatingSystem"),
    daemonName,
    local,
    wsl: null,
    host: null
  };
  if (!local)
    return result;
  if (process.platform === "win32")
    result.wsl = await wslDisk(signal).catch(() => null);
  else if (rootDir)
    result.host = freeSpace(rootDir);
  return result;
}

module.exports = { load, reclaimOf, serviceSpace, invalidate, remove, storage, SAFE, ON_REQUEST, IN_USE };
