"use strict";

const DTF_SHARED_FOLDER = "/dtf-test";

function isBlank(value) {
  return value === null || value === undefined || String(value).trim().length === 0;
}

function trimEndSlash(value) {
  return value.replace(/\/+$/, "");
}

function configuredImageText(service) {
  if (!isBlank(service.image)) {
    if (isBlank(service.versionLabel) || service.image.includes(service.versionLabel))
      return service.image;
    return `${service.image} (${service.versionLabel})`;
  }

  if (!isBlank(service.buildContext)) {
    const built = `sestaveno z ${service.buildContext}`;
    return isBlank(service.versionLabel) ? built : `${built} · ${service.versionLabel}`;
  }

  return "—";
}

function configuredTooltip(service, imageText) {
  const lines = [imageText];
  if (!isBlank(service.appName))
    lines.push("Balíček: " + service.appName);
  lines.push(...service.packages);
  if (service.replicas === 0)
    lines.push("V compose je služba vypnutá (replicas: 0).");
  return lines.join("\n");
}

function portsDisplay(service) {
  return service.endpoints.length > 0
    ? service.endpoints.map(endpoint => "localhost:" + endpoint.listenPort).join(", ")
    : service.portsText;
}

function portsTooltip(service) {
  if (service.endpoints.length === 0)
    return service.portsText;
  const host = process.platform === "win32" ? "Windows" : "hostitele";
  return `Připojení z ${host} přes gateway:\n` +
    service.endpoints.map(endpoint => `localhost:${endpoint.listenPort} → ${endpoint.target}`).join("\n");
}

function createComposeService(fields) {
  const service = {
    name: fields.name ?? "",
    image: fields.image ?? null,
    buildContext: fields.buildContext ?? null,
    versionLabel: fields.versionLabel ?? null,
    appName: fields.appName ?? null,
    memoryLimit: fields.memoryLimit ?? null,
    portsText: fields.portsText ?? "—",
    endpoints: fields.endpoints ?? [],
    replicas: fields.replicas ?? null,
    packages: fields.packages ?? [],
    mounts: fields.mounts ?? []
  };

  const imageText = configuredImageText(service);
  return {
    ...service,
    usesImage: !isBlank(service.image),
    usesBuild: !isBlank(service.buildContext),
    isDtfService: service.mounts.some(mount => trimEndSlash(mount.containerPath) === DTF_SHARED_FOLDER),
    configuredImageText: imageText,
    configuredTooltip: configuredTooltip(service, imageText),
    portsDisplay: portsDisplay(service),
    portsTooltip: portsTooltip(service)
  };
}

module.exports = { DTF_SHARED_FOLDER, createComposeService, trimEndSlash };
