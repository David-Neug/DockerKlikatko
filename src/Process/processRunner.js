"use strict";

const fs = require("fs");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const { createResult } = require("./commandResult");
const { ProcessStartError, TimeoutError, CanceledError } = require("./errors");

const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const IS_WINDOWS = process.platform === "win32";

function utf8Decoder() {
  return new StringDecoder("utf8");
}

function createLineCollector(onLine, decoder) {
  const all = [];
  let current = "";

  function publish() {
    if (current.length === 0)
      return;
    const line = current.replace(ANSI_ESCAPE, "");
    current = "";
    if (line.length === 0)
      return;
    all.push(line);
    if (onLine && line.trim().length > 0)
      onLine(line);
  }

  function append(text) {
    // Dekodéry iconv-lite vrací z end() undefined, když nemají rozpracované bajty.
    if (!text)
      return;
    for (const character of text) {
      if (character === "\n" || character === "\r") {
        publish();
        continue;
      }
      current += character;
    }
  }

  return {
    write(chunk) {
      append(decoder.write(chunk));
    },
    end() {
      append(decoder.end());
      publish();
      return all.length === 0 ? "" : all.join("\n") + "\n";
    }
  };
}

function spawnOptions(cwd, env) {
  return {
    cwd: cwd || process.cwd(),
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    detached: !IS_WINDOWS
  };
}

function startError(fileName, error, cwd) {
  if (error?.code === "ENOENT" && cwd && !fs.existsSync(cwd))
    return new ProcessStartError(`Pracovní složka příkazu ${fileName} neexistuje: ${cwd}`);
  if (error?.code === "ENOENT")
    return new ProcessStartError(`Program ${fileName} není v PATH.`);
  return new ProcessStartError(`Program ${fileName} nejde spustit.`);
}

function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  try {
    if (IS_WINDOWS)
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    else
      process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Proces už skončil.
    }
  }
}

function run(fileName, args, options = {}) {
  const { cwd, signal, timeoutMs, env, onLine, createDecoder = utf8Decoder, input } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CanceledError());
      return;
    }

    let child;
    try {
      child = spawn(fileName, args, spawnOptions(cwd, env));
    } catch (error) {
      reject(startError(fileName, error, cwd));
      return;
    }

    const stdout = createLineCollector(onLine, createDecoder());
    const stderr = createLineCollector(onLine, createDecoder());
    let settled = false;
    let timedOut = false;
    const onAbort = () => kill(child);
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeoutMs) : null;
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = action => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };

    child.stdout.on("data", chunk => stdout.write(chunk));
    child.stderr.on("data", chunk => stderr.write(chunk));
    child.on("error", error => finish(() => reject(startError(fileName, error, cwd))));
    child.on("close", code => finish(() => {
      if (timedOut) {
        reject(new TimeoutError(`Příkaz vypršel: ${fileName}.`));
        return;
      }
      if (signal?.aborted) {
        reject(new CanceledError());
        return;
      }
      resolve(createResult(code ?? 1, stdout.end(), stderr.end()));
    }));

    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function start(fileName, args, options = {}) {
  const { cwd, env, onLine, onExit, createDecoder = utf8Decoder } = options;
  let child;
  try {
    child = spawn(fileName, args, spawnOptions(cwd, env));
  } catch (error) {
    throw startError(fileName, error, cwd);
  }

  const stdout = createLineCollector(onLine, createDecoder());
  const stderr = createLineCollector(onLine, createDecoder());
  let exited = false;
  const exit = error => {
    if (exited)
      return;
    exited = true;
    onExit?.(error);
  };

  child.stdout.on("data", chunk => stdout.write(chunk));
  child.stderr.on("data", chunk => stderr.write(chunk));
  child.on("error", error => exit(startError(fileName, error, cwd)));
  child.on("close", () => {
    stdout.end();
    stderr.end();
    exit();
  });
  child.stdin.end();

  return {
    stop() {
      exited = true;
      kill(child);
    }
  };
}

module.exports = { run, start, kill, IS_WINDOWS };
