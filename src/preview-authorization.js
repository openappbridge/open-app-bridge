import { OAB_TRANSPORTS } from "./constants.js";
import { OabError } from "./errors.js";

const PREVIEW_INTENT = "preview";

function freezeCapabilities(value) {
  return Object.freeze({
    representations: Object.freeze([...value.representations]),
    assetTypes: Object.freeze([...value.assetTypes]),
    maximumTransferBytes: value.maximumTransferBytes,
    maximumAssets: value.maximumAssets,
    maximumFrameBytes: value.maximumFrameBytes,
  });
}

function sameList(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameCapabilities(left, right) {
  return sameList(left.representations, right.representations) &&
    sameList(left.assetTypes, right.assetTypes) &&
    left.maximumTransferBytes === right.maximumTransferBytes &&
    left.maximumAssets === right.maximumAssets &&
    left.maximumFrameBytes === right.maximumFrameBytes;
}

function assertBinding(value) {
  const ceilings = value?.capabilityCeilings;
  if (
    value == null ||
    typeof value !== "object" ||
    typeof value.requestId !== "string" ||
    typeof value.senderOrigin !== "string" ||
    typeof value.receiverOrigin !== "string" ||
    (value.receiverId !== null && typeof value.receiverId !== "string") ||
    value.transport !== OAB_TRANSPORTS.detachedDataChannel ||
    value.intent !== PREVIEW_INTENT ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0 ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    value.sessionGeneration < 0 ||
    ceilings == null ||
    typeof ceilings !== "object" ||
    !Array.isArray(ceilings.representations) ||
    !ceilings.representations.every((item) => typeof item === "string") ||
    !Array.isArray(ceilings.assetTypes) ||
    !ceilings.assetTypes.every((item) => typeof item === "string") ||
    !Number.isSafeInteger(ceilings.maximumTransferBytes) ||
    ceilings.maximumTransferBytes < 0 ||
    !Number.isSafeInteger(ceilings.maximumAssets) ||
    ceilings.maximumAssets < 0 ||
    !Number.isSafeInteger(ceilings.maximumFrameBytes) ||
    ceilings.maximumFrameBytes < 0
  ) {
    throw new TypeError("A complete detached preview-authorization binding is required.");
  }
}

function bindingMatches(expected, actual) {
  return expected.requestId === actual.requestId &&
    expected.senderOrigin === actual.senderOrigin &&
    expected.receiverOrigin === actual.receiverOrigin &&
    expected.receiverId === actual.receiverId &&
    expected.transport === actual.transport &&
    expected.intent === actual.intent &&
    expected.expiresAt === actual.expiresAt &&
    expected.sessionGeneration === actual.sessionGeneration &&
    sameCapabilities(
      expected.capabilityCeilings,
      actual.capabilityCeilings,
    );
}

/**
 * Creates a closure-private, one-use authorization capability. The capability
 * itself is never returned to application code. Only its frozen, non-bearer
 * evidence may be exposed after successful consumption.
 */
export function createPreviewAuthorizationGrant(bindingValue) {
  assertBinding(bindingValue);
  const binding = Object.freeze({
    requestId: bindingValue.requestId,
    senderOrigin: bindingValue.senderOrigin,
    receiverOrigin: bindingValue.receiverOrigin,
    receiverId: bindingValue.receiverId,
    transport: bindingValue.transport,
    intent: bindingValue.intent,
    capabilityCeilings: freezeCapabilities(bindingValue.capabilityCeilings),
    expiresAt: bindingValue.expiresAt,
    sessionGeneration: bindingValue.sessionGeneration,
  });
  const evidence = Object.freeze({
    requestId: binding.requestId,
    senderOrigin: binding.senderOrigin,
    receiverOrigin: binding.receiverOrigin,
    receiverId: binding.receiverId,
    transport: binding.transport,
    intent: binding.intent,
    capabilityCeilings: binding.capabilityCeilings,
    expiresAt: binding.expiresAt,
  });
  let state = "active";

  return Object.freeze({
    consume(actualValue, now) {
      if (state === "consumed") {
        throw new OabError(
          "preview_authorization_consumed",
          "The preview authorization has already been consumed.",
        );
      }
      if (state !== "active") {
        throw new OabError(
          "preview_authorization_revoked",
          "The preview authorization is no longer active.",
        );
      }
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError("Preview authorization time must be a non-negative integer.");
      }
      if (now >= binding.expiresAt) {
        state = "expired";
        throw new OabError(
          "preview_authorization_expired",
          "The preview authorization expired before manifest authorization.",
        );
      }
      assertBinding(actualValue);
      if (!bindingMatches(binding, actualValue)) {
        state = "revoked";
        throw new OabError(
          "preview_authorization_mismatch",
          "The manifest authorization context does not match the preview authorization.",
        );
      }
      state = "consumed";
      return evidence;
    },
    revoke() {
      if (state === "active") state = "revoked";
    },
  });
}

export const PREVIEW_AUTHORIZATION_INTENT = PREVIEW_INTENT;
