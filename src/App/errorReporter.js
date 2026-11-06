"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");

const REPORT_DIRECTORY_NAME = "error-reports";
const MAX_RECENT_CALLS = 40;
const MAX_ARGUMENT_LENGTH = 400;
// Časté úspěšné dotazy by z historie vytlačily to podstatné.
const QUIET_CHANNELS = new Set(["live:table", "compose:fileExists", "child:context", "error:report"]);

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Služby z compose jsou v argumentech velké, pro reprodukci stačí jejich název.
function replacer(_, value) {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.configuredImageText === "string")
    return `<služba ${value.name}>`;
  return value;
}

function summarize(args) {
  let text;
  try {
    text = JSON.stringify(args, replacer);
  } catch {
    text = String(args);
  }
  return text.length > MAX_ARGUMENT_LENGTH ? text.slice(0, MAX_ARGUMENT_LENGTH) + "…" : text;
}

function indent(text) {
  return String(text ?? "").split(/\r?\n/).map(line => "  " + line).join("\n");
}

function createErrorReporter(app, settingsStore) {
  const directory = path.join(path.dirname(settingsStore.settingsPath), REPORT_DIRECTORY_NAME);
  const recentCalls = [];

  function recordCall(channel, args, startedAt, error) {
    if (!error && QUIET_CHANNELS.has(channel))
      return;
    recentCalls.push({
      time: formatTime(new Date(startedAt)),
      channel,
      args: summarize(args),
      duration: Date.now() - startedAt,
      error: error ? error.message : null,
      stack: error && !error.canceled ? error.stack : null
    });
    while (recentCalls.length > MAX_RECENT_CALLS)
      recentCalls.shift();
  }

  function settingsText() {
    try {
      return JSON.stringify(settingsStore.load(), null, 2);
    } catch (error) {
      return "Nastavení nejde načíst: " + error.message;
    }
  }

  function environmentText() {
    return [
      `aplikace: ${app.getName()} ${app.getVersion()} (${app.isPackaged ? "sestavená" : "spuštěná z projektu"})`,
      `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`,
      `OS: ${process.platform} ${os.release()} ${process.arch}`,
      `spustitelný soubor: ${process.execPath}`,
      `nastavení: ${settingsStore.settingsPath}`
    ].join("\n");
  }

  function contextText(context) {
    if (!context || typeof context !== "object")
      return "(není)";
    return Object.entries(context).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n");
  }

  function callsText() {
    if (recentCalls.length === 0)
      return "(žádná)";
    return recentCalls.map(call => {
      const result = call.error === null ? "OK" : "CHYBA: " + call.error;
      const line = `${call.time} ${call.channel} ${call.args} -> ${result} (${call.duration} ms)`;
      return call.stack ? line + "\n" + indent(call.stack) : line;
    }).join("\n");
  }

  // Každá chyba se připíše na konec souboru daného dne, starší záznamy zůstávají.
  function report({ source, message, stack, window, context }) {
    const now = new Date();
    const id = `${formatDate(now).replace(/-/g, "")}-${formatTime(now).replace(/[:.]/g, "")}-${randomBytes(2).toString("hex")}`;
    const entry = [
      `==================== CHYBA ${formatDate(now)} ${formatTime(now)} (id ${id}) ====================`,
      `Zdroj: ${source}`,
      `Okno: ${window || "(hlavní proces)"}`,
      "Zpráva:",
      indent(message || "(bez zprávy)"),
      "Stack:",
      indent(stack || "(není)"),
      "Kontext:",
      indent(contextText(context)),
      "Prostředí:",
      indent(environmentText()),
      "Nastavení:",
      indent(settingsText()),
      `Poslední volání (nejstarší první, max ${MAX_RECENT_CALLS}):`,
      indent(callsText()),
      "",
      ""
    ].join("\n");

    const file = path.join(directory, `error-report-${formatDate(now)}.log`);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(file, entry, "utf8");
      return file;
    } catch {
      return null;
    }
  }

  return { directory, recordCall, report };
}

module.exports = { createErrorReporter };
