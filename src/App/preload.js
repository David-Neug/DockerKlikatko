"use strict";

const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result.ok)
    return result.value;
  const error = new Error(result.error);
  error.canceled = result.canceled;
  throw error;
}

function subscribe(channel, listener) {
  const wrapped = (_, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("klikatko", {
  invoke,
  on: subscribe
});
