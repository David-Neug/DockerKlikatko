"use strict";

const fs = require("fs");
const { run } = require("../Process/processRunner");

async function runGit(directory, args, signal) {
  const result = await run("git", ["-C", directory, ...args], { cwd: directory, signal, timeoutMs: 60000 });
  if (!result.success)
    throw new Error(`git ${args.join(" ")} selhal: ${result.errorText}`);
  return result.stdOut;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function getInfo(directory, signal) {
  if (!isDirectory(directory))
    throw new Error(`Složka projektu neexistuje: ${directory}`);

  const branch = await runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
  const commit = await runGit(directory, ["rev-parse", "--short", "HEAD"], signal);
  const commitFull = await runGit(directory, ["rev-parse", "HEAD"], signal);
  const status = await runGit(directory, ["status", "--porcelain"], signal);
  return {
    branch: branch.trim(),
    commit: commit.trim(),
    commitFull: commitFull.trim(),
    dirty: status.trim().length > 0
  };
}

function gitText(git) {
  return `Git: větev ${git.branch} · commit ${git.commit}` + (git.dirty ? " · necommitnuté změny (dirty)" : "");
}

module.exports = { getInfo, gitText };
