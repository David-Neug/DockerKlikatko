"use strict";

function formatDateTime(milliseconds) {
  const date = new Date(milliseconds);
  const pad = value => String(value).padStart(2, "0");
  return `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()} ${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { formatDateTime };
