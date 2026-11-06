"use strict";

const path = require("path");
const { BrowserWindow, Menu } = require("electron");

const UI_DIRECTORY = path.join(__dirname, "..", "Ui");
const ICON_PATH = path.join(__dirname, "..", "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png");
const PRELOAD_PATH = path.join(__dirname, "preload.js");

function attachContextMenu(window) {
  window.webContents.on("context-menu", (_, params) => {
    const template = params.isEditable
      ? [{ role: "cut", label: "Vyjmout" }, { role: "copy", label: "Kopírovat" }, { role: "paste", label: "Vložit" }, { type: "separator" }, { role: "selectAll", label: "Vybrat vše" }]
      : [{ role: "copy", label: "Kopírovat", enabled: params.selectionText.length > 0 }, { role: "selectAll", label: "Vybrat vše" }];
    Menu.buildFromTemplate(template).popup({ window });
  });
}

function createWindow(page, options) {
  const window = new BrowserWindow({
    icon: ICON_PATH,
    show: false,
    backgroundColor: "#f5f7fa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    ...options
  });
  window.setMenu(null);
  attachContextMenu(window);
  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(UI_DIRECTORY, page, "index.html"));
  return window;
}

function createMainWindow() {
  return createWindow("main", {
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 680
  });
}

function createChildWindow(parent, page, options) {
  return createWindow(page, {
    parent,
    minimizable: !options.modal,
    ...options
  });
}

module.exports = { createMainWindow, createChildWindow };
