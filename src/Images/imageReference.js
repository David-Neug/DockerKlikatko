"use strict";

function isDockerHubRegistry(registry) {
  return registry.toLowerCase() === "docker.io";
}

function stripDigestAndTag(image) {
  let value = image.trim();
  const digest = value.indexOf("@");
  if (digest >= 0)
    value = value.slice(0, digest);

  let tag = null;
  const slash = value.lastIndexOf("/");
  const colon = value.lastIndexOf(":");
  if (colon > slash) {
    tag = value.slice(colon + 1);
    value = value.slice(0, colon);
  }
  return { value, tag };
}

function repositoryLabel(registry, repository) {
  if (isDockerHubRegistry(registry))
    return repository.startsWith("library/") ? repository.slice("library/".length) : repository;
  return registry + "/" + repository;
}

function parse(image) {
  if ((image ?? "").trim().length === 0)
    throw new Error("Image je prázdný.");

  const { value, tag } = stripDigestAndTag(image);
  if (value.length === 0)
    throw new Error("Image nejde rozpoznat.");

  const firstSlash = value.indexOf("/");
  const first = firstSlash < 0 ? value : value.slice(0, firstSlash);
  const looksLikeRegistry = first.includes(".") || first.includes(":") || first.toLowerCase() === "localhost";
  let registry;
  let repository;
  if (looksLikeRegistry && firstSlash > 0) {
    registry = first;
    repository = value.slice(firstSlash + 1);
    if (isDockerHubRegistry(registry) && !repository.includes("/"))
      repository = "library/" + repository;
  } else {
    registry = "docker.io";
    repository = value.includes("/") ? value : "library/" + value;
  }

  if (repository.length === 0)
    throw new Error("Image nejde rozpoznat.");

  return {
    registry,
    repository,
    tag: tag && tag.trim().length > 0 ? tag : null,
    isDockerHub: isDockerHubRegistry(registry) && repository.split("/").length === 2,
    repositoryLabel: repositoryLabel(registry, repository)
  };
}

function withTag(image, tag) {
  if (!tag || tag.trim().length === 0 || tag.includes(" ") || tag.includes("/") || tag.includes(":"))
    throw new Error("Vybraný tag není platný.");
  return stripDigestAndTag(image).value + ":" + tag;
}

module.exports = { parse, withTag };
