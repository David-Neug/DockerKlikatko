"use strict";

(() => {
  const REFRESH_MS = 3000;
  const NO_COMPOSE = "(bez compose)";

  const view = {
    composeInfo: Ui.byId("composeInfo"),
    gridContainer: Ui.byId("gridContainer"),
    projectsBody: Ui.byId("projectsBody"),
    stopButton: Ui.byId("stopButton"),
    refreshButton: Ui.byId("refreshButton"),
    statusLabel: Ui.byId("statusLabel"),
    closeButton: Ui.byId("closeButton")
  };

  const state = {
    model: null,
    selectedName: null,
    loading: false,
    stopping: false
  };

  function projectTitle(project) {
    return project.name.length > 0 ? project.name : NO_COMPOSE;
  }

  function selectedProject() {
    return state.model?.projects.find(project => project.name === state.selectedName) ?? null;
  }

  function setStatus(text, tooltip) {
    view.statusLabel.textContent = text;
    view.statusLabel.title = tooltip ?? text;
  }

  // Souvislé řady portů se zkrátí na rozsah, např. 47400–47470.
  function formatPorts(ports) {
    if (ports.length === 0)
      return "—";
    const parts = [];
    let first = ports[0];
    let last = ports[0];
    for (const port of [...ports.slice(1), null]) {
      if (port === last + 1) {
        last = port;
        continue;
      }
      parts.push(first === last ? String(first) : `${first}–${last}`);
      first = last = port;
    }
    return parts.join(", ");
  }

  function containerState(container) {
    return container.health.length > 0 ? `${container.state} (${container.health})` : container.state;
  }

  function cell(text, tooltip, className) {
    const node = Ui.element("td", { text, title: tooltip ?? text });
    if (className)
      node.className = className;
    return node;
  }

  function projectRow(project) {
    const conflict = project.conflictPorts.length > 0;
    const row = Ui.element("tr", { className: "project" }, [
      cell(projectTitle(project) + (project.own ? " (načtený)" : "")),
      cell(project.workingDir || "—", [project.workingDir, project.configFiles].filter(Boolean).join("\n") || "—"),
      cell(`${project.containers.length} běží`),
      cell(formatPorts(project.ports)),
      cell(conflict ? formatPorts(project.conflictPorts) : "—", null, "conflict-ports")
    ]);
    if (project.own)
      row.classList.add("own");
    if (conflict)
      row.classList.add("conflict");
    return row;
  }

  function containerRow(project, container) {
    const conflictPorts = container.ports.filter(port => project.conflictPorts.includes(port));
    const startedAt = container.startedAt ? "\nBěží od " + Ui.formatDateTime(container.startedAt) : "";
    const row = Ui.element("tr", { className: "container" }, [
      cell(container.name, `${container.name}\nSlužba: ${container.service || "—"}\nId: ${container.id}`),
      cell(container.image),
      cell(containerState(container), containerState(container) + startedAt),
      cell(formatPorts(container.ports)),
      cell(conflictPorts.length > 0 ? formatPorts(conflictPorts) : "", null, "conflict-ports")
    ]);
    if (conflictPorts.length > 0)
      row.classList.add("conflict");
    return row;
  }

  function bindGrid() {
    const projects = state.model?.projects ?? [];
    if (!projects.some(project => project.name === state.selectedName))
      state.selectedName = projects.find(project => project.conflictPorts.length > 0)?.name ?? projects[0]?.name ?? null;

    const rows = [];
    for (const project of projects) {
      const group = [projectRow(project), ...project.containers.map(container => containerRow(project, container))];
      for (const row of group) {
        row.addEventListener("click", () => selectProject(project.name));
        if (project.name === state.selectedName)
          row.classList.add("selected");
      }
      rows.push(...group);
    }

    if (rows.length === 0)
      rows.push(Ui.element("tr", {}, [Ui.element("td", { className: "empty", colSpan: 5, text: "Žádný kontejner neběží." })]));
    view.projectsBody.replaceChildren(...rows);
    updateButtons();
  }

  function bindComposeInfo() {
    const model = state.model;
    if (!model?.composeFile) {
      view.composeInfo.textContent = "V hlavním okně není načtený docker-compose, konflikty portů se nezvýrazňují.";
      return;
    }
    const conflicting = model.projects.filter(project => project.conflictPorts.length > 0).map(projectTitle);
    const own = model.ownProject ? ` (projekt ${model.ownProject})` : "";
    const summary = conflicting.length === 0
      ? "Žádný jiný projekt nedrží jeho porty."
      : "Jeho porty drží: " + conflicting.join(", ") + ".";
    view.composeInfo.textContent = `Načtený compose: ${model.composeFile}${own}. ${summary}`;
    view.composeInfo.title = view.composeInfo.textContent;
  }

  function selectProject(name) {
    state.selectedName = name;
    bindGrid();
  }

  function moveSelection(offset) {
    const projects = state.model?.projects ?? [];
    if (projects.length === 0)
      return;
    const index = projects.findIndex(project => project.name === state.selectedName);
    const next = Math.min(projects.length - 1, Math.max(0, index + offset));
    selectProject(projects[next].name);
  }

  function updateButtons() {
    view.stopButton.disabled = state.stopping || !selectedProject() || selectedProject().own;
    view.refreshButton.disabled = state.stopping;
  }

  async function refresh() {
    if (state.loading || state.stopping)
      return;
    state.loading = true;
    try {
      state.model = await Ui.invoke("projects:list");
      bindComposeInfo();
      bindGrid();
    } catch (error) {
      if (!error.canceled)
        setStatus(Ui.lastLine(error.message), error.message);
    } finally {
      state.loading = false;
    }
  }

  async function stopSelected() {
    const project = selectedProject();
    if (!project || project.own || state.stopping)
      return;

    const title = projectTitle(project);
    const what = project.name.length > 0
      ? `Zastavit compose projekt ${title}?\n\nSložka: ${project.workingDir || "—"}`
      : "Zastavit kontejnery, které nepatří žádnému compose projektu?";
    const names = project.containers.map(container => container.name).join("\n");
    if (!await Ui.confirm("Zastavit projekt", `${what}\n\nKontejnery (${project.containers.length}):\n${names}`))
      return;

    state.stopping = true;
    updateButtons();
    setStatus(`Zastavuji ${title}…`);
    try {
      const result = await Ui.invoke("projects:stop", project.name);
      if (result.success) {
        setStatus(`Projekt ${title} zastaven`);
      } else {
        setStatus(Ui.errorLine(result.errorText), Ui.trimForDialog(result.errorText));
        await Ui.showError(result.errorText);
      }
    } catch (error) {
      if (!error.canceled) {
        setStatus(Ui.lastLine(error.message));
        await Ui.showError(error.message, error);
      }
    } finally {
      state.stopping = false;
      updateButtons();
    }
    await refresh();
  }

  view.stopButton.addEventListener("click", stopSelected);
  view.refreshButton.addEventListener("click", refresh);
  view.closeButton.addEventListener("click", () => window.close());
  view.gridContainer.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
      return;
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !document.querySelector(".modal-backdrop"))
      window.close();
  });

  Ui.on("projects:lines", lines => {
    const line = lines.map(item => item.trim()).filter(item => item.length > 0).at(-1);
    if (line && state.stopping)
      setStatus(line);
  });
  Ui.setErrorContext(() => ({ vybranýProjekt: state.selectedName, zastavuje: state.stopping }));

  refresh().then(() => setInterval(refresh, REFRESH_MS));
})();
