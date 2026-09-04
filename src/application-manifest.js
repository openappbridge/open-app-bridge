import { OabError } from "./errors.js";
import {
  canonicalOrigin,
  cleanText,
  isUnicodeScalarString,
} from "./internal.js";
import {
  NETWORK_REQUEST_LIMITS,
  resolveNetworkTimeout,
  runWithNetworkDeadline,
} from "./network-deadline.js";

export const MAX_APPLICATION_MANIFEST_BYTES = 32 * 1024;
export const MAX_APPLICATION_ICONS = 8;
export const MAX_APPLICATION_ICON_BYTES = 256 * 1024;
export const MAX_APPLICATION_ICON_DIMENSION = 1024;
export const MAX_APPLICATION_ICON_PIXELS = 1024 * 1024;

const APPLICATION_MANIFEST_TYPES = new Set([
  "application/manifest+json",
  "application/json",
]);
const ICON_TYPES = new Set([
  "image/png",
  "image/jpeg",
]);

function cleanDisplayText(value, maximumLength) {
  const text = cleanText(value, maximumLength * 2);
  if (!text) return null;
  const clean = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return clean
    ? Array.from(clean).slice(0, maximumLength).join("")
    : null;
}

function safeThemeColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(
    color,
  )
    ? color
    : null;
}

function inferredIconType(url) {
  const path = url.pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".ico")) return "image/x-icon";
  return null;
}

function normalizeIcon(value, manifestUrl, origin) {
  if (
    !value ||
    typeof value !== "object" ||
    !isUnicodeScalarString(value.src) ||
    [value.type, value.sizes, value.purpose].some(
      (item) => typeof item === "string" && !isUnicodeScalarString(item),
    )
  ) {
    return null;
  }
  let url;
  try {
    url = new URL(value.src, manifestUrl);
  } catch (_) {
    return null;
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const declaredType = String(value.type || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const type = declaredType || inferredIconType(url);
  if (!type || !ICON_TYPES.has(type)) return null;
  const sizes = String(value.sizes || "").trim().toLowerCase();
  if (
    sizes &&
    sizes !== "any" &&
    !sizes
      .split(/\s+/u)
      .every((size) => /^\d{1,5}x\d{1,5}$/u.test(size))
  ) {
    return null;
  }
  const purpose = String(value.purpose || "any")
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((item) => ["any", "maskable", "monochrome"].includes(item));
  return Object.freeze({
    src: url.href,
    type,
    sizes: sizes || null,
    purpose: Object.freeze(purpose.length ? [...new Set(purpose)] : ["any"]),
  });
}

function resolveManifestUrl(originValue, manifestValue) {
  const origin = canonicalOrigin(originValue);
  if (!isUnicodeScalarString(manifestValue) || !manifestValue.trim()) {
    throw new OabError(
      "invalid_application_manifest",
      "The receiver application manifest URL is missing.",
    );
  }
  let url;
  try {
    url = new URL(manifestValue.trim(), origin);
  } catch (_) {
    throw new OabError(
      "invalid_application_manifest",
      "The receiver application manifest URL is invalid.",
    );
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new OabError(
      "invalid_application_manifest",
      "The receiver application manifest must remain on the receiver origin.",
    );
  }
  return url.href;
}

function resourceLength(response, maximumBytes, code, label) {
  const raw = response.headers.get("content-length");
  if (raw == null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new OabError(
      "invalid_resource_length",
      `The ${label} returned a non-canonical Content-Length header.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximumBytes) {
    throw new OabError(
      code,
      `The ${label} exceeds the supported size.`,
    );
  }
  return value;
}

async function readBoundedBytes(response, options) {
  resourceLength(
    response,
    options.maximumBytes,
    options.tooLargeCode,
    options.label,
  );
  if (!response.body?.getReader) {
    throw new OabError(
      "bounded_response_required",
      `The ${options.label} response cannot be consumed with a bounded stream.`,
    );
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    try {
      Promise.resolve(reader.cancel(options.signal?.reason)).catch(() => {});
    } catch (_) {}
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > options.maximumBytes) {
        await reader.cancel();
        throw new OabError(
          options.tooLargeCode,
          `The ${options.label} exceeds the supported size.`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(); } catch (_) {}
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function normalizeApplicationManifest(value, options = {}) {
  if (!value || typeof value !== "object") return null;
  const supportedStrings = [
    value.name,
    value.short_name,
    value.shortName,
    value.description,
    value.theme_color,
    value.themeColor,
  ];
  if (
    supportedStrings.some(
      (item) => typeof item === "string" && !isUnicodeScalarString(item),
    ) ||
    (Array.isArray(value.icons) && value.icons.some((icon) =>
      icon && typeof icon === "object" &&
      [icon.src, icon.type, icon.sizes, icon.purpose].some(
        (item) => typeof item === "string" && !isUnicodeScalarString(item),
      )))
  ) {
    return null;
  }
  const origin = canonicalOrigin(options.origin);
  let manifestUrl;
  try {
    manifestUrl = resolveManifestUrl(
      origin,
      options.manifestUrl ?? value.manifestUrl,
    );
  } catch (_) {
    return null;
  }
  const name = cleanDisplayText(value.name, 80);
  const shortName = cleanDisplayText(
    value.short_name ?? value.shortName,
    40,
  );
  const description = cleanDisplayText(value.description, 240);
  const icons = Object.freeze(
    (Array.isArray(value.icons) ? value.icons : [])
      .map((icon) => normalizeIcon(icon, manifestUrl, origin))
      .filter(Boolean)
      .slice(0, MAX_APPLICATION_ICONS),
  );
  const themeColor = safeThemeColor(value.theme_color ?? value.themeColor);
  if (!name && !shortName && !description && icons.length === 0) return null;
  return Object.freeze({
    manifestUrl,
    name,
    shortName,
    description,
    icons,
    themeColor,
  });
}

async function readBoundedText(response, signal) {
  const bytes = await readBoundedBytes(response, {
    maximumBytes: MAX_APPLICATION_MANIFEST_BYTES,
    tooLargeCode: "application_manifest_too_large",
    label: "receiver application manifest",
    signal,
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function fetchReceiverApplicationManifest(
  origin,
  manifestValue,
  options = {},
) {
  const manifestUrl = resolveManifestUrl(origin, manifestValue);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new OabError(
      "fetch_unavailable",
      "Receiver application metadata requires fetch().",
    );
  }
  const timeoutMs = resolveNetworkTimeout(
    options.timeoutMs,
    NETWORK_REQUEST_LIMITS.applicationManifest,
    "application manifest timeoutMs",
  );
  return runWithNetworkDeadline(async (signal) => {
    let response;
    try {
      response = await fetchImpl(manifestUrl, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/manifest+json, application/json;q=0.9" },
        signal,
      });
    } catch (error) {
      throw new OabError(
        "application_manifest_unavailable",
        "The receiver application metadata could not be read.",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new OabError(
        "application_manifest_unavailable",
        `The receiver application manifest returned HTTP ${response.status}.`,
      );
    }
    if (response.redirected === true || response.url !== manifestUrl) {
      throw new OabError(
        "application_manifest_redirected",
        "The receiver application manifest did not remain at its declared URL.",
      );
    }
    const contentType = String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!APPLICATION_MANIFEST_TYPES.has(contentType)) {
      throw new OabError(
        "invalid_application_manifest",
        "The receiver application manifest has an unsupported content type.",
      );
    }
    let value;
    try {
      value = JSON.parse(await readBoundedText(response, signal));
    } catch (error) {
      if (error instanceof OabError) throw error;
      throw new OabError(
        "invalid_application_manifest",
        "The receiver application manifest is not valid JSON.",
        { cause: error },
      );
    }
    const application = normalizeApplicationManifest(value, {
      origin,
      manifestUrl,
    });
    if (!application) {
      throw new OabError(
        "invalid_application_manifest",
        "The receiver application manifest contains no usable display metadata.",
      );
    }
    return application;
  }, {
    signal: options.signal,
    timeoutMs,
    code: "application_manifest_timeout",
    message: "The receiver application manifest did not complete before its deadline.",
  });
}

function iconSize(icon) {
  if (icon.sizes === "any") return Number.POSITIVE_INFINITY;
  const sizes = String(icon.sizes || "")
    .split(/\s+/u)
    .map((value) => value.match(/^(\d+)x(\d+)$/u))
    .filter(Boolean)
    .map((match) => Math.min(Number(match[1]), Number(match[2])));
  return sizes.length ? Math.max(...sizes) : 0;
}

export function selectApplicationIcon(application, preferredSize = 96) {
  const icons = Array.isArray(application?.icons) ? application.icons : [];
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const icon of icons) {
    const size = iconSize(icon);
    const sizeScore = !Number.isFinite(size)
      ? 4
      : size >= preferredSize
        ? size - preferredSize
        : (preferredSize - size) * 3;
    const purposeScore = icon.purpose?.includes("any") ? 0 : 12;
    const score = sizeScore + purposeScore;
    if (score < bestScore) {
      best = icon;
      bestScore = score;
    }
  }
  return best;
}

function readAscii(bytes, offset, length) {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function assertIconDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_APPLICATION_ICON_DIMENSION ||
    height > MAX_APPLICATION_ICON_DIMENSION ||
    width * height > MAX_APPLICATION_ICON_PIXELS
  ) {
    throw new OabError(
      "application_icon_dimensions_unsupported",
      "The receiver application icon has unsupported pixel dimensions.",
    );
  }
  return Object.freeze({ width, height });
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < 57 ||
    signature.some((value, index) => bytes[index] !== value)
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunkCount = 0;
  let dimensions = null;
  let sawImageData = false;
  while (offset < bytes.byteLength && chunkCount < 1024) {
    if (offset + 12 > bytes.byteLength) return null;
    const length = view.getUint32(offset);
    const type = readAscii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/u.test(type) || end > bytes.byteLength) return null;
    if (chunkCount === 0) {
      if (type !== "IHDR" || length !== 13) return null;
      dimensions = assertIconDimensions(
        view.getUint32(offset + 8),
        view.getUint32(offset + 12),
      );
    } else if (type === "IHDR") {
      return null;
    }
    // APNG is animated PNG. Receiver identity artwork is deliberately static
    // so a remembered app card cannot become a persistent attention surface.
    if (type === "acTL") {
      throw new OabError(
        "animated_application_icon_forbidden",
        "Animated PNG application icons are not allowed.",
      );
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      return length === 0 && sawImageData && end === bytes.byteLength
        ? dimensions
        : null;
    }
    offset = end;
    chunkCount += 1;
  }
  return null;
}

function gifDimensions(bytes) {
  if (
    bytes.byteLength < 10 ||
    !["GIF87a", "GIF89a"].includes(readAscii(bytes, 0, 6))
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return assertIconDimensions(view.getUint16(6, true), view.getUint16(8, true));
}

function jpegDimensions(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
        .includes(marker)
    ) {
      if (length < 7) break;
      return assertIconDimensions(
        view.getUint16(offset + 5),
        view.getUint16(offset + 3),
      );
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes) {
  if (
    bytes.byteLength < 30 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP"
  ) return null;
  const kind = readAscii(bytes, 12, 4);
  if (kind === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return assertIconDimensions(width, height);
  }
  if (
    kind === "VP8 " &&
    bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
  ) {
    return assertIconDimensions(
      (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    );
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    return assertIconDimensions(
      1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    );
  }
  return null;
}

function icoDimensions(bytes) {
  if (
    bytes.byteLength < 22 ||
    bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (count < 1 || count > 64 || 6 + count * 16 > bytes.byteLength) return null;
  let largest = null;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    const value = assertIconDimensions(width, height);
    if (!largest || value.width * value.height > largest.width * largest.height) {
      largest = value;
    }
  }
  return largest;
}

function svgDimensions(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    return null;
  }
  if (
    /<!DOCTYPE|<!ENTITY|<\?(?:xml-)?stylesheet|<(?:script|foreignObject|iframe|object|embed|image|use|link|style|animate|set)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|\burl\s*\(|@import/iu.test(source)
  ) return null;
  const root = source.match(/<svg\b([^>]*)>/iu);
  if (!root) return null;
  const attribute = (name) => {
    const match = root[1].match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu"));
    return match?.[1] ?? null;
  };
  const numeric = (value) => {
    const match = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)(?:px)?$/u);
    return match ? Math.ceil(Number(match[1])) : null;
  };
  let width = numeric(attribute("width"));
  let height = numeric(attribute("height"));
  if (width == null || height == null) {
    const viewBox = attribute("viewBox")
      ?.trim()
      .split(/[\s,]+/u)
      .map(Number);
    if (
      viewBox?.length === 4 &&
      viewBox.every(Number.isFinite) &&
      viewBox[2] > 0 && viewBox[3] > 0
    ) {
      width ??= Math.ceil(viewBox[2]);
      height ??= Math.ceil(viewBox[3]);
    }
  }
  return width != null && height != null
    ? assertIconDimensions(width, height)
    : null;
}

function inspectIcon(bytes, type) {
  const dimensions = type === "image/png"
    ? pngDimensions(bytes)
    : type === "image/jpeg"
      ? jpegDimensions(bytes)
      : null;
  if (!dimensions) {
    throw new OabError(
      "invalid_application_icon",
      "The receiver application icon does not match its declared media type.",
    );
  }
  return dimensions;
}

export async function fetchReceiverApplicationIcon(application, options = {}) {
  const icon = options.icon ?? selectApplicationIcon(
    application,
    options.preferredSize ?? 96,
  );
  if (!icon) return null;
  const manifestUrl = resolveManifestUrl(
    new URL(application.manifestUrl).origin,
    application.manifestUrl,
  );
  const url = new URL(icon.src, manifestUrl);
  if (url.origin !== new URL(manifestUrl).origin || url.href !== icon.src) {
    throw new OabError(
      "invalid_application_icon",
      "The selected application icon is not an exact same-origin resource.",
    );
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new OabError("fetch_unavailable", "Application icon loading requires fetch().");
  }
  const timeoutMs = resolveNetworkTimeout(
    options.timeoutMs,
    NETWORK_REQUEST_LIMITS.applicationIcon,
    "application icon timeoutMs",
  );
  return runWithNetworkDeadline(async (signal) => {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: icon.type },
        signal,
      });
    } catch (error) {
      throw new OabError(
        "application_icon_unavailable",
        "The receiver application icon could not be read.",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new OabError(
        "application_icon_unavailable",
        `The receiver application icon returned HTTP ${response.status}.`,
      );
    }
    if (response.redirected === true || response.url !== url.href) {
      throw new OabError(
        "application_icon_redirected",
        "The receiver application icon did not remain at its declared URL.",
      );
    }
    const type = String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!ICON_TYPES.has(type) || type !== icon.type) {
      throw new OabError(
        "invalid_application_icon",
        "The receiver application icon returned an unexpected media type.",
      );
    }
    const bytes = await readBoundedBytes(response, {
      maximumBytes: MAX_APPLICATION_ICON_BYTES,
      tooLargeCode: "application_icon_too_large",
      label: "receiver application icon",
      signal,
    });
    const dimensions = inspectIcon(bytes, type);
    return Object.freeze({
      icon,
      type,
      width: dimensions.width,
      height: dimensions.height,
      bytes,
      blob: new Blob([bytes], { type }),
    });
  }, {
    signal: options.signal,
    timeoutMs,
    code: "application_icon_timeout",
    message: "The receiver application icon did not complete before its deadline.",
  });
}
