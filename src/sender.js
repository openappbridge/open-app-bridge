import { OAB_TRANSPORTS } from "./constants.js";
import { isPreparedContent, prepareContent } from "./content.js";
import { createDetachedSenderSession } from "./detached-transport.js";
import { prepareDetachedTransfer } from "./detached-framing.js";
import { waitForDetachedAnswer } from "./detached-callback.js";
import { assertFreshDeclaration } from "./discovery-document.js";
import { OabError } from "./errors.js";
import { createLinkEnvelopeHandoff } from "./link-envelope.js";
import {
  assertSecureContext,
  assertTopLevelContext,
  assertNativeHandoffAnchor,
  bindNativeHandoffAnchor,
  canonicalOrigin,
  clearNativeHandoffAnchor,
  randomToken,
} from "./internal.js";

export const HANDOFF_PROFILES = Object.freeze({
  linkEnvelope: OAB_TRANSPORTS.linkEnvelope,
  detachedDataChannel: OAB_TRANSPORTS.detachedDataChannel,
});

function currentTime(options) {
  const value = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now() must return a non-negative integer timestamp.");
  }
  return value;
}

function senderWindow(options) {
  const windowRef = options.windowRef ?? globalThis.window;
  if (!windowRef?.location) {
    throw new OabError(
      "browser_required",
      "This browser handoff requires a top-level window.",
    );
  }
  assertSecureContext(windowRef, "sender");
  assertTopLevelContext(windowRef, "sender");
  return windowRef;
}

function senderOrigin(windowRef, options) {
  const observed = canonicalOrigin(windowRef.location.origin);
  if (
    options.senderOrigin != null &&
    canonicalOrigin(options.senderOrigin) !== observed
  ) {
    throw new OabError(
      "sender_origin_mismatch",
      "senderOrigin must equal the browser-observed sender origin.",
    );
  }
  return observed;
}

function preparedContent(value) {
  return isPreparedContent(value) ? value : prepareContent(value);
}

function profile(receiver, identifier, now) {
  const declaration = assertFreshDeclaration(receiver, now);
  const configuration = declaration.transports[identifier];
  if (!configuration) {
    throw new OabError(
      "unsupported_transport",
      `The receiver does not advertise ${identifier}.`,
    );
  }
  return { declaration, configuration };
}

function assertContentForProfile(content, configuration) {
  const unsupportedRepresentation = content.representationTypes.find(
    (type) => !configuration.representations.includes(type),
  );
  if (unsupportedRepresentation) {
    throw new OabError(
      "unsupported_representation",
      `This profile does not accept ${unsupportedRepresentation}.`,
    );
  }
  const unsupportedAsset = content.assets.find(
    (asset) => !configuration.assetTypes.includes(asset.mimeType),
  );
  if (unsupportedAsset) {
    throw new OabError(
      "unsupported_asset",
      `This profile does not accept ${unsupportedAsset.mimeType}.`,
    );
  }
  const maximumAssets = configuration.limits.maximumAssets ?? 0;
  const maximumBytes = configuration.limits.maximumTransferBytes ??
    configuration.limits.maximumDecodedBytes;
  if (content.assets.length > maximumAssets) {
    throw new OabError(
      "too_many_assets",
      `This profile accepts at most ${maximumAssets} assets.`,
    );
  }
  if (content.totalBytes > maximumBytes) {
    throw new OabError(
      "transfer_too_large",
      `This profile accepts at most ${maximumBytes} content bytes.`,
    );
  }
  return content;
}

export function assertTrustedUserActivation(windowRef, event) {
  if (event?.isTrusted !== true || event?.type !== "click") {
    throw new OabError(
      "trusted_activation_required",
      "The handoff must be started by a trusted browser event.",
    );
  }
  if (
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    windowRef?.navigator?.userActivation?.isActive !== true
  ) {
    throw new OabError(
      "user_activation_required",
      "Use an unmodified primary click or keyboard activation while the page has fresh user activation.",
    );
  }
}

export function inspectProfileAvailability(receiverValue, contentValue, options = {}) {
  const now = currentTime(options);
  const receiver = assertFreshDeclaration(receiverValue, now);
  const content = contentValue == null ? null : preparedContent(contentValue);
  const result = {};
  for (const identifier of Object.values(HANDOFF_PROFILES)) {
    const configuration = receiver.transports[identifier];
    let reason = null;
    if (!configuration) {
      reason = "not_advertised";
    } else if (content) {
      try {
        assertContentForProfile(content, configuration);
        if (
          identifier === OAB_TRANSPORTS.linkEnvelope &&
          (content.assets.length > 0 ||
            content.representationTypes.some(
              (type) => !["text/markdown", "text/plain"].includes(type),
            ))
        ) {
          reason = "portable_text_only";
        }
      } catch (error) {
        reason = error?.code ?? "incompatible_content";
      }
    }
    result[identifier] = Object.freeze({
      advertised: Boolean(configuration),
      compatible: Boolean(configuration) && reason == null,
      reason,
    });
  }
  return Object.freeze(result);
}

export async function createLinkAnchorHandoff(
  receiverValue,
  contentValue,
  options = {},
) {
  const windowRef = senderWindow(options);
  const content = preparedContent(contentValue);
  let handoff = await createLinkEnvelopeHandoff(
    receiverValue,
    content,
    options,
  );
  const requestId = handoff.requestId;
  const expiresAt = handoff.expiresAt;
  let launchHref = handoff.href;
  let boundAnchor = null;
  let state = "ready";
  const onPageHide = () => close("closed");
  let expiryTimer = setTimeout(() => close("expired"), Math.max(
    0,
    expiresAt - currentTime(options),
  ));
  expiryTimer.unref?.();
  const clearLifecycle = ({ clearHref = true } = {}) => {
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (clearHref) launchHref = "";
    if (clearHref) clearNativeHandoffAnchor(boundAnchor);
    boundAnchor = null;
    handoff = null;
    windowRef.removeEventListener?.("pagehide", onPageHide);
  };
  const close = (nextState = "closed") => {
    if (state !== "ready") return false;
    state = nextState;
    clearLifecycle();
    return true;
  };
  const rejectAlternateActivation = (event) => {
    if (state !== "ready") return;
    const error = new OabError(
      "unsafe_handoff_anchor",
      "A prepared handoff accepts exactly one unmodified primary click.",
    );
    close("closed");
    try {
      options.onActivationError?.(Object.freeze({
        error,
        eventType: String(event?.type ?? "unknown"),
      }));
    } catch (_) {}
  };
  windowRef.addEventListener?.("pagehide", onPageHide, { once: true });
  return Object.freeze({
    ...handoff,
    get href() {
      return launchHref;
    },
    target: "_blank",
    get state() {
      return state;
    },
    bind(anchor) {
      if (state !== "ready") {
        throw new OabError(
          "handoff_not_bindable",
          "Only a ready handoff can be bound to a native anchor.",
        );
      }
      if (boundAnchor && boundAnchor !== anchor) {
        throw new OabError(
          "handoff_already_bound",
          "A prepared handoff capability can be bound to exactly one anchor.",
        );
      }
      boundAnchor = bindNativeHandoffAnchor(
        anchor,
        launchHref,
        rejectAlternateActivation,
      );
      return boundAnchor;
    },
    activate(event) {
      try {
        if (state !== "ready") {
          throw new OabError(
            "handoff_already_activated",
            "A link-envelope handoff may be activated exactly once.",
          );
        }
        assertTrustedUserActivation(windowRef, event);
        assertNativeHandoffAnchor(event, boundAnchor, launchHref);
        const activationTime = currentTime(options);
        if (activationTime >= expiresAt) {
          close("expired");
          throw new OabError(
            "link_envelope_expired",
            "This prepared link has expired. Check the receiver again before sending.",
          );
        }
        assertFreshDeclaration(receiverValue, activationTime);
        const activatedAnchor = boundAnchor;
        state = "launching";
        // The browser has already captured the anchor's activation target for
        // this trusted event. Drop the SDK-held capability immediately so the
        // prepared URL cannot be copied or activated again through this
        // facade. Integrations should bind activate() to the same anchor click.
        clearLifecycle({ clearHref: false });
        launchHref = "";
        return new Promise((resolve) => {
          setTimeout(() => {
            clearNativeHandoffAnchor(activatedAnchor);
            state = "launched";
            resolve(Object.freeze({
              requestId,
              transport: OAB_TRANSPORTS.linkEnvelope,
              status: "launched",
              receiptAvailable: false,
            }));
          }, 0);
        });
      } catch (error) {
        event?.preventDefault?.();
        event?.currentTarget?.removeAttribute?.("href");
        if (state === "ready") close("closed");
        throw error;
      }
    },
    close() {
      close("closed");
    },
  });
}

export async function createDetachedAnchorHandoff(
  receiverValue,
  contentValue,
  options = {},
) {
  const windowRef = senderWindow(options);
  const observedSenderOrigin = senderOrigin(windowRef, options);
  const now = currentTime(options);
  const { declaration, configuration } = profile(
    receiverValue,
    OAB_TRANSPORTS.detachedDataChannel,
    now,
  );
  const content = assertContentForProfile(
    preparedContent(contentValue),
    configuration,
  );
  let transfer = await prepareDetachedTransfer(content, {
    ...options,
    transferId: options.transferId ?? randomToken(32),
    maximumItems:
      configuration.representations.length + configuration.limits.maximumAssets,
    maximumTransferBytes: configuration.limits.maximumTransferBytes,
    maximumFrameBytes: configuration.limits.maximumFrameBytes,
  });
  let session;
  try {
    session = await createDetachedSenderSession({
      ...options,
      senderOrigin: observedSenderOrigin,
      receiverOrigin: declaration.origin,
      receiverEndpoint: declaration.endpoint,
      receiverHelper: configuration.receiverHelper,
      declarationId: declaration.declarationId,
      wireVersion: declaration.selectedVersion,
      maximumSignalingBytes: configuration.limits.maximumSignalingBytes,
      maximumFrameBytes: configuration.limits.maximumFrameBytes,
      expectedReceiverCapabilities: {
        representations: configuration.representations,
        assetTypes: configuration.assetTypes,
        maximumTransferBytes: configuration.limits.maximumTransferBytes,
        maximumAssets: configuration.limits.maximumAssets,
        maximumFrameBytes: configuration.limits.maximumFrameBytes,
      },
    });
  } catch (error) {
    transfer.dispose?.();
    throw error;
  }

  let state = "ready";
  let launchHref = session.launchHref;
  let boundAnchor = null;
  let answerWaiter = null;
  let expiryTimer = null;
  let settled = false;
  let generation = 0;
  let launchBoundary = null;
  let launchBoundaryPassed = false;
  let pendingTermination = null;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {});

  const cleanup = () => {
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null;
    launchHref = "";
    clearNativeHandoffAnchor(boundAnchor);
    boundAnchor = null;
    answerWaiter?.close();
    answerWaiter = null;
    const activeSession = session;
    session = null;
    const activeTransfer = transfer;
    transfer = null;
    activeSession?.close();
    activeTransfer?.dispose?.();
    windowRef.removeEventListener?.("pagehide", onPageHide);
  };
  const finalizeTermination = (terminalState, reason) => {
    if (["closed", "expired", "failed", "preserved", "discarded"].includes(state)) {
      return;
    }
    generation += 1;
    state = terminalState;
    cleanup();
    if (!settled && reason) {
      settled = true;
      rejectResult(reason);
    }
  };
  const terminate = (terminalState, reason) => {
    if (["closed", "expired", "failed", "preserved", "discarded"].includes(state)) {
      return;
    }
    if (launchBoundary && !launchBoundaryPassed) {
      if (pendingTermination) return;
      pendingTermination = Object.freeze({ terminalState, reason });
      void launchBoundary.then(() => {
        const pending = pendingTermination;
        pendingTermination = null;
        if (pending) finalizeTermination(pending.terminalState, pending.reason);
      });
      return;
    }
    finalizeTermination(terminalState, reason);
  };
  const onPageHide = () => terminate("closed", new OabError(
    "sender_page_closed",
    "The sender page ended before the detached handoff completed.",
  ));
  const rejectAlternateActivation = (event) => {
    if (state !== "ready") return;
    const error = new OabError(
      "unsafe_handoff_anchor",
      "A prepared handoff accepts exactly one unmodified primary click.",
    );
    terminate("failed", error);
    try {
      options.onActivationError?.(Object.freeze({
        error,
        eventType: String(event?.type ?? "unknown"),
      }));
    } catch (_) {}
  };
  windowRef.addEventListener?.("pagehide", onPageHide, { once: true });
  expiryTimer = setTimeout(() => terminate("expired", new OabError(
    "detached_offer_expired",
    "The detached handoff expired before the receiver connected.",
  )), Math.max(0, session.offer.expiresAt - currentTime(options)));
  expiryTimer.unref?.();

  return Object.freeze({
    transport: OAB_TRANSPORTS.detachedDataChannel,
    requestId: session.requestId,
    expiresAt: session.offer.expiresAt,
    get href() {
      return launchHref;
    },
    target: "_blank",
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer",
    result,
    get state() {
      return state;
    },
    bind(anchor) {
      if (state !== "ready") {
        throw new OabError(
          "handoff_not_bindable",
          "Only a ready handoff can be bound to a native anchor.",
        );
      }
      if (boundAnchor && boundAnchor !== anchor) {
        throw new OabError(
          "handoff_already_bound",
          "A prepared handoff capability can be bound to exactly one anchor.",
        );
      }
      boundAnchor = bindNativeHandoffAnchor(
        anchor,
        launchHref,
        rejectAlternateActivation,
      );
      return boundAnchor;
    },
    activate(event) {
      try {
        if (state !== "ready") {
          throw new OabError(
            "handoff_already_activated",
            "A detached handoff may be activated exactly once.",
          );
        }
        assertTrustedUserActivation(windowRef, event);
        assertNativeHandoffAnchor(event, boundAnchor, launchHref);
        const activationTime = currentTime(options);
        if (activationTime >= session.offer.expiresAt) {
          terminate("expired", new OabError(
            "detached_offer_expired",
            "This detached offer expired before activation.",
          ));
          throw new OabError(
            "detached_offer_expired",
            "This detached offer expired before activation.",
          );
        }
        assertFreshDeclaration(declaration, activationTime);
      } catch (error) {
        event?.preventDefault?.();
        event?.currentTarget?.removeAttribute?.("href");
        if (state === "ready") terminate("failed", error);
        throw error;
      }
      state = "launching";
      const activatedAnchor = boundAnchor;
      const activationGeneration = generation;
      const remainingOfferLifetime = Math.max(
        1,
        session.offer.expiresAt - currentTime(options),
      );
      try {
        answerWaiter = waitForDetachedAnswer({
          requestId: session.requestId,
          channelId: session.channelId,
          receiverOrigin: declaration.origin,
        }, {
          ...options,
          maximumSignalingBytes: configuration.limits.maximumSignalingBytes,
          timeoutMs: Math.min(
            options.answerTimeoutMs ?? remainingOfferLifetime,
            remainingOfferLifetime,
          ),
        });
      } catch (error) {
        event?.preventDefault?.();
        event?.currentTarget?.removeAttribute?.("href");
        terminate("failed", error);
        throw error;
      }
      // The DOM anchor owns the navigation already initiated by this trusted
      // click. The SDK no longer exposes the one-shot offer URL.
      launchHref = "";
      boundAnchor = null;
      launchBoundary = new Promise((resolve) => {
        setTimeout(() => {
          clearNativeHandoffAnchor(activatedAnchor);
          launchBoundaryPassed = true;
          if (
            !pendingTermination &&
            generation === activationGeneration &&
            state === "launching"
          ) {
            state = "launched";
          }
          resolve();
        }, 0);
      });
      let answerOutcome = answerWaiter.promise.then(
        (value) => Object.freeze({ value, error: null }),
        (error) => Object.freeze({ value: null, error }),
      );
      (async () => {
        try {
          // The answer wait starts immediately, but no success or failure can
          // settle the public result until the native launch has survived a
          // complete event-loop task.
          await launchBoundary;
          if (generation !== activationGeneration || state !== "launched") return;
          let { value: sealedAnswer, error: answerError } = await answerOutcome;
          answerOutcome = null;
          answerWaiter?.close();
          answerWaiter = null;
          if (answerError) throw answerError;
          state = "connecting";
          try {
            await session.acceptSealedAnswer(sealedAnswer);
          } finally {
            sealedAnswer = null;
            answerError = null;
          }
          if (generation !== activationGeneration || state !== "connecting") return;
          if (expiryTimer != null) clearTimeout(expiryTimer);
          expiryTimer = null;
          state = "transferring";
          const preview = await session.sendTransfer(transfer, {
            ...options,
            maximumFrameBytes: configuration.limits.maximumFrameBytes,
          });
          if (generation !== activationGeneration || state !== "transferring") return;
          state = "previewing";
          if (!settled) {
            settled = true;
            resolveResult(preview);
          }
          preview.completion.then((disposition) => {
            if (generation !== activationGeneration || state !== "previewing") return;
            state = disposition;
            generation += 1;
            cleanup();
          }, (error) => {
            if (generation !== activationGeneration) return;
            terminate("failed", error);
          });
        } catch (error) {
          if (generation !== activationGeneration) return;
          if (!settled) {
            settled = true;
            rejectResult(error);
          }
          terminate("failed");
        }
      })();
      return result;
    },
    close() {
      terminate("closed", new OabError(
        "handoff_closed",
        "The detached handoff was closed before preview.",
      ));
    },
  });
}

export function createHandoff(receiver, content, options = {}) {
  if (options.transport === OAB_TRANSPORTS.linkEnvelope) {
    return createLinkAnchorHandoff(receiver, content, options);
  }
  if (options.transport === OAB_TRANSPORTS.detachedDataChannel) {
    return createDetachedAnchorHandoff(receiver, content, options);
  }
  throw new OabError(
    "transport_selection_required",
    "Select exactly link-envelope/1 or detached-datachannel/1. OAB never chooses or falls back automatically.",
  );
}
