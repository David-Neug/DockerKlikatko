"use strict";

const { run } = require("../Process/processRunner");
const { ProcessStartError, TimeoutError } = require("../Process/errors");

const WSL_ENVIRONMENT = { WSL_UTF8: "1" };
const DISTRO_LINE = /^(?<name>.+?)\s{2,}(?<state>Running|Stopped|Installing|Uninstalling|Converting)\s{2,}\d+\s*$/i;

function runWsl(args, signal, timeoutMs) {
  return run("wsl.exe", args, { signal, timeoutMs, env: WSL_ENVIRONMENT });
}

function parseList(output, error, exitCode) {
  const text = (output ?? "").replace(/\0/g, "").replace(/﻿/g, "");
  const distros = [];
  for (const rawLine of text.split(/[\r\n]+/)) {
    let line = rawLine.trim();
    if (line.length === 0)
      continue;

    const isDefault = line.startsWith("*");
    if (isDefault)
      line = line.slice(1).trim();

    const match = DISTRO_LINE.exec(line);
    if (!match)
      continue;

    const name = match.groups.name.trim();
    if (name.toUpperCase() === "NAME")
      continue;
    distros.push({ name, state: match.groups.state.trim(), isDefault });
  }

  if (distros.length === 0) {
    const message = error && error.trim().length > 0 ? error.replace(/\0/g, "").trim() : "Stav WSL nejde zjistit.";
    return { known: false, isRunning: false, defaultDistro: null, error: message, exitCode };
  }

  const isRunning = distro => distro.state.toLowerCase() === "running";
  const selected = distros.find(distro => distro.isDefault);
  return {
    known: true,
    isRunning: selected ? isRunning(selected) : distros.some(isRunning),
    defaultDistro: selected ? selected.name : null,
    error: ""
  };
}

async function getStatus(signal) {
  try {
    const result = await runWsl(["-l", "-v"], signal, 20000);
    return parseList(result.stdOut, result.stdErr, result.exitCode);
  } catch (error) {
    if (error instanceof ProcessStartError || error instanceof TimeoutError)
      return { known: false, isRunning: false, defaultDistro: null, error: error.message };
    throw error;
  }
}

// Starší WSL z Windows parametr --version nezná, verze je pak neznámá (null).
async function getVersion(signal) {
  try {
    const result = await runWsl(["--version"], signal, 20000);
    const match = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.\d+)?/.exec((result.stdOut ?? "").replace(/\0/g, ""));
    if (!result.success || !match)
      return null;
    return { text: match[0], major: Number.parseInt(match.groups.major, 10) };
  } catch (error) {
    if (error instanceof ProcessStartError || error instanceof TimeoutError)
      return null;
    throw error;
  }
}

function startDefault(distro, signal) {
  return runWsl(["-d", distro, "-e", "true"], signal, 60000);
}

function shutdown(signal) {
  return runWsl(["--shutdown"], signal, 90000);
}

module.exports = { getStatus, getVersion, startDefault, shutdown, parseList };
