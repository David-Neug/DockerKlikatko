"use strict";

function tryParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function readJsonValues(text) {
  const trimmed = text.trim().replace(/^﻿/, "");
  if (trimmed.length === 0)
    return [];

  const arrayStart = trimmed.indexOf("[");
  const objectStart = trimmed.indexOf("{");
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    const parsed = tryParse(trimmed.slice(arrayStart));
    if (Array.isArray(parsed))
      return parsed;
  }

  const values = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    const start = candidate.indexOf("{");
    if (start < 0)
      continue;
    const parsed = tryParse(candidate.slice(start));
    if (parsed !== undefined)
      values.push(parsed);
  }
  return values;
}

function prop(element, name) {
  if (!element || typeof element !== "object")
    return null;
  const value = element[name];
  if (typeof value === "string")
    return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

function parseDockerTime(value) {
  if (!value || value.trim().length === 0 || value.startsWith("0001-01-01"))
    return null;

  const match = /^(?<head>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<frac>\d+))?(?<tz>Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const fraction = (match.groups.frac ?? "").slice(0, 3);
  const normalized = match.groups.head + (fraction.length > 0 ? "." + fraction : "") + (match.groups.tz ?? "Z");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

module.exports = { readJsonValues, prop, parseDockerTime };
