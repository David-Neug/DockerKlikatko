"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("../Process/processRunner");
const wslCli = require("./wslCli");

const MINUTE = 60000;
const WSL_ENVIRONMENT = { WSL_UTF8: "1" };
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function quotePowerShell(text) {
  return "'" + text.replace(/'/g, "''") + "'";
}

function diskpartScript(vhdxPath, compact) {
  const lines = [`select vdisk file="${vhdxPath}"`];
  if (compact)
    lines.push("attach vdisk readonly", "compact vdisk");
  lines.push("detach vdisk", "exit");
  return lines.join("\r\n") + "\r\n";
}

// Běží jako správce. Když komprimace selže, disk aspoň odpojí, jinak by WSL nešlo znovu spustit.
function elevatedScript(compactPath, detachPath, logPath) {
  return [
    `& diskpart /s ${quotePowerShell(compactPath)} *>&1 | Out-File -FilePath ${quotePowerShell(logPath)} -Encoding utf8`,
    "$code = $LASTEXITCODE",
    `if ($code -ne 0) { & diskpart /s ${quotePowerShell(detachPath)} *>&1 | Out-File -FilePath ${quotePowerShell(logPath)} -Encoding utf8 -Append }`,
    "exit $code"
  ].join("\n");
}

// -EncodedCommand nepodléhá execution policy pro skripty a nevadí mu uvozovky v cestách.
function launcherCommand(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return "$process = Start-Process -FilePath powershell.exe " +
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' ` +
    "-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode";
}

function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, "utf8").replace(/^﻿/, "").trim();
  } catch {
    return null;
  }
}

function result(success, errorText, details) {
  return { success, errorText, ...details };
}

async function compactSteps(vhdxPath, distro, workDirectory, signal, onLine) {
  const compactPath = path.join(workDirectory, "compact.txt");
  const detachPath = path.join(workDirectory, "detach.txt");
  const logPath = path.join(workDirectory, "diskpart.log");
  fs.writeFileSync(compactPath, diskpartScript(vhdxPath, true), "ascii");
  fs.writeFileSync(detachPath, diskpartScript(vhdxPath, false), "ascii");

  onLine(`1/4 Označuji volné místo v distribuci ${distro} (fstrim)…`);
  const trim = await run("wsl.exe", ["-d", distro, "-u", "root", "fstrim", "-av"], { signal, timeoutMs: 30 * MINUTE, env: WSL_ENVIRONMENT, onLine });
  if (!trim.success)
    return result(false, "fstrim selhal, WSL se nezastavilo a disk se nekomprimoval.\n" + trim.errorText, { restarted: true });

  onLine("2/4 Zastavuji WSL a Docker (wsl --shutdown)…");
  const shutdown = await wslCli.shutdown(signal);
  if (!shutdown.success)
    return result(false, "WSL se nepodařilo zastavit, disk se nekomprimoval.\n" + shutdown.errorText, { restarted: false });

  onLine("3/4 Komprimuji virtuální disk (diskpart, potvrďte oprávnění správce)…");
  const elevated = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launcherCommand(elevatedScript(compactPath, detachPath, logPath))], {
    signal,
    timeoutMs: 180 * MINUTE
  });
  const log = readLog(logPath);
  log?.split(/\r?\n/).filter(line => line.trim().length > 0).forEach(onLine);

  onLine(`4/4 Spouštím WSL (${distro})…`);
  const started = await wslCli.startDefault(distro, signal);

  if (log === null)
    return result(false, "Komprimace neproběhla: oprávnění správce nebylo povoleno.\n" + elevated.errorText, { restarted: started.success });
  if (!elevated.success)
    return result(false, "diskpart skončil chybou:\n" + log, { restarted: started.success });
  if (!started.success)
    return result(false, "Disk je zkomprimovaný, ale WSL se nepodařilo znovu spustit. Spusťte ho tlačítkem Spustit WSL.\n" + started.errorText, { restarted: false });
  return result(true, "", { restarted: true });
}

async function compact(vhdxPath, distro, signal, onLine) {
  if (process.platform !== "win32")
    return result(false, "Zmenšení virtuálního disku je jen pro Docker ve WSL na Windows.", {});
  // Skript pro diskpart je v ASCII, cestu s diakritikou by nemusel přečíst správně.
  if (!PRINTABLE_ASCII.test(vhdxPath))
    return result(false, `Cesta k virtuálnímu disku obsahuje diakritiku nebo zvláštní znaky, zmenšete ho ručně (README, Místo na disku):\n${vhdxPath}`, {});

  const beforeBytes = sizeOf(vhdxPath);
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "klikatko-vhd-"));
  try {
    const outcome = await compactSteps(vhdxPath, distro, workDirectory, signal, onLine);
    return { ...outcome, beforeBytes, afterBytes: sizeOf(vhdxPath) };
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

module.exports = { compact };
