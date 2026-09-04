import {
  DEFAULT_LIMITS,
  DETACHED_RESOURCE_LIMITS,
  LINK_ENVELOPE_REPRESENTATIONS,
  OAB_DISCOVERY_PATH,
  OAB_PROTOCOL,
  OAB_TRANSPORTS,
  OAB_WIRE_VERSIONS,
} from "./constants.js";
import { fetchReceiverApplicationManifest } from "./application-manifest.js";
import {
  DETACHED_FRAME_HEADER_BYTES,
  DETACHED_MAX_FRAMES,
  encodeDetachedControl,
} from "./detached-framing.js";
import { OabError } from "./errors.js";
import { canonicalOrigin, receiverEndpoint } from "./internal.js";
import {
  NETWORK_REQUEST_LIMITS,
  resolveNetworkTimeout,
  runWithNetworkDeadline,
} from "./network-deadline.js";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_DECLARATION_TTL_SECONDS = 300;
const MAXIMUM_DECLARATION_TTL_SECONDS = 3600;
const MAXIMUM_JSON_DEPTH = 32;
const MAXIMUM_WIRE_VERSIONS = 8;
const MAXIMUM_TRANSFER_BYTES = DETACHED_RESOURCE_LIMITS.maximumTransferBytes;
const MAXIMUM_SIGNALING_BYTES = 32 * 1024;
const MAXIMUM_FRAME_BYTES = 16 * 1024;
const MAXIMUM_LINK_URL_BYTES = 64 * 1024;
const MAXIMUM_LINK_FRAGMENT_BYTES = 32 * 1024;
const MAXIMUM_LINK_DECODED_BYTES = 24 * 1024;
const TRANSPORT_PATTERN = /^[a-z][a-z0-9-]*\/[1-9][0-9]*(?:\.[0-9]+)?$/u;
const WIRE_VERSION_PATTERN = /^[1-9][0-9]*\.[0-9]+(?:-[a-z0-9.-]+)?$/u;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const RECEIVER_DECLARATION_TOKEN = Symbol("ReceiverDeclaration");
const receiverDeclarationInstances = new WeakSet();

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function exactObject(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((name) => Object.hasOwn(value, name)) &&
    Object.keys(value).every((name) => allowed.has(name))
  );
}

function invalidDeclaration(message, cause) {
  return new OabError("invalid_declaration", message, { cause });
}

export function assertNoDuplicateJsonMembers(source) {
  let offset = 0;

  function fail() {
    throw invalidDeclaration("The discovery document is not unambiguous JSON.");
  }

  function skipWhitespace() {
    while (/[\u0009\u000A\u000D\u0020]/u.test(source[offset] || "")) {
      offset += 1;
    }
  }

  function readString() {
    if (source[offset] !== '"') fail();
    const start = offset++;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset));
        } catch (_) {
          fail();
        }
      }
      if (code < 0x20) fail();
      if (code === 0x5c) {
        offset += 1;
        if (offset >= source.length) fail();
        if (source[offset] === "u") {
          if (!/^[0-9A-Fa-f]{4}$/u.test(source.slice(offset + 1, offset + 5))) {
            fail();
          }
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(source[offset])) fail();
      }
      offset += 1;
    }
    fail();
  }

  function readPrimitive() {
    const start = offset;
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) {
      offset += 1;
    }
    if (start === offset) fail();
    try {
      JSON.parse(source.slice(start, offset));
    } catch (_) {
      fail();
    }
  }

  function readValue(depth) {
    if (depth > MAXIMUM_JSON_DEPTH) {
      throw invalidDeclaration(
        `The discovery document exceeds ${MAXIMUM_JSON_DEPTH} nesting levels.`,
      );
    }
    skipWhitespace();
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const members = new Set();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        const member = readString();
        if (members.has(member)) {
          throw invalidDeclaration(
            `The discovery document repeats ${JSON.stringify(member)}.`,
          );
        }
        members.add(member);
        skipWhitespace();
        if (source[offset] !== ":") fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
      fail();
    }
    if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        readValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail();
        offset += 1;
      }
      fail();
    }
    if (source[offset] === '"') {
      readString();
      return;
    }
    readPrimitive();
  }

  readValue(0);
  skipWhitespace();
  if (offset !== source.length) fail();
}

async function readBoundedJson(response, maximumBytes, signal) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength != null) {
    const canonical = declaredLength.trim();
    const parsed = Number(canonical);
    if (
      !/^(?:0|[1-9][0-9]*)$/u.test(canonical) ||
      !Number.isSafeInteger(parsed) ||
      parsed > maximumBytes
    ) {
      throw new OabError(
        "discovery_too_large",
        `The discovery document must not exceed ${maximumBytes} bytes.`,
      );
    }
  }

  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const onAbort = () => {
      try {
        Promise.resolve(reader.cancel(signal?.reason)).catch(() => {});
      } catch (_) {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          throw new OabError(
            "discovery_too_large",
            `The discovery document must not exceed ${maximumBytes} bytes.`,
          );
        }
        chunks.push(value);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
  } else {
    throw new OabError(
      "bounded_response_required",
      "The discovery response cannot be consumed with a bounded stream.",
    );
  }
  if (bytes.byteLength === 0) {
    throw invalidDeclaration("The discovery document is empty.");
  }
  try {
    return fatalDecoder.decode(bytes);
  } catch (error) {
    throw invalidDeclaration("The discovery document is not valid UTF-8.", error);
  }
}

function stringList(value, name, options = {}) {
  if (
    !Array.isArray(value) ||
    (options.allowEmpty !== true && value.length === 0) ||
    new Set(value).size !== value.length ||
    (options.maximumItems != null && value.length > options.maximumItems) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        item !== item.trim() ||
        (options.pattern && !options.pattern.test(item)) ||
        (options.allowed && !options.allowed.includes(item)),
    )
  ) {
    throw invalidDeclaration(`${name} is not a canonical unique string list.`);
  }
  return Object.freeze([...value]);
}

function boundedInteger(value, name, maximum, minimum = 1) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidDeclaration(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function extensionMap(value, name) {
  if (!plainObject(value)) {
    throw invalidDeclaration(`${name} must be a JSON object.`);
  }
  return Object.freeze({ ...value });
}

function parseLinkEnvelope(value) {
  if (
    !exactObject(
      value,
      ["representations", "assetTypes", "limits"],
      ["extensions"],
    )
  ) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.linkEnvelope} has unknown or missing members.`,
    );
  }
  const representations = stringList(
    value.representations,
    `${OAB_TRANSPORTS.linkEnvelope}.representations`,
    { allowed: LINK_ENVELOPE_REPRESENTATIONS },
  );
  const assetTypes = stringList(
    value.assetTypes,
    `${OAB_TRANSPORTS.linkEnvelope}.assetTypes`,
    { allowEmpty: true, pattern: MIME_TYPE_PATTERN, maximumItems: 16 },
  );
  if (assetTypes.length !== 0) {
    throw invalidDeclaration(`${OAB_TRANSPORTS.linkEnvelope} must not accept assets.`);
  }
  if (
    !exactObject(value.limits, [
      "maximumUrlBytes",
      "maximumFragmentBytes",
      "maximumDecodedBytes",
    ])
  ) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.linkEnvelope}.limits has unknown or missing members.`,
    );
  }
  const maximumUrlBytes = boundedInteger(
    value.limits.maximumUrlBytes,
    `${OAB_TRANSPORTS.linkEnvelope}.limits.maximumUrlBytes`,
    MAXIMUM_LINK_URL_BYTES,
  );
  const maximumFragmentBytes = boundedInteger(
    value.limits.maximumFragmentBytes,
    `${OAB_TRANSPORTS.linkEnvelope}.limits.maximumFragmentBytes`,
    Math.min(maximumUrlBytes, MAXIMUM_LINK_FRAGMENT_BYTES),
  );
  const maximumDecodedBytes = boundedInteger(
    value.limits.maximumDecodedBytes,
    `${OAB_TRANSPORTS.linkEnvelope}.limits.maximumDecodedBytes`,
    Math.min(maximumFragmentBytes, MAXIMUM_LINK_DECODED_BYTES),
  );
  return Object.freeze({
    representations,
    assetTypes,
    limits: Object.freeze({
      maximumUrlBytes,
      maximumFragmentBytes,
      maximumDecodedBytes,
    }),
    extensions: extensionMap(
      Object.hasOwn(value, "extensions") ? value.extensions : {},
      `${OAB_TRANSPORTS.linkEnvelope}.extensions`,
    ),
  });
}

function parseDetachedDataChannel(value, origin) {
  if (
    !exactObject(
      value,
      ["representations", "assetTypes", "limits", "receiverHelper"],
      ["extensions"],
    )
  ) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel} has unknown or missing members.`,
    );
  }
  const representations = stringList(
    value.representations,
    `${OAB_TRANSPORTS.detachedDataChannel}.representations`,
    { allowEmpty: true, pattern: MIME_TYPE_PATTERN, maximumItems: 16 },
  );
  const assetTypes = stringList(
    value.assetTypes,
    `${OAB_TRANSPORTS.detachedDataChannel}.assetTypes`,
    { allowEmpty: true, pattern: MIME_TYPE_PATTERN, maximumItems: 64 },
  );
  if (representations.length === 0 && assetTypes.length === 0) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel} accepts no content.`,
    );
  }
  if (
    !exactObject(value.limits, [
      "maximumTransferBytes",
      "maximumAssets",
      "maximumSignalingBytes",
      "maximumFrameBytes",
    ])
  ) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel}.limits has unknown or missing members.`,
    );
  }
  if (typeof value.receiverHelper !== "string") {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel}.receiverHelper must be a path.`,
    );
  }
  const maximumTransferBytes = boundedInteger(
    value.limits.maximumTransferBytes,
    `${OAB_TRANSPORTS.detachedDataChannel}.limits.maximumTransferBytes`,
    MAXIMUM_TRANSFER_BYTES,
  );
  const maximumAssets = boundedInteger(
    value.limits.maximumAssets,
    `${OAB_TRANSPORTS.detachedDataChannel}.limits.maximumAssets`,
    256,
    0,
  );
  const maximumFrameBytes = boundedInteger(
    value.limits.maximumFrameBytes,
    `${OAB_TRANSPORTS.detachedDataChannel}.limits.maximumFrameBytes`,
    MAXIMUM_FRAME_BYTES,
    17,
  );
  if (
    maximumFrameBytes > maximumTransferBytes ||
    (assetTypes.length === 0 && maximumAssets !== 0) ||
    (assetTypes.length > 0 && maximumAssets === 0)
  ) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel}.limits is inconsistent with its media capabilities.`,
    );
  }
  const maximumFrameableBytes =
    (maximumFrameBytes - DETACHED_FRAME_HEADER_BYTES) *
    DETACHED_MAX_FRAMES;
  const capabilities = {
    representations,
    assetTypes,
    maximumTransferBytes,
    maximumAssets,
    maximumFrameBytes,
  };
  let capabilitiesFrame;
  try {
    capabilitiesFrame = encodeDetachedControl("capabilities", capabilities);
  } catch (error) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel} capabilities cannot be encoded within the protocol hard frame limit.`,
    );
  }
  if (
    maximumTransferBytes > maximumFrameableBytes ||
    capabilitiesFrame.byteLength > maximumFrameBytes
  ) {
    throw invalidDeclaration(
      `${OAB_TRANSPORTS.detachedDataChannel}.limits cannot frame its advertised capabilities or maximum transfer.`,
    );
  }
  return Object.freeze({
    representations,
    assetTypes,
    receiverHelper: receiverEndpoint(origin, value.receiverHelper),
    limits: Object.freeze({
      maximumTransferBytes,
      maximumAssets,
      maximumSignalingBytes: boundedInteger(
        value.limits.maximumSignalingBytes,
        `${OAB_TRANSPORTS.detachedDataChannel}.limits.maximumSignalingBytes`,
        MAXIMUM_SIGNALING_BYTES,
        1024,
      ),
      maximumFrameBytes,
    }),
    extensions: extensionMap(
      Object.hasOwn(value, "extensions") ? value.extensions : {},
      `${OAB_TRANSPORTS.detachedDataChannel}.extensions`,
    ),
  });
}

function parseTransports(value, origin) {
  if (!plainObject(value) || Object.keys(value).length === 0) {
    throw invalidDeclaration("transports must explicitly advertise at least one transport.");
  }
  const recognized = {};
  const advertised = [];
  for (const [identifier, configuration] of Object.entries(value)) {
    if (!TRANSPORT_PATTERN.test(identifier) || !plainObject(configuration)) {
      throw invalidDeclaration("transports contains an invalid entry.");
    }
    advertised.push(identifier);
    try {
      if (identifier === OAB_TRANSPORTS.linkEnvelope) {
        recognized[identifier] = parseLinkEnvelope(configuration);
      } else if (identifier === OAB_TRANSPORTS.detachedDataChannel) {
        recognized[identifier] = parseDetachedDataChannel(configuration, origin);
      }
    } catch (error) {
      if (!(error instanceof OabError)) throw error;
      // A malformed known profile is disabled in isolation. It never changes
      // another profile and cannot become an implicit fallback.
    }
    // Unknown identifiers are bounded by the document cap and ignored. Their
    // content cannot influence a known transport or make it appear supported.
  }
  if (Object.keys(recognized).length === 0) {
    throw new OabError(
      "unsupported_transport",
      "The receiver advertises no transport supported by this SDK.",
    );
  }
  return {
    transports: Object.freeze(recognized),
    advertisedTransportIds: Object.freeze(advertised),
  };
}

function selectedWireVersion(advertised, supported) {
  const local = stringList(supported, "supportedWireVersions", {
    pattern: WIRE_VERSION_PATTERN,
    maximumItems: MAXIMUM_WIRE_VERSIONS,
  });
  if (
    local.length !== 1 ||
    local[0] !== OAB_WIRE_VERSIONS[0]
  ) {
    throw new TypeError(
      `This draft SDK accepts exactly wire version ${OAB_WIRE_VERSIONS[0]}.`,
    );
  }
  return advertised.find((version) => local.includes(version)) ?? null;
}

function parseDiscovery(value, origin, options) {
  const required = [
    "protocol",
    "wireVersions",
    "status",
    "endpoint",
    "intents",
    "transports",
  ];
  const optional = [
    "senderPolicy",
    "declarationId",
    "discoveryTtl",
    "applicationManifest",
    "extensions",
  ];
  if (!exactObject(value, required, optional)) {
    throw invalidDeclaration(
      "The discovery document has unknown or missing top-level members.",
    );
  }
  if (
    value.protocol !== OAB_PROTOCOL ||
    value.status !== "enabled"
  ) {
    throw new OabError(
      "receiver_disabled",
      "This origin has not explicitly enabled Open App Bridge receiving.",
    );
  }
  const wireVersions = stringList(value.wireVersions, "wireVersions", {
    pattern: WIRE_VERSION_PATTERN,
    maximumItems: MAXIMUM_WIRE_VERSIONS,
  });
  const selectedVersion = selectedWireVersion(
    wireVersions,
    options.supportedWireVersions ?? OAB_WIRE_VERSIONS,
  );
  if (!selectedVersion) {
    throw new OabError(
      "unsupported_version",
      "The receiver and sender have no mutually supported wire version.",
    );
  }
  const intents = stringList(value.intents, "intents");
  if (!intents.includes("preview")) {
    throw new OabError(
      "unsupported_intent",
      "The receiver must support the preview intent.",
    );
  }
  if (typeof value.endpoint !== "string") {
    throw invalidDeclaration("endpoint must be an origin-relative path.");
  }
  const endpoint = receiverEndpoint(origin, value.endpoint);
  const parsedTransports = parseTransports(value.transports, origin);
  const requiredTransport = options.requiredTransport;
  if (
    requiredTransport != null &&
    (typeof requiredTransport !== "string" ||
      !TRANSPORT_PATTERN.test(requiredTransport))
  ) {
    throw new TypeError("requiredTransport must be an OAB transport identifier.");
  }
  if (
    requiredTransport &&
    !Object.hasOwn(parsedTransports.transports, requiredTransport)
  ) {
    throw new OabError(
      "unsupported_transport",
      `The receiver does not advertise supported ${requiredTransport}.`,
    );
  }
  if (
    Object.hasOwn(value, "senderPolicy") &&
    (typeof value.senderPolicy !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(value.senderPolicy))
  ) {
    throw invalidDeclaration("senderPolicy is invalid.");
  }
  if (
    value.declarationId != null &&
    (typeof value.declarationId !== "string" ||
      !/^[\x21-\x7e]{8,512}$/u.test(value.declarationId))
  ) {
    throw invalidDeclaration(
      "declarationId must contain 8–512 printable ASCII characters.",
    );
  }
  const discoveryTtl = Object.hasOwn(value, "discoveryTtl")
    ? value.discoveryTtl
    : DEFAULT_DECLARATION_TTL_SECONDS;
  boundedInteger(
    discoveryTtl,
    "discoveryTtl",
    MAXIMUM_DECLARATION_TTL_SECONDS,
  );
  if (
    Object.hasOwn(value, "applicationManifest") &&
    typeof value.applicationManifest !== "string"
  ) {
    throw invalidDeclaration("applicationManifest must be an origin-relative path.");
  }
  return {
    selectedVersion,
    wireVersions,
    endpoint,
    intents,
    ...parsedTransports,
    senderPolicy: value.senderPolicy ?? "unspecified",
    declarationId: value.declarationId ?? null,
    discoveryTtl,
    applicationManifest: value.applicationManifest == null
      ? null
      : receiverEndpoint(origin, value.applicationManifest),
    extensions: extensionMap(
      Object.hasOwn(value, "extensions") ? value.extensions : {},
      "extensions",
    ),
  };
}

function union(values) {
  return Object.freeze([...new Set(values.flat())]);
}

export class ReceiverDeclaration {
  constructor(value, token) {
    if (token !== RECEIVER_DECLARATION_TOKEN) {
      throw new TypeError(
        "ReceiverDeclaration instances are created by discoverReceiver().",
      );
    }
    Object.assign(this, value);
    this.transportIds = Object.freeze(Object.keys(this.transports));
    this.linkEnvelope = this.transports[OAB_TRANSPORTS.linkEnvelope] ?? null;
    this.detachedDataChannel =
      this.transports[OAB_TRANSPORTS.detachedDataChannel] ?? null;
    this.representations = union(
      this.transportIds.map((id) => this.transports[id].representations),
    );
    this.assetTypes = union(
      this.transportIds.map((id) => this.transports[id].assetTypes),
    );
    this.maximumTransferBytes = this.detachedDataChannel?.limits
      .maximumTransferBytes ?? this.linkEnvelope?.limits.maximumDecodedBytes ?? 0;
    this.maximumAssets = this.detachedDataChannel?.limits.maximumAssets ?? 0;
    this.application ??= null;
    Object.freeze(this);
    receiverDeclarationInstances.add(this);
  }

  get isFresh() {
    return Date.now() < this.expiresAt;
  }

  supportsTransport(identifier) {
    return Object.hasOwn(this.transports, identifier);
  }
}

export async function discoverReceiver(target, options = {}) {
  const origin = canonicalOrigin(target);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new OabError("fetch_unavailable", "Receiver discovery requires fetch().");
  }
  const maximumBytes = options.maximumDiscoveryBytes ??
    DEFAULT_LIMITS.maximumDiscoveryBytes;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > DEFAULT_LIMITS.maximumDiscoveryBytes
  ) {
    throw new TypeError(
      `maximumDiscoveryBytes must be an integer from 1 to ${DEFAULT_LIMITS.maximumDiscoveryBytes}.`,
    );
  }
  const timeoutMs = resolveNetworkTimeout(
    options.timeoutMs,
    NETWORK_REQUEST_LIMITS.discovery,
    "discovery timeoutMs",
  );
  const applicationManifestTimeoutMs = resolveNetworkTimeout(
    options.applicationManifestTimeoutMs,
    NETWORK_REQUEST_LIMITS.applicationManifest,
    "applicationManifestTimeoutMs",
  );
  const discoveryPath = OAB_DISCOVERY_PATH;
  const discoveryUrl = new URL(discoveryPath, origin);
  if (
    discoveryUrl.origin !== origin ||
    discoveryUrl.username ||
    discoveryUrl.password ||
    discoveryUrl.search ||
    discoveryUrl.hash
  ) {
    throw new OabError(
      "invalid_discovery_path",
      "Discovery must be a query-free path on the receiver origin.",
    );
  }

  const source = await runWithNetworkDeadline(async (signal) => {
    let response;
    try {
      response = await fetchImpl(discoveryUrl, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: { Accept: "application/json, application/octet-stream;q=0.8" },
        signal,
      });
    } catch (error) {
      throw new OabError(
        "discovery_failed",
        "The receiver declaration could not be read. Check its domain and CORS policy.",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new OabError(
        "receiver_unavailable",
        `Receiver discovery returned HTTP ${response.status}.`,
      );
    }
    if (response.redirected) {
      throw new OabError(
        "discovery_redirected",
        "Receiver discovery must not follow redirects.",
      );
    }
    if (
      typeof response.url !== "string" ||
      response.url !== discoveryUrl.href
    ) {
      throw new OabError(
        "discovery_url_mismatch",
        "Receiver discovery must return from the exact requested URL.",
      );
    }
    const mediaType = String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (![
      "application/json",
      "application/octet-stream",
      "text/plain",
    ].includes(mediaType)) {
      throw new OabError(
        "invalid_discovery_media_type",
        "Receiver discovery returned an unsupported media type.",
      );
    }
    return readBoundedJson(response, maximumBytes, signal);
  }, {
    signal: options.signal,
    timeoutMs,
    code: "discovery_timeout",
    message: "Receiver discovery did not complete before its deadline.",
  });
  assertNoDuplicateJsonMembers(source);
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw invalidDeclaration("The discovery document is not valid JSON.", error);
  }
  const parsed = parseDiscovery(value, origin, options);
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now() must return a non-negative integer timestamp.");
  }

  let application = null;
  if (parsed.applicationManifest && options.fetchApplicationManifest !== false) {
    try {
      application = await fetchReceiverApplicationManifest(
        origin,
        parsed.applicationManifest,
        {
          fetchImpl,
          signal: options.signal,
          timeoutMs: applicationManifestTimeoutMs,
        },
      );
    } catch (error) {
      if (error?.cause?.name === "AbortError" || error?.name === "AbortError") {
        throw error;
      }
      // Optional display metadata never participates in receiver identity.
    }
  }

  return new ReceiverDeclaration({
    origin,
    discoveryUrl: discoveryUrl.href,
    endpoint: parsed.endpoint,
    selectedVersion: parsed.selectedVersion,
    wireVersions: parsed.wireVersions,
    intents: parsed.intents,
    transports: parsed.transports,
    advertisedTransportIds: parsed.advertisedTransportIds,
    senderPolicy: parsed.senderPolicy,
    declarationId: parsed.declarationId,
    extensions: parsed.extensions,
    application,
    checkedAt: now,
    expiresAt: now + parsed.discoveryTtl * 1000,
  }, RECEIVER_DECLARATION_TOKEN);
}

export function assertFreshDeclaration(value, now = Date.now()) {
  if (!receiverDeclarationInstances.has(value)) {
    throw new OabError(
      "discovery_required",
      "Call discoverReceiver() before enabling a Send action.",
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now must be a non-negative integer timestamp.");
  }
  if (now >= value.expiresAt) {
    throw new OabError(
      "discovery_expired",
      "The receiver declaration expired. Check the receiver again.",
    );
  }
  return value;
}

export const DISCOVERY_HARD_LIMITS = Object.freeze({
  maximumBytes: DEFAULT_LIMITS.maximumDiscoveryBytes,
  maximumTtlSeconds: MAXIMUM_DECLARATION_TTL_SECONDS,
  maximumSignalingBytes: MAXIMUM_SIGNALING_BYTES,
  maximumFrameBytes: MAXIMUM_FRAME_BYTES,
  maximumLinkUrlBytes: MAXIMUM_LINK_URL_BYTES,
  maximumLinkFragmentBytes: MAXIMUM_LINK_FRAGMENT_BYTES,
  maximumLinkDecodedBytes: MAXIMUM_LINK_DECODED_BYTES,
});
