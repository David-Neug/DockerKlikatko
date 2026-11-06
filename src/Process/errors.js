"use strict";

class ProcessStartError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessStartError";
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

class CanceledError extends Error {
  constructor() {
    super("Zrušeno");
    this.name = "CanceledError";
  }
}

function isCanceled(error) {
  return error instanceof CanceledError || error?.name === "AbortError";
}

module.exports = { ProcessStartError, TimeoutError, CanceledError, isCanceled };
