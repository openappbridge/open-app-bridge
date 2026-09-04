import { isOabErrorCode } from "./error-codes.js";

export const OAB_WIRE_ABORT_REASONS = Object.freeze([
  "expired",
  "integrity_failure",
  "internal_error",
  "policy_denied",
  "protocol_error",
  "receiver_cancelled",
  "resource_limit",
  "sender_cancelled",
  "unavailable",
  "user_rejected",
]);

const reasons = new Set(OAB_WIRE_ABORT_REASONS);

export function isOabWireAbortReason(value) {
  return typeof value === "string" && reasons.has(value);
}

export function normalizeWireAbortReason(value, fallback = "protocol_error") {
  const safeFallback = isOabWireAbortReason(fallback)
    ? fallback
    : "protocol_error";
  if (isOabWireAbortReason(value)) return value;
  if (!isOabErrorCode(value)) return safeFallback;
  if (value.includes("sender_aborted") || value === "sender_page_closed") {
    return "sender_cancelled";
  }
  if (value.includes("receiver_aborted") || value === "link_receive_cancelled") {
    return "receiver_cancelled";
  }
  if (value.includes("expired") || value.includes("timeout")) return "expired";
  if (
    value.includes("integrity") ||
    value.includes("mismatch") ||
    value.includes("replayed")
  ) {
    return "integrity_failure";
  }
  if (
    value.includes("too_large") ||
    value.includes("too_many") ||
    value.includes("capacity") ||
    value.includes("overflow") ||
    value.includes("rate_exceeded") ||
    value.includes("frame_limit")
  ) {
    return "resource_limit";
  }
  if (
    value.includes("denied") ||
    value.includes("not_authorized") ||
    value.includes("authorization_required")
  ) {
    return "policy_denied";
  }
  if (
    value.includes("unavailable") ||
    value.includes("unsupported") ||
    value.includes("disabled") ||
    value.endsWith("_required")
  ) {
    return "unavailable";
  }
  return "protocol_error";
}
