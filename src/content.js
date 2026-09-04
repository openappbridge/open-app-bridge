import {
  DEFAULT_ASSET_TYPES,
  DEFAULT_EXTENSIONS_BY_MIME,
  DEFAULT_LIMITS,
  DEFAULT_REPRESENTATIONS,
} from "./constants.js";
import { OabError } from "./errors.js";
import { assertSafeDisplayText, safeSourceUrl } from "./internal.js";

const encoder = new TextEncoder();
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const PREPARED_CONTENT_TOKEN = Symbol("PreparedContent");
const preparedContentInstances = new WeakSet();

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function representationTypes(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    new Set(value).size !== value.length ||
    value.some((type) =>
      typeof type !== "string" || !MIME_TYPE_PATTERN.test(type))
  ) {
    throw new OabError(
      "invalid_representation_types",
      "Representations must be 1–16 unique canonical lowercase media types.",
    );
  }
  return value;
}

function isPortableUnicodeText(value) {
  if (value.includes("\u0000")) return false;
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

function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function mimeForName(name, acceptedTypes) {
  const extension = extensionOf(name);
  return acceptedTypes.find((mimeType) =>
    DEFAULT_EXTENSIONS_BY_MIME[mimeType]?.includes(extension),
  );
}

export function safeAssetName(value) {
  if (typeof value !== "string") {
    throw new OabError("invalid_asset", "Every asset needs a filename.");
  }
  const name = assertSafeDisplayText(value, 240, "Asset name");
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new OabError(
      "invalid_asset",
      "Asset names must be safe, path-free filenames of at most 240 characters.",
    );
  }
  return name;
}

export class PreparedContent {
  constructor(value, token) {
    if (token !== PREPARED_CONTENT_TOKEN) {
      throw new TypeError("PreparedContent instances are created by prepareContent().");
    }
    Object.assign(this, value);
    Object.freeze(this.representations);
    Object.freeze(this.assets);
    Object.freeze(this.assetManifest);
    Object.freeze(this);
    preparedContentInstances.add(this);
  }
}

export function isPreparedContent(value) {
  return preparedContentInstances.has(value);
}

export function prepareContent(content, options = {}) {
  const acceptedRepresentations = representationTypes(
    options.representations ?? DEFAULT_REPRESENTATIONS,
  );
  const acceptedAssetTypes = options.assetTypes ?? DEFAULT_ASSET_TYPES;
  const maximumTextBytes = options.maximumTextBytes ??
    DEFAULT_LIMITS.maximumTextBytes;
  const maximumTransferBytes = options.maximumTransferBytes ??
    DEFAULT_LIMITS.maximumTransferBytes;
  const maximumAssets = options.maximumAssets ?? DEFAULT_LIMITS.maximumAssets;

  const providedRepresentations = content?.representations;
  if (providedRepresentations != null && !plainObject(providedRepresentations)) {
    throw new OabError(
      "invalid_text_representation",
      "representations must be a plain media-type-to-string object.",
    );
  }
  for (const type of Object.keys(providedRepresentations ?? {})) {
    if (!MIME_TYPE_PATTERN.test(type)) {
      throw new OabError(
        "invalid_text_representation",
        "Representation keys must be canonical lowercase media types.",
      );
    }
  }
  const suppliedRepresentations = {
    ...(providedRepresentations ?? {}),
    "text/markdown":
      providedRepresentations?.["text/markdown"] ?? content?.markdown,
    "text/html": providedRepresentations?.["text/html"] ?? content?.html,
    "text/plain": providedRepresentations?.["text/plain"] ?? content?.text,
  };
  const representations = {};
  let textBytes = 0;
  for (const mimeType of acceptedRepresentations) {
    const value = suppliedRepresentations[mimeType];
    if (typeof value !== "string" || !value.trim()) continue;
    if (!isPortableUnicodeText(value)) {
      throw new OabError(
        "invalid_text_representation",
        `${mimeType} must contain valid Unicode scalar text without NUL characters.`,
      );
    }
    const size = encoder.encode(value).byteLength;
    if (size > maximumTextBytes) {
      throw new OabError(
        "text_too_large",
        `${mimeType} exceeds the ${maximumTextBytes}-byte text limit.`,
      );
    }
    representations[mimeType] = value;
    textBytes += size;
  }

  const suppliedAssets = Array.isArray(content?.assets) ? content.assets : [];
  if (suppliedAssets.length > maximumAssets) {
    throw new OabError(
      "too_many_assets",
      `A handoff can contain at most ${maximumAssets} assets.`,
    );
  }
  const assets = suppliedAssets.map((value, index) => {
    const isFile = typeof File !== "undefined" && value instanceof File;
    const candidate = value instanceof Blob ? { data: value } : value;
    const data = candidate?.data;
    if (
      !candidate ||
      !(
        data instanceof Blob ||
        data instanceof ArrayBuffer ||
        ArrayBuffer.isView(data)
      )
    ) {
      throw new OabError(
        "invalid_asset",
        `Asset ${index + 1} does not contain Blob, ArrayBuffer, or typed-array data.`,
      );
    }
    const name = safeAssetName(candidate.name ?? (isFile ? value.name : null));
    const inferredMime = mimeForName(name, acceptedAssetTypes);
    if (!inferredMime) {
      throw new OabError(
        "unsupported_asset",
        `${name} is not an accepted asset type.`,
      );
    }
    const blob = data instanceof Blob
      ? data
      : new Blob([data], {
          type: candidate.mimeType || inferredMime,
        });
    const suppliedMime = String(candidate.mimeType || blob.type || "")
      .trim()
      .toLowerCase();
    if (
      suppliedMime &&
      suppliedMime !== inferredMime &&
      suppliedMime !== "application/octet-stream"
    ) {
      throw new OabError(
        "asset_type_mismatch",
        `${name} does not match its declared media type.`,
      );
    }
    return Object.freeze({
      name,
      mimeType: inferredMime,
      size: blob.size,
      blob,
    });
  });
  const assetBytes = assets.reduce((total, asset) => total + asset.size, 0);
  if (textBytes + assetBytes > maximumTransferBytes) {
    throw new OabError(
      "transfer_too_large",
      `The handoff exceeds the ${maximumTransferBytes}-byte transfer limit.`,
    );
  }
  if (Object.keys(representations).length === 0 && assets.length === 0) {
    throw new OabError(
      "empty_handoff",
      "At least one text representation or asset is required.",
    );
  }

  return new PreparedContent({
    title: assertSafeDisplayText(content?.title, 240, "Document title"),
    representations,
    representationTypes: Object.freeze(Object.keys(representations)),
    textBytes,
    assets,
    assetManifest: Object.freeze(
      assets.map(({ name, mimeType, size }) =>
        Object.freeze({ name, mimeType, size }),
      ),
    ),
    assetBytes,
    totalBytes: textBytes + assetBytes,
    sourceApplication: assertSafeDisplayText(
      content?.sourceApplication,
      120,
      "Source application",
    ),
    sourceUrl: safeSourceUrl(content?.sourceUrl),
  }, PREPARED_CONTENT_TOKEN);
}

export function assertContentMatchesReceiver(content, receiver) {
  if (!isPreparedContent(content)) {
    throw new OabError(
      "content_not_prepared",
      "Call prepareContent() before the user presses Send.",
    );
  }
  const unsupportedRepresentation = content.representationTypes.find(
    (type) => !receiver.representations.includes(type),
  );
  if (unsupportedRepresentation) {
    throw new OabError(
      "unsupported_representation",
      `The receiver does not accept ${unsupportedRepresentation}.`,
    );
  }
  const unsupportedAsset = content.assets.find(
    (asset) => !receiver.assetTypes.includes(asset.mimeType),
  );
  if (unsupportedAsset) {
    throw new OabError(
      "unsupported_asset",
      `The receiver does not accept ${unsupportedAsset.mimeType}.`,
    );
  }
  if (content.assets.length > receiver.maximumAssets) {
    throw new OabError(
      "too_many_assets",
      `The receiver accepts at most ${receiver.maximumAssets} assets.`,
    );
  }
  if (content.totalBytes > receiver.maximumTransferBytes) {
    throw new OabError(
      "transfer_too_large",
      `The receiver accepts at most ${receiver.maximumTransferBytes} bytes.`,
    );
  }
  return content;
}
