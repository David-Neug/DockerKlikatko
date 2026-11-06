"use strict";

(() => {
  const ALL_SERVICES = "Všechny služby";
  const MISSING_COMPOSE = "Soubor docker-compose neexistuje.";

  const view = {
    titleLabel: Ui.byId("titleLabel"),
    subtitleLabel: Ui.byId("subtitleLabel"),
    environmentStatusLabel: Ui.byId("environmentStatusLabel"),
    startWslButton: Ui.byId("startWslButton"),
    stopWslButton: Ui.byId("stopWslButton"),
    refreshStatusButton: Ui.byId("refreshStatusButton"),
    liveListButton: Ui.byId("liveListButton"),
    composePathInput: Ui.byId("composePathInput"),
    browseComposeButton: Ui.byId("browseComposeButton"),
    loadComposeButton: Ui.byId("loadComposeButton"),
    groupsPanel: Ui.byId("groupsPanel"),
    groupsList: Ui.byId("groupsList"),
    addGroupButton: Ui.byId("addGroupButton"),
    editGroupButton: Ui.byId("editGroupButton"),
    deleteGroupButton: Ui.byId("deleteGroupButton"),
    startGroupButton: Ui.byId("startGroupButton"),
    stopGroupButton: Ui.byId("stopGroupButton"),
    pullGroupButton: Ui.byId("pullGroupButton"),
    splitter: Ui.byId("splitter"),
    refreshServicesButton: Ui.byId("refreshServicesButton"),
    startServiceButton: Ui.byId("startServiceButton"),
    stopServiceButton: Ui.byId("stopServiceButton"),
    pullServiceButton: Ui.byId("pullServiceButton"),
    removeServiceButton: Ui.byId("removeServiceButton"),
    showLogsButton: Ui.byId("showLogsButton"),
    localBinariesButton: Ui.byId("localBinariesButton"),
    autoRefreshCheckBox: Ui.byId("autoRefreshCheckBox"),
    refreshIntervalInput: Ui.byId("refreshIntervalInput"),
    gridContainer: Ui.byId("gridContainer"),
    servicesBody: Ui.byId("servicesBody"),
    operationProgress: Ui.byId("operationProgress"),
    operationStatusLabel: Ui.byId("operationStatusLabel")
  };

  const state = {
    platform: "win32",
    settings: null,
    settingsPath: "",
    services: [],
    runtime: new Map(),
    runtimeKnown: false,
    busyCount: 0,
    autoRefreshRunning: false,
    selectedServiceName: null,
    selectedGroupIndex: 0,
    recentOperationLines: [],
    currentOperation: null,
    refreshTimer: null
  };

  const isWindows = () => state.platform === "win32";

  function sameName(left, right) {
    return (left ?? "").toLowerCase() === (right ?? "").toLowerCase();
  }

  function runtimeOf(serviceName) {
    return state.runtime.get(serviceName.toLowerCase()) ?? null;
  }

  function isRunningState(runtime) {
    return (runtime?.state ?? "").toLowerCase() === "running";
  }

  function currentComposePath() {
    return view.composePathInput.value.trim().replace(/^"+|"+$/g, "");
  }

  function selectedGroup() {
    return state.selectedGroupIndex > 0 ? state.settings.groups[state.selectedGroupIndex - 1] ?? null : null;
  }

  function selectedService() {
    return state.services.find(service => sameName(service.name, state.selectedServiceName)) ?? null;
  }

  function visibleServices() {
    const group = selectedGroup();
    if (!group)
      return state.services;
    const names = new Set(group.services.map(name => name.toLowerCase()));
    return state.services.filter(service => names.has(service.name.toLowerCase()));
  }

  function mappingFor(serviceName) {
    return state.settings.localBinaries.find(mapping => sameName(mapping.serviceName, serviceName)) ?? null;
  }

  function fileExists(target) {
    return Ui.invoke("compose:fileExists", target);
  }

  async function requireComposeFile() {
    const target = currentComposePath();
    return await fileExists(target) ? target : null;
  }

  function setOperationStatus(text, tooltip) {
    view.operationStatusLabel.textContent = text;
    view.operationStatusLabel.title = tooltip ?? text;
  }

  async function persist() {
    state.settings.composePath = currentComposePath();
    state.settings.autoRefresh = view.autoRefreshCheckBox.checked;
    state.settings.refreshSeconds = refreshSeconds();
    try {
      state.settings = await Ui.invoke("settings:save", state.settings);
    } catch (error) {
      setOperationStatus(Ui.lastLine(error.message), error.message);
    }
  }

  function refreshSeconds() {
    const value = Number.parseInt(view.refreshIntervalInput.value, 10);
    return Number.isFinite(value) ? Math.min(300, Math.max(5, value)) : 10;
  }

  // Prostředí: na Windows WSL, na Linuxu přímo Docker daemon.

  function applyEnvironment(snapshot) {
    const label = view.environmentStatusLabel;
    const prefix = isWindows() ? "WSL" : "Docker";
    label.classList.remove("running");
    if (!snapshot.known) {
      label.textContent = `${prefix}: Neznámý stav`;
      return;
    }
    if (snapshot.isRunning) {
      label.textContent = `${prefix}: Běží`;
      label.classList.add("running");
      return;
    }
    label.textContent = isWindows() ? "WSL: Zastaveno" : "Docker: Neběží";
  }

  async function refreshEnvironmentCore() {
    const snapshot = await Ui.invoke(isWindows() ? "wsl:status" : "docker:engineStatus");
    applyEnvironment(snapshot);
    if (snapshot.known)
      return null;
    return snapshot.error && snapshot.error.trim().length > 0 ? snapshot.error : (isWindows() ? "Stav WSL nejde zjistit." : "Stav Dockeru nejde zjistit.");
  }

  async function refreshEnvironment(reportError) {
    if (state.busyCount > 0)
      return;
    state.busyCount++;
    updateButtons();
    try {
      const error = await refreshEnvironmentCore();
      if (reportError && error) {
        setOperationStatus(Ui.lastLine(error));
        await Ui.showError(error);
      }
    } catch (error) {
      if (!error.canceled)
        setOperationStatus(Ui.lastLine(error.message));
    } finally {
      state.busyCount--;
      updateButtons();
    }
  }

  async function refreshEnvironmentAndRuntime() {
    const statusError = await refreshEnvironmentCore();
    if (state.services.length === 0)
      return statusError;
    const runtimeError = await queryRuntime();
    return runtimeError ?? statusError;
  }

  function startWsl() {
    return runOperation("Spouštím WSL…", "WSL běží", async () => {
      const snapshot = await Ui.invoke("wsl:status");
      if (!snapshot.known)
        return snapshot.error && snapshot.error.trim().length > 0 ? snapshot.error : "Stav WSL nejde zjistit.";
      if (!snapshot.defaultDistro)
        return "Není nastavená výchozí distribuce WSL.";

      const result = await Ui.invoke("wsl:start", snapshot.defaultDistro);
      if (!result.success)
        return result.errorText;
      return refreshEnvironmentAndRuntime();
    });
  }

  async function stopWsl() {
    if (!await Ui.confirm("Zastavit WSL", "Zastavit WSL? Zastaví se všechny distribuce a Docker."))
      return;

    await runOperation("Zastavuji WSL…", "WSL je zastaveno", async () => {
      const result = await Ui.invoke("wsl:shutdown");
      if (!result.success)
        return result.errorText;
      return refreshEnvironmentAndRuntime();
    });
  }

  function refreshAll() {
    return runOperation("Obnovuji stav…", "Stav obnoven", refreshEnvironmentAndRuntime);
  }

  // Compose a stav kontejnerů.

  async function browseCompose() {
    const selected = await Ui.invoke("dialog:openCompose", currentComposePath());
    if (selected) {
      view.composePathInput.value = selected;
      await persist();
    }
  }

  function loadCompose() {
    return runOperation("Načítám služby…", "Služby načteny", async () => {
      const target = currentComposePath();
      if (!await fileExists(target))
        return MISSING_COMPOSE;

      let loaded;
      try {
        loaded = await Ui.invoke("compose:read", target);
      } catch (error) {
        return error.message;
      }

      state.services = loaded;
      await persist();
      bindGrid();
      return queryRuntime();
    });
  }

  async function reloadComposeServices(target) {
    try {
      state.services = await Ui.invoke("compose:read", target);
      bindGrid();
      return null;
    } catch (error) {
      return error.message;
    }
  }

  function clearRuntime() {
    state.runtimeKnown = false;
    state.runtime = new Map();
    bindGrid();
  }

  async function queryRuntime() {
    const target = currentComposePath();
    if (!await fileExists(target)) {
      clearRuntime();
      return MISSING_COMPOSE;
    }

    let query;
    try {
      query = await Ui.invoke("docker:query", target, state.services, state.settings.localBinaries);
    } catch (error) {
      if (error.canceled)
        throw error;
      clearRuntime();
      return error.message;
    }

    if (!query.success) {
      clearRuntime();
      return query.error && query.error.trim().length > 0 ? query.error : "Docker neodpověděl.";
    }

    state.runtimeKnown = true;
    state.runtime = new Map(Object.entries(query.byService));
    bindGrid();
    return null;
  }

  function refreshServices() {
    return runOperation("Obnovuji služby…", "Stav obnoven", queryRuntime);
  }

  // Akce nad vybranou službou.

  async function startSelected() {
    const service = selectedService();
    const target = await requireComposeFile();
    if (!service || !target)
      return;

    const note = service.replicas === 0 ? " (v compose je vypnutá, spouštím jednu instanci)" : "";
    await runOperation(`Spouštím ${service.name}…${note}`, "Hotovo", async () => {
      const result = await Ui.invoke("docker:up", target, [service]);
      return result.success ? queryRuntime() : result.errorText;
    });
  }

  async function stopSelected() {
    const service = selectedService();
    const target = await requireComposeFile();
    if (!service || !target)
      return;

    await runOperation(`Zastavuji ${service.name}…`, "Hotovo", async () => {
      const result = await Ui.invoke("docker:stop", target, [service.name]);
      return result.success ? queryRuntime() : result.errorText;
    });
  }

  async function fetchSelected() {
    const service = selectedService();
    const target = await requireComposeFile();
    if (!service || !target)
      return;

    if (service.usesBuild && !service.usesImage) {
      await runOperation(`Sestavuji ${service.name}…`, "Hotovo", async () => {
        const result = await Ui.invoke("docker:fetch", target, service);
        return result.success ? queryRuntime() : result.errorText;
      });
      return;
    }

    if (!service.image || service.image.trim().length === 0) {
      await Ui.showError(`Služba ${service.name} nemá image ani build.`);
      return;
    }

    let reference;
    try {
      reference = await Ui.invoke("images:parse", service.image);
    } catch (error) {
      await Ui.showError(error.message);
      return;
    }

    const tag = await ImagePicker.open(service.name, service.image, reference);
    if (!tag)
      return;

    let newImage;
    try {
      newImage = await Ui.invoke("images:withTag", service.image, tag);
    } catch (error) {
      await Ui.showError(error.message);
      return;
    }

    const changed = newImage !== service.image;
    const wasRunning = isRunningState(runtimeOf(service.name));
    const success = !changed
      ? "Hotovo"
      : wasRunning
        ? `Hotovo. V compose je ${newImage}. Běžící kontejner pořád používá starý image, dokud službu znovu nespustíte.`
        : `Hotovo. V compose je ${newImage}.`;

    await runOperation(`Stahuji ${newImage}…`, success, async () => {
      const result = await Ui.invoke("docker:pullImage", target, newImage);
      if (!result.success)
        return result.errorText;
      if (!changed)
        return queryRuntime();

      try {
        await Ui.invoke("compose:replaceImage", target, service.name, newImage);
      } catch (error) {
        return "Image je stažený, ale compose se nepodařilo upravit: " + error.message;
      }

      const reloadError = await reloadComposeServices(target);
      if (reloadError)
        return "Image je stažený a compose upravený, ale seznam se nepodařilo znovu načíst: " + reloadError;
      return queryRuntime();
    });
  }

  async function removeSelected() {
    const service = selectedService();
    const target = await requireComposeFile();
    if (!service || !target)
      return;

    if (!await Ui.confirm("Odstranit kontejner", `Odstranit kontejner služby ${service.name}? Volumes a data databází zůstanou, image se nesmaže.`))
      return;

    await runOperation(`Odstraňuji ${service.name}…`, "Hotovo", async () => {
      const result = await Ui.invoke("docker:remove", target, service.name);
      return result.success ? queryRuntime() : result.errorText;
    });
  }

  async function showLogs() {
    const service = selectedService();
    const target = await requireComposeFile();
    if (!service || !target) {
      if (!target)
        await Ui.showError(MISSING_COMPOSE);
      return;
    }
    await Ui.invoke("window:openLogs", target, service.name);
  }

  async function showLocalBinaries() {
    const service = selectedService();
    const target = await requireComposeFile();
    if (!service || !target)
      return;

    const mapping = mappingFor(service.name);
    if (!mapping)
      return;

    const current = runtimeOf(service.name);
    if (!current || !current.consoleStarted || current.startedAt === null) {
      await Ui.showError(`Kontejner služby ${service.name} neběží nebo ještě nenastartovala konzole ("Console starting ...").`);
      return;
    }

    const bin = await Ui.invoke("binaries:resolveBinPath", mapping, service);
    if (!bin.binPath) {
      await Ui.showError(`Cestu k Bin nejde odvodit z volumes služby ${service.name} (chybí mapování na /dtf-test). Nastavte binPath v settings.json.`);
      return;
    }
    if (!bin.exists) {
      await Ui.showError(`Složka Bin neexistuje: ${bin.binPath}`);
      return;
    }

    await Ui.invoke("window:openLocalBinaries", {
      composeFile: target,
      serviceName: service.name,
      mapping,
      containerName: current.containerName,
      containerStartedAt: current.startedAt,
      binPath: bin.binPath
    });
    // Okno binárek může v settings.json změnit cestu k projektu.
    state.settings = (await Ui.invoke("settings:load")).settings;
    await refreshServices();
  }

  // Skupiny.

  function resolveGroup(group) {
    const found = [];
    const missing = [];
    for (const name of group.services) {
      const service = state.services.find(item => sameName(item.name, name));
      if (service)
        found.push(service);
      else
        missing.push(name);
    }
    return { found, missing };
  }

  function currentGroupAction() {
    if (state.services.length === 0)
      return null;
    const group = selectedGroup();
    if (!group)
      return { progressName: "všechny služby", services: [...state.services], missing: [] };
    const { found, missing } = resolveGroup(group);
    return { progressName: `skupinu ${group.name}`, services: found, missing };
  }

  function successWithMissing(missing) {
    return missing.length === 0 ? "Hotovo" : "Hotovo. V compose chybí: " + missing.join(", ");
  }

  async function groupTarget() {
    const target = currentGroupAction();
    const composePath = await requireComposeFile();
    if (!target || !composePath)
      return null;
    if (target.services.length === 0) {
      await Ui.showError("Ve skupině není žádná služba z načteného compose.");
      return null;
    }
    return { ...target, composePath };
  }

  async function startGroup() {
    const target = await groupTarget();
    if (!target)
      return;
    await runOperation(`Spouštím ${target.progressName}…`, successWithMissing(target.missing), async () => {
      const result = await Ui.invoke("docker:up", target.composePath, target.services);
      return result.success ? queryRuntime() : result.errorText;
    });
  }

  async function stopGroup() {
    const target = await groupTarget();
    if (!target)
      return;
    await runOperation(`Zastavuji ${target.progressName}…`, successWithMissing(target.missing), async () => {
      const result = await Ui.invoke("docker:stop", target.composePath, target.services.map(service => service.name));
      return result.success ? queryRuntime() : result.errorText;
    });
  }

  async function fetchGroup() {
    const target = await groupTarget();
    if (!target)
      return;
    await runOperation(`Připravuji image — ${target.progressName}…`, successWithMissing(target.missing), async () => {
      const errors = [];
      const found = target.services;
      for (let i = 0; i < found.length; i++) {
        const service = found[i];
        setOperationStatus(service.usesBuild && !service.usesImage
          ? `Sestavuji ${service.name} (${i + 1}/${found.length})…`
          : `Stahuji ${service.name} (${i + 1}/${found.length})…`);
        const result = await Ui.invoke("docker:fetch", target.composePath, service);
        if (!result.success)
          errors.push(service.name + ": " + Ui.lastLine(result.errorText));
      }

      const runtimeError = await queryRuntime();
      return errors.length > 0 ? errors.join("\n") : runtimeError;
    });
  }

  async function addGroup() {
    if (state.services.length === 0) {
      await Ui.showError("Nejdřív načtěte docker-compose.");
      return;
    }

    const result = await GroupEditor.open(
      "Nová skupina",
      "",
      state.services.map(service => service.name),
      [],
      state.settings.groups.map(group => group.name));
    if (!result)
      return;

    state.settings.groups.push({ name: result.name, services: result.services });
    await persist();
    bindGroups(result.name);
  }

  async function editGroup() {
    const group = selectedGroup();
    if (!group)
      return;
    if (state.services.length === 0) {
      await Ui.showError("Nejdřív načtěte docker-compose.");
      return;
    }

    const result = await GroupEditor.open(
      "Upravit skupinu",
      group.name,
      state.services.map(service => service.name),
      group.services,
      state.settings.groups.map(item => item.name).filter(name => !sameName(name, group.name)));
    if (!result)
      return;

    group.name = result.name;
    group.services = result.services;
    await persist();
    bindGroups(result.name);
  }

  async function deleteGroup() {
    const group = selectedGroup();
    if (!group)
      return;
    if (!await Ui.confirm("Smazat skupinu", `Smazat skupinu ${group.name}? Kontejnery se nemažou.`))
      return;

    state.settings.groups.splice(state.settings.groups.indexOf(group), 1);
    await persist();
    bindGroups();
  }

  // Průběh operací.

  function applyOperationLine(line) {
    if (state.busyCount === 0)
      return;
    let text = line.trim();
    if (text.length === 0)
      return;
    if (text.length > 500)
      text = text.slice(0, 500);

    state.recentOperationLines.push(text);
    while (state.recentOperationLines.length > 25)
      state.recentOperationLines.shift();
    setOperationStatus(text, state.recentOperationLines.join("\n"));
  }

  async function runOperation(progress, success, action) {
    if (state.busyCount > 0)
      return;

    state.busyCount++;
    state.currentOperation = progress;
    view.operationProgress.classList.add("running");
    state.recentOperationLines = [];
    setOperationStatus(progress);
    updateButtons();
    try {
      const error = await action();
      if (!error) {
        setOperationStatus(success);
        return;
      }
      setOperationStatus(Ui.errorLine(error), Ui.trimForDialog(error));
      await Ui.showError(error);
    } catch (error) {
      if (error.canceled) {
        setOperationStatus("Zrušeno");
        return;
      }
      setOperationStatus(Ui.lastLine(error.message));
      await Ui.showError(error.message, error);
    } finally {
      state.busyCount--;
      state.currentOperation = null;
      view.operationProgress.classList.remove("running");
      updateButtons();
    }
  }

  // Automatická obnova.

  function configureTimer() {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    if (view.autoRefreshCheckBox.checked)
      state.refreshTimer = setInterval(refreshTimerTick, Math.max(5000, refreshSeconds() * 1000));
  }

  async function refreshTimerTick() {
    if (state.busyCount > 0 || state.autoRefreshRunning || state.services.length === 0)
      return;

    state.autoRefreshRunning = true;
    try {
      const error = await queryRuntime();
      if (state.busyCount === 0 && error)
        setOperationStatus(Ui.lastLine(error));
    } catch {
      // Zrušeno při zavírání okna.
    } finally {
      state.autoRefreshRunning = false;
    }
  }

  // Vykreslení.

  function bindGroups(selectName) {
    const previous = selectName ?? selectedGroup()?.name ?? null;
    let index = 0;
    if (previous) {
      const found = state.settings.groups.findIndex(group => sameName(group.name, previous));
      if (found >= 0)
        index = found + 1;
    }
    state.selectedGroupIndex = index;

    const titles = [ALL_SERVICES, ...state.settings.groups.map(group => group.name)];
    view.groupsList.replaceChildren(...titles.map((title, itemIndex) => {
      const item = Ui.element("div", { className: "list-item", text: title, title });
      item.classList.toggle("selected", itemIndex === index);
      item.addEventListener("click", () => selectGroup(itemIndex));
      return item;
    }));
    bindGrid();
  }

  function selectGroup(index) {
    if (state.busyCount > 0 || index === state.selectedGroupIndex)
      return;
    state.selectedGroupIndex = index;
    [...view.groupsList.children].forEach((item, itemIndex) => item.classList.toggle("selected", itemIndex === index));
    view.groupsList.children[index]?.scrollIntoView({ block: "nearest" });
    bindGrid();
  }

  function createCell(text, tooltip) {
    const cell = Ui.element("td", { text });
    if (tooltip)
      cell.title = tooltip;
    return cell;
  }

  function createRow(service) {
    const current = runtimeOf(service.name);
    const known = state.runtimeKnown;
    const mapping = mappingFor(service.name);

    const runningCell = createCell(known ? ServicePresentation.runningImageText(current) : "—");
    if (known && ServicePresentation.imageDiffers(service, current)) {
      runningCell.style.background = ServicePresentation.MISMATCH_BACK;
      runningCell.title = "Spuštěný image se liší od compose.";
    } else if (current?.configImage) {
      runningCell.title = current.configImage;
    }

    const row = Ui.element("tr", {}, [
      createCell(service.name, service.name),
      createCell(service.configuredImageText, service.configuredTooltip),
      runningCell,
      createCell(
        ServicePresentation.binariesText(mapping, service, current, known),
        ServicePresentation.binariesTooltip(mapping, service, current, known, state.settingsPath)),
      createCell(service.memoryLimit && service.memoryLimit.trim().length > 0 ? service.memoryLimit : "—"),
      createCell(known && current?.cpu ? current.cpu : "—"),
      createCell(known && current?.memory ? current.memory : "—"),
      createCell(service.portsDisplay, service.portsTooltip),
      createCell(ServicePresentation.statusText(current, known), current?.status || null),
      createCell(ServicePresentation.healthText(current, known))
    ]);

    const back = ServicePresentation.rowBackColor(current, known);
    if (back)
      row.style.background = back;
    row.dataset.service = service.name;
    row.addEventListener("mousedown", () => selectService(service.name));
    return row;
  }

  function bindGrid() {
    const visible = visibleServices();
    if (!visible.some(service => sameName(service.name, state.selectedServiceName)))
      state.selectedServiceName = visible[0]?.name ?? null;

    const scrollTop = view.gridContainer.scrollTop;
    view.servicesBody.replaceChildren(...visible.map(createRow));
    view.gridContainer.scrollTop = scrollTop;
    markSelectedRow();
    updateButtons();
  }

  function markSelectedRow() {
    for (const row of view.servicesBody.children)
      row.classList.toggle("selected", sameName(row.dataset.service, state.selectedServiceName));
  }

  function selectService(name) {
    if (sameName(name, state.selectedServiceName))
      return;
    state.selectedServiceName = name;
    markSelectedRow();
    view.servicesBody.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
    updateButtons();
  }

  function moveSelection(offset) {
    const rows = [...view.servicesBody.children];
    const index = rows.findIndex(row => row.classList.contains("selected"));
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + offset))];
    if (next)
      selectService(next.dataset.service);
  }

  function updateButtons() {
    const busy = state.busyCount > 0;
    const service = selectedService();
    const hasService = service !== null;
    const group = selectedGroup();
    const hasServices = state.services.length > 0;
    const hasGroup = hasServices && (state.selectedGroupIndex === 0 || (group !== null && group.services.length > 0));
    const hasMapping = hasService && mappingFor(service.name) !== null;
    const current = hasService ? runtimeOf(service.name) : null;

    view.startWslButton.disabled = busy;
    view.stopWslButton.disabled = busy;
    view.refreshStatusButton.disabled = busy;
    view.browseComposeButton.disabled = busy;
    view.loadComposeButton.disabled = busy;
    view.refreshServicesButton.disabled = busy || !hasServices;
    view.startServiceButton.disabled = busy || !hasService;
    view.stopServiceButton.disabled = busy || !hasService;
    view.pullServiceButton.disabled = busy || !hasService;
    view.removeServiceButton.disabled = busy || !hasService;
    view.showLogsButton.disabled = busy || !hasService;
    view.localBinariesButton.hidden = !hasMapping;
    view.localBinariesButton.disabled = busy || !hasMapping || !state.runtimeKnown ||
      !current || !current.consoleStarted || !isRunningState(current);
    view.addGroupButton.disabled = busy || !hasServices;
    view.editGroupButton.disabled = busy || group === null || !hasServices;
    view.deleteGroupButton.disabled = busy || group === null;
    view.startGroupButton.disabled = busy || !hasGroup;
    view.stopGroupButton.disabled = busy || !hasGroup;
    view.pullGroupButton.disabled = busy || !hasGroup;
    view.autoRefreshCheckBox.disabled = busy;
    view.refreshIntervalInput.disabled = busy;
    view.groupsList.classList.toggle("disabled", busy);
  }

  // Ovládání.

  function wireSplitter() {
    view.splitter.addEventListener("mousedown", start => {
      start.preventDefault();
      const startX = start.clientX;
      const startWidth = view.groupsPanel.getBoundingClientRect().width;
      const onMove = move => {
        const width = Math.min(window.innerWidth * 0.5, Math.max(230, startWidth + move.clientX - startX));
        view.groupsPanel.style.width = width + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function wireEvents() {
    view.startWslButton.addEventListener("click", startWsl);
    view.stopWslButton.addEventListener("click", stopWsl);
    view.refreshStatusButton.addEventListener("click", refreshAll);
    view.liveListButton.addEventListener("click", () => Ui.invoke("window:openLive"));
    view.browseComposeButton.addEventListener("click", browseCompose);
    view.loadComposeButton.addEventListener("click", loadCompose);
    view.composePathInput.addEventListener("keydown", event => {
      if (event.key !== "Enter")
        return;
      event.preventDefault();
      loadCompose();
    });
    view.composePathInput.addEventListener("change", persist);

    view.refreshServicesButton.addEventListener("click", refreshServices);
    view.startServiceButton.addEventListener("click", startSelected);
    view.stopServiceButton.addEventListener("click", stopSelected);
    view.pullServiceButton.addEventListener("click", fetchSelected);
    view.removeServiceButton.addEventListener("click", removeSelected);
    view.showLogsButton.addEventListener("click", showLogs);
    view.localBinariesButton.addEventListener("click", showLocalBinaries);

    view.addGroupButton.addEventListener("click", addGroup);
    view.editGroupButton.addEventListener("click", editGroup);
    view.deleteGroupButton.addEventListener("click", deleteGroup);
    view.startGroupButton.addEventListener("click", startGroup);
    view.stopGroupButton.addEventListener("click", stopGroup);
    view.pullGroupButton.addEventListener("click", fetchGroup);

    view.groupsList.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
        return;
      event.preventDefault();
      const count = state.settings.groups.length + 1;
      selectGroup(Math.min(count - 1, Math.max(0, state.selectedGroupIndex + (event.key === "ArrowDown" ? 1 : -1))));
    });
    view.gridContainer.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
        return;
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    });

    view.autoRefreshCheckBox.addEventListener("change", () => {
      configureTimer();
      persist();
    });
    view.refreshIntervalInput.addEventListener("change", () => {
      view.refreshIntervalInput.value = String(refreshSeconds());
      configureTimer();
      persist();
    });

    Ui.on("operation:lines", lines => lines.forEach(applyOperationLine));
    Ui.setErrorContext(errorContext);
    wireSplitter();
  }

  function errorContext() {
    const service = selectedService();
    return {
      operace: state.currentOperation ?? "(žádná)",
      posledniRadkyOperace: state.recentOperationLines.slice(-10),
      composePath: currentComposePath(),
      skupina: selectedGroup()?.name ?? ALL_SERVICES,
      sluzba: service?.name ?? "(žádná)",
      sluzbaVCompose: service,
      stavKontejneru: service ? runtimeOf(service.name) : null,
      stavDockeruZnamy: state.runtimeKnown,
      pocetSluzeb: state.services.length,
      stavProstredi: view.environmentStatusLabel.textContent
    };
  }

  function applyPlatformTexts() {
    if (isWindows()) {
      document.title = "Správa Dockeru ve WSL";
      view.titleLabel.textContent = "Docker ve WSL";
      view.subtitleLabel.textContent = "Správa kontejnerů a služeb v prostředí WSL";
      return;
    }

    document.title = "Správa Dockeru";
    view.titleLabel.textContent = "Docker";
    view.subtitleLabel.textContent = "Správa kontejnerů a služeb docker-compose";
    view.startWslButton.hidden = true;
    view.stopWslButton.hidden = true;
  }

  async function initialize() {
    const loaded = await Ui.invoke("settings:load");
    state.platform = loaded.platform;
    state.settings = loaded.settings;
    state.settingsPath = loaded.settingsPath;

    applyPlatformTexts();
    view.composePathInput.value = state.settings.composePath;
    view.autoRefreshCheckBox.checked = state.settings.autoRefresh;
    view.refreshIntervalInput.value = String(state.settings.refreshSeconds);
    wireEvents();
    configureTimer();

    bindGroups();
    await refreshEnvironment(false);
    if (await fileExists(currentComposePath()))
      await loadCompose();
  }

  initialize().catch(error => Ui.showError(error.message, error));
})();
