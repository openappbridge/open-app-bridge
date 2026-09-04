import assert from "node:assert/strict";
import test from "node:test";

import {
  OAB_TRANSPORTS,
  createDetachedAnchorHandoff,
  createHandoff,
  createLinkAnchorHandoff,
  inspectProfileAvailability,
  prepareContent,
} from "../src/index.js";
import {
  bindHandoff,
  makeReceiver,
  makeWindow,
  trustedClick,
  trustedHandoffClick,
} from "./helpers.mjs";

const REQUEST_ID = "sender_request_id_00000000000000";

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

class FakeChannel extends EventTarget {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = "connecting";
  bufferedAmount = 0;
  label = "oab-1";

  close() {
    this.readyState = "closed";
  }

  send() {}
}

class FakePeerConnection extends EventTarget {
  channel = new FakeChannel();
  closed = false;
  iceGatheringState = "new";

  getConfiguration() {
    return { iceServers: [], iceTransportPolicy: "all" };
  }

  getTransceivers() {
    return [];
  }

  getSenders() {
    return [];
  }

  getReceivers() {
    return [];
  }

  createDataChannel() {
    return this.channel;
  }

  async createOffer() {
    return { type: "offer", sdp: DATA_SDP };
  }

  async setLocalDescription(value) {
    this.localDescription = value;
    queueMicrotask(() => {
      const candidate = new Event("icecandidate");
      candidate.candidate = { toJSON: () => HOST_CANDIDATE };
      this.dispatchEvent(candidate);
      const complete = new Event("icecandidate");
      complete.candidate = null;
      this.dispatchEvent(complete);
    });
  }

  close() {
    this.closed = true;
    this.channel.close();
  }
}

function detachedOptions(connection, overrides = {}) {
  return {
    windowRef: makeWindow(),
    now: () => 1000,
    randomToken(label) {
      return label === "channelId" ? "c".repeat(43) : REQUEST_ID;
    },
    candidateFactory,
    peerConnectionFactory: () => connection,
    ...overrides,
  };
}

test("requires an explicit profile and never chooses or falls back automatically", async () => {
  const receiver = makeReceiver();
  const content = prepareContent({ markdown: "# Explicit profile" });

  assert.throws(
    () => createHandoff(receiver, content),
    (error) => error.code === "transport_selection_required",
  );

  await assert.rejects(
    createHandoff(makeReceiver({ detached: false }), content, {
      transport: OAB_TRANSPORTS.detachedDataChannel,
      windowRef: makeWindow(),
    }),
    (error) => error.code === "unsupported_transport",
  );

  await assert.rejects(
    createHandoff(
      receiver,
      prepareContent({ markdown: "# Text", html: "<h1>Text</h1>" }),
      {
        transport: OAB_TRANSPORTS.linkEnvelope,
        contentClassification: "non-confidential",
        windowRef: makeWindow(),
      },
    ),
    (error) => error.code === "link_envelope_html_unsupported",
  );
});

test("reports each advertised profile independently without selecting one", () => {
  const receiver = makeReceiver();
  const portable = inspectProfileAvailability(
    receiver,
    prepareContent({ markdown: "# Portable", text: "Portable" }),
    { now: () => 1000 },
  );
  assert.deepEqual(portable[OAB_TRANSPORTS.linkEnvelope], {
    advertised: true,
    compatible: true,
    reason: null,
  });
  assert.deepEqual(portable[OAB_TRANSPORTS.detachedDataChannel], {
    advertised: true,
    compatible: true,
    reason: null,
  });

  const rich = inspectProfileAvailability(
    receiver,
    prepareContent({ markdown: "# Rich", html: "<h1>Rich</h1>" }),
    { now: () => 1000 },
  );
  assert.equal(rich[OAB_TRANSPORTS.linkEnvelope].compatible, false);
  assert.equal(
    rich[OAB_TRANSPORTS.linkEnvelope].reason,
    "unsupported_representation",
  );
  assert.equal(rich[OAB_TRANSPORTS.detachedDataChannel].compatible, true);
});

test("creates a one-shot link-envelope anchor with no opener or receipt claim", async () => {
  const windowRef = makeWindow();
  const handoff = await createLinkAnchorHandoff(
    makeReceiver({ detached: false }),
    prepareContent({ markdown: "# Portable" }),
    {
      windowRef,
      now: () => 1000,
      lifetimeMs: 60_000,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
    },
  );

  assert.equal(handoff.transport, OAB_TRANSPORTS.linkEnvelope);
  assert.equal(handoff.target, "_blank");
  assert.equal(handoff.rel, "noopener noreferrer");
  assert.equal(handoff.referrerPolicy, "no-referrer");
  assert.equal(handoff.state, "ready");
  assert.match(handoff.href, /#oab-link=1&payload=/u);

  const launchedPromise = handoff.activate(trustedHandoffClick(handoff));
  assert.equal(handoff.state, "launching");
  assert.equal(handoff.href, "");
  const launched = await launchedPromise;
  assert.deepEqual(launched, {
    requestId: REQUEST_ID,
    transport: OAB_TRANSPORTS.linkEnvelope,
    status: "launched",
    receiptAvailable: false,
  });
  assert.equal(handoff.state, "launched");
  assert.throws(
    () => handoff.activate(trustedClick()),
    (error) => error.code === "handoff_already_activated",
  );
});

test("accepted native anchors survive dispatch and microtasks before cleanup", async () => {
  const link = await createLinkAnchorHandoff(
    makeReceiver({ detached: false }),
    prepareContent({ markdown: "# Portable" }),
    {
      windowRef: makeWindow(),
      now: () => 1000,
      lifetimeMs: 60_000,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
    },
  );
  const linkAnchor = bindHandoff(link);
  const linkHref = linkAnchor.href;
  let indicationSettled = false;
  const indication = link.activate(trustedClick({ currentTarget: linkAnchor }));
  void indication.then(() => {
    indicationSettled = true;
  });
  assert.equal(link.state, "launching");
  assert.equal(linkAnchor.href, linkHref);
  await Promise.resolve();
  assert.equal(indicationSettled, false);
  assert.equal(linkAnchor.href, linkHref);
  const launch = await indication;
  assert.equal(launch.receiptAvailable, false);
  assert.equal(indicationSettled, true);
  assert.equal(link.state, "launched");
  assert.equal(linkAnchor.href, "");

  const rendezvous = new EventTarget();
  rendezvous.postMessage = () => {};
  rendezvous.close = () => {};
  const detached = await createDetachedAnchorHandoff(
    makeReceiver({ link: false }),
    prepareContent({ text: "Private" }),
    detachedOptions(new FakePeerConnection(), {
      broadcastChannelFactory: () => rendezvous,
    }),
  );
  const detachedAnchor = bindHandoff(detached);
  const detachedHref = detachedAnchor.href;
  const result = detached.activate(trustedClick({ currentTarget: detachedAnchor }));
  assert.equal(detached.state, "launching");
  assert.equal(detachedAnchor.href, detachedHref);
  await Promise.resolve();
  assert.equal(detached.state, "launching");
  assert.equal(detachedAnchor.href, detachedHref);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detached.state, "launched");
  assert.equal(detachedAnchor.href, "");
  detached.close();
  await assert.rejects(result, (error) => error.code === "handoff_closed");
});

test("detached close cannot settle or clear an accepted launch before its task boundary", async () => {
  const rendezvous = new EventTarget();
  rendezvous.postMessage = () => {};
  rendezvous.close = () => {};
  const detached = await createDetachedAnchorHandoff(
    makeReceiver({ link: false }),
    prepareContent({ text: "Private" }),
    detachedOptions(new FakePeerConnection(), {
      broadcastChannelFactory: () => rendezvous,
    }),
  );
  const anchor = bindHandoff(detached);
  const href = anchor.href;
  let settled = false;
  const result = detached.activate(trustedClick({ currentTarget: anchor }));
  void result.catch(() => {
    settled = true;
  });

  detached.close();
  assert.equal(detached.state, "launching");
  assert.equal(anchor.href, href);
  assert.equal(settled, false);
  await Promise.resolve();
  assert.equal(detached.state, "launching");
  assert.equal(anchor.href, href);
  assert.equal(settled, false);

  await assert.rejects(result, (error) => error.code === "handoff_closed");
  assert.equal(detached.state, "closed");
  assert.equal(anchor.href, "");
  assert.equal(settled, true);
});

test("armed handoff anchors block alternate navigation and extraction gestures", async () => {
  for (const [type, button] of [
    ["auxclick", 1],
    ["contextmenu", 2],
    ["dragstart", 0],
    ["mousedown", 1],
    ["pointerdown", 2],
  ]) {
    const failures = [];
    const handoff = await createLinkAnchorHandoff(
      makeReceiver({ detached: false }),
      prepareContent({ markdown: "# Guarded capability" }),
      {
        windowRef: makeWindow(),
        now: () => 1_000,
        lifetimeMs: 60_000,
        contentClassification: "non-confidential",
        randomToken: () => REQUEST_ID,
        onActivationError: (failure) => failures.push(failure),
      },
    );
    const anchor = bindHandoff(handoff);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "button", { value: button });
    assert.equal(anchor.dispatchEvent(event), false, type);
    assert.equal(event.defaultPrevented, true, type);
    assert.equal(anchor.href, "", type);
    assert.equal(handoff.href, "", type);
    assert.equal(handoff.state, "closed", type);
    assert.equal(failures.length, 1, type);
    assert.equal(failures[0].eventType, type);
    assert.equal(failures[0].error.code, "unsafe_handoff_anchor");
    const unguarded = new Event("contextmenu", { cancelable: true });
    assert.equal(anchor.dispatchEvent(unguarded), true);
  }
});

test("activation rejects trusted non-click browser events", async () => {
  const handoff = await createLinkAnchorHandoff(
    makeReceiver({ detached: false }),
    prepareContent({ markdown: "# Exact click only" }),
    {
      windowRef: makeWindow(),
      now: () => 1_000,
      lifetimeMs: 60_000,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
    },
  );
  const anchor = bindHandoff(handoff);
  const event = trustedClick({ type: "pointerdown", currentTarget: anchor });
  assert.throws(
    () => handoff.activate(event),
    (error) => error.code === "trusted_activation_required",
  );
  assert.equal(event.defaultPrevented, true);
  assert.equal(anchor.href, "");
  assert.equal(handoff.state, "closed");
});

test("refuses to navigate a prepared link after its envelope expires", async () => {
  let time = 1000;
  const handoff = await createLinkAnchorHandoff(
    makeReceiver({ detached: false }),
    prepareContent({ markdown: "# Expiring" }),
    {
      windowRef: makeWindow(),
      now: () => time,
      lifetimeMs: 1000,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
    },
  );
  time = 2000;
  const event = trustedHandoffClick(handoff);
  assert.throws(
    () => handoff.activate(event),
    (error) => error.code === "link_envelope_expired",
  );
  assert.equal(handoff.state, "expired");
  assert.equal(event.defaultPrevented, true);
  assert.equal(handoff.href, "");
  assert.equal(handoff.target, "_blank");
});

test("rejects missing, misbound, or mutated native handoff anchors", async () => {
  const receiver = makeReceiver({ detached: false });
  const create = () => createLinkAnchorHandoff(
    receiver,
    prepareContent({ markdown: "# Bound capability" }),
    {
      windowRef: makeWindow(),
      now: () => 1000,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
    },
  );

  const unbound = await create();
  const unboundEvent = trustedClick();
  assert.throws(
    () => unbound.activate(unboundEvent),
    (error) => error.code === "native_anchor_required",
  );
  assert.equal(unboundEvent.defaultPrevented, true);

  for (const mutate of [
    (anchor) => { anchor.href = "https://attacker.example/"; },
    (anchor) => { anchor.target = "_self"; },
    (anchor) => { anchor.rel = "opener"; },
    (anchor) => { anchor.referrerPolicy = "unsafe-url"; },
    (anchor) => { anchor.setAttribute("ping", "https://tracker.example/"); },
  ]) {
    const handoff = await create();
    const anchor = bindHandoff(handoff);
    mutate(anchor);
    const event = trustedClick({ currentTarget: anchor });
    assert.throws(
      () => handoff.activate(event),
      (error) => error.code === "unsafe_handoff_anchor",
    );
    assert.equal(event.defaultPrevented, true);
    assert.equal(anchor.href, "");
  }
});

test("scheduled expiry removes the bound DOM capability without a click", async () => {
  const handoff = await createLinkAnchorHandoff(
    makeReceiver({ detached: false }),
    prepareContent({ markdown: "# Short lived" }),
    {
      windowRef: makeWindow(),
      now: () => Date.now(),
      lifetimeMs: 25,
      contentClassification: "non-confidential",
      randomToken: () => REQUEST_ID,
    },
  );
  const anchor = bindHandoff(handoff);
  assert.notEqual(anchor.href, "");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(handoff.state, "expired");
  assert.equal(handoff.href, "");
  assert.equal(anchor.href, "");
});

test("rejects synthetic, modified, stale, framed, and insecure launches", async () => {
  const receiver = makeReceiver({ detached: false });
  const content = prepareContent({ markdown: "# Guarded" });
  const options = {
    now: () => 1000,
    contentClassification: "non-confidential",
    randomToken: () => REQUEST_ID,
  };

  const synthetic = await createLinkAnchorHandoff(receiver, content, {
    ...options,
    windowRef: makeWindow(),
  });
  const syntheticEvent = trustedClick({ isTrusted: false });
  assert.throws(
    () => synthetic.activate(syntheticEvent),
    (error) => error.code === "trusted_activation_required",
  );
  assert.equal(syntheticEvent.defaultPrevented, true);
  assert.equal(synthetic.state, "closed");
  assert.equal(synthetic.href, "");

  const modified = await createLinkAnchorHandoff(receiver, content, {
    ...options,
    windowRef: makeWindow(),
  });
  assert.throws(
    () => modified.activate(trustedClick({ metaKey: true })),
    (error) => error.code === "user_activation_required",
  );
  assert.equal(modified.state, "closed");
  assert.equal(modified.href, "");

  const inactiveWindow = makeWindow();
  inactiveWindow.navigator.userActivation.isActive = false;
  const inactive = await createLinkAnchorHandoff(receiver, content, {
    ...options,
    windowRef: inactiveWindow,
  });
  assert.throws(
    () => inactive.activate(trustedClick()),
    (error) => error.code === "user_activation_required",
  );
  assert.equal(inactive.state, "closed");
  assert.equal(inactive.href, "");

  await assert.rejects(
    createLinkAnchorHandoff(receiver, content, {
      ...options,
      windowRef: makeWindow({ isSecureContext: false }),
    }),
    (error) => error.code === "secure_context_required",
  );
  await assert.rejects(
    createLinkAnchorHandoff(receiver, content, {
      ...options,
      windowRef: makeWindow({ framed: true }),
    }),
    (error) => error.code === "top_level_context_required",
  );

  const stale = makeReceiver({ detached: false, expiresAt: 999 });
  await assert.rejects(
    createLinkAnchorHandoff(stale, content, {
      ...options,
      windowRef: makeWindow(),
    }),
    (error) => error.code === "discovery_expired",
  );
});

test("builds detached-datachannel as a content-free noopener launch facade", async () => {
  const connection = new FakePeerConnection();
  const handoff = await createDetachedAnchorHandoff(
    makeReceiver({ link: false }),
    prepareContent({
      title: "Private material",
      markdown: "# Secret body marker",
      html: "<h1>Secret HTML marker</h1>",
    }),
    detachedOptions(connection),
  );

  assert.equal(handoff.transport, OAB_TRANSPORTS.detachedDataChannel);
  assert.equal(handoff.target, "_blank");
  assert.equal(handoff.rel, "noopener noreferrer");
  assert.equal(handoff.referrerPolicy, "no-referrer");
  assert.equal(handoff.state, "ready");
  assert.doesNotMatch(handoff.href, /Private|Secret|markdown|html/iu);
  assert.match(handoff.href, /#oab-detached=/u);

  const event = trustedClick({ isTrusted: false });
  assert.throws(
    () => handoff.activate(event),
    (error) => error.code === "trusted_activation_required",
  );
  assert.equal(event.defaultPrevented, true);
  assert.equal(handoff.state, "failed");
  assert.equal(handoff.href, "");
  assert.equal(connection.closed, true);
  await assert.rejects(handoff.result, (error) =>
    error.code === "trusted_activation_required");
});

test("blocks navigation when a detached offer expires before activation", async () => {
  let time = 1000;
  const connection = new FakePeerConnection();
  const handoff = await createDetachedAnchorHandoff(
    makeReceiver({ link: false }),
    prepareContent({ text: "Private" }),
    detachedOptions(connection, {
      now: () => time,
      lifetimeMs: 1000,
    }),
  );
  time = 2000;
  const event = trustedHandoffClick(handoff);
  assert.throws(
    () => handoff.activate(event),
    (error) => error.code === "detached_offer_expired",
  );
  assert.equal(event.defaultPrevented, true);
  assert.equal(handoff.state, "expired");
  assert.equal(handoff.href, "");
  assert.equal(connection.closed, true);
  await assert.rejects(handoff.result, (error) =>
    error.code === "detached_offer_expired");
});

test("blocks navigation and terminates when detached rendezvous setup fails", async () => {
  const connection = new FakePeerConnection();
  const failure = new Error("BroadcastChannel unavailable");
  const handoff = await createDetachedAnchorHandoff(
    makeReceiver({ link: false }),
    prepareContent({ text: "Private" }),
    detachedOptions(connection, {
      broadcastChannelFactory() { throw failure; },
    }),
  );
  const event = trustedHandoffClick(handoff);
  assert.throws(() => handoff.activate(event), (error) => error === failure);
  assert.equal(event.defaultPrevented, true);
  assert.equal(handoff.state, "failed");
  assert.equal(handoff.href, "");
  assert.equal(connection.closed, true);
  await assert.rejects(handoff.result, (error) => error === failure);
});

test("rejects a caller-supplied sender origin that differs from the browser", async () => {
  const connection = new FakePeerConnection();
  await assert.rejects(
    createDetachedAnchorHandoff(
      makeReceiver({ link: false }),
      prepareContent({ text: "Private" }),
      detachedOptions(connection, {
        senderOrigin: "https://impostor.example",
      }),
    ),
    (error) => error.code === "sender_origin_mismatch",
  );
  assert.equal(connection.closed, false);
});
