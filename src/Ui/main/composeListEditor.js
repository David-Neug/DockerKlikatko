"use strict";

const ComposeListEditor = (() => {
  // Vrací nový seznam [{ path, note }] nebo null, když uživatel dialog zruší.
  function open(files, selectedPath) {
    return new Promise(resolve => {
      const items = files.map(file => ({ path: file.path, note: file.note }));
      let selectedIndex = Math.max(0, items.findIndex(item => item.path === selectedPath));

      const finish = result => {
        modal.close();
        resolve(result);
      };
      const modal = Ui.openModal("Soubory docker-compose", "compose-editor", () => finish(null));
      const list = Ui.element("div", { className: "compose-list" });
      const deleteButton = Ui.element("button", { className: "danger", text: "Smazat", onClick: () => removeSelected() });
      const upButton = Ui.element("button", { text: "Nahoru", onClick: () => moveSelected(-1) });
      const downButton = Ui.element("button", { text: "Dolů", onClick: () => moveSelected(1) });

      function updateButtons() {
        deleteButton.disabled = items.length === 0;
        upButton.disabled = selectedIndex <= 0;
        downButton.disabled = selectedIndex >= items.length - 1;
      }

      function markSelected() {
        [...list.children].forEach((row, index) => row.classList.toggle("selected", index === selectedIndex));
        updateButtons();
      }

      async function markMissing(row, filePath) {
        const exists = filePath.trim().length > 0 && await Ui.invoke("compose:fileExists", filePath.trim()).catch(() => false);
        row.classList.toggle("missing", !exists);
        row.querySelector("input.compose-path").title = exists ? filePath : "Soubor neexistuje: " + filePath;
      }

      function render(focusIndex) {
        list.replaceChildren(...items.map((item, index) => {
          const pathInput = Ui.element("input", { type: "text", className: "compose-path", value: item.path, spellcheck: false, placeholder: "Cesta k docker-compose.yml" });
          const noteInput = Ui.element("input", { type: "text", value: item.note, spellcheck: false, placeholder: "Poznámka" });
          const row = Ui.element("div", { className: "compose-item" }, [pathInput, noteInput]);
          const select = () => {
            selectedIndex = index;
            markSelected();
          };
          row.addEventListener("mousedown", select);
          pathInput.addEventListener("focus", select);
          noteInput.addEventListener("focus", select);
          pathInput.addEventListener("input", () => { item.path = pathInput.value; });
          pathInput.addEventListener("change", () => markMissing(row, item.path));
          noteInput.addEventListener("input", () => { item.note = noteInput.value; });
          markMissing(row, item.path);
          return row;
        }));
        markSelected();
        if (focusIndex !== undefined)
          list.children[focusIndex]?.querySelector("input")?.focus();
      }

      async function add() {
        const current = items[selectedIndex]?.path ?? selectedPath;
        const chosen = await Ui.invoke("dialog:openCompose", current);
        if (!chosen)
          return;
        const existing = items.findIndex(item => item.path.trim().toLowerCase() === chosen.toLowerCase());
        if (existing >= 0) {
          selectedIndex = existing;
        } else {
          items.push({ path: chosen, note: "" });
          selectedIndex = items.length - 1;
        }
        render();
        list.children[selectedIndex]?.querySelectorAll("input")[1]?.focus();
      }

      function removeSelected() {
        if (items.length === 0)
          return;
        items.splice(selectedIndex, 1);
        selectedIndex = Math.min(selectedIndex, items.length - 1);
        render();
      }

      function moveSelected(offset) {
        const target = selectedIndex + offset;
        if (target < 0 || target >= items.length)
          return;
        [items[selectedIndex], items[target]] = [items[target], items[selectedIndex]];
        selectedIndex = target;
        render(target);
      }

      async function accept() {
        const cleaned = items
          .map(item => ({ path: item.path.trim().replace(/^"+|"+$/g, ""), note: item.note.trim() }))
          .filter(item => item.path.length > 0);
        if (cleaned.length === 0) {
          await Ui.showInfo("Soubory docker-compose", "V seznamu musí zůstat aspoň jeden soubor.");
          return;
        }
        const seen = new Set();
        for (const item of cleaned) {
          const key = item.path.toLowerCase();
          if (seen.has(key)) {
            await Ui.showInfo("Soubory docker-compose", "Soubor je v seznamu dvakrát:\n" + item.path);
            return;
          }
          seen.add(key);
        }
        finish(cleaned);
      }

      modal.body.append(
        Ui.element("div", { className: "compose-header" }, [
          Ui.element("span", { text: "Cesta k souboru" }),
          Ui.element("span", { text: "Poznámka (zobrazí se v seznamu)" })
        ]),
        list,
        Ui.element("div", { className: "button-bar tools" }, [
          Ui.element("button", { className: "primary", text: "Přidat…", onClick: add }),
          deleteButton,
          upButton,
          downButton
        ]));
      modal.buttonBar.append(
        Ui.element("button", { text: "Zrušit", onClick: () => finish(null) }),
        Ui.element("button", { className: "primary", text: "Uložit", onClick: accept }));
      render(selectedIndex);
    });
  }

  return { open };
})();
