"use strict";

const path = require("path");
const gitCli = require("./gitCli");
const msBuildCli = require("./msBuildCli");
const deployer = require("./localBinariesDeployer");
const { createDockerCli } = require("../Docker/dockerCli");
const { SCOPE_OUTPUT_FOLDER } = require("../Settings/appSettings");

function excludesText(mapping) {
  return mapping.outputFolderExcludes.length === 0 ? "výjimek" : mapping.outputFolderExcludes.join(", ");
}

function failuresText(result) {
  const lines = result.failed.slice(0, 30).map(failed => failed.relativePath + ": " + failed.reason);
  if (result.failed.length > lines.length)
    lines.push(`… a dalších ${result.failed.length - lines.length}`);
  return lines.join("\n");
}

function projectDirectory(mapping) {
  return path.dirname(mapping.projectPath);
}

async function readGitText(mapping, signal) {
  return gitCli.gitText(await gitCli.getInfo(projectDirectory(mapping), signal));
}

function confirmOutputFolderText(selection, existing, mapping) {
  return [
    `Zkopíruje se ${selection.files.length} souborů z výstupu buildu do Bin.`,
    `Přepíše se ${existing} existujících souborů, ${selection.files.length - existing} přibude.`,
    `Vynechá se ${selection.excluded.length} souborů (${excludesText(mapping)}).`,
    "",
    "Pozor: přepíšou se i framework DLL z Nexus balíčku.",
    "Pokračovat?"
  ].join("\n");
}

// Vrací { error } při chybě, { info } po úspěšném nahrání, jinak prázdný objekt.
async function deploy(context, scope, callbacks, signal) {
  const { composeFile, mapping, containerName, containerStartedAt, binPath } = context;
  const { appendLine, onGit, confirm } = callbacks;

  appendLine("== Git");
  const git = await gitCli.getInfo(projectDirectory(mapping), signal);
  onGit(gitCli.gitText(git));
  appendLine(gitCli.gitText(git));

  appendLine("");
  appendLine("== Výstupní cesta projektu");
  const targetPath = await msBuildCli.getTargetPath(mapping, signal);
  const outputDirectory = path.dirname(targetPath);
  const mainAssemblyPath = path.join(outputDirectory, mapping.mainAssembly);
  appendLine(outputDirectory);

  appendLine("");
  appendLine(`== Rebuild (${mapping.configuration})`);
  const buildStarted = Date.now();
  const build = await msBuildCli.rebuild(mapping, signal, appendLine);
  const buildFinished = Date.now();
  if (!build.success)
    return { error: `Build selhal (kód ${build.exitCode}). Nic se nekopíruje.` };
  appendLine("Build OK.");

  const freshError = deployer.verifyFresh(mainAssemblyPath, buildStarted);
  if (freshError)
    return { error: freshError };

  const started = await createDockerCli(composeFile).getContainerStart(containerName, signal);
  if (!started.running || started.startedAt !== containerStartedAt)
    return { error: "Kontejner mezitím neběží nebo se restartoval. Startovací skript Bin přepisuje, proto se nic nekopíruje. Počkejte na \"Console starting ...\" a zkuste to znovu." };
  if (!deployer.isDirectory(binPath))
    return { error: `Složka Bin neexistuje: ${binPath}` };

  const selection = deployer.selectFiles(mapping, scope, outputDirectory);
  if (selection.files.length === 0)
    return { error: "Ve výstupu buildu nejsou žádné soubory ke kopírování." };

  if (scope === SCOPE_OUTPUT_FOLDER) {
    const existing = deployer.countExisting(selection.files, binPath);
    if (!await confirm(confirmOutputFolderText(selection, existing, mapping))) {
      appendLine("");
      appendLine("Kopírování zrušeno uživatelem.");
      return {};
    }
  }

  appendLine("");
  appendLine(`== Kopírování do ${binPath}`);
  const result = deployer.copy(selection.files, binPath);
  for (const copied of result.copied)
    appendLine("  OK    " + copied);
  for (const failed of result.failed)
    appendLine("  CHYBA " + failed.relativePath + ": " + failed.reason);

  if (result.copied.length === 0)
    return { error: "Nezkopíroval se žádný soubor:\n" + failuresText(result) };

  try {
    deployer.writeMarker(binPath, {
      branch: git.branch,
      commit: git.commit,
      commitFull: git.commitFull,
      dirty: git.dirty,
      builtAt: buildFinished,
      deployedAt: Date.now(),
      projectPath: mapping.projectPath,
      configuration: mapping.configuration,
      scope,
      files: result.copied,
      failedFiles: result.failed.map(failed => failed.relativePath)
    });
  } catch (error) {
    return { error: "Soubory jsou zkopírované, ale značku " + deployer.MARKER_FILE_NAME + " se nepodařilo zapsat: " + error.message };
  }

  appendLine("");
  appendLine(`Hotovo. Zkopírováno ${result.copied.length} souborů, nezkopírováno ${result.failed.length}. Značka zapsána.`);
  if (result.failed.length > 0)
    return { error: `Zkopírováno ${result.copied.length} souborů, ale ${result.failed.length} se nezkopírovalo:\n` + failuresText(result) };

  return { info: `Lokální binárky jsou nahrané (${result.copied.length} souborů). Testy je načtou při dalším příkazu start.` };
}

module.exports = { deploy, readGitText, excludesText };
