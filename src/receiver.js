import { DEFAULT_LIMITS, OAB_TRANSPORTS } from "./constants.js";
import {
  captureDetachedOfferFromWindow,
  createDetachedAnswerCallbackUrl,
  createDetachedReceiverHelperSession,
  inspectCapturedDetachedOffer,
} from "./detached-callback.js";
import {
  DETACHED_LIFECYCLE_LIMITS,
  acceptDetachedOffer,
} from "./detached-transport.js";
import { DETACHED_SIGNAL_LIMITS } from "./detached-signaling.js";
import { assertFreshDeclaration } from "./discovery-document.js";
import { OabError } from "./errors.js";
import {
  admitIncomingHandoff,
  adoptScrubbedIncomingHandoff,
  assertNativeHandoffAnchor,
  bindNativeHandoffAnchor,
  captureIncomingHandoffFragment,
  clearNativeHandoffAnchor,
} from "./internal.js";
import { consumeLinkEnvelope } from "./link-envelope.js";
import { assertTrustedUserActivation } from "./sender.js";
import {
  PREVIEW_AUTHORIZATION_INTENT,
  createPreviewAuthorizationGrant,
} from "./preview-authorization.js";

const LINK_MARKER = "oab-link";
const DETACHED_MARKER = "oab-detached";
const MAXIMUM_HELPER_READY_TIMEOUT_MS = 15 * 1000;
const encoder = new TextEncoder();

function currentTime(options) {
  const value = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now() must return a non-negative integer timestamp.");
  }
  return value;
}

function fragmentMarker(fragmentValue) {
  const incoming = String(fragmentValue ?? "");
  if (
    incoming.length > DETACHED_SIGNAL_LIMITS.maximumFragmentBytes ||
    encoder.encode(incoming.replace(/^#/u, "")).byteLength >
      DETACHED_SIGNAL_LIMITS.maximumFragmentBytes
  ) {
    throw new OabError(
      "handoff_fragment_too_large",
      `An OAB launch fragment must not exceed ${DETACHED_SIGNAL_LIMITS.maximumFragmentBytes} bytes.`,
    );
  }
  const fragment = incoming.replace(/^#/u, "");
  const names = new Set();
  for (const part of fragment.split("&")) {
    const separator = part.indexOf("=");
    const name = separator < 0 ? part : part.slice(0, separator);
    if (
      name === LINK_MARKER ||
      name === DETACHED_MARKER
    ) {
      names.add(name);
    }
  }
  const isLink = names.has(LINK_MARKER);
  const isDetached = names.has(DETACHED_MARKER);
  if (isLink && isDetached) {
    throw new OabError(
      "ambiguous_handoff",
      "A receiver URL must identify exactly one OAB profile.",
    );
  }
  return names.values().next().value ?? null;
}

export function detectIncomingProfile(fragmentValue) {
  const marker = fragmentMarker(fragmentValue);
  if (marker === LINK_MARKER) return OAB_TRANSPORTS.linkEnvelope;
  if (marker === DETACHED_MARKER) return OAB_TRANSPORTS.detachedDataChannel;
  return null;
}

function detachedConfiguration(receiver, options) {
  const declaration = assertFreshDeclaration(receiver, currentTime(options));
  const configuration =
    declaration.transports[OAB_TRANSPORTS.detachedDataChannel];
  if (!configuration) {
    throw new OabError(
      "unsupported_transport",
      `This receiver does not advertise ${OAB_TRANSPORTS.detachedDataChannel}.`,
    );
  }
  return { declaration, configuration };
}

function assertOfferMatchesDiscovery(offer, declaration, configuration) {
  if (
    offer.receiverOrigin !== declaration.origin ||
    offer.receiverHelper !== configuration.receiverHelper ||
    offer.wireVersion !== declaration.selectedVersion ||
    (offer.declarationId ?? null) !== (declaration.declarationId ?? null)
  ) {
    throw new OabError(
      "detached_discovery_mismatch",
      "The detached offer does not match the receiver's current discovery declaration.",
    );
  }
}

function requireCallback(options, name, message) {
  if (typeof options[name] !== "function") {
    const code = `${name.replace(/[A-Z]/gu, (letter) =>
      `_${letter.toLowerCase()}`)}_required`;
    throw new OabError(code, message);
  }
  return options[name];
}

function assertCurrentReceiverEndpoint(windowRef, declaration) {
  let current;
  try {
    const origin = windowRef.location?.origin;
    current = new URL(
      `${origin}${windowRef.location?.pathname ?? ""}` +
        `${windowRef.location?.search ?? ""}`,
    );
  } catch (error) {
    throw new OabError(
      "detached_receiver_endpoint_mismatch",
      "The detached receiver is not running at its discovered endpoint.",
      { cause: error },
    );
  }
  const expected = new URL(declaration.endpoint);
  if (
    current.origin !== expected.origin ||
    current.pathname !== expected.pathname ||
    current.search ||
    current.username ||
    current.password
  ) {
    throw new OabError(
      "detached_receiver_endpoint_mismatch",
      "The detached receiver must run at its exact non-redirecting discovered endpoint.",
    );
  }
}

/**
 * Synchronously captures and scrubs a detached fragment. No asynchronous
 * parsing, key import, or WebRTC operation occurs until prepare()/verify().
 */
export function captureDetachedReceiverHandoff(receiverValue, options = {}) {
  const windowRef = options.windowRef ?? globalThis.window;
  // Capture and scrub against the protocol hard ceiling before discovery or
  // endpoint validation. A stale, unsupported, or misrouted marked launch
  // must never leave signaling material in browser history.
  let capture = captureDetachedOfferFromWindow(windowRef, {
    maximumSignalingBytes: DETACHED_SIGNAL_LIMITS.maximumFragmentBytes,
    capturedHandoff: options.capturedHandoff,
  });
  // Bootstrap captures are one-shot URL material, not lifecycle options.
  // Exclude them from every downstream spread so the controller cannot retain
  // a second copy after the fragment has been consumed and scrubbed.
  const {
    capturedHandoff: _capturedHandoff,
    scrubbedHandoff: _scrubbedHandoff,
    ...lifecycleOptions
  } = options;
  options = lifecycleOptions;
  const { declaration, configuration } = detachedConfiguration(
    receiverValue,
    options,
  );
  if (
    encoder.encode(capture.fragment.replace(/^#/u, "")).byteLength >
      configuration.limits.maximumSignalingBytes
  ) {
    throw new OabError(
      "detached_fragment_too_large",
      "The captured detached offer exceeds the receiver signaling limit.",
    );
  }
  const helperReadyTimeoutMs = options.helperReadyTimeoutMs ??
    MAXIMUM_HELPER_READY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(helperReadyTimeoutMs) ||
    helperReadyTimeoutMs < 100 ||
    helperReadyTimeoutMs > MAXIMUM_HELPER_READY_TIMEOUT_MS
  ) {
    throw new TypeError(
      `helperReadyTimeoutMs must be an integer from 100 to ${MAXIMUM_HELPER_READY_TIMEOUT_MS}.`,
    );
  }
  assertCurrentReceiverEndpoint(windowRef, declaration);
  let state = "captured";
  let preparedPromise = null;
  let activeSession = null;
  let helperSession = null;
  let transferHandle = null;
  let sessionLease = null;
  let preparedHref = "";
  let boundVerifyAnchor = null;
  let expiryTimer = null;
  let generation = 0;
  let offerExpiresAt = null;
  let offer = null;
  let preparedRequestId = null;
  let preparedSenderOrigin = null;
  let preparedExpiresAt = null;
  let pendingTermination = null;
  let previewAuthorizationGrant = null;
  let cleanupPromise = Promise.resolve();
  const hostCallbacks = new AbortController();
  const hostCallbackCancelled = new Promise((_, reject) => {
    hostCallbacks.signal.addEventListener("abort", () => reject(
      hostCallbacks.signal.reason instanceof Error
        ? hostCallbacks.signal.reason
        : new OabError(
          "invalid_detached_state",
          "The detached receiver lifecycle ended during a host callback.",
        ),
    ), { once: true });
  });
  hostCallbackCancelled.catch(() => {});
  const raceHostCallback = (value) => Promise.race([
    Promise.resolve(value),
    hostCallbackCancelled,
  ]);

  const reportCleanupError = (operation, error) => {
    try {
      options.onCleanupError?.(Object.freeze({ operation, error }));
    } catch (_) {}
  };

  const terminalState = () => [
    "preserved",
    "discarded",
    "closed",
    "failed",
    "expired",
    "terminating",
  ].includes(state);

  const clearOfferExpiry = () => {
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null;
  };
  const cleanup = () => {
    clearOfferExpiry();
    const helper = helperSession;
    const session = activeSession;
    helperSession = null;
    activeSession = null;
    transferHandle = null;
    capture = null;
    preparedPromise = null;
    offerExpiresAt = null;
    offer = null;
    preparedRequestId = null;
    preparedSenderOrigin = null;
    preparedExpiresAt = null;
    preparedHref = "";
    previewAuthorizationGrant?.revoke();
    previewAuthorizationGrant = null;
    clearNativeHandoffAnchor(boundVerifyAnchor);
    boundVerifyAnchor = null;
    if (!hostCallbacks.signal.aborted) {
      hostCallbacks.abort(new OabError(
        "invalid_detached_state",
        "The detached receiver lifecycle ended during a host callback.",
      ));
    }
    const lease = sessionLease;
    sessionLease = null;
    helper?.close();
    session?.close();
    windowRef.removeEventListener?.("pagehide", onPageHide);
    if (lease) {
      const release = Promise.resolve().then(() => lease.release()).catch(
        (error) => reportCleanupError("session-lease-release", error),
      );
      cleanupPromise = Promise.all([cleanupPromise, release]).then(() => {});
    }
    return cleanupPromise;
  };
  const terminate = (nextState, abortReason = null) => {
    if (terminalState()) return false;
    generation += 1;
    const transfer = transferHandle;
    if (transfer?.state === "preserving" && abortReason) {
      state = "terminating";
      clearOfferExpiry();
      preparedHref = "";
      clearNativeHandoffAnchor(boundVerifyAnchor);
      boundVerifyAnchor = null;
      windowRef.removeEventListener?.("pagehide", onPageHide);
      pendingTermination = Promise.resolve(transfer.abort(abortReason)).finally(() => {
        state = transfer.state === "failed" ? "failed" : nextState;
        const completion = cleanup();
        pendingTermination = null;
        return completion;
      });
      pendingTermination.catch(() => {});
      return true;
    }
    state = nextState;
    if (abortReason) transfer?.abort?.(abortReason).catch?.(() => {});
    cleanup();
    return true;
  };
  const assertCurrent = (snapshot, allowedStates) => {
    if (generation !== snapshot || !allowedStates.includes(state)) {
      throw new OabError(
        "invalid_detached_state",
        "The detached receiver session ended during an asynchronous operation.",
      );
    }
    if (
      offerExpiresAt != null &&
      [
        "inspecting",
        "awaiting-verification",
        "verifying",
        "answering",
      ].includes(state) &&
      currentTime(options) >= offerExpiresAt
    ) {
      terminate("expired", "detached_offer_expired");
      throw new OabError(
        "detached_offer_expired",
        "The detached offer expired during receiver preparation.",
      );
    }
  };
  const scheduleExpiry = (delayMs) => {
    clearOfferExpiry();
    expiryTimer = setTimeout(() => {
      terminate("expired", "detached_offer_expired");
    }, Math.max(0, delayMs));
    expiryTimer.unref?.();
  };
  const onPageHide = () => {
    terminate("closed", "receiver_page_closed");
  };
  const rejectAlternateActivation = (event) => {
    if (state !== "awaiting-verification") return;
    const error = new OabError(
      "unsafe_handoff_anchor",
      "Receiver verification accepts exactly one unmodified primary click.",
    );
    terminate("failed", "invalid_receiver_activation");
    try {
      options.onActivationError?.(Object.freeze({
        error,
        eventType: String(event?.type ?? "unknown"),
      }));
    } catch (_) {}
  };
  windowRef.addEventListener?.("pagehide", onPageHide, { once: true });
  // Until the opaque offer is inspected, the protocol's five-minute hard
  // lifetime is the strongest available bound. prepare() replaces this with
  // the offer's exact absolute expiry.
  scheduleExpiry(DETACHED_SIGNAL_LIMITS.maximumLifetimeMs);

  const controller = {
    transport: OAB_TRANSPORTS.detachedDataChannel,
    get capture() {
      return capture;
    },
    get state() {
      return state;
    },
    prepare() {
      if (preparedPromise) return preparedPromise;
      if (state !== "captured") {
        return Promise.reject(new OabError(
          "invalid_detached_state",
          "The captured detached handoff can no longer be prepared.",
        ));
      }
      state = "inspecting";
      const prepareGeneration = generation;
      preparedPromise = (async () => {
        const inspectedOffer = await inspectCapturedDetachedOffer(capture, {
          ...options,
          maximumSignalingBytes: configuration.limits.maximumSignalingBytes,
        });
        assertCurrent(prepareGeneration, ["inspecting"]);
        offer = inspectedOffer;
        offerExpiresAt = offer.expiresAt;
        scheduleExpiry(offer.expiresAt - currentTime(options));
        assertFreshDeclaration(declaration, currentTime(options));
        assertOfferMatchesDiscovery(offer, declaration, configuration);
        const maximumActiveSessions = options.maximumActiveSessions ??
          DEFAULT_LIMITS.maximumActiveSessions;
        if (
          !Number.isSafeInteger(maximumActiveSessions) ||
          maximumActiveSessions < 1 ||
          maximumActiveSessions > DEFAULT_LIMITS.maximumActiveSessions
        ) {
          throw new TypeError(
            `maximumActiveSessions must be an integer from 1 to ${DEFAULT_LIMITS.maximumActiveSessions}.`,
          );
        }
        const maximumReplayClaims = options.maximumReplayClaims ??
          DEFAULT_LIMITS.maximumReplayClaims;
        if (
          !Number.isSafeInteger(maximumReplayClaims) ||
          maximumReplayClaims < maximumActiveSessions ||
          maximumReplayClaims > DEFAULT_LIMITS.maximumReplayClaims
        ) {
          throw new TypeError(
            `maximumReplayClaims must be an integer from ${maximumActiveSessions} to ${DEFAULT_LIMITS.maximumReplayClaims}.`,
          );
        }
        const acquiredLease = await admitIncomingHandoff(
          options.admitIncomingHandoff,
          {
            requestId: offer.requestId,
            channelId: offer.channelId,
            transport: OAB_TRANSPORTS.detachedDataChannel,
            replayExpiresAt: offer.expiresAt,
            pendingExpiresAt: Math.min(
              offer.expiresAt,
              currentTime(options) + DEFAULT_LIMITS.pendingAuthorizationTtlMs,
            ),
            maximumActiveSessions,
            maximumReplayClaims,
          },
          options,
        );
        if (acquiredLease.admitted !== true) {
          const failures = {
            replay: [
              "detached_offer_replayed",
              "This detached handoff offer was already processed.",
            ],
            "session-capacity": [
              "session_capacity_exceeded",
              "The receiver cannot admit another bounded handoff session.",
            ],
            "replay-capacity": [
              "replay_store_capacity_exceeded",
              "The receiver replay store is temporarily at capacity.",
            ],
          };
          const [code, message] = failures[acquiredLease.reason];
          throw new OabError(code, message);
        }
        try {
          assertCurrent(prepareGeneration, ["inspecting"]);
        } catch (error) {
          await acquiredLease.release();
          throw error;
        }
        sessionLease = acquiredLease;
        helperSession = createDetachedReceiverHelperSession({
          receiverOrigin: declaration.origin,
          receiverHelper: configuration.receiverHelper,
        }, options);
        assertCurrent(prepareGeneration, ["inspecting"]);
        state = "awaiting-verification";
        preparedHref = helperSession.href;
        preparedRequestId = offer.requestId;
        preparedSenderOrigin = offer.senderOrigin;
        preparedExpiresAt = offer.expiresAt;

        const prepared = Object.freeze({
          transport: OAB_TRANSPORTS.detachedDataChannel,
          get requestId() {
            return preparedRequestId;
          },
          get sender() {
            if (preparedSenderOrigin == null) return null;
            return Object.freeze({
              origin: preparedSenderOrigin,
              originVerified: false,
              status: "unverified-pending-connection",
            });
          },
          get href() {
            return preparedHref;
          },
          target: helperSession.target,
          rel: helperSession.rel,
          referrerPolicy: helperSession.referrerPolicy,
          get state() {
            return state;
          },
          get expiresAt() {
            return preparedExpiresAt;
          },
          bind(anchor) {
            if (state !== "awaiting-verification") {
              throw new OabError(
                "handoff_not_bindable",
                "Only a pending Verify handoff can be bound to a native anchor.",
              );
            }
            if (boundVerifyAnchor && boundVerifyAnchor !== anchor) {
              throw new OabError(
                "handoff_already_bound",
                "A prepared Verify capability can be bound to exactly one anchor.",
              );
            }
            boundVerifyAnchor = bindNativeHandoffAnchor(
              anchor,
              preparedHref,
              rejectAlternateActivation,
            );
            return boundVerifyAnchor;
          },
          verify(event) {
            let authorizeOrigin;
            let authorizeManifest;
            let onPreview;
            let reserveIncomingBytes;
            try {
              if (state !== "awaiting-verification") {
                throw new OabError(
                  "invalid_detached_state",
                  "This review action may be activated exactly once.",
                );
              }
              if (currentTime(options) >= offer.expiresAt) {
                terminate("expired", "detached_offer_expired");
                throw new OabError(
                  "detached_offer_expired",
                  "The detached offer expired before receiver verification.",
                );
              }
              assertTrustedUserActivation(windowRef, event);
              assertNativeHandoffAnchor(
                event,
                boundVerifyAnchor,
                preparedHref,
              );
              assertFreshDeclaration(declaration, currentTime(options));
              authorizeOrigin = requireCallback(
                options,
                "authorizeOrigin",
                "A receiver-origin authorization callback is required.",
              );
              authorizeManifest = requireCallback(
                options,
                "authorizeManifest",
                "A separate manifest authorization callback is required.",
              );
              onPreview = requireCallback(
                options,
                "onPreview",
                "A transient preview callback is required.",
              );
              reserveIncomingBytes = requireCallback(
                options,
                "reserveIncomingBytes",
                "An origin-wide aggregate byte reservation callback is required.",
              );
            } catch (error) {
              event?.preventDefault?.();
              event?.currentTarget?.removeAttribute?.("href");
              preparedHref = "";
              if (!terminalState()) terminate("failed");
              throw error;
            }
            state = "verifying";
            const activatedAnchor = boundVerifyAnchor;
            // The DOM anchor owns the helper navigation initiated by this
            // trusted click. Remove the SDK-held one-shot capability now.
            preparedHref = "";
            boundVerifyAnchor = null;
            const launchBoundary = new Promise((resolve) => {
              setTimeout(() => {
                clearNativeHandoffAnchor(activatedAnchor);
                resolve();
              }, 0);
            });
            const verifyGeneration = generation;
            return (async () => {
              try {
                // Do not invoke host authorization or any continuation that
                // could rebuild the receiver UI until native helper navigation
                // has crossed a complete event-loop task.
                await launchBoundary;
                assertCurrent(verifyGeneration, ["verifying"]);
                await helperSession.waitUntilReady(helperReadyTimeoutMs);
                assertCurrent(verifyGeneration, ["verifying"]);
                const originDecision = await raceHostCallback(authorizeOrigin(
                  Object.freeze({
                    origin: offer.senderOrigin,
                    originVerified: false,
                    conditional: true,
                    requestId: offer.requestId,
                    transport: OAB_TRANSPORTS.detachedDataChannel,
                  }),
                  Object.freeze({ signal: hostCallbacks.signal }),
                ));
                assertCurrent(verifyGeneration, ["verifying"]);
                if (originDecision?.allowed !== true) {
                  throw new OabError(
                    "sender_origin_denied",
                    "The receiver declined this sender origin.",
                  );
                }
                const sessionExpiresAt =
                  offer.createdAt +
                  DETACHED_LIFECYCLE_LIMITS.maximumSessionLifetimeMs;
                await raceHostCallback(sessionLease.promote(sessionExpiresAt));
                assertCurrent(verifyGeneration, ["verifying"]);
                const capabilityCeilings = Object.freeze({
                  representations: Object.freeze([
                    ...configuration.representations,
                  ]),
                  assetTypes: Object.freeze([...configuration.assetTypes]),
                  maximumTransferBytes:
                    configuration.limits.maximumTransferBytes,
                  maximumAssets: configuration.limits.maximumAssets,
                  maximumFrameBytes: configuration.limits.maximumFrameBytes,
                });
                const previewAuthorizationBinding = Object.freeze({
                  requestId: offer.requestId,
                  senderOrigin: offer.senderOrigin,
                  receiverOrigin: declaration.origin,
                  receiverId: declaration.declarationId ?? null,
                  transport: OAB_TRANSPORTS.detachedDataChannel,
                  intent: PREVIEW_AUTHORIZATION_INTENT,
                  capabilityCeilings,
                  expiresAt: sessionExpiresAt,
                  sessionGeneration: verifyGeneration,
                });
                previewAuthorizationGrant = createPreviewAuthorizationGrant(
                  previewAuthorizationBinding,
                );
                state = "answering";
                const createdSession = await acceptDetachedOffer(offer, {
                  ...options,
                  signal: hostCallbacks.signal,
                  verificationAuthorized: true,
                  receiverOrigin: declaration.origin,
                  maximumFrameBytes: configuration.limits.maximumFrameBytes,
                });
                try {
                  assertCurrent(verifyGeneration, ["answering"]);
                } catch (error) {
                  createdSession.close();
                  throw error;
                }
                activeSession = createdSession;
                const callbackUrl = await createDetachedAnswerCallbackUrl(
                  offer.senderOrigin,
                  {
                    requestId: offer.requestId,
                    channelId: offer.channelId,
                    receiverOrigin: declaration.origin,
                    envelope: activeSession.sealedAnswer,
                  },
                  {
                    ...options,
                    maximumSignalingBytes:
                      configuration.limits.maximumSignalingBytes,
                  },
                );
                assertCurrent(verifyGeneration, ["answering"]);
                helperSession.navigateToCallback(callbackUrl, offer.senderOrigin);
                await activeSession.connected;
                assertCurrent(verifyGeneration, ["answering"]);
                // Offer expiry protects only the unconnected handoff. Once the
                // authenticated channel is open, transfer-phase deadlines own
                // the remaining lifecycle.
                clearOfferExpiry();
                helperSession?.close();
                helperSession = null;
                state = "connected";
                const authorizeBoundManifest = async (
                  manifest,
                  manifestDigest,
                  context,
                ) => {
                  assertCurrent(verifyGeneration, ["connected", "receiving"]);
                  const authorization = previewAuthorizationGrant?.consume(
                    previewAuthorizationBinding,
                    currentTime(options),
                  );
                  previewAuthorizationGrant = null;
                  if (!authorization) {
                    throw new OabError(
                      "preview_authorization_revoked",
                      "The preview authorization is no longer active.",
                    );
                  }
                  return authorizeManifest(
                    manifest,
                    manifestDigest,
                    Object.freeze({
                      signal: context.signal,
                      previewAuthorization: authorization,
                    }),
                  );
                };
                const receivedTransfer = activeSession.receiveTransfer({
                  ...options,
                  capabilities: capabilityCeilings,
                  maximumItems:
                    configuration.representations.length +
                    configuration.limits.maximumAssets,
                  maximumTransferBytes:
                    configuration.limits.maximumTransferBytes,
                  maximumFrameBytes: configuration.limits.maximumFrameBytes,
                  maximumAggregateTransferBytes:
                    options.maximumAggregateTransferBytes ??
                    DEFAULT_LIMITS.maximumAggregateTransferBytes,
                  requestId: offer.requestId,
                  channelId: offer.channelId,
                  sessionExpiresAt,
                  reserveIncomingBytes,
                  authorizeVerifiedSender(evidence) {
                    return {
                      allowed:
                        originDecision?.allowed === true &&
                        evidence?.originVerified === true &&
                        evidence?.origin === offer.senderOrigin,
                    };
                  },
                  authorizeManifest: authorizeBoundManifest,
                  onPreview,
                });
                assertCurrent(verifyGeneration, ["connected"]);
                state = "receiving";
                const transferGeneration = generation;
                receivedTransfer.preview.then(() => {
                  if (
                    generation === transferGeneration &&
                    state === "receiving"
                  ) {
                    state = "previewing";
                  }
                }, (error) => {
                  if (
                    generation === transferGeneration &&
                    !terminalState()
                  ) {
                    terminate("failed");
                  }
                  return error;
                });
                const completion = receivedTransfer.completion.then(async (disposition) => {
                  if (
                    generation === transferGeneration &&
                    !terminalState()
                  ) {
                    terminate(disposition);
                  }
                  await cleanupPromise;
                  return disposition;
                }, async (error) => {
                  if (
                    generation === transferGeneration &&
                    !terminalState()
                  ) {
                    terminate("failed");
                  }
                  await cleanupPromise;
                  throw error;
                });
                completion.catch(() => {});
                transferHandle = Object.freeze({
                  get state() {
                    return receivedTransfer.state;
                  },
                  preview: receivedTransfer.preview,
                  completion,
                  async complete(disposition) {
                    const result = await receivedTransfer.complete(disposition);
                    await completion;
                    return result;
                  },
                  async preserve(transaction) {
                    const result = await receivedTransfer.preserve(transaction);
                    await completion;
                    return result;
                  },
                  async abort(reason) {
                    await receivedTransfer.abort(reason);
                    await completion.catch(() => {});
                  },
                });
                return transferHandle;
              } catch (error) {
                if (!terminalState()) terminate("failed");
                throw error;
              }
            })();
          },
          close() {
            terminate("closed", "receiver_closed");
          },
        });
        return prepared;
      })().catch((error) => {
        if (!terminalState()) terminate("failed");
        throw error;
      });
      return preparedPromise;
    },
    close() {
      terminate("closed", "receiver_closed");
    },
  };
  return Object.freeze(controller);
}

/**
 * Dispatches only on an explicit fragment marker. This is parsing dispatch,
 * not transport fallback or sender-side negotiation.
 */
export function consumeIncomingHandoff(receiverValue, options = {}) {
  const windowRef = options.windowRef ?? globalThis.window;
  const capture = options.scrubbedHandoff == null
    ? captureIncomingHandoffFragment(windowRef, [
      LINK_MARKER,
      DETACHED_MARKER,
    ])
    : adoptScrubbedIncomingHandoff(windowRef, options.scrubbedHandoff);
  if (capture == null) return null;
  // Selection and all declaration/profile validation happen only after the
  // complete marked fragment has been copied and removed from browser state.
  const selected = detectIncomingProfile(capture.fragment);
  if (selected === OAB_TRANSPORTS.detachedDataChannel) {
    const {
      scrubbedHandoff: _scrubbedHandoff,
      capturedHandoff: _capturedHandoff,
      ...lifecycleOptions
    } = options;
    return captureDetachedReceiverHandoff(receiverValue, {
      ...lifecycleOptions,
      capturedHandoff: capture,
    });
  }
  const declaration = assertFreshDeclaration(
    receiverValue,
    currentTime(options),
  );
  const configuration = declaration.transports[selected];
  if (!configuration) {
    throw new OabError(
      "unsupported_transport",
      `This receiver does not advertise ${selected}.`,
    );
  }
  return consumeLinkEnvelope({
    ...options,
    windowRef,
    capturedHandoff: capture,
    expectedEndpoint: declaration.endpoint,
    declarationId: declaration.declarationId,
    acceptedWireVersions: [declaration.selectedVersion],
    representations: configuration.representations,
    maximumUrlBytes: configuration.limits.maximumUrlBytes,
    maximumFragmentBytes: configuration.limits.maximumFragmentBytes,
    maximumDecodedBytes: configuration.limits.maximumDecodedBytes,
    maximumTransferBytes: configuration.limits.maximumDecodedBytes,
  });
}
