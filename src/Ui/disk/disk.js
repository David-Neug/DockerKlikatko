"use strict";

(() => {
  const SERVICES_TAB = "services";
  const KINDS = ["image", "container", "volume", "buildCache"];
  const ALL_SERVICES = "";
  const OUTSIDE_COMPOSE = "\u0000outside";
  const SERVICE_DETAIL_ITEMS = 15;
  const ITEM_COLUMN_COUNT = 8;
  const DESCENDING_FIRST = new Set(["when", "size", "reclaim", "imageBytes", "containerBytes", "volumeBytes", "safeBytes", "requestBytes"]);
  const { SAFE, ON_REQUEST, IN_USE } = DiskPresentation;

  const view = {
    summaryBody: Ui.byId("summaryBody"),
    storageInfo: Ui.byId("storageInfo"),
    tabs: Ui.byId("tabs"),
    itemFilters: Ui.byId("itemFilters"),
    serviceFilter: Ui.byId("serviceFilter"),
    showInUseCheckBox: Ui.byId("showInUseCheckBox"),
    gridContainer: Ui.byId("gridContainer"),
    itemsColumns: Ui.byId("itemsColumns"),
    itemsHead: Ui.byId("itemsHead"),
    itemsBody: Ui.byId("itemsBody"),
    detailBox: Ui.byId("detailBox"),
    statusLabel: Ui.byId("statusLabel"),
    selectSafeButton: Ui.byId("selectSafeButton"),
    clearSelectionButton: Ui.byId("clearSelectionButton"),
    removeButton: Ui.byId("removeButton"),
    compactButton: Ui.byId("compactButton"),
    refreshButton: Ui.byId("refreshButton"),
    closeButton: Ui.byId("closeButton")
  };

  const state = {
    context: null,
    model: null,
    storage: null,
    tab: SERVICES_TAB,
    sorts: {},
    selected: new Set(),
    focusedKey: null,
    busy: false,
    operation: null
  };

  function allItems() {
    return state.model?.items ?? [];
  }

  function serviceNames() {
    return (state.context?.services ?? []).map(service => service.name);
  }

  function sumBy(list, select) {
    return list.reduce((total, item) => total + select(item), 0);
  }

  function reclaim(list) {
    return DiskPresentation.reclaimOf(list, allItems());
  }

  function selectedItems() {
    return allItems().filter(item => state.selected.has(item.key) && item.level !== IN_USE);
  }

  function matchesService(item) {
    const filter = view.serviceFilter.value;
    if (filter === ALL_SERVICES)
      return true;
    if (filter === OUTSIDE_COMPOSE)
      return !item.serviceName;
    return item.serviceName === filter;
  }

  // Bez kliknutí na hlavičku platí výchozí pořadí (fallback), jinak podle sloupce a výchozí pořadí rozhodne shodu.
  function sorted(list, valueOf, fallback) {
    const sort = state.sorts[state.tab];
    if (!sort)
      return [...list].sort(fallback);
    const direction = sort.descending ? -1 : 1;
    const isEmpty = value => value === null || value === undefined || value === "";
    return [...list].sort((left, right) => {
      const leftValue = valueOf(left, sort.key);
      const rightValue = valueOf(right, sort.key);
      // Prázdné hodnoty jsou vždy na konci, v obou směrech.
      if (isEmpty(leftValue) !== isEmpty(rightValue))
        return isEmpty(leftValue) ? 1 : -1;
      return direction * DiskPresentation.compareValues(leftValue, rightValue) || fallback(left, right);
    });
  }

  function toggleSort(key) {
    const current = state.sorts[state.tab];
    state.sorts[state.tab] = current?.key === key
      ? { key, descending: !current.descending }
      : { key, descending: DESCENDING_FIRST.has(key) };
    bindGrid();
  }

  function sortHeader(title, key) {
    const sort = state.sorts[state.tab];
    const arrow = sort?.key === key ? (sort.descending ? " ▼" : " ▲") : "";
    return Ui.element("th", { className: "sortable", text: title + arrow, title: `${title} – kliknutím seřadit`, onClick: () => toggleSort(key) });
  }

  function visibleItems() {
    return sorted(
      allItems().filter(item => item.kind === state.tab && matchesService(item) && (view.showInUseCheckBox.checked || item.level !== IN_USE)),
      DiskPresentation.sortValue,
      DiskPresentation.compareItems);
  }

  function setStatus(text, tooltip) {
    view.statusLabel.textContent = text;
    view.statusLabel.title = tooltip ?? text;
  }

  function cell(text, className, tooltip) {
    const node = Ui.element("td", { text: text ?? "" });
    if (className)
      node.className = className;
    node.title = tooltip ?? text ?? "";
    return node;
  }

  function headerRow(titles) {
    return Ui.element("tr", {}, titles.map(title => typeof title === "string" ? Ui.element("th", { text: title, title }) : title));
  }

  function setColumns(widths) {
    view.itemsColumns.replaceChildren(...widths.map(width => {
      const column = Ui.element("col");
      column.style.width = width;
      return column;
    }));
  }

  // Souhrn nahoře: čísla Dockeru a k nim naše rozdělení na bezpečné a na vyžádání.

  function bindSummary() {
    const rows = (state.model?.summary ?? []).map(row => {
      const own = allItems().filter(item => item.kind === row.kind);
      return {
        title: DiskPresentation.KIND_TITLES[row.kind] ?? row.kind,
        count: `${row.total} / ${row.active}`,
        sizeBytes: row.sizeBytes,
        docker: Ui.formatSize(row.reclaimableBytes) + (row.reclaimablePercent === null ? "" : ` (${row.reclaimablePercent} %)`),
        safeBytes: reclaim(own.filter(item => item.level === SAFE)),
        requestBytes: reclaim(own.filter(item => item.level === ON_REQUEST))
      };
    });
    const total = {
      title: "Celkem",
      count: "",
      sizeBytes: sumBy(rows, row => row.sizeBytes),
      docker: "",
      safeBytes: sumBy(rows, row => row.safeBytes),
      requestBytes: sumBy(rows, row => row.requestBytes)
    };

    view.summaryBody.replaceChildren(...[...rows, total].map(row => {
      const tr = Ui.element("tr", {}, [
        cell(row.title),
        cell(row.count, "number"),
        cell(Ui.formatSize(row.sizeBytes), "number"),
        cell(row.docker, "number"),
        cell(Ui.formatSize(row.safeBytes), "number"),
        cell(Ui.formatSize(row.requestBytes), "number")
      ]);
      if (row === total)
        tr.className = "total";
      return tr;
    }));
  }

  function bindTabs() {
    const tabs = [{ key: SERVICES_TAB, text: "Podle služeb" }, ...KINDS.map(kind => {
      const own = allItems().filter(item => item.kind === kind);
      const safe = reclaim(own.filter(item => item.level === SAFE));
      const count = kind === "buildCache" ? "" : ` (${own.length})`;
      return { key: kind, text: `${DiskPresentation.KIND_TITLES[kind]}${count}${safe > 0 ? " · bezpečně " + Ui.formatSize(safe) : ""}` };
    })];
    view.tabs.replaceChildren(...tabs.map(tab => {
      const button = Ui.element("button", { className: "tab", text: tab.text, onClick: () => selectTab(tab.key) });
      button.classList.toggle("selected", tab.key === state.tab);
      return button;
    }));
  }

  function bindServiceFilter() {
    const previous = view.serviceFilter.value;
    const withItems = new Set(allItems().map(item => item.serviceName).filter(Boolean));
    const options = [
      { value: ALL_SERVICES, text: "Všechny" },
      ...serviceNames().filter(name => withItems.has(name)).map(name => ({ value: name, text: name })),
      { value: OUTSIDE_COMPOSE, text: "Mimo služby compose" }
    ];
    view.serviceFilter.replaceChildren(...options.map(option => Ui.element("option", { value: option.value, text: option.text })));
    view.serviceFilter.value = options.some(option => option.value === previous) ? previous : ALL_SERVICES;
  }

  // Záložka Podle služeb.

  // Image sdílený více službami nemá serviceName, aktuální image služby se proto hledá i podle jejích kontejnerů.
  function usedImagesOf(name, own) {
    const used = name
      ? allItems().filter(item => item.kind === "image" && item.level === IN_USE &&
        (item.serviceName === name || item.users.some(user => user.serviceName === name)))
      : own.filter(item => item.kind === "image" && item.level === IN_USE && !item.users.some(user => user.serviceName));
    return [...new Map(used.map(item => [item.imageId, item])).values()];
  }

  function serviceSummary(name, own) {
    const usedImages = usedImagesOf(name, own);
    const containers = own.filter(item => item.kind === "container");
    const volumes = own.filter(item => item.kind === "volume");
    const safe = own.filter(item => item.level === SAFE).sort(DiskPresentation.compareItems);
    const request = own.filter(item => item.level === ON_REQUEST).sort(DiskPresentation.compareItems);
    return {
      key: "service:" + (name ?? OUTSIDE_COMPOSE),
      name,
      usedImages,
      imageBytes: sumBy(usedImages, item => item.sizeBytes),
      containers,
      containerBytes: sumBy(containers, item => item.sizeBytes),
      volumes,
      volumeBytes: sumBy(volumes, item => item.sizeBytes),
      safe,
      safeBytes: reclaim(safe),
      request,
      requestBytes: reclaim(request)
    };
  }

  function serviceSummaries() {
    const rows = serviceNames().map(name => serviceSummary(name, allItems().filter(item => item.serviceName === name)));
    rows.push(serviceSummary(null, allItems().filter(item => !item.serviceName)));
    return rows;
  }

  function summaryLines(title, list) {
    if (list.length === 0)
      return [];
    const lines = [title];
    for (const item of list.slice(0, SERVICE_DETAIL_ITEMS)) {
      const parts = [DiskPresentation.KIND_TITLES[item.kind], item.title];
      if (item.version)
        parts.push("verze " + item.version);
      parts.push(DiskPresentation.whenText(item), DiskPresentation.reclaimText(item));
      lines.push("  • " + parts.join(" · "));
    }
    if (list.length > SERVICE_DETAIL_ITEMS)
      lines.push(`  … a dalších ${list.length - SERVICE_DETAIL_ITEMS} v záložkách`);
    return lines;
  }

  function describeService(row) {
    const lines = [
      row.name ? `Služba ${row.name}` : "Mimo služby compose: image, kontejnery a volumy, které nejde přiřadit žádné službě načteného compose (jiné projekty, osiřelé volumy, build cache).",
      `Aktuální image: ${row.usedImages.map(item => `${item.title} (${Ui.formatSize(item.sizeBytes)})`).join(", ") || "—"}`,
      `Kontejnery: ${row.containers.map(item => `${item.title} (${item.status}, ${Ui.formatSize(item.sizeBytes)})`).join(", ") || "—"}`,
      `Volumy: ${row.volumes.length}× · ${Ui.formatSize(row.volumeBytes)}`,
      ""
    ];
    lines.push(...summaryLines(`Bezpečně lze uvolnit nejméně ${Ui.formatSize(row.safeBytes)}:`, row.safe));
    lines.push(...summaryLines(`Na výslovnou žádost ${Ui.formatSize(row.requestBytes)}:`, row.request));
    if (row.safe.length === 0 && row.request.length === 0)
      lines.push("Nic nepoužívaného tu neleží.");
    lines.push("", "Dvojklikem zobrazíte položky v záložkách s filtrem na tuto službu.");
    return lines.join("\n");
  }

  function openServiceItems(row) {
    view.serviceFilter.value = row.name ?? OUTSIDE_COMPOSE;
    const kind = KINDS.find(item => [...row.safe, ...row.request].some(own => own.kind === item)) ?? "image";
    selectTab(kind);
  }

  function bindServices() {
    setColumns(["18%", "26%", "16%", "12%", "14%", "14%"]);
    view.itemsHead.replaceChildren(headerRow([
      sortHeader("Služba", "name"),
      sortHeader("Aktuální image", "imageBytes"),
      sortHeader("Kontejner", "containerBytes"),
      sortHeader("Volumy", "volumeBytes"),
      sortHeader("Bezpečně uvolnit", "safeBytes"),
      sortHeader("Na vyžádání", "requestBytes")
    ]));

    // Řádek "Mimo služby compose" zůstává vždy poslední.
    const rows = serviceSummaries();
    const outside = rows.pop();
    const ordered = [...sorted(rows, (row, key) => key === "name" ? row.name : row[key], () => 0), outside];

    view.itemsBody.replaceChildren(...ordered.map(row => {
      const tr = Ui.element("tr", {}, [
        cell(row.name ?? "Mimo služby compose"),
        cell(row.usedImages.length === 0 ? "—" : `${Ui.formatSize(row.imageBytes)} · ${row.usedImages.map(item => item.title).join(", ")}`),
        cell(row.containers.length === 0 ? "—" : `${Ui.formatSize(row.containerBytes)} · ${row.containers.length}×`),
        cell(row.volumes.length === 0 ? "—" : `${Ui.formatSize(row.volumeBytes)} · ${row.volumes.length}×`),
        cell(row.safe.length === 0 ? "—" : `${Ui.formatSize(row.safeBytes)} · ${row.safe.length}×`, "number"),
        cell(row.request.length === 0 ? "—" : `${Ui.formatSize(row.requestBytes)} · ${row.request.length}×`, "number")
      ]);
      if (row.safe.length > 0)
        tr.classList.add("safe");
      tr.dataset.key = row.key;
      tr.addEventListener("mousedown", () => focusRow(row.key, describeService(row)));
      tr.addEventListener("dblclick", () => openServiceItems(row));
      return tr;
    }));
  }

  // Záložky s položkami.

  function rowClass(item) {
    if (item.level === IN_USE)
      return "in-use";
    if (DiskPresentation.isDangerous(item))
      return "danger";
    return item.level === SAFE ? "safe" : "request";
  }

  function toggleItems(items, checked) {
    for (const item of items) {
      if (item.level === IN_USE)
        continue;
      if (checked)
        state.selected.add(item.key);
      else
        state.selected.delete(item.key);
    }
    bindGrid();
  }

  function bindItems() {
    const items = visibleItems();
    const selectable = items.filter(item => item.level !== IN_USE);
    const headerCheck = Ui.element("input", { type: "checkbox", title: "Vybrat všechny zobrazené položky, které jde smazat" });
    headerCheck.checked = selectable.length > 0 && selectable.every(item => state.selected.has(item.key));
    headerCheck.disabled = state.busy || selectable.length === 0;
    headerCheck.addEventListener("change", () => toggleItems(selectable, headerCheck.checked));

    setColumns(["34px", "130px", "30%", "16%", "16%", "14%", "9%", "9%"]);
    const [title, info, service, when] = DiskPresentation.columns(state.tab);
    view.itemsHead.replaceChildren(headerRow([
      Ui.element("th", {}, [headerCheck]),
      sortHeader("Kategorie", "level"),
      sortHeader(title, "title"),
      sortHeader(info, "info"),
      sortHeader(service, "service"),
      sortHeader(when, "when"),
      sortHeader("Velikost", "size"),
      sortHeader("Uvolní", "reclaim")
    ]));

    view.itemsBody.replaceChildren(...items.map(item => {
      const check = Ui.element("input", { type: "checkbox" });
      check.checked = state.selected.has(item.key);
      check.disabled = state.busy || item.level === IN_USE;
      check.addEventListener("change", () => toggleItems([item], check.checked));

      const tr = Ui.element("tr", { className: rowClass(item) }, [
        Ui.element("td", {}, [check]),
        cell(DiskPresentation.levelText(item)),
        cell(item.title, null, item.name ?? item.title),
        cell(DiskPresentation.infoText(item)),
        cell(DiskPresentation.serviceText(item)),
        cell(DiskPresentation.whenText(item)),
        cell(Ui.formatSize(item.sizeBytes), "number"),
        cell(DiskPresentation.reclaimText(item), "number")
      ]);
      tr.classList.toggle("checked", check.checked);
      tr.dataset.key = item.key;
      tr.addEventListener("mousedown", () => focusRow(item.key, DiskPresentation.describe(item, state.storage)));
      return tr;
    }));

    if (items.length === 0) {
      const empty = cell(view.serviceFilter.value === ALL_SERVICES
        ? "Nic tu není."
        : "U vybrané služby tu nic není. Zkuste jinou službu nebo Všechny.");
      empty.colSpan = ITEM_COLUMN_COUNT;
      view.itemsBody.append(Ui.element("tr", {}, [empty]));
    }
  }

  function bindGrid() {
    const scrollTop = view.gridContainer.scrollTop;
    view.itemFilters.hidden = state.tab === SERVICES_TAB;
    if (state.tab === SERVICES_TAB)
      bindServices();
    else
      bindItems();
    view.gridContainer.scrollTop = scrollTop;
    markFocused();
    bindSelection();
  }

  function bindAll() {
    bindSummary();
    bindTabs();
    bindServiceFilter();
    bindGrid();
    refreshDetail();
  }

  function markFocused() {
    for (const row of view.itemsBody.children)
      row.classList.toggle("focused", row.dataset.key === state.focusedKey);
  }

  function focusRow(key, text) {
    state.focusedKey = key;
    view.detailBox.textContent = text;
    markFocused();
  }

  function refreshDetail() {
    const item = allItems().find(own => own.key === state.focusedKey);
    if (item) {
      view.detailBox.textContent = DiskPresentation.describe(item, state.storage);
      return;
    }
    const service = state.focusedKey?.startsWith("service:") ? serviceSummaries().find(row => row.key === state.focusedKey) : null;
    if (service)
      view.detailBox.textContent = describeService(service);
  }

  function moveFocus(offset) {
    const rows = [...view.itemsBody.children].filter(row => row.dataset.key);
    const index = rows.findIndex(row => row.dataset.key === state.focusedKey);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + offset))];
    if (!next)
      return;
    next.dispatchEvent(new MouseEvent("mousedown"));
    next.scrollIntoView({ block: "nearest" });
  }

  function bindSelection() {
    const selected = selectedItems();
    if (!state.busy) {
      setStatus(selected.length === 0
        ? "Nic není vybráno. Zaškrtněte položky nebo použijte Vybrat vše bezpečné."
        : `Vybráno: ${selected.length} · uvolní nejméně ${Ui.formatSize(reclaim(selected))}`);
    }
    view.selectSafeButton.disabled = state.busy || !allItems().some(item => item.level === SAFE);
    view.clearSelectionButton.disabled = state.busy || selected.length === 0;
    view.removeButton.disabled = state.busy || selected.length === 0;
    view.compactButton.hidden = !canCompact();
    view.compactButton.disabled = state.busy;
    view.refreshButton.disabled = state.busy;
    view.closeButton.disabled = state.busy;
    view.serviceFilter.disabled = state.busy;
    view.showInUseCheckBox.disabled = state.busy;
  }

  function selectTab(key) {
    state.tab = key;
    bindTabs();
    bindGrid();
  }

  function selectSafe() {
    toggleItems(allItems().filter(item => item.level === SAFE && matchesService(item)), true);
  }

  function clearSelection() {
    state.selected.clear();
    bindGrid();
  }

  // Načtení a mazání.

  function setBusy(busy, text) {
    state.busy = busy;
    state.operation = busy ? text : null;
    document.body.classList.toggle("running", busy);
    if (text)
      setStatus(text);
    bindGrid();
  }

  async function loadModel() {
    const model = await Ui.invoke("disk:load");
    if (!model.success)
      return model.error && model.error.trim().length > 0 ? model.error : "Docker nevrátil využití místa.";
    state.model = model;
    const keys = new Set(model.items.filter(item => item.level !== IN_USE).map(item => item.key));
    state.selected = new Set([...state.selected].filter(key => keys.has(key)));
    return null;
  }

  async function loadStorage() {
    try {
      state.storage = await Ui.invoke("disk:storage");
    } catch (error) {
      if (error.canceled)
        throw error;
      state.storage = null;
    }
    view.storageInfo.textContent = DiskPresentation.storageText(state.storage);
  }

  async function reload() {
    setBusy(true, "Načítám využití místa (docker system df)…");
    let error = null;
    try {
      error = await loadModel();
      await loadStorage();
    } catch (failure) {
      if (failure.canceled)
        return false;
      error = failure.message;
    } finally {
      setBusy(false);
    }
    bindAll();
    if (error) {
      setStatus(Ui.errorLine(error), error);
      await Ui.showError(error);
      return false;
    }
    return true;
  }

  function totalBytes() {
    return sumBy(state.model?.summary ?? [], row => row.sizeBytes);
  }

  async function confirmRemove(items) {
    if (!await Ui.confirm("Smazat vybrané", DiskPresentation.confirmText(items, allItems())))
      return false;
    const dangerous = items.filter(DiskPresentation.isDangerous);
    if (dangerous.length === 0)
      return true;
    return Ui.confirm("Smazat data volumů",
      `Opravdu smazat ${dangerous.length} pojmenovaných volumů i s daty?\n\n${dangerous.map(item => item.name).join("\n")}\n\nData se nedají obnovit.`);
  }

  async function removeSelected() {
    const items = selectedItems();
    if (items.length === 0 || !await confirmRemove(items))
      return;

    const before = totalBytes();
    let result;
    setBusy(true, `Mažu ${items.length} položek…`);
    try {
      result = await Ui.invoke("disk:remove", items.map(item => item.key));
    } catch (error) {
      setBusy(false);
      if (!error.canceled)
        await Ui.showError(error.message, error);
      return;
    }
    setBusy(false);

    state.selected.clear();
    if (!await reload())
      return;
    const freed = Math.max(0, before - totalBytes());
    setStatus(`Hotovo. Docker teď zabírá o ${Ui.formatSize(freed)} méně.`);

    if (!result.success) {
      await Ui.showError("Některé položky se nepodařilo smazat (např. je mezitím začal používat kontejner). Ostatní se smazaly.\n\n" + result.errorText);
      return;
    }
    const wslNote = canCompact()
      ? "\n\nMísto je uvolněné uvnitř virtuálního disku WSL. Soubor .vhdx na disku Windows se tím sám nezmenšil. Windows místo dostanou zpět tlačítkem Zmenšit virtuální disk."
      : "";
    await Ui.showInfo("Místo uvolněno", `Smazáno. Docker teď zabírá o ${Ui.formatSize(freed)} méně.${wslNote}`);
  }

  function canCompact() {
    return Boolean(state.storage?.local && state.storage.wsl?.vhdxPath);
  }

  // Po spuštění WSL chvíli trvá, než Docker odpovídá. Bez čekání by obnovení skončilo chybou.
  async function waitForDocker() {
    for (let attempt = 0; attempt < 15; attempt++) {
      const status = await Ui.invoke("docker:engineStatus");
      if (status.isRunning)
        return;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async function compactDisk() {
    if (!canCompact() || !await Ui.confirm("Zmenšit virtuální disk", DiskPresentation.compactConfirmText(state.storage)))
      return;

    let result;
    setBusy(true, "Zmenšuji virtuální disk…");
    try {
      result = await Ui.invoke("disk:compactVhd");
      if (result.restarted) {
        setStatus("Čekám, až Docker po spuštění WSL odpoví…");
        await waitForDocker();
      }
    } catch (error) {
      setBusy(false);
      if (!error.canceled)
        await Ui.showError(error.message, error);
      return;
    }
    setBusy(false);

    await reload();
    if (!result.success) {
      await Ui.showError(result.errorText);
      return;
    }
    const freed = result.beforeBytes !== null && result.afterBytes !== null ? Math.max(0, result.beforeBytes - result.afterBytes) : null;
    const text = `Virtuální disk zmenšen z ${Ui.formatSize(result.beforeBytes)} na ${Ui.formatSize(result.afterBytes)}` +
      (freed === null ? "." : `, na disku Windows se uvolnilo ${Ui.formatSize(freed)}.`);
    setStatus(text);
    await Ui.showInfo("Virtuální disk zmenšen",
      text + "\n\nWSL a Docker znovu běží. Kontejnery, které se samy nespustily, spusťte v hlavním okně (Spustit skupinu).");
  }

  function wireEvents() {
    view.compactButton.addEventListener("click", compactDisk);
    view.selectSafeButton.addEventListener("click", selectSafe);
    view.clearSelectionButton.addEventListener("click", clearSelection);
    view.removeButton.addEventListener("click", removeSelected);
    view.refreshButton.addEventListener("click", reload);
    view.closeButton.addEventListener("click", () => window.close());
    view.serviceFilter.addEventListener("change", bindGrid);
    view.showInUseCheckBox.addEventListener("change", bindGrid);
    view.gridContainer.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key !== " " || state.busy)
        return;
      event.preventDefault();
      const item = allItems().find(own => own.key === state.focusedKey);
      if (item && item.kind === state.tab)
        toggleItems([item], !state.selected.has(item.key));
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !state.busy && !document.querySelector(".modal-backdrop"))
        window.close();
    });
    Ui.on("disk:lines", lines => {
      if (state.busy && lines.length > 0)
        setStatus(Ui.lastLine(lines.at(-1)), lines.join("\n"));
    });
    Ui.setErrorContext(() => ({
      composeFile: state.context?.composeFile ?? null,
      zalozka: state.tab,
      operace: state.operation ?? "(žádná)",
      vybrano: [...state.selected].slice(0, 50)
    }));
  }

  async function initialize() {
    state.context = await Ui.invoke("child:context");
    wireEvents();
    await reload();
  }

  initialize().catch(error => Ui.showError(error.message, error));
})();
