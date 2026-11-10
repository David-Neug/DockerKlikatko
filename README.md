# DockerKlikatko – správa Dockeru ve WSL i v Linuxu

Desktopová aplikace (Electron) pro klikací správu služeb z jednoho souboru `docker-compose.yml`. Běží na **Windows** (Docker ve WSL) i na **Linuxu** (Docker nativně).

## Co umí

- **Stav prostředí** – na Windows ukazuje stav WSL a umí ho spustit (`wsl -d <výchozí distribuce> -e true`) nebo zastavit (`wsl --shutdown`). Na Linuxu jsou tlačítka WSL skrytá a místo nich je vidět, jestli odpovídá Docker daemon.
- **Seznam compose souborů** – pole „Soubor docker-compose“ je rozbalovací seznam, mezi uloženými soubory jde přepínat. Položka se ukazuje jako `poznámka — cesta` (bez poznámky jen cesta).
  - **Procházet** vybraný soubor přidá do seznamu (když v něm ještě není) a zvolí ho.
  - **Spravovat** otevře dialog se seznamem: cestu i poznámku jde přepsat přímo v řádku, **Přidat…** vybere další soubor, **Smazat** odebere vybraný, **Nahoru** / **Dolů** mění pořadí. Neexistující soubor má cestu červeně. Uložit nejde prázdný seznam ani stejný soubor dvakrát.
  - Změna výběru služby **nenačte**. Dokud se nestiskne **Načíst služby**, tlačítko svítí oranžově a všechny akce (spuštění, zastavení, obnova, místo na disku, běžící projekty) pracují dál s dříve načteným compose, ke kterému patří služby v tabulce.
- **Načtení compose** – zobrazí všechny služby v tabulce. Služby můžou být přímo v `services` nebo v souborech z `include:` (i vnořených). Relativní cesty v includovaném souboru platí vůči jeho složce a proměnné `${...}` se dosadí z `.env` vedle hlavního compose:

  | Sloupec | Obsah |
  |---|---|
  | Služba | název služby v compose |
  | Image / verze z compose | `image`, případně `sestaveno z <context>` a verze z labelů `app.version` / `mssql.version`, env `APP_VERSION` nebo build arg `MSSQL_BASE_IMAGE_TAG` |
  | Spuštěný image / verze | image běžícího kontejneru a krátké ID. Když se liší od compose, buňka zčervená |
  | Binárky | jen u DTF služeb (volume na `/dtf-test`): `Nexus`, `Local · větev · commit …`, `Startuje…`, `Nenastaveno` |
  | Limit RAM | `mem_limit` |
  | CPU, RAM využití | z `docker stats` |
  | Porty | adresy `localhost:<port>` přes gateway (z nginx konfigurace ve složce `/stream` nebo z `haproxy.cfg` připojeného do gateway), jinak `ports` z compose |
  | Stav, Health | stav kontejneru česky (Běží · 2 h, Padá · kód 137, Zastaveno …) a healthcheck |
  | Lze uvolnit | jestli u služby leží nepoužívané místo: `Ano · 58,4 GB` (staré verze image, jde bezpečně smazat), `Na vyžádání` nebo `Ne`. Tooltip vypíše konkrétní verze s datem a velikostí |

  Barva řádku: zelená = běží, oranžová = padá, šedá = zastaveno, bílá = kontejner není vytvořen.
- **Akce nad službou** – Spustit (i služby s `replicas: 0`, spustí jednu instanci), Zastavit, Odstranit kontejner (volumes a data zůstanou), Zobrazit logy (posledních 300 řádků, volitelně živé sledování).
- **Stáhnout image** – u služby s `image` nabídne tagy z registru (Docker Hub nebo privátní registr, přihlašovací údaje bere z `~/.docker/config.json` a credential helperu). Vybraný tag stáhne a **přepíše řádek `image:` v compose** (u služby z `include:` v souboru, kde je definovaná) (zachová uvozovky, komentáře, BOM i konce řádků). Služba s `build` se sestaví.
- **Skupiny** – pojmenované sady služeb (Přidat / Upravit / Smazat). Skupinu jde najednou spustit, zastavit nebo pro ni stáhnout image. „Všechny služby“ pracuje s celým compose.
- **Živý seznam** – samostatné okno, které každou sekundu vypisuje běžící kontejnery (image, verze, stav, čas startu).
- **Auto obnova** – stav služeb se obnovuje každých 5–300 s.
- **Místo na disku** – okno s přehledem, kolik místa zabírají image, kontejnery, volumy a build cache, co z toho jde smazat a kde data Dockeru leží. Vybrané položky smaže bez vlivu na běžící kontejnery. Podrobnosti viz [Místo na disku](#místo-na-disku).
- **Nahrát lokální binárky** – u DTF služby s mapováním v nastavení sestaví zdrojový projekt (MSBuild Rebuild) a nahraje výstup do složky `Bin` běžícího kontejneru. Podrobnosti viz [Lokální binárky](#lokální-binárky).

## Požadavky

- **Docker** s Compose v2 (`docker compose`) v `PATH`. Okno Místo na disku potřebuje Docker 23 nebo novější (`docker system df --format json`).
  - Windows: Docker Desktop nebo Docker ve WSL, plus `wsl.exe`.
  - Linux: nativní Docker, uživatel musí smět volat `docker` (skupina `docker`).
- Pro lokální binárky: `git` v `PATH` a MSBuild (výchozí cesta je Visual Studio 18 Professional).
- Pro vývoj a build: **Node.js 20+** a npm.

## Instalace a spuštění

Hotová aplikace vzniká buildem (viz [Build](#build)) ve složce `dist/` v projektu. Nic se neinstaluje, stačí ji zkopírovat a spustit.

### Windows

1. Spusť `build.bat` (dvojklikem). Po dokončení jsou ve složce `dist\` tři varianty:

   | Soubor / složka | Co to je |
   |---|---|
   | `win-unpacked\` | rozbalená aplikace, spouští se `DockerKlikatko.exe` |
   | `DockerKlikatko-<verze>-win.zip` | stejná aplikace zabalená do zipu |
   | `DockerKlikatko <verze>.exe` | portable verze v jednom souboru |

2. Vyber si jednu variantu:
   - **Doporučeno:** zkopíruj celou složku `win-unpacked` (nebo rozbal zip) do vlastní složky, třeba `C:\Nástroje\DockerKlikatko`, a spusť `DockerKlikatko.exe`. Na exe si můžeš udělat zástupce na plochu nebo připnout aplikaci na hlavní panel.
   - **Portable:** zkopíruj `DockerKlikatko <verze>.exe` kamkoli a spusť ho. Startuje o něco pomaleji, protože se při každém spuštění rozbaluje do dočasné složky.
3. Nastavení (`settings.json`) leží vždy **vedle spouštěného exe**. Při prvním spuštění se vytvoří z výchozího nastavení.

> **Nespouštěj aplikaci přímo z `dist\`.** Každý další build obsah `dist\` přepíše, včetně `settings.json`, a tím zmizí tvoje skupiny i cesta ke compose.

Při aktualizaci na novou verzi přepiš v cílové složce všechno kromě `settings.json`. Tak si nastavení ponecháš.

### Linux

1. V kořeni projektu spusť `./build.sh`. Po dokončení jsou ve složce `dist/`:

   | Soubor / složka | Co to je |
   |---|---|
   | `docker-klikatko-<verze>.tar.gz` | aplikace zabalená do archivu |
   | `linux-unpacked/` | rozbalená aplikace |
   | soubor `.AppImage` | aplikace v jednom souboru (vzniká jen při buildu na Linuxu) |

2. Vyber si jednu variantu:
   - **tar.gz:** rozbal ho do vlastní složky, třeba `~/Aplikace/DockerKlikatko`, a spusť soubor `docker-klikatko`:
     ```bash
     mkdir -p ~/Aplikace/DockerKlikatko
     tar -xzf dist/docker-klikatko-*.tar.gz -C ~/Aplikace/DockerKlikatko --strip-components=1
     ~/Aplikace/DockerKlikatko/docker-klikatko
     ```
   - **AppImage:** zkopíruj ho kamkoli, nastav mu spouštění (`chmod +x DockerKlikatko*.AppImage`) a spusť ho.
3. Nastavení leží vedle spouštěného souboru (u AppImage vedle souboru `.AppImage`). Když tam zapisovat nejde, použije se `~/.config/DockerKlikatko/settings.json`.

Když aplikace hned po spuštění spadne s hláškou o `chrome-sandbox`, spusť ji s přepínačem `--no-sandbox`:

```bash
~/Aplikace/DockerKlikatko/docker-klikatko --no-sandbox
```

### Co ve `dist/` nepotřebuješ

`builder-debug.yml` je jen ladicí výstup buildu a jde smazat.

## Spuštění z projektu

```bash
npm install
npm start
```

Při spuštění z projektu se nastavení ukládá do `settings.json` v kořeni projektu (je v `.gitignore`).

## Build

| Platforma | Příkaz | Výstup ve složce `dist/` |
|---|---|---|
| Windows | `build.bat` (nebo `npm run dist:win`) | `DockerKlikatko-<verze>-win.zip` (složka s exe) a `DockerKlikatko <verze>.exe` (portable) |
| Linux | `./build.sh` (nebo `npm run dist:linux`) | soubor `.AppImage` a `docker-klikatko-<verze>.tar.gz` |

Linuxovou verzi **sestavuj na Linuxu** přes `./build.sh`. `tar.gz` sice jde sestavit i na Windows (`npx electron-builder --linux tar.gz`), ale Windows neumí uložit unixový příznak „spustitelný“. Soubory v takovém archivu pak nejdou spustit, dokud jim ho nenastavíš ručně (viz [Řešení problémů](#řešení-problémů)). AppImage se staví jen na Linuxu.

Ikona aplikace je ve složce `assets/`: `icon.ico` pro Windows, `icon.png` (512×512) pro Linux a `icon.svg` pro logo v hlavičce okna.

Čas sestavení zapíše při každém buildu skript `scripts/afterPack.js` do souboru `resources/build-info.json` vedle aplikace. Hlavní okno ho ukazuje vpravo dole („Sestaveno 10.11.2026 10:30“), takže je vidět, jak stará verze běží. Při spuštění z projektu (`npm start`) tam je „Spuštěno z projektu (bez buildu)“.

## Nastavení

Nastavení je v souboru `settings.json`:

1. **Vedle spustitelného souboru** – u rozbaleného zipu vedle `DockerKlikatko.exe`, u portable exe vedle něj, u AppImage vedle souboru `.AppImage`, u `tar.gz` v rozbalené složce.
2. Když tam zapisovat nejde, použije se uživatelská složka: `%APPDATA%\DockerKlikatko\settings.json` na Windows a `~/.config/DockerKlikatko/settings.json` na Linuxu.

Když soubor neexistuje, vytvoří se z výchozího `src/Settings/settings.json`. Build tento soubor kopíruje vedle exe, takže **další build přepíše nastavení v `dist/`**. Trvalé změny dělej i v `src/Settings/settings.json`.

Aplikace soubor přepisuje při každé změně (vybraný compose, seznam compose souborů, auto obnova, skupiny). Ruční úpravy proto dělej se zavřenou aplikací.

```json
{
  "composePath": "C:\\Projekty\\docker\\docker-compose.yml",
  "composeFiles": [
    { "path": "C:\\Projekty\\docker\\docker-compose.yml", "note": "" },
    { "path": "C:\\Disky\\R2\\docker\\egw-tests\\docker-compose.yml", "note": "EGW testy" }
  ],
  "autoRefresh": false,
  "refreshSeconds": 10,
  "groups": [
    { "name": "Databáze", "services": ["gateway", "mssql-ids", "mssql-emsdb"] }
  ],
  "localBinaries": [
    {
      "serviceName": "dtf-test-ukazka",
      "projectPath": "C:\\Projekty\\Ukazka\\src\\DTF.Ukazka\\DTF.Ukazka.csproj",
      "configuration": "Debug",
      "mainAssembly": "DTF.Ukazka.dll",
      "defaultScope": "assembly",
      "outputFolderExcludes": ["*.config"],
      "binPath": null,
      "msBuildPath": "C:\\Program Files\\Microsoft Visual Studio\\18\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe"
    }
  ]
}
```

| Klíč | Význam |
|---|---|
| `composePath` | vybraný `docker-compose.yml`, po startu se načte |
| `composeFiles` | soubory v rozbalovacím seznamu v uloženém pořadí: `path` a nepovinná `note`. Duplicitní cesty (bez ohledu na velikost písmen) se zahodí a `composePath`, který v seznamu chybí, se přidá na začátek, takže starší nastavení bez `composeFiles` funguje dál |
| `autoRefresh`, `refreshSeconds` | automatická obnova a její interval (5–300 s) |
| `groups` | skupiny služeb (`name` musí být jedinečné, služby, které v compose chybí, se při akci vypíšou) |
| `localBinaries` | mapování DTF služeb na zdrojové projekty, viz níže |

## Lokální binárky

Tlačítko **Nahrát lokální binárky** je vidět jen u služby, která má záznam v `localBinaries`. Povolené je, jen když kontejner běží a startovací skript už vypsal `Console starting ...` (předtím by Bin přepsal balíček z Nexusu).

| Klíč | Povinný | Význam |
|---|---|---|
| `serviceName` | ano | název služby v compose |
| `projectPath` | ano | cesta k `.csproj` zdrojového projektu |
| `mainAssembly` | ano | hlavní DLL projektu (AssemblyName), např. `DTF.Ukazka.dll` |
| `configuration` | ne | `Debug` (výchozí) |
| `defaultScope` | ne | `assembly` = jen DLL + pdb (výchozí), `outputFolder` = celá výstupní složka buildu |
| `outputFolderExcludes` | ne | masky souborů, které se u celé složky nekopírují (výchozí `["*.config"]`) |
| `binPath` | ne | `null` = odvodí se z volume `…:/dtf-test` + `Bin` |
| `msBuildPath` | ne | cesta k `MSBuild.exe` |

Cestu k projektu nemusíš psát do `settings.json` ručně. Když `projectPath` po otevření okna neexistuje, aplikace nabídne vybrat soubor `.csproj` v průzkumníku. Vybraná cesta se rovnou uloží do `settings.json`. Projekt jde kdykoli změnit i tlačítkem **Změnit projekt…**.

Postup po stisku **Sestavit a nahrát**:

1. Zjistí větev, commit a necommitnuté změny (`git`).
2. Zjistí výstupní cestu projektu a spustí `MSBuild -t:Rebuild`. Výstup buildu se vypisuje do okna.
3. Ověří, že hlavní DLL je čerstvá a že se kontejner mezitím nerestartoval. Jinak nic nekopíruje.
4. U celé složky se před kopírováním zeptá (počet přepsaných a nových souborů, upozornění na framework DLL).
5. Zkopíruje soubory do `Bin` a zapíše značku `.local-binaries.json`. Podle ní pak sloupec Binárky ukazuje `Local · větev · commit`.

Restart kontejneru vrátí binárky z Nexusu.

## Místo na disku

Docker staré verze sám nemaže. Po každém novém stažení nebo sestavení image na stejný tag zůstane předchozí verze jako `<none>`. Po odstranění kontejneru zůstanou jeho anonymní volumy a build si drží cache. Tlačítko **Místo na disku** v hlavičce otevře okno, kde jde tohle místo najít a uvolnit.

- **Souhrn** – počet, kolik se používá, kolik zabírá a kolik jde uvolnit, zvlášť pro image, kontejnery, volumy a build cache (z `docker system df`).
- **Kde data leží** – složka Dockeru (`/var/lib/docker`). Na Windows i WSL distribuce, cesta k jejímu virtuálnímu disku `ext4.vhdx`, jeho velikost a volné místo na disku Windows.
- **Podle služeb** – kolik každá služba compose zabírá (image, kontejner, volumy) a kolik u ní jde uvolnit. Dvojklik zobrazí její položky.
- **Image / Kontejnery / Volumy / Build cache** – tabulka položek s verzí, službou, datem, velikostí a tím, kolik smazání uvolní. Po kliknutí na řádek se dole vypíše, co položka je, kde leží a co se stane po smazání.

Položky jsou rozdělené podle toho, co jejich smazání způsobí:

| Kategorie | Co sem patří | Co se stane po smazání |
|---|---|---|
| Bezpečné (zelená) | staré verze image `<none>` bez kontejneru, nepoužívaná build cache, osiřelé anonymní volumy (jejich kontejner už neexistuje a compose je znovu nepoužije) | nic, co běží nebo je v compose, se nezmění. Další build bude pomalejší, ve starých volumech můžou být stará data |
| Na vyžádání (žlutá) | image s tagem bez kontejneru, zastavené kontejnery | image se při dalším použití znovu stáhne nebo sestaví, službu jde dál spustit a vytvoří se nový kontejner |
| Na vyžádání · data (červená) | pojmenované volumy bez kontejneru | **smažou se jejich data**, před smazáním je druhé potvrzení |
| Používá se (šedá) | cokoli, co používá nějaký kontejner (i zastavený) | nejde vybrat |

**Vybrat vše bezpečné** vybere bezpečné položky ve všech záložkách, při filtru služby jen u ní. Před smazáním se zobrazí souhrn podle druhu položek s tím, kolik se uvolní a co se ztratí. Maže se bez `--force` (`docker rm`, `docker image rm`, `docker volume rm`, `docker builder prune --all`), takže Docker odmítne cokoli, co se mezitím začalo používat. Image s více tagy se uvolní až po smazání všech tagů. Uvedená velikost je spodní odhad, protože smazáním více verzí se uvolní i vrstvy, které sdílely.

Sloupec **Lze uvolnit** v hlavní tabulce bere data ze stejného zjištění. Údaje se drží 5 minut a čerstvé se načtou po Obnovit, Načíst služby, stažení image, Odstranit a po zavření okna Místo na disku.

> **Windows (WSL):** smazáním se uvolní místo uvnitř virtuálního disku `ext4.vhdx` a Docker ho použije pro další image. Soubor `.vhdx` se ale sám nezmenší, Windows místo dostanou zpět až po jeho zmenšení. Na Linuxu s nativním Dockerem se místo uvolní hned.

### Zmenšit virtuální disk (Windows)

Tlačítko **Zmenšit virtuální disk…** v okně Místo na disku je vidět jen na Windows, když Docker běží ve WSL distribuci na tomto počítači. Po potvrzení:

1. `wsl -d <distribuce> -u root fstrim -av` označí volné místo, bez toho by komprimace skoro nic neuvolnila,
2. `wsl --shutdown` zastaví WSL, tedy **Docker a všechny kontejnery**,
3. `diskpart` (`attach vdisk readonly`, `compact vdisk`, `detach vdisk`) zkomprimuje soubor `.vhdx`. Windows si vyžádá **oprávnění správce** (UAC). Když komprimace selže, disk se aspoň odpojí,
4. WSL se znovu spustí. Kontejnery bez restart policy je potřeba spustit znovu (Spustit skupinu).

Data uvnitř zůstanou. Okno se během zmenšování nedá zavřít. Nejdřív smaž nepotřebné položky, jinak se uvolní málo. Cestu k disku s diakritikou aplikace nezpracuje, takový disk zmenši ručně stejnými příkazy.

Automatické zmenšování (sparse režim) umí WSL 2.0 a novější: `wsl --update`, `wsl --shutdown` a `wsl --manage <distribuce> --set-sparse true`. U některých verzí WSL je označený jako experimentální. Okno ukazuje nainstalovanou verzi WSL a podle ní nabídne správný postup.

## Záznamy o chybách

Když aplikace spadne nebo zobrazí chybu, zapíše o tom záznam do složky **`error-reports`**, která leží vedle `settings.json` (tedy vedle spouštěného exe, případně v uživatelské složce).

- Záznamy jsou v souborech po dnech: `error-report-RRRR-MM-DD.log`.
- Každá další chyba se **připíše na konec** souboru, starší záznamy se nikdy nepřepíšou. Každý záznam má vlastní ID a čas.
- Zapisuje se:
  - chyba zobrazená v okně „Operace selhala“ (i v okně lokálních binárek),
  - chyba při načítání nebo sledování logu,
  - neočekávaná chyba skriptu v okně i v hlavním procesu (ta se navíc ukáže v dialogu s cestou k záznamu),
  - pád okna nebo jiného procesu aplikace.
- Záznam obsahuje vše potřebné k zopakování chyby:

  | Část | Obsah |
  |---|---|
  | Zpráva, Stack | text chyby a místo v kódu |
  | Kontext | rozpracovaná operace a její poslední řádky, cesta ke compose, vybraná skupina a služba, stav kontejneru. U lokálních binárek mapování, cílová složka Bin, rozsah, git a konec výpisu buildu |
  | Prostředí | verze aplikace, Electronu a OS, cesta k exe a k nastavení |
  | Nastavení | aktuální obsah `settings.json` |
  | Poslední volání | až 40 posledních akcí (Docker, WSL, compose, git, MSBuild…) s argumenty, dobou trvání a výsledkem, u chyb i se stackem |

Při nahlášení chyby stačí poslat příslušný záznam ze souboru.

## Řešení problémů

- **Načtení stavu trvá dlouho** – `docker compose ps` u compose na síťovém nebo mapovaném disku trvá i desítky sekund, první volání `docker` po pauze také. Je to rychlost Docker CLI, aplikace na výsledek jen čeká.
- **Registr vyžaduje přihlášení** – v `~/.docker/config.json` na straně, kde aplikace běží, chybí údaje k registru. Na Windows s Dockerem jen ve WSL tento soubor často neexistuje.
- **„Program docker není v PATH.“** – aplikace nenašla příkaz `docker`. Ověř v terminálu `which docker` a `docker info`. Když Docker chybí, nainstaluj ho. Když `docker info` hlásí „permission denied … docker.sock“, přidej se do skupiny docker (`sudo usermod -aG docker $USER`) a znovu se přihlas. Aplikace přebírá `PATH` z prostředí, ze kterého ji spouštíš.
- **Na Linuxu zůstala windowsová cesta ke compose** (`C:\...`) – je to výchozí hodnota z nastavení. Vyber svůj `docker-compose.yml` tlačítkem **Procházet** a stiskni **Načíst služby**. Windowsovou cestu pak můžeš ze seznamu smazat přes **Spravovat**.
- **Varování v terminálu o `vaapi`, `MESA-LOADER` nebo `GLib-GObject`** – jde jen o grafickou akceleraci (typicky ve virtuálce) a fungování aplikace neovlivňují. Kdyby se okno špatně vykreslovalo, spusť ho s `--disable-gpu`.
- **Na Linuxu hlásí `./docker-klikatko: Permission denied`** – archiv byl sestavený na Windows a soubory nemají příznak spustitelnosti. V rozbalené složce ho nastav:
  ```bash
  chmod +x docker-klikatko chrome_crashpad_handler chrome-sandbox
  ```
  Pro příště sestav linuxovou verzi na Linuxu přes `./build.sh`.
- **Na Linuxu se aplikace nespustí kvůli sandboxu** (hláška o `chrome-sandbox`) – spusť ji s přepínačem `--no-sandbox`, nebo jednou nastav sandbox (`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`) a pak spouštěj normálně.
- **`npm start` spustí Node místo okna** – v prostředí je nastavená proměnná `ELECTRON_RUN_AS_NODE`. Před spuštěním ji zruš.

## Struktura projektu

```
build.bat, build.ps1   build pro Windows
build.sh               build pro Linux
assets/                ikony aplikace
src/
  App/                 hlavní proces Electronu: okna, IPC, preload
  Process/             spouštění externích programů (výstup po řádcích, timeouty, ukončení stromu procesů)
  Wsl/                 stav, spuštění a zastavení WSL
  Docker/              docker / docker compose, živý seznam kontejnerů, místo na disku
  Compose/             čtení docker-compose a přepis řádku image
  Images/              rozbor názvu image, tagy z registrů, přihlašovací údaje Dockeru
  LocalBinaries/       git, MSBuild, kopírování do Bin a značka nasazení
  Settings/            výchozí settings.json, načítání a ukládání nastavení
  Ui/                  okna aplikace (hlavní okno, logy, živý seznam, místo na disku, lokální binárky)
```
