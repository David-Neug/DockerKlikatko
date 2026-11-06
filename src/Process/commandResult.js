"use strict";

function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function errorTextOf(stdOut, stdErr) {
  const stderr = normalize(stdErr);
  const stdout = normalize(stdOut);
  if (stderr.length === 0)
    return stdout.length === 0 ? "Příkaz selhal." : stdout;
  if (stdout.length === 0)
    return stderr;
  return stderr + "\n" + stdout;
}

function createResult(exitCode, stdOut, stdErr) {
  const out = stdOut ?? "";
  const err = stdErr ?? "";
  return {
    exitCode,
    stdOut: out,
    stdErr: err,
    success: exitCode === 0,
    errorText: errorTextOf(out, err)
  };
}

function failedResult(message) {
  return createResult(1, "", message);
}

module.exports = { createResult, failedResult };
