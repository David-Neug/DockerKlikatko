"use strict";

const DEFAULT_COMPOSE_PATH = "C:\\Projekty\\docker\\docker-compose.yml";
const DEFAULT_MSBUILD_PATH = "C:\\Program Files\\Microsoft Visual Studio\\18\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe";
const DEFAULT_CONFIGURATION = "Debug";
const DEFAULT_EXCLUDE = "*.config";
const SCOPE_ASSEMBLY = "assembly";
const SCOPE_OUTPUT_FOLDER = "outputFolder";

function createExampleMapping() {
  return {
    serviceName: "dtf-test-ukazka",
    projectPath: "C:\\Projekty\\Ukazka\\src\\DTF.Ukazka\\DTF.Ukazka.csproj",
    configuration: DEFAULT_CONFIGURATION,
    mainAssembly: "DTF.Ukazka.dll",
    defaultScope: SCOPE_ASSEMBLY,
    outputFolderExcludes: [DEFAULT_EXCLUDE],
    binPath: null,
    msBuildPath: DEFAULT_MSBUILD_PATH
  };
}

function createDefault() {
  return {
    composePath: DEFAULT_COMPOSE_PATH,
    composeFiles: [{ path: DEFAULT_COMPOSE_PATH, note: "" }],
    autoRefresh: false,
    refreshSeconds: 10,
    groups: [],
    localBinaries: [createExampleMapping()]
  };
}

function scopeText(scope) {
  return scope === SCOPE_OUTPUT_FOLDER ? "celá složka" : "DLL";
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function distinctIgnoreCase(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function cleanList(values) {
  return distinctIgnoreCase((Array.isArray(values) ? values : [])
    .filter(value => typeof value === "string" && value.trim().length > 0)
    .map(value => value.trim()));
}

function normalizeScope(value) {
  return typeof value === "string" && value.toLowerCase() === SCOPE_OUTPUT_FOLDER.toLowerCase()
    ? SCOPE_OUTPUT_FOLDER
    : SCOPE_ASSEMBLY;
}

function normalizeGroup(group) {
  return {
    name: trimText(group?.name),
    services: cleanList(group?.services)
  };
}

function normalizeMapping(mapping) {
  const configuration = trimText(mapping?.configuration);
  const msBuildPath = trimText(mapping?.msBuildPath);
  const binPath = trimText(mapping?.binPath);
  return {
    serviceName: trimText(mapping?.serviceName),
    projectPath: trimText(mapping?.projectPath),
    configuration: configuration || DEFAULT_CONFIGURATION,
    mainAssembly: trimText(mapping?.mainAssembly),
    defaultScope: normalizeScope(mapping?.defaultScope),
    outputFolderExcludes: Array.isArray(mapping?.outputFolderExcludes) ? cleanList(mapping.outputFolderExcludes) : [DEFAULT_EXCLUDE],
    binPath: binPath || null,
    msBuildPath: msBuildPath || DEFAULT_MSBUILD_PATH
  };
}

// Seznam compose souborů pro rozbalovací seznam; aktuální cesta v něm nesmí chybět.
function normalizeComposeFiles(files, composePath) {
  const seen = new Set();
  const result = [];
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = trimText(file?.path);
    const key = filePath.toLowerCase();
    if (filePath.length === 0 || seen.has(key))
      continue;
    seen.add(key);
    result.push({ path: filePath, note: trimText(file?.note) });
  }
  if (!seen.has(composePath.trim().toLowerCase()))
    result.unshift({ path: composePath.trim(), note: "" });
  return result;
}

function clampRefresh(value) {
  const seconds = Number.isFinite(value) ? Math.trunc(value) : 10;
  return Math.min(300, Math.max(5, seconds));
}

function normalize(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const composePath = typeof source.composePath === "string" && source.composePath.trim().length > 0
    ? source.composePath
    : DEFAULT_COMPOSE_PATH;
  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .map(normalizeGroup)
    .filter(group => group.name.length > 0);
  const localBinaries = (Array.isArray(source.localBinaries) ? source.localBinaries : [createExampleMapping()])
    .map(normalizeMapping)
    .filter(mapping => mapping.serviceName.length > 0);

  return {
    composePath,
    composeFiles: normalizeComposeFiles(source.composeFiles, composePath),
    autoRefresh: source.autoRefresh === true,
    refreshSeconds: clampRefresh(source.refreshSeconds ?? 10),
    groups,
    localBinaries
  };
}

module.exports = {
  DEFAULT_COMPOSE_PATH,
  DEFAULT_MSBUILD_PATH,
  DEFAULT_CONFIGURATION,
  DEFAULT_EXCLUDE,
  SCOPE_ASSEMBLY,
  SCOPE_OUTPUT_FOLDER,
  createDefault,
  createExampleMapping,
  scopeText,
  normalize
};
