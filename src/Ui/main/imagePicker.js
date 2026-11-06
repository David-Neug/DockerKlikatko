"use strict";

const ImagePicker = (() => {
  // Vrací vybraný tag nebo null, když uživatel dialog zruší.
  function open(serviceName, currentImage, reference) {
    return new Promise(resolve => {
      const currentTag = reference.tag;
      let registryTask = null;
      let registryTags = [];
      let registryNote = null;
      let generation = 0;
      let filterTimer = null;
      let selectedTag = null;
      let closed = false;

      const finish = result => {
        closed = true;
        clearTimeout(filterTimer);
        modal.close();
        resolve(result);
      };
      const modal = Ui.openModal("Dostupné image — " + serviceName, "image-picker", () => finish(null));

      const filterInput = Ui.element("input", { type: "text", placeholder: "Filtr tagu", spellcheck: false });
      const tagsBody = Ui.element("tbody");
      const tagsTable = Ui.element("table", { className: "grid" }, [
        Ui.element("thead", {}, [Ui.element("tr", {}, [
          Ui.element("th", { text: "Tag" }),
          Ui.element("th", { text: "Aktualizováno" })
        ])]),
        tagsBody
      ]);
      const tagsContainer = Ui.element("div", { className: "grid-container tags", tabIndex: 0 }, [tagsTable]);
      const statusLabel = Ui.element("div", { className: "status", text: "Načítám tagy…" });
      const downloadButton = Ui.element("button", { className: "primary", text: "Stáhnout", disabled: true });

      const accept = () => {
        if (!selectedTag)
          return;
        finish(selectedTag);
      };

      const select = row => {
        for (const item of tagsBody.children)
          item.classList.toggle("selected", item === row);
        selectedTag = row?.dataset.tag ?? null;
        downloadButton.disabled = !selectedTag;
        row?.scrollIntoView({ block: "nearest" });
      };

      const setStatus = (text, isError) => {
        statusLabel.textContent = text;
        statusLabel.title = text;
        statusLabel.classList.toggle("error", isError);
      };

      const fill = (tags, filter, note) => {
        const rows = [...tags];
        const lowerFilter = filter.toLowerCase();
        if (currentTag &&
            (filter.length === 0 || currentTag.toLowerCase().includes(lowerFilter)) &&
            rows.every(tag => tag.name !== currentTag)) {
          rows.unshift({ name: currentTag, updated: null });
        }

        tagsBody.replaceChildren();
        let current = null;
        for (const tag of rows) {
          let caption = tag.name;
          let updated = tag.updated === null ? "—" : Ui.formatShortDateTime(tag.updated);
          if (tag.name === currentTag) {
            caption += "  (aktuální)";
            if (tag.updated === null)
              updated = "v compose";
          }

          const row = Ui.element("tr", {}, [Ui.element("td", { text: caption, title: caption }), Ui.element("td", { text: updated })]);
          row.dataset.tag = tag.name;
          row.addEventListener("click", () => select(row));
          row.addEventListener("dblclick", () => {
            select(row);
            accept();
          });
          tagsBody.append(row);
          if (tag.name === currentTag)
            current = row;
        }

        select(current ?? tagsBody.firstElementChild);
        const count = tagsBody.children.length === 1 ? "1 tag" : `${tagsBody.children.length} tagů`;
        setStatus(note ? count + " — " + note : count, Boolean(note) && rows.length === 0);
      };

      const load = async (filter, loadGeneration) => {
        downloadButton.disabled = true;
        setStatus("Načítám tagy…", false);
        try {
          let tags;
          let note;
          if (reference.isDockerHub) {
            const page = await Ui.invoke("images:listTags", reference, filter);
            tags = page.tags;
            note = page.warning;
          } else {
            if (!registryTask)
              registryTask = Ui.invoke("images:listTags", reference, null);
            try {
              const page = await registryTask;
              registryTags = page.tags;
              registryNote = page.warning;
            } catch (error) {
              registryTask = null;
              if (closed)
                return;
              registryNote = error.message;
              registryTags = [];
            }

            if (closed || loadGeneration !== generation)
              return;
            const lowerFilter = filter.toLowerCase();
            tags = filter.length === 0 ? registryTags : registryTags.filter(tag => tag.name.toLowerCase().includes(lowerFilter));
            note = registryNote;
          }

          if (closed || loadGeneration !== generation)
            return;
          fill(tags, filter, note);
        } catch (error) {
          if (closed || loadGeneration !== generation)
            return;
          tagsBody.replaceChildren();
          select(null);
          setStatus(error.message, true);
        }
      };

      const startLoad = () => {
        generation++;
        load(filterInput.value.trim(), generation);
      };

      filterInput.addEventListener("input", () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(startLoad, 400);
      });
      filterInput.addEventListener("keydown", event => {
        if (event.key !== "Enter")
          return;
        event.preventDefault();
        clearTimeout(filterTimer);
        startLoad();
      });
      tagsContainer.addEventListener("keydown", event => {
        const selected = tagsBody.querySelector("tr.selected");
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = event.key === "ArrowDown" ? selected?.nextElementSibling : selected?.previousElementSibling;
          if (next)
            select(next);
        } else if (event.key === "Enter") {
          event.preventDefault();
          accept();
        }
      });
      downloadButton.addEventListener("click", accept);

      modal.body.append(
        Ui.element("div", { className: "repository", text: reference.repositoryLabel }),
        Ui.element("div", { className: "current", text: "Teď v compose: " + currentImage, title: currentImage }),
        filterInput,
        tagsContainer,
        statusLabel);
      modal.buttonBar.append(Ui.element("button", { text: "Zrušit", onClick: () => finish(null) }), downloadButton);
      filterInput.focus();
      startLoad();
    });
  }

  return { open };
})();
