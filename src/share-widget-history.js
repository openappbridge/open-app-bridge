import { canonicalOrigin, cleanText, isLoopbackHostname } from "./internal.js";
import { OabError } from "./errors.js";
import { normalizeApplicationManifest } from "./application-manifest.js";

export const DEFAULT_SHARE_HISTORY_KEY = "oab.share.destinations.v1";
export const MAX_SHARE_DESTINATIONS = 20;

function isValidReceiverHostname(hostname) {
  const value = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (isLoopbackHostname(value)) return true;
  if (value.includes(":")) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) return true;
  if (value.endsWith(".")) return false;
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  );
}

export function receiverInputToOrigin(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new OabError("invalid_receiver_domain", "Enter a receiver domain.");
  }
  if (input.includes("://")) {
    throw new OabError(
      "invalid_receiver_domain",
      "Enter only the receiver domain, without https://.",
    );
  }
  if (/[\s/?#@]/u.test(input)) {
    throw new OabError(
      "invalid_receiver_domain",
      "Enter a domain or subdomain only. Paths, queries, fragments, and credentials are not accepted.",
    );
  }
  let probe;
  try {
    probe = new URL(`https://${input}`);
  } catch (_) {
    throw new OabError(
      "invalid_receiver_domain",
      "Enter a valid receiver domain, such as markerpad.app.",
    );
  }
  if (
    !isValidReceiverHostname(probe.hostname) ||
    probe.pathname !== "/" ||
    probe.search ||
    probe.hash
  ) {
    throw new OabError(
      "invalid_receiver_domain",
      "Enter a valid domain or subdomain without a path.",
    );
  }
  const scheme = isLoopbackHostname(probe.hostname) ? "http" : "https";
  return canonicalOrigin(`${scheme}://${probe.host}`);
}

export function receiverOriginToDomain(value) {
  return new URL(canonicalOrigin(value)).host;
}

function safeOrigin(value) {
  try {
    const input = String(value || "").trim();
    return input.includes("://")
      ? canonicalOrigin(input)
      : receiverInputToOrigin(input);
  } catch (_) {
    return null;
  }
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeApplication(value, origin) {
  if (!value || typeof value !== "object") return null;
  const normalized = typeof value.manifestUrl === "string"
    ? normalizeApplicationManifest(value, {
        origin,
        manifestUrl: value.manifestUrl,
      })
    : null;
  const source = normalized ?? value;
  const name = cleanText(source.name, 80);
  const shortName = cleanText(source.shortName ?? source.short_name, 40);
  const description = cleanText(source.description, 240);
  const themeColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(
    String(source.themeColor ?? source.theme_color ?? "").toLowerCase(),
  )
    ? String(source.themeColor ?? source.theme_color).toLowerCase()
    : null;
  if (!name && !shortName && !description && !themeColor) return null;
  // History is UX metadata, not a receiver-controlled resource cache. Never
  // persist manifest or icon URLs (including query-bearing tracking tokens).
  return Object.freeze({ name, shortName, description, themeColor });
}

export function normalizeShareDestinations(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.destinations)
      ? value.destinations
      : [];
  const byOrigin = new Map();
  for (const item of source) {
    const origin = safeOrigin(item?.origin ?? item);
    if (!origin) continue;
    const candidate = Object.freeze({
      origin,
      lastUsedAt: safeTimestamp(item?.lastUsedAt),
      application: safeApplication(item?.application, origin),
    });
    const current = byOrigin.get(origin);
    if (!current || candidate.lastUsedAt > current.lastUsedAt) {
      byOrigin.set(origin, candidate);
    }
  }
  return Object.freeze(
    [...byOrigin.values()]
      .sort(
        (left, right) =>
          right.lastUsedAt - left.lastUsedAt ||
          left.origin.localeCompare(right.origin),
      )
      .slice(0, MAX_SHARE_DESTINATIONS),
  );
}

export function rememberShareDestination(
  destinations,
  originValue,
  lastUsedAt = Date.now(),
  application = null,
) {
  const origin = safeOrigin(originValue);
  if (!origin) {
    throw new OabError(
      "invalid_receiver_domain",
      "Enter a valid receiver domain.",
    );
  }
  return normalizeShareDestinations([
    {
      origin,
      lastUsedAt: safeTimestamp(lastUsedAt),
      application: safeApplication(application, origin),
    },
    ...normalizeShareDestinations(destinations),
  ]);
}

export function removeShareDestination(destinations, originValue) {
  const origin = safeOrigin(originValue);
  if (!origin) return normalizeShareDestinations(destinations);
  return Object.freeze(
    normalizeShareDestinations(destinations).filter(
      (item) => item.origin !== origin,
    ),
  );
}

export function filterShareDestinations(destinations, query) {
  const needle = String(query || "").trim().toLowerCase();
  const normalized = normalizeShareDestinations(destinations);
  if (!needle) return normalized;
  return Object.freeze(
    normalized.filter(
      (item) => [
        item.origin.toLowerCase().includes(needle),
        receiverOriginToDomain(item.origin).toLowerCase().includes(needle),
        item.application?.name?.toLowerCase().includes(needle),
        item.application?.shortName?.toLowerCase().includes(needle),
        item.application?.description?.toLowerCase().includes(needle),
      ].some(Boolean),
    ),
  );
}

export class ShareDestinationHistory {
  constructor(storage, key = DEFAULT_SHARE_HISTORY_KEY) {
    this.storage = storage;
    this.key = key;
    this.memory = Object.freeze([]);
  }

  load() {
    try {
      const serialized = this.storage?.getItem?.(this.key);
      if (serialized) {
        this.memory = normalizeShareDestinations(JSON.parse(serialized));
        this.storage?.setItem?.(
          this.key,
          JSON.stringify({ version: 3, destinations: this.memory }),
        );
      }
    } catch (_) {
      // Private browsing and embedded contexts may deny storage. The in-memory
      // history still provides predictable behavior for the current page.
    }
    return this.memory;
  }

  save(destinations) {
    this.memory = normalizeShareDestinations(destinations);
    try {
      this.storage?.setItem?.(
        this.key,
        JSON.stringify({ version: 3, destinations: this.memory }),
      );
    } catch (_) {
      // Storage is an optional local UX enhancement, never a send requirement.
    }
    return this.memory;
  }

  remember(origin, lastUsedAt = Date.now(), application = null) {
    return this.save(
      rememberShareDestination(this.load(), origin, lastUsedAt, application),
    );
  }

  remove(origin) {
    return this.save(removeShareDestination(this.load(), origin));
  }

  clear() {
    this.memory = Object.freeze([]);
    try {
      this.storage?.removeItem?.(this.key);
    } catch (_) {
      // See save().
    }
    return this.memory;
  }
}
