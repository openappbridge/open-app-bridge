import {
  DETACHED_LIFECYCLE_LIMITS,
  DETACHED_SIGNAL_LIMITS,
  OAB_TRANSPORTS,
  consumeIncomingHandoff,
  discoverReceiver,
  toSafeErrorPresentation,
} from "../../src/index.js";

const byId = (id) => document.getElementById(id);
const waiting = byId("waiting");
const incoming = byId("incoming");
const incomingOrigin = byId("incoming-origin");
const incomingCallbackOrigin = byId("incoming-callback-origin");
const verifyLink = byId("verify");
const cancelIncoming = byId("cancel-incoming");
const consentDialog = byId("consent");
const allowOnce = byId("allow-once");
const deny = byId("deny");
const preview = byId("preview");
const provenance = byId("provenance");
const previewTitle = byId("preview-title");
const previewText = byId("preview-text");
const previewAssets = byId("preview-assets");
const previewStatus = byId("preview-status");
const preserveButton = byId("preserve");
const discardButton = byId("discard");

let currentDelivery = null;
let transferHandle = null;
let verificationIntent = false;
let releasePreparedControls = () => {};

function localDeclaration(signal) {
  return discoverReceiver(location.origin, {
    fetchApplicationManifest: false,
    signal,
  });
}

function dialogDecision(dialog, allowButton, denyButton, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (allowed, closeDialog = true) => {
      if (settled) return;
      settled = true;
      allowButton.removeEventListener("click", allow);
      denyButton.removeEventListener("click", reject);
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("close", closed);
      signal?.removeEventListener("abort", aborted);
      if (closeDialog && dialog.open) dialog.close();
      resolve({ allowed });
    };
    const allow = () => finish(true);
    const reject = () => finish(false);
    const cancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const closed = () => finish(false, false);
    const aborted = () => finish(false);
    allowButton.addEventListener("click", allow, { once: true });
    denyButton.addEventListener("click", reject, { once: true });
    dialog.addEventListener("cancel", cancel, { once: true });
    dialog.addEventListener("close", closed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    dialog.showModal();
  });
}

function waitForReceiverForeground(signal) {
  const isForeground = () =>
    document.visibilityState === "visible" && document.hasFocus();
  if (isForeground()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => {
      if (!isForeground()) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Receiver closed.", "AbortError"));
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function openSecurityDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oab-reference-receiver-security", 4);
    let settled = false;
    request.addEventListener("upgradeneeded", () => {
      const transaction = request.transaction;
      const claims = request.result.objectStoreNames.contains("claims")
        ? transaction.objectStore("claims")
        : request.result.createObjectStore("claims", { keyPath: "id" });
      const leases = request.result.objectStoreNames.contains("leases")
        ? transaction.objectStore("leases")
        : request.result.createObjectStore("leases", { keyPath: "id" });
      const reservations = request.result.objectStoreNames.contains(
        "byte-reservations",
      )
        ? transaction.objectStore("byte-reservations")
        : request.result.createObjectStore(
          "byte-reservations",
          { keyPath: "id" },
        );
      for (const store of [claims, leases, reservations]) {
        if (!store.indexNames.contains("expiresAt")) {
          store.createIndex("expiresAt", "expiresAt");
        }
      }
      // Version 4 writes one tuple key. Live v3 request/channel tombstones are
      // retained and checked until their natural expiry so an upgrade cannot
      // reopen a replay window.
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
      reject(new Error("The receiver security database upgrade is blocked."));
    });
  });
}

function pruneExpiredWithIndex(store, now, complete) {
  const request = store.index("expiresAt").openCursor(
    IDBKeyRange.upperBound(now),
  );
  request.addEventListener("success", () => {
    const cursor = request.result;
    if (!cursor) {
      complete();
      return;
    }
    cursor.delete();
    cursor.continue();
  });
}

async function deleteAdmissionLease(id) {
  const database = await openSecurityDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("leases", "readwrite");
      transaction.objectStore("leases").delete(id);
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

async function promoteAdmissionLease(id, { expiresAt }) {
  const now = Date.now();
  const maximumActiveExpiry =
    now +
    DETACHED_LIFECYCLE_LIMITS.maximumSessionLifetimeMs +
    DETACHED_SIGNAL_LIMITS.maximumClockSkewMs;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > maximumActiveExpiry
  ) return false;
  const database = await openSecurityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("leases", "readwrite");
      const store = transaction.objectStore("leases");
      let promoted = false;
      const getRequest = store.get(id);
      getRequest.addEventListener("success", () => {
        const record = getRequest.result;
        if (
          !record ||
          !Number.isSafeInteger(record.expiresAt) ||
          record.expiresAt <= now ||
          record.state !== "pending"
        ) return;
        store.put({ ...record, expiresAt, state: "active" });
        promoted = true;
      });
      getRequest.addEventListener("error", () => reject(getRequest.error));
      transaction.addEventListener("complete", () => resolve(promoted));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

async function admitIncomingHandoff({
  requestId,
  channelId,
  transport,
  replayExpiresAt,
  pendingExpiresAt,
  maximumActiveSessions,
  maximumReplayClaims,
}) {
  const now = Date.now();
  if (
    !Number.isSafeInteger(replayExpiresAt) ||
    replayExpiresAt <= now ||
    !Number.isSafeInteger(pendingExpiresAt) ||
    pendingExpiresAt <= now ||
    pendingExpiresAt > replayExpiresAt ||
    !Number.isSafeInteger(maximumActiveSessions) ||
    maximumActiveSessions < 1 ||
    maximumActiveSessions > 4 ||
    !Number.isSafeInteger(maximumReplayClaims) ||
    maximumReplayClaims < maximumActiveSessions ||
    maximumReplayClaims > 512
  ) {
    throw new TypeError("Invalid atomic handoff admission request.");
  }
  const id = `${transport}:${requestId}:${channelId ?? "link"}`;
  const legacyRequestId = `request:${requestId}`;
  const legacyChannelId = channelId == null ? null : `channel:${channelId}`;
  const database = await openSecurityDatabase();
  let outcome = "session-capacity";
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        ["claims", "leases"],
        "readwrite",
      );
      const claims = transaction.objectStore("claims");
      const leases = transaction.objectStore("leases");
      let pruned = 0;
      const afterPrune = () => {
        pruned += 1;
        if (pruned !== 2) return;
        const claimsRequest = claims.getAll();
        const leasesRequest = leases.getAll();
        let liveClaims;
        let liveLeases;
        const decide = () => {
          if (!liveClaims || !liveLeases) return;
          if (liveClaims.some((record) =>
            record.id === id ||
            record.id === legacyRequestId ||
            (legacyChannelId != null && record.id === legacyChannelId))) {
            outcome = "replay";
            return;
          }
          if (liveLeases.length >= maximumActiveSessions) {
            outcome = "session-capacity";
            return;
          }
          if (liveClaims.length >= maximumReplayClaims) {
            outcome = "replay-capacity";
            return;
          }
          claims.add({ id, expiresAt: replayExpiresAt });
          leases.add({ id, expiresAt: pendingExpiresAt, state: "pending" });
          outcome = "admitted";
        };
        claimsRequest.addEventListener("success", () => {
          liveClaims = claimsRequest.result;
          decide();
        });
        leasesRequest.addEventListener("success", () => {
          liveLeases = leasesRequest.result;
          decide();
        });
        claimsRequest.addEventListener("error", () => reject(claimsRequest.error));
        leasesRequest.addEventListener("error", () => reject(leasesRequest.error));
      };
      pruneExpiredWithIndex(claims, now, afterPrune);
      pruneExpiredWithIndex(leases, now, afterPrune);
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
  if (outcome !== "admitted") {
    return Object.freeze({ admitted: false, reason: outcome });
  }
  return Object.freeze({
    admitted: true,
    promote: (request) => promoteAdmissionLease(id, request),
    release: () => deleteAdmissionLease(id),
  });
}

async function deleteByteReservation(id) {
  const database = await openSecurityDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("byte-reservations", "readwrite");
      transaction.objectStore("byte-reservations").delete(id);
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

async function reserveIncomingBytes({
  requestId,
  channelId,
  transferId,
  totalBytes,
  maximumAggregateTransferBytes,
  expiresAt,
}) {
  const now = Date.now();
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    totalBytes > 33554432 ||
    !Number.isSafeInteger(maximumAggregateTransferBytes) ||
    maximumAggregateTransferBytes < totalBytes ||
    maximumAggregateTransferBytes > 67108864 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now
  ) {
    return Object.freeze({ reserved: false });
  }
  const id = `${requestId}:${channelId}:${transferId}`;
  const database = await openSecurityDatabase();
  let reserved = false;
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("byte-reservations", "readwrite");
      const store = transaction.objectStore("byte-reservations");
      const recordsRequest = store.getAll();
      recordsRequest.addEventListener("success", () => {
        const records = recordsRequest.result;
        const live = records.filter(
          (record) => Number.isSafeInteger(record.expiresAt) && record.expiresAt > now,
        );
        for (const record of records) {
          if (!live.includes(record)) store.delete(record.id);
        }
        const reservedBytes = live.reduce(
          (sum, record) => sum + (Number.isSafeInteger(record.totalBytes) ? record.totalBytes : 0),
          0,
        );
        if (
          live.some((record) => record.id === id) ||
          reservedBytes + totalBytes > maximumAggregateTransferBytes
        ) {
          return;
        }
        store.add({ id, totalBytes, expiresAt });
        reserved = true;
      });
      recordsRequest.addEventListener("error", () => reject(recordsRequest.error));
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
  if (!reserved) return Object.freeze({ reserved: false });
  return Object.freeze({
    reserved: true,
    release: () => deleteByteReservation(id),
  });
}

function releasePreview() {
  if (currentDelivery) {
    for (const asset of currentDelivery.assets) {
      if (asset.data instanceof Uint8Array) asset.data.fill(0);
    }
  }
  currentDelivery = null;
  previewTitle.textContent = "";
  provenance.textContent = "";
  previewText.textContent = "";
  previewAssets.replaceChildren();
  previewStatus.textContent = "";
  previewStatus.classList.remove("error");
}

function releaseTransientReceiverState() {
  releasePreview();
  verificationIntent = false;
  incomingOrigin.textContent = "";
  incomingCallbackOrigin.textContent = "";
  delete incomingOrigin.dataset.origin;
  verifyLink.removeAttribute("href");
  if (consentDialog.open) consentDialog.close();
}

function showContentFreeTerminal(error) {
  const presentation = toSafeErrorPresentation(error);
  transferHandle = null;
  releaseTransientReceiverState();
  preview.classList.add("hidden");
  incoming.classList.add("hidden");
  waiting.textContent = presentation.message;
  if (presentation.technicalCode) {
    waiting.dataset.technicalCode = presentation.technicalCode;
  } else {
    delete waiting.dataset.technicalCode;
  }
  waiting.classList.remove("hidden");
}

function showPreview(delivery) {
  releasePreview();
  currentDelivery = delivery;
  preserveButton.disabled = false;
  discardButton.disabled = false;
  waiting.classList.add("hidden");
  incoming.classList.add("hidden");
  preview.classList.remove("hidden");
  previewTitle.textContent = delivery.title || "Untitled handoff";
  provenance.textContent = delivery.source.originVerified
    ? `Shared from ${delivery.source.origin}`
    : "Unverified app or website · portable non-confidential link";
  if (Number.isSafeInteger(delivery.dispositionExpiresAt)) {
    previewStatus.textContent =
      `Nothing is saved yet. Save or Discard by ${new Date(delivery.dispositionExpiresAt).toLocaleTimeString()}.`;
  }
  previewText.textContent =
    delivery.representations["text/markdown"] ??
    delivery.representations["text/plain"] ??
    delivery.representations["text/html"] ??
    "Asset-only handoff";
  previewAssets.replaceChildren();
  for (const asset of delivery.assets) {
    const card = document.createElement("article");
    card.className = "asset";
    const title = document.createElement("strong");
    const data = asset.data ?? asset.blob;
    const size = data?.byteLength ?? data?.size ?? 0;
    title.textContent = `${asset.name} · ${size.toLocaleString()} bytes`;
    card.append(title);
    const note = document.createElement("small");
    note.textContent =
      "Opaque attachment · binary rendering is intentionally disabled in this security-focused reference UI.";
    card.append(note);
    previewAssets.append(card);
  }
}

function openDatabase(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Preserve was aborted."));
      return;
    }
    const request = indexedDB.open("oab-receiver-bridge-example", 2);
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error("Preserve was aborted."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("documents")) {
        request.result.createObjectStore("documents", { keyPath: "batchId" });
      }
    });
    request.addEventListener("success", () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      cleanup();
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("The document database is blocked."));
    });
  });
}

function receiverDocumentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function persistWithId(delivery, batchId, signal) {
  const database = await openDatabase(signal);
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("documents", "readwrite");
      const abort = () => {
        try {
          transaction.abort();
        } catch (_) {}
      };
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
      transaction.objectStore("documents").add({
        batchId,
        title: delivery.title,
        representations: delivery.representations,
        assets: delivery.assets.map((asset) => ({
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.data?.byteLength ?? asset.blob?.size ?? 0,
          blob: asset.blob ?? new Blob([asset.data], { type: asset.mimeType }),
        })),
        source: delivery.source,
        preservedAt: new Date().toISOString(),
      });
      transaction.addEventListener("complete", () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      transaction.addEventListener("abort", () => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? transaction.error ?? new Error("Preserve was aborted."));
      });
      transaction.addEventListener("error", () => {
        signal?.removeEventListener("abort", abort);
        reject(transaction.error);
      });
    });
  } finally {
    database.close();
  }
  return batchId;
}

async function deletePersisted(batchId) {
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

function persistenceTransaction(delivery) {
  return Object.freeze({
    commit: ({ signal, transactionId }) =>
      persistWithId(delivery, transactionId, signal),
    rollback: ({ transactionId }) => deletePersisted(transactionId),
  });
}

function persistPortableDelivery(delivery) {
  return persistWithId(delivery, receiverDocumentId());
}

function strictApplicationPath(batchId = null) {
  if (batchId == null) return "/examples/receiver/app/index.html";
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(batchId)) {
    throw new Error("The receiver generated an invalid durable document ID.");
  }
  return `/examples/receiver/app/document/${batchId}`;
}

function replaceWithStrictApplication(batchId = null) {
  transferHandle = null;
  releaseTransientReceiverState();
  location.replace(strictApplicationPath(batchId));
}

preserveButton.addEventListener("click", async () => {
  if (!currentDelivery) return;
  const delivery = currentDelivery;
  const handle = transferHandle;
  preserveButton.disabled = true;
  discardButton.disabled = true;
  preview.setAttribute("aria-busy", "true");
  previewStatus.classList.remove("error");
  previewStatus.textContent = "Making a safe copy…";
  try {
    const batchId = handle
      ? await handle.preserve(persistenceTransaction(delivery))
      : await persistPortableDelivery(delivery);
    transferHandle = null;
    releaseTransientReceiverState();
    preview.classList.add("hidden");
    preview.removeAttribute("aria-busy");
    waiting.textContent = "Saved. Opening the app…";
    waiting.classList.remove("hidden", "error");
    await new Promise((resolve) => setTimeout(resolve, 500));
    location.replace(strictApplicationPath(batchId));
  } catch (error) {
    if (handle && handle.state !== "previewing") {
      preview.removeAttribute("aria-busy");
      showContentFreeTerminal(error);
      return;
    }
    previewStatus.textContent =
      `Preserve failed: ${error?.message ?? "No durable copy was accepted."}`;
    previewStatus.classList.add("error");
    const canRetry = !handle || handle.state === "previewing";
    preserveButton.disabled = !canRetry;
    discardButton.disabled = !canRetry;
    preview.removeAttribute("aria-busy");
  }
});

discardButton.addEventListener("click", async () => {
  if (!currentDelivery) return;
  preserveButton.disabled = true;
  discardButton.disabled = true;
  try {
    await transferHandle?.complete("discarded");
  } finally {
    replaceWithStrictApplication();
  }
});

window.addEventListener("pagehide", () => {
  releasePreparedControls(true);
  const handle = transferHandle;
  transferHandle = null;
  // pagehide may place this Document into the back/forward cache immediately.
  // Release every application-owned byte and DOM reference synchronously;
  // the channel abort below is only a best-effort wire notification.
  releaseTransientReceiverState();
  if (handle) {
    void handle.abort("receiver_page_closed").catch(() => {});
  }
}, { once: true });

export async function installReceiver(options = {}) {
  const bootstrapError = options.bootstrapError ?? null;
  let scrubbedHandoff = options.scrubbedHandoff == null
    ? null
    : Object.freeze({ ...options.scrubbedHandoff });
  options = null;
  if (bootstrapError) {
    scrubbedHandoff = null;
    waiting.textContent = bootstrapError;
    return;
  }
  let active = true;
  const discoveryAbort = new AbortController();
  const abandonInstall = () => {
    active = false;
    scrubbedHandoff = null;
    discoveryAbort.abort();
  };
  window.addEventListener("pagehide", abandonInstall, { once: true });
  let declaration;
  try {
    declaration = await localDeclaration(discoveryAbort.signal);
  } catch (error) {
    if (!active) return;
    throw error;
  }
  if (!active) return;
  await waitForReceiverForeground(discoveryAbort.signal);
  if (!active) return;
  let captured = scrubbedHandoff;
  scrubbedHandoff = null;
  let result;
  try {
    result = consumeIncomingHandoff(declaration, {
      windowRef: window,
      ...(captured == null ? {} : { scrubbedHandoff: captured }),
      admitIncomingHandoff,
      reserveIncomingBytes,
      onCleanupError({ operation, error }) {
        console.error(`OAB cleanup failure during ${operation}`, error);
      },
      onActivationError({ error }) {
        releasePreparedControls();
        showContentFreeTerminal(error);
      },
      async authorizeSender(request) {
        return dialogDecision(consentDialog, allowOnce, deny, request.signal);
      },
      async deliver(delivery) {
        showPreview(delivery);
      },
      async authorizeOrigin(evidence, { signal }) {
        const allowed =
          verificationIntent === true &&
          signal.aborted === false &&
          evidence.origin === incomingOrigin.dataset.origin;
        verificationIntent = false;
        return {
          allowed,
        };
      },
      async authorizeManifest(
        _manifest,
        _manifestDigest,
        { signal, previewAuthorization },
      ) {
        const allowed =
          previewAuthorization?.senderOrigin === incomingOrigin.dataset.origin &&
          previewAuthorization?.receiverOrigin === location.origin &&
          previewAuthorization?.transport ===
            OAB_TRANSPORTS.detachedDataChannel &&
          previewAuthorization?.intent === "preview" &&
          Date.now() < previewAuthorization.expiresAt &&
          signal.aborted === false;
        return {
          allowed,
          reason: allowed ? undefined : "policy_denied",
        };
      },
      async onPreview(delivery) {
        showPreview(delivery);
      },
    });
  } finally {
    captured = null;
    window.removeEventListener("pagehide", abandonInstall);
  }
  if (!result) {
    waiting.textContent = "No OAB handoff was found in this URL.";
    return;
  }
  if (result.transport === OAB_TRANSPORTS.detachedDataChannel) {
    let preparedSlot = await result.prepare();
    let onVerify;
    let onCancel;
    const cleanupPreparedControls = (closePrepared = false) => {
      const prepared = preparedSlot;
      verifyLink.removeEventListener("click", onVerify);
      cancelIncoming.removeEventListener("click", onCancel);
      preparedSlot = null;
      releasePreparedControls = () => {};
      if (closePrepared) prepared?.close();
    };
    releasePreparedControls = cleanupPreparedControls;
    waiting.classList.add("hidden");
    incoming.classList.remove("hidden");
    incomingOrigin.textContent = preparedSlot.sender.origin;
    incomingCallbackOrigin.textContent = preparedSlot.sender.origin;
    incomingOrigin.dataset.origin = preparedSlot.sender.origin;
    preparedSlot.bind(verifyLink);
    onVerify = (event) => {
      verificationIntent = true;
      const prepared = preparedSlot;
      if (!prepared) {
        event.preventDefault();
        return;
      }
      let verification;
      try {
        verification = prepared.verify(event);
      } catch (error) {
        event.preventDefault();
        cleanupPreparedControls();
        showContentFreeTerminal(error);
        return;
      }
      // The capability is one-shot. The controller owns the in-flight
      // verification; the page must release its DOM listeners and object
      // reference immediately after the accepted activation.
      cleanupPreparedControls();
      // Preserve the browser's current trusted anchor activation, then remove
      // the one-shot helper capability from the DOM.
      setTimeout(() => verifyLink.removeAttribute("href"), 0);
      void Promise.resolve(verification).then((handle) => {
        transferHandle = handle;
        handle.completion.then((disposition) => {
          if (transferHandle !== handle || disposition !== "discarded") return;
          transferHandle = null;
          releaseTransientReceiverState();
          preview.classList.add("hidden");
          waiting.textContent =
            "The transient preview expired or was discarded. No document was preserved.";
          waiting.classList.remove("hidden");
        }).catch((error) => {
          if (transferHandle !== handle) return;
          showContentFreeTerminal(error);
        });
        incoming.classList.add("hidden");
        waiting.textContent = "Checking the sender and getting your preview ready…";
        waiting.classList.remove("hidden");
      }).catch((error) => {
        showContentFreeTerminal(error);
      });
    };
    onCancel = () => {
      cleanupPreparedControls(true);
      releaseTransientReceiverState();
      incoming.classList.add("hidden");
      waiting.textContent = "The handoff request was cancelled.";
      waiting.classList.remove("hidden");
    };
    verifyLink.addEventListener("click", onVerify);
    cancelIncoming.addEventListener("click", onCancel);
    return;
  }
  try {
    await result;
  } catch (error) {
    showContentFreeTerminal(error);
    throw error;
  }
}
