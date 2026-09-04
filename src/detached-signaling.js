import { OabError } from "./errors.js";
import { canonicalOrigin, receiverEndpoint } from "./internal.js";
import {
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
  normalizeP256PublicJwk,
  sha256Base64Url,
} from "./detached-crypto.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const DETACHED_TRANSPORT = "detached-datachannel/1";
export const DETACHED_CHANNEL_LABEL = "oab-1";
export const DETACHED_TRANSPORT_VERSION = "1";
export const DETACHED_PROTOCOL = "org.openapp.bridge";
export const DETACHED_WIRE_VERSION = "1.0";
export const DETACHED_CALLBACK_PATH = "/.well-known/open-app-bridge/callback";

export const DETACHED_SIGNAL_LIMITS = Object.freeze({
  maximumSdpBytes: 64 * 1024,
  maximumSdpLines: 512,
  maximumSdpLineBytes: 4096,
  maximumCandidateBytes: 2048,
  maximumCandidates: 32,
  maximumFragmentBytes: 32 * 1024,
  maximumLifetimeMs: 5 * 60 * 1000,
  maximumClockSkewMs: 30 * 1000,
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const CHANNEL_CAPABILITY_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SHA256_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const CANDIDATE_PATTERN = /^candidate:[A-Za-z0-9+/]+ 1 (?:udp|tcp) \d{1,10} \S+ \d{1,5} typ host(?: .*)?$/iu;

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

function boundedInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new OabError(
      "invalid_detached_signal",
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function boundedText(value, maximum, label, nullable = false) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !value ||
    encoder.encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OabError(
      "invalid_detached_signal",
      `${label} is missing or exceeds its ${maximum}-byte limit.`,
    );
  }
  return value;
}

function sameOriginEndpoint(originValue, endpointValue, label) {
  const origin = canonicalOrigin(originValue);
  let url;
  try {
    url = typeof endpointValue === "string" && endpointValue.startsWith("/")
      ? new URL(receiverEndpoint(origin, endpointValue))
      : new URL(endpointValue);
  } catch (error) {
    throw new OabError(
      "invalid_detached_endpoint",
      `${label} must be an exact same-origin HTTPS endpoint.`,
      { cause: error },
    );
  }
  if (
    encoder.encode(url.href).byteLength > 2048 ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new OabError(
      "invalid_detached_endpoint",
      `${label} must remain on ${origin} without query or fragment data.`,
    );
  }
  return url.href;
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
      "invalid_detached_signal",
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
      "invalid_detached_signal",
      `${label} must be a canonical 32-byte base64url capability.`,
    );
  }
  return value;
}

function declarationId(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    !/^[!-~]+$/u.test(value)
  ) {
    throw new OabError(
      "invalid_detached_signal",
      "declarationId must be null or 8–512 printable ASCII characters.",
    );
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new OabError(
      "invalid_detached_signal",
      `${label} must be an unpadded SHA-256 base64url digest.`,
    );
  }
  return value;
}

export function isPrivateHostCandidateAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.trim().toLowerCase();
  return HOSTNAME_PATTERN.test(address) || LOOPBACK_HOSTS.has(address);
}

export function assertDataOnlySdp(description, options = {}) {
  const expectedType = options.type;
  if (
    !exactKeys(description, ["type", "sdp"]) ||
    description.type !== expectedType ||
    typeof description.sdp !== "string"
  ) {
    throw new OabError(
      "invalid_detached_sdp",
      `Expected an exact browser-generated ${expectedType} description.`,
    );
  }
  const sdpBytes = encoder.encode(description.sdp);
  if (
    sdpBytes.byteLength === 0 ||
    sdpBytes.byteLength > DETACHED_SIGNAL_LIMITS.maximumSdpBytes ||
    /[^\x09\x0a\x0d\x20-\x7e]/u.test(description.sdp) ||
    /(?:^|\r?\n)a=(?:candidate:|end-of-candidates)/iu.test(description.sdp)
  ) {
    throw new OabError(
      "invalid_detached_sdp",
      "The SDP is oversized, contains unsafe characters, or embeds ICE candidates.",
    );
  }
  const lines = description.sdp.split(/\r?\n/u).filter(Boolean);
  if (
    lines.length > DETACHED_SIGNAL_LIMITS.maximumSdpLines ||
    lines.some(
      (line) =>
        encoder.encode(line).byteLength >
        DETACHED_SIGNAL_LIMITS.maximumSdpLineBytes,
    )
  ) {
    throw new OabError(
      "invalid_detached_sdp",
      "The SDP exceeds the detached-channel line limits.",
    );
  }
  const mediaLines = lines.filter((line) => line.startsWith("m="));
  const applicationLines = mediaLines.filter((line) =>
    /^m=application\s/iu.test(line),
  );
  const matching = (pattern) => lines.filter((line) => pattern.test(line));
  const iceUfrags = matching(/^a=ice-ufrag:[A-Za-z0-9+/]{4,256}$/iu);
  const icePasswords = matching(/^a=ice-pwd:[A-Za-z0-9+/]{22,256}$/iu);
  const fingerprints = matching(
    /^a=fingerprint:sha-256 (?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/iu,
  );
  const allFingerprints = matching(/^a=fingerprint:/iu);
  const sctpAttributes = matching(/^a=(?:sctp-port:|sctpmap:)/iu);
  const midAttributes = matching(/^a=mid:[^\s]{1,64}$/u);
  const allMids = matching(/^a=mid:/iu);
  const setupAttributes = matching(/^a=setup:(?:actpass|active|passive)$/iu);
  const allSetupAttributes = matching(/^a=setup:/iu);
  const hasRequired =
    lines[0] === "v=0" &&
    iceUfrags.length === 1 &&
    icePasswords.length === 1 &&
    fingerprints.length === 1 &&
    allFingerprints.length === 1 &&
    sctpAttributes.length === 1 &&
    midAttributes.length === 1 &&
    allMids.length === 1 &&
    setupAttributes.length === 1 &&
    allSetupAttributes.length === 1;
  if (
    mediaLines.length !== 1 ||
    applicationLines.length !== 1 ||
    !hasRequired ||
    lines.some((line) => /^m=(?:audio|video)\s/iu.test(line))
  ) {
    throw new OabError(
      "invalid_detached_sdp",
      "The SDP must describe exactly one data channel and no media tracks.",
    );
  }
  return Object.freeze({ type: description.type, sdp: description.sdp });
}

function dataSdpMid(description) {
  const line = description.sdp
    .split(/\r?\n/u)
    .find((value) => /^a=mid:/u.test(value));
  return line.slice("a=mid:".length);
}

function defaultCandidateFactory(init) {
  if (typeof globalThis.RTCIceCandidate !== "function") {
    throw new OabError(
      "ice_candidate_parser_unavailable",
      "The browser ICE-candidate parser is required.",
    );
  }
  return new globalThis.RTCIceCandidate(init);
}

export function validateHostCandidate(value, options = {}) {
  if (
    !exactKeys(value, [
      "candidate",
      "sdpMid",
      "sdpMLineIndex",
      "usernameFragment",
    ]) ||
    typeof value.candidate !== "string" ||
    encoder.encode(value.candidate).byteLength >
      DETACHED_SIGNAL_LIMITS.maximumCandidateBytes ||
    /[\r\n\u0000]/u.test(value.candidate) ||
    !CANDIDATE_PATTERN.test(value.candidate) ||
    typeof value.sdpMid !== "string" ||
    value.sdpMid.length > 64 ||
    value.sdpMLineIndex !== 0 ||
    (value.usernameFragment !== null &&
      (typeof value.usernameFragment !== "string" ||
        !/^[A-Za-z0-9+/]{4,256}$/u.test(value.usernameFragment)))
  ) {
    throw new OabError(
      "invalid_detached_candidate",
      "The ICE candidate is malformed or does not target the sole data m-line.",
    );
  }
  const fields = value.candidate.split(" ");
  const component = Number(fields[1]);
  const protocol = fields[2].toLowerCase();
  const priority = Number(fields[3]);
  const address = fields[4].toLowerCase();
  const port = Number(fields[5]);
  const extensionFields = fields.slice(8);
  const tcpTypeIndexes = extensionFields.flatMap((field, index) =>
    field.toLowerCase() === "tcptype" ? [index] : []
  );
  const lexicalTcpType = tcpTypeIndexes.length === 1
    ? extensionFields[tcpTypeIndexes[0] + 1]?.toLowerCase()
    : null;
  if (
    component !== 1 ||
    !Number.isSafeInteger(priority) ||
    priority < 0 ||
    priority > 0xffffffff ||
    !["udp", "tcp"].includes(protocol) ||
    !isPrivateHostCandidateAddress(address) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    extensionFields.some((field) =>
      ["raddr", "rport"].includes(field.toLowerCase())
    ) ||
    (protocol === "tcp" &&
      !["active", "passive", "so"].includes(lexicalTcpType)) ||
    (protocol === "udp" && tcpTypeIndexes.length > 0) ||
    value.sdpMid.length === 0 ||
    (options.expectedSdpMid != null &&
      value.sdpMid !== options.expectedSdpMid)
  ) {
    throw new OabError(
      "unsafe_detached_candidate",
      "Only structurally valid browser-obfuscated mDNS or loopback host candidates are allowed.",
    );
  }
  const normalized = Object.freeze({
    candidate: value.candidate,
    sdpMid: value.sdpMid,
    sdpMLineIndex: 0,
    usernameFragment: value.usernameFragment,
  });
  if (options.structuralOnly === true) return normalized;
  let parsed;
  try {
    parsed = (options.candidateFactory ?? defaultCandidateFactory)(value);
  } catch (error) {
    if (error instanceof OabError) throw error;
    throw new OabError(
      "invalid_detached_candidate",
      "The browser rejected the ICE candidate.",
      { cause: error },
    );
  }
  if (
    parsed.type !== "host" ||
    String(parsed.protocol).toLowerCase() !== protocol ||
    String(parsed.address).toLowerCase() !== address ||
    !Number.isSafeInteger(parsed.port) ||
    parsed.port !== port ||
    parsed.relatedAddress != null ||
    parsed.relatedPort != null ||
    (parsed.component != null &&
      ![1, "1", "rtp"].includes(parsed.component)) ||
    (parsed.priority != null && parsed.priority !== priority) ||
    (protocol === "udp" && parsed.tcpType != null) ||
    (protocol === "tcp" &&
      String(parsed.tcpType).toLowerCase() !== lexicalTcpType)
  ) {
    throw new OabError(
      "unsafe_detached_candidate",
      "Only browser-obfuscated mDNS or exact loopback host candidates are allowed; other IP literals, server-reflexive, and relay candidates are forbidden.",
    );
  }
  return normalized;
}

export function validateCandidateList(values, options = {}) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > DETACHED_SIGNAL_LIMITS.maximumCandidates
  ) {
    throw new OabError(
      "invalid_detached_candidates",
      `A detached channel requires 1–${DETACHED_SIGNAL_LIMITS.maximumCandidates} host candidates.`,
    );
  }
  const candidates = values.map((value) =>
    validateHostCandidate(value, options),
  );
  const unique = new Set(candidates.map((value) => canonicalJson(value)));
  if (unique.size !== candidates.length) {
    throw new OabError(
      "invalid_detached_candidates",
      "Duplicate ICE candidates are not allowed.",
    );
  }
  return Object.freeze(candidates);
}

function normalizeProtocolFields(value) {
  if (
    value.protocol !== DETACHED_PROTOCOL ||
    value.wireVersion !== DETACHED_WIRE_VERSION ||
    value.transport !== DETACHED_TRANSPORT ||
    value.transportVersion !== DETACHED_TRANSPORT_VERSION
  ) {
    throw new OabError(
      "unsupported_detached_version",
      "The detached-channel protocol or transport version is unsupported.",
    );
  }
}

function validateTimes(value, options) {
  const now = options.now?.() ?? Date.now();
  boundedInteger(now, 0, Number.MAX_SAFE_INTEGER, "now");
  const createdAt = boundedInteger(
    value.createdAt,
    0,
    Number.MAX_SAFE_INTEGER,
    "createdAt",
  );
  const expiresAt = boundedInteger(
    value.expiresAt,
    1,
    Number.MAX_SAFE_INTEGER,
    "expiresAt",
  );
  if (
    expiresAt <= createdAt ||
    expiresAt - createdAt > DETACHED_SIGNAL_LIMITS.maximumLifetimeMs
  ) {
    throw new OabError(
      "invalid_detached_signal",
      "The detached-channel bootstrap has an invalid lifetime.",
    );
  }
  if (now < createdAt - DETACHED_SIGNAL_LIMITS.maximumClockSkewMs) {
    throw new OabError(
      "detached_signal_from_future",
      "The detached-channel bootstrap was created beyond the permitted future clock skew.",
    );
  }
  if (now >= expiresAt) {
    throw new OabError(
      "detached_signal_expired",
      "The detached-channel bootstrap has expired.",
    );
  }
  return { createdAt, expiresAt };
}

export function validateDetachedOffer(value, options = {}) {
  const keys = [
    "protocol",
    "wireVersion",
    "transport",
    "transportVersion",
    "requestId",
    "channelId",
    "createdAt",
    "expiresAt",
    "senderOrigin",
    "receiverOrigin",
    "receiverHelper",
    "declarationId",
    "senderPublicKey",
    "description",
    "candidates",
  ];
  if (!exactKeys(value, keys)) {
    throw new OabError(
      "invalid_detached_offer",
      "The detached-channel offer has unknown or missing fields.",
    );
  }
  normalizeProtocolFields(value);
  const times = validateTimes(value, options);
  const senderOrigin = canonicalOrigin(value.senderOrigin);
  const receiverOrigin = canonicalOrigin(value.receiverOrigin);
  const receiverHelper = sameOriginEndpoint(
    receiverOrigin,
    value.receiverHelper,
    "receiverHelper",
  );
  if (
    options.expectedReceiverOrigin &&
    receiverOrigin !== canonicalOrigin(options.expectedReceiverOrigin)
  ) {
    throw new OabError(
      "detached_receiver_origin_mismatch",
      "The detached-channel offer targets another receiver origin.",
    );
  }
  const description = assertDataOnlySdp(value.description, { type: "offer" });
  return Object.freeze({
    protocol: DETACHED_PROTOCOL,
    wireVersion: DETACHED_WIRE_VERSION,
    transport: DETACHED_TRANSPORT,
    transportVersion: DETACHED_TRANSPORT_VERSION,
    requestId: token(value.requestId, "requestId"),
    channelId: channelCapability(value.channelId, "channelId"),
    ...times,
    senderOrigin,
    receiverOrigin,
    receiverHelper,
    declarationId: declarationId(value.declarationId),
    senderPublicKey: normalizeP256PublicJwk(value.senderPublicKey),
    description,
    candidates: validateCandidateList(value.candidates, {
      ...options,
      expectedSdpMid: dataSdpMid(description),
    }),
  });
}

export function validateDetachedAnswer(value, options = {}) {
  if (!exactKeys(value, ["description", "candidates"])) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer has unknown or missing fields.",
    );
  }
  const description = assertDataOnlySdp(value.description, { type: "answer" });
  return Object.freeze({
    description,
    candidates: validateCandidateList(value.candidates, {
      ...options,
      expectedSdpMid: dataSdpMid(description),
    }),
  });
}

export async function createDetachedTranscript(offer, options = {}) {
  const validated = validateDetachedOffer(offer, options);
  return Object.freeze({
    protocol: validated.protocol,
    wireVersion: validated.wireVersion,
    transport: validated.transport,
    transportVersion: validated.transportVersion,
    requestId: validated.requestId,
    channelId: validated.channelId,
    senderOrigin: validated.senderOrigin,
    receiverOrigin: validated.receiverOrigin,
    receiverHelper: validated.receiverHelper,
    senderPublicKey: validated.senderPublicKey,
    callbackPath: DETACHED_CALLBACK_PATH,
    createdAt: validated.createdAt,
    expiresAt: validated.expiresAt,
    declarationId: validated.declarationId,
    offerDigest: await sha256Base64Url(
      canonicalJson({
        description: validated.description,
        candidates: validated.candidates,
      }),
      options,
    ),
  });
}

async function encodeFragment(marker, value, options = {}) {
  const payloadBytes = encoder.encode(canonicalJson(value));
  const payload = encodeBase64Url(payloadBytes);
  const payloadDigest = await sha256Base64Url(payloadBytes, options);
  const fragment =
    `${marker}=${DETACHED_TRANSPORT_VERSION}&payload=${payload}&digest=${payloadDigest}`;
  const maximumFragmentBytes = signalingLimit(options);
  if (encoder.encode(fragment).byteLength > maximumFragmentBytes) {
    throw new OabError(
      "detached_fragment_too_large",
      "The detached-channel signaling fragment exceeds its limit.",
    );
  }
  return fragment;
}

async function decodeFragment(marker, fragmentValue, options = {}) {
  const fragment = String(fragmentValue || "").replace(/^#/u, "");
  const maximumFragmentBytes = signalingLimit(options);
  if (
    encoder.encode(fragment).byteLength > maximumFragmentBytes
  ) {
    throw new OabError(
      "detached_fragment_too_large",
      "The detached-channel signaling fragment exceeds its limit.",
    );
  }
  const markers = Array.isArray(marker) ? marker : [marker];
  const markerPattern = markers
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const match = fragment.match(new RegExp(
    `^(?:${markerPattern})=${DETACHED_TRANSPORT_VERSION}&payload=([A-Za-z0-9_-]+)&digest=([A-Za-z0-9_-]{43})$`,
    "u",
  ));
  if (!match) {
    throw new OabError(
      "invalid_detached_fragment",
      "The detached-channel signaling fragment is not in canonical wire form.",
    );
  }
  const payloadBytes = decodeBase64Url(
    match[1],
    maximumFragmentBytes,
  );
  const expectedDigest = digest(match[2], "fragment digest");
  const actualDigest = await sha256Base64Url(payloadBytes, options);
  if (actualDigest !== expectedDigest) {
    throw new OabError(
      "detached_fragment_integrity_failed",
      "The detached-channel signaling fragment was modified or truncated.",
    );
  }
  try {
    const source = decoder.decode(payloadBytes);
    const value = JSON.parse(source);
    if (source !== canonicalJson(value)) {
      throw new OabError(
        "invalid_detached_fragment",
        "The detached-channel signaling fragment is not canonical JSON.",
      );
    }
    return value;
  } catch (error) {
    if (error instanceof OabError) throw error;
    throw new OabError(
      "invalid_detached_fragment",
      "The detached-channel signaling fragment is not valid JSON.",
      { cause: error },
    );
  }
}

function signalingLimit(options) {
  const requested = options.maximumSignalingBytes ??
    options.maximumFragmentBytes ??
    DETACHED_SIGNAL_LIMITS.maximumFragmentBytes;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1024 ||
    requested > DETACHED_SIGNAL_LIMITS.maximumFragmentBytes
  ) {
    throw new OabError(
      "invalid_signaling_limit",
      `maximumSignalingBytes must be from 1024 to ${DETACHED_SIGNAL_LIMITS.maximumFragmentBytes}.`,
    );
  }
  return requested;
}

export async function createDetachedOfferLaunchUrl(endpointValue, offer, options = {}) {
  const validated = validateDetachedOffer(offer, options);
  const endpoint = sameOriginEndpoint(
    validated.receiverOrigin,
    endpointValue,
    "receiverEndpoint",
  );
  const url = new URL(endpoint);
  url.hash = await encodeFragment("oab-detached", validated, options);
  return url.href;
}

export async function parseDetachedOfferFragment(fragment, options = {}) {
  const value = await decodeFragment(["oab-detached"], fragment, options);
  return validateDetachedOffer(value, options);
}

export async function createDetachedAnswerFragment(value, options = {}) {
  return encodeFragment("oab-detached-answer", value, options);
}

export async function parseDetachedAnswerFragment(fragment, options = {}) {
  return decodeFragment(["oab-detached-answer"], fragment, options);
}

export function detachedCallbackUrl(senderOriginValue, fragment) {
  const senderOrigin = canonicalOrigin(senderOriginValue);
  const url = new URL(DETACHED_CALLBACK_PATH, senderOrigin);
  url.hash = String(fragment || "").replace(/^#/u, "");
  return url.href;
}

export function createHostOnlyPeerConnection(options = {}) {
  const configuration = Object.freeze({
    iceServers: Object.freeze([]),
    iceCandidatePoolSize: 0,
    bundlePolicy: "max-bundle",
  });
  const factory = options.peerConnectionFactory ?? ((config) => {
    if (typeof globalThis.RTCPeerConnection !== "function") {
      throw new OabError(
        "webrtc_unavailable",
        "A WebRTC peer connection implementation is required.",
      );
    }
    return new globalThis.RTCPeerConnection(config);
  });
  const connection = factory(configuration);
  if (!connection || typeof connection !== "object") {
    throw new OabError(
      "webrtc_unavailable",
      "The peer-connection factory returned no connection.",
    );
  }
  const applied = connection.getConfiguration?.();
  if (
    applied &&
    (applied.iceTransportPolicy === "relay" ||
      (Array.isArray(applied.iceServers) && applied.iceServers.length > 0))
  ) {
    connection.close?.();
    throw new OabError(
      "unsafe_webrtc_configuration",
      "detached-datachannel/1 forbids STUN and TURN servers.",
    );
  }
  return connection;
}

export async function collectHostCandidates(connection, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  boundedInteger(timeoutMs, 100, 30000, "candidate timeout");
  return new Promise((resolve, reject) => {
    const values = [];
    const signal = options.signal;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      connection.removeEventListener?.("icecandidate", onCandidate);
      connection.removeEventListener?.("icecandidateerror", onError);
      connection.removeEventListener?.(
        "icegatheringstatechange",
        onGatheringStateChange,
      );
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      if (values.length === 0) {
        fail(new OabError(
          "detached_ice_no_eligible_candidate",
          "The browser completed ICE gathering without an eligible mDNS or loopback host candidate.",
        ));
        return;
      }
      settled = true;
      cleanup();
      try {
        resolve(validateCandidateList(values, options));
      } catch (error) {
        reject(error);
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onCandidate = (event) => {
      if (!event.candidate) {
        finish();
        return;
      }
      // Firefox exposes the WebRTC end-of-candidates marker as a truthy
      // RTCIceCandidate whose candidate string is empty before it emits the
      // final null event. This is signaling state, not a network candidate.
      if (event.candidate.candidate === "") return;
      try {
        const json = event.candidate.toJSON?.() ?? event.candidate;
        values.push(validateHostCandidate(json, options));
        if (values.length > DETACHED_SIGNAL_LIMITS.maximumCandidates) {
          throw new OabError(
            "too_many_detached_candidates",
            "The peer produced too many ICE candidates.",
          );
        }
      } catch (error) {
        fail(error);
      }
    };
    const onError = () => fail(new OabError(
      "detached_ice_failed",
      "Host-only ICE candidate gathering failed.",
    ));
    const onAbort = () => fail(
      signal.reason instanceof Error
        ? signal.reason
        : new OabError(
          "detached_ice_cancelled",
          "Host-only ICE candidate gathering was cancelled.",
        ),
    );
    const onGatheringStateChange = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(() => fail(new OabError(
      "detached_ice_timeout",
      "Host-only ICE candidate gathering timed out.",
    )), timeoutMs);
    connection.addEventListener?.("icecandidate", onCandidate);
    connection.addEventListener?.("icecandidateerror", onError);
    connection.addEventListener?.(
      "icegatheringstatechange",
      onGatheringStateChange,
    );
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (connection.iceGatheringState === "complete") finish();
  });
}
