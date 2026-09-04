import { OabError } from "./errors.js";
import {
  isOabWireAbortReason,
  normalizeWireAbortReason,
} from "./wire-abort-reasons.js";
import { safeAssetName } from "./content.js";
import {
  DEFAULT_LIMITS,
  DETACHED_RESOURCE_LIMITS,
} from "./constants.js";
import {
  assertSafeDisplayText,
  safeSourceUrl,
} from "./internal.js";
import {
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
  sha256Base64Url,
} from "./detached-crypto.js";
import {
  DETACHED_CHANNEL_LABEL,
  DETACHED_PROTOCOL,
  DETACHED_TRANSPORT,
} from "./detached-signaling.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const DETACHED_MAX_FRAME_BYTES = 16 * 1024;
export const DETACHED_FRAME_HEADER_BYTES = 16;
export const DETACHED_MAX_CHUNK_BYTES =
  DETACHED_MAX_FRAME_BYTES - DETACHED_FRAME_HEADER_BYTES;
export const DETACHED_MAX_FRAMES = 65536;
export const DETACHED_MIN_FRAME_BYTES = DETACHED_FRAME_HEADER_BYTES + 1;

const MAGIC_HIGH = 0x4f;
const MAGIC_LOW = 0x41;
const FRAME_VERSION = 1;
const CONTROL_ITEM = 0xffff;
const SHA256_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;

export const DETACHED_FRAME_TYPES = Object.freeze({
  capabilities: 1,
  manifest: 2,
  grant: 3,
  data: 4,
  complete: 5,
  previewing: 6,
  result: 7,
  abort: 8,
});

const FRAME_TYPE_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(DETACHED_FRAME_TYPES).map(([name, value]) => [value, name]),
  ),
);

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
}

function isCanonicalTransferId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  try {
    return encodeBase64Url(decodeBase64Url(value, 96)) === value;
  } catch (_) {
    return false;
  }
}

function validateAbortControl(value) {
  if (
    !exactKeys(value, ["reason"]) ||
    !isOabWireAbortReason(value.reason)
  ) {
    throw new OabError(
      "invalid_detached_abort",
      "An abort frame must contain exactly one registered wire reason.",
    );
  }
  return value.reason;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new OabError(
    "invalid_detached_frame",
    "A detached-channel frame must be binary data.",
  );
}

function negotiatedFrameBytes(value = DETACHED_MAX_FRAME_BYTES) {
  if (
    !Number.isSafeInteger(value) ||
    value < DETACHED_MIN_FRAME_BYTES ||
    value > DETACHED_MAX_FRAME_BYTES
  ) {
    throw new OabError(
      "invalid_detached_frame_limit",
      `maximumFrameBytes must be from ${DETACHED_MIN_FRAME_BYTES} to ${DETACHED_MAX_FRAME_BYTES}.`,
    );
  }
  return value;
}

async function contentBytes(value, maximumBytes) {
  let result;
  if (typeof value === "string") {
    result = encoder.encode(value);
  } else if (value instanceof Blob) {
    if (value.size > maximumBytes) {
      throw new OabError(
        "detached_transfer_too_large",
        "The detached content exceeds its configured transfer limit.",
      );
    }
    result = new Uint8Array(await value.arrayBuffer());
  } else {
    // The prepared transfer owns its buffer so terminal zeroing never mutates
    // a caller-owned ArrayBuffer or typed-array view.
    result = new Uint8Array(bytes(value));
  }
  if (result.byteLength > maximumBytes) {
    result.fill(0);
    throw new OabError(
      "detached_transfer_too_large",
      "The detached content exceeds its configured transfer limit.",
    );
  }
  return result;
}

function integer(
  value,
  minimum,
  maximum,
  label,
  code = "invalid_detached_manifest",
) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new OabError(
      code,
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new OabError(
      "invalid_detached_manifest",
      `${label} must be a SHA-256 base64url digest.`,
    );
  }
  return value;
}

function mediaType(value) {
  if (typeof value !== "string" || !MIME_PATTERN.test(value)) {
    throw new OabError(
      "invalid_detached_manifest",
      "Every transfer item requires a valid lowercase media type.",
    );
  }
  return value;
}

function normalizeManifestSource(value) {
  if (!exactKeys(value, ["application", "url"])) {
    throw new OabError(
      "invalid_detached_manifest",
      "The manifest source has unknown or missing fields.",
    );
  }
  let application = null;
  if (value.application !== null) {
    application = assertSafeDisplayText(
      value.application,
      120,
      "Claimed source application",
    );
    if (application !== value.application) {
      throw new OabError(
        "invalid_detached_manifest",
        "The claimed source application is not canonical display text.",
      );
    }
  }
  const url = value.url === null ? null : safeSourceUrl(value.url);
  if (value.url !== null && url !== value.url) {
    throw new OabError(
      "invalid_detached_manifest",
      "The claimed source URL must be a bounded HTTPS URL.",
    );
  }
  return Object.freeze({ application, url });
}

function uniqueMediaTypes(values, maximum, label) {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    values.some((value) => typeof value !== "string" || !MIME_PATTERN.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new OabError(
      "invalid_detached_capabilities",
      `${label} must be a bounded list of unique lowercase media types.`,
    );
  }
  return Object.freeze([...values]);
}

export function validateDetachedCapabilities(value) {
  if (!exactKeys(value, [
    "representations",
    "assetTypes",
    "maximumTransferBytes",
    "maximumAssets",
    "maximumFrameBytes",
  ])) {
    throw new OabError(
      "invalid_detached_capabilities",
      "The live receiver capabilities have unknown or missing fields.",
    );
  }
  const representations = uniqueMediaTypes(
    value.representations,
    16,
    "representations",
  );
  const assetTypes = uniqueMediaTypes(value.assetTypes, 64, "assetTypes");
  const maximumTransferBytes = integer(
    value.maximumTransferBytes,
    1,
    DETACHED_RESOURCE_LIMITS.maximumTransferBytes,
    "maximumTransferBytes",
    "invalid_detached_capabilities",
  );
  const maximumAssets = integer(
    value.maximumAssets,
    0,
    256,
    "maximumAssets",
    "invalid_detached_capabilities",
  );
  const maximumFrameBytes = negotiatedFrameBytes(value.maximumFrameBytes);
  if (
    (representations.length === 0 && assetTypes.length === 0) ||
    ((assetTypes.length === 0) !== (maximumAssets === 0)) ||
    maximumFrameBytes > maximumTransferBytes ||
    maximumTransferBytes >
      (maximumFrameBytes - DETACHED_FRAME_HEADER_BYTES) *
      DETACHED_MAX_FRAMES
  ) {
    throw new OabError(
      "invalid_detached_capabilities",
      "A receiver must accept frameable content with internally consistent media and asset limits.",
    );
  }
  const normalized = Object.freeze({
    representations,
    assetTypes,
    maximumTransferBytes,
    maximumAssets,
    maximumFrameBytes,
  });
  if (encodeDetachedControl("capabilities", normalized).byteLength > maximumFrameBytes) {
    throw new OabError(
      "invalid_detached_capabilities",
      "The live capabilities control does not fit its own maximum frame size.",
    );
  }
  return normalized;
}

export function assertManifestMatchesCapabilities(manifestValue, capabilitiesValue) {
  const capabilities = validateDetachedCapabilities(capabilitiesValue);
  const manifest = validateDetachedManifest(manifestValue);
  const assets = manifest.items.filter((item) => item.kind === "asset");
  const unsupportedRepresentation = manifest.items.find(
    (item) => item.kind === "representation" &&
      !capabilities.representations.includes(item.mimeType),
  );
  const unsupportedAsset = assets.find(
    (item) => !capabilities.assetTypes.includes(item.mimeType),
  );
  if (
    manifest.totalBytes > capabilities.maximumTransferBytes ||
    assets.length > capabilities.maximumAssets ||
    unsupportedRepresentation ||
    unsupportedAsset
  ) {
    throw new OabError(
      "detached_capability_mismatch",
      "The transfer manifest exceeds the receiver's live capabilities.",
    );
  }
  return manifest;
}

export function encodeDetachedFrame({
  type,
  itemIndex = CONTROL_ITEM,
  sequence = 0,
  totalFrames = 1,
  payload,
}) {
  if (!Object.hasOwn(FRAME_TYPE_NAMES, type)) {
    throw new OabError("invalid_detached_frame", "Unknown frame type.");
  }
  const payloadBytes = bytes(payload);
  if (
    payloadBytes.byteLength > DETACHED_MAX_CHUNK_BYTES ||
    (type === DETACHED_FRAME_TYPES.data && payloadBytes.byteLength === 0) ||
    !Number.isSafeInteger(itemIndex) ||
    itemIndex < 0 ||
    itemIndex > CONTROL_ITEM ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Number.isSafeInteger(totalFrames) ||
    totalFrames < 1 ||
    totalFrames > DETACHED_MAX_FRAMES ||
    sequence >= totalFrames ||
    (type === DETACHED_FRAME_TYPES.data && itemIndex === CONTROL_ITEM) ||
    (type !== DETACHED_FRAME_TYPES.data &&
      (itemIndex !== CONTROL_ITEM || sequence !== 0 || totalFrames !== 1))
  ) {
    throw new OabError(
      "invalid_detached_frame",
      "The detached-channel frame header or payload is out of bounds.",
    );
  }
  const frame = new Uint8Array(
    DETACHED_FRAME_HEADER_BYTES + payloadBytes.byteLength,
  );
  const view = new DataView(frame.buffer);
  frame[0] = MAGIC_HIGH;
  frame[1] = MAGIC_LOW;
  frame[2] = FRAME_VERSION;
  frame[3] = type;
  view.setUint16(4, itemIndex);
  view.setUint32(6, sequence);
  view.setUint32(10, totalFrames);
  view.setUint16(14, payloadBytes.byteLength);
  frame.set(payloadBytes, DETACHED_FRAME_HEADER_BYTES);
  return frame;
}

export function encodeDetachedControl(typeName, value) {
  const type = DETACHED_FRAME_TYPES[typeName];
  if (!type || typeName === "data") {
    throw new OabError(
      "invalid_detached_frame",
      "The control frame type is invalid.",
    );
  }
  return encodeDetachedFrame({
    type,
    payload: encoder.encode(canonicalJson(value)),
  });
}

export function decodeDetachedFrame(value, options = {}) {
  const frame = bytes(value);
  const maximumFrameBytes = negotiatedFrameBytes(options.maximumFrameBytes);
  if (
    frame.byteLength < DETACHED_FRAME_HEADER_BYTES ||
    frame.byteLength > maximumFrameBytes ||
    frame[0] !== MAGIC_HIGH ||
    frame[1] !== MAGIC_LOW ||
    frame[2] !== FRAME_VERSION
  ) {
    throw new OabError(
      "invalid_detached_frame",
      "The detached-channel frame magic, version, or size is invalid.",
    );
  }
  const view = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  );
  const type = frame[3];
  const typeName = FRAME_TYPE_NAMES[type];
  const itemIndex = view.getUint16(4);
  const sequence = view.getUint32(6);
  const totalFrames = view.getUint32(10);
  const payloadLength = view.getUint16(14);
  if (
    !typeName ||
    payloadLength !== frame.byteLength - DETACHED_FRAME_HEADER_BYTES ||
    totalFrames < 1 ||
    totalFrames > DETACHED_MAX_FRAMES ||
    sequence >= totalFrames ||
    (typeName === "data" &&
      (itemIndex === CONTROL_ITEM || payloadLength === 0)) ||
    (typeName !== "data" &&
      (itemIndex !== CONTROL_ITEM || sequence !== 0 || totalFrames !== 1))
  ) {
    throw new OabError(
      "invalid_detached_frame",
      "The detached-channel frame header is inconsistent.",
    );
  }
  const payload = frame.slice(DETACHED_FRAME_HEADER_BYTES);
  let control = null;
  if (typeName !== "data") {
    try {
      const source = decoder.decode(payload);
      control = JSON.parse(source);
      if (source !== canonicalJson(control)) {
        throw new OabError(
          "invalid_detached_frame",
          "The detached-channel control frame is not canonical JSON.",
        );
      }
    } catch (error) {
      if (error instanceof OabError) throw error;
      throw new OabError(
        "invalid_detached_frame",
        "The detached-channel control frame is not valid UTF-8 JSON.",
        { cause: error },
      );
    }
  }
  return Object.freeze({
    type,
    typeName,
    itemIndex,
    sequence,
    totalFrames,
    payload,
    control,
  });
}

export function validateDetachedManifest(value, options = {}) {
  if (
    !exactKeys(value, [
      "protocol",
      "transport",
      "frameVersion",
      "transferId",
      "title",
      "source",
      "items",
      "totalBytes",
    ]) ||
    value.protocol !== DETACHED_PROTOCOL ||
    value.transport !== DETACHED_TRANSPORT ||
    value.frameVersion !== FRAME_VERSION ||
    !isCanonicalTransferId(value.transferId) ||
    (value.title !== null && typeof value.title !== "string") ||
    !Array.isArray(value.items) ||
    value.items.length === 0
  ) {
    throw new OabError(
      "invalid_detached_manifest",
      "The detached transfer manifest is malformed.",
    );
  }
  const normalizedTitle = assertSafeDisplayText(
    value.title,
    240,
    "Manifest title",
  );
  if (normalizedTitle !== value.title) {
    throw new OabError(
      "invalid_detached_manifest",
      "The manifest title is not canonical display text.",
    );
  }
  const maximumItems = options.maximumItems ?? 272;
  const maximumTransferBytes = options.maximumTransferBytes ??
    DEFAULT_LIMITS.maximumTransferBytes;
  integer(maximumItems, 1, 272, "maximumItems");
  integer(
    maximumTransferBytes,
    1,
    DETACHED_RESOURCE_LIMITS.maximumTransferBytes,
    "maximumTransferBytes",
  );
  if (value.items.length > maximumItems) {
    throw new OabError(
      "detached_too_many_items",
      `The detached transfer exceeds the ${maximumItems}-item limit.`,
    );
  }
  const representationTypes = new Set();
  const assetNames = new Set();
  const items = value.items.map((item, index) => {
    if (
      !exactKeys(item, [
        "index",
        "kind",
        "mimeType",
        "name",
        "bytes",
        "sha256",
      ]) ||
      item.index !== index ||
      !["representation", "asset"].includes(item.kind)
    ) {
      throw new OabError(
        "invalid_detached_manifest",
        "Transfer item indexes and kinds must be canonical.",
      );
    }
    const mimeType = mediaType(item.mimeType);
    const byteLength = integer(
      item.bytes,
      1,
      maximumTransferBytes,
      `items[${index}].bytes`,
    );
    const hash = digest(item.sha256, `items[${index}].sha256`);
    let name = null;
    if (item.kind === "representation") {
      if (item.name !== null || representationTypes.has(mimeType)) {
        throw new OabError(
          "invalid_detached_manifest",
          "Text representations must have unique media types and no filename.",
        );
      }
      representationTypes.add(mimeType);
    } else {
      name = safeAssetName(item.name);
      if (name !== item.name) {
        throw new OabError(
          "invalid_detached_manifest",
          "Asset filenames must already be canonical display text.",
        );
      }
      if (assetNames.has(name)) {
        throw new OabError(
          "invalid_detached_manifest",
          "Asset filenames must be unique within a transfer.",
        );
      }
      assetNames.add(name);
    }
    return Object.freeze({
      index,
      kind: item.kind,
      mimeType,
      name,
      bytes: byteLength,
      sha256: hash,
    });
  });
  const totalBytes = items.reduce((total, item) => total + item.bytes, 0);
  if (
    representationTypes.size > 16 ||
    assetNames.size > 256 ||
    totalBytes !== value.totalBytes ||
    totalBytes > maximumTransferBytes
  ) {
    throw new OabError(
      "invalid_detached_manifest",
      "The manifest total is inconsistent or exceeds the transfer limit.",
    );
  }
  return Object.freeze({
    protocol: DETACHED_PROTOCOL,
    transport: DETACHED_TRANSPORT,
    frameVersion: FRAME_VERSION,
    transferId: value.transferId,
    title: normalizedTitle,
    source: normalizeManifestSource(value.source),
    items: Object.freeze(items),
    totalBytes,
  });
}

export async function prepareDetachedTransfer(content, options = {}) {
  const representations = content?.representations;
  const assets = Array.isArray(content?.assets) ? content.assets : [];
  const representationEntries = plainObject(representations)
    ? Object.entries(representations)
    : null;
  if (
    !representationEntries ||
    representationEntries.length > 16 ||
    assets.length > 256 ||
    representationEntries.length + assets.length > 272
  ) {
    throw new OabError(
      "invalid_detached_content",
      "Detached content requires a representation map and a bounded asset list.",
    );
  }
  const maximumTransferBytes = integer(
    options.maximumTransferBytes ?? DEFAULT_LIMITS.maximumTransferBytes,
    1,
    DETACHED_RESOURCE_LIMITS.maximumTransferBytes,
    "maximumTransferBytes",
  );
  const itemBytes = [];
  const itemFields = [];
  const framedViews = new Set();
  let disposed = false;
  let transferId = options.transferId;
  let manifest = null;
  let manifestDigest = null;
  const assertAvailable = () => {
    if (disposed) {
      throw new OabError(
        "detached_transfer_disposed",
        "The detached transfer bytes have already been released.",
      );
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const value of itemBytes) value.fill(0);
    itemBytes.length = 0;
    itemFields.length = 0;
    for (const view of framedViews) {
      view.manifestFrame?.fill(0);
      view.completionFrame?.fill(0);
      view.completionDigest = null;
    }
    framedViews.clear();
    transferId = null;
    manifest = null;
    manifestDigest = null;
  };
  try {
    let totalBytes = 0;
    for (const [mimeType, value] of representationEntries) {
      const data = await contentBytes(value, maximumTransferBytes - totalBytes);
      if (data.byteLength === 0) continue;
      totalBytes += data.byteLength;
      itemBytes.push(data);
      itemFields.push({
        kind: "representation",
        mimeType,
        name: null,
        bytes: data.byteLength,
        sha256: await sha256Base64Url(data, options),
      });
    }
    for (const asset of assets) {
      const data = await contentBytes(
        asset.blob ?? asset.data,
        maximumTransferBytes - totalBytes,
      );
      if (data.byteLength === 0) {
        throw new OabError(
          "invalid_detached_content",
          "Empty assets are not transferred.",
        );
      }
      totalBytes += data.byteLength;
      itemBytes.push(data);
      itemFields.push({
        kind: "asset",
        mimeType: asset.mimeType,
        name: asset.name,
        bytes: data.byteLength,
        sha256: await sha256Base64Url(data, options),
      });
    }
    if (!isCanonicalTransferId(transferId)) {
      throw new OabError(
        "invalid_detached_transfer_id",
        "A 22–128 character base64url transfer ID is required.",
      );
    }
    const manifestValue = {
      protocol: DETACHED_PROTOCOL,
      transport: DETACHED_TRANSPORT,
      frameVersion: FRAME_VERSION,
      transferId,
      title: assertSafeDisplayText(content?.title, 240, "Manifest title"),
      source: {
        application:
          assertSafeDisplayText(
            content?.sourceApplication,
            120,
            "Claimed source application",
          ),
        url:
          typeof content?.sourceUrl === "string"
            ? content.sourceUrl
            : null,
      },
      items: itemFields.map((item, index) => ({ index, ...item })),
      totalBytes,
    };
    manifest = validateDetachedManifest(manifestValue, options);
    manifestDigest = await sha256Base64Url(
      canonicalJson(manifest),
      options,
    );
    async function frameFor(maximumFrameBytesValue) {
      try {
        assertAvailable();
        const maximumFrameBytes = negotiatedFrameBytes(maximumFrameBytesValue);
        const view = {
          manifestFrame: null,
          completionFrame: null,
          completionDigest: null,
        };
        framedViews.add(view);
        const maximumChunkBytes =
          maximumFrameBytes - DETACHED_FRAME_HEADER_BYTES;
        const totalFrames = itemBytes.reduce(
          (total, item) =>
            total + Math.ceil(item.byteLength / maximumChunkBytes),
          0,
        );
        if (totalFrames < 1 || totalFrames > DETACHED_MAX_FRAMES) {
          throw new OabError(
            "detached_too_many_frames",
            `A detached transfer can use at most ${DETACHED_MAX_FRAMES} frames.`,
          );
        }
        view.completionDigest = await sha256Base64Url(
          canonicalJson({
            transferId,
            manifestDigest,
            itemDigests: manifest.items.map((item) => item.sha256),
            totalFrames,
          }),
          options,
        );
        view.manifestFrame = encodeDetachedControl("manifest", {
          manifest,
          manifestDigest,
        });
        view.completionFrame = encodeDetachedControl("complete", {
          transferId,
          manifestDigest,
          totalFrames,
          completionDigest: view.completionDigest,
        });
        if (
          view.manifestFrame.byteLength > maximumFrameBytes ||
          view.completionFrame.byteLength > maximumFrameBytes
        ) {
          throw new OabError(
            "detached_control_frame_too_large",
            "The transfer metadata does not fit the negotiated frame limit.",
          );
        }

        async function* dataFrames() {
          assertAvailable();
          let sequence = 0;
          for (let itemIndex = 0; itemIndex < itemBytes.length; itemIndex += 1) {
            assertAvailable();
            const data = itemBytes[itemIndex];
            for (
              let offset = 0;
              offset < data.byteLength;
              offset += maximumChunkBytes
            ) {
              assertAvailable();
              const chunk = data.subarray(
                offset,
                Math.min(offset + maximumChunkBytes, data.byteLength),
              );
              yield encodeDetachedFrame({
                type: DETACHED_FRAME_TYPES.data,
                itemIndex,
                sequence,
                totalFrames,
                payload: chunk,
              });
              sequence += 1;
            }
          }
        }

        return Object.freeze({
          get manifest() {
            assertAvailable();
            return manifest;
          },
          get manifestDigest() {
            assertAvailable();
            return manifestDigest;
          },
          maximumFrameBytes,
          totalFrames,
          get completionDigest() {
            assertAvailable();
            return view.completionDigest;
          },
          get manifestFrame() {
            assertAvailable();
            return view.manifestFrame;
          },
          dataFrames,
          get completionFrame() {
            assertAvailable();
            return view.completionFrame;
          },
          forMaximumFrameBytes: frameFor,
          dispose,
          get disposed() {
            return disposed;
          },
        });
      } catch (error) {
        dispose();
        throw error;
      }
    }

    return await frameFor(
      options.maximumFrameBytes ?? DETACHED_MAX_FRAME_BYTES,
    );
  } catch (error) {
    // Every byte in itemBytes is an SDK-owned copy. A preparation failure has
    // no public handle through which the caller could request disposal, so it
    // must be synchronously overwritten here before the error escapes.
    dispose();
    throw error;
  }
}

export function assertReliableOrderedChannel(channel) {
  if (
    !channel ||
    channel.label !== DETACHED_CHANNEL_LABEL ||
    channel.ordered !== true ||
    channel.maxRetransmits != null ||
    channel.maxPacketLifeTime != null
  ) {
    throw new OabError(
      "unsafe_detached_channel",
      "detached-datachannel/1 requires an ordered, fully reliable RTCDataChannel.",
    );
  }
  try {
    channel.binaryType = "arraybuffer";
  } catch (_) {
    // A read-only implementation is acceptable only if it already emits
    // ArrayBuffers. The post-condition below is authoritative.
  }
  if (channel.binaryType !== "arraybuffer") {
    throw new OabError(
      "unsafe_detached_channel",
      "detached-datachannel/1 requires RTCDataChannel binaryType arraybuffer.",
    );
  }
  return channel;
}

function waitForBufferedAmount(channel, lowWaterMark, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener?.("bufferedamountlow", onLow);
      channel.removeEventListener?.("close", onClose);
      channel.removeEventListener?.("error", onError);
      callback();
    };
    const onLow = () => finish(resolve);
    const onClose = () => finish(() => reject(new OabError(
      "detached_channel_closed",
      "The detached channel closed during backpressure.",
    )));
    const onError = () => finish(() => reject(new OabError(
      "detached_channel_error",
      "The detached channel failed during backpressure.",
    )));
    const timer = setTimeout(() => finish(() => reject(new OabError(
      "detached_backpressure_timeout",
      "The detached channel did not drain before its deadline.",
    ))), timeoutMs);
    channel.bufferedAmountLowThreshold = lowWaterMark;
    channel.addEventListener?.("bufferedamountlow", onLow);
    channel.addEventListener?.("close", onClose);
    channel.addEventListener?.("error", onError);
    if (channel.bufferedAmount <= lowWaterMark) finish(resolve);
  });
}

export async function sendDetachedFrame(channelValue, frame, options = {}) {
  const channel = assertReliableOrderedChannel(channelValue);
  const highWaterMark = options.highWaterMark ?? 256 * 1024;
  const lowWaterMark = options.lowWaterMark ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 15000;
  if (
    !Number.isSafeInteger(highWaterMark) ||
    !Number.isSafeInteger(lowWaterMark) ||
    lowWaterMark < 0 ||
    highWaterMark <= lowWaterMark ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  ) {
    throw new TypeError(
      "Detached-channel backpressure limits are invalid; timeoutMs must be 100–30000 ms.",
    );
  }
  const encoded = bytes(frame);
  const maximumFrameBytes = negotiatedFrameBytes(options.maximumFrameBytes);
  if (encoded.byteLength > maximumFrameBytes) {
    throw new OabError(
      "invalid_detached_frame",
      `The detached frame exceeds the negotiated ${maximumFrameBytes}-byte limit.`,
    );
  }
  if (channel.readyState !== "open") {
    throw new OabError(
      "detached_channel_not_open",
      "The detached channel is not open.",
    );
  }
  if (channel.bufferedAmount > highWaterMark) {
    await waitForBufferedAmount(channel, lowWaterMark, timeoutMs);
  }
  if (channel.readyState !== "open") {
    throw new OabError(
      "detached_channel_closed",
      "The detached channel closed before the frame was sent.",
    );
  }
  try {
    channel.send(encoded);
  } catch (error) {
    throw new OabError(
      "detached_send_failed",
      "The detached frame could not be sent.",
      { cause: error },
    );
  }
}

export class DetachedFrameReceiver {
  #state = "idle";
  #manifest = null;
  #manifestDigest = null;
  #itemValues = [];
  #itemReceivedBytes = [];
  #receivedBytes = 0;
  #sequence = 0;
  #totalFrames = null;
  #lastItemIndex = 0;
  #options;

  constructor(options = {}) {
    this.#options = options;
  }

  get state() {
    return this.#state;
  }

  get manifest() {
    return this.#manifest;
  }

  async accept(frameValue) {
    if (["complete", "failed", "rejected"].includes(this.#state)) {
      throw new OabError(
        "detached_session_terminal",
        "The detached receive session is already terminal.",
      );
    }
    let frame = null;
    try {
      frame = decodeDetachedFrame(frameValue, this.#options);
      if (frame.typeName === "manifest") return await this.#acceptManifest(frame);
      if (frame.typeName === "data") return this.#acceptData(frame);
      if (frame.typeName === "complete") return await this.#acceptComplete(frame);
      if (frame.typeName === "abort") {
        const reason = validateAbortControl(frame.control);
        this.#fail("rejected");
        return Object.freeze({ type: "abort", reason });
      }
      throw new OabError(
        "unexpected_detached_frame",
        `A ${frame.typeName} frame is not valid from the sender in this state.`,
      );
    } catch (error) {
      frame?.payload?.fill?.(0);
      this.#fail("failed");
      throw error;
    }
  }

  async #acceptManifest(frame) {
    if (
      this.#state !== "idle" ||
      !exactKeys(frame.control, ["manifest", "manifestDigest"])
    ) {
      throw new OabError(
        "unexpected_detached_manifest",
        "Exactly one manifest must be the first transfer frame.",
      );
    }
    const manifest = validateDetachedManifest(
      frame.control.manifest,
      this.#options,
    );
    digest(frame.control.manifestDigest, "manifestDigest");
    const actualManifestDigest = await sha256Base64Url(
      canonicalJson(manifest),
      this.#options,
    );
    if (
      actualManifestDigest !== frame.control.manifestDigest ||
      (this.#options.expectedManifestDigest &&
        this.#options.expectedManifestDigest !== frame.control.manifestDigest)
    ) {
      throw new OabError(
        "detached_manifest_integrity_failed",
        "The transfer manifest does not match its digest or the approved offer.",
      );
    }
    this.#manifest = manifest;
    this.#manifestDigest = frame.control.manifestDigest;
    this.#itemValues = [];
    this.#itemReceivedBytes = manifest.items.map(() => 0);
    this.#state = "awaiting-grant";
    return Object.freeze({
      type: "manifest",
      manifest,
      manifestDigest: this.#manifestDigest,
    });
  }

  grant() {
    if (this.#state !== "awaiting-grant") {
      throw new OabError(
        "invalid_detached_state",
        "A transfer can be granted only after validating its manifest.",
      );
    }
    try {
      this.#itemValues = this.#manifest.items.map(
        (item) => new Uint8Array(item.bytes),
      );
    } catch (error) {
      this.#fail("failed");
      throw new OabError(
        "detached_memory_allocation_failed",
        "The receiver could not allocate the reserved transfer buffer.",
        { cause: error },
      );
    }
    this.#state = "receiving";
    return encodeDetachedControl("grant", {
      transferId: this.#manifest.transferId,
      manifestDigest: this.#manifestDigest,
    });
  }

  reject(reason = "user_rejected") {
    if (this.#state !== "awaiting-grant") {
      throw new OabError(
        "invalid_detached_state",
        "A transfer can be rejected only while awaiting a grant.",
      );
    }
    this.#fail("rejected");
    return encodeDetachedControl("abort", {
      reason: normalizeWireAbortReason(reason, "user_rejected"),
    });
  }

  dispose() {
    if (["complete", "failed", "rejected"].includes(this.#state)) {
      this.#clearTerminalMetadata(true);
      return;
    }
    this.#fail("failed");
  }

  #acceptData(frame) {
    if (
      this.#state !== "receiving" ||
      frame.itemIndex >= this.#manifest.items.length ||
      frame.sequence !== this.#sequence ||
      (this.#totalFrames !== null && frame.totalFrames !== this.#totalFrames) ||
      frame.itemIndex < this.#lastItemIndex
    ) {
      throw new OabError(
        "detached_frame_sequence_error",
        "Detached data frames must be ordered, contiguous, and manifest-bound.",
      );
    }
    this.#totalFrames ??= frame.totalFrames;
    const item = this.#manifest.items[frame.itemIndex];
    const itemReceived = this.#itemReceivedBytes[frame.itemIndex];
    if (
      itemReceived + frame.payload.byteLength > item.bytes ||
      this.#receivedBytes + frame.payload.byteLength > this.#manifest.totalBytes
    ) {
      throw new OabError(
        "detached_transfer_overflow",
        "The detached transfer exceeds its authenticated manifest.",
      );
    }
    this.#itemValues[frame.itemIndex].set(frame.payload, itemReceived);
    frame.payload.fill(0);
    this.#itemReceivedBytes[frame.itemIndex] += frame.payload.byteLength;
    this.#receivedBytes += frame.payload.byteLength;
    this.#sequence += 1;
    this.#lastItemIndex = frame.itemIndex;
    return Object.freeze({
      type: "data",
      receivedBytes: this.#receivedBytes,
      totalBytes: this.#manifest.totalBytes,
    });
  }

  async #acceptComplete(frame) {
    if (
      this.#state !== "receiving" ||
      !exactKeys(frame.control, [
        "transferId",
        "manifestDigest",
        "totalFrames",
        "completionDigest",
      ]) ||
      frame.control.transferId !== this.#manifest.transferId ||
      frame.control.manifestDigest !== this.#manifestDigest ||
      frame.control.totalFrames !== this.#totalFrames ||
      this.#sequence !== this.#totalFrames ||
      this.#receivedBytes !== this.#manifest.totalBytes
    ) {
      throw new OabError(
        "detached_completion_mismatch",
        "The detached completion frame does not match the received transfer.",
      );
    }
    const actualManifestDigest = await sha256Base64Url(
      canonicalJson(this.#manifest),
      this.#options,
    );
    if (actualManifestDigest !== this.#manifestDigest) {
      throw new OabError(
        "detached_manifest_integrity_failed",
        "The transfer manifest digest does not match.",
      );
    }
    const expectedCompletionDigest = await sha256Base64Url(
      canonicalJson({
        transferId: this.#manifest.transferId,
        manifestDigest: this.#manifestDigest,
        itemDigests: this.#manifest.items.map((item) => item.sha256),
        totalFrames: this.#totalFrames,
      }),
      this.#options,
    );
    if (frame.control.completionDigest !== expectedCompletionDigest) {
      throw new OabError(
        "detached_completion_integrity_failed",
        "The transfer completion digest does not match.",
      );
    }
    for (const item of this.#manifest.items) {
      const value = this.#itemValues[item.index];
      const actualHash = await sha256Base64Url(value, this.#options);
      if (actualHash !== item.sha256) {
        throw new OabError(
          "detached_item_integrity_failed",
          `Transfer item ${item.index} failed SHA-256 verification.`,
        );
      }
    }
    const representations = {};
    const assets = [];
    for (const item of this.#manifest.items) {
      const value = this.#itemValues[item.index];
      if (item.kind === "representation") {
        try {
          const text = decoder.decode(value);
          if (text.includes("\u0000")) {
            throw new OabError(
              "detached_text_encoding_invalid",
              `${item.mimeType} contains a forbidden NUL character.`,
            );
          }
          representations[item.mimeType] = text;
        } catch (error) {
          if (error instanceof OabError) throw error;
          throw new OabError(
            "detached_text_encoding_invalid",
            `${item.mimeType} is not valid UTF-8.`,
            { cause: error },
          );
        } finally {
          value.fill(0);
        }
      } else {
        assets.push(Object.freeze({
          name: item.name,
          mimeType: item.mimeType,
          data: value,
        }));
      }
    }
    const completedManifest = this.#manifest;
    const delivery = Object.freeze({
      type: "complete",
      transferId: completedManifest.transferId,
      title: completedManifest.title,
      source: completedManifest.source,
      representations: Object.freeze(representations),
      assets: Object.freeze(assets),
      totalBytes: completedManifest.totalBytes,
    });
    this.#state = "complete";
    this.#clearTerminalMetadata(false);
    return delivery;
  }

  #fail(state) {
    this.#state = state;
    this.#clearTerminalMetadata(true);
  }

  #clearTerminalMetadata(wipeValues) {
    if (wipeValues) {
      for (const value of this.#itemValues) value.fill(0);
    }
    this.#manifest = null;
    this.#manifestDigest = null;
    this.#itemValues = [];
    this.#itemReceivedBytes = [];
    this.#receivedBytes = 0;
    this.#sequence = 0;
    this.#totalFrames = null;
    this.#lastItemIndex = 0;
    this.#options = null;
  }
}
