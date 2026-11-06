"use strict";

(() => {
  const MAX_LOG_LENGTH = 300000;
  const TRIMMED_LOG_LENGTH = 200000;

  const logBox = Ui.byId("logBox");
  const followCheckBox = Ui.byId("followCheckBox");
  const refreshButton = Ui.byId("refreshButton");
  const closeButton = Ui.byId("closeButton");

  function scrollToEnd() {
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setText(text) {
    logBox.value = text;
    scrollToEnd();
  }

  function appendLines(lines) {
    let text = logBox.value + lines.map(line => line + "\n").join("");
    if (text.length > MAX_LOG_LENGTH)
      text = text.slice(text.length - TRIMMED_LOG_LENGTH);
    setText(text);
  }

  function joinOutput(result) {
    const normalize = text => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const stdout = normalize(result.stdOut);
    const stderr = normalize(result.stdErr);
    if (stdout.length === 0)
      return stderr;
    if (stderr.length === 0)
      return stdout;
    return stdout + "\n" + stderr;
  }

  function stopFollow() {
    return Ui.invoke("logs:followStop");
  }

  async function startFollow() {
    setText("");
    try {
      await Ui.invoke("logs:followStart");
    } catch (error) {
      followCheckBox.checked = false;
      setText(error.message);
      Ui.reportError("chyba sledování logu", error.message, error.stack);
    }
  }

  async function loadSnapshot() {
    followCheckBox.checked = false;
    await stopFollow();
    refreshButton.disabled = true;
    followCheckBox.disabled = true;
    setText("Načítám logy…");
    try {
      const result = await Ui.invoke("logs:snapshot");
      let text = joinOutput(result);
      if (!result.success && result.stdOut.trim().length === 0)
        text = text.length === 0 ? "Logy se nepodařilo načíst." : text;
      setText(text.length === 0 ? "Log je prázdný." : text);
    } catch (error) {
      if (!error.canceled) {
        setText(error.message);
        Ui.reportError("chyba načtení logu", error.message, error.stack);
      }
    } finally {
      refreshButton.disabled = false;
      followCheckBox.disabled = false;
    }
  }

  async function initialize() {
    const context = await Ui.invoke("child:context");
    document.title = `Logy — ${context.serviceName}`;
    Ui.setErrorContext(() => ({ sluzba: context.serviceName, composeFile: context.composeFile, sledovani: followCheckBox.checked }));

    refreshButton.addEventListener("click", loadSnapshot);
    closeButton.addEventListener("click", () => window.close());
    followCheckBox.addEventListener("change", () => (followCheckBox.checked ? startFollow() : stopFollow()));
    document.addEventListener("keydown", event => {
      if (event.key === "Escape")
        window.close();
    });

    Ui.on("logs:lines", appendLines);
    Ui.on("logs:followExit", message => {
      followCheckBox.checked = false;
      if (message) {
        setText(message);
        Ui.reportError("sledování logu skončilo chybou", message, null);
      }
    });

    await loadSnapshot();
  }

  initialize().catch(error => setText(error.message));
})();
