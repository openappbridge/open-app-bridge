import { OabError } from "./errors.js";

const MINIMUM_NETWORK_TIMEOUT_MS = 100;

export const NETWORK_REQUEST_LIMITS = Object.freeze({
  minimumTimeoutMs: MINIMUM_NETWORK_TIMEOUT_MS,
  discovery: Object.freeze({
    defaultTimeoutMs: 8000,
    maximumTimeoutMs: 30000,
  }),
  applicationManifest: Object.freeze({
    defaultTimeoutMs: 4000,
    maximumTimeoutMs: 15000,
  }),
  applicationIcon: Object.freeze({
    defaultTimeoutMs: 4000,
    maximumTimeoutMs: 15000,
  }),
});

function abortError(reason) {
  if (reason instanceof OabError || reason?.name === "AbortError") return reason;
  const error = new Error("The operation was aborted.", {
    cause: reason instanceof Error ? reason : undefined,
  });
  error.name = "AbortError";
  return error;
}

export function resolveNetworkTimeout(value, limits, label) {
  const timeoutMs = value ?? limits.defaultTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MINIMUM_NETWORK_TIMEOUT_MS ||
    timeoutMs > limits.maximumTimeoutMs
  ) {
    throw new TypeError(
      `${label} must be an integer from ${MINIMUM_NETWORK_TIMEOUT_MS} to ${limits.maximumTimeoutMs} ms.`,
    );
  }
  return timeoutMs;
}

/**
 * Runs one complete network operation, including bounded body consumption,
 * under an internal deadline that cannot be disabled by omitting a signal.
 * The caller's AbortSignal remains independently authoritative.
 */
export async function runWithNetworkDeadline(operation, options) {
  if (typeof operation !== "function") {
    throw new TypeError("A network deadline operation must be a function.");
  }
  const externalSignal = options.signal;
  if (
    externalSignal != null &&
    (
      typeof externalSignal !== "object" ||
      typeof externalSignal.addEventListener !== "function" ||
      typeof externalSignal.removeEventListener !== "function" ||
      typeof externalSignal.aborted !== "boolean"
    )
  ) {
    throw new TypeError("signal must be an AbortSignal.");
  }

  const controller = new AbortController();
  const timeoutError = new OabError(options.code, options.message);
  const abortPromise = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(abortError(controller.signal.reason));
    }, { once: true });
  });
  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(abortError(externalSignal.reason));
    }
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) onExternalAbort();

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutError);
  }, options.timeoutMs);

  const operationPromise = Promise.resolve().then(() => {
    if (controller.signal.aborted) {
      throw abortError(controller.signal.reason);
    }
    return operation(controller.signal);
  });

  try {
    return await Promise.race([operationPromise, abortPromise]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
