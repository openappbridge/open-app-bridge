import assert from "node:assert/strict";
import test from "node:test";

import {
  OAB_TRANSPORTS,
  INCOMING_HANDOFF_CAPTURE_LIMITS,
  captureDetachedReceiverHandoff,
  consumeIncomingHandoff,
  createDetachedKeyPair,
  createDetachedOfferLaunchUrl,
  createLinkEnvelopeHandoff,
  detectIncomingProfile,
  prepareContent,
} from "../src/index.js";
import { admitSession, makeReceiver, makeWindow } from "./helpers.mjs";

const REQUEST_ID = "receiver_request_000000000000000";
const BATCH_TOKEN = "receiver_batch_00000000000000000";

const DATA_SDP = [
  "v=0",
  "o=- 1 2 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:abcdefghijklmnopqrstuvwx",
  `a=fingerprint:sha-256 ${"AA:".repeat(31)}AA`,
  "a=setup:actpass",
  "a=sctp-port:5000",
  "",
].join("\r\n");

const HOST_CANDIDATE = Object.freeze({
  candidate:
    "candidate:1 1 udp 2122260223 a1b2c3d4-e5f6-47a8-9012-123456789abc.local 54321 typ host generation 0 ufrag abcd",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "abcd",
});

function candidateFactory(value) {
  const fields = value.candidate.split(" ");
  return {
    type: "host",
    protocol: fields[2].toLowerCase(),
    address: fields[4],
    port: Number(fields[5]),
    relatedAddress: null,
    relatedPort: null,
    tcpType: null,
  };
}

function incomingWindow(href) {
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.location.search = parsed.search;
  windowRef.document = { referrer: "" };
  return windowRef;
}

function scrubBeforeSdk(windowRef) {
  const capture = Object.freeze({
    fragment: windowRef.location.hash,
    href: windowRef.location.href,
    origin: windowRef.location.origin,
    pathname: windowRef.location.pathname,
    search: windowRef.location.search,
  });
  windowRef.history.replaceState(
    windowRef.history.state ?? null,
    "",
    windowRef.location.pathname,
  );
  return capture;
}

async function linkHandoff(receiver, overrides = {}) {
  return createLinkEnvelopeHandoff(
    receiver,
    prepareContent({
      title: "Portable note",
      markdown: "# Portable note",
      text: "Portable note",
      sourceApplication: "Claimed sender",
      sourceUrl: "https://sender.example/note?private=query#fragment",
    }),
    {
      now: () => 1000,
      lifetimeMs: 60_000,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
      ...overrides,
    },
  );
}

async function detachedOfferHref(overrides = {}) {
  const senderKeys = await createDetachedKeyPair();
  const offer = {
    protocol: "org.openapp.bridge",
    wireVersion: "1.0",
    transport: "detached-datachannel/1",
    transportVersion: "1",
    requestId: REQUEST_ID,
    channelId: "c".repeat(43),
    createdAt: 1000,
    expiresAt: 61_000,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/detached-helper",
    declarationId: "declaration-test-0001",
    senderPublicKey: senderKeys.publicKey,
    description: { type: "offer", sdp: DATA_SDP },
    candidates: [HOST_CANDIDATE],
    ...overrides,
  };
  return createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer,
    { now: () => 1000, candidateFactory },
  );
}

test("dispatches only explicit, unambiguous profile markers", () => {
  assert.equal(detectIncomingProfile(""), null);
  assert.equal(detectIncomingProfile("#unrelated=1"), null);
  assert.equal(
    detectIncomingProfile("#oab-link=1&payload=x&digest=y"),
    OAB_TRANSPORTS.linkEnvelope,
  );
  assert.equal(
    detectIncomingProfile("#oab-detached=opaque"),
    OAB_TRANSPORTS.detachedDataChannel,
  );
  assert.throws(
    () => detectIncomingProfile("#oab-link=1&oab-detached=opaque"),
    (error) => error.code === "ambiguous_handoff",
  );
  assert.throws(
    () => detectIncomingProfile(`#oab-link=1&payload=${"A".repeat(33 * 1024)}`),
    (error) => error.code === "handoff_fragment_too_large",
  );

  assert.equal(
    consumeIncomingHandoff(makeReceiver(), {
      windowRef: incomingWindow("https://receiver.example/_oab/receive"),
    }),
    null,
  );
});

test("consumes link-envelope through the receiver facade and labels it unverified", async () => {
  const receiver = makeReceiver({ detached: false });
  const handoff = await linkHandoff(receiver);
  const windowRef = incomingWindow(handoff.href);
  let scrubbedBeforeClaim = false;
  let delivered;
  const originalReplace = windowRef.history.replaceState.bind(windowRef.history);
  windowRef.history.replaceState = (...args) => {
    originalReplace(...args);
    scrubbedBeforeClaim = windowRef.location.hash === "";
  };

  const pending = consumeIncomingHandoff(receiver, {
    windowRef,
    now: () => 2000,
    batchRandomToken: () => BATCH_TOKEN,
    async admitIncomingHandoff(value) {
      assert.equal(scrubbedBeforeClaim, true);
      assert.equal(value.requestId, REQUEST_ID);
      return admitSession();
    },
    async authorizeSender(value) {
      assert.equal(value.evidence.originVerified, false);
      assert.equal(value.source.origin, null);
      return { allowed: true };
    },
    async deliver(value) {
      delivered = value;
    },
  });

  assert.equal(windowRef.location.hash, "");
  const delivery = await pending;
  assert.equal(delivery, delivered);
  assert.equal(delivery.requestId, REQUEST_ID);
  assert.equal(delivery.batchId, `oab_${BATCH_TOKEN}`);
  assert.equal(delivery.source.origin, null);
  assert.equal(delivery.source.url, "https://sender.example/note");
  assert.deepEqual(delivery.evidence, {
    transport: "link-envelope/1",
    originVerified: false,
    appAttested: false,
    userActivationObserved: false,
    declarationIdMatched: true,
    receiverAuthorized: true,
  });
});

test("adopts a frozen parser-blocking capture without reading the scrubbed fragment again", async () => {
  const receiver = makeReceiver({ detached: false });
  const handoff = await linkHandoff(receiver);
  const windowRef = incomingWindow(handoff.href);
  const scrubbedHandoff = scrubBeforeSdk(windowRef);
  windowRef.history.replaceState = () => {
    throw new Error("the SDK must adopt, not recapture, the scrubbed handoff");
  };

  let claimObserved = false;
  const delivery = await consumeIncomingHandoff(receiver, {
    windowRef,
    scrubbedHandoff,
    now: () => 2000,
    batchRandomToken: () => BATCH_TOKEN,
    async admitIncomingHandoff() {
      claimObserved = true;
      return admitSession();
    },
    async authorizeSender() {
      return { allowed: true };
    },
    async deliver() {},
  });

  assert.equal(claimObserved, true);
  assert.equal(delivery.requestId, REQUEST_ID);
  assert.equal(windowRef.location.hash, "");
  assert.equal(windowRef.location.search, "");
  assert.throws(
    () => consumeIncomingHandoff(receiver, {
      windowRef,
      scrubbedHandoff,
    }),
    (error) => error.code === "invalid_handoff_capture",
  );
  assert.deepEqual(INCOMING_HANDOFF_CAPTURE_LIMITS, {
    maximumFragmentBytes: 32768,
    maximumUrlBytes: 65536,
    maximumOriginBytes: 2048,
    maximumPathBytes: 8192,
    maximumQueryBytes: 16384,
  });
});

test("revalidates every public scrub-first location field against a clean current URL", async () => {
  const receiver = makeReceiver({ detached: false });
  const handoff = await linkHandoff(receiver);

  const cases = [
    (capture) => ({ ...capture }),
    (capture) => Object.freeze({ ...capture, extra: "forbidden" }),
    (capture) => Object.freeze({ ...capture, origin: "https://other.example" }),
    (capture) => Object.freeze({ ...capture, pathname: "/other" }),
    (capture) => Object.freeze({ ...capture, search: "?injected=1" }),
    (capture) => Object.freeze({
      ...capture,
      href: capture.href.replace("/_oab/receive", "/other"),
    }),
  ];

  for (const mutate of cases) {
    const windowRef = incomingWindow(handoff.href);
    const capture = mutate(scrubBeforeSdk(windowRef));
    assert.throws(
      () => consumeIncomingHandoff(receiver, {
        windowRef,
        scrubbedHandoff: capture,
      }),
      (error) => error.code === "invalid_handoff_capture",
    );
  }

  const dirtyWindow = incomingWindow(handoff.href);
  const capture = scrubBeforeSdk(dirtyWindow);
  dirtyWindow.location.hash = "#restored-secret";
  assert.throws(
    () => consumeIncomingHandoff(receiver, {
      windowRef: dirtyWindow,
      scrubbedHandoff: capture,
    }),
    (error) => error.code === "invalid_handoff_capture",
  );
});

test("fails closed on link replay, denial, opener retention, and declaration changes", async () => {
  const receiver = makeReceiver({ detached: false });
  const handoff = await linkHandoff(receiver);

  let authorizationCalled = false;
  await assert.rejects(
    consumeIncomingHandoff(receiver, {
      windowRef: incomingWindow(handoff.href),
      now: () => 2000,
      admitIncomingHandoff: async () => ({ admitted: false, reason: "replay" }),
      authorizeSender: async () => {
        authorizationCalled = true;
        return { allowed: true };
      },
      deliver: async () => {},
    }),
    (error) => error.code === "link_envelope_replayed",
  );
  assert.equal(authorizationCalled, false);

  let delivered = false;
  await assert.rejects(
    consumeIncomingHandoff(receiver, {
      windowRef: incomingWindow(handoff.href),
      now: () => 2000,
      admitIncomingHandoff: admitSession,
      authorizeSender: async () => ({ allowed: false }),
      deliver: async () => {
        delivered = true;
      },
    }),
    (error) => error.code === "unverified_sender_denied",
  );
  assert.equal(delivered, false);

  const opened = incomingWindow(handoff.href);
  opened.opener = {};
  await assert.rejects(
    consumeIncomingHandoff(receiver, {
      windowRef: opened,
      now: () => 2000,
      admitIncomingHandoff: admitSession,
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => {},
    }),
    (error) => error.code === "unsafe_window_relationship",
  );
  assert.equal(opened.location.hash, "");

  await assert.rejects(
    consumeIncomingHandoff(
      makeReceiver({ detached: false, declarationId: "replacement-declaration" }),
      {
        windowRef: incomingWindow(handoff.href),
        now: () => 2000,
        admitIncomingHandoff: admitSession,
        authorizeSender: async () => ({ allowed: true }),
        deliver: async () => {},
      },
    ),
    (error) => error.code === "discovery_required",
  );
});

test("captures and scrubs detached bootstrap synchronously before parsing", async () => {
  const windowRef = incomingWindow(
    "https://receiver.example/_oab/receive#oab-detached=malformed-untrusted-offer",
  );
  let rtcCreated = false;
  let candidateParsed = false;
  const controller = captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
    windowRef,
    now: () => 1000,
    peerConnectionFactory() {
      rtcCreated = true;
      throw new Error("must not create RTC while capturing");
    },
    candidateFactory() {
      candidateParsed = true;
      throw new Error("must not invoke the browser candidate parser yet");
    },
  });

  assert.equal(controller.transport, OAB_TRANSPORTS.detachedDataChannel);
  assert.equal(controller.state, "captured");
  assert.equal(windowRef.location.hash, "");
  assert.match(controller.capture.fragment, /^#oab-detached=/u);
  assert.equal(rtcCreated, false);
  assert.equal(candidateParsed, false);

  await assert.rejects(
    controller.prepare(),
    (error) => error.code === "invalid_detached_fragment",
  );
  assert.equal(rtcCreated, false);
  assert.equal(candidateParsed, false);
  assert.equal(controller.state, "failed");
  assert.equal(controller.capture, null);
});

test("scrubs oversized marked launches before retaining or parsing them", () => {
  const oversized = incomingWindow(
    `https://receiver.example/_oab/receive?secret=query#oab-link=1&payload=${"A".repeat(33 * 1024)}`,
  );
  assert.throws(
    () => consumeIncomingHandoff(makeReceiver(), { windowRef: oversized }),
    (error) => error.code === "handoff_fragment_too_large",
  );
  assert.equal(oversized.location.hash, "");
  assert.equal(oversized.location.search, "");
});

test("scrubs a marked detached fragment before exact endpoint failure", () => {
  for (const href of [
    "https://receiver.example/wrong#oab-detached=opaque",
    "https://receiver.example/_oab/receive?state=1#oab-detached=opaque",
  ]) {
    const windowRef = incomingWindow(href);
    assert.throws(
      () => captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
        windowRef,
        now: () => 1000,
      }),
      (error) => error.code === "detached_receiver_endpoint_mismatch",
      href,
    );
    assert.equal(windowRef.location.hash, "", href);
  }
});

test("binds detached helper and declaration ID before creating WebRTC state", async () => {
  for (const overrides of [
    {
      receiverHelper: "https://receiver.example/_oab/other-helper",
    },
    {
      declarationId: "different-declaration-id",
    },
  ]) {
    const windowRef = incomingWindow(await detachedOfferHref(overrides));
    let rtcCreated = false;
    let browserCandidateParsed = false;
    const controller = captureDetachedReceiverHandoff(
      makeReceiver({ link: false }),
      {
        windowRef,
        now: () => 2000,
        peerConnectionFactory() {
          rtcCreated = true;
          throw new Error("must not create RTC before discovery binding");
        },
        candidateFactory() {
          browserCandidateParsed = true;
          throw new Error("must not invoke the browser parser before consent");
        },
      },
    );
    assert.equal(windowRef.location.hash, "");
    await assert.rejects(
      controller.prepare(),
      (error) => error.code === "detached_discovery_mismatch",
    );
    assert.equal(rtcCreated, false);
    assert.equal(browserCandidateParsed, false);
  }
});

test("does not reinterpret detached input as link-envelope when unsupported", () => {
  const windowRef = incomingWindow(
    "https://receiver.example/_oab/receive#oab-detached=opaque",
  );
  assert.throws(
    () => consumeIncomingHandoff(makeReceiver({ detached: false }), { windowRef }),
    (error) => error.code === "unsupported_transport",
  );
  assert.equal(windowRef.location.hash, "");
});

test("scrubs an ambiguous marked fragment before rejecting dispatch", () => {
  const windowRef = incomingWindow(
    "https://receiver.example/_oab/receive" +
      "#oab-link=1&oab-detached=opaque",
  );
  assert.throws(
    () => consumeIncomingHandoff(makeReceiver(), { windowRef }),
    (error) => error.code === "ambiguous_handoff",
  );
  assert.equal(windowRef.location.hash, "");
});

test("scrubs a malformed marked link before rejecting it", async () => {
  const windowRef = incomingWindow(
    "https://receiver.example/_oab/receive#oab-link=%ZZ",
  );
  await assert.rejects(
    consumeIncomingHandoff(makeReceiver({ detached: false }), {
      windowRef,
      admitIncomingHandoff: admitSession,
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => {},
    }),
    (error) => error.code === "invalid_link_envelope",
  );
  assert.equal(windowRef.location.hash, "");
});
