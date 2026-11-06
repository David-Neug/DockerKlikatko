"use strict";

const path = require("path");
const { run, start } = require("../Process/processRunner");
const { failedResult } = require("../Process/commandResult");
const { readJsonValues, prop, parseDockerTime } = require("./dockerJson");

const DOCKER_ENVIRONMENT = { DOCKER_CLI_HINTS: "false", COMPOSE_ANSI: "never" };
const CONSOLE_STARTED_TEXT = "Console starting ...";
const MINUTE = 60000;

let gate = Promise.resolve();

function withGate(action) {
  const result = gate.then(action, action);
  gate = result.catch(() => {});
  return result;
}

function isRunning(state) {
  return (state ?? "").toLowerCase() === "running";
}

function trimSlash(name) {
  if (!name || name.trim().length === 0)
    return null;
  return name.trim().replace(/^\/+/, "");
}

function healthFrom(healthField, status) {
  if (healthField && healthField.trim().length > 0)
    return healthField;
  const match = /\((healthy|unhealthy|starting)\)/i.exec(status);
  return match ? match[1].toLowerCase() : null;
}

function readComposePs(item) {
  if (!item || typeof item !== "object" || Array.isArray(item))
    return null;

  const service = prop(item, "Service");
  if (!service || service.trim().length === 0)
    return null;

  const status = prop(item, "Status") ?? "";
  return {
    serviceName: service,
    containerName: trimSlash(prop(item, "Name")) ?? "",
    state: prop(item, "State") ?? "",
    status,
    health: healthFrom(prop(item, "Health"), status),
    exitCode: Number.isInteger(item.ExitCode) ? item.ExitCode : null,
    startedAt: null,
    configImage: prop(item, "Image"),
    imageId: null,
    cpu: null,
    memory: null,
    consoleStarted: false,
    binaries: null
  };
}

function byContainerName(byService) {
  const map = new Map();
  for (const runtime of Object.values(byService)) {
    const key = runtime.containerName.toLowerCase();
    if (key.length > 0 && !map.has(key))
      map.set(key, runtime);
  }
  return map;
}

function applyInspectItem(item, runtime) {
  const state = item.State;
  if (state && typeof state === "object") {
    const status = prop(state, "Status");
    if (status && status.trim().length > 0)
      runtime.state = status;
    const startedAt = parseDockerTime(prop(state, "StartedAt"));
    if (startedAt !== null)
      runtime.startedAt = startedAt;
    if (Number.isInteger(state.ExitCode))
      runtime.exitCode = state.ExitCode;
    const healthStatus = prop(state.Health, "Status");
    if (healthStatus && healthStatus.trim().length > 0)
      runtime.health = healthStatus;
  }

  const image = prop(item.Config, "Image");
  if (image && image.trim().length > 0)
    runtime.configImage = image;

  const imageId = prop(item, "Image");
  if (imageId && imageId.trim().length > 0)
    runtime.imageId = imageId;
}

function formatSince(milliseconds) {
  return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function createDockerCli(composeFilePath) {
  const fullComposePath = path.resolve(composeFilePath);
  const workingDirectory = path.dirname(fullComposePath);

  function runDocker(args, signal, timeoutMs, onProgress) {
    return withGate(() => run("docker", args, {
      cwd: workingDirectory,
      signal,
      timeoutMs,
      env: DOCKER_ENVIRONMENT,
      onLine: onProgress
    }));
  }

  // Docker ve WSL bere pracovní adresář a -f jako cestu uvnitř Linuxu.
  // Plná cesta R:\... se při předání rozpadne, proto se předává jen název souboru.
  function composeArguments(args) {
    return ["compose", "-f", path.basename(fullComposePath), ...args];
  }

  function compose(args, signal, timeoutMs, onProgress) {
    return runDocker(composeArguments(args), signal, timeoutMs, onProgress);
  }

  function up(services, signal, onProgress) {
    const args = ["up", "-d"];
    for (const service of services.filter(item => item.replicas === 0))
      args.push("--scale", `${service.name}=1`);
    args.push(...services.map(service => service.name));
    return compose(args, signal, 20 * MINUTE, onProgress);
  }

  function stop(serviceNames, signal, onProgress) {
    return compose(["stop", ...serviceNames], signal, 10 * MINUTE, onProgress);
  }

  function pullImage(image, signal, onProgress) {
    return runDocker(["pull", image], signal, 30 * MINUTE, onProgress);
  }

  function fetch(service, signal, onProgress) {
    if (service.usesImage)
      return compose(["pull", "--progress", "plain", service.name], signal, 30 * MINUTE, onProgress);
    if (service.usesBuild)
      return compose(["build", "--progress", "plain", service.name], signal, 60 * MINUTE, onProgress);
    return Promise.resolve(failedResult(`Služba ${service.name} nemá image ani build.`));
  }

  async function remove(serviceName, signal, onProgress) {
    const stopped = await stop([serviceName], signal, onProgress);
    if (!stopped.success)
      return stopped;
    return compose(["rm", "-f", serviceName], signal, 5 * MINUTE, onProgress);
  }

  function logs(serviceName, signal) {
    return compose(["logs", "--no-color", "--tail", "300", serviceName], signal, 2 * MINUTE);
  }

  function containerLogsSince(container, since, signal) {
    return runDocker(["logs", "--since", formatSince(since), container], signal, MINUTE);
  }

  async function isConsoleStarted(container, startedAt, signal) {
    const result = await containerLogsSince(container, startedAt, signal);
    if (!result.success)
      return false;
    return result.stdOut.includes(CONSOLE_STARTED_TEXT) || result.stdErr.includes(CONSOLE_STARTED_TEXT);
  }

  async function getContainerStart(container, signal) {
    const inspect = await runDocker(["inspect", container], signal, 45000);
    if (!inspect.success)
      return { running: false, startedAt: null };

    for (const item of readJsonValues(inspect.stdOut)) {
      if (!item || typeof item !== "object" || !item.State)
        continue;
      return {
        running: isRunning(prop(item.State, "Status")),
        startedAt: parseDockerTime(prop(item.State, "StartedAt"))
      };
    }
    return { running: false, startedAt: null };
  }

  function startLogsFollow(serviceName, onLine, onExit) {
    return start("docker", composeArguments(["logs", "--no-color", "--tail", "300", "-f", serviceName]), {
      cwd: workingDirectory,
      env: DOCKER_ENVIRONMENT,
      onLine,
      onExit
    });
  }

  async function applyInspect(names, byService, signal) {
    const inspect = await runDocker(["inspect", ...names], signal, 45000);
    if (!inspect.success)
      return;

    const containers = byContainerName(byService);
    for (const item of readJsonValues(inspect.stdOut)) {
      if (!item || typeof item !== "object")
        continue;
      const name = trimSlash(prop(item, "Name"));
      const runtime = name ? containers.get(name.toLowerCase()) : null;
      if (runtime)
        applyInspectItem(item, runtime);
    }
  }

  async function applyStats(byService, signal) {
    const stats = await runDocker(["stats", "--no-stream", "--format", "{{json .}}"], signal, 45000);
    if (!stats.success)
      return;

    const containers = byContainerName(byService);
    for (const item of readJsonValues(stats.stdOut)) {
      const name = trimSlash(prop(item, "Name"));
      const runtime = name ? containers.get(name.toLowerCase()) : null;
      if (!runtime)
        continue;
      runtime.cpu = prop(item, "CPUPerc");
      runtime.memory = prop(item, "MemUsage");
    }
  }

  async function query(signal) {
    const ps = await compose(["ps", "--all", "--format", "json"], signal, 45000);
    if (!ps.success)
      return { success: false, error: ps.errorText, byService: {} };

    const byService = {};
    for (const item of readJsonValues(ps.stdOut)) {
      const runtime = readComposePs(item);
      if (!runtime)
        continue;
      const key = runtime.serviceName.toLowerCase();
      const existing = byService[key];
      if (!existing || (!isRunning(existing.state) && isRunning(runtime.state)))
        byService[key] = runtime;
    }

    const runtimes = Object.values(byService);
    if (runtimes.length > 0) {
      const names = runtimes.map(runtime => runtime.containerName).filter(name => name.length > 0);
      if (names.length > 0)
        await applyInspect(names, byService, signal);
      await applyStats(byService, signal);
    }

    return { success: true, error: "", byService };
  }

  return {
    composeFilePath: fullComposePath,
    up,
    stop,
    pullImage,
    fetch,
    remove,
    logs,
    isConsoleStarted,
    getContainerStart,
    startLogsFollow,
    query
  };
}

async function getEngineStatus(signal) {
  try {
    const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      signal,
      timeoutMs: 20000,
      env: DOCKER_ENVIRONMENT
    });
    if (result.success && result.stdOut.trim().length > 0)
      return { known: true, isRunning: true, error: "" };
    return { known: true, isRunning: false, error: result.errorText };
  } catch (error) {
    if (error.name === "ProcessStartError" || error.name === "TimeoutError")
      return { known: false, isRunning: false, error: error.message };
    throw error;
  }
}

module.exports = { createDockerCli, getEngineStatus, CONSOLE_STARTED_TEXT };
