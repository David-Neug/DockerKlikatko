"use strict";

const { tryGetBasic } = require("./dockerCredentials");
const { CanceledError } = require("../Process/errors");

const REQUEST_TIMEOUT_MS = 25000;
const USER_AGENT = "DockerKlikatko";
const AUTH_PARAM = /([A-Za-z0-9_]+)=(?:"([^"]*)"|([^,\s]+))/g;
const MAX_REGISTRY_TAGS = 2000;

function loginRequired(registry) {
  return new Error(`Registr ${registry} vyžaduje přihlášení. V Dockeru chybí uložené údaje pro tento registr.`);
}

async function sendOnce(url, basic, bearer, signal) {
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (bearer)
    headers.Authorization = "Bearer " + bearer;
  else if (basic)
    headers.Authorization = "Basic " + basic;

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    if (signal?.aborted)
      throw new CanceledError();
    if (error?.name === "TimeoutError")
      throw new Error("Registr neodpověděl včas.");
    throw error;
  }
}

function networkError(error) {
  return error instanceof TypeError ? new Error(error.cause?.message || error.message) : error;
}

async function send(url, basic, bearer, signal) {
  try {
    return await sendOnce(url, basic, bearer, signal);
  } catch (error) {
    if (!(error instanceof TypeError) || !url.toLowerCase().startsWith("https://"))
      throw networkError(error);
  }

  try {
    return await sendOnce("http://" + url.slice("https://".length), basic, bearer, signal);
  } catch (error) {
    throw networkError(error);
  }
}

async function safeBody(response) {
  try {
    const body = (await response.text()).replace(/[\r\n]/g, " ").trim();
    return body.length > 240 ? body.slice(0, 240) : body;
  } catch {
    return "";
  }
}

function parseAuthParams(parameter) {
  const map = new Map();
  for (const match of parameter.matchAll(AUTH_PARAM))
    map.set(match[1].toLowerCase(), match[2] !== undefined ? match[2] : match[3]);
  return map;
}

function bearerChallenge(response) {
  const header = response.headers.get("www-authenticate") ?? "";
  const match = /Bearer\s+(.+)/i.exec(header);
  return match ? match[1] : null;
}

async function requestBearer(unauthorized, reference, basic, signal) {
  const challenge = bearerChallenge(unauthorized);
  if (!challenge || challenge.trim().length === 0)
    throw loginRequired(reference.registry);

  const parameters = parseAuthParams(challenge);
  const realm = parameters.get("realm");
  if (!realm || realm.trim().length === 0)
    throw new Error(`Registr ${reference.registry} nevrátil adresu pro přihlášení.`);

  const service = parameters.get("service");
  let scope = parameters.get("scope");
  if (!scope || scope.trim().length === 0)
    scope = "repository:" + reference.repository + ":pull";

  let url = realm + (realm.includes("?") ? "&" : "?") + "scope=" + encodeURIComponent(scope);
  if (service && service.trim().length > 0)
    url += "&service=" + encodeURIComponent(service);

  const response = await sendOnce(url, basic, null, signal);
  if (!response.ok)
    throw new Error(`Registr ${reference.registry} odmítl přihlášení (${response.status}).`);

  const document = await response.json();
  if (typeof document.token === "string")
    return document.token;
  if (typeof document.access_token === "string")
    return document.access_token;
  throw new Error(`Registr ${reference.registry} nevrátil přístupový token.`);
}

function nextLink(response, currentUrl) {
  const header = response.headers.get("link");
  if (!header)
    return null;
  for (const link of header.split(/,(?=\s*<)/)) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
    if (!match)
      continue;
    const target = match[1];
    if (/^https?:\/\//i.test(target))
      return target;
    return new URL(target, currentUrl).toString();
  }
  return null;
}

function rank(tag) {
  const lower = tag.toLowerCase();
  if (lower === "latest")
    return 0;
  if (lower === "stable")
    return 1;
  if (lower === "master" || lower === "main")
    return 2;
  return 10;
}

function compareOrdinalIgnoreCase(left, right) {
  const a = left.toUpperCase();
  const b = right.toUpperCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTags(left, right) {
  const a = left.split(/[.\-_]/);
  const b = right.split(/[.\-_]/);
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const sa = i < a.length ? a[i] : "";
    const sb = i < b.length ? b[i] : "";
    const na = /^[+-]?\d+$/.test(sa);
    const nb = /^[+-]?\d+$/.test(sb);
    const order = na && nb ? Number(sb) - Number(sa) : compareOrdinalIgnoreCase(sb, sa);
    if (order !== 0)
      return order;
  }
  return 0;
}

async function listRegistry(reference, signal) {
  const tags = [];
  const repositoryPath = reference.repository.split("/").map(encodeURIComponent).join("/");
  let next = "https://" + reference.registry + "/v2/" + repositoryPath + "/tags/list?n=200";
  let basic = null;
  let bearer = null;
  let triedBasic = false;
  let triedBearer = false;
  let pages = 0;
  while (next && pages < 10 && tags.length < MAX_REGISTRY_TAGS) {
    pages++;
    const response = await send(next, basic, bearer, signal);
    if (response.status === 401) {
      if (!triedBasic) {
        triedBasic = true;
        basic = await tryGetBasic(reference.registry);
        if (basic)
          continue;
      }
      if (!triedBearer) {
        triedBearer = true;
        bearer = await requestBearer(response, reference, basic, signal);
        if (bearer)
          continue;
      }
      throw loginRequired(reference.registry);
    }

    if (!response.ok)
      throw new Error(`Registr ${reference.registry} vrátil ${response.status}. ${await safeBody(response)}`.trim());

    const document = await response.json();
    if (Array.isArray(document.tags)) {
      for (const name of document.tags) {
        if (typeof name === "string" && name.trim().length > 0)
          tags.push(name);
      }
    }
    next = nextLink(response, next);
  }

  const distinct = [...new Set(tags.filter(tag => tag.trim().length > 0))]
    .sort((left, right) => rank(left) - rank(right) || compareTags(left, right))
    .map(name => ({ name, updated: null }));
  return {
    tags: distinct,
    total: distinct.length,
    warning: tags.length >= MAX_REGISTRY_TAGS ? "Zobrazeno prvních 2000 tagů. Použijte filtr." : null
  };
}

async function listDockerHub(reference, filter, signal) {
  const [namespace, name] = reference.repository.split("/");
  let url = "https://hub.docker.com/v2/repositories/" +
    encodeURIComponent(namespace) + "/" + encodeURIComponent(name) +
    "/tags?page_size=100&ordering=last_updated";
  const hasFilter = filter && filter.trim().length > 0;
  if (hasFilter)
    url += "&name=" + encodeURIComponent(filter.trim());

  const tags = [];
  let total = null;
  const pages = hasFilter ? 1 : 3;
  for (let page = 0; page < pages && url; page++) {
    const response = await send(url, null, null, signal);
    if (!response.ok)
      throw new Error(`Docker Hub vrátil ${response.status}. ${await safeBody(response)}`.trim());

    const document = await response.json();
    if (Number.isInteger(document.count))
      total = document.count;
    for (const item of Array.isArray(document.results) ? document.results : []) {
      if (typeof item?.name !== "string" || item.name.trim().length === 0)
        continue;
      const updated = typeof item.last_updated === "string" ? Date.parse(item.last_updated) : NaN;
      tags.push({ name: item.name, updated: Number.isNaN(updated) ? null : updated });
    }
    url = typeof document.next === "string" ? document.next : null;
  }

  const warning = total !== null && total > 0 && tags.length < total
    ? `Zobrazeno ${tags.length} z ${total}. Filtr hledá v názvu tagu.`
    : null;
  return { tags, total, warning };
}

async function list(reference, filter, signal) {
  if (reference.isDockerHub)
    return listDockerHub(reference, filter, signal);

  const page = await listRegistry(reference, signal);
  if (!filter || filter.trim().length === 0)
    return page;

  const lowerFilter = filter.toLowerCase();
  return { ...page, tags: page.tags.filter(tag => tag.name.toLowerCase().includes(lowerFilter)) };
}

module.exports = { list };
