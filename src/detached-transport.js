import { OabError, asOabError } from "./errors.js";
import {
  isOabWireAbortReason,
  normalizeWireAbortReason,
} from "./wire-abort-reasons.js";
import {
  acquireIncomingByteReservation,
  canonicalOrigin,
} from "./internal.js";
import {
  DEFAULT_LIMITS,
  DETACHED_RESOURCE_LIMITS,
} from "./constants.js";
import {
  createDetachedKeyPair,
  decodeBase64Url,
  encodeBase64Url,
  openDetachedAnswer,
  sealDetachedAnswer,
} from "./detached-crypto.js";
import {
  DETACHED_PROTOCOL,
  DETACHED_CHANNEL_LABEL,
  DETACHED_SIGNAL_LIMITS,
  DETACHED_TRANSPORT,
  DETACHED_TRANSPORT_VERSION,
  DETACHED_WIRE_VERSION,
  assertDataOnlySdp,
  collectHostCandidates,
  createDetachedOfferLaunchUrl,
  createDetachedTranscript,
  createHostOnlyPeerConnection,
  validateDetachedAnswer,
  validateDetachedOffer,
} from "./detached-signaling.js";
import {
  DETACHED_FRAME_HEADER_BYTES,
  DETACHED_FRAME_TYPES,
  DetachedFrameReceiver,
  assertManifestMatchesCapabilities,
  assertReliableOrderedChannel,
  decodeDetachedFrame,
  encodeDetachedControl,
  sendDetachedFrame,
  validateDetachedCapabilities,
} from "./detached-framing.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const CHANNEL_CAPABILITY_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

const MAXIMUM_RTC_SETUP_MS = 30 * 1000;
const DEFAULT_RTC_SETUP_MS = 15 * 1000;
const MAXIMUM_CONNECTED_TO_PREVIEW_MS = 10 * 60 * 1000;
const DEFAULT_RECEIVER_CONNECTED_TO_PREVIEW_MS = 2 * 60 * 1000;
const DEFAULT_DISPOSITION_MS = 15 * 60 * 1000;
const MAXIMUM_DISPOSITION_MS = 60 * 60 * 1000;
const DEFAULT_MAXIMUM_FRAMES_PER_SECOND = 2048;
const HARD_MAXIMUM_FRAMES_PER_SECOND = 4096;
const DEFAULT_MAXIMUM_BYTES_PER_SECOND = 32 * 1024 * 1024;
const HARD_MAXIMUM_BYTES_PER_SECOND = 64 * 1024 * 1024;
const MAXIMUM_QUEUED_INBOUND_FRAMES = 32;
const DEFAULT_PRESERVE_SETTLEMENT_MS = 5000;
const MAXIMUM_PRESERVE_SETTLEMENT_MS = 15000;
const MAXIMUM_CONTROL_RESPONSE_MS = 30000;
export const DETACHED_LIFECYCLE_LIMITS = Object.freeze({
  maximumRtcSetupMs: MAXIMUM_RTC_SETUP_MS,
  maximumConnectedToPreviewMs: MAXIMUM_CONNECTED_TO_PREVIEW_MS,
  maximumDispositionMs: MAXIMUM_DISPOSITION_MS,
  maximumSessionLifetimeMs:
    DETACHED_SIGNAL_LIMITS.maximumLifetimeMs +
    MAXIMUM_CONNECTED_TO_PREVIEW_MS +
    MAXIMUM_DISPOSITION_MS,
});
const TERMINAL_STATES = new Set([
  "preserved",
  "discarded",
  "closed",
  "failed",
  "expired",
  "aborted",
]);

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function token(value, label) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new OabError(
      "invalid_detached_identifier",
      `${label} must be a 22–128 character base64url token.`,
    );
  }
  return value;
}

function channelCapability(value, label) {
  if (typeof value !== "string" || !CHANNEL_CAPABILITY_PATTERN.test(value)) {
    throw new OabError(
      "invalid_detached_identifier",
      `${label} must be a canonical 256-bit base64url capability.`,
    );
  }
  return value;
}

function validateRemoteAbort(frame) {
  if (
    frame.typeName !== "abort" ||
    !exactKeys(frame.control, ["reason"]) ||
    !isOabWireAbortReason(frame.control.reason)
  ) {
    throw new OabError(
      "invalid_detached_abort",
      "The peer sent a malformed abort control frame.",
    );
  }
  return frame.control.reason;
}

function assertCapabilitiesWithinDiscovery(liveValue, discoveredValue) {
  const live = validateDetachedCapabilities(liveValue);
  const discovered = validateDetachedCapabilities(discoveredValue);
  const broadenedRepresentation = live.representations.some(
    (type) => !discovered.representations.includes(type),
  );
  const broadenedAsset = live.assetTypes.some(
    (type) => !discovered.assetTypes.includes(type),
  );
  if (
    broadenedRepresentation ||
    broadenedAsset ||
    live.maximumTransferBytes > discovered.maximumTransferBytes ||
    live.maximumAssets > discovered.maximumAssets ||
    live.maximumFrameBytes > discovered.maximumFrameBytes
  ) {
    throw new OabError(
      "detached_capability_broadened",
      "Live receiver capabilities must be equal to or narrower than discovery.",
    );
  }
  return live;
}

function secureToken(options, label) {
  const supplied = options.randomToken?.(label);
  if (supplied !== undefined) {
    let canonical = false;
    if (typeof supplied === "string" && TOKEN_PATTERN.test(supplied)) {
      try {
        canonical = encodeBase64Url(decodeBase64Url(supplied, 96)) === supplied;
      } catch (_) {
        canonical = false;
      }
    }
    if (!canonical) {
      throw new OabError(
        "invalid_detached_token",
        `${label} must be 22–128 canonical base64url characters.`,
      );
    }
    return supplied;
  }
  const provider = options.crypto ?? globalThis.crypto;
  if (typeof provider?.getRandomValues !== "function") {
    throw new OabError(
      "secure_random_unavailable",
      "detached-datachannel/1 requires a secure random generator.",
    );
  }
  const value = new Uint8Array(32);
  provider.getRandomValues(value);
  return encodeBase64Url(value);
}

function secureChannelCapability(options, label) {
  const value = secureToken(options, label);
  if (!CHANNEL_CAPABILITY_PATTERN.test(value)) {
    throw new OabError(
      "invalid_detached_token",
      `${label} must be a canonical 32-byte base64url capability.`,
    );
  }
  return value;
}

function now(options) {
  const value = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now() must return a non-negative integer timestamp.");
  }
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function boundedTimeout(value, fallback, maximum, label) {
  const timeoutMs = value ?? fallback;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer from 100 to ${maximum} ms.`,
    );
  }
  return timeoutMs;
}

function boundedRate(value, fallback, maximum, label) {
  const rate = value ?? fallback;
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > maximum) {
    throw new TypeError(
      `${label} must be an integer from 1 to ${maximum}.`,
    );
  }
  return rate;
}

async function observeSettlement(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(Object.freeze({ status: "timeout" })), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => Object.freeze({ status: "fulfilled", value }),
        (reason) => Object.freeze({ status: "rejected", reason }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rateTime(options) {
  const value = options.rateNow?.() ??
    globalThis.performance?.now?.() ??
    Date.now();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("rateNow() must return a non-negative finite number.");
  }
  return value;
}

function deadlineTime() {
  const value = globalThis.performance?.now?.() ?? Date.now();
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : Date.now();
}

function messageByteLength(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  throw new OabError(
    "invalid_detached_frame",
    "Detached data-channel messages must be binary ArrayBuffer data.",
  );
}

function ownMessageBytes(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new OabError(
    "invalid_detached_frame",
    "Detached data-channel messages must be binary ArrayBuffer data.",
  );
}

function createDeadline(timeoutMs, code, message, onExpire = () => {}) {
  const expired = deferred();
  expired.promise.catch(() => {});
  const abortController = new AbortController();
  let active = true;
  const expiresAt = deadlineTime() + timeoutMs;
  const expire = () => {
    if (!active) return;
    active = false;
    const error = new OabError(code, message);
    abortController.abort(error);
    try {
      onExpire(error);
    } finally {
      expired.reject(error);
    }
    return error;
  };
  const timer = setTimeout(expire, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: abortController.signal,
    get active() {
      return active;
    },
    race(value) {
      return Promise.race([
        Promise.resolve(value),
        expired.promise,
      ]).then((result) => {
        if (active && deadlineTime() >= expiresAt) {
          throw expire();
        }
        return result;
      });
    },
    clear() {
      if (!active) return;
      active = false;
      clearTimeout(timer);
    },
    abort(error = new OabError(code, message)) {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      abortController.abort(error);
      expired.reject(error);
    },
  });
}

function invalidatedSessionError(state, fallbackCode = "invalid_detached_state") {
  if (state === "expired") {
    return new OabError(
      "detached_offer_expired",
      "The detached offer expired while an asynchronous operation was pending.",
    );
  }
  return new OabError(
    fallbackCode,
    "The detached session ended while an asynchronous operation was pending.",
  );
}

function wipePreviewAssets(delivery) {
  for (const asset of delivery?.assets ?? []) {
    if (asset?.data instanceof Uint8Array) asset.data.fill(0);
  }
}

function addListener(target, type, listener) {
  if (typeof target.addEventListener === "function") {
    target.addEventListener(type, listener);
    return () => target.removeEventListener?.(type, listener);
  }
  const property = `on${type}`;
  const previous = target[property];
  target[property] = listener;
  return () => {
    if (target[property] === listener) target[property] = previous ?? null;
  };
}

function withTimeout(promise, timeoutMs, code, message) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 24 * 60 * 60 * 1000
  ) {
    throw new TypeError("A timeout must be an integer from 100 ms to 24 hours.");
  }
  const deadline = createDeadline(timeoutMs, code, message);
  return deadline.race(promise).finally(() => deadline.clear());
}

async function yieldTransferLoop(options) {
  if (typeof options.yieldControl === "function") {
    await options.yieldControl();
    return;
  }
  if (typeof globalThis.scheduler?.yield === "function") {
    await globalThis.scheduler.yield();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function assertNoMedia(connection) {
  const transceivers = connection.getTransceivers?.() ?? [];
  const senders = connection.getSenders?.() ?? [];
  const receivers = connection.getReceivers?.() ?? [];
  if (
    transceivers.length > 0 ||
    senders.some((value) => value.track) ||
    receivers.some((value) => value.track)
  ) {
    connection.close?.();
    throw new OabError(
      "media_transport_forbidden",
      "detached-datachannel/1 forbids audio, video, and media transceivers.",
    );
  }
}

async function applyRemoteCandidates(
  connection,
  candidates,
  afterAwait = () => {},
  awaitOperation = (value) => value,
) {
  for (const candidate of candidates) {
    try {
      await awaitOperation(connection.addIceCandidate(candidate));
      afterAwait();
    } catch (error) {
      throw new OabError(
        "detached_candidate_rejected",
        "A validated host candidate was rejected by the peer connection.",
        { cause: error },
      );
    }
  }
}

function waitForOpenChannel(channel, timeoutMs) {
  assertReliableOrderedChannel(channel);
  if (channel.readyState === "open") return Promise.resolve(channel);
  const ready = deferred();
  const removeOpen = addListener(channel, "open", () => ready.resolve(channel));
  const removeClose = addListener(channel, "close", () => ready.reject(
    new OabError(
      "detached_channel_closed",
      "The detached data channel closed before opening.",
    ),
  ));
  const removeError = addListener(channel, "error", () => ready.reject(
    new OabError(
      "detached_channel_error",
      "The detached data channel failed before opening.",
    ),
  ));
  return withTimeout(
    ready.promise,
    timeoutMs,
    "detached_channel_timeout",
    "The detached data channel did not open before its deadline.",
  ).finally(() => {
    removeOpen();
    removeClose();
    removeError();
  });
}

function listenForIncomingChannel(connection) {
  const channelReady = deferred();
  channelReady.promise.catch(() => {});
  const violation = deferred();
  violation.promise.catch(() => {});
  let accepted = false;
  let closed = false;
  const fail = (error) => {
    if (closed) return;
    if (!accepted) {
      accepted = true;
      channelReady.reject(error);
    }
    violation.reject(error);
  };
  const remove = addListener(connection, "datachannel", (event) => {
    const candidate = event?.channel;
    try {
      if (accepted) {
        candidate?.close?.();
        fail(new OabError(
          "unexpected_detached_channel",
          "A peer attempted to create more than the single OAB data channel.",
        ));
        return;
      }
      const channel = assertReliableOrderedChannel(candidate);
      if (channel.label !== DETACHED_CHANNEL_LABEL) {
        throw new OabError(
          "unexpected_detached_channel",
          "The offered data channel does not use the exact OAB channel label.",
        );
      }
      accepted = true;
      channelReady.resolve(channel);
    } catch (error) {
      candidate?.close?.();
      fail(error);
    }
  });
  return Object.freeze({
    promise: channelReady.promise,
    violation: violation.promise,
    cancel(error = new OabError(
      "detached_channel_closed",
      "The detached receiver stopped waiting for a data channel.",
    )) {
      if (closed) return;
      closed = true;
      remove();
      if (!accepted) {
        accepted = true;
        channelReady.reject(error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      remove();
    },
  });
}

function createControlInbox(channel, initialMaximumFrameBytes) {
  const phases = [
    Object.freeze({ name: "capabilities", allowed: ["capabilities", "abort"] }),
    Object.freeze({ name: "grant", allowed: ["grant", "abort"] }),
    Object.freeze({ name: "previewing", allowed: ["previewing", "abort"] }),
    Object.freeze({ name: "result", allowed: ["result", "abort"] }),
  ];
  let phaseIndex = 0;
  let armed = true;
  let buffered = null;
  let waiter = null;
  let terminalError = null;
  let maximumFrameBytes = initialMaximumFrameBytes;
  const failWith = (error) => {
    terminalError ??= asOabError(error, "unexpected_detached_frame");
    waiter?.reject(terminalError);
    waiter = null;
    buffered = null;
    channel.close?.();
  };
  const listener = (event) => {
    let frame;
    try {
      frame = decodeDetachedFrame(event.data, { maximumFrameBytes });
      if (frame.typeName === "data" || frame.typeName === "manifest" || frame.typeName === "complete") {
        throw new OabError(
          "unexpected_detached_frame",
          "The receiver sent a sender-only frame type.",
        );
      }
      const phase = phases[phaseIndex];
      if (
        !phase ||
        !armed ||
        !phase.allowed.includes(frame.typeName)
      ) {
        throw new OabError(
          "unexpected_detached_frame",
          "The receiver sent a control frame outside the exact protocol state.",
        );
      }
    } catch (error) {
      failWith(asOabError(error, "invalid_detached_frame"));
      return;
    }
    armed = false;
    if (waiter) {
      const current = waiter;
      waiter = null;
      phaseIndex += 1;
      current.resolve(frame);
    } else if (buffered == null) {
      // Capabilities may arrive immediately after channel open. No later phase
      // is armed until the sender explicitly reaches it.
      buffered = frame;
    } else {
      failWith(new OabError(
        "unexpected_detached_frame",
        "The receiver sent more than one control frame for a protocol state.",
      ));
    }
  };
  const removeMessage = addListener(channel, "message", listener);
  const fail = () => {
    terminalError ??= new OabError(
      "detached_channel_closed",
      "The detached data channel closed before the expected response.",
    );
    waiter?.reject(terminalError);
    waiter = null;
  };
  const removeClose = addListener(channel, "close", fail);
  const removeError = addListener(channel, "error", fail);
  return Object.freeze({
    setMaximumFrameBytes(value) {
      maximumFrameBytes = value;
      if (
        buffered &&
        DETACHED_FRAME_HEADER_BYTES + buffered.payload.byteLength > value
      ) {
        terminalError = new OabError(
          "invalid_detached_frame",
          "A buffered control frame exceeds the negotiated frame limit.",
        );
        buffered = null;
        waiter?.reject(terminalError);
        waiter = null;
        channel.close?.();
      }
    },
    waitFor(name, timeoutMs) {
      if (terminalError) return Promise.reject(terminalError);
      const phase = phases[phaseIndex];
      if (!phase || phase.name !== name || waiter) {
        return Promise.reject(new OabError(
          "invalid_detached_state",
          "The sender attempted to wait for a control frame out of order.",
        ));
      }
      if (buffered) {
        const frame = buffered;
        buffered = null;
        phaseIndex += 1;
        return Promise.resolve(frame);
      }
      armed = true;
      const entry = deferred();
      waiter = entry;
      return withTimeout(
        entry.promise,
        timeoutMs,
        "detached_response_timeout",
        "The detached receiver did not respond before its deadline.",
      ).finally(() => {
        if (waiter === entry) {
          waiter = null;
          armed = false;
        }
      });
    },
    close() {
      removeMessage();
      removeClose();
      removeError();
      fail();
    },
  });
}

export async function createDetachedSenderSession(options = {}) {
  const expectedReceiverCapabilities = validateDetachedCapabilities(
    options.expectedReceiverCapabilities,
  );
  const senderOrigin = canonicalOrigin(options.senderOrigin);
  const receiverOrigin = canonicalOrigin(options.receiverOrigin);
  let requestId = secureToken(options, "requestId");
  let channelId = secureChannelCapability(options, "channelId");
  const createdAt = now(options);
  const lifetimeMs = options.lifetimeMs ?? 2 * 60 * 1000;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1000 ||
    lifetimeMs > DETACHED_SIGNAL_LIMITS.maximumLifetimeMs
  ) {
    throw new TypeError("lifetimeMs must be from 1000 to 300000 ms.");
  }
  const rtcSetupTimeoutMs = boundedTimeout(
    options.channelTimeoutMs,
    DEFAULT_RTC_SETUP_MS,
    MAXIMUM_RTC_SETUP_MS,
    "channelTimeoutMs",
  );
  const connectedToPreviewTimeoutMs = boundedTimeout(
    options.connectedToPreviewTimeoutMs,
    MAXIMUM_CONNECTED_TO_PREVIEW_MS,
    MAXIMUM_CONNECTED_TO_PREVIEW_MS,
    "connectedToPreviewTimeoutMs",
  );
  let senderPrivateKey = null;
  let senderPublicKey;
  let connection = null;
  let channel = null;
  const offerSetupTimeoutMs = Math.min(rtcSetupTimeoutMs, lifetimeMs);
  const setupDeadline = createDeadline(
    offerSetupTimeoutMs,
    offerSetupTimeoutMs < rtcSetupTimeoutMs
      ? "detached_offer_expired"
      : "detached_setup_timeout",
    offerSetupTimeoutMs < rtcSetupTimeoutMs
      ? "The detached offer expired during RTC offer setup."
      : "Detached RTC offer setup did not complete before its global deadline.",
    () => {
      senderPrivateKey = null;
      channel?.close?.();
      connection?.close?.();
    },
  );
  try {
    const keyPair = await setupDeadline.race(createDetachedKeyPair(options));
    senderPrivateKey = keyPair.privateKey;
    senderPublicKey = keyPair.publicKey;
    connection = createHostOnlyPeerConnection(options);
    channel = connection.createDataChannel(DETACHED_CHANNEL_LABEL, {
      ordered: true,
    });
    assertReliableOrderedChannel(channel);
    assertNoMedia(connection);
    const descriptionValue = await setupDeadline.race(connection.createOffer());
    const description = assertDataOnlySdp(
      { type: descriptionValue.type, sdp: descriptionValue.sdp },
      { type: "offer" },
    );
    const candidatesPromise = collectHostCandidates(connection, {
      ...options,
      signal: setupDeadline.signal,
    });
    await setupDeadline.race(connection.setLocalDescription(description));
    const candidates = await setupDeadline.race(candidatesPromise);
    assertNoMedia(connection);
    let offer = validateDetachedOffer({
      protocol: DETACHED_PROTOCOL,
      wireVersion: options.wireVersion ?? DETACHED_WIRE_VERSION,
      transport: DETACHED_TRANSPORT,
      transportVersion: DETACHED_TRANSPORT_VERSION,
      requestId,
      channelId,
      createdAt,
      expiresAt: createdAt + lifetimeMs,
      senderOrigin,
      receiverOrigin,
      receiverHelper: options.receiverHelper,
      declarationId: options.declarationId ?? null,
      senderPublicKey,
      description,
      candidates,
    }, { ...options, now: () => createdAt });
    let transcript = await setupDeadline.race(createDetachedTranscript(offer, {
      ...options,
      now: () => createdAt,
    }));
    let launchHref = await setupDeadline.race(createDetachedOfferLaunchUrl(
      options.receiverEndpoint,
      offer,
      { ...options, now: () => createdAt },
    ));
    setupDeadline.clear();

    let state = "offered";
    let generation = 0;
    let controlInbox = null;
    let offerExpiryTimer = null;
    let connectionDeadline = null;
    let previewDeadline = null;
    let removeUnexpectedChannelGuard = () => {};
    const invalidated = deferred();
    invalidated.promise.catch(() => {});
    const releasePrivateKey = () => {
      senderPrivateKey = null;
    };
    const clearOfferExpiry = () => {
      if (offerExpiryTimer != null) clearTimeout(offerExpiryTimer);
      offerExpiryTimer = null;
    };
    const closeResources = () => {
      clearOfferExpiry();
      connectionDeadline?.clear();
      connectionDeadline = null;
      previewDeadline?.clear();
      previewDeadline = null;
      releasePrivateKey();
      const inbox = controlInbox;
      controlInbox = null;
      inbox?.close();
      removeUnexpectedChannelGuard();
      removeUnexpectedChannelGuard = () => {};
      channel?.close?.();
      connection?.close?.();
      channel = null;
      connection = null;
      senderPublicKey = null;
      offer = null;
      transcript = null;
      launchHref = null;
      requestId = null;
      channelId = null;
    };
    const terminate = (nextState, error = invalidatedSessionError(nextState)) => {
      if (TERMINAL_STATES.has(state)) return false;
      generation += 1;
      state = nextState;
      invalidated.reject(error);
      closeResources();
      return true;
    };
    const assertCurrent = (snapshot, allowedStates) => {
      if (generation !== snapshot || !allowedStates.includes(state)) {
        throw invalidatedSessionError(state);
      }
      if (state === "connecting" && now(options) >= offer.expiresAt) {
        const error = new OabError(
          "detached_offer_expired",
          "The detached offer expired before channel connection.",
        );
        terminate("expired", error);
        throw error;
      }
    };
    const raceInvalidation = (value) => Promise.race([
      Promise.resolve(value),
      invalidated.promise,
    ]);
    removeUnexpectedChannelGuard = addListener(
      connection,
      "datachannel",
      (event) => {
        event?.channel?.close?.();
        terminate("failed", new OabError(
          "unexpected_detached_channel",
          "The receiver attempted to create an unexpected data channel.",
        ));
      },
    );
    const remainingOfferLifetime = Math.max(0, offer.expiresAt - now(options));
    offerExpiryTimer = setTimeout(() => {
      if (!["offered", "connecting"].includes(state)) return;
      terminate("expired", new OabError(
        "detached_offer_expired",
        "The detached offer expired before channel connection.",
      ));
    }, remainingOfferLifetime);
    offerExpiryTimer.unref?.();

    return Object.freeze({
      get requestId() { return requestId; },
      get channelId() { return channelId; },
      get offer() { return offer; },
      get transcript() { return transcript; },
      get launchHref() { return launchHref; },
      target: "_blank",
      rel: "noopener noreferrer",
      referrerPolicy: "no-referrer",
      get connection() { return connection; },
      get channel() { return channel; },
      get state() { return state; },
      async acceptSealedAnswer(envelope) {
        if (state !== "offered") {
          throw new OabError(
            "invalid_detached_state",
            "The detached answer can be accepted exactly once.",
          );
        }
        if (now(options) >= offer.expiresAt) {
          const error = new OabError(
            "detached_offer_expired",
            "The detached answer arrived after the offer expired.",
          );
          terminate("expired", error);
          throw error;
        }
        state = "connecting";
        const operationGeneration = generation;
        const remainingOfferLifetimeMs = Math.max(
          1,
          offer.expiresAt - now(options),
        );
        const connectionTimeoutMs = Math.min(
          rtcSetupTimeoutMs,
          remainingOfferLifetimeMs,
        );
        connectionDeadline = createDeadline(
          connectionTimeoutMs,
          connectionTimeoutMs < rtcSetupTimeoutMs
            ? "detached_offer_expired"
            : "detached_channel_timeout",
          connectionTimeoutMs < rtcSetupTimeoutMs
            ? "The detached offer expired before RTC connection completed."
            : "Detached RTC connection did not complete before its global deadline.",
          (error) => terminate(
            connectionTimeoutMs < rtcSetupTimeoutMs ? "expired" : "failed",
            error,
          ),
        );
        const activeConnectionDeadline = connectionDeadline;
        const awaitConnection = (value) => activeConnectionDeadline.race(
          raceInvalidation(value),
        );
        try {
          if (!senderPrivateKey) {
            throw new OabError(
              "detached_offer_expired",
              "The detached offer expired before answer authentication.",
            );
          }
          const answerValue = await awaitConnection(openDetachedAnswer(envelope, {
            ...options,
            transcript,
            senderPrivateKey,
          }));
          assertCurrent(operationGeneration, ["connecting"]);
          // The private ECDH key is single-use. Release the last application
          // reference immediately after authenticating the answer.
          releasePrivateKey();
          const answer = validateDetachedAnswer(answerValue, options);
          await awaitConnection(connection.setRemoteDescription(answer.description));
          assertCurrent(operationGeneration, ["connecting"]);
          assertNoMedia(connection);
          await applyRemoteCandidates(
            connection,
            answer.candidates,
            () => assertCurrent(operationGeneration, ["connecting"]),
            awaitConnection,
          );
          assertCurrent(operationGeneration, ["connecting"]);
          await awaitConnection(waitForOpenChannel(channel, rtcSetupTimeoutMs));
          assertCurrent(operationGeneration, ["connecting"]);
          controlInbox = createControlInbox(
            channel,
            expectedReceiverCapabilities.maximumFrameBytes,
          );
          state = "connected";
          clearOfferExpiry();
          connectionDeadline.clear();
          connectionDeadline = null;
          previewDeadline = createDeadline(
            connectedToPreviewTimeoutMs,
            "detached_transfer_timeout",
            "The detached transfer did not reach preview before its hard deadline.",
            (error) => terminate("failed", error),
          );
          return channel;
        } catch (error) {
          if (!TERMINAL_STATES.has(state)) terminate("failed", error);
          throw error;
        }
      },
      async sendTransfer(preparedTransfer, transferOptions = {}) {
        if (state !== "connected" || !controlInbox || !previewDeadline) {
          throw new OabError(
            "invalid_detached_state",
            "Connect the detached channel before transferring content.",
          );
        }
        const dispositionTimeoutMs = boundedTimeout(
          transferOptions.dispositionTimeoutMs,
          DEFAULT_DISPOSITION_MS,
          MAXIMUM_DISPOSITION_MS,
          "dispositionTimeoutMs",
        );
        state = "transferring";
        const operationGeneration = generation;
        let activeFrameOptions = { ...transferOptions };
        let transferTerminated = false;
        const activePreviewDeadline = previewDeadline;
        const awaitPreview = (value) => activePreviewDeadline.race(
          raceInvalidation(value),
        );
        const terminateTransfer = (error) => {
          if (!transferTerminated) {
            transferTerminated = true;
            if (!TERMINAL_STATES.has(state) && channel.readyState === "open") {
              sendDetachedFrame(
                channel,
                encodeDetachedControl("abort", {
                  reason: normalizeWireAbortReason(asOabError(error).code),
                }),
                activeFrameOptions,
              ).catch(() => {});
            }
            if (!TERMINAL_STATES.has(state)) terminate("failed", error);
          }
          throw error;
        };
        try {
          const responseTimeoutMs = boundedTimeout(
            transferOptions.responseTimeoutMs,
            MAXIMUM_CONTROL_RESPONSE_MS,
            MAXIMUM_CONTROL_RESPONSE_MS,
            "responseTimeoutMs",
          );
          const capabilitiesFrame = await awaitPreview(controlInbox.waitFor(
            "capabilities",
            responseTimeoutMs,
          ));
          assertCurrent(operationGeneration, ["transferring"]);
          if (capabilitiesFrame.typeName === "abort") {
            validateRemoteAbort(capabilitiesFrame);
            throw new OabError(
              "detached_transfer_rejected",
              "The receiver did not authorize a detached transfer.",
            );
          }
          const capabilities = assertCapabilitiesWithinDiscovery(
            capabilitiesFrame.control,
            expectedReceiverCapabilities,
          );
          controlInbox.setMaximumFrameBytes(capabilities.maximumFrameBytes);
          if (typeof preparedTransfer.forMaximumFrameBytes !== "function") {
            throw new OabError(
              "invalid_detached_transfer",
              "Prepare the transfer with negotiated-frame support.",
            );
          }
          const transfer = await awaitPreview(
            preparedTransfer.forMaximumFrameBytes(capabilities.maximumFrameBytes),
          );
          assertCurrent(operationGeneration, ["transferring"]);
          assertManifestMatchesCapabilities(transfer.manifest, capabilities);
          const transferId = transfer.manifest.transferId;
          const frameOptions = {
            ...transferOptions,
            maximumFrameBytes: capabilities.maximumFrameBytes,
          };
          activeFrameOptions = frameOptions;
          const grantPromise = controlInbox.waitFor("grant", responseTimeoutMs);
          grantPromise.catch(() => {});
          await awaitPreview(sendDetachedFrame(
            channel,
            transfer.manifestFrame,
            frameOptions,
          ));
          assertCurrent(operationGeneration, ["transferring"]);
          const grant = await awaitPreview(grantPromise);
          assertCurrent(operationGeneration, ["transferring"]);
          if (grant.typeName === "abort") {
            validateRemoteAbort(grant);
            throw new OabError(
              "detached_transfer_rejected",
              "The receiver rejected the detached transfer.",
            );
          }
          if (
            !exactKeys(grant.control, ["transferId", "manifestDigest"]) ||
            grant.control?.transferId !== transferId ||
            grant.control?.manifestDigest !== transfer.manifestDigest
          ) {
            throw new OabError(
              "detached_grant_mismatch",
              "The receiver grant does not match the transfer manifest.",
            );
          }
          let sentFrames = 0;
          const yieldEveryFrames = transferOptions.yieldEveryFrames ?? 32;
          if (
            !Number.isSafeInteger(yieldEveryFrames) ||
            yieldEveryFrames < 1 ||
            yieldEveryFrames > 1024
          ) {
            throw new TypeError(
              "yieldEveryFrames must be an integer from 1 to 1024.",
            );
          }
          const frames = transfer.dataFrames();
          const iterator = frames[Symbol.asyncIterator]?.() ??
            frames[Symbol.iterator]?.();
          if (!iterator) {
            throw new OabError(
              "invalid_detached_transfer",
              "Transfer dataFrames() must return an iterable.",
            );
          }
          while (true) {
            const entry = await awaitPreview(iterator.next());
            assertCurrent(operationGeneration, ["transferring"]);
            if (entry.done) break;
            await awaitPreview(sendDetachedFrame(channel, entry.value, frameOptions));
            assertCurrent(operationGeneration, ["transferring"]);
            sentFrames += 1;
            transferOptions.onProgress?.({
              sentFrames,
              totalFrames: transfer.totalFrames,
            });
            if (
              sentFrames < transfer.totalFrames &&
              sentFrames % yieldEveryFrames === 0
            ) {
              await awaitPreview(yieldTransferLoop(transferOptions));
              assertCurrent(operationGeneration, ["transferring"]);
            }
          }
          const previewingPromise = controlInbox.waitFor(
            "previewing",
            responseTimeoutMs,
          );
          previewingPromise.catch(() => {});
          await awaitPreview(sendDetachedFrame(
            channel,
            transfer.completionFrame,
            frameOptions,
          ));
          assertCurrent(operationGeneration, ["transferring"]);
          const previewing = await awaitPreview(previewingPromise);
          assertCurrent(operationGeneration, ["transferring"]);
          if (previewing.typeName === "abort") {
            validateRemoteAbort(previewing);
            throw new OabError(
              "detached_transfer_failed",
              "The receiver rejected the completed transfer.",
            );
          }
          if (
            !exactKeys(previewing.control, ["transferId", "status"]) ||
            previewing.control?.transferId !== transferId ||
            previewing.control?.status !== "previewing"
          ) {
            throw new OabError(
              "detached_result_mismatch",
              "The receiver did not acknowledge the previewing state.",
            );
          }
          state = "previewing";
          previewDeadline.clear();
          previewDeadline = null;
          const completion = (async () => {
            try {
              const result = await raceInvalidation(controlInbox.waitFor(
                "result",
                dispositionTimeoutMs,
              ));
              assertCurrent(operationGeneration, ["previewing"]);
              if (result.typeName === "abort") {
                validateRemoteAbort(result);
                throw new OabError(
                  "detached_transfer_failed",
                  "The receiver aborted the transfer while previewing.",
                );
              }
              const disposition = result.control?.disposition;
              if (
                !exactKeys(result.control, ["transferId", "disposition"]) ||
                result.control?.transferId !== transferId ||
                !["preserved", "discarded"].includes(disposition)
              ) {
                throw new OabError(
                  "detached_result_mismatch",
                  "The final receiver disposition is invalid.",
                );
              }
              terminate(disposition);
              return disposition;
            } catch (error) {
              return terminateTransfer(error);
            }
          })();
          completion.catch(() => {});
          return Object.freeze({
            transferId,
            status: "previewing",
            capabilities,
            completion,
          });
        } catch (error) {
          return terminateTransfer(error);
        } finally {
          try {
            preparedTransfer?.dispose?.();
          } catch (_) {
            // Disposal is synchronous and idempotent for SDK-created
            // transfers. A foreign implementation must not mask the
            // protocol outcome if its optional cleanup hook is broken.
          }
        }
      },
      close() {
        if (!TERMINAL_STATES.has(state)) terminate("closed");
        else closeResources();
      },
    });
  } catch (error) {
    setupDeadline.abort(error);
    senderPrivateKey = null;
    channel?.close?.();
    connection?.close?.();
    throw error;
  }
}

export async function acceptDetachedOffer(offerValue, options = {}) {
  if (options.verificationAuthorized !== true) {
    throw new OabError(
      "detached_verification_authorization_required",
      "Explicit user authorization is required before creating WebRTC verification state.",
    );
  }
  const receiverOrigin = canonicalOrigin(options.receiverOrigin);
  let offer = validateDetachedOffer(offerValue, {
    ...options,
    expectedReceiverOrigin: receiverOrigin,
  });
  const rtcSetupTimeoutMs = boundedTimeout(
    options.channelTimeoutMs,
    DEFAULT_RTC_SETUP_MS,
    MAXIMUM_RTC_SETUP_MS,
    "channelTimeoutMs",
  );
  const connectedToPreviewTimeoutMs = boundedTimeout(
    options.transferTimeoutMs,
    DEFAULT_RECEIVER_CONNECTED_TO_PREVIEW_MS,
    MAXIMUM_CONNECTED_TO_PREVIEW_MS,
    "transferTimeoutMs",
  );
  let state = "setting-up";
  let generation = 0;
  let connection = null;
  let incomingChannel = null;
  let channel = null;
  let setupDeadline = null;
  let previewDeadline = null;
  let activeTransfer = null;
  let removeExternalAbort = () => {};
  let requestId = offer.requestId;
  let channelId = offer.channelId;
  let transcript = null;
  let sealedAnswer = null;
  let connected = null;
  const invalidated = deferred();
  invalidated.promise.catch(() => {});
  const closeResources = (terminalError = new OabError(
    "detached_channel_closed",
    "The detached receiver session ended before channel setup completed.",
  )) => {
    setupDeadline?.abort(terminalError);
    setupDeadline = null;
    previewDeadline?.clear();
    previewDeadline = null;
    activeTransfer?.abort?.("receiver_session_closed").catch?.(() => {});
    activeTransfer = null;
    removeExternalAbort();
    removeExternalAbort = () => {};
    // `close()` only detaches the listener. If no channel arrived, the
    // externally observable `connected` promise would remain pending forever
    // and retain the complete session graph. `cancel()` also rejects that
    // waiter, while remaining harmless after a channel was accepted.
    incomingChannel?.cancel(terminalError);
    channel?.close?.();
    connection?.close?.();
    incomingChannel = null;
    channel = null;
    connection = null;
    offer = null;
    transcript = null;
    sealedAnswer = null;
    connected = null;
    requestId = null;
    channelId = null;
  };
  const terminate = (nextState, error = invalidatedSessionError(nextState)) => {
    if (TERMINAL_STATES.has(state)) return false;
    generation += 1;
    state = nextState;
    invalidated.reject(error);
    closeResources(error);
    return true;
  };
  const assertCurrent = (snapshot, allowedStates) => {
    if (generation !== snapshot || !allowedStates.includes(state)) {
      throw invalidatedSessionError(state);
    }
    if (
      ["setting-up", "answer-ready"].includes(state) &&
      now(options) >= offer.expiresAt
    ) {
      const error = new OabError(
        "detached_offer_expired",
        "The detached offer expired before channel connection.",
      );
      terminate("expired", error);
      throw error;
    }
  };
  const raceInvalidation = (value) => Promise.race([
    Promise.resolve(value),
    invalidated.promise,
  ]);
  const remainingOfferLifetimeMs = Math.max(1, offer.expiresAt - now(options));
  const setupAndConnectionTimeoutMs = Math.min(
    rtcSetupTimeoutMs,
    remainingOfferLifetimeMs,
  );
  setupDeadline = createDeadline(
    setupAndConnectionTimeoutMs,
    setupAndConnectionTimeoutMs < rtcSetupTimeoutMs
      ? "detached_offer_expired"
      : "detached_channel_timeout",
    setupAndConnectionTimeoutMs < rtcSetupTimeoutMs
      ? "The detached offer expired before RTC connection completed."
      : "Detached RTC setup and connection did not complete before its global deadline.",
    (error) => terminate(
      setupAndConnectionTimeoutMs < rtcSetupTimeoutMs ? "expired" : "failed",
      error,
    ),
  );
  const externalSignal = options.signal;
  if (externalSignal) {
    const abortFromHost = () => {
      const error = externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new OabError(
          "detached_receiver_aborted",
          "The receiver host cancelled detached channel setup.",
        );
      terminate("closed", error);
    };
    externalSignal.addEventListener("abort", abortFromHost, { once: true });
    removeExternalAbort = () =>
      externalSignal.removeEventListener("abort", abortFromHost);
    if (externalSignal.aborted) {
      abortFromHost();
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : invalidatedSessionError("closed");
    }
  }
  const setupGeneration = generation;
  try {
    const activeSetupDeadline = setupDeadline;
    const awaitSetup = (value) => activeSetupDeadline.race(
      raceInvalidation(value),
    );
    transcript = await awaitSetup(createDetachedTranscript(offer, options));
    assertCurrent(setupGeneration, ["setting-up"]);
    connection = createHostOnlyPeerConnection(options);
    incomingChannel = listenForIncomingChannel(connection);
    await awaitSetup(connection.setRemoteDescription(offer.description));
    assertCurrent(setupGeneration, ["setting-up"]);
    assertNoMedia(connection);
    await applyRemoteCandidates(
      connection,
      offer.candidates,
      () => assertCurrent(setupGeneration, ["setting-up"]),
      awaitSetup,
    );
    assertCurrent(setupGeneration, ["setting-up"]);
    const answerValue = await awaitSetup(connection.createAnswer());
    assertCurrent(setupGeneration, ["setting-up"]);
    const description = assertDataOnlySdp(
      { type: answerValue.type, sdp: answerValue.sdp },
      { type: "answer" },
    );
    const candidatesPromise = collectHostCandidates(connection, {
      ...options,
      signal: setupDeadline.signal,
    });
    await awaitSetup(connection.setLocalDescription(description));
    assertCurrent(setupGeneration, ["setting-up"]);
    const candidates = await awaitSetup(candidatesPromise);
    assertCurrent(setupGeneration, ["setting-up"]);
    assertNoMedia(connection);
    const answer = validateDetachedAnswer({
      description,
      candidates,
    }, options);
    sealedAnswer = await awaitSetup(sealDetachedAnswer(answer, {
      ...options,
      senderPublicKey: offer.senderPublicKey,
      transcript,
    }));
    assertCurrent(setupGeneration, ["setting-up"]);
    state = "answer-ready";
    connected = (async () => {
      try {
        const incoming = await awaitSetup(incomingChannel.promise);
        assertCurrent(setupGeneration, ["answer-ready"]);
        channel = incoming;
        await awaitSetup(waitForOpenChannel(channel, rtcSetupTimeoutMs));
        assertCurrent(setupGeneration, ["answer-ready"]);
        state = "connected";
        setupDeadline.clear();
        setupDeadline = null;
        previewDeadline = createDeadline(
          connectedToPreviewTimeoutMs,
          "detached_transfer_timeout",
          "The detached transfer did not reach preview before its deadline.",
          (error) => terminate("failed", error),
        );
        return channel;
      } catch (error) {
        if (!TERMINAL_STATES.has(state)) terminate("failed", error);
        throw error;
      }
    })();
    connected.catch(() => {});
    incomingChannel.violation.catch((error) => {
      if (!TERMINAL_STATES.has(state)) terminate("failed", error);
    });
    return Object.freeze({
      get requestId() { return requestId; },
      get channelId() { return channelId; },
      get offer() { return offer; },
      get transcript() { return transcript; },
      get sealedAnswer() { return sealedAnswer; },
      get connection() { return connection; },
      get channel() { return channel; },
      get connected() { return connected; },
      get state() { return state; },
      receiveTransfer(receiveOptions = {}) {
        if (state !== "connected" || !channel) {
          throw new OabError(
            "invalid_detached_state",
            "Await connected before starting the single detached transfer.",
          );
        }
        const transferGeneration = generation;
        const handle = receiveDetachedTransfer(channel, {
          ...options,
          ...receiveOptions,
          requestId: offer.requestId,
          channelId: offer.channelId,
          sessionExpiresAt:
            offer.createdAt + DETACHED_LIFECYCLE_LIMITS.maximumSessionLifetimeMs,
          sourceOrigin: offer.senderOrigin,
        });
        state = "receiving";
        activeTransfer = handle;
        handle.preview.then(() => {
          if (generation !== transferGeneration || state !== "receiving") return;
          state = "previewing";
          previewDeadline?.clear();
          previewDeadline = null;
        }).catch((error) => {
          if (generation === transferGeneration && !TERMINAL_STATES.has(state)) {
            terminate("failed", error);
          }
        });
        handle.completion.then((disposition) => {
          if (generation === transferGeneration && !TERMINAL_STATES.has(state)) {
            activeTransfer = null;
            terminate(disposition);
          }
        }).catch((error) => {
          if (generation === transferGeneration && !TERMINAL_STATES.has(state)) {
            activeTransfer = null;
            terminate("failed", error);
          }
        });
        return handle;
      },
      close() {
        if (!TERMINAL_STATES.has(state)) terminate("closed");
        else closeResources();
      },
    });
  } catch (error) {
    if (!TERMINAL_STATES.has(state)) terminate("failed", error);
    incomingChannel?.cancel(error);
    channel?.close?.();
    connection?.close?.();
    throw error;
  }
}

export function receiveDetachedTransfer(channelValue, options = {}) {
  let channel = assertReliableOrderedChannel(channelValue);
  const capabilities = validateDetachedCapabilities(options.capabilities);
  let requestId = token(options.requestId, "requestId");
  let channelId = channelCapability(options.channelId, "channelId");
  let preserveTransactionId = secureToken(options, "preserveTransactionId");
  const maximumAggregateTransferBytes = options.maximumAggregateTransferBytes ??
    DEFAULT_LIMITS.maximumAggregateTransferBytes;
  if (
    !Number.isSafeInteger(maximumAggregateTransferBytes) ||
    maximumAggregateTransferBytes < capabilities.maximumTransferBytes ||
    maximumAggregateTransferBytes >
      DETACHED_RESOURCE_LIMITS.maximumAggregateTransferBytes
  ) {
    throw new TypeError(
      `maximumAggregateTransferBytes must be an integer from the live transfer maximum through ${DETACHED_RESOURCE_LIMITS.maximumAggregateTransferBytes}.`,
    );
  }
  const transferTimeoutMs = boundedTimeout(
    options.transferTimeoutMs,
    DEFAULT_RECEIVER_CONNECTED_TO_PREVIEW_MS,
    MAXIMUM_CONNECTED_TO_PREVIEW_MS,
    "transferTimeoutMs",
  );
  const dispositionTimeoutMs = boundedTimeout(
    options.dispositionTimeoutMs,
    DEFAULT_DISPOSITION_MS,
    MAXIMUM_DISPOSITION_MS,
    "dispositionTimeoutMs",
  );
  const maximumFramesPerSecond = boundedRate(
    options.maximumFramesPerSecond,
    DEFAULT_MAXIMUM_FRAMES_PER_SECOND,
    HARD_MAXIMUM_FRAMES_PER_SECOND,
    "maximumFramesPerSecond",
  );
  const maximumBytesPerSecond = boundedRate(
    options.maximumBytesPerSecond,
    DEFAULT_MAXIMUM_BYTES_PER_SECOND,
    HARD_MAXIMUM_BYTES_PER_SECOND,
    "maximumBytesPerSecond",
  );
  const preserveSettlementTimeoutMs = boundedTimeout(
    options.preserveSettlementTimeoutMs,
    DEFAULT_PRESERVE_SETTLEMENT_MS,
    MAXIMUM_PRESERVE_SETTLEMENT_MS,
    "preserveSettlementTimeoutMs",
  );
  let frameTokens = maximumFramesPerSecond;
  let byteTokens = maximumBytesPerSecond;
  let lastRateTime = rateTime(options);
  const consumeInboundRate = (value) => {
    const currentRateTime = rateTime(options);
    const elapsedMs = Math.max(0, currentRateTime - lastRateTime);
    lastRateTime = Math.max(lastRateTime, currentRateTime);
    frameTokens = Math.min(
      maximumFramesPerSecond,
      frameTokens + elapsedMs * maximumFramesPerSecond / 1000,
    );
    byteTokens = Math.min(
      maximumBytesPerSecond,
      byteTokens + elapsedMs * maximumBytesPerSecond / 1000,
    );
    const byteLength = messageByteLength(value);
    if (frameTokens < 1 || byteTokens < byteLength) return false;
    frameTokens -= 1;
    byteTokens -= byteLength;
    return true;
  };
  let frameOptions = {
    ...options,
    maximumFrameBytes: capabilities.maximumFrameBytes,
  };
  let receiver = new DetachedFrameReceiver(frameOptions);
  const previewReady = deferred();
  const dispositionReady = deferred();
  let terminal = false;
  let generation = 0;
  let state = "authorizing-sender";
  let previewDelivery = null;
  let previewSettled = false;
  let queue = Promise.resolve();
  const queuedFrames = new Set();
  let previewTimer = null;
  let dispositionTimer = null;
  let preserveController = null;
  let preserveOperation = null;
  let preserveTerminalRequest = null;
  let byteReservation = null;
  let terminalCleanup = Promise.resolve();
  const previewDeadlineAt = deadlineTime() + transferTimeoutMs;
  let dispositionDeadlineAt = null;
  let dispositionExpiresAt = null;
  let removeMessage = () => {};
  let removeClose = () => {};
  let removeError = () => {};
  let cleanupErrorCallback = options.onCleanupError;
  const reportCleanupError = (operation, error) => {
    try {
      cleanupErrorCallback?.(Object.freeze({ operation, error }));
    } catch (_) {}
  };
  const invalidated = deferred();
  invalidated.promise.catch(() => {});
  let hostCallbacks = new AbortController();
  let callbackContext = Object.freeze({ signal: hostCallbacks.signal });
  const clearPhaseTimers = () => {
    if (previewTimer != null) clearTimeout(previewTimer);
    if (dispositionTimer != null) clearTimeout(dispositionTimer);
    previewTimer = null;
    dispositionTimer = null;
  };
  const releasePreview = (wipe) => {
    if (wipe) wipePreviewAssets(previewDelivery);
    previewDelivery = null;
  };
  const releaseByteReservation = () => {
    const reservation = byteReservation;
    byteReservation = null;
    if (!reservation) return Promise.resolve();
    return Promise.resolve().then(() => reservation.release()).catch((error) => {
      reportCleanupError("byte-reservation-release", error);
    });
  };
  const finish = (
    callback,
    { error = invalidatedSessionError(state), wipe = false, close = true } = {},
  ) => {
    if (terminal) return false;
    terminal = true;
    generation += 1;
    preserveController?.abort(error);
    preserveController = null;
    invalidated.reject(error);
    clearPhaseTimers();
    const removeMessageListener = removeMessage;
    const removeCloseListener = removeClose;
    const removeErrorListener = removeError;
    removeMessage = () => {};
    removeClose = () => {};
    removeError = () => {};
    removeMessageListener();
    removeCloseListener();
    removeErrorListener();
    if (hostCallbacks && !hostCallbacks.signal.aborted) hostCallbacks.abort(error);
    hostCallbacks = null;
    callbackContext = null;
    receiver?.dispose();
    receiver = null;
    releasePreview(wipe);
    dispositionDeadlineAt = null;
    dispositionExpiresAt = null;
    // Promise reactions already placed on the microtask queue cannot be
    // cancelled. Revoke their owned byte slots synchronously so those
    // reactions retain only empty holders after any terminal transition.
    for (const slot of queuedFrames) {
      slot.data?.fill(0);
      slot.data = null;
    }
    queuedFrames.clear();
    queue = Promise.resolve();
    const terminalChannel = channel;
    channel = null;
    requestId = null;
    channelId = null;
    preserveTransactionId = null;
    frameOptions = null;
    options = null;
    terminalCleanup = releaseByteReservation().then(callback).finally(() => {
      cleanupErrorCallback = null;
    });
    if (close) terminalChannel?.close?.();
    return terminalCleanup;
  };
  const fail = (error, nextState = "failed") => {
    if (terminal) return false;
    if (state === "preserving" && preserveOperation) {
      void coordinatePreserveTerminal(error, nextState);
      return true;
    }
    state = nextState;
    return finish(() => {
      if (!previewSettled) previewReady.reject(error);
      dispositionReady.reject(error);
    }, { error, wipe: true });
  };
  const assertCurrent = (snapshot, allowedStates) => {
    if (generation !== snapshot || !allowedStates.includes(state)) {
      throw invalidatedSessionError(state);
    }
    const currentDeadlineTime = deadlineTime();
    if (
      !["presenting-preview", "previewing", "preserving"].includes(state) &&
      currentDeadlineTime >= previewDeadlineAt
    ) {
      const error = new OabError(
        "detached_transfer_timeout",
        "The detached transfer did not reach preview before its deadline.",
      );
      sendAbortThenFail(error);
      throw error;
    }
    if (
      ["presenting-preview", "previewing", "preserving"].includes(state) &&
      dispositionDeadlineAt != null &&
      currentDeadlineTime >= dispositionDeadlineAt
    ) {
      const error = new OabError(
        "detached_disposition_timeout",
        "The preview disposition deadline expired and was discarded.",
      );
      if (state === "preserving") {
        preserveController?.abort(error);
        throw error;
      }
      discard(error).catch(() => {});
      throw error;
    }
  };
  const raceInvalidation = (value) => Promise.race([
    Promise.resolve(value),
    invalidated.promise,
  ]);
  const sendAbortThenFail = (error) => {
    if (terminal) return;
    if (channel.readyState === "open") {
      sendDetachedFrame(channel, encodeDetachedControl("abort", {
        reason: normalizeWireAbortReason(asOabError(error).code),
      }), frameOptions).catch(() => {});
    }
    fail(error);
  };
  const discard = (reasonError = invalidatedSessionError("discarded")) => {
    if (terminal) return Promise.resolve("discarded");
    const transferId = previewDelivery?.transferId;
    state = "discarded";
    let resultAttempt = Promise.resolve();
    if (transferId && channel.readyState === "open") {
      resultAttempt = sendDetachedFrame(channel, encodeDetachedControl("result", {
        transferId,
        disposition: "discarded",
      }), frameOptions).catch(() => {});
    }
    const cleanupAttempt = finish(() => {
      if (!previewSettled) previewReady.reject(reasonError);
      dispositionReady.resolve("discarded");
    }, { error: reasonError, wipe: true });
    return Promise.all([resultAttempt, cleanupAttempt]).then(() => "discarded");
  };
  const coordinatePreserveTerminal = (error, nextState = "failed") => {
    if (terminal) return Promise.resolve();
    if (preserveTerminalRequest) return preserveTerminalRequest.promise;
    const request = {
      error,
      nextState,
      promise: null,
    };
    preserveTerminalRequest = request;
    preserveController?.abort(error);
    request.promise = Promise.resolve(preserveOperation).catch(() => {}).then(async () => {
      if (terminal) return;
      state = request.nextState;
      await finish(() => {
        if (!previewSettled) previewReady.reject(request.error);
        dispositionReady.reject(request.error);
      }, { error: request.error, wipe: true });
    }).finally(() => {
      if (preserveTerminalRequest === request) preserveTerminalRequest = null;
      request.error = null;
      request.nextState = null;
    });
    request.promise.catch(() => {});
    return request.promise;
  };
  previewTimer = setTimeout(() => {
    if (
      terminal ||
      ["presenting-preview", "previewing", "preserving"].includes(state)
    ) return;
    const error = new OabError(
      "detached_transfer_timeout",
      "The detached transfer did not reach preview before its deadline.",
    );
    sendAbortThenFail(error);
  }, Math.max(0, previewDeadlineAt - deadlineTime()));
  previewTimer.unref?.();
  const capabilitiesSent = Promise.resolve().then(async () => {
    const operationGeneration = generation;
    const authorization = await raceInvalidation(
      options.authorizeVerifiedSender?.({
        origin: canonicalOrigin(options.sourceOrigin),
        originVerified: true,
        transport: DETACHED_TRANSPORT,
      }, callbackContext),
    );
    assertCurrent(operationGeneration, ["authorizing-sender"]);
    if (authorization?.allowed !== true) {
      throw new OabError(
        "detached_sender_not_authorized",
        "The verified sender origin was not authorized by receiver policy.",
      );
    }
    await sendDetachedFrame(
      channel,
      encodeDetachedControl("capabilities", capabilities),
      frameOptions,
    );
    assertCurrent(operationGeneration, ["authorizing-sender"]);
    state = "awaiting-manifest";
  }).catch((error) => {
    if (!terminal) sendAbortThenFail(error);
    throw error;
  });
  capabilitiesSent.catch(() => {});
  const onMessage = (event) => {
    if (terminal) return;
    let messageBytes;
    let withinRate;
    try {
      messageBytes = messageByteLength(event.data);
      if (messageBytes > capabilities.maximumFrameBytes) {
        throw new OabError(
          "invalid_detached_frame",
          "The detached message exceeds the negotiated frame limit.",
        );
      }
      withinRate = consumeInboundRate(event.data);
    } catch (error) {
      sendAbortThenFail(error);
      return;
    }
    if (!withinRate) {
      sendAbortThenFail(new OabError(
        "detached_receive_rate_exceeded",
        "The peer exceeded the detached inbound frame or byte rate limit.",
      ));
      return;
    }
    const slot = { data: ownMessageBytes(event.data) };
    if (queuedFrames.size >= MAXIMUM_QUEUED_INBOUND_FRAMES) {
      slot.data.fill(0);
      slot.data = null;
      const error = new OabError(
        "detached_receive_queue_overflow",
        "The peer exceeded the bounded detached receive queue.",
      );
      sendAbortThenFail(error);
      return;
    }
    queuedFrames.add(slot);
    queue = queue.then(async () => {
      const message = slot.data;
      if (terminal || !message) return;
      const operationGeneration = generation;
      await raceInvalidation(capabilitiesSent);
      assertCurrent(operationGeneration, [
        "awaiting-manifest",
        "authorizing-manifest",
        "receiving",
        "previewing",
      ]);
      if (state === "previewing") {
        const frame = decodeDetachedFrame(message, frameOptions);
        if (frame.typeName === "abort") {
          validateRemoteAbort(frame);
          throw new OabError(
            "detached_sender_aborted",
            "The sender aborted while the receiver was previewing.",
          );
        }
        throw new OabError(
          "unexpected_detached_frame",
          "No transfer frames are accepted after preview begins.",
        );
      }
      const accepted = await raceInvalidation(receiver.accept(message));
      try {
        assertCurrent(operationGeneration, ["awaiting-manifest", "receiving"]);
      } catch (error) {
        if (accepted?.type === "complete") wipePreviewAssets(accepted);
        throw error;
      }
      if (accepted.type === "manifest") {
        state = "authorizing-manifest";
        assertManifestMatchesCapabilities(
          accepted.manifest,
          capabilities,
        );
        const reservation = await acquireIncomingByteReservation(
          options.reserveIncomingBytes,
          {
            requestId,
            channelId,
            transferId: accepted.manifest.transferId,
            transport: DETACHED_TRANSPORT,
            totalBytes: accepted.manifest.totalBytes,
            maximumAggregateTransferBytes,
            expiresAt: options.sessionExpiresAt ??
              Date.now() + transferTimeoutMs + dispositionTimeoutMs,
          },
          options,
        );
        try {
          assertCurrent(operationGeneration, ["authorizing-manifest"]);
        } catch (error) {
          await reservation.release();
          throw error;
        }
        byteReservation = reservation;
        const authorization = await raceInvalidation(
          options.authorizeManifest?.(
            accepted.manifest,
            accepted.manifestDigest,
            callbackContext,
          ),
        );
        assertCurrent(operationGeneration, ["authorizing-manifest"]);
        if (authorization?.allowed !== true) {
          await sendDetachedFrame(channel, receiver.reject(
            authorization?.reason ?? "user_rejected",
          ), frameOptions);
          assertCurrent(operationGeneration, ["authorizing-manifest"]);
          throw new OabError(
            "detached_transfer_rejected",
            "The receiver did not authorize the offered transfer.",
          );
        }
        await sendDetachedFrame(channel, receiver.grant(), frameOptions);
        assertCurrent(operationGeneration, ["authorizing-manifest"]);
        state = "receiving";
      } else if (accepted.type === "complete") {
        const source = Object.freeze({
          origin: canonicalOrigin(options.sourceOrigin),
          application: accepted.source.application,
          url: accepted.source.url,
          originVerified: true,
        });
        previewDelivery = Object.freeze({
          ...accepted,
          source,
          dispositionExpiresAt: Date.now() + dispositionTimeoutMs,
          evidence: Object.freeze({
            transport: DETACHED_TRANSPORT,
            originVerified: true,
            encryptedPeerChannel: true,
            receiverAuthorized: true,
            persisted: false,
          }),
        });
        if (typeof options.onPreview !== "function") {
          throw new OabError(
            "on_preview_required",
            "A transient preview callback is required before preview acknowledgement.",
          );
        }
        state = "presenting-preview";
        if (previewTimer != null) clearTimeout(previewTimer);
        previewTimer = null;
        dispositionDeadlineAt = deadlineTime() + dispositionTimeoutMs;
        dispositionExpiresAt = previewDelivery.dispositionExpiresAt;
        dispositionTimer = setTimeout(() => {
          if (
            terminal ||
            !["presenting-preview", "previewing", "preserving"].includes(state)
          ) return;
          const error = new OabError(
            "detached_disposition_timeout",
            "The preview disposition deadline expired and was discarded.",
          );
          if (state === "preserving") {
            preserveController?.abort(error);
            return;
          }
          discard(error).catch(() => {});
        }, Math.max(0, dispositionDeadlineAt - deadlineTime()));
        dispositionTimer.unref?.();
        await raceInvalidation(options.onPreview(
          previewDelivery,
          callbackContext,
        ));
        assertCurrent(operationGeneration, ["presenting-preview"]);
        await sendDetachedFrame(channel, encodeDetachedControl("previewing", {
          transferId: accepted.transferId,
          status: "previewing",
        }), frameOptions);
        assertCurrent(operationGeneration, ["presenting-preview"]);
        state = "previewing";
        previewSettled = true;
        previewReady.resolve(previewDelivery);
      }
    }).catch((error) => {
      if (!terminal) sendAbortThenFail(error);
    }).finally(() => {
      slot.data?.fill(0);
      slot.data = null;
      queuedFrames.delete(slot);
    });
  };
  removeMessage = addListener(channel, "message", onMessage);
  removeClose = addListener(channel, "close", () => fail(new OabError(
    "detached_channel_closed",
    "The detached channel closed before transfer completion.",
  )));
  removeError = addListener(channel, "error", () => fail(new OabError(
    "detached_channel_error",
    "The detached channel failed before transfer completion.",
  )));
  const preview = previewReady.promise;
  preview.catch(() => {});
  dispositionReady.promise.catch(() => {});
  return Object.freeze({
    capabilities,
    get state() { return state; },
    get dispositionExpiresAt() { return dispositionExpiresAt; },
    preview,
    completion: dispositionReady.promise,
    async complete(disposition) {
      const operationGeneration = generation;
      await raceInvalidation(preview);
      assertCurrent(operationGeneration, ["previewing"]);
      if (state !== "previewing") {
        throw new OabError(
          "invalid_detached_state",
          "A final disposition can be sent exactly once after preview begins.",
        );
      }
      if (!["preserved", "discarded"].includes(disposition)) {
        throw new OabError(
          "invalid_detached_disposition",
          "The final disposition must be preserved or discarded.",
        );
      }
      if (disposition === "discarded") {
        return discard();
      }
      throw new OabError(
        "preserve_transaction_required",
        "Preserve requires preserve({commit, rollback}) so expiry can never leave a late durable commit behind.",
      );
    },
    async preserve(transaction) {
      if (
        !plainObject(transaction) ||
        !exactKeys(transaction, ["commit", "rollback"]) ||
        typeof transaction.commit !== "function" ||
        typeof transaction.rollback !== "function"
      ) {
        throw new TypeError(
          "preserve() requires exactly {commit(context), rollback(context)}.",
        );
      }
      const operationGeneration = generation;
      await raceInvalidation(preview);
      assertCurrent(operationGeneration, ["previewing"]);
      if (state !== "previewing") {
        throw new OabError(
          "invalid_detached_state",
          "Preserve may begin exactly once while the transient preview is active.",
        );
      }
      state = "preserving";
      const preservationDone = deferred();
      preservationDone.promise.catch(() => {});
      preserveOperation = preservationDone.promise;
      let preservationSettled = false;
      const settlePreservation = () => {
        if (preservationSettled) return;
        preservationSettled = true;
        if (preserveOperation === preservationDone.promise) {
          preserveOperation = null;
        }
        preservationDone.resolve();
      };
      const controller = new AbortController();
      preserveController = controller;
      const context = Object.freeze({
        transactionId: preserveTransactionId,
        delivery: previewDelivery,
        dispositionExpiresAt,
        signal: controller.signal,
      });
      const commitPromise = Promise.resolve().then(() =>
        transaction.commit(context));
      commitPromise.catch(() => {});
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new OabError(
              "preserve_aborted",
              "The Preserve transaction was aborted before completion.",
            )
        ), { once: true });
      });
      aborted.catch(() => {});
      let committedValue;
      try {
        committedValue = await raceInvalidation(Promise.race([
          commitPromise,
          aborted,
        ]));
        assertCurrent(operationGeneration, ["preserving"]);
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new OabError(
              "preserve_aborted",
              "The Preserve transaction was aborted before completion.",
            );
        }
        if (
          dispositionDeadlineAt == null ||
          deadlineTime() >= dispositionDeadlineAt
        ) {
          throw new OabError(
            "detached_disposition_timeout",
            "The durable commit did not finish before the preview disposition deadline.",
          );
        }
      } catch (error) {
        controller.abort(error);
        const settlement = await observeSettlement(
          commitPromise,
          preserveSettlementTimeoutMs,
        );
        let failure = error;
        let commitUnresponsive = false;
        if (settlement.status === "timeout") {
          commitUnresponsive = true;
          failure = new OabError(
            "preserve_commit_unresponsive",
            "The Preserve commit ignored cancellation and did not settle within the hard cleanup deadline.",
            { cause: error },
          );
        }
        const rollbackContext = Object.freeze({
          ...context,
          reason: failure,
          commitSettlement: settlement.status,
        });
        try {
          const rollbackPromise = Promise.resolve().then(() =>
            transaction.rollback(rollbackContext));
          rollbackPromise.catch(() => {});
          const rollbackSettlement = await observeSettlement(
            rollbackPromise,
            preserveSettlementTimeoutMs,
          );
          if (rollbackSettlement.status !== "fulfilled") {
            throw rollbackSettlement.status === "rejected"
              ? rollbackSettlement.reason
              : new OabError(
                "preserve_rollback_timeout",
                "The Preserve rollback did not settle within the hard cleanup deadline.",
              );
          }
        } catch (rollbackError) {
          failure = new OabError(
            "preserve_rollback_failed",
            "The receiver could not prove that a failed or expired Preserve left no durable content.",
            { cause: rollbackError },
          );
          if (preserveTerminalRequest) {
            preserveTerminalRequest.error = failure;
            preserveTerminalRequest.nextState = "failed";
          }
          settlePreservation();
          if (!terminal && !preserveTerminalRequest) fail(failure);
          throw failure;
        } finally {
          if (preserveController === controller) preserveController = null;
        }
        if (commitUnresponsive) {
          // A non-conforming adapter can still settle after the SDK deadline.
          // Run a second idempotent rollback at that point and surface any
          // cleanup failure to the host. Never report this transaction as
          // Discarded or Preserved because its durable state is indeterminate.
          commitPromise.then(
            () => transaction.rollback(Object.freeze({
              ...rollbackContext,
              commitSettlement: "late-fulfilled",
            })),
            () => transaction.rollback(Object.freeze({
              ...rollbackContext,
              commitSettlement: "late-rejected",
            })),
          ).catch((lateError) => reportCleanupError(
            "late-preserve-rollback",
            lateError,
          ));
          if (preserveTerminalRequest) {
            preserveTerminalRequest.error = failure;
            preserveTerminalRequest.nextState = "failed";
          }
        }
        settlePreservation();
        if (!terminal && !preserveTerminalRequest) {
          if (commitUnresponsive) fail(failure);
          else await discard(failure);
        }
        throw failure;
      }
      const transferId = previewDelivery.transferId;
      const terminalChannel = channel;
      const terminalFrameOptions = frameOptions;
      preserveController = null;
      state = "preserved";
      let resultAttempt = Promise.resolve();
      if (terminalChannel?.readyState === "open") {
        resultAttempt = sendDetachedFrame(
          terminalChannel,
          encodeDetachedControl("result", {
            transferId,
            disposition: "preserved",
          }),
          terminalFrameOptions,
        ).catch(() => {});
      }
      const cleanupAttempt = finish(
        () => dispositionReady.resolve("preserved"),
        { wipe: true, close: false },
      );
      await Promise.all([cleanupAttempt, resultAttempt]);
      terminalChannel?.close?.();
      settlePreservation();
      return committedValue;
    },
    async abort(reason = "receiver_aborted") {
      if (terminal) return;
      let abortAttempt = Promise.resolve();
      if (channel.readyState === "open") {
        abortAttempt = sendDetachedFrame(channel, encodeDetachedControl("abort", {
          reason: normalizeWireAbortReason(reason, "receiver_cancelled"),
        }), frameOptions).catch(() => {});
      }
      const error = new OabError(
        "detached_receiver_aborted",
        "The receiver aborted the detached transfer.",
      );
      if (state === "preserving" && preserveOperation) {
        await Promise.all([
          coordinatePreserveTerminal(error, "aborted"),
          abortAttempt,
        ]);
        return;
      }
      state = "aborted";
      const cleanupAttempt = finish(() => {
        if (!previewSettled) previewReady.reject(error);
        dispositionReady.reject(error);
      }, { error, wipe: true });
      await Promise.all([abortAttempt, cleanupAttempt]);
    },
  });
}
