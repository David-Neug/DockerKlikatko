"use strict";

const { resolveBinPath, readStatus } = require("./localBinariesDeployer");

// Kontejner, u kterého už startovací skript vypsal "Console starting ...", podle času startu.
const consoleStartedContainers = new Map();

function isRunning(state) {
  return (state ?? "").toLowerCase() === "running";
}

async function applyLocalBinaries(docker, services, mappings, byService, signal) {
  for (const mapping of mappings ?? []) {
    const service = services.find(item => item.name.toLowerCase() === mapping.serviceName.toLowerCase());
    const current = service ? byService[service.name.toLowerCase()] : null;
    if (!current || current.startedAt === null || current.containerName.length === 0 || !isRunning(current.state))
      continue;

    const containerKey = current.containerName.toLowerCase();
    current.consoleStarted = consoleStartedContainers.get(containerKey) === current.startedAt;
    if (!current.consoleStarted) {
      try {
        current.consoleStarted = await docker.isConsoleStarted(current.containerName, current.startedAt, signal);
      } catch (error) {
        if (error.name === "CanceledError")
          throw error;
        current.consoleStarted = false;
      }
      if (current.consoleStarted)
        consoleStartedContainers.set(containerKey, current.startedAt);
    }

    const binPath = resolveBinPath(mapping, service);
    if (current.consoleStarted && binPath)
      current.binaries = readStatus(binPath);
  }
}

module.exports = { applyLocalBinaries };
