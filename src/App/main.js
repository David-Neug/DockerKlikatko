"use strict";

const { app, dialog, Menu } = require("electron");
const { createMainWindow } = require("./windows");
const { registerIpc, trackWindow } = require("./ipc");
const { createSettingsStore } = require("../Settings/settingsStore");
const { createErrorReporter } = require("./errorReporter");

function registerCrashReporting(reporter) {
  process.on("uncaughtException", error => {
    const file = reporter.report({ source: "uncaughtException (hlavní proces)", message: error?.message, stack: error?.stack });
    dialog.showErrorBox(
      "Neočekávaná chyba aplikace",
      `${error?.stack ?? error}\n\n` + (file ? `Záznam o chybě: ${file}` : "Záznam o chybě se nepodařilo zapsat."));
  });

  process.on("unhandledRejection", reason => {
    reporter.report({ source: "unhandledRejection (hlavní proces)", message: reason?.message ?? String(reason), stack: reason?.stack });
  });

  app.on("render-process-gone", (_, contents, details) => {
    reporter.report({
      source: "render-process-gone (pád okna)",
      message: `Okno spadlo: ${details.reason} (kód ${details.exitCode})`,
      window: contents.isDestroyed() ? null : contents.getTitle(),
      context: details
    });
  });

  app.on("child-process-gone", (_, details) => {
    if (details.reason === "clean-exit")
      return;
    reporter.report({ source: "child-process-gone", message: `Proces ${details.type} skončil: ${details.reason} (kód ${details.exitCode})`, context: details });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;
  const settingsStore = createSettingsStore(app);
  const reporter = createErrorReporter(app, settingsStore);
  registerCrashReporting(reporter);

  app.on("second-instance", () => {
    if (!mainWindow)
      return;
    if (mainWindow.isMinimized())
      mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc(settingsStore, reporter);
    mainWindow = trackWindow(createMainWindow());
    mainWindow.on("closed", () => {
      mainWindow = null;
      app.quit();
    });
  });

  app.on("window-all-closed", () => app.quit());
}
