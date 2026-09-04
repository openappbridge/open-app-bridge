const byId = (id) => document.getElementById(id);
const status = byId("status");
const documentView = byId("document");
const title = byId("document-title");
const provenance = byId("provenance");
const text = byId("document-text");
const assets = byId("document-assets");
const isolation = byId("isolation");

isolation.textContent =
  `COOP application context · crossOriginIsolated: ${crossOriginIsolated}`;

function durableDocumentIdFromCleanRoute() {
  if (location.hash || location.search) return null;
  const match = location.pathname.match(
    /^\/examples\/receiver\/app\/document\/([A-Za-z0-9_-]{16,128})$/u,
  );
  return match?.[1] ?? null;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oab-receiver-bridge-example", 2);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("documents")) {
        request.result.createObjectStore("documents", { keyPath: "batchId" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function openSecurityDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oab-reference-receiver-security", 4);
    let settled = false;
    request.addEventListener("upgradeneeded", () => {
      for (const name of ["claims", "leases", "byte-reservations"]) {
        const store = request.result.objectStoreNames.contains(name)
          ? request.transaction.objectStore(name)
          : request.result.createObjectStore(name, { keyPath: "id" });
        if (!store.indexNames.contains("expiresAt")) {
          store.createIndex("expiresAt", "expiresAt");
        }
      }
    });
    request.addEventListener("success", () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      if (settled) return;
      settled = true;
      reject(new Error("The receiver security database is blocked."));
    });
  });
}

async function pruneExpiredSecurityRecords() {
  const database = await openSecurityDatabase();
  const now = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const names = ["claims", "leases", "byte-reservations"];
      const transaction = database.transaction(names, "readwrite");
      for (const name of names) {
        const store = transaction.objectStore(name);
        const request = store.index("expiresAt").openCursor(
          IDBKeyRange.upperBound(now),
        );
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        });
        request.addEventListener("error", () => reject(request.error));
      }
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

async function readDocument(batchId) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction("documents", "readonly")
        .objectStore("documents")
        .get(batchId);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  } finally {
    database.close();
  }
}

async function deleteDocument(batchId) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("documents", "readwrite");
      transaction.objectStore("documents").delete(batchId);
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

function renderDocument(document) {
  title.textContent = document.title || "Untitled handoff";
  provenance.textContent =
    `${document.source.origin ? `Verified sender: ${document.source.origin}` : "Unverified portable-link sender"} · preserved ${document.preservedAt}`;
  text.textContent =
    document.representations["text/markdown"] ??
    document.representations["text/plain"] ??
    document.representations["text/html"] ??
    "Asset-only handoff";
  for (const asset of document.assets) {
    const card = globalThis.document.createElement("article");
    card.className = "asset";
    const heading = globalThis.document.createElement("strong");
    heading.textContent = `${asset.name} · ${asset.size.toLocaleString()} bytes`;
    card.append(heading);
    const note = globalThis.document.createElement("small");
    note.textContent =
      "Opaque attachment · binary rendering is intentionally disabled in this security-focused reference UI.";
    card.append(note);
    assets.append(card);
  }
  status.classList.add("hidden");
  documentView.classList.remove("hidden");
}

// The restricted receiver performed a full navigation to this clean ordinary
// application route. The path contains only a receiver-owned durable record
// identifier; it is not sender-controlled handoff or fragment capability.
await pruneExpiredSecurityRecords();
const batchId = durableDocumentIdFromCleanRoute();
if (!batchId) {
  status.textContent = "No preserved document was selected.";
} else {
  try {
    const document = await readDocument(batchId);
    if (!document) throw new Error("missing");
    renderDocument(document);
    byId("delete").addEventListener("click", async () => {
      await deleteDocument(batchId);
      title.textContent = "";
      provenance.textContent = "";
      text.textContent = "";
      assets.replaceChildren();
      documentView.classList.add("hidden");
      status.textContent = "The preserved local example was deleted.";
      status.classList.remove("hidden");
    });
  } catch (_) {
    status.textContent = "The preserved local document was not found.";
    status.classList.add("error");
  }
}
