"use strict";

const fs = require("fs");

const SERVICE_HEADER = /^  (?<name>[A-Za-z0-9_.-]+):\s*(?:#.*)?$/;
const IMAGE_LINE = /^(?<indent>[ \t]+)image:[ \t]+(?<value>"(?:\\.|[^"])*"|'(?:[^']|'')*'|\S+)(?<rest>[ \t]*(?:#.*)?)$/;
const YAML_SPECIAL = " #{}[]&*!|>%@`'\"";

function isDoubleQuoted(value) {
  return value.length >= 2 && value.startsWith("\"") && value.endsWith("\"");
}

function isSingleQuoted(value) {
  return value.length >= 2 && value.startsWith("'") && value.endsWith("'");
}

function unquote(rawValue) {
  if (isDoubleQuoted(rawValue))
    return rawValue.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
  if (isSingleQuoted(rawValue))
    return rawValue.slice(1, -1).replaceAll("''", "'");
  return rawValue;
}

function doubleQuote(text) {
  return "\"" + text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"") + "\"";
}

function formatValue(rawValue, newImage) {
  if (isDoubleQuoted(rawValue))
    return doubleQuote(newImage);
  if (isSingleQuoted(rawValue))
    return "'" + newImage.replaceAll("'", "''") + "'";
  if ([...newImage].some(character => YAML_SPECIAL.includes(character)))
    return doubleQuote(newImage);
  return newImage;
}

function findServiceIndex(lines, serviceName) {
  return lines.findIndex(line => SERVICE_HEADER.exec(line)?.groups.name === serviceName);
}

function findImageIndex(lines, serviceIndex, serviceName) {
  for (let i = serviceIndex + 1; i < lines.length; i++) {
    if (SERVICE_HEADER.test(lines[i]) || /^\S/.test(lines[i]))
      break;
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("#") || !trimmed.startsWith("image:"))
      continue;
    if (!IMAGE_LINE.test(lines[i]))
      throw new Error(`Řádek image u služby ${serviceName} nejde bezpečně přepsat.`);
    return i;
  }
  return -1;
}

function replaceServiceImage(composePath, serviceName, newImage) {
  const bytes = fs.readFileSync(composePath);
  if (bytes.includes(0))
    throw new Error("Soubor docker-compose není v UTF-8, řádek image nejde bezpečně přepsat.");

  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  const text = bytes.subarray(hasBom ? 3 : 0).toString("utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(newline);

  const serviceIndex = findServiceIndex(lines, serviceName);
  if (serviceIndex < 0)
    throw new Error(`V docker-compose není služba ${serviceName}.`);

  const imageIndex = findImageIndex(lines, serviceIndex, serviceName);
  if (imageIndex < 0)
    throw new Error(`Služba ${serviceName} nemá řádek image:.`);

  const line = IMAGE_LINE.exec(lines[imageIndex]).groups;
  const plain = unquote(line.value);
  if (plain.startsWith("*") || plain.startsWith("&") || ["|", ">", "{", "["].includes(plain))
    throw new Error(`Řádek image u služby ${serviceName} používá YAML zápis, který aplikace nepřepisuje.`);

  lines[imageIndex] = line.indent + "image: " + formatValue(line.value, newImage) + line.rest;
  const updated = Buffer.from(lines.join(newline), "utf8");
  const temporary = composePath + ".klikatkotmp";
  fs.writeFileSync(temporary, hasBom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), updated]) : updated);
  fs.renameSync(temporary, composePath);
}

module.exports = { replaceServiceImage };
