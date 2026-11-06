"use strict";

(() => {
  const DIALOG_TITLE = "Nahrát lokální binárky";

  const infoLabel = Ui.byId("infoLabel");
  const gitLabel = Ui.byId("gitLabel");
  const assemblyRadio = Ui.byId("assemblyRadio");
  const folderRadio = Ui.byId("folderRadio");
  const logBox = Ui.byId("logBox");
  const deployButton = Ui.byId("deployButton");
  const chooseProjectButton = Ui.byId("chooseProjectButton");
  const closeButton = Ui.byId("closeButton");
  let running = false;
  let context = null;

  function appendLines(lines) {
    logBox.value += lines.map(line => line + "\n").join("");
    logBox.scrollTop = logBox.scrollHeight;
  }

  function excludesText(mapping) {
    return mapping.outputFolderExcludes.length === 0 ? "výjimek" : mapping.outputFolderExcludes.join(", ");
  }

  function setRunning(value) {
    running = value;
    deployButton.disabled = value;
    chooseProjectButton.disabled = value;
    closeButton.disabled = value;
    assemblyRadio.disabled = value;
    folderRadio.disabled = value;
    document.body.classList.toggle("running", value);
  }

  function showMapping(mapping) {
    infoLabel.textContent = [
      "Projekt: " + mapping.projectPath,
      "Konfigurace: " + mapping.configuration + " · hlavní DLL: " + mapping.mainAssembly,
      "Cíl: " + context.binPath
    ].join("\n");
  }

  function showGitError(message) {
    gitLabel.textContent = message;
    gitLabel.classList.add("error");
  }

  async function loadGit() {
    deployButton.disabled = true;
    gitLabel.textContent = "Git: zjišťuji…";
    gitLabel.classList.remove("error");
    try {
      gitLabel.textContent = await Ui.invoke("binaries:git");
      deployButton.disabled = false;
    } catch (error) {
      if (error.canceled)
        return;
      showGitError("Git: " + error.message);
    }
  }

  async function chooseProject() {
    try {
      const mapping = await Ui.invoke("binaries:chooseProject");
      if (!mapping)
        return false;
      context.mapping = mapping;
      showMapping(mapping);
      await loadGit();
      return true;
    } catch (error) {
      await Ui.showError(error.message);
      return false;
    }
  }

  async function ensureProject() {
    if (await Ui.invoke("binaries:projectExists")) {
      await loadGit();
      return;
    }

    showGitError("Projekt neexistuje: " + context.mapping.projectPath);
    const choose = await Ui.confirm(DIALOG_TITLE,
      `Projekt služby ${context.serviceName} nebyl nalezen:\n${context.mapping.projectPath}\n\n` +
      "Vybrat soubor .csproj v průzkumníku? Cesta se uloží do settings.json.");
    if (choose)
      await chooseProject();
  }

  async function reportError(message, error) {
    appendLines(["", "CHYBA: " + message]);
    await Ui.showError(message, error);
  }

  async function deploy() {
    const scope = folderRadio.checked ? "outputFolder" : "assembly";
    setRunning(true);
    logBox.value = "";
    try {
      const result = await Ui.invoke("binaries:deploy", scope);
      if (result.error)
        await reportError(result.error);
      else if (result.info)
        await Ui.showInfo(DIALOG_TITLE, result.info);
    } catch (error) {
      if (!error.canceled)
        await reportError(error.message, error);
    } finally {
      setRunning(false);
    }
  }

  async function initialize() {
    context = await Ui.invoke("child:context");
    const mapping = context.mapping;
    document.title = `${DIALOG_TITLE} — ${context.serviceName}`;
    showMapping(mapping);
    Ui.byId("assemblyText").textContent = "Jen DLL projektu (" + mapping.mainAssembly + " + .pdb)";
    Ui.byId("folderText").textContent = "Celá výstupní složka buildu (bez " + excludesText(mapping) + ")";
    assemblyRadio.checked = mapping.defaultScope !== "outputFolder";
    folderRadio.checked = mapping.defaultScope === "outputFolder";

    Ui.setErrorContext(() => ({
      sluzba: context.serviceName,
      kontejner: context.containerName,
      startKontejneru: context.containerStartedAt,
      binPath: context.binPath,
      composeFile: context.composeFile,
      mapovani: context.mapping,
      rozsah: folderRadio.checked ? "outputFolder" : "assembly",
      git: gitLabel.textContent,
      konecVypisu: logBox.value.split("\n").slice(-40).join("\n")
    }));
    deployButton.addEventListener("click", deploy);
    chooseProjectButton.addEventListener("click", chooseProject);
    closeButton.addEventListener("click", () => window.close());
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !running)
        window.close();
    });
    Ui.on("binaries:lines", appendLines);
    Ui.on("binaries:git", text => {
      gitLabel.textContent = text;
      gitLabel.classList.remove("error");
    });

    await ensureProject();
  }

  initialize().catch(error => showGitError(error.message));
})();
