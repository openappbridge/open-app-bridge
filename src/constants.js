export const OAB_PROTOCOL = "org.openapp.bridge";
export const OAB_VERSION = "1.0";
export const OAB_WIRE_VERSIONS = Object.freeze([OAB_VERSION]);
export const OAB_DISCOVERY_PATH = "/.well-known/open-app-bridge";

export const OAB_TRANSPORTS = Object.freeze({
  linkEnvelope: "link-envelope/1",
  detachedDataChannel: "detached-datachannel/1",
});

export const LINK_ENVELOPE_REPRESENTATIONS = Object.freeze([
  "text/markdown",
  "text/plain",
]);

export const DETACHED_RESOURCE_LIMITS = Object.freeze({
  maximumTransferBytes: 32 * 1024 * 1024,
  maximumAggregateTransferBytes: 64 * 1024 * 1024,
  maximumActiveSessions: 4,
});

export const DEFAULT_LIMITS = Object.freeze({
  maximumTextBytes: 10 * 1024 * 1024,
  maximumTransferBytes: 16 * 1024 * 1024,
  maximumAggregateTransferBytes: 32 * 1024 * 1024,
  maximumAssets: 32,
  maximumActiveSessions: DETACHED_RESOURCE_LIMITS.maximumActiveSessions,
  maximumReplayClaims: 512,
  pendingAuthorizationTtlMs: 60 * 1000,
  maximumDiscoveryBytes: 8 * 1024,
  maximumLinkEnvelopeUrlBytes: 16 * 1024,
  maximumLinkEnvelopeFragmentBytes: 12 * 1024,
  maximumLinkEnvelopeDecodedBytes: 8 * 1024,
  linkEnvelopeTtlMs: 2 * 60 * 1000,
  maximumLinkEnvelopeLifetimeMs: 5 * 60 * 1000,
});

export const DEFAULT_REPRESENTATIONS = Object.freeze([
  "text/markdown",
  "text/html",
  "text/plain",
]);

export const DEFAULT_ASSET_TYPES = Object.freeze([
  "text/markdown",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export const DEFAULT_EXTENSIONS_BY_MIME = Object.freeze({
  "text/markdown": Object.freeze([".md", ".markdown"]),
  "text/plain": Object.freeze([".txt"]),
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
  "image/gif": Object.freeze([".gif"]),
  "image/webp": Object.freeze([".webp"]),
  "image/svg+xml": Object.freeze([".svg"]),
});
