"use strict";

const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");
const { StringDecoder } = require("string_decoder");
const { run, IS_WINDOWS } = require("../Process/processRunner");

// Anglické hlášky MSBuildu, aby výstup v OEM kódové stránce nebyl rozsypaný.
const MSBUILD_ENVIRONMENT = { VSLANG: "1033" };
const MINUTE = 60000;

let oemEncoding = null;

async function resolveOemEncoding() {
  if (!IS_WINDOWS)
    return "utf8";
  if (oemEncoding)
    return oemEncoding;

  try {
    const result = await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"], { timeoutMs: 10000 });
    const match = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(result.stdOut);
    oemEncoding = match && iconv.encodingExists("cp" + match[1]) ? "cp" + match[1] : "cp852";
  } catch {
    oemEncoding = "cp852";
  }
  return oemEncoding;
}

function decoderFor(encoding) {
  return encoding === "utf8" ? () => new StringDecoder("utf8") : () => iconv.getDecoder(encoding);
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function ensureFiles(mapping) {
  if (!isFile(mapping.msBuildPath))
    throw new Error(`MSBuild neexistuje: ${mapping.msBuildPath}`);
  if (!isFile(mapping.projectPath))
    throw new Error(`Projekt neexistuje: ${mapping.projectPath}`);
}

async function runMsBuild(mapping, args, signal, timeoutMs, onLine) {
  const encoding = await resolveOemEncoding();
  return run(mapping.msBuildPath, args, {
    cwd: path.dirname(mapping.projectPath),
    signal,
    timeoutMs,
    env: MSBUILD_ENVIRONMENT,
    onLine,
    createDecoder: decoderFor(encoding)
  });
}

async function getTargetPath(mapping, signal) {
  ensureFiles(mapping);
  const result = await runMsBuild(
    mapping,
    [mapping.projectPath, "-nologo", "-getProperty:TargetPath", "-p:Configuration=" + mapping.configuration],
    signal,
    2 * MINUTE,
    null);
  if (!result.success)
    throw new Error("Výstupní cestu projektu nejde zjistit: " + result.errorText);

  const lines = result.stdOut.split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
  const targetPath = lines.at(-1);
  if (!targetPath)
    throw new Error("MSBuild nevrátil výstupní cestu projektu (TargetPath).");
  return targetPath;
}

function rebuild(mapping, signal, onLine) {
  ensureFiles(mapping);
  return runMsBuild(
    mapping,
    [
      mapping.projectPath,
      "-t:Rebuild",
      "-p:Configuration=" + mapping.configuration,
      "-m",
      "-nodeReuse:false",
      "-nologo",
      "-v:minimal"
    ],
    signal,
    30 * MINUTE,
    onLine);
}

module.exports = { getTargetPath, rebuild };
