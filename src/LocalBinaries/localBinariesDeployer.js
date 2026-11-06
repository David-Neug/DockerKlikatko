"use strict";

const fs = require("fs");
const path = require("path");
const { DTF_SHARED_FOLDER, trimEndSlash } = require("../Compose/composeService");
const { SCOPE_ASSEMBLY } = require("../Settings/appSettings");
const { parseDockerTime } = require("../Docker/dockerJson");
const { formatDateTime } = require("./dateFormat");

const MARKER_FILE_NAME = ".local-binaries.json";

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function resolveBinPath(mapping, service) {
  if (mapping.binPath && mapping.binPath.trim().length > 0)
    return mapping.binPath;
  const mount = service.mounts.find(item => trimEndSlash(item.containerPath) === DTF_SHARED_FOLDER);
  return mount ? path.join(mount.hostPath, "Bin") : null;
}

function readMarker(text) {
  const marker = JSON.parse(text);
  if (!marker || typeof marker !== "object")
    return null;
  return {
    branch: marker.branch ?? "",
    commit: marker.commit ?? "",
    commitFull: marker.commitFull ?? "",
    dirty: marker.dirty === true,
    builtAt: parseDockerTime(marker.builtAt),
    deployedAt: parseDockerTime(marker.deployedAt),
    projectPath: marker.projectPath ?? "",
    configuration: marker.configuration ?? "",
    scope: typeof marker.scope === "string" && marker.scope.toLowerCase() === "outputfolder" ? "outputFolder" : SCOPE_ASSEMBLY,
    files: Array.isArray(marker.files) ? marker.files : [],
    failedFiles: Array.isArray(marker.failedFiles) ? marker.failedFiles : []
  };
}

function readStatus(binPath) {
  if (!isDirectory(binPath))
    return { binExists: false, marker: null, error: null };

  const markerPath = path.join(binPath, MARKER_FILE_NAME);
  if (!fs.existsSync(markerPath))
    return { binExists: true, marker: null, error: null };

  try {
    return { binExists: true, marker: readMarker(fs.readFileSync(markerPath, "utf8")), error: null };
  } catch (error) {
    return { binExists: true, marker: null, error: "Značku nejde přečíst: " + error.message };
  }
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$", "i");
}

function listFilesRecursive(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...listFilesRecursive(full));
    else if (entry.isFile())
      files.push(full);
  }
  return files;
}

function selectFiles(mapping, scope, outputDirectory) {
  if (scope === SCOPE_ASSEMBLY) {
    const files = [{ sourcePath: path.join(outputDirectory, mapping.mainAssembly), relativePath: mapping.mainAssembly }];
    const pdb = mapping.mainAssembly.replace(/\.[^.\\/]*$/, "") + ".pdb";
    if (isFile(path.join(outputDirectory, pdb)))
      files.push({ sourcePath: path.join(outputDirectory, pdb), relativePath: pdb });
    return { files, excluded: [] };
  }

  const excludes = mapping.outputFolderExcludes.map(wildcardToRegex);
  const files = [];
  const excluded = [];
  for (const file of listFilesRecursive(outputDirectory)) {
    const relativePath = path.relative(outputDirectory, file);
    const name = path.basename(file);
    if (excludes.some(regex => regex.test(name) || regex.test(relativePath)))
      excluded.push(relativePath);
    else
      files.push({ sourcePath: file, relativePath });
  }
  return { files, excluded };
}

function verifyFresh(mainAssemblyPath, buildStarted) {
  if (!isFile(mainAssemblyPath))
    return `Po buildu chybí hlavní DLL projektu: ${mainAssemblyPath}`;

  // Tolerance kvůli zaokrouhlení času zápisu na disku.
  const written = fs.statSync(mainAssemblyPath).mtimeMs;
  if (written < buildStarted - 2000)
    return `Hlavní DLL nemá čas zápisu z právě proběhlého buildu (${formatDateTime(written)}, build začal ${formatDateTime(buildStarted)}). Nic se nekopíruje.`;
  return null;
}

function countExisting(files, binPath) {
  return files.filter(file => fs.existsSync(path.join(binPath, file.relativePath))).length;
}

function failureReason(error) {
  if (error.code === "EBUSY")
    return "soubor je zamčený, používá ho jiný proces";
  if (error.code === "EPERM" || error.code === "EACCES")
    return "přístup odepřen (soubor je jen pro čtení nebo zamčený)";
  return error.message;
}

function copy(files, binPath) {
  const result = { copied: [], failed: [] };
  for (const file of files) {
    const target = path.join(binPath, file.relativePath);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.sourcePath, target);
      result.copied.push(file.relativePath);
    } catch (error) {
      result.failed.push({ relativePath: file.relativePath, reason: failureReason(error) });
    }
  }
  return result;
}

function writeMarker(binPath, marker) {
  const json = {
    ...marker,
    builtAt: new Date(marker.builtAt).toISOString(),
    deployedAt: new Date(marker.deployedAt).toISOString()
  };
  fs.writeFileSync(path.join(binPath, MARKER_FILE_NAME), JSON.stringify(json, null, 2), "utf8");
}

module.exports = {
  MARKER_FILE_NAME,
  resolveBinPath,
  readStatus,
  selectFiles,
  verifyFresh,
  countExisting,
  copy,
  writeMarker,
  isDirectory
};
