import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SHARE_DESTINATIONS,
  ShareDestinationHistory,
  filterShareDestinations,
  normalizeShareDestinations,
  receiverInputToOrigin,
  receiverOriginToDomain,
  rememberShareDestination,
  removeShareDestination,
} from "../src/share-widget-history.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("normalizes, deduplicates, sorts, and bounds previous destinations", () => {
  const entries = Array.from({ length: MAX_SHARE_DESTINATIONS + 5 }, (_, index) => ({
    origin: `https://receiver-${index}.example`,
    lastUsedAt: index,
  }));
  entries.push({ origin: "https://receiver-3.example", lastUsedAt: 999 });
  entries.push({ origin: "not a domain", lastUsedAt: 1000 });

  const normalized = normalizeShareDestinations(entries);
  assert.equal(normalized.length, MAX_SHARE_DESTINATIONS);
  assert.deepEqual(normalized[0], {
    origin: "https://receiver-3.example",
    lastUsedAt: 999,
    application: null,
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized[0]), true);
});

test("remember, search, and remove use canonical origins", () => {
  let entries = rememberShareDestination([], "https://Example.com/", 10);
  entries = rememberShareDestination(entries, "https://second.example", 20);
  assert.deepEqual(
    entries.map((item) => item.origin),
    ["https://second.example", "https://example.com"],
  );
  assert.deepEqual(
    filterShareDestinations(entries, "EXAMPLE.COM").map((item) => item.origin),
    ["https://example.com"],
  );
  entries = removeShareDestination(entries, "https://example.com/");
  assert.deepEqual(entries.map((item) => item.origin), ["https://second.example"]);
});

test("domain entry defaults safely to HTTPS and supports local development", () => {
  assert.equal(receiverInputToOrigin("Example.com"), "https://example.com");
  assert.equal(
    receiverInputToOrigin("notes.example.com"),
    "https://notes.example.com",
  );
  assert.equal(
    receiverInputToOrigin("127.0.0.1:8080"),
    "http://127.0.0.1:8080",
  );
  assert.equal(
    receiverInputToOrigin("127.12.34.56:8080"),
    "http://127.12.34.56:8080",
  );
  assert.equal(
    receiverInputToOrigin("[::1]:8080"),
    "http://[::1]:8080",
  );
  assert.equal(
    receiverOriginToDomain("https://Notes.Example.com"),
    "notes.example.com",
  );
  assert.throws(() => receiverInputToOrigin("https://example.com"));
  assert.throws(() => receiverInputToOrigin("http://example.com"));
  assert.throws(() => receiverInputToOrigin("example.com/private"));
  assert.throws(() => receiverInputToOrigin("example.com?target=notes"));
  assert.throws(() => receiverInputToOrigin("example.com#notes"));
  assert.throws(() => receiverInputToOrigin("user@example.com"));
  assert.throws(() => receiverInputToOrigin("markerpad"));
  assert.throws(() => receiverInputToOrigin("-bad.example"));
  assert.throws(() => receiverInputToOrigin("bad..example"));
});

test("history persists locally and falls back to memory when storage fails", () => {
  const storage = memoryStorage();
  const first = new ShareDestinationHistory(storage, "test-history");
  first.remember("https://one.example", 10);
  const second = new ShareDestinationHistory(storage, "test-history");
  assert.equal(second.load()[0].origin, "https://one.example");
  second.remove("https://one.example");
  assert.equal(second.load().length, 0);

  const denied = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  const fallback = new ShareDestinationHistory(denied, "denied");
  fallback.remember("https://memory.example", 30);
  assert.equal(fallback.load()[0].origin, "https://memory.example");
  fallback.clear();
  assert.equal(fallback.load().length, 0);
});

test("history caches bounded untrusted application display metadata", () => {
  const entries = rememberShareDestination(
    [],
    "writer.example",
    50,
    {
      manifestUrl: "https://writer.example/manifest.webmanifest",
      name: "Example Writer",
      shortName: "Writer",
      description: "Portable writing.",
      icons: [
        {
          src: "https://writer.example/icon.png",
          type: "image/png",
          sizes: "192x192",
          purpose: ["any"],
        },
      ],
    },
  );
  assert.equal(entries[0].application.name, "Example Writer");
  assert.equal(Object.hasOwn(entries[0].application, "manifestUrl"), false);
  assert.equal(Object.hasOwn(entries[0].application, "icons"), false);
  assert.equal(
    filterShareDestinations(entries, "portable")[0].origin,
    "https://writer.example",
  );
  assert.equal(
    filterShareDestinations(entries, "writer")[0].application.shortName,
    "Writer",
  );
});
