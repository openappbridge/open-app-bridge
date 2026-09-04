import { OabError } from "./errors.js";

// Twenty-two base64url characters are the shortest canonical encoding that can
// carry 128 bits. SDK-generated identifiers use 256 bits; the lower bound
// exists for independent implementations and test vectors.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const UNSAFE_DISPLAY_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const DEFAULT_HANDOFF_ADMISSION_TIMEOUT_MS = 5000;
const MAXIMUM_HANDOFF_ADMISSION_TIMEOUT_MS = 30000;
const DEFAULT_SESSION_PROMOTION_TIMEOUT_MS = 5000;
const MAXIMUM_SESSION_PROMOTION_TIMEOUT_MS = 30000;
const DEFAULT_BYTE_RESERVATION_TIMEOUT_MS = 5000;
const MAXIMUM_BYTE_RESERVATION_TIMEOUT_MS = 30000;
export const INCOMING_HANDOFF_CAPTURE_LIMITS = Object.freeze({
  maximumFragmentBytes: 32 * 1024,
  maximumUrlBytes: 64 * 1024,
  maximumOriginBytes: 2 * 1024,
  maximumPathBytes: 8 * 1024,
  maximumQueryBytes: 16 * 1024,
});
const capturedIncomingHandoffs = new WeakSet();
const adoptedScrubbedIncomingHandoffs = new WeakSet();
const utf8Encoder = new TextEncoder();

function hasNamedFragmentMarker(fragment, markerNames) {
  let cursor = fragment.startsWith("#") ? 1 : 0;
  while (cursor <= fragment.length) {
    const separator = fragment.indexOf("&", cursor);
    const end = separator < 0 ? fragment.length : separator;
    const equals = fragment.indexOf("=", cursor);
    const nameEnd = equals >= cursor && equals < end ? equals : end;
    for (const markerName of markerNames) {
      if (
        nameEnd - cursor === markerName.length &&
        fragment.startsWith(markerName, cursor)
      ) {
        return true;
      }
    }
    if (separator < 0) break;
    cursor = separator + 1;
  }
  return false;
}

/**
 * Captures and scrubs a marked OAB launch synchronously, before the caller
 * parses a marker or consults discovery. The WeakSet brand prevents a caller
 * from bypassing capture by forging the internal handoff object.
 */
export function captureIncomingHandoffFragment(
  windowRef,
  markerNames = ["oab-link", "oab-detached"],
) {
  if (
    !windowRef?.location ||
    typeof windowRef?.history?.replaceState !== "function"
  ) {
    throw new OabError(
      "browser_required",
      "A browser window with History API support is required.",
    );
  }
  if (
    !Array.isArray(markerNames) ||
    markerNames.length === 0 ||
    markerNames.some((name) => typeof name !== "string" || !name)
  ) {
    throw new TypeError("markerNames must be a non-empty string array.");
  }
  const fragment = typeof windowRef.location.hash === "string"
    ? windowRef.location.hash
    : String(windowRef.location.hash || "");
  if (!hasNamedFragmentMarker(fragment, markerNames)) return null;
  const href = typeof windowRef.location.href === "string"
    ? windowRef.location.href
    : String(windowRef.location.href || "");
  const origin = typeof windowRef.location.origin === "string"
    ? windowRef.location.origin
    : String(windowRef.location.origin || "");
  const pathname = typeof windowRef.location.pathname === "string"
    ? windowRef.location.pathname
    : String(windowRef.location.pathname || "");
  const search = typeof windowRef.location.search === "string"
    ? windowRef.location.search
    : String(windowRef.location.search || "");
  windowRef.history.replaceState(
    windowRef.history.state ?? null,
    "",
    windowRef.location.pathname || "/",
  );
  if (windowRef.location.hash || windowRef.location.search) {
    throw new OabError(
      "handoff_fragment_not_scrubbed",
      "The receiver could not remove the captured OAB fragment and query.",
    );
  }
  // Check cheap code-unit ceilings before allocating UTF-8 buffers. A UTF-8
  // encoding can never contain fewer bytes than JavaScript code units.
  if (
    fragment.length > INCOMING_HANDOFF_CAPTURE_LIMITS.maximumFragmentBytes ||
    utf8Encoder.encode(fragment.replace(/^#/u, "")).byteLength >
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumFragmentBytes
  ) {
    throw new OabError(
      "handoff_fragment_too_large",
      `An OAB launch fragment must not exceed ${INCOMING_HANDOFF_CAPTURE_LIMITS.maximumFragmentBytes} bytes.`,
    );
  }
  if (
    href.length > INCOMING_HANDOFF_CAPTURE_LIMITS.maximumUrlBytes ||
    utf8Encoder.encode(href).byteLength >
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumUrlBytes ||
    origin.length > INCOMING_HANDOFF_CAPTURE_LIMITS.maximumOriginBytes ||
    utf8Encoder.encode(origin).byteLength >
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumOriginBytes ||
    pathname.length > INCOMING_HANDOFF_CAPTURE_LIMITS.maximumPathBytes ||
    utf8Encoder.encode(pathname).byteLength >
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumPathBytes ||
    search.length > INCOMING_HANDOFF_CAPTURE_LIMITS.maximumQueryBytes ||
    utf8Encoder.encode(search).byteLength >
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumQueryBytes
  ) {
    throw new OabError(
      "handoff_url_too_large",
      `The captured OAB launch location exceeds its bounded capture limits.`,
    );
  }
  const capture = {
    fragment,
    href,
    origin,
    pathname,
    search,
    hadQuery: Boolean(search),
  };
  const frozen = Object.freeze(capture);
  capturedIncomingHandoffs.add(frozen);
  return frozen;
}

function exactCaptureKeys(value, expectedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => Object.hasOwn(descriptor, "value"),
    )
  );
}

function boundedCaptureString(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.length <= maximumBytes &&
    utf8Encoder.encode(value).byteLength <= maximumBytes
  );
}

/**
 * Adopts the closure-local result of a parser-blocking scrub-first bootstrap.
 * The plain public value is deliberately revalidated against both its complete
 * pre-scrub URL and the browser's current already-clean location, then copied
 * into the runtime-branded one-use capture expected by the profile parsers.
 */
export function adoptScrubbedIncomingHandoff(windowRef, value) {
  if (
    !windowRef?.location ||
    !exactCaptureKeys(value, [
      "fragment",
      "href",
      "origin",
      "pathname",
      "search",
    ]) ||
    !Object.isFrozen(value) ||
    adoptedScrubbedIncomingHandoffs.has(value) ||
    !boundedCaptureString(
      value.fragment,
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumFragmentBytes,
    ) ||
    !boundedCaptureString(
      value.href,
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumUrlBytes,
    ) ||
    !boundedCaptureString(
      value.origin,
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumOriginBytes,
    ) ||
    !boundedCaptureString(
      value.pathname,
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumPathBytes,
    ) ||
    !boundedCaptureString(
      value.search,
      INCOMING_HANDOFF_CAPTURE_LIMITS.maximumQueryBytes,
    ) ||
    windowRef.location.hash ||
    windowRef.location.search
  ) {
    throw new OabError(
      "invalid_handoff_capture",
      "The scrub-first receiver handoff is invalid or the current URL is not clean.",
    );
  }

  let capturedUrl;
  let currentUrl;
  try {
    capturedUrl = new URL(value.href);
    currentUrl = new URL(windowRef.location.href);
  } catch (error) {
    throw new OabError(
      "invalid_handoff_capture",
      "The scrub-first receiver handoff contains an invalid URL.",
      { cause: error },
    );
  }
  if (
    !value.fragment.startsWith("#") ||
    capturedUrl.username ||
    capturedUrl.password ||
    capturedUrl.href !== value.href ||
    capturedUrl.origin !== value.origin ||
    capturedUrl.pathname !== value.pathname ||
    capturedUrl.search !== value.search ||
    capturedUrl.hash !== value.fragment ||
    currentUrl.username ||
    currentUrl.password ||
    currentUrl.origin !== value.origin ||
    currentUrl.pathname !== value.pathname ||
    currentUrl.search ||
    currentUrl.hash ||
    currentUrl.href !== new URL(value.pathname, value.origin).href ||
    windowRef.location.origin !== value.origin ||
    windowRef.location.pathname !== value.pathname
  ) {
    throw new OabError(
      "invalid_handoff_capture",
      "The captured receiver location does not match its complete pre-scrub URL and current clean endpoint.",
    );
  }

  const capture = Object.freeze({
    fragment: value.fragment,
    href: capturedUrl.href,
    origin: value.origin,
    pathname: value.pathname,
    search: value.search,
    hadQuery: Boolean(value.search),
  });
  adoptedScrubbedIncomingHandoffs.add(value);
  capturedIncomingHandoffs.add(capture);
  return capture;
}

export function assertCapturedIncomingHandoff(value) {
  if (!value || !capturedIncomingHandoffs.has(value)) {
    throw new OabError(
      "invalid_handoff_capture",
      "The supplied handoff was not synchronously captured by this runtime.",
    );
  }
  return value;
}

export function isValidRequestId(value) {
  if (
    typeof value !== "string" ||
    !REQUEST_ID_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    return false;
  }
  // Canonical unpadded base64url requires unused low bits in the last symbol
  // to be zero. Checking the terminal alphabet avoids accepting aliases that
  // decode to the same bytes under forgiving browser decoders.
  if (value.length % 4 === 2 && !/[AQgw]$/u.test(value)) return false;
  if (
    value.length % 4 === 3 &&
    !/[AEIMQUYcgkosw048]$/u.test(value)
  ) {
    return false;
  }
  return true;
}

export function isLoopbackHostname(value) {
  const hostname = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1"
  ) {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/u.test(octet) && Number.parseInt(octet, 10) <= 255,
    )
  );
}

export function assertSecureContext(windowRef, role = "application") {
  if (windowRef?.isSecureContext !== true) {
    throw new OabError(
      "secure_context_required",
      `The OAB ${role} must run in a secure browser context. Use HTTPS; ` +
        "HTTP is allowed only for loopback development.",
    );
  }
}

export function canonicalOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new OabError("invalid_origin", "Enter a valid receiver origin.");
  }
  const localDevelopment =
    url.protocol === "http:" && isLoopbackHostname(url.hostname);
  const originOnly =
    !url.username &&
    !url.password &&
    (url.pathname === "" || url.pathname === "/") &&
    !url.search &&
    !url.hash;
  if (!originOnly || (url.protocol !== "https:" && !localDevelopment)) {
    throw new OabError(
      "invalid_origin",
      "Use an HTTPS origin without a path, query, fragment, or credentials. " +
      "HTTP is accepted only for loopback development.",
    );
  }
  return url.origin;
}

export function receiverEndpoint(origin, value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("%")
  ) {
    throw new OabError(
      "invalid_declaration",
      "The receiver endpoint must be a safe, unencoded absolute path.",
    );
  }
  if (
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new OabError(
      "invalid_declaration",
      "The receiver endpoint must not contain path traversal segments.",
    );
  }
  const url = new URL(value, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new OabError(
      "invalid_declaration",
      "The receiver endpoint must remain on the declared origin.",
    );
  }
  if (new TextEncoder().encode(url.href).byteLength > 2048) {
    throw new OabError(
      "invalid_declaration",
      "OAB endpoint URLs must not exceed 2048 bytes.",
    );
  }
  return url.href;
}

export function cleanText(value, maximumLength) {
  if (!isUnicodeScalarString(value)) return null;
  const clean = value.normalize("NFC").trim();
  if (!clean || UNSAFE_DISPLAY_TEXT.test(clean)) return null;
  return Array.from(clean).length <= maximumLength ? clean : null;
}

export function isUnicodeScalarString(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function assertSafeDisplayText(
  value,
  maximumLength,
  label = "Display text",
) {
  if (value == null) return null;
  const clean = cleanText(value, maximumLength);
  if (clean == null) {
    throw new OabError(
      "invalid_display_text",
      `${label} must be single-line NFC text without control or bidirectional override characters and at most ${maximumLength} characters.`,
    );
  }
  return clean;
}

export function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    // Source URLs are optional display claims. Query strings and fragments
    // frequently contain tokens, search terms, or document-local secrets and
    // are never needed by the transport.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch (_) {
    return null;
  }
}

export function randomToken(byteLength = 32) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new TypeError("Token entropy must be between 16 and 64 bytes.");
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((value) => value === 0)) {
    throw new OabError(
      "secure_random_unavailable",
      "A cryptographically secure random generator is required.",
    );
  }
  return Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertTopLevelContext(windowRef, role = "receiver") {
  if (!windowRef || windowRef.top !== windowRef || windowRef.self !== windowRef) {
    throw new OabError(
      "top_level_context_required",
      `The OAB ${role} must run in a top-level browsing context.`,
    );
  }
}

export async function admitIncomingHandoff(callback, request, options = {}) {
  if (typeof callback !== "function") {
    throw new OabError(
      "handoff_admission_required",
      "A bounded atomic replay-and-session admission callback is required.",
    );
  }
  const timeoutMs = options.handoffAdmissionTimeoutMs ??
    DEFAULT_HANDOFF_ADMISSION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > MAXIMUM_HANDOFF_ADMISSION_TIMEOUT_MS
  ) {
    throw new TypeError(
      `handoffAdmissionTimeoutMs must be an integer from 100 to ${MAXIMUM_HANDOFF_ADMISSION_TIMEOUT_MS}.`,
    );
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OabError(
      "handoff_admission_timeout",
      "The receiver replay-and-session admission did not complete before its deadline.",
    )), timeoutMs);
    timer.unref?.();
  });
  const callbackResult = Promise.resolve().then(() =>
    callback(Object.freeze(request)));
  const reportReleaseFailure = (error) => {
    try {
      options.onCleanupError?.(Object.freeze({
        operation: "handoff-admission-release",
        error,
      }));
    } catch (_) {}
  };
  const releaseLateAdmission = (result) => {
    if (typeof result?.release === "function") {
      try {
        Promise.resolve(result.release()).catch(reportReleaseFailure);
      } catch (error) {
        reportReleaseFailure(error);
      }
    }
  };
  let result;
  try {
    result = await Promise.race([
      callbackResult,
      timeout,
    ]);
  } catch (error) {
    callbackResult.then(releaseLateAdmission).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const keys = result && typeof result === "object" && !Array.isArray(result)
    ? Object.keys(result).sort()
    : [];
  if (
    result?.admitted === false &&
    ["replay", "session-capacity", "replay-capacity"].includes(result.reason) &&
    keys.length === 2 &&
    keys[0] === "admitted" &&
    keys[1] === "reason"
  ) {
    return Object.freeze({ admitted: false, reason: result.reason });
  }
  if (
    result?.admitted !== true ||
    typeof result.promote !== "function" ||
    typeof result.release !== "function" ||
    keys.length !== 3 ||
    keys[0] !== "admitted" ||
    keys[1] !== "promote" ||
    keys[2] !== "release"
  ) {
    releaseLateAdmission(result);
    throw new OabError(
      "invalid_handoff_admission",
      "The receiver returned an invalid handoff admission decision.",
    );
  }
  let released = false;
  let promoted = false;
  let promotionPromise = null;
  const releaseHost = () => {
    try {
      return Promise.resolve(result.release()).catch(reportReleaseFailure);
    } catch (error) {
      reportReleaseFailure(error);
      return Promise.resolve();
    }
  };
  const release = () => {
    if (released) return Promise.resolve();
    released = true;
    return releaseHost();
  };
  return Object.freeze({
    admitted: true,
    promote(expiresAt) {
      if (released) {
        return Promise.reject(new OabError(
          "session_promotion_failed",
          "The pending handoff admission was already released.",
        ));
      }
      if (promoted) return Promise.resolve();
      if (promotionPromise) return promotionPromise;
      if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
        return Promise.reject(new TypeError(
          "The promoted session expiry must be a non-negative integer timestamp.",
        ));
      }
      const promotionTimeoutMs = options.sessionPromotionTimeoutMs ??
        DEFAULT_SESSION_PROMOTION_TIMEOUT_MS;
      if (
        !Number.isSafeInteger(promotionTimeoutMs) ||
        promotionTimeoutMs < 100 ||
        promotionTimeoutMs > MAXIMUM_SESSION_PROMOTION_TIMEOUT_MS
      ) {
        return Promise.reject(new TypeError(
          `sessionPromotionTimeoutMs must be an integer from 100 to ${MAXIMUM_SESSION_PROMOTION_TIMEOUT_MS}.`,
        ));
      }
      promotionPromise = (async () => {
        let promotionTimer;
        const promotionTimeout = new Promise((_, reject) => {
          promotionTimer = setTimeout(() => reject(new OabError(
            "session_promotion_timeout",
            "The pending handoff admission was not promoted before its deadline.",
          )), promotionTimeoutMs);
          promotionTimer.unref?.();
        });
        const hostPromotion = Promise.resolve().then(() =>
          result.promote(Object.freeze({ expiresAt })));
        try {
          const promotedResult = await Promise.race([
            hostPromotion,
            promotionTimeout,
          ]);
          if (promotedResult !== true) {
            throw new OabError(
              "session_promotion_failed",
              "The receiver could not promote the pending handoff admission.",
            );
          }
          promoted = true;
        } catch (error) {
          // A timed-out host operation may still settle after the first
          // release. Invoke the required idempotent host release again after
          // late settlement so a late promotion cannot strand capacity.
          hostPromotion.then(releaseHost, () => {});
          throw error;
        } finally {
          clearTimeout(promotionTimer);
        }
      })().catch(async (error) => {
        await release();
        throw error;
      });
      return promotionPromise;
    },
    release,
  });
}

export async function acquireIncomingByteReservation(
  callback,
  request,
  options = {},
) {
  if (typeof callback !== "function") {
    throw new OabError(
      "byte_reservation_required",
      "A bounded atomic origin-wide incoming-byte reservation callback is required.",
    );
  }
  const timeoutMs = options.byteReservationTimeoutMs ??
    DEFAULT_BYTE_RESERVATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > MAXIMUM_BYTE_RESERVATION_TIMEOUT_MS
  ) {
    throw new TypeError(
      `byteReservationTimeoutMs must be an integer from 100 to ${MAXIMUM_BYTE_RESERVATION_TIMEOUT_MS}.`,
    );
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OabError(
      "byte_reservation_timeout",
      "The receiver byte reservation did not complete before its deadline.",
    )), timeoutMs);
    timer.unref?.();
  });
  const callbackResult = Promise.resolve().then(() =>
    callback(Object.freeze(request)));
  const reportReleaseFailure = (error) => {
    try {
      options.onCleanupError?.(Object.freeze({
        operation: "byte-reservation-release",
        error,
      }));
    } catch (_) {}
  };
  const releaseLateReservation = (result) => {
    if (result?.reserved === true && typeof result.release === "function") {
      try {
        Promise.resolve(result.release()).catch(reportReleaseFailure);
      } catch (error) {
        reportReleaseFailure(error);
      }
    }
  };

  let result;
  try {
    result = await Promise.race([callbackResult, timeout]);
  } catch (error) {
    callbackResult.then(releaseLateReservation).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const keys = result && typeof result === "object" && !Array.isArray(result)
    ? Object.keys(result).sort()
    : [];
  if (
    result?.reserved !== true ||
    typeof result.release !== "function" ||
    keys.length !== 2 ||
    keys[0] !== "release" ||
    keys[1] !== "reserved"
  ) {
    releaseLateReservation(result);
    throw new OabError(
      "aggregate_byte_capacity_exceeded",
      "The receiver cannot reserve bounded memory for this handoff.",
    );
  }

  let released = false;
  return Object.freeze({
    release() {
      if (released) return Promise.resolve();
      released = true;
      try {
        return Promise.resolve(result.release()).catch(reportReleaseFailure);
      } catch (error) {
        reportReleaseFailure(error);
        return Promise.resolve();
      }
    },
  });
}

const HANDOFF_ANCHOR_REL = "noopener noreferrer";
const HANDOFF_REFERRER_POLICY = "no-referrer";
const FORBIDDEN_HANDOFF_ANCHOR_ATTRIBUTES = Object.freeze([
  "attributionsrc",
  "download",
  "ping",
]);
const HANDOFF_ANCHOR_GUARDS = new WeakMap();

function removeHandoffAnchorGuards(anchor) {
  const guards = HANDOFF_ANCHOR_GUARDS.get(anchor);
  if (!guards) return;
  for (const [type, listener] of guards) {
    anchor.removeEventListener(type, listener, { capture: true });
  }
  HANDOFF_ANCHOR_GUARDS.delete(anchor);
}

function installHandoffAnchorGuards(anchor, onRejectedActivation) {
  removeHandoffAnchorGuards(anchor);
  let rejected = false;
  const block = (event) => {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    if (rejected) return;
    rejected = true;
    try {
      onRejectedActivation?.(event);
    } catch (_) {}
  };
  const blockNonPrimaryPointer = (event) => {
    if (event.button !== 0) block(event);
  };
  const guards = [
    ["auxclick", block],
    ["contextmenu", block],
    ["dragstart", block],
    ["mousedown", blockNonPrimaryPointer],
    ["pointerdown", blockNonPrimaryPointer],
  ];
  for (const [type, listener] of guards) {
    anchor.addEventListener(type, listener, { capture: true });
  }
  HANDOFF_ANCHOR_GUARDS.set(anchor, guards);
}

function assertAnchorElement(anchor) {
  if (
    !anchor ||
    String(anchor.tagName ?? "").toUpperCase() !== "A" ||
    typeof anchor.removeAttribute !== "function" ||
    typeof anchor.addEventListener !== "function" ||
    typeof anchor.removeEventListener !== "function"
  ) {
    throw new OabError(
      "native_anchor_required",
      "A handoff capability must be bound to an HTML anchor element.",
    );
  }
  return anchor;
}

/**
 * Binds a prepared navigation capability to one exact native anchor. Keeping
 * this operation in the SDK lets expiry remove the actual DOM capability,
 * rather than merely clearing an internal copy of the URL.
 */
export function bindNativeHandoffAnchor(
  anchorValue,
  href,
  onRejectedActivation,
) {
  const anchor = assertAnchorElement(anchorValue);
  if (typeof href !== "string" || href.length === 0) {
    throw new OabError(
      "invalid_handoff_href",
      "A prepared handoff URL is required before binding an anchor.",
    );
  }
  for (const attribute of FORBIDDEN_HANDOFF_ANCHOR_ATTRIBUTES) {
    anchor.removeAttribute(attribute);
  }
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = HANDOFF_ANCHOR_REL;
  anchor.referrerPolicy = HANDOFF_REFERRER_POLICY;
  installHandoffAnchorGuards(anchor, onRejectedActivation);
  return anchor;
}

/**
 * Fails closed if a host mutates or misbinds the prepared native navigation.
 * stopImmediatePropagation prevents a later click listener from changing the
 * security attributes after validation and before the browser default action.
 */
export function assertNativeHandoffAnchor(event, boundAnchor, href) {
  const anchor = assertAnchorElement(boundAnchor);
  const hasForbiddenAttribute = FORBIDDEN_HANDOFF_ANCHOR_ATTRIBUTES.some(
    (attribute) => anchor.hasAttribute?.(attribute) === true,
  );
  if (
    event?.currentTarget !== anchor ||
    event.defaultPrevented === true ||
    anchor.href !== href ||
    anchor.target !== "_blank" ||
    anchor.rel !== HANDOFF_ANCHOR_REL ||
    anchor.referrerPolicy !== HANDOFF_REFERRER_POLICY ||
    hasForbiddenAttribute
  ) {
    throw new OabError(
      "unsafe_handoff_anchor",
      "The handoff anchor no longer matches its prepared no-opener, no-referrer navigation capability.",
    );
  }
  event.stopImmediatePropagation?.();
  return anchor;
}

export function clearNativeHandoffAnchor(anchorValue) {
  if (!anchorValue || typeof anchorValue.removeAttribute !== "function") return;
  removeHandoffAnchorGuards(anchorValue);
  anchorValue.removeAttribute("href");
}
