import { canonicalOrigin } from "./internal.js";

export const UNKNOWN_SENDER_POLICIES = Object.freeze(["ask", "allow", "deny"]);

function normalizeOrigins(value) {
  const result = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    try {
      const origin = canonicalOrigin(candidate);
      if (!result.includes(origin)) result.push(origin);
    } catch (_) {
      // Invalid persisted values do not participate in trust decisions.
    }
  }
  return result;
}

export function normalizeSenderPolicy(value) {
  const unknownSenders = UNKNOWN_SENDER_POLICIES.includes(value?.unknownSenders)
    ? value.unknownSenders
    : "ask";
  const blockedOrigins = normalizeOrigins(value?.blockedOrigins);
  const allowedOrigins = normalizeOrigins(value?.allowedOrigins).filter(
    (origin) => !blockedOrigins.includes(origin),
  );
  return Object.freeze({
    unknownSenders,
    allowedOrigins: Object.freeze(allowedOrigins),
    blockedOrigins: Object.freeze(blockedOrigins),
  });
}

/**
 * Evaluates durable origin policy only when the transport supplied verified
 * origin evidence. Low-assurance profiles always return `ask`; claimed source
 * labels and URLs must never inherit an allow/block decision.
 */
export function evaluateSender(policyValue, evidence) {
  const policy = normalizeSenderPolicy(policyValue);
  if (
    !evidence ||
    evidence.originVerified !== true ||
    typeof evidence.origin !== "string"
  ) {
    return "ask";
  }
  const origin = canonicalOrigin(evidence.origin);
  if (policy.blockedOrigins.includes(origin)) return "block";
  if (policy.allowedOrigins.includes(origin)) return "allow";
  return policy.unknownSenders;
}

export function allowOrigin(policyValue, originValue) {
  const policy = normalizeSenderPolicy(policyValue);
  const origin = canonicalOrigin(originValue);
  return normalizeSenderPolicy({
    ...policy,
    allowedOrigins: [...policy.allowedOrigins, origin],
    blockedOrigins: policy.blockedOrigins.filter((item) => item !== origin),
  });
}

export function blockOrigin(policyValue, originValue) {
  const policy = normalizeSenderPolicy(policyValue);
  const origin = canonicalOrigin(originValue);
  return normalizeSenderPolicy({
    ...policy,
    allowedOrigins: policy.allowedOrigins.filter((item) => item !== origin),
    blockedOrigins: [...policy.blockedOrigins, origin],
  });
}

export function removeOriginRule(policyValue, originValue) {
  const policy = normalizeSenderPolicy(policyValue);
  const origin = canonicalOrigin(originValue);
  return normalizeSenderPolicy({
    ...policy,
    allowedOrigins: policy.allowedOrigins.filter((item) => item !== origin),
    blockedOrigins: policy.blockedOrigins.filter((item) => item !== origin),
  });
}
