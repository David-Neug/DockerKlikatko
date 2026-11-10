"use strict";

const os = require("os");
const { run } = require("../Process/processRunner");
const { createResult } = require("../Process/commandResult");
const { readJsonValues, prop, parseDockerTime } = require("./dockerJson");

const DOCKER_ENVIRONMENT = { DOCKER_CLI_HINTS: "false", COMPOSE_ANSI: "never" };
const PROJECT_LABEL = "com.docker.compose.project";
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const CONFIG_FILES_LABEL = "com.docker.compose.project.config_files";
const SERVICE_LABEL = "com.docker.compose.service";
const MAX_RANGE = 1000;
const MINUTE = 60000;

function label(item, name) {
  const value = item?.Config?.Labels?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function hostPorts(item) {
  const ports = new Set();
  const bindings = item?.NetworkSettings?.Ports;
  if (!bindings || typeof bindings !== "object")
    return [];
  for (const list of Object.values(bindings)) {
    if (!Array.isArray(list))
      continue;
    for (const binding of list) {
      const port = Number.parseInt(prop(binding, "HostPort") ?? "", 10);
      if (Number.isInteger(port) && port > 0)
        ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}

function readContainer(item) {
  const name = (prop(item, "Name") ?? "").trim().replace(/^\/+/, "");
  return {
    id: (prop(item, "Id") ?? "").slice(0, 12),
    name,
    project: label(item, PROJECT_LABEL),
    workingDir: label(item, WORKING_DIR_LABEL),
    configFiles: label(item, CONFIG_FILES_LABEL),
    service: label(item, SERVICE_LABEL),
    image: prop(item?.Config, "Image") ?? "",
    state: prop(item?.State, "Status") ?? "",
    health: prop(item?.State?.Health, "Status") ?? "",
    startedAt: parseDockerTime(prop(item?.State, "StartedAt")),
    ports: hostPorts(item)
  };
}

// Pracovní složka bez docker-compose, aby compose -p nenačetl cizí soubor a nezúžil projekt na jeho služby.
function runDocker(args, signal, timeoutMs, onProgress) {
  return run("docker", args, { cwd: os.tmpdir(), signal, timeoutMs, env: DOCKER_ENVIRONMENT, onLine: onProgress });
}

async function runningContainers(signal) {
  const ps = await runDocker(["ps", "-q", "--no-trunc"], signal, 20000);
  if (!ps.success)
    throw new Error(ps.errorText);
  const ids = ps.stdOut.split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
  if (ids.length === 0)
    return [];

  const inspect = await runDocker(["inspect", ...ids], signal, 30000);
  if (!inspect.success)
    throw new Error(inspect.errorText);
  return readJsonValues(inspect.stdOut)
    .filter(item => item && typeof item === "object")
    .map(readContainer);
}

// Kontejnery bez compose labelu tvoří jeden společný řádek s prázdným názvem projektu.
function groupByProject(containers) {
  const projects = new Map();
  for (const container of containers) {
    const key = container.project;
    if (!projects.has(key))
      projects.set(key, { name: key, workingDir: container.workingDir, configFiles: container.configFiles, containers: [] });
    projects.get(key).containers.push(container);
  }
  return [...projects.values()]
    .map(project => ({
      ...project,
      containers: project.containers.sort((left, right) => left.name.localeCompare(right.name)),
      ports: [...new Set(project.containers.flatMap(container => container.ports))].sort((left, right) => left - right)
    }))
    .sort((left, right) => (left.name === "") - (right.name === "") || left.name.localeCompare(right.name));
}

async function list(signal) {
  return groupByProject(await runningContainers(signal));
}

function expandRange(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!match)
    return [];
  const first = Number.parseInt(match[1], 10);
  const last = match[2] ? Number.parseInt(match[2], 10) : first;
  if (last < first || last - first > MAX_RANGE)
    return [first];
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

// Z "8091:8091", "127.0.0.1:80:18880", "8000-8005:8000-8005/tcp" vrací porty na hostu.
// Samotný port kontejneru ("3000") se publikuje na náhodný port, ten konflikt nedělá.
function publishedPorts(portsText) {
  const ports = new Set();
  for (const token of String(portsText ?? "").split(",")) {
    const parts = token.trim().replace(/\/[a-z]+$/i, "").split(":");
    if (parts.length < 2)
      continue;
    for (const port of expandRange(parts[parts.length - 2]))
      ports.add(port);
  }
  return ports;
}

function requiredPorts(services) {
  const ports = new Map();
  for (const service of services) {
    for (const port of publishedPorts(service.portsText)) {
      if (!ports.has(port))
        ports.set(port, service.name);
    }
  }
  return ports;
}

// Projekty (jiné než ownProject), které na hostu drží porty potřebné pro services.
function findConflicts(projects, ownProject, services) {
  const required = requiredPorts(services);
  if (required.size === 0)
    return [];
  return projects
    .filter(project => project.name !== ownProject)
    .map(project => ({
      name: project.name,
      workingDir: project.workingDir,
      containers: project.containers
        .filter(container => container.ports.some(port => required.has(port)))
        .map(container => container.name),
      ports: project.ports.filter(port => required.has(port))
    }))
    .filter(conflict => conflict.ports.length > 0);
}

async function conflicts(ownProject, services, signal) {
  return findConflicts(await list(signal), ownProject, services);
}

// Compose projekt jde zastavit i bez jeho souboru, compose ho najde podle labelů kontejnerů.
// Název se ověří proti aktuálně běžícím projektům, z okna se nepřebírá naslepo.
// U kontejnerů bez compose jde zastavit jen část (containerNames), jinak všechny.
async function stop(projectName, signal, onProgress, containerNames) {
  const project = (await list(signal)).find(item => item.name === projectName);
  if (!project)
    return createResult(0, "", "");
  if (project.name.length > 0)
    return runDocker(["compose", "-p", project.name, "stop"], signal, 10 * MINUTE, onProgress);

  const names = project.containers
    .map(container => container.name)
    .filter(name => !containerNames || containerNames.includes(name));
  if (names.length === 0)
    return createResult(0, "", "");
  return runDocker(["stop", ...names], signal, 10 * MINUTE, onProgress);
}

module.exports = { list, conflicts, findConflicts, publishedPorts, stop };
