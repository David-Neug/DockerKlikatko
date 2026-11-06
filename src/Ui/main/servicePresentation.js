"use strict";

const ServicePresentation = (() => {
  const RUNNING_BACK = "var(--running-back)";
  const FAILING_BACK = "var(--failing-back)";
  const STOPPED_BACK = "var(--stopped-back)";
  const MISMATCH_BACK = "var(--mismatch-back)";

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim().length === 0;
  }

  function lower(value) {
    return (value ?? "").trim().toLowerCase();
  }

  function scopeText(scope) {
    return scope === "outputFolder" ? "celá složka" : "DLL";
  }

  function formatDuration(elapsed) {
    const minutes = elapsed / 60000;
    const hours = minutes / 60;
    const days = hours / 24;
    if (minutes < 1)
      return "méně než minutu";
    if (hours < 1)
      return `${Math.trunc(minutes)} min`;
    if (days < 1) {
      const restMinutes = Math.trunc(minutes) % 60;
      return restMinutes === 0 ? `${Math.trunc(hours)} h` : `${Math.trunc(hours)} h ${restMinutes} min`;
    }
    const restHours = Math.trunc(hours) % 24;
    return restHours === 0 ? `${Math.trunc(days)} d` : `${Math.trunc(days)} d ${restHours} h`;
  }

  function uptimeFromStatus(status) {
    if (isBlank(status))
      return "";

    const cleaned = status.replace(/\s*\((healthy|unhealthy|starting)\)\s*$/i, "").trim();
    const match = /^Up\s+(?<body>.+)$/i.exec(cleaned);
    if (!match)
      return "";

    const body = match.groups.body.trim();
    if (body.toLowerCase().includes("less than a second"))
      return "méně než minutu";

    const amount = /^(?:about\s+|an?\s+)?(?:(?<count>\d+)\s+)?(?<unit>second|minute|hour|day|week|month)s?$/i.exec(body);
    if (!amount)
      return body;

    const count = amount.groups.count ? Number.parseInt(amount.groups.count, 10) : 1;
    switch (amount.groups.unit.toLowerCase()) {
      case "second": return "méně než minutu";
      case "minute": return `${count} min`;
      case "hour": return `${count} h`;
      case "day": return `${count} d`;
      case "week": return `${count * 7} d`;
      case "month": return `${count} měs.`;
      default: return body;
    }
  }

  function formatUptime(runtime) {
    if (runtime.startedAt !== null && lower(runtime.state) === "running")
      return formatDuration(Math.max(0, Date.now() - runtime.startedAt));
    return uptimeFromStatus(runtime.status);
  }

  function formatRestart(status) {
    if (isBlank(status))
      return "restartuje se";
    const match = /(?<count>\d+)\s+(?<unit>second|minute|hour)s?\s+ago/i.exec(status);
    if (!match)
      return "restartuje se";
    const unit = { second: "s", minute: "min", hour: "h" }[match.groups.unit.toLowerCase()] ?? "";
    return `restart před ${Number.parseInt(match.groups.count, 10)} ${unit}`.trim();
  }

  function statusText(runtime, runtimeKnown) {
    if (!runtimeKnown)
      return "Neznámý";
    if (!runtime || isBlank(runtime.state))
      return "Není vytvořen";

    const state = lower(runtime.state);
    const health = lower(runtime.health);
    const uptime = formatUptime(runtime);

    if (state === "restarting")
      return "Padá · " + formatRestart(runtime.status);
    if (health === "unhealthy")
      return uptime.length === 0 ? "Padá · unhealthy" : `Padá · unhealthy · ${uptime}`;
    if (state === "dead")
      return "Padá";
    if (state === "exited" || state === "removing") {
      if (runtime.exitCode !== null && runtime.exitCode > 0)
        return `Padá · kód ${runtime.exitCode}`;
      return state === "removing" ? "Zastavuje se" : "Zastaveno";
    }
    if (state === "running")
      return uptime.length === 0 ? "Běží" : `Běží · ${uptime}`;
    if (state === "paused")
      return "Pozastaveno";
    if (state === "created")
      return "Vytvořen";
    return isBlank(runtime.status) ? state : runtime.status;
  }

  function healthText(runtime, runtimeKnown) {
    if (!runtimeKnown || !runtime)
      return "none";
    const health = lower(runtime.health);
    return health.length === 0 ? "none" : health;
  }

  function rowBackColor(runtime, runtimeKnown) {
    if (!runtimeKnown || !runtime || isBlank(runtime.state))
      return null;

    const state = lower(runtime.state);
    const health = lower(runtime.health);
    if (state === "restarting" || state === "dead" || health === "unhealthy" || (state === "exited" && runtime.exitCode > 0))
      return FAILING_BACK;
    if (state === "running")
      return RUNNING_BACK;
    if (state === "exited" || state === "paused" || state === "removing")
      return STOPPED_BACK;
    return null;
  }

  function shortId(imageId) {
    if (isBlank(imageId))
      return "";
    const hex = imageId.toLowerCase().startsWith("sha256:") ? imageId.slice(7) : imageId;
    return hex.length <= 12 ? hex : hex.slice(0, 12);
  }

  function runningImageText(runtime) {
    if (!runtime)
      return "—";
    const image = runtime.configImage?.trim() ?? "";
    const id = shortId(runtime.imageId);
    if (image.length === 0 && id.length === 0)
      return "—";
    if (id.length === 0)
      return image;
    if (image.length === 0)
      return id;
    return `${image} · ${id}`;
  }

  function normalizeImage(image) {
    let value = image.trim();
    const digest = value.indexOf("@");
    if (digest >= 0)
      value = value.slice(0, digest);

    const dockerLibrary = "docker.io/library/";
    const dockerHub = "docker.io/";
    if (value.toLowerCase().startsWith(dockerLibrary))
      value = value.slice(dockerLibrary.length);
    else if (value.toLowerCase().startsWith(dockerHub))
      value = value.slice(dockerHub.length);

    if (value.lastIndexOf(":") <= value.lastIndexOf("/"))
      value += ":latest";
    return value.toLowerCase();
  }

  function imageDiffers(service, runtime) {
    if (!runtime || isBlank(service.image) || isBlank(runtime.configImage))
      return false;
    return normalizeImage(service.image) !== normalizeImage(runtime.configImage);
  }

  function unknownBinaries(runtime, runtimeKnown) {
    if (!runtimeKnown)
      return { text: "Neznámý", tooltip: "Stav Dockeru není známý, obnovte stav." };
    if (!runtime || lower(runtime.state) !== "running")
      return { text: "Neznámý", tooltip: "Kontejner neběží. Stav binárek je známý jen u běžícího kontejneru." };
    if (!runtime.consoleStarted) {
      return {
        text: "Startuje…",
        tooltip: "Kontejner běží, ale startovací skript ještě nevypsal \"Console starting ...\" " +
          "(stahuje a rozbaluje balíček z Nexusu, nebo kontejner padá a restartuje se).\n" +
          "Stav se zjistí při dalším obnovení (Obnovit nebo Auto obnova)."
      };
    }
    if (!runtime.binaries || !runtime.binaries.binExists)
      return { text: "Neznámý", tooltip: "Složka Bin služby neexistuje nebo ji nejde odvodit z volumes v compose (lze nastavit binPath)." };
    return null;
  }

  function binariesText(mapping, service, runtime, runtimeKnown) {
    if (!mapping)
      return service.isDtfService ? "Nenastaveno" : "—";

    const unknown = unknownBinaries(runtime, runtimeKnown);
    if (unknown)
      return unknown.text;
    const status = runtime.binaries;
    if (status.error)
      return "Local? · chybná značka";
    const marker = status.marker;
    if (!marker)
      return "Nexus";

    const parts = ["Local", marker.branch, marker.commit];
    if (marker.dirty)
      parts.push("dirty");
    parts.push(scopeText(marker.scope));
    if (marker.failedFiles.length > 0)
      parts.push("neúplné");
    return parts.filter(part => !isBlank(part)).join(" · ");
  }

  function missingMappingHelp(service, settingsPath) {
    return [
      "DTF služba nemá mapování na zdrojový projekt, proto u ní není tlačítko Nahrát lokální binárky.",
      "",
      "Doplňte záznam do pole localBinaries v souboru:",
      settingsPath,
      "Upravujte ho se zavřenou aplikací, jinak ho při zavření přepíše.",
      "Stejnou změnu udělejte i v src/Settings/settings.json v projektu aplikace, jinak ji další build přepíše.",
      "",
      "Povinné:",
      `  serviceName: "${service.name}"`,
      "  projectPath: cesta k .csproj zdrojového projektu",
      "  mainAssembly: hlavní DLL projektu (AssemblyName), musí být i v Bin služby, např. DTF.XXX.dll",
      "Volitelné:",
      "  configuration: Debug (výchozí)",
      "  defaultScope: assembly (jen DLL + pdb) nebo outputFolder (celá složka)",
      "  outputFolderExcludes: [\"*.config\"] (výchozí)",
      "  binPath: null = odvodí se z volume …:/dtf-test + \\Bin",
      "  msBuildPath: cesta k MSBuild.exe (výchozí Visual Studio 18 Professional)",
      "",
      "Vzor je záznam dtf-test-ukazka ve stejném souboru."
    ].join("\n");
  }

  function binariesTooltip(mapping, service, runtime, runtimeKnown, settingsPath) {
    if (!mapping && service.isDtfService)
      return missingMappingHelp(service, settingsPath);
    if (!mapping)
      return "Služba nemá mapování na zdrojový projekt v nastavení.";

    const unknown = unknownBinaries(runtime, runtimeKnown);
    if (unknown)
      return unknown.tooltip;
    const status = runtime.binaries;
    if (status.error)
      return status.error;
    const marker = status.marker;
    if (!marker)
      return "V Bin jsou binárky z Nexus balíčku.";

    const lines = [
      "Lokální binárky",
      "Větev: " + marker.branch,
      "Commit: " + (isBlank(marker.commitFull) ? marker.commit : marker.commitFull),
      "Necommitnuté změny: " + (marker.dirty ? "ano" : "ne"),
      "Rozsah: " + (marker.scope === "outputFolder" ? "celá výstupní složka buildu" : "jen DLL projektu"),
      "Build: " + (marker.builtAt === null ? "—" : Ui.formatDateTime(marker.builtAt)),
      "Nasazeno: " + (marker.deployedAt === null ? "—" : Ui.formatDateTime(marker.deployedAt)),
      "Projekt: " + marker.projectPath,
      "Konfigurace: " + marker.configuration,
      "Zkopírováno souborů: " + marker.files.length
    ];
    if (marker.failedFiles.length > 0) {
      lines.push("Nezkopírováno (" + marker.failedFiles.length + "):");
      lines.push(...marker.failedFiles.slice(0, 20));
    }
    return lines.join("\n");
  }

  return {
    RUNNING_BACK,
    FAILING_BACK,
    STOPPED_BACK,
    MISMATCH_BACK,
    statusText,
    healthText,
    rowBackColor,
    runningImageText,
    imageDiffers,
    binariesText,
    binariesTooltip
  };
})();
