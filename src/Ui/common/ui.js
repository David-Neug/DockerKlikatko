"use strict";

const Ui = (() => {
  const api = window.klikatko;

  function invoke(channel, ...args) {
    return api.invoke(channel, ...args);
  }

  function on(channel, listener) {
    return api.on(channel, listener);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function element(tag, properties = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
      if (key === "className")
        node.className = value;
      else if (key === "text")
        node.textContent = value;
      else if (key.startsWith("on"))
        node.addEventListener(key.slice(2).toLowerCase(), value);
      else
        node[key] = value;
    }
    for (const child of children)
      node.append(child);
    return node;
  }

  function lastLine(text) {
    const line = String(text ?? "").split(/[\r\n]+/).filter(item => item.trim().length > 0).at(-1)?.trim();
    if (!line)
      return "Příkaz selhal.";
    return line.length > 200 ? line.slice(0, 200) : line;
  }

  const ERROR_LINE = /error|failed|denied|not found|no such|cannot|unable|invalid|chyba|selhal|neexistuje/i;

  // Výstup Dockeru často končí oddělovačem nebo výpisem průběhu, podstatná je poslední řádka s chybou.
  function errorLine(text) {
    const lines = String(text ?? "").split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
    const line = [...lines].reverse().find(item => ERROR_LINE.test(item) && !/^-+$/.test(item)) ?? lastLine(text);
    return line.length > 300 ? line.slice(0, 300) + "…" : line;
  }

  function trimForDialog(text) {
    const trimmed = String(text ?? "").trim();
    const max = 5000;
    if (trimmed.length <= max)
      return trimmed;
    return "…\n" + trimmed.slice(-max);
  }

  function message(options) {
    return invoke("dialog:message", options);
  }

  let errorContextProvider = null;

  // Okno si dodá vlastní stav (vybraná služba, běžící operace…), který se zapíše do záznamu o chybě.
  function setErrorContext(provider) {
    errorContextProvider = provider;
  }

  function reportError(source, text, stack) {
    let context = null;
    try {
      context = errorContextProvider?.() ?? null;
    } catch (error) {
      context = { chybaKontextu: error.message };
    }
    return invoke("error:report", { source, message: String(text ?? ""), stack: stack ?? null, window: document.title, context })
      .catch(() => null);
  }

  window.addEventListener("error", event =>
    reportError("chyba skriptu v okně", event.message, event.error?.stack ?? `${event.filename}:${event.lineno}:${event.colno}`));
  window.addEventListener("unhandledrejection", event =>
    reportError("neošetřený promise v okně", event.reason?.message ?? event.reason, event.reason?.stack));

  // Vlastní dialog místo systémového: dlouhý výstup Dockeru se v něm dá posouvat a tlačítka zůstanou vidět.
  function showError(text, error) {
    reportError("zobrazená chyba (Operace selhala)", text, error?.stack);
    const fullText = trimForDialog(text);
    return new Promise(resolve => {
      const finish = () => {
        modal.close();
        resolve(0);
      };
      const modal = openModal("Operace selhala", "error-dialog", finish);
      const details = element("textarea", { className: "log-box error-details", readOnly: true, spellcheck: false, value: fullText });
      details.setAttribute("wrap", "off");
      const okButton = element("button", { className: "primary", text: "OK", onClick: finish });
      const copyButton = element("button", {
        text: "Kopírovat",
        onClick: () => {
          details.select();
          navigator.clipboard.writeText(fullText).catch(() => document.execCommand("copy"));
        }
      });

      modal.body.append(element("div", { className: "error-summary", text: errorLine(text) }));
      if (fullText.includes("\n"))
        modal.body.append(details);
      modal.buttonBar.append(copyButton, okButton);
      requestAnimationFrame(() => {
        details.scrollTop = details.scrollHeight;
      });
      okButton.focus();
    });
  }

  function showInfo(title, text) {
    return message({ type: "info", title, message: text });
  }

  async function confirm(title, text) {
    return await message({ type: "warning", title, message: text, buttons: ["Ano", "Ne"] }) === 0;
  }

  function formatDateTime(milliseconds) {
    const date = new Date(milliseconds);
    const pad = value => String(value).padStart(2, "0");
    return `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()} ${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatShortDateTime(milliseconds) {
    const date = new Date(milliseconds);
    const pad = value => String(value).padStart(2, "0");
    return `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()} ${date.getHours()}:${pad(date.getMinutes())}`;
  }

  function openModal(title, className, onCancel) {
    const body = element("div", { className: "modal-body" });
    const buttonBar = element("div", { className: "button-bar end" });
    const modal = element("div", { className: "modal " + className }, [
      element("div", { className: "modal-title", text: title }),
      body,
      buttonBar
    ]);
    const backdrop = element("div", { className: "modal-backdrop" }, [modal]);
    const onKeyDown = event => {
      if (event.key !== "Escape")
        return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.append(backdrop);
    return {
      body,
      buttonBar,
      close() {
        document.removeEventListener("keydown", onKeyDown);
        backdrop.remove();
      }
    };
  }

  return {
    invoke,
    on,
    byId,
    element,
    openModal,
    lastLine,
    errorLine,
    trimForDialog,
    showError,
    reportError,
    setErrorContext,
    showInfo,
    confirm,
    formatDateTime,
    formatShortDateTime
  };
})();
