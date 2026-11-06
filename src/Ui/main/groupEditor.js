"use strict";

const GroupEditor = (() => {
  function includesIgnoreCase(values, value) {
    const lower = value.toLowerCase();
    return values.some(item => item.toLowerCase() === lower);
  }

  // Vrací { name, services } nebo null, když uživatel dialog zruší.
  function open(title, name, services, selected, takenNames) {
    return new Promise(resolve => {
      const names = [...services];
      for (const extra of selected) {
        if (!includesIgnoreCase(names, extra))
          names.push(extra);
      }

      const finish = result => {
        modal.close();
        resolve(result);
      };
      const modal = Ui.openModal(title, "group-editor", () => finish(null));

      const nameInput = Ui.element("input", { type: "text", value: name, spellcheck: false });
      const checkboxes = names.map(service => Ui.element("input", {
        type: "checkbox",
        value: service,
        checked: includesIgnoreCase(selected, service)
      }));
      const checklist = Ui.element("div", { className: "checklist" },
        checkboxes.map(checkbox => Ui.element("label", {}, [checkbox, checkbox.value])));

      const accept = async () => {
        const groupName = nameInput.value.trim();
        if (groupName.length === 0) {
          await Ui.showInfo(title, "Zadejte název skupiny.");
          return;
        }
        if (includesIgnoreCase(takenNames, groupName)) {
          await Ui.showInfo(title, "Skupina s tímto názvem už existuje.");
          return;
        }
        finish({
          name: groupName,
          services: checkboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value)
        });
      };

      nameInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          accept();
        }
      });

      modal.body.append(Ui.element("div", { className: "field-label", text: "Název skupiny" }), nameInput, checklist);
      modal.buttonBar.append(
        Ui.element("button", { text: "Zrušit", onClick: () => finish(null) }),
        Ui.element("button", { className: "primary", text: "Uložit", onClick: accept }));
      nameInput.focus();
    });
  }

  return { open };
})();
