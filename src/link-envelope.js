import {
  DEFAULT_LIMITS,
  LINK_ENVELOPE_REPRESENTATIONS,
  OAB_PROTOCOL,
  OAB_TRANSPORTS,
  OAB_VERSION,
} from "./constants.js";
import {
  assertContentMatchesReceiver,
  isPreparedContent,
  prepareContent,
} from "./content.js";
import { assertFreshDeclaration } from "./discovery-document.js";
import { OabError } from "./errors.js";
import {
  admitIncomingHandoff,
  assertCapturedIncomingHandoff,
  assertSafeDisplayText,
  assertSecureContext,
  canonicalOrigin,
  captureIncomingHandoffFragment,
  cleanText,
  isLoopbackHostname,
  isValidRequestId,
  safeSourceUrl,
} from "./internal.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const LINK_ENVELOPE_MARKER = "oab-link";
const LINK_ENVELOPE_VERSION = "1";
const MAXIMUM_LINK_ENVELOPE_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 30 * 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SHA256_BASE64URL_LENGTH = 43;
const UI_METADATA_FORBIDDEN_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

function currentTime(options) {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now() must return a non-negative integer timestamp.");
  }
  return now;
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new OabError(
      "crypto_unavailable",
      "The link-envelope profile requires Web Crypto support.",
    );
  }
  return globalThis.crypto;
}

function encodeBase64Url(bytes) {
  if (typeof globalThis.btoa !== "function") {
    throw new OabError(
      "base64_unavailable",
      "The link-envelope profile requires a base64 encoder.",
    );
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCanonicalBase64Url(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value) ||
    typeof globalThis.atob !== "function"
  ) {
    throw new OabError(
      "invalid_link_envelope",
      `${label} is not canonical unpadded base64url data.`,
    );
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary;
  try {
    binary = globalThis.atob(padded);
  } catch (error) {
    throw new OabError(
      "invalid_link_envelope",
      `${label} could not be decoded.`,
      { cause: error },
    );
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) {
    throw new OabError(
      "invalid_link_envelope",
      `${label} is not in its canonical base64url form.`,
    );
  }
  return bytes;
}

async function sha256Base64Url(bytes) {
  const digest = await requireCrypto().subtle.digest("SHA-256", bytes);
  return encodeBase64Url(new Uint8Array(digest));
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function unicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// RFC 8785 JSON Canonicalization Scheme, restricted to the envelope's
// interoperable subset (finite safe integers, arrays, objects, strings,
// booleans, and null).
function canonicalValue(value, depth = 0) {
  if (depth > 32) {
    throw new OabError(
      "invalid_link_envelope",
      "The envelope exceeds the canonical JSON nesting limit.",
    );
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (!unicodeScalarString(value)) {
      throw new OabError(
        "invalid_link_envelope",
        "Canonical link JSON must contain Unicode scalar strings.",
      );
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item, depth + 1));
  }
  if (plainObject(value)) {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      if (
        !key ||
        !unicodeScalarString(key) ||
        typeof value[key] === "undefined"
      ) {
        throw new OabError(
          "invalid_link_envelope",
          "The envelope is outside the canonical JSON value set.",
        );
      }
      canonical[key] = canonicalValue(value[key], depth + 1);
    }
    return canonical;
  }
  throw new OabError(
    "invalid_link_envelope",
    "The envelope is outside the canonical JSON value set.",
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function exactObject(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sanitizeUiMetadata(value, maximumLength) {
  if (typeof value !== "string") return null;
  const sanitized = value
    .normalize("NFC")
    .replace(UI_METADATA_FORBIDDEN_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!sanitized) return null;
  return Array.from(sanitized).slice(0, maximumLength).join("");
}

function safeSourceClaimUrl(value) {
  const normalized = safeSourceUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  return url.username || url.password ? null : url.href;
}

function createRequestId(options) {
  if (options.randomToken != null) {
    if (typeof options.randomToken !== "function") {
      throw new TypeError("randomToken must be a function when provided.");
    }
    const supplied = options.randomToken();
    if (!isValidRequestId(supplied)) {
      throw new OabError(
        "invalid_request_id",
        "Custom request identifiers must contain 22–128 base64url characters and provide at least 128 bits of entropy.",
      );
    }
    return supplied;
  }
  const bytes = new Uint8Array(24);
  requireCrypto().getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function profileLimits(receiver, options) {
  const profile = receiver.linkEnvelope ??
    receiver.transports?.[OAB_TRANSPORTS.linkEnvelope];
  const limits = profile?.limits ?? profile;
  if (!profile || !plainObject(limits)) {
    throw new OabError(
      "invalid_declaration",
      "The receiver's link-envelope capabilities are missing.",
    );
  }
  const receiverUrl = positiveLimit(limits.maximumUrlBytes, "maximumUrlBytes");
  const receiverFragment = positiveLimit(
    limits.maximumFragmentBytes,
    "maximumFragmentBytes",
  );
  const receiverDecoded = positiveLimit(
    limits.maximumDecodedBytes,
    "maximumDecodedBytes",
  );
  if (receiverFragment > receiverUrl || receiverDecoded > receiverFragment) {
    throw new OabError(
      "invalid_declaration",
      "The receiver's link-envelope size limits are inconsistent.",
    );
  }
  const maximumUrlBytes = Math.min(
    receiverUrl,
    positiveLimit(
      options.maximumUrlBytes ?? DEFAULT_LIMITS.maximumLinkEnvelopeUrlBytes,
      "maximumUrlBytes",
    ),
  );
  const maximumFragmentBytes = Math.min(
    receiverFragment,
    positiveLimit(
      options.maximumFragmentBytes ??
        DEFAULT_LIMITS.maximumLinkEnvelopeFragmentBytes,
      "maximumFragmentBytes",
    ),
  );
  const maximumDecodedBytes = Math.min(
    receiverDecoded,
    positiveLimit(
      options.maximumDecodedBytes ??
        DEFAULT_LIMITS.maximumLinkEnvelopeDecodedBytes,
      "maximumDecodedBytes",
    ),
  );
  return Object.freeze({
    maximumUrlBytes,
    maximumFragmentBytes: Math.min(maximumFragmentBytes, maximumUrlBytes),
    maximumDecodedBytes: Math.min(
      maximumDecodedBytes,
      maximumFragmentBytes,
      maximumUrlBytes,
    ),
  });
}

function decoderLimits(options) {
  const requestedUrlBytes = positiveLimit(
    options.maximumUrlBytes ?? DEFAULT_LIMITS.maximumLinkEnvelopeUrlBytes,
    "maximumUrlBytes",
  );
  const requestedFragmentBytes = positiveLimit(
    options.maximumFragmentBytes ??
      DEFAULT_LIMITS.maximumLinkEnvelopeFragmentBytes,
    "maximumFragmentBytes",
  );
  const requestedDecodedBytes = positiveLimit(
    options.maximumDecodedBytes ??
      DEFAULT_LIMITS.maximumLinkEnvelopeDecodedBytes,
    "maximumDecodedBytes",
  );
  if (
    requestedUrlBytes > 64 * 1024 ||
    requestedFragmentBytes > 32 * 1024 ||
    requestedDecodedBytes > 24 * 1024
  ) {
    throw new TypeError(
      "Link-envelope limits exceed the protocol hard ceilings.",
    );
  }
  const maximumUrlBytes = requestedUrlBytes;
  const maximumFragmentBytes = requestedFragmentBytes;
  const maximumDecodedBytes = requestedDecodedBytes;
  if (
    maximumFragmentBytes > maximumUrlBytes ||
    maximumDecodedBytes > maximumFragmentBytes
  ) {
    throw new TypeError(
      "Link-envelope limits must satisfy decoded <= fragment <= URL bytes.",
    );
  }
  return { maximumUrlBytes, maximumFragmentBytes, maximumDecodedBytes };
}

function linkEnvelopeLifetime(options) {
  const lifetime = options.lifetimeMs ?? DEFAULT_LIMITS.linkEnvelopeTtlMs;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime <= 0 ||
    lifetime > MAXIMUM_LINK_ENVELOPE_LIFETIME_MS
  ) {
    throw new TypeError(
      `lifetimeMs must be an integer from 1 to ${MAXIMUM_LINK_ENVELOPE_LIFETIME_MS}.`,
    );
  }
  return lifetime;
}

function acceptedRepresentations(options) {
  const representations = options.representations ??
    LINK_ENVELOPE_REPRESENTATIONS;
  if (
    !Array.isArray(representations) ||
    representations.length === 0 ||
    new Set(representations).size !== representations.length ||
    representations.some(
      (type) => !LINK_ENVELOPE_REPRESENTATIONS.includes(type),
    )
  ) {
    throw new TypeError(
      "representations must be a unique non-empty subset of text/markdown and text/plain.",
    );
  }
  return representations;
}

function acceptedWireVersions(options) {
  const versions = options.acceptedWireVersions ?? [OAB_VERSION];
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    new Set(versions).size !== versions.length ||
    versions.some(
      (version) =>
        typeof version !== "string" ||
        !/^[1-9][0-9]*\.[0-9]+(?:-[a-z0-9.-]+)?$/u.test(version),
    )
  ) {
    throw new TypeError(
      "acceptedWireVersions must be a unique non-empty wire-version list.",
    );
  }
  return versions;
}

function assertLinkEnvelopeContent(receiver, content) {
  if (!receiver.supportsTransport(OAB_TRANSPORTS.linkEnvelope)) {
    throw new OabError(
      "unsupported_transport",
      `The receiver does not advertise ${OAB_TRANSPORTS.linkEnvelope}.`,
    );
  }
  const profile = receiver.linkEnvelope ??
    receiver.transports?.[OAB_TRANSPORTS.linkEnvelope];
  const profileRepresentations = profile?.representations;
  const profileAssets = profile?.assetTypes ?? [];
  if (
    !Array.isArray(profileRepresentations) ||
    profileRepresentations.length === 0 ||
    profileRepresentations.some(
      (type) =>
        !LINK_ENVELOPE_REPRESENTATIONS.includes(type) ||
        !receiver.representations.includes(type),
    ) ||
    !Array.isArray(profileAssets) ||
    profileAssets.length !== 0
  ) {
    throw new OabError(
      "invalid_declaration",
      "The receiver's link-envelope media declaration is invalid.",
    );
  }
  if (content.assets.length > 0) {
    throw new OabError(
      "link_envelope_assets_unsupported",
      "link-envelope/1 never carries assets.",
    );
  }
  if (content.representationTypes.includes("text/html")) {
    throw new OabError(
      "link_envelope_html_unsupported",
      "link-envelope/1 never carries HTML.",
    );
  }
  assertContentMatchesReceiver(content, receiver);
  const unsupported = content.representationTypes.find(
    (type) => !profileRepresentations.includes(type),
  );
  if (unsupported) {
    throw new OabError(
      "unsupported_representation",
      `The receiver does not accept ${unsupported} over link-envelope/1.`,
    );
  }
}

function assertNonConfidentialChoice(options) {
  if (options.contentClassification !== "non-confidential") {
    throw new OabError(
      "link_envelope_exposure_not_accepted",
      "Select link-envelope/1 explicitly and classify its content as non-confidential. It must never be an automatic fallback.",
    );
  }
}

function secureLaunchUrl(value, fragment, options, maximumUrlBytes) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("launchUrl is required to enforce the complete URL limit.");
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OabError("invalid_link_envelope", "The launch URL is invalid.", {
      cause: error,
    });
  }
  const localDevelopment =
    url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.username ||
    url.password ||
    url.hash !== `#${fragment}`
  ) {
    throw new OabError(
      "invalid_link_envelope",
      "The launch must be an HTTPS URL whose fragment exactly matches the envelope.",
    );
  }
  if (encoder.encode(url.href).byteLength > maximumUrlBytes) {
    throw new OabError(
      "link_envelope_url_too_large",
      `The complete launch URL exceeds ${maximumUrlBytes} bytes.`,
    );
  }
  if (options.expectedEndpoint != null) {
    let expected;
    try {
      expected = new URL(options.expectedEndpoint);
    } catch (error) {
      throw new TypeError("expectedEndpoint must be an absolute URL.", {
        cause: error,
      });
    }
    if (
      expected.hash ||
      expected.search ||
      expected.username ||
      expected.password ||
      expected.origin !== url.origin ||
      expected.pathname !== url.pathname ||
      url.search
    ) {
      throw new OabError(
        "link_envelope_endpoint_mismatch",
        "The launch URL does not match the receiver's non-redirecting endpoint.",
      );
    }
  }
  return url;
}

/**
 * Creates the low-assurance, text-only transport. Calling this function is an
 * explicit profile selection: it never falls back from another transport.
 */
export async function createLinkEnvelopeHandoff(
  receiverValue,
  contentValue,
  options = {},
) {
  assertNonConfidentialChoice(options);
  const now = currentTime(options);
  const receiver = assertFreshDeclaration(receiverValue, now);
  const content = isPreparedContent(contentValue)
    ? contentValue
    : prepareContent(contentValue);
  assertLinkEnvelopeContent(receiver, content);
  const limits = profileLimits(receiver, options);

  const title = sanitizeUiMetadata(content.title, 240);
  const sourceApplication = sanitizeUiMetadata(content.sourceApplication, 120);
  const envelope = {
    protocol: OAB_PROTOCOL,
    wireVersion: receiver.selectedVersion,
    transport: OAB_TRANSPORTS.linkEnvelope,
    requestId: createRequestId(options),
    intent: "preview",
    classification: "non-confidential",
    createdAt: now,
    expiresAt: now + linkEnvelopeLifetime(options),
    declarationId: receiver.declarationId,
    title,
    representations: content.representations,
    source: {
      application: sourceApplication,
      url: safeSourceClaimUrl(content.sourceUrl),
    },
  };
  const payloadBytes = encoder.encode(canonicalJson(envelope));
  if (payloadBytes.byteLength > limits.maximumDecodedBytes) {
    throw new OabError(
      "link_envelope_decoded_too_large",
      `The decoded envelope exceeds ${limits.maximumDecodedBytes} bytes.`,
    );
  }
  const payload = encodeBase64Url(payloadBytes);
  const digest = await sha256Base64Url(payloadBytes);
  const fragment =
    `${LINK_ENVELOPE_MARKER}=${LINK_ENVELOPE_VERSION}` +
    `&payload=${payload}&digest=${digest}`;
  const fragmentBytes = encoder.encode(fragment).byteLength;
  if (fragmentBytes > limits.maximumFragmentBytes) {
    throw new OabError(
      "link_envelope_fragment_too_large",
      `The envelope fragment exceeds ${limits.maximumFragmentBytes} bytes.`,
    );
  }

  const url = new URL(receiver.endpoint);
  if (url.hash || url.search || url.username || url.password) {
    throw new OabError(
      "invalid_declaration",
      "The link-envelope endpoint must not contain credentials, a query, or a fragment.",
    );
  }
  url.hash = fragment;
  secureLaunchUrl(url.href, fragment, {}, limits.maximumUrlBytes);
  return Object.freeze({
    transport: OAB_TRANSPORTS.linkEnvelope,
    requestId: envelope.requestId,
    href: url.href,
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer",
    urlBytes: encoder.encode(url.href).byteLength,
    fragmentBytes,
    decodedBytes: payloadBytes.byteLength,
    expiresAt: envelope.expiresAt,
    classification: "non-confidential",
  });
}

/** Strictly decodes one canonical envelope and does not persist its content. */
export async function decodeLinkEnvelopeFragment(fragmentValue, options = {}) {
  const fragment = String(fragmentValue || "").replace(/^#/u, "");
  const limits = decoderLimits(options);
  secureLaunchUrl(options.launchUrl, fragment, options, limits.maximumUrlBytes);
  if (encoder.encode(fragment).byteLength > limits.maximumFragmentBytes) {
    throw new OabError(
      "link_envelope_fragment_too_large",
      `The envelope fragment exceeds ${limits.maximumFragmentBytes} bytes.`,
    );
  }
  const match = fragment.match(
    /^oab-link=1&payload=([A-Za-z0-9_-]+)&digest=([A-Za-z0-9_-]{43})$/u,
  );
  if (!match) {
    throw new OabError(
      "invalid_link_envelope",
      "The launch fragment is non-canonical, malformed, or ambiguous.",
    );
  }

  const payloadBytes = decodeCanonicalBase64Url(match[1], "payload");
  if (payloadBytes.byteLength > limits.maximumDecodedBytes) {
    throw new OabError(
      "link_envelope_decoded_too_large",
      `The decoded envelope exceeds ${limits.maximumDecodedBytes} bytes.`,
    );
  }
  const claimedDigest = match[2];
  if (!BASE64URL_PATTERN.test(claimedDigest)) {
    throw new OabError("invalid_link_envelope", "The digest is malformed.");
  }
  const actualDigest = await sha256Base64Url(payloadBytes);
  if (actualDigest !== claimedDigest) {
    throw new OabError(
      "link_envelope_integrity_failed",
      "The envelope is incomplete or was modified.",
    );
  }

  let envelope;
  let json;
  try {
    json = decoder.decode(payloadBytes);
    envelope = JSON.parse(json);
  } catch (error) {
    throw new OabError(
      "invalid_link_envelope",
      "The envelope is not valid UTF-8 JSON.",
      { cause: error },
    );
  }
  if (canonicalJson(envelope) !== json) {
    throw new OabError(
      "invalid_link_envelope",
      "The envelope JSON is not in the canonical OAB serialization.",
    );
  }
  if (
    !exactObject(envelope, [
      "protocol",
      "wireVersion",
      "transport",
      "requestId",
      "intent",
      "classification",
      "createdAt",
      "expiresAt",
      "declarationId",
      "title",
      "representations",
      "source",
    ]) ||
    envelope.protocol !== OAB_PROTOCOL ||
    !acceptedWireVersions(options).includes(envelope.wireVersion) ||
    envelope.transport !== OAB_TRANSPORTS.linkEnvelope ||
    !isValidRequestId(envelope.requestId) ||
    envelope.intent !== "preview" ||
    envelope.classification !== "non-confidential"
  ) {
    throw new OabError(
      "invalid_link_envelope",
      "The envelope is invalid or uses an unsupported wire version.",
    );
  }

  const now = currentTime(options);
  const maximumClockSkewMs = options.maximumClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ??
    MAXIMUM_LINK_ENVELOPE_LIFETIME_MS;
  if (
    !Number.isSafeInteger(maximumClockSkewMs) ||
    maximumClockSkewMs < 0 ||
    maximumClockSkewMs > DEFAULT_CLOCK_SKEW_MS
  ) {
    throw new TypeError("maximumClockSkewMs must be from 0 to 30000 ms.");
  }
  if (
    !Number.isSafeInteger(maximumLifetimeMs) ||
    maximumLifetimeMs <= 0 ||
    maximumLifetimeMs > MAXIMUM_LINK_ENVELOPE_LIFETIME_MS ||
    !Number.isSafeInteger(envelope.createdAt) ||
    envelope.createdAt < 0 ||
    !Number.isSafeInteger(envelope.expiresAt) ||
    envelope.expiresAt <= envelope.createdAt ||
    envelope.expiresAt - envelope.createdAt > maximumLifetimeMs
  ) {
    throw new OabError(
      "invalid_link_envelope",
      "The envelope lifetime is invalid.",
    );
  }
  if (envelope.createdAt > now + maximumClockSkewMs) {
    throw new OabError(
      "link_envelope_from_future",
      "The link-envelope handoff was created beyond the permitted future clock skew.",
    );
  }
  if (envelope.expiresAt <= now) {
    throw new OabError(
      "link_envelope_expired",
      "The link-envelope handoff has expired.",
    );
  }

  const hasExpectedDeclarationId = Object.hasOwn(options, "declarationId");
  const expectedDeclarationId = options.declarationId ?? null;
  if (
    hasExpectedDeclarationId &&
    envelope.declarationId !== expectedDeclarationId
  ) {
    throw new OabError(
      "discovery_required",
      "The sender did not present the receiver's current declaration identifier.",
    );
  }
  if (
    envelope.declarationId != null &&
    (typeof envelope.declarationId !== "string" ||
      !/^[\x21-\x7e]{8,512}$/u.test(envelope.declarationId))
  ) {
    throw new OabError(
      "invalid_link_envelope",
      "The declaration identifier is invalid.",
    );
  }

  const title = envelope.title == null
    ? null
    : sanitizeUiMetadata(envelope.title, 240);
  if (
    envelope.title != null &&
    (typeof envelope.title !== "string" || title !== envelope.title)
  ) {
    throw new OabError(
      "invalid_link_envelope",
      "The title contains unsafe or non-canonical UI metadata.",
    );
  }
  const representations = acceptedRepresentations(options);
  if (
    !plainObject(envelope.representations) ||
    Object.keys(envelope.representations).length === 0 ||
    Object.keys(envelope.representations).some(
      (type) => !representations.includes(type),
    ) ||
    Object.values(envelope.representations).some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  ) {
    throw new OabError(
      "unsupported_representation",
      "The envelope contains an unsupported or empty text representation.",
    );
  }
  if (!exactObject(envelope.source, ["application", "url"])) {
    throw new OabError(
      "invalid_link_envelope",
      "The unverified source claim is malformed.",
    );
  }
  const sourceApplication = envelope.source.application == null
    ? null
    : sanitizeUiMetadata(envelope.source.application, 120);
  if (
    envelope.source.application != null &&
    (typeof envelope.source.application !== "string" ||
      sourceApplication !== envelope.source.application)
  ) {
    throw new OabError(
      "invalid_link_envelope",
      "The application label contains unsafe or non-canonical UI metadata.",
    );
  }
  const sourceUrl = envelope.source.url == null
    ? null
    : safeSourceClaimUrl(envelope.source.url);
  if (envelope.source.url != null && sourceUrl !== envelope.source.url) {
    throw new OabError(
      "invalid_link_envelope",
      "The unverified source URL is invalid.",
    );
  }

  const maximumTransferBytes = positiveLimit(
    options.maximumTransferBytes ?? limits.maximumDecodedBytes,
    "maximumTransferBytes",
  );
  const prepared = prepareContent(
    {
      title,
      representations: envelope.representations,
      sourceApplication,
      sourceUrl,
    },
    {
      representations,
      assetTypes: [],
      maximumAssets: 0,
      maximumTextBytes: maximumTransferBytes,
      maximumTransferBytes,
    },
  );
  return Object.freeze({
    protocol: OAB_PROTOCOL,
    wireVersion: envelope.wireVersion,
    transport: OAB_TRANSPORTS.linkEnvelope,
    requestId: envelope.requestId,
    intent: "preview",
    classification: "non-confidential",
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    title: prepared.title,
    representations: prepared.representations,
    assets: Object.freeze([]),
    source: Object.freeze({
      origin: null,
      application: sourceApplication,
      url: sourceUrl,
    }),
    evidence: Object.freeze({
      transport: OAB_TRANSPORTS.linkEnvelope,
      originVerified: false,
      appAttested: false,
      userActivationObserved: false,
      declarationIdMatched:
        hasExpectedDeclarationId &&
        envelope.declarationId === expectedDeclarationId,
    }),
  });
}

/**
 * Synchronously captures and removes the fragment before any decoding,
 * authorization, replay check, or delivery work can yield to the event loop.
 */
export async function consumeLinkEnvelope(options = {}) {
  const windowRef = options.windowRef ?? globalThis.window;
  const capture = options.capturedHandoff == null
    ? captureIncomingHandoffFragment(windowRef, [LINK_ENVELOPE_MARKER])
    : assertCapturedIncomingHandoff(options.capturedHandoff);
  if (capture == null) return null;
  const capturedFragment = capture.fragment;
  const capturedHref = capture.href;

  const cancellation = new AbortController();
  let cancellationError = null;
  let expiryTimer = null;
  let sessionLease = null;
  const cancel = (error) => {
    if (cancellation.signal.aborted) return;
    cancellationError = error;
    cancellation.abort(error);
  };
  const onPageHide = () => cancel(new OabError(
    "link_receive_cancelled",
    "The receiver page ended before the transient preview was delivered.",
  ));
  const onExternalAbort = () => cancel(new OabError(
    "link_receive_cancelled",
    "The link-envelope receive operation was cancelled.",
  ));
  windowRef.addEventListener?.("pagehide", onPageHide, { once: true });
  options.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  const cancellationPromise = new Promise((_, reject) => {
    cancellation.signal.addEventListener("abort", () => reject(
      cancellationError ?? new OabError(
        "link_receive_cancelled",
        "The link-envelope receive operation was cancelled.",
      ),
    ), { once: true });
  });
  cancellationPromise.catch(() => {});
  const guarded = (value) => Promise.race([
    Promise.resolve(value),
    cancellationPromise,
  ]);

  try {
    if (cancellation.signal.aborted) throw cancellationError;

    assertSecureContext(windowRef, "link-envelope receiver");
  if (!("top" in windowRef) || windowRef.top !== windowRef) {
    throw new OabError(
      "framed_receiver_forbidden",
      "A link-envelope receiver must run in a top-level browsing context.",
    );
  }
  if (windowRef.opener != null) {
    throw new OabError(
      "unsafe_window_relationship",
      "The receiver refuses link-envelope launches that retain an opener.",
    );
  }
  if (typeof options.expectedEndpoint !== "string") {
    throw new TypeError(
      "expectedEndpoint is required so redirected receiver endpoints fail closed.",
    );
  }
  if (!Object.hasOwn(options, "declarationId")) {
    throw new TypeError(
      "declarationId is required, including an explicit null value, so the launch is bound to the receiver's current discovery declaration.",
    );
  }
  const offer = await guarded(decodeLinkEnvelopeFragment(capturedFragment, {
    ...options,
    launchUrl: capturedHref,
  }));
  const remainingLifetime = offer.expiresAt - currentTime(options);
  if (remainingLifetime <= 0) {
    throw new OabError(
      "link_envelope_expired",
      "The link-envelope handoff expired before receiver processing.",
    );
  }
  expiryTimer = setTimeout(() => cancel(new OabError(
    "link_envelope_expired",
    "The link-envelope handoff expired before receiver processing completed.",
  )), remainingLifetime);
  expiryTimer.unref?.();

  const maximumActiveSessions = options.maximumActiveSessions ??
    DEFAULT_LIMITS.maximumActiveSessions;
  if (
    !Number.isSafeInteger(maximumActiveSessions) ||
    maximumActiveSessions < 1 ||
    maximumActiveSessions > DEFAULT_LIMITS.maximumActiveSessions
  ) {
    throw new TypeError(
      `maximumActiveSessions must be an integer from 1 to ${DEFAULT_LIMITS.maximumActiveSessions}.`,
    );
  }
  const maximumReplayClaims = options.maximumReplayClaims ??
    DEFAULT_LIMITS.maximumReplayClaims;
  if (
    !Number.isSafeInteger(maximumReplayClaims) ||
    maximumReplayClaims < maximumActiveSessions ||
    maximumReplayClaims > DEFAULT_LIMITS.maximumReplayClaims
  ) {
    throw new TypeError(
      `maximumReplayClaims must be an integer from ${maximumActiveSessions} to ${DEFAULT_LIMITS.maximumReplayClaims}.`,
    );
  }
  const admission = admitIncomingHandoff(
    options.admitIncomingHandoff,
    {
      requestId: offer.requestId,
      channelId: null,
      transport: OAB_TRANSPORTS.linkEnvelope,
      replayExpiresAt: offer.expiresAt,
      pendingExpiresAt: Math.min(
        offer.expiresAt,
        currentTime(options) + DEFAULT_LIMITS.pendingAuthorizationTtlMs,
      ),
      maximumActiveSessions,
      maximumReplayClaims,
    },
    options,
  );
  admission.then((lease) => {
    if (cancellation.signal.aborted && sessionLease !== lease) {
      void lease.release();
    }
  }).catch(() => {});
  const admissionDecision = await guarded(admission);
  if (admissionDecision.admitted !== true) {
    const failures = {
      replay: [
        "link_envelope_replayed",
        "This link-envelope handoff was already processed.",
      ],
      "session-capacity": [
        "session_capacity_exceeded",
        "The receiver cannot admit another bounded handoff session.",
      ],
      "replay-capacity": [
        "replay_store_capacity_exceeded",
        "The receiver replay store is temporarily at capacity.",
      ],
    };
    const [code, message] = failures[admissionDecision.reason];
    throw new OabError(code, message);
  }
  sessionLease = admissionDecision;
  if (typeof options.authorizeSender !== "function") {
    throw new OabError(
      "unverified_sender_not_authorized",
      "The receiver must obtain explicit user consent for this unverified app or website.",
    );
  }
  const decision = await guarded(options.authorizeSender({
    requestId: offer.requestId,
    transport: offer.transport,
    classification: offer.classification,
    source: offer.source,
    evidence: offer.evidence,
    signal: cancellation.signal,
  }));
  if (decision?.allowed !== true) {
    throw new OabError(
      "unverified_sender_denied",
      "The receiver declined this link-envelope handoff.",
    );
  }
  await guarded(sessionLease.promote(offer.expiresAt));
  if (typeof options.deliver !== "function") {
    throw new TypeError("A transient preview delivery callback is required.");
  }

  const batchId = `oab_${createRequestId({
    randomToken: options.batchRandomToken,
  })}`;
  const delivery = Object.freeze({
    protocol: offer.protocol,
    wireVersion: offer.wireVersion,
    requestId: offer.requestId,
    batchId,
    intent: offer.intent,
    classification: offer.classification,
    title: offer.title,
    representations: offer.representations,
    assets: offer.assets,
    source: offer.source,
    evidence: Object.freeze({
      ...offer.evidence,
      receiverAuthorized: true,
    }),
  });
  await guarded(options.deliver(delivery, Object.freeze({
    signal: cancellation.signal,
    expiresAt: offer.expiresAt,
  })));
  if (cancellation.signal.aborted) throw cancellationError;
  return delivery;
  } finally {
    if (expiryTimer != null) clearTimeout(expiryTimer);
    await sessionLease?.release();
    windowRef.removeEventListener?.("pagehide", onPageHide);
    options.signal?.removeEventListener?.("abort", onExternalAbort);
  }
}

export const LINK_ENVELOPE_HARD_LIMITS = Object.freeze({
  maximumLifetimeMs: MAXIMUM_LINK_ENVELOPE_LIFETIME_MS,
  maximumClockSkewMs: DEFAULT_CLOCK_SKEW_MS,
  minimumRequestIdBits: 128,
});
