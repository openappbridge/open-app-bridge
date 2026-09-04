import { OabError } from "./errors.js";
import {
  assertCapturedIncomingHandoff,
  assertSecureContext,
  canonicalOrigin,
} from "./internal.js";
import {
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
} from "./detached-crypto.js";
import {
  DETACHED_CALLBACK_PATH,
  DETACHED_PROTOCOL,
  DETACHED_TRANSPORT,
  detachedCallbackUrl,
  createDetachedAnswerFragment,
  parseDetachedAnswerFragment,
  parseDetachedOfferFragment,
} from "./detached-signaling.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const CHANNEL_CAPABILITY_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const MAXIMUM_BROADCAST_BYTES = 64 * 1024;
const MAXIMUM_CALLBACK_FRAGMENT_BYTES = 32 * 1024;
const MAXIMUM_HELPER_FRAGMENT_BYTES = 4 * 1024;
const MAXIMUM_HELPER_URL_BYTES = 2048;
const MAXIMUM_HELPER_READY_TIMEOUT_MS = 15 * 1000;

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
  let canonical = false;
  if (typeof value === "string" && TOKEN_PATTERN.test(value)) {
    try {
      canonical = encodeBase64Url(decodeBase64Url(value, 96)) === value;
    } catch (_) {
      canonical = false;
    }
  }
  if (!canonical) {
    throw new OabError(
      "invalid_detached_callback",
      `${label} must be 22–128 canonical base64url characters.`,
    );
  }
  return value;
}

function channelCapability(value, label) {
  if (
    typeof value !== "string" ||
    !CHANNEL_CAPABILITY_PATTERN.test(value)
  ) {
    throw new OabError(
      "invalid_detached_callback",
      `${label} must be a canonical 32-byte base64url capability.`,
    );
  }
  return value;
}

function assertDetachedTopLevel(windowRef, role) {
  assertSecureContext(windowRef, role);
  if (windowRef.opener !== null) {
    throw new OabError(
      "detached_opener_forbidden",
      `The detached ${role} must be opened with noopener.`,
    );
  }
  if (windowRef.parent && windowRef.parent !== windowRef) {
    throw new OabError(
      "detached_top_level_required",
      `The detached ${role} must run in a top-level browsing context.`,
    );
  }
}

function captureAndScrubFragment(windowRef, options = {}) {
  if (
    !windowRef?.location ||
    typeof windowRef?.history?.replaceState !== "function"
  ) {
    throw new OabError(
      "browser_required",
      "A browser window with History API support is required.",
    );
  }
  const fragment = typeof windowRef.location.hash === "string"
    ? windowRef.location.hash
    : String(windowRef.location.hash ?? "");
  // OAB entry/helper/callback endpoints are query-free. Drop a hostile query
  // together with the fragment before validating either value. Callers retain
  // only bounded pre-scrub evidence and still reject the launch.
  const replacement = windowRef.location.pathname || "/";
  windowRef.history.replaceState(
    windowRef.history.state ?? null,
    "",
    replacement,
  );
  if (windowRef.location.hash || windowRef.location.search) {
    throw new OabError(
      "detached_fragment_not_scrubbed",
      "The detached page could not remove its signaling fragment and query.",
    );
  }
  if (!fragment) {
    throw new OabError(
      "detached_fragment_missing",
      "The detached launch fragment is missing.",
    );
  }
  const maximumBytes = options.maximumBytes;
  if (
    Number.isSafeInteger(maximumBytes) &&
    maximumBytes > 0 &&
    (
      fragment.length > maximumBytes ||
      encoder.encode(fragment.replace(/^#/u, "")).byteLength > maximumBytes
    )
  ) {
    throw new OabError(
      options.errorCode ?? "detached_fragment_too_large",
      options.errorMessage ??
        `The detached launch fragment exceeds ${maximumBytes} bytes.`,
    );
  }
  return fragment;
}

function adoptScrubbedUtilityHandoff(windowRef, value, options = {}) {
  if (
    !exactKeys(value, ["fragment", "hadQuery", "href", "referrer"]) ||
    typeof value.fragment !== "string" ||
    typeof value.href !== "string" ||
    typeof value.referrer !== "string" ||
    typeof value.hadQuery !== "boolean" ||
    windowRef.location?.hash ||
    windowRef.location?.search
  ) {
    throw new OabError(
      options.errorCode ?? "invalid_detached_capture",
      "The scrub-first detached utility handoff is invalid.",
    );
  }
  let launchUrl;
  try {
    launchUrl = new URL(value.href);
  } catch (error) {
    throw new OabError(
      options.errorCode ?? "invalid_detached_capture",
      "The scrub-first detached utility URL is invalid.",
      { cause: error },
    );
  }
  const currentOrigin = canonicalOrigin(windowRef.location?.origin);
  if (
    launchUrl.hash !== value.fragment ||
    Boolean(launchUrl.search) !== value.hadQuery ||
    launchUrl.origin !== currentOrigin ||
    launchUrl.pathname !== windowRef.location?.pathname ||
    value.referrer.length > 4096
  ) {
    throw new OabError(
      options.errorCode ?? "invalid_detached_capture",
      "The scrub-first detached utility handoff does not match this endpoint.",
    );
  }
  const maximumBytes = options.maximumBytes;
  if (
    Number.isSafeInteger(maximumBytes) &&
    maximumBytes > 0 &&
    (
      value.fragment.length > maximumBytes ||
      encoder.encode(value.fragment.replace(/^#/u, "")).byteLength >
        maximumBytes
    )
  ) {
    throw new OabError(
      options.errorCode ?? "detached_fragment_too_large",
      options.errorMessage ??
        `The detached utility fragment exceeds ${maximumBytes} bytes.`,
    );
  }
  return Object.freeze({
    fragment: value.fragment,
    hadQuery: value.hadQuery,
    href: launchUrl.href,
    referrer: value.referrer,
  });
}

function broadcastFactory(options) {
  const factory = options.broadcastChannelFactory ?? ((name) => {
    if (typeof globalThis.BroadcastChannel !== "function") {
      throw new OabError(
        "broadcast_channel_unavailable",
        "A same-origin BroadcastChannel implementation is required.",
      );
    }
    return new globalThis.BroadcastChannel(name);
  });
  return factory;
}

function openBroadcastChannel(name, options) {
  const channel = broadcastFactory(options)(name);
  if (
    !channel ||
    typeof channel.postMessage !== "function" ||
    typeof channel.close !== "function"
  ) {
    throw new OabError(
      "broadcast_channel_unavailable",
      "The BroadcastChannel factory returned an invalid channel.",
    );
  }
  return channel;
}

function addMessageListener(channel, listener) {
  if (typeof channel.addEventListener === "function") {
    channel.addEventListener("message", listener);
    return () => channel.removeEventListener?.("message", listener);
  }
  const previous = channel.onmessage;
  channel.onmessage = listener;
  return () => {
    if (channel.onmessage === listener) channel.onmessage = previous ?? null;
  };
}

function boundedBroadcast(value) {
  let size;
  try {
    size = encoder.encode(canonicalJson(value)).byteLength;
  } catch (error) {
    throw new OabError(
      "invalid_detached_broadcast",
      "The detached-channel local message is not canonical JSON.",
      { cause: error },
    );
  }
  if (size > MAXIMUM_BROADCAST_BYTES) {
    throw new OabError(
      "detached_broadcast_too_large",
      "The detached-channel local message exceeds its size limit.",
    );
  }
  return value;
}

export function detachedBroadcastName(role, requestIdValue, channelIdValue) {
  if (!['sender', 'receiver'].includes(role)) {
    throw new TypeError("role must be sender or receiver.");
  }
  const requestId = token(requestIdValue, "requestId");
  const channelId = channelCapability(channelIdValue, "channelId");
  return `oab:detached:${role}:${requestId}:${channelId}`;
}

export function captureDetachedOfferFromWindow(windowRef, options = {}) {
  const hadQuery = options.capturedHandoff == null
    ? Boolean(windowRef.location?.search)
    : assertCapturedIncomingHandoff(options.capturedHandoff).hadQuery;
  const fragment = options.capturedHandoff == null
    ? captureAndScrubFragment(windowRef, {
        maximumBytes: MAXIMUM_CALLBACK_FRAGMENT_BYTES,
      })
    : assertCapturedIncomingHandoff(options.capturedHandoff).fragment;
  assertDetachedTopLevel(windowRef, "receiver");
  if (hadQuery) {
    throw new OabError(
      "detached_receiver_endpoint_mismatch",
      "The detached receiver endpoint must not contain a query.",
    );
  }
  const maximumSignalingBytes = options.maximumSignalingBytes ?? 32 * 1024;
  if (
    !Number.isSafeInteger(maximumSignalingBytes) ||
    maximumSignalingBytes < 1024 ||
    maximumSignalingBytes > 32 * 1024 ||
    encoder.encode(fragment.replace(/^#/u, "")).byteLength >
      maximumSignalingBytes
  ) {
    throw new OabError(
      "detached_fragment_too_large",
      "The captured detached offer exceeds the receiver signaling limit.",
    );
  }
  return Object.freeze({
    fragment,
    receiverOrigin: canonicalOrigin(windowRef.location.origin),
  });
}

export async function inspectCapturedDetachedOffer(capture, options = {}) {
  if (
    !exactKeys(capture, ["fragment", "receiverOrigin"]) ||
    typeof capture.fragment !== "string"
  ) {
    throw new OabError(
      "invalid_detached_capture",
      "The captured detached offer is malformed.",
    );
  }
  return parseDetachedOfferFragment(capture.fragment, {
    ...options,
    expectedReceiverOrigin: capture.receiverOrigin,
    structuralOnly: true,
  });
}

function localHelperToken(options, label) {
  const supplied = options.randomToken?.(label);
  if (supplied !== undefined) return token(supplied, label);
  const provider = options.crypto ?? globalThis.crypto;
  if (typeof provider?.getRandomValues !== "function") {
    throw new OabError(
      "secure_random_unavailable",
      "The detached helper requires a secure random generator.",
    );
  }
  const value = new Uint8Array(32);
  provider.getRandomValues(value);
  return encodeBase64Url(value);
}

function helperEnvelope(value) {
  if (
    !exactKeys(value, [
      "protocol",
      "transport",
      "helperRequestId",
      "helperChannelId",
      "receiverOrigin",
      "receiverHelper",
    ]) ||
    value.protocol !== DETACHED_PROTOCOL ||
    value.transport !== DETACHED_TRANSPORT
  ) {
    throw new OabError(
      "invalid_detached_helper",
      "The detached helper bootstrap is malformed.",
    );
  }
  return Object.freeze({
    protocol: DETACHED_PROTOCOL,
    transport: DETACHED_TRANSPORT,
    helperRequestId: token(value.helperRequestId, "helperRequestId"),
    helperChannelId: channelCapability(
      value.helperChannelId,
      "helperChannelId",
    ),
    receiverOrigin: canonicalOrigin(value.receiverOrigin),
    receiverHelper: (() => {
      let url;
      try {
        url = new URL(value.receiverHelper);
      } catch (error) {
        throw new OabError(
          "invalid_detached_helper",
          "The discovered receiver helper endpoint is invalid.",
          { cause: error },
        );
      }
      const origin = canonicalOrigin(value.receiverOrigin);
      if (
        encoder.encode(url.href).byteLength > MAXIMUM_HELPER_URL_BYTES ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new OabError(
          "invalid_detached_helper",
          "The receiver helper must be an exact same-origin endpoint.",
        );
      }
      return url.href;
    })(),
  });
}

export function createDetachedHelperUrl(receiverOriginValue, value) {
  const receiverOrigin = canonicalOrigin(receiverOriginValue);
  const envelope = helperEnvelope({ ...value, receiverOrigin });
  const url = new URL(envelope.receiverHelper);
  const payload = encodeBase64Url(encoder.encode(canonicalJson(envelope)));
  const fragment = `oab-detached-helper=1&payload=${payload}`;
  if (encoder.encode(fragment).byteLength > MAXIMUM_HELPER_FRAGMENT_BYTES) {
    throw new OabError(
      "invalid_detached_helper",
      `The detached helper fragment exceeds ${MAXIMUM_HELPER_FRAGMENT_BYTES} bytes.`,
    );
  }
  url.hash = fragment;
  return url.href;
}

export function parseDetachedHelperFromWindow(windowRef, options = {}) {
  const earlyCapture = options.scrubbedHandoff == null
    ? null
    : adoptScrubbedUtilityHandoff(windowRef, options.scrubbedHandoff, {
        maximumBytes: MAXIMUM_HELPER_FRAGMENT_BYTES,
        errorCode: "invalid_detached_helper",
        errorMessage:
          `The detached helper fragment exceeds ${MAXIMUM_HELPER_FRAGMENT_BYTES} bytes.`,
      });
  const hadQuery = earlyCapture?.hadQuery ??
    Boolean(windowRef.location?.search);
  const fragment = earlyCapture?.fragment ??
    captureAndScrubFragment(windowRef, {
      maximumBytes: MAXIMUM_HELPER_FRAGMENT_BYTES,
      errorCode: "invalid_detached_helper",
      errorMessage:
        `The detached helper fragment exceeds ${MAXIMUM_HELPER_FRAGMENT_BYTES} bytes.`,
    });
  assertDetachedTopLevel(windowRef, "receiver helper");
  if (hadQuery) {
    throw new OabError(
      "detached_helper_endpoint_mismatch",
      "The detached helper endpoint must not contain a query.",
    );
  }
  const rawFragment = fragment.replace(/^#/u, "");
  if (encoder.encode(rawFragment).byteLength > MAXIMUM_HELPER_FRAGMENT_BYTES) {
    throw new OabError(
      "invalid_detached_helper",
      `The detached helper fragment exceeds ${MAXIMUM_HELPER_FRAGMENT_BYTES} bytes.`,
    );
  }
  const match = rawFragment.match(
    /^oab-detached-helper=1&payload=([A-Za-z0-9_-]+)$/u,
  );
  if (!match) {
    throw new OabError(
      "invalid_detached_helper",
      "The detached helper fragment is malformed or ambiguous.",
    );
  }
  let value;
  try {
    const source = decoder.decode(
      decodeBase64Url(match[1], 4096),
    );
    value = JSON.parse(source);
    if (source !== canonicalJson(value)) {
      throw new OabError(
        "invalid_detached_helper",
        "The detached helper fragment is not canonical JSON.",
      );
    }
  } catch (error) {
    if (error instanceof OabError) throw error;
    throw new OabError(
      "invalid_detached_helper",
      "The detached helper fragment could not be decoded.",
      { cause: error },
    );
  }
  const envelope = helperEnvelope(value);
  if (envelope.receiverOrigin !== canonicalOrigin(windowRef.location.origin)) {
    throw new OabError(
      "detached_receiver_origin_mismatch",
      "The detached helper was opened on the wrong receiver origin.",
    );
  }
  const actualHelper = new URL(
    `${windowRef.location.origin}${windowRef.location.pathname}`,
  ).href;
  if (actualHelper !== envelope.receiverHelper) {
    throw new OabError(
      "detached_helper_endpoint_mismatch",
      "The detached helper is not running at its discovered endpoint.",
    );
  }
  return envelope;
}

export function createDetachedReceiverHelperSession(value, options = {}) {
  let envelope = helperEnvelope({
    protocol: value.protocol ?? DETACHED_PROTOCOL,
    transport: value.transport ?? DETACHED_TRANSPORT,
    helperRequestId:
      value.helperRequestId ?? localHelperToken(options, "helperRequestId"),
    helperChannelId:
      value.helperChannelId ?? localHelperToken(options, "helperChannelId"),
    receiverOrigin: value.receiverOrigin,
    receiverHelper: value.receiverHelper,
  });
  // Validate and bound the complete launch URL before acquiring the local
  // rendezvous resource, so a fragment-size failure cannot leak a channel.
  let href = createDetachedHelperUrl(envelope.receiverOrigin, envelope);
  let channel = openBroadcastChannel(
    detachedBroadcastName(
      "receiver",
      envelope.helperRequestId,
      envelope.helperChannelId,
    ),
    options,
  );
  let closed = false;
  let ready = false;
  let readyWaiter = null;
  let navigated = false;
  return Object.freeze({
    get href() { return href; },
    target: "_blank",
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer",
    waitUntilReady(timeoutMs = 15000) {
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 100 ||
        timeoutMs > MAXIMUM_HELPER_READY_TIMEOUT_MS
      ) {
        return Promise.reject(new TypeError(
          `The detached helper-ready timeout must be from 100 to ${MAXIMUM_HELPER_READY_TIMEOUT_MS} ms.`,
        ));
      }
      if (closed) {
        return Promise.reject(new OabError(
          "detached_helper_closed",
          "The detached helper session is closed.",
        ));
      }
      if (ready) return Promise.resolve();
      readyWaiter ??= waitForLocalMessage(channel, {
          timeoutMs,
          validate(message) {
            return exactKeys(message, ["type", "requestId", "channelId"]) &&
              message.type === "helper-ready" &&
              message.requestId === envelope.helperRequestId &&
              message.channelId === envelope.helperChannelId;
          },
          errorCode: "detached_helper_timeout",
        });
      return readyWaiter.promise.then(() => {
          ready = true;
          readyWaiter = null;
          return undefined;
        });
    },
    navigateToCallback(href, senderOriginValue) {
      if (closed) {
        throw new OabError(
          "detached_helper_closed",
          "The detached helper session is closed.",
        );
      }
      if (!ready || navigated) {
        throw new OabError(
          "invalid_detached_helper_state",
          "Callback navigation requires one verified helper-ready message.",
        );
      }
      const senderOrigin = canonicalOrigin(senderOriginValue);
      const url = assertFixedCallbackUrl(href, senderOrigin);
      channel.postMessage(boundedBroadcast({
        type: "navigate-callback",
        requestId: envelope.helperRequestId,
        channelId: envelope.helperChannelId,
        senderOrigin,
        href: url.href,
      }));
      navigated = true;
    },
    close() {
      if (closed) return;
      closed = true;
      readyWaiter?.cancel(new OabError(
        "detached_helper_closed",
        "The detached helper session was closed while waiting.",
      ));
      channel?.close();
      channel = null;
      readyWaiter = null;
      href = null;
      envelope = null;
    },
  });
}

export function runDetachedReceiverHelper(windowRef, options = {}) {
  let envelope = parseDetachedHelperFromWindow(windowRef, options);
  const timeoutMs = options.timeoutMs ?? 30000;
  const navigationFallbackDelayMs = options.navigationFallbackDelayMs ?? 1500;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  ) {
    envelope = null;
    throw new TypeError("The detached helper timeout must be from 100 to 30000 ms.");
  }
  if (
    !Number.isSafeInteger(navigationFallbackDelayMs) ||
    navigationFallbackDelayMs < 250 ||
    navigationFallbackDelayMs > 5000
  ) {
    envelope = null;
    throw new TypeError(
      "The detached helper navigation fallback delay must be from 250 to 5000 ms.",
    );
  }
  let channel = openBroadcastChannel(
    detachedBroadcastName(
      "receiver",
      envelope.helperRequestId,
      envelope.helperChannelId,
    ),
    options,
  );
  let terminal = false;
  let readyMessage = null;
  let readyInterval = null;
  let navigationFallbackTimer = null;
  let timeout = null;
  let remove = () => {};
  const stopRendezvous = () => {
    clearInterval(readyInterval);
    readyInterval = null;
    remove();
    remove = () => {};
    channel?.close();
    channel = null;
    readyMessage = null;
  };
  const cleanup = () => {
    clearTimeout(timeout);
    clearTimeout(navigationFallbackTimer);
    stopRendezvous();
    windowRef.removeEventListener?.("pagehide", onPageHide);
    envelope = null;
  };
  const terminate = ({ closeWindow = false } = {}) => {
    if (terminal) return false;
    terminal = true;
    cleanup();
    if (closeWindow) windowRef.close?.();
    return true;
  };
  const onPageHide = () => terminate();
  windowRef.addEventListener?.("pagehide", onPageHide, { once: true });
  readyMessage = boundedBroadcast({
    type: "helper-ready",
    requestId: envelope.helperRequestId,
    channelId: envelope.helperChannelId,
  });
  channel.postMessage(readyMessage);
  readyInterval = setInterval(
    () => channel?.postMessage(readyMessage),
    options.readyIntervalMs ?? 250,
  );
  const showNavigationFallback = (url, senderOrigin) => {
    if (terminal) return;
    let handled = false;
    try {
      handled = options.onNavigationFallback?.(Object.freeze({
        href: url.href,
        senderOrigin,
      })) === true;
    } catch (_) {
      handled = false;
    }
    if (handled) return;
    const documentRef = windowRef.document;
    if (
      !documentRef?.createElement ||
      !documentRef.body?.append
    ) return;
    documentRef.getElementById?.("oab-helper-navigation-fallback")?.remove?.();
    const section = documentRef.createElement("section");
    section.id = "oab-helper-navigation-fallback";
    section.setAttribute("role", "status");
    section.setAttribute("aria-live", "polite");
    const message = documentRef.createElement("p");
    message.textContent =
      `Your approved preview is ready. Continue to return to ${senderOrigin}.`;
    const link = documentRef.createElement("a");
    link.href = url.href;
    link.target = "_self";
    link.rel = "noopener";
    link.referrerPolicy = "origin";
    link.textContent = "Continue";
    section.append(message, link);
    documentRef.body.append(section);
    link.focus?.({ preventScroll: true });
  };
  remove = addMessageListener(channel, (event) => {
    if (terminal) return;
    let message;
    let url;
    try {
      message = boundedBroadcast(event?.data);
      if (
        !exactKeys(message, [
          "type",
          "requestId",
          "channelId",
          "senderOrigin",
          "href",
        ]) ||
        message.type !== "navigate-callback" ||
        message.requestId !== envelope.helperRequestId ||
        message.channelId !== envelope.helperChannelId
      ) {
        return;
      }
      url = assertFixedCallbackUrl(
        message.href,
        canonicalOrigin(message.senderOrigin),
      );
    } catch (_) {
      terminate({ closeWindow: true });
      return;
    }
    stopRendezvous();
    navigationFallbackTimer = setTimeout(
      () => showNavigationFallback(url, canonicalOrigin(message.senderOrigin)),
      navigationFallbackDelayMs,
    );
    try {
      windowRef.location.replace(url.href);
    } catch (_) {
      clearTimeout(navigationFallbackTimer);
      showNavigationFallback(url, canonicalOrigin(message.senderOrigin));
    }
  });
  timeout = setTimeout(() => {
    if (terminal) return;
    const error = new OabError(
      "detached_helper_timeout",
      "The detached receiver helper expired before callback navigation.",
    );
    terminate({ closeWindow: true });
    try {
      options.onTimeout?.(error);
    } catch (_) {}
  }, timeoutMs);
  return Object.freeze({
    get envelope() { return envelope; },
    close() { terminate(); },
  });
}

function assertFixedCallbackUrl(value, senderOriginValue) {
  const senderOrigin = canonicalOrigin(senderOriginValue);
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OabError(
      "invalid_detached_callback",
      "The detached callback URL is invalid.",
      { cause: error },
    );
  }
  if (
    url.origin !== senderOrigin ||
    url.username ||
    url.password ||
    url.pathname !== DETACHED_CALLBACK_PATH ||
    url.search ||
    !url.hash ||
    encoder.encode(url.hash.slice(1)).byteLength >
      MAXIMUM_CALLBACK_FRAGMENT_BYTES
  ) {
    throw new OabError(
      "invalid_detached_callback",
      "The answer may navigate only to the fixed sender-origin callback path.",
    );
  }
  return url;
}

export async function createDetachedAnswerCallbackUrl(
  senderOrigin,
  value,
  options = {},
) {
  const callback = {
    protocol: DETACHED_PROTOCOL,
    transport: DETACHED_TRANSPORT,
    type: "sealed-answer",
    requestId: token(value.requestId, "requestId"),
    channelId: channelCapability(value.channelId, "channelId"),
    receiverOrigin: canonicalOrigin(value.receiverOrigin),
    envelope: value.envelope,
  };
  boundedBroadcast(callback);
  const fragment = await createDetachedAnswerFragment(callback, options);
  return detachedCallbackUrl(senderOrigin, fragment);
}

export async function runDetachedSenderCallback(windowRef, options = {}) {
  let earlyCapture = options.scrubbedHandoff == null
    ? null
    : adoptScrubbedUtilityHandoff(windowRef, options.scrubbedHandoff, {
        maximumBytes: MAXIMUM_CALLBACK_FRAGMENT_BYTES,
        errorCode: "invalid_detached_callback",
        errorMessage:
          `The detached callback fragment exceeds ${MAXIMUM_CALLBACK_FRAGMENT_BYTES} bytes.`,
      });
  let earlyUrl = earlyCapture ? new URL(earlyCapture.href) : null;
  const callbackOrigin = earlyUrl?.origin ?? windowRef.location?.origin;
  const callbackPathname = earlyUrl?.pathname ??
    windowRef.location?.pathname ?? "";
  const callbackHadQuery = earlyCapture?.hadQuery ??
    Boolean(windowRef.location?.search);
  let fragment = earlyCapture?.fragment ??
    captureAndScrubFragment(windowRef, {
      maximumBytes: MAXIMUM_CALLBACK_FRAGMENT_BYTES,
      errorCode: "invalid_detached_callback",
      errorMessage:
        `The detached callback fragment exceeds ${MAXIMUM_CALLBACK_FRAGMENT_BYTES} bytes.`,
    });
  assertDetachedTopLevel(windowRef, "sender callback");
  let callbackLocationValid = false;
  try {
    const origin = canonicalOrigin(callbackOrigin);
    const current = new URL(`${origin}${callbackPathname}`);
    callbackLocationValid =
      current.origin === origin &&
      !current.username &&
      !current.password &&
      current.pathname === DETACHED_CALLBACK_PATH &&
      !callbackHadQuery;
  } catch (_) {
    callbackLocationValid = false;
  }
  let observedReferrerOrigin = null;
  try {
    observedReferrerOrigin = canonicalOrigin(
      new URL(earlyCapture?.referrer ?? windowRef.document?.referrer).origin,
    );
  } catch (_) {
    // A missing, opaque, or non-HTTPS referrer supplies no required
    // browser-observed receiver-origin evidence.
  }
  earlyCapture = null;
  earlyUrl = null;
  if (!callbackLocationValid) {
    throw new OabError(
      "detached_callback_endpoint_mismatch",
      "The detached callback must run at its fixed non-redirecting sender-origin path.",
    );
  }
  if (!observedReferrerOrigin) {
    throw new OabError(
      "detached_receiver_referrer_missing",
      "The callback has no valid receiver-origin referrer evidence.",
    );
  }
  let active = true;
  let rejectAbandoned;
  const abandoned = new Promise((_, reject) => {
    rejectAbandoned = reject;
  });
  abandoned.catch(() => {});
  const onPageHide = () => {
    active = false;
    rejectAbandoned(new OabError(
      "detached_local_wait_cancelled",
      "The detached sender callback was abandoned before relay.",
    ));
  };
  windowRef.addEventListener?.("pagehide", onPageHide, { once: true });
  let callback;
  try {
    callback = await Promise.race([
      parseDetachedAnswerFragment(fragment, options),
      abandoned,
    ]);
    fragment = null;
    if (!active) {
      throw new OabError(
        "detached_local_wait_cancelled",
        "The detached sender callback was abandoned before relay.",
      );
    }
  } finally {
    fragment = null;
    windowRef.removeEventListener?.("pagehide", onPageHide);
  }
  if (
    !exactKeys(callback, [
      "protocol",
      "transport",
      "type",
      "requestId",
      "channelId",
      "receiverOrigin",
      "envelope",
    ]) ||
    callback.protocol !== DETACHED_PROTOCOL ||
    callback.transport !== DETACHED_TRANSPORT ||
    callback.type !== "sealed-answer"
  ) {
    throw new OabError(
      "invalid_detached_callback",
      "The sender callback envelope is malformed.",
    );
  }
  let requestId = token(callback.requestId, "requestId");
  let channelId = channelCapability(callback.channelId, "channelId");
  let receiverOrigin = canonicalOrigin(callback.receiverOrigin);
  if (
    options.expectedReceiverOrigin &&
    receiverOrigin !== canonicalOrigin(options.expectedReceiverOrigin)
  ) {
    throw new OabError(
      "detached_receiver_origin_mismatch",
      "The detached callback names an unexpected receiver origin.",
    );
  }
  if (observedReferrerOrigin !== receiverOrigin) {
    throw new OabError(
      "detached_receiver_origin_mismatch",
      "The callback referrer does not show navigation from the expected receiver origin.",
    );
  }
  let channel = openBroadcastChannel(
    detachedBroadcastName("sender", requestId, channelId),
    options,
  );
  try {
    channel.postMessage(boundedBroadcast(callback));
  } finally {
    channel.close();
    channel = null;
  }
  const closeWindow = options.closeWindow;
  callback = null;
  requestId = null;
  channelId = null;
  receiverOrigin = null;
  observedReferrerOrigin = null;
  options = null;
  closeWindow?.();
}

function waitForLocalMessage(channel, options) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      remove();
      callback();
    };
    const listener = (event) => {
      let message;
      try {
        message = boundedBroadcast(event?.data);
      } catch (_) {
        return;
      }
      if (options.validate(message)) finish(() => resolve(message));
    };
    const remove = addMessageListener(channel, listener);
    const timer = setTimeout(() => finish(() => reject(new OabError(
      options.errorCode,
      "The detached-channel local handoff timed out.",
    ))), options.timeoutMs);
    cancel = (error = new OabError(
      "detached_local_wait_cancelled",
      "The detached-channel local wait was cancelled.",
    )) => finish(() => reject(error));
  });
  return Object.freeze({ promise, cancel: (error) => cancel(error) });
}

export function waitForDetachedAnswer(value, options = {}) {
  const requestId = token(value.requestId, "requestId");
  const channelId = channelCapability(value.channelId, "channelId");
  const receiverOrigin = canonicalOrigin(value.receiverOrigin);
  let channel = openBroadcastChannel(
    detachedBroadcastName("sender", requestId, channelId),
    options,
  );
  let waiter = waitForLocalMessage(channel, {
    timeoutMs: options.timeoutMs ?? 30000,
    errorCode: "detached_answer_timeout",
    validate(message) {
      return exactKeys(message, [
        "protocol",
        "transport",
        "type",
        "requestId",
        "channelId",
        "receiverOrigin",
        "envelope",
      ]) &&
        message.protocol === DETACHED_PROTOCOL &&
        message.transport === DETACHED_TRANSPORT &&
        message.type === "sealed-answer" &&
        message.requestId === requestId &&
        message.channelId === channelId &&
        message.receiverOrigin === receiverOrigin;
    },
  });
  const sourcePromise = waiter.promise;
  const cleanup = () => {
    const activeChannel = channel;
    channel = null;
    waiter = null;
    activeChannel?.close();
  };
  const promise = sourcePromise.then(async (message) => {
    // Reconstruct the canonical callback fragment so the original sender can
    // enforce the receiver's lower discovery-advertised signaling ceiling.
    await createDetachedAnswerFragment(message, {
      ...options,
      maximumSignalingBytes: options.maximumSignalingBytes,
    });
    return message.envelope;
  }).finally(cleanup);
  return Object.freeze({
    promise,
    close: () => {
      const activeWaiter = waiter;
      activeWaiter?.cancel(new OabError(
        "detached_answer_wait_closed",
        "The detached answer wait was closed before completion.",
      ));
      cleanup();
    },
  });
}
