"use strict";

const { run } = require("../Process/processRunner");

const DOCKER_ENVIRONMENT = { DOCKER_CLI_HINTS: "false" };

function stringProp(element, name) {
  const value = element && typeof element === "object" ? element[name] : null;
  return typeof value === "string" ? value : null;
}

function cell(value, width) {
  let text = (value ?? "").replace(/[\t\r\n]/g, " ");
  if (text.length > width)
    text = text.slice(0, width);
  return text.padEnd(width + 2);
}

function row(image, version, status, running, names) {
  return cell(image, 48) + cell(version, 52) + cell(status, 22) + cell(running, 19) + names;
}

function label(item, name) {
  const labels = item?.Config?.Labels;
  if (!labels || typeof labels !== "object")
    return "";
  const value = labels[name];
  return typeof value === "string" ? value.trim() : "";
}

function firstLabel(item, ...names) {
  for (const name of names) {
    const value = label(item, name);
    if (value.length > 0)
      return value;
  }
  return "-";
}

function stateString(item, name) {
  return stringProp(item?.State, name) ?? "";
}

function statusFor(item, statuses) {
  let id = stringProp(item, "Id") ?? "";
  if (id.toLowerCase().startsWith("sha256:"))
    id = id.slice(7);
  const lowerId = id.toLowerCase();
  for (const [key, status] of statuses) {
    const lowerKey = key.toLowerCase();
    if (lowerId.startsWith(lowerKey) || lowerKey.startsWith(lowerId))
      return status;
  }
  return stateString(item, "Status");
}

function formatStartedAt(value) {
  if (!value || value.trim().length === 0 || value.startsWith("0001-01-01"))
    return "-";
  if (value.length >= 19)
    return value.slice(0, 10) + " " + value.slice(11, 19);
  return value;
}

async function runDocker(args, signal, timeoutMs) {
  try {
    return { result: await run("docker", args, { signal, timeoutMs, env: DOCKER_ENVIRONMENT }) };
  } catch (error) {
    if (error.name === "ProcessStartError" || error.name === "TimeoutError")
      return { message: error.message };
    throw error;
  }
}

async function formatTable(signal) {
  const ps = await runDocker(["ps", "--format", "{{.ID}}\t{{.Status}}"], signal, 20000);
  if (ps.message)
    return ps.message;
  if (!ps.result.success)
    return ps.result.errorText.trim().length === 0 ? "Nelze načíst seznam kontejnerů." : ps.result.errorText;

  const statuses = new Map();
  const ids = [];
  for (const raw of ps.result.stdOut.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (line.length === 0)
      continue;
    const tab = line.indexOf("\t");
    const id = tab < 0 ? line : line.slice(0, tab);
    if (id.length === 0)
      continue;
    ids.push(id);
    statuses.set(id, tab < 0 ? "" : line.slice(tab + 1));
  }

  const lines = [row("IMAGE", "VERSION", "STATUS", "RUNNING", "NAMES")];
  if (ids.length === 0) {
    lines.push("Žádný kontejner neběží.");
    return lines.join("\n") + "\n";
  }

  const inspect = await runDocker(["inspect", ...ids], signal, 30000);
  if (inspect.message)
    return inspect.message;
  if (!inspect.result.success)
    return inspect.result.errorText.trim().length === 0 ? "Nelze načíst detaily kontejnerů." : inspect.result.errorText;

  const json = inspect.result.stdOut.trim().replace(/^﻿/, "");
  const start = json.indexOf("[");
  if (start < 0)
    return "Docker inspect nevrátil seznam kontejnerů.";

  let items;
  try {
    items = JSON.parse(json.slice(start));
  } catch (error) {
    return "Docker inspect nejde přečíst: " + error.message;
  }
  if (!Array.isArray(items))
    return "Docker inspect nevrátil seznam kontejnerů.";

  for (const item of items) {
    lines.push(row(
      stringProp(item?.Config, "Image") ?? "",
      firstLabel(item, "mssql.version", "java.opts", "app.version"),
      statusFor(item, statuses),
      formatStartedAt(stateString(item, "StartedAt")),
      (stringProp(item, "Name") ?? "").trim().replace(/^\/+/, "")));
  }
  return lines.join("\n") + "\n";
}

module.exports = { formatTable };
