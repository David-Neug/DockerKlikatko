"use strict";

const fs = require("fs");
const path = require("path");
const { app, ipcMain, dialog, BrowserWindow } = require("electron");
const { readBuildInfo } = require("./buildInfo");
const { createChildWindow } = require("./windows");
const { isCanceled } = require("../Process/errors");
const wslCli = require("../Wsl/wslCli");
const vhdCompactor = require("../Wsl/vhdCompactor");
const { createDockerCli, getEngineStatus } = require("../Docker/dockerCli");
const containerLiveQuery = require("../Docker/containerLiveQuery");
const composeProjects = require("../Docker/composeProjects");
const diskUsage = require("../Docker/diskUsage");
const composeFileReader = require("../Compose/composeFileReader");
const composeImageEditor = require("../Compose/composeImageEditor");
const imageReference = require("../Images/imageReference");
const imageTagCatalog = require("../Images/imageTagCatalog");
const deployWorkflow = require("../LocalBinaries/deployWorkflow");
const localBinariesDeployer = require("../LocalBinaries/localBinariesDeployer");
const { applyLocalBinaries } = require("../LocalBinaries/localBinariesStatus");

const LINE_FLUSH_MS = 60;
const DISK_CACHE_MS = 5 * 60000;

const windowControllers = new Map();
const childContexts = new Map();
const logFollowers = new Map();
const runningDeploys = new Set();
const runningCompactions = new Set();
let liveWindow = null;
let projectsWindow = null;
let errorReporter = null;

function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    try {
      const value = await action(event, ...args);
      errorReporter?.recordCall(channel, args, startedAt, null);
      return { ok: true, value };
    } catch (error) {
      const failure = { message: error?.message ?? String(error), stack: error?.stack, canceled: isCanceled(error) };
      errorReporter?.recordCall(channel, args, startedAt, failure);
      return { ok: false, error: failure.message, canceled: failure.canceled };
    }
  });
}

function windowOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function signalOf(event) {
  const id = event.sender.id;
  if (!windowControllers.has(id))
    windowControllers.set(id, new AbortController());
  return windowControllers.get(id).signal;
}

function releaseWindow(id) {
  windowControllers.get(id)?.abort();
  windowControllers.delete(id);
  childContexts.delete(id);
  runningDeploys.delete(id);
  runningCompactions.delete(id);
  logFollowers.get(id)?.stop();
  logFollowers.delete(id);
}

function trackWindow(window) {
  const id = window.webContents.id;
  window.on("closed", () => releaseWindow(id));
  return window;
}

function createBatchedLineSender(sender, channel) {
  let pending = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending.length === 0 || sender.isDestroyed())
      return;
    sender.send(channel, pending);
    pending = [];
  };
  const send = line => {
    pending.push(line);
    if (!timer)
      timer = setTimeout(flush, LINE_FLUSH_MS);
  };
  send.flush = () => {
    if (timer)
      clearTimeout(timer);
    flush();
  };
  return send;
}

function openModal(event, page, context, options, prepare) {
  const parent = windowOf(event);
  const child = trackWindow(createChildWindow(parent, page, { modal: true, ...options }));
  childContexts.set(child.webContents.id, context);
  prepare?.(child);
  return new Promise(resolve => child.on("closed", () => resolve(null)));
}

function registerWindowHandlers() {
  handle("child:context", event => childContexts.get(event.sender.id) ?? null);

  handle("window:openLogs", (event, composeFile, serviceName) =>
    openModal(event, "logs", { composeFile, serviceName }, { width: 960, height: 640, minWidth: 640, minHeight: 400 }));

  handle("window:openLocalBinaries", (event, context) =>
    openModal(event, "localBinaries", context, { width: 1000, height: 700, minWidth: 700, minHeight: 480 }, guardLocalBinariesClose));

  handle("window:openDisk", (event, composeFile, services) =>
    openModal(event, "disk", { composeFile, services }, { width: 1280, height: 860, minWidth: 960, minHeight: 600 }, guardDiskClose));

  handle("window:openLive", event => {
    if (liveWindow && !liveWindow.isDestroyed()) {
      if (liveWindow.isMinimized())
        liveWindow.restore();
      liveWindow.focus();
      return null;
    }

    liveWindow = trackWindow(createChildWindow(windowOf(event), "live", { width: 1280, height: 560, minWidth: 900, minHeight: 360 }));
    liveWindow.on("closed", () => { liveWindow = null; });
    return null;
  });

  handle("window:openProjects", (event, composeFile, services) => {
    if (projectsWindow && !projectsWindow.isDestroyed()) {
      setProjectsContext(composeFile, services);
      if (projectsWindow.isMinimized())
        projectsWindow.restore();
      projectsWindow.focus();
      return null;
    }

    projectsWindow = trackWindow(createChildWindow(windowOf(event), "projects", { width: 1280, height: 640, minWidth: 900, minHeight: 400 }));
    projectsWindow.on("closed", () => { projectsWindow = null; });
    setProjectsContext(composeFile, services);
    return null;
  });

  handle("window:close", event => {
    windowOf(event)?.close();
    return null;
  });
}

function registerDialogHandlers() {
  handle("dialog:message", async (event, options) => {
    const buttons = options.buttons ?? ["OK"];
    const result = await dialog.showMessageBox(windowOf(event), {
      type: options.type ?? "info",
      title: options.title ?? "",
      message: options.message ?? "",
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true
    });
    return result.response;
  });

  handle("dialog:openCompose", async (event, currentPath) => {
    const directory = currentPath ? path.dirname(currentPath) : "";
    const defaultPath = currentPath && fs.existsSync(currentPath)
      ? currentPath
      : directory && fs.existsSync(directory) ? directory : undefined;
    const result = await dialog.showOpenDialog(windowOf(event), {
      title: "Vyberte soubor docker-compose",
      defaultPath,
      properties: ["openFile"],
      filters: [
        { name: "Docker Compose (*.yml;*.yaml)", extensions: ["yml", "yaml"] },
        { name: "Všechny soubory (*.*)", extensions: ["*"] }
      ]
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
}

function registerSettingsHandlers(settingsStore) {
  handle("app:buildInfo", () => readBuildInfo(app));
  handle("settings:load", () => ({
    settings: settingsStore.load(),
    settingsPath: settingsStore.settingsPath,
    platform: process.platform
  }));
  handle("settings:save", (_, settings) => settingsStore.save(settings));
}

function registerEnvironmentHandlers() {
  handle("wsl:status", event => wslCli.getStatus(signalOf(event)));
  handle("wsl:start", (event, distro) => wslCli.startDefault(distro, signalOf(event)));
  handle("wsl:shutdown", event => wslCli.shutdown(signalOf(event)));
  handle("docker:engineStatus", event => getEngineStatus(signalOf(event)));
}

function registerComposeHandlers() {
  handle("compose:fileExists", (_, composePath) => {
    try {
      return fs.statSync(composePath).isFile();
    } catch {
      return false;
    }
  });
  handle("compose:read", (_, composePath) => composeFileReader.read(composePath));
  handle("compose:replaceImage", (_, composePath, serviceName, image) => {
    composeImageEditor.replaceServiceImage(composeFileReader.serviceFile(composePath, serviceName), serviceName, image);
    return null;
  });
}

function registerDockerHandlers() {
  // Průběh příkazu jde do řádku "Operace" v hlavním okně, všechny řádky po dávkách.
  const withProgress = async (event, action) => {
    const sendLines = createBatchedLineSender(event.sender, "operation:lines");
    try {
      return await action(sendLines);
    } finally {
      sendLines.flush();
    }
  };

  handle("docker:up", (event, composePath, services) =>
    withProgress(event, onProgress => createDockerCli(composePath).up(services, signalOf(event), onProgress)));
  handle("docker:stop", (event, composePath, names) =>
    withProgress(event, onProgress => createDockerCli(composePath).stop(names, signalOf(event), onProgress)));
  handle("docker:remove", (event, composePath, name) =>
    withProgress(event, onProgress => createDockerCli(composePath).remove(name, signalOf(event), onProgress)));
  handle("docker:pullImage", (event, composePath, image) =>
    withProgress(event, onProgress => createDockerCli(composePath).pullImage(image, signalOf(event), onProgress)));
  handle("docker:fetch", (event, composePath, service) =>
    withProgress(event, onProgress => createDockerCli(composePath).fetch(service, signalOf(event), onProgress)));

  handle("docker:query", async (event, composePath, services, mappings) => {
    const signal = signalOf(event);
    const docker = createDockerCli(composePath);
    setProjectsContext(composePath, services);
    const query = await docker.query(signal);
    if (query.success)
      await applyLocalBinaries(docker, services, mappings, query.byService, signal);
    return query;
  });

  handle("live:table", event => containerLiveQuery.formatTable(signalOf(event)));

  handle("projects:conflicts", async (event, composePath, services) => {
    const signal = signalOf(event);
    const ownProject = await createDockerCli(composePath).projectName(signal);
    return composeProjects.conflicts(ownProject, services, signal);
  });
  handle("projects:stopMany", (event, conflicts) =>
    withProgress(event, async onProgress => {
      for (const conflict of conflicts) {
        const result = await composeProjects.stop(conflict.name, signalOf(event), onProgress, conflict.containers);
        if (!result.success)
          return result;
      }
      return { success: true, errorText: "" };
    }));
}

// Okno projektů zvýrazní ty, které drží porty compose načteného v hlavním okně.
// Název vlastního projektu se zjišťuje přes docker compose config, proto se pamatuje.
function setProjectsContext(composeFile, services) {
  if (!projectsWindow || projectsWindow.isDestroyed())
    return;
  const id = projectsWindow.webContents.id;
  const current = childContexts.get(id);
  if (current && current.composeFile === composeFile) {
    current.services = services ?? [];
    return;
  }
  childContexts.set(id, { composeFile: composeFile ?? null, services: services ?? [], ownProject: undefined });
}

async function ownProjectOf(context, signal) {
  if (!context?.composeFile)
    return null;
  if (context.ownProject === undefined) {
    try {
      context.ownProject = fs.statSync(context.composeFile).isFile()
        ? await createDockerCli(context.composeFile).projectName(signal)
        : null;
    } catch (error) {
      if (isCanceled(error))
        throw error;
      context.ownProject = null;
    }
  }
  return context.ownProject;
}

function registerProjectsHandlers() {
  handle("projects:list", async event => {
    const signal = signalOf(event);
    const context = childContexts.get(event.sender.id);
    const projects = await composeProjects.list(signal);
    const ownProject = await ownProjectOf(context, signal);
    const conflicts = context?.composeFile ? composeProjects.findConflicts(projects, ownProject, context.services) : [];
    return {
      composeFile: context?.composeFile ?? null,
      ownProject,
      projects: projects.map(project => ({
        ...project,
        own: ownProject !== null && project.name === ownProject,
        conflictPorts: conflicts.find(conflict => conflict.name === project.name)?.ports ?? []
      }))
    };
  });

  handle("projects:stop", async (event, name) => {
    const sendLines = createBatchedLineSender(event.sender, "projects:lines");
    try {
      return await composeProjects.stop(name, signalOf(event), sendLines);
    } finally {
      sendLines.flush();
    }
  });
}

function registerImageHandlers() {
  handle("images:parse", (_, image) => imageReference.parse(image));
  handle("images:withTag", (_, image, tag) => imageReference.withTag(image, tag));
  handle("images:listTags", (event, reference, filter) => imageTagCatalog.list(reference, filter, signalOf(event)));
}

function registerLogsHandlers() {
  handle("logs:snapshot", event => {
    const context = childContexts.get(event.sender.id);
    return createDockerCli(context.composeFile).logs(context.serviceName, signalOf(event));
  });

  handle("logs:followStart", event => {
    const id = event.sender.id;
    const context = childContexts.get(id);
    logFollowers.get(id)?.stop();
    const sendLines = createBatchedLineSender(event.sender, "logs:lines");
    const follower = createDockerCli(context.composeFile).startLogsFollow(context.serviceName, sendLines, error => {
      sendLines.flush();
      if (logFollowers.get(id) !== follower)
        return;
      logFollowers.delete(id);
      if (!event.sender.isDestroyed())
        event.sender.send("logs:followExit", error?.message ?? null);
    });
    logFollowers.set(id, follower);
    return null;
  });

  handle("logs:followStop", event => {
    logFollowers.get(event.sender.id)?.stop();
    logFollowers.delete(event.sender.id);
    return null;
  });
}

// Okno místa smí smazat jen položky z posledního načtení, které nepoužívá žádný kontejner.
function registerDiskHandlers() {
  handle("disk:services", (event, composePath, services, fresh) =>
    diskUsage.serviceSpace(composePath, services, fresh ? 0 : DISK_CACHE_MS, signalOf(event)));

  handle("disk:load", async event => {
    const context = childContexts.get(event.sender.id);
    const model = await diskUsage.load(context.composeFile, context.services, signalOf(event));
    context.items = new Map((model.items ?? []).map(item => [item.key, item]));
    return model;
  });

  handle("disk:storage", event => diskUsage.storage(childContexts.get(event.sender.id).composeFile, signalOf(event)));

  // Cesta k disku se zjistí znovu tady, nepřebírá se z okna.
  handle("disk:compactVhd", async event => {
    const id = event.sender.id;
    const storage = await diskUsage.storage(childContexts.get(id).composeFile, signalOf(event));
    if (!storage.local || !storage.wsl?.vhdxPath)
      throw new Error("Virtuální disk WSL s Dockerem se nepodařilo najít.");

    const sendLines = createBatchedLineSender(event.sender, "disk:lines");
    runningCompactions.add(id);
    try {
      return await vhdCompactor.compact(storage.wsl.vhdxPath, storage.wsl.distro, signalOf(event), sendLines);
    } finally {
      sendLines.flush();
      runningCompactions.delete(id);
      diskUsage.invalidate();
    }
  });

  handle("disk:remove", async (event, keys) => {
    const context = childContexts.get(event.sender.id);
    const items = keys
      .map(key => context.items?.get(key))
      .filter(item => item && item.level !== diskUsage.IN_USE);
    const sendLines = createBatchedLineSender(event.sender, "disk:lines");
    try {
      return await diskUsage.remove(context.composeFile, items, signalOf(event), sendLines);
    } finally {
      sendLines.flush();
    }
  });
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function nearestExistingDirectory(target) {
  let directory = target ? path.dirname(target) : "";
  while (directory && !fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory)
      return undefined;
    directory = parent;
  }
  return directory || undefined;
}

function saveProjectPath(settingsStore, serviceName, projectPath) {
  const settings = settingsStore.load();
  const mapping = settings.localBinaries.find(item => item.serviceName.toLowerCase() === serviceName.toLowerCase());
  if (!mapping)
    throw new Error(`V nastavení chybí mapování služby ${serviceName}.`);
  mapping.projectPath = projectPath;
  settingsStore.save(settings);
}

function registerLocalBinariesHandlers(settingsStore) {
  handle("binaries:projectExists", event => isFile(childContexts.get(event.sender.id).mapping.projectPath));

  handle("binaries:chooseProject", async event => {
    const context = childContexts.get(event.sender.id);
    const result = await dialog.showOpenDialog(windowOf(event), {
      title: `Vyberte projekt služby ${context.serviceName}`,
      defaultPath: nearestExistingDirectory(context.mapping.projectPath),
      properties: ["openFile"],
      filters: [
        { name: "Projekt C# (*.csproj)", extensions: ["csproj"] },
        { name: "Všechny soubory (*.*)", extensions: ["*"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0)
      return null;

    const projectPath = result.filePaths[0];
    saveProjectPath(settingsStore, context.mapping.serviceName, projectPath);
    context.mapping = { ...context.mapping, projectPath };
    return context.mapping;
  });

  handle("binaries:resolveBinPath", (_, mapping, service) => {
    const binPath = localBinariesDeployer.resolveBinPath(mapping, service);
    return { binPath, exists: binPath !== null && localBinariesDeployer.isDirectory(binPath) };
  });

  handle("binaries:git", event => {
    const context = childContexts.get(event.sender.id);
    return deployWorkflow.readGitText(context.mapping, signalOf(event));
  });

  handle("binaries:deploy", async (event, scope) => {
    const id = event.sender.id;
    const context = childContexts.get(id);
    const window = windowOf(event);
    const appendLine = createBatchedLineSender(event.sender, "binaries:lines");
    runningDeploys.add(id);
    try {
      return await deployWorkflow.deploy(context, scope, {
        appendLine,
        onGit: text => event.sender.send("binaries:git", text),
        confirm: async message => {
          appendLine.flush();
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            title: "Celá výstupní složka buildu",
            message,
            buttons: ["Ano", "Ne"],
            defaultId: 0,
            cancelId: 1,
            noLink: true
          });
          return result.response === 0;
        }
      }, signalOf(event));
    } finally {
      appendLine.flush();
      runningDeploys.delete(id);
    }
  });
}

function guardLocalBinariesClose(window) {
  window.on("close", event => {
    if (!runningDeploys.has(window.webContents.id))
      return;
    event.preventDefault();
    dialog.showMessageBox(window, {
      type: "info",
      title: "Nahrát lokální binárky",
      message: "Build nebo kopírování ještě běží. Počkejte na dokončení.",
      buttons: ["OK"]
    });
  });
}

function guardDiskClose(window) {
  window.on("close", event => {
    if (!runningCompactions.has(window.webContents.id))
      return;
    event.preventDefault();
    dialog.showMessageBox(window, {
      type: "info",
      title: "Zmenšit virtuální disk",
      message: "Zmenšování virtuálního disku ještě běží. Počkejte na dokončení, jinak by WSL zůstalo zastavené.",
      buttons: ["OK"]
    });
  });
}

function registerIpc(settingsStore, reporter) {
  errorReporter = reporter;
  handle("error:report", (event, details) => reporter.report({ ...details, window: windowOf(event)?.getTitle() ?? details.window }));
  registerWindowHandlers();
  registerDialogHandlers();
  registerSettingsHandlers(settingsStore);
  registerEnvironmentHandlers();
  registerComposeHandlers();
  registerDockerHandlers();
  registerProjectsHandlers();
  registerImageHandlers();
  registerLogsHandlers();
  registerDiskHandlers();
  registerLocalBinariesHandlers(settingsStore);
}

module.exports = { registerIpc, trackWindow };
