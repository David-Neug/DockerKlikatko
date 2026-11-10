"use strict";

const DiskPresentation = (() => {
  const SAFE = "safe";
  const ON_REQUEST = "request";
  const IN_USE = "inUse";
  const LEVEL_ORDER = { [SAFE]: 0, [ON_REQUEST]: 1, [IN_USE]: 2 };
  const KIND_TITLES = { image: "Image", container: "Kontejnery", volume: "Volumy", buildCache: "Build cache" };
  const REASON_TITLES = {
    imageOldVersion: "staré verze image",
    imageCompose: "image z compose bez kontejneru",
    imageOtherTag: "jiné tagy image služeb",
    imageUnused: "nepoužívané image mimo compose",
    containerStopped: "zastavené kontejnery",
    volumeOrphanAnonymous: "osiřelé anonymní volumy",
    volumeComposeNamed: "pojmenované volumy projektu",
    volumeNamed: "pojmenované volumy",
    buildCache: "nepoužívaná build cache"
  };
  const REASON_CONSEQUENCES = {
    imageOldVersion: "nic se neztratí",
    imageCompose: "při dalším spuštění se image znovu stáhne nebo sestaví",
    imageOtherTag: "k těmto verzím se půjde vrátit jen novým stažením",
    imageUnused: "při další potřebě se znovu stáhnou",
    containerStopped: "služby půjde spustit, vytvoří se nový kontejner",
    volumeOrphanAnonymous: "smažou se stará data, která už žádný kontejner nepoužije",
    volumeComposeNamed: "SMAŽOU SE DATA, která compose při dalším spuštění znovu připojí",
    volumeNamed: "SMAŽOU SE JEJICH DATA",
    buildCache: "další build bude pomalejší"
  };

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim().length === 0;
  }

  function isDangerous(item) {
    return item.reason === "volumeComposeNamed" || item.reason === "volumeNamed";
  }

  // Image s více tagy se uvolní až se smazáním všech tagů, sdílené vrstvy se počítají jen jednou.
  function reclaimOf(items, allItems) {
    const tagRows = new Map();
    for (const item of allItems ?? items) {
      if (item.kind === "image")
        tagRows.set(item.imageId, (tagRows.get(item.imageId) ?? 0) + 1);
    }

    const imageRows = new Map();
    let total = 0;
    for (const item of items) {
      if (item.kind !== "image") {
        total += item.reclaimBytes ?? 0;
        continue;
      }
      imageRows.set(item.imageId, (imageRows.get(item.imageId) ?? 0) + 1);
    }
    for (const [imageId, count] of imageRows) {
      const sample = items.find(item => item.kind === "image" && item.imageId === imageId);
      if (count >= (tagRows.get(imageId) ?? 1))
        total += sample.uniqueBytes;
    }
    return total;
  }

  function compareItems(left, right) {
    return LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level]
      || reclaimOf([right]) - reclaimOf([left])
      || right.sizeBytes - left.sizeBytes
      || left.title.localeCompare(right.title);
  }

  // Hodnota pro řazení podle sloupce. Kategorie řadí nebezpečné "na vyžádání" až za ostatní.
  function sortValue(item, key) {
    switch (key) {
      case "level": return LEVEL_ORDER[item.level] * 2 + (isDangerous(item) ? 1 : 0);
      case "title": return item.title;
      case "info": return item.kind === "image" ? item.version : infoText(item);
      case "service": return item.serviceName ?? item.foreignService ?? null;
      case "when": return item.kind === "container" ? item.status : item.createdAt;
      case "size": return item.sizeBytes;
      default: return item.level === IN_USE ? -1 : reclaimOf([item]);
    }
  }

  function compareValues(left, right) {
    if (typeof left === "number" && typeof right === "number")
      return left - right;
    return String(left ?? "").localeCompare(String(right ?? ""), "cs", { numeric: true });
  }

  function levelText(item) {
    if (item.level === SAFE)
      return "Bezpečné";
    if (item.level === IN_USE)
      return "Používá se";
    return isDangerous(item) ? "Na vyžádání · data" : "Na vyžádání";
  }

  function dateText(milliseconds) {
    return milliseconds === null || milliseconds === undefined ? "—" : Ui.formatShortDateTime(milliseconds);
  }

  function usersText(users) {
    return users.map(user => `${user.name} (${user.running ? "běží" : "zastavený"})`).join(", ");
  }

  function serviceText(item) {
    if (!isBlank(item.serviceName))
      return item.serviceName;
    if (!isBlank(item.foreignService))
      return "jiný projekt: " + item.foreignService;
    if (item.sharedBy?.length > 1)
      return "sdílí: " + item.sharedBy.join(", ");
    if (item.kind === "volume" && item.users.length > 0)
      return item.users.map(user => user.name).join(", ");
    return "—";
  }

  function infoText(item) {
    switch (item.kind) {
      case "image": return item.version ?? "—";
      case "container": return item.image;
      case "volume": return item.anonymous ? "anonymní" : `pojmenovaný${item.composeVolume ? " · " + item.composeVolume : ""}`;
      default: return `${item.count} záznamů`;
    }
  }

  function whenText(item) {
    return item.kind === "container" ? item.status : dateText(item.createdAt);
  }

  function reclaimText(item) {
    if (item.level === IN_USE)
      return "—";
    if (item.kind === "image" && item.tagCount > 1)
      return Ui.formatSize(item.uniqueBytes) + " *";
    return Ui.formatSize(reclaimOf([item]));
  }

  function columns(kind) {
    switch (kind) {
      case "image": return ["Image", "Verze", "Služba", "Vytvořeno"];
      case "container": return ["Kontejner", "Image", "Služba", "Stav"];
      case "volume": return ["Volume", "Typ", "Služba / kontejner", "Vytvořeno"];
      default: return ["Položka", "Rozsah", "Služba", "Naposledy použito"];
    }
  }

  function storageLocation(storage) {
    if (!storage?.rootDir)
      return "v úložišti Dockeru";
    const where = storage.wsl?.distro ? ` uvnitř WSL distribuce ${storage.wsl.distro}` : "";
    return `${storage.rootDir}/${storage.driver ?? "overlay2"}${where}`;
  }

  function imageLines(item, storage) {
    const lines = [
      `Image: ${item.title}`,
      `ID: ${item.shortId} · vytvořen ${dateText(item.createdAt)}${isBlank(item.version) ? "" : " · verze " + item.version}`,
      `Velikost: ${Ui.formatSize(item.sizeBytes)} celkem, z toho ${Ui.formatSize(item.uniqueBytes)} má jen tento image a ${Ui.formatSize(item.sharedBytes)} sdílí s jinými image.`,
      `Kde: vrstvy v ${storageLocation(storage)}.`,
      ""
    ];

    switch (item.reason) {
      case "imageUsed": {
        lines.push(`Používají ho kontejnery: ${usersText(item.users) || "(Docker hlásí kontejner)"}.`);
        lines.push(item.users.length > 0 && item.users.every(user => !user.running)
          ? "Smazat ho jde až po odstranění zastaveného kontejneru (záložka Kontejnery nebo Odstranit v hlavním okně)."
          : "Dokud kontejner existuje, smazat ho nejde.");
        break;
      }
      case "imageOldVersion":
        if (!isBlank(item.serviceName)) {
          lines.push(`Stará verze image služby ${item.serviceName}. Po novém stažení nebo sestavení ${item.composeReference ? `ukazuje tag ${item.composeReference}` : "ukazuje tag"} na novější image a tahle verze zůstala bez názvu (<none>).`);
        } else if (!isBlank(item.foreignService)) {
          lines.push(`Stará verze image služby ${item.foreignService} z jiného compose projektu.`);
        } else {
          lines.push(`Image bez názvu (<none>)${isBlank(item.repository) ? "" : " z repozitáře " + item.repository}. Obvykle jde o starou verzi po novém stažení nebo sestavení.`);
        }
        lines.push("Žádný kontejner ho nepoužívá. Smazání neovlivní nic, co běží, ani nic z compose.");
        lines.push("Uvolní se nejméně uvedená velikost. Když se smažou i další staré verze se společnými vrstvami, uvolní se i ty.");
        break;
      case "imageCompose":
        lines.push(`Tento image má v compose služba ${item.composeServices.join(", ")}. Kontejner z něj teď neexistuje.`);
        lines.push("Po smazání se při dalším Spustit image znovu stáhne z registru (nebo sestaví), což chvíli potrvá.");
        break;
      case "imageOtherTag":
        lines.push(`Jiná verze (tag) image, který v compose používá ${item.sharedBy.join(", ")}.${item.composeReference ? ` V compose je ${item.composeReference}.` : ""}`);
        lines.push("Žádný kontejner ho nepoužívá. Kdybyste se k této verzi chtěli vrátit, stáhne se znovu (Stáhnout image).");
        break;
      default:
        lines.push("Image nepatří k žádné službě načteného compose a nepoužívá ho žádný kontejner (jiný projekt, ručně stažený nebo pozůstatek).");
        lines.push("Smazání neovlivní nic, co běží. Když ho budete potřebovat, stáhne se znovu.");
    }
    if (item.tagCount > 1)
      lines.push("", `* Stejný image (ID ${item.shortId}) má ${item.tagCount} tagy. Místo se uvolní, až se smažou všechny; samotný tag se jen odebere.`);
    return lines;
  }

  function containerLines(item) {
    const lines = [
      `Kontejner: ${item.title}`,
      `Image: ${item.image} · stav: ${item.status} · vytvořen ${dateText(item.createdAt)}`,
      `Zapisovatelná vrstva: ${Ui.formatSize(item.sizeBytes)} – soubory, které kontejner změnil nebo vytvořil uvnitř sebe (logy, dočasné soubory). Image ani volumy do toho nepatří.`,
      ""
    ];
    if (item.level === IN_USE) {
      lines.push("Kontejner běží. Tady ho smazat nejde; zastavit ho můžete v hlavním okně.");
      return lines;
    }

    lines.push(!isBlank(item.serviceName)
      ? `Zastavený kontejner služby ${item.serviceName}. Smazání je totéž jako Odstranit v hlavním okně: službu jde dál spustit, compose vytvoří nový kontejner.`
      : `Zastavený kontejner mimo načtený compose${isBlank(item.foreignService) ? "" : ` (${item.foreignService})`}.`);
    if (item.anonymousVolumes > 0) {
      const destinations = item.volumes.map(volume => volume.destination).filter(Boolean).join(", ");
      lines.push(`Pozor: kontejner má anonymní volume (${item.anonymousVolumes}×${destinations ? ", " + destinations : ""}). Po smazání kontejneru zůstane osiřelý a nový kontejner dostane prázdný – data v něm (např. databázi) už služba neuvidí.`);
    }
    return lines;
  }

  function volumeLines(item, storage) {
    const lines = [
      `Volume: ${item.name}`,
      `Typ: ${item.anonymous ? "anonymní (vytvořil ho kontejner podle VOLUME v image)" : "pojmenovaný"}${item.composeVolume ? ` · compose volume ${item.composeVolume} projektu ${item.composeProject}` : ""}`,
      `Velikost: ${Ui.formatSize(item.sizeBytes)} · vytvořen ${dateText(item.createdAt)}`,
      `Kde: ${item.mountpoint ?? "—"}${storage?.wsl?.distro ? ` (uvnitř WSL distribuce ${storage.wsl.distro})` : ""}`,
      ""
    ];
    switch (item.reason) {
      case "volumeUsed":
        lines.push(`Používá ho: ${usersText(item.users) || "kontejner"}${item.destinations.length > 0 ? `, připojený do ${[...new Set(item.destinations)].join(", ")}` : ""}. Smazat ho nejde.`);
        break;
      case "volumeOrphanAnonymous":
        lines.push("Kontejner, který ho vytvořil, už neexistuje (byl odstraněn nebo nahrazen). Compose ho znovu nepoužije, nový kontejner dostane vlastní nový volume.");
        lines.push("Smazání neovlivní nic, co běží. Mohou v něm ale být stará data (např. stará databáze), po smazání se nedají obnovit.");
        break;
      case "volumeComposeNamed":
        lines.push("Teď ho nepoužívá žádný kontejner, ale při dalším spuštění služby ho compose znovu připojí i s daty.");
        lines.push("Smazáním přijdete o jeho data (např. databázi), služba začne s prázdným volume.");
        break;
      default:
        lines.push("Pojmenovaný volume, který nepoužívá žádný kontejner. Smazáním přijdete o jeho data.");
    }
    return lines;
  }

  function buildCacheLines(item) {
    const lines = item.level === IN_USE
      ? [`Build cache, kterou právě používá běžící build (${item.count} záznamů). Smazat ji nejde.`]
      : [
        `Mezivýsledky docker build / compose build (${item.count} záznamů): vrstvy jednotlivých kroků Dockerfile a stažené podkladové image.`,
        "Nepoužívá je žádný běžící build a na kontejnery ani image nemají vliv. Po smazání bude další sestavení pomalejší, protože se kroky provedou znovu.",
        "Nepočítají se vrstvy sdílené s image, ty se smazáním cache neuvolní."
      ];
    lines.push("", "Největší záznamy:");
    for (const entry of item.entries) {
      const used = entry.lastUsedAt ?? entry.createdAt;
      const description = entry.description.length > 160 ? entry.description.slice(0, 160) + "…" : entry.description;
      lines.push(`  ${Ui.formatSize(entry.sizeBytes).padStart(9)}  ${dateText(used).padEnd(16)}  ${description}`);
    }
    return lines;
  }

  function describe(item, storage) {
    switch (item.kind) {
      case "image": return imageLines(item, storage).join("\n");
      case "container": return containerLines(item).join("\n");
      case "volume": return volumeLines(item, storage).join("\n");
      default: return buildCacheLines(item).join("\n");
    }
  }

  // Sparse režim (soubor .vhdx se zmenšuje sám) umí až WSL 2.0.
  function sparseText(wsl) {
    if (!wsl.version)
      return "Verzi WSL nejde zjistit (starší WSL z Windows). Automatické zmenšování (sparse režim) umí až WSL 2.0, nejdřív je potřeba wsl --update.";
    if (wsl.version.major < 2)
      return `Máte WSL ${wsl.version.text}. Automatické zmenšování (sparse režim) umí až WSL 2.0, nejdřív je potřeba wsl --update.`;
    return `Máte WSL ${wsl.version.text}, které umí i automatické zmenšování: wsl --shutdown a pak wsl --manage ${wsl.distro} --set-sparse true ` +
      "(u některých verzí WSL je sparse režim označený jako experimentální).";
  }

  function compactConfirmText(storage) {
    return [
      "Zmenšit virtuální disk WSL?",
      "",
      `Soubor: ${storage.wsl.vhdxPath}`,
      `Teď zabírá: ${Ui.formatSize(storage.wsl.vhdxBytes)}`,
      "",
      `1. fstrim v distribuci ${storage.wsl.distro} označí volné místo.`,
      "2. wsl --shutdown zastaví WSL – zastaví se Docker a VŠECHNY kontejnery.",
      "3. diskpart soubor zkomprimuje. Windows si vyžádá oprávnění správce. U velkého disku to trvá několik minut.",
      "4. WSL se znovu spustí. Kontejnery, které nemají restart policy, pak spusťte znovu (Spustit skupinu).",
      "",
      "Data uvnitř zůstanou. Nejdřív smažte nepotřebné položky, jinak se uvolní málo."
    ].join("\n");
  }

  function storageText(storage) {
    if (!storage)
      return "Nepodařilo se zjistit, kde leží data Dockeru.";
    const driver = storage.driver ? ` (úložiště ${storage.driver})` : "";
    if (!storage.local) {
      return [
        `Docker běží mimo tento počítač: ${storage.daemonName}${storage.operatingSystem ? " (" + storage.operatingSystem + ")" : ""}, data ve složce ${storage.rootDir ?? "/var/lib/docker"}${driver}.`,
        "Typicky jde o Docker Desktop ve virtuálním stroji nebo vzdálený daemon. Kolik místa zbývá na jeho disku, odsud zjistit nejde.",
        "Mazáním se uvolní místo na disku tohoto virtuálního stroje; jeho soubor disku se nemusí sám zmenšit."
      ].join("\n");
    }
    if (storage.wsl) {
      const lines = [`Data Dockeru leží ve WSL distribuci ${storage.wsl.distro} ve složce ${storage.rootDir ?? "/var/lib/docker"}${driver}.`];
      if (storage.wsl.vhdxPath) {
        const host = storage.wsl.host;
        lines.push(`Virtuální disk distribuce: ${storage.wsl.vhdxPath}` +
          (storage.wsl.vhdxBytes === null ? "." : ` – soubor teď zabírá ${Ui.formatSize(storage.wsl.vhdxBytes)}`) +
          (host ? `, na disku ${host.path} zbývá ${Ui.formatSize(host.freeBytes)} z ${Ui.formatSize(host.totalBytes)}.` : "."));
      }
      lines.push("Mazáním se uvolní místo uvnitř virtuálního disku a Docker ho použije pro další image. Soubor .vhdx se ale sám nezmenší, " +
        "Windows místo dostanou zpět až tlačítkem Zmenšit virtuální disk (zastaví na pár minut WSL a všechny kontejnery).");
      lines.push(sparseText(storage.wsl));
      return lines.join("\n");
    }
    const lines = [`Data Dockeru leží ve složce ${storage.rootDir ?? "/var/lib/docker"}${driver}${storage.operatingSystem ? " (" + storage.operatingSystem + ")" : ""}.`];
    if (storage.host)
      lines.push(`Na disku (${storage.host.path}) zbývá ${Ui.formatSize(storage.host.freeBytes)} z ${Ui.formatSize(storage.host.totalBytes)}.`);
    return lines.join("\n");
  }

  function confirmText(items, allItems) {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.reason))
        groups.set(item.reason, []);
      groups.get(item.reason).push(item);
    }
    const line = ([reason, list]) => `  • ${REASON_TITLES[reason] ?? reason}: ${list.length}× · ${Ui.formatSize(reclaimOf(list, allItems))} – ${REASON_CONSEQUENCES[reason] ?? ""}`;
    const safe = [...groups].filter(([, list]) => list[0].level === SAFE);
    const request = [...groups].filter(([, list]) => list[0].level === ON_REQUEST);
    const lines = [`Smazat vybrané položky (${items.length})? Uvolní se nejméně ${Ui.formatSize(reclaimOf(items, allItems))}.`, ""];
    if (safe.length > 0)
      lines.push("Bezpečné:", ...safe.map(line), "");
    if (request.length > 0)
      lines.push("Na výslovnou žádost:", ...request.map(line), "");
    lines.push("Nic z toho nepoužívá běžící kontejner. Maže se bez --force, takže Docker odmítne smazat cokoli, co se mezitím začalo používat.");
    return lines.join("\n");
  }

  return {
    SAFE,
    ON_REQUEST,
    IN_USE,
    KIND_TITLES,
    isDangerous,
    reclaimOf,
    compareItems,
    sortValue,
    compareValues,
    levelText,
    serviceText,
    infoText,
    whenText,
    reclaimText,
    columns,
    describe,
    storageText,
    compactConfirmText,
    confirmText
  };
})();
