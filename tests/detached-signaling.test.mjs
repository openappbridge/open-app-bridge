import assert from "node:assert/strict";
import test from "node:test";

import { createDetachedKeyPair } from "../src/detached-crypto.js";
import { inspectCapturedDetachedOffer } from "../src/detached-callback.js";
import {
  assertDataOnlySdp,
  collectHostCandidates,
  createDetachedOfferLaunchUrl,
  createDetachedTranscript,
  createHostOnlyPeerConnection,
  parseDetachedOfferFragment,
  validateDetachedOffer,
  validateHostCandidate,
} from "../src/detached-signaling.js";

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

const CANDIDATE = {
  candidate:
    "candidate:1 1 udp 2122260223 a1b2c3d4-e5f6-47a8-9012-123456789abc.local 54321 typ host generation 0 ufrag abcd",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "abcd",
};

function candidateFactory(value) {
  const pieces = value.candidate.split(" ");
  return {
    type: "host",
    component: pieces[1] === "1" ? "rtp" : "rtcp",
    protocol: pieces[2].toLowerCase(),
    priority: Number(pieces[3]),
    address: pieces[4],
    port: Number(pieces[5]),
    relatedAddress: null,
    relatedPort: null,
    tcpType: null,
  };
}

test("ignores Firefox's truthy empty end-of-candidates marker", async () => {
  const connection = new EventTarget();
  connection.iceGatheringState = "gathering";
  const collecting = collectHostCandidates(connection, {
    timeoutMs: 1_000,
    candidateFactory,
    expectedSdpMid: "0",
  });
  const emit = (candidate) => {
    const event = new Event("icecandidate");
    event.candidate = candidate;
    connection.dispatchEvent(event);
  };
  emit({
    candidate: "",
    toJSON: () => ({
      candidate: "",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "abcd",
    }),
  });
  emit({ candidate: CANDIDATE.candidate, toJSON: () => CANDIDATE });
  emit(null);
  assert.deepEqual(await collecting, [CANDIDATE]);
});

async function offer(overrides = {}) {
  const keys = await createDetachedKeyPair();
  return {
    protocol: "org.openapp.bridge",
    wireVersion: "1.0",
    transport: "detached-datachannel/1",
    transportVersion: "1",
    requestId: "r".repeat(32),
    channelId: "c".repeat(43),
    createdAt: 1000,
    expiresAt: 61000,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
    declarationId: "declaration-id",
    senderPublicKey: keys.publicKey,
    description: { type: "offer", sdp: DATA_SDP },
    candidates: [CANDIDATE],
    ...overrides,
  };
}

test("round-trips a bounded candidate-free opaque JSEP offer fragment", async () => {
  const value = await offer();
  const options = { now: () => 2000, candidateFactory };
  const validated = validateDetachedOffer(value, options);
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    validated,
    options,
  );
  const url = new URL(href);
  assert.equal(url.origin, "https://receiver.example");
  assert.equal(url.search, "");
  assert.ok(url.hash.length < 32768);
  assert.ok(!href.includes("v=0"));
  assert.ok(!href.includes("A detached note"));
  const decoded = await parseDetachedOfferFragment(url.hash, options);
  assert.equal(decoded.description.sdp, DATA_SDP);
  assert.deepEqual(decoded.candidates, [CANDIDATE]);
  const first = await createDetachedTranscript(decoded, options);
  const second = await createDetachedTranscript(decoded, options);
  assert.deepEqual(first, second);
});

test("binds an absent discovery declaration as an explicit null", async () => {
  const value = await offer({ declarationId: null });
  const options = { now: () => 2000, candidateFactory };
  const validated = validateDetachedOffer(value, options);
  assert.equal(validated.declarationId, null);
  const transcript = await createDetachedTranscript(validated, options);
  assert.equal(transcript.declarationId, null);
  assert.throws(
    () => validateDetachedOffer({ ...value, declarationId: undefined }, options),
    (error) => error.code === "invalid_detached_signal",
  );
});

test("pre-click inspection never invokes the browser ICE parser", async () => {
  const value = await offer();
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    value,
    { now: () => 2000, candidateFactory },
  );
  let parserCalls = 0;
  const options = {
    now: () => 2000,
    candidateFactory(candidate) {
      parserCalls += 1;
      return candidateFactory(candidate);
    },
  };
  const inspected = await inspectCapturedDetachedOffer({
    fragment: new URL(href).hash,
    receiverOrigin: "https://receiver.example",
  }, options);
  assert.equal(parserCalls, 0);
  validateDetachedOffer(inspected, options);
  assert.equal(parserCalls, 1);
});

test("rejects media, SDP-embedded candidates, and public host candidates", async () => {
  assert.throws(
    () => assertDataOnlySdp({
      type: "offer",
      sdp: DATA_SDP.replace(
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      ),
    }, { type: "offer" }),
    (error) => error.code === "invalid_detached_sdp",
  );
  assert.throws(
    () => assertDataOnlySdp({
      type: "offer",
      sdp: DATA_SDP.replace(
        "a=sctp-port:5000",
        `a=candidate:${CANDIDATE.candidate.slice("candidate:".length)}\r\na=sctp-port:5000`,
      ),
    }, { type: "offer" }),
    (error) => error.code === "invalid_detached_sdp",
  );
  assert.throws(
    () => validateHostCandidate({
      ...CANDIDATE,
      candidate:
        "candidate:1 1 udp 2122260223 203.0.113.5 54321 typ host generation 0 ufrag abcd",
    }, { candidateFactory: () => ({
      type: "host",
      protocol: "udp",
      address: "203.0.113.5",
      port: 54321,
      relatedAddress: null,
      relatedPort: null,
      tcpType: null,
    }) }),
    (error) => error.code === "unsafe_detached_candidate",
  );
});

test("accepts only exact loopback raw host candidates", () => {
  for (const address of ["127.0.0.1", "::1"]) {
    const candidate = {
      ...CANDIDATE,
      candidate: `candidate:1 1 udp 2122260223 ${address} 54321 typ host generation 0 ufrag abcd`,
    };
    assert.equal(
      validateHostCandidate(candidate, { candidateFactory }).candidate,
      candidate.candidate,
    );
  }

  for (const address of ["127.0.0.2", "10.0.0.1", "192.168.1.8", "169.254.1.2"]) {
    assert.throws(
      () => validateHostCandidate({
        ...CANDIDATE,
        candidate: `candidate:1 1 udp 2122260223 ${address} 54321 typ host generation 0 ufrag abcd`,
      }, { candidateFactory }),
      (error) => error.code === "unsafe_detached_candidate",
    );
  }
});

test("fails immediately when ICE gathering completes without an eligible candidate", async () => {
  const connection = new EventTarget();
  connection.iceGatheringState = "gathering";
  const collecting = collectHostCandidates(connection, {
    timeoutMs: 1_000,
    candidateFactory,
  });
  connection.iceGatheringState = "complete";
  connection.dispatchEvent(new Event("icegatheringstatechange"));
  await assert.rejects(
    collecting,
    (error) => error.code === "detached_ice_no_eligible_candidate",
  );
});

test("rejects duplicate critical SDP attributes before browser parsing", () => {
  for (const duplicate of [
    "a=ice-ufrag:abcd",
    "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    `a=fingerprint:sha-256 ${"AA:".repeat(31)}AA`,
    "a=mid:0",
    "a=setup:actpass",
    "a=sctp-port:5000",
  ]) {
    assert.throws(
      () => assertDataOnlySdp({
        type: "offer",
        sdp: DATA_SDP.replace("a=sctp-port:5000", `${duplicate}\r\na=sctp-port:5000`),
      }, { type: "offer" }),
      (error) => error.code === "invalid_detached_sdp",
    );
  }
});

test("binds candidates to component one, uint32 priority, and the sole mid", async () => {
  const base = await offer();
  const invalidCandidates = [
    { ...CANDIDATE, candidate: CANDIDATE.candidate.replace(" 1 udp ", " 2 udp ") },
    {
      ...CANDIDATE,
      candidate: CANDIDATE.candidate.replace("2122260223", "4294967296"),
    },
    { ...CANDIDATE, sdpMid: "other" },
    { ...CANDIDATE, sdpMid: "" },
  ];
  for (const candidate of invalidCandidates) {
    assert.throws(
      () => validateDetachedOffer(
        { ...base, candidates: [candidate] },
        { now: () => 2000, candidateFactory },
      ),
      (error) => [
        "invalid_detached_candidate",
        "unsafe_detached_candidate",
      ].includes(error.code),
    );
  }
});

test("constructs peer connections with no STUN or TURN and rejects injected servers", () => {
  let received;
  const safe = createHostOnlyPeerConnection({
    peerConnectionFactory(configuration) {
      received = configuration;
      return {
        getConfiguration: () => ({ iceServers: [] }),
        close() {},
      };
    },
  });
  assert.ok(safe);
  assert.deepEqual(received.iceServers, []);
  assert.throws(
    () => createHostOnlyPeerConnection({
      peerConnectionFactory() {
        return {
          getConfiguration: () => ({
            iceServers: [{ urls: "turn:relay.example" }],
          }),
          close() {},
        };
      },
    }),
    (error) => error.code === "unsafe_webrtc_configuration",
  );
});

test("rejects ambiguous signaling and a receiver-origin mismatch", async () => {
  const value = await offer();
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    value,
    { now: () => 2000, candidateFactory },
  );
  await assert.rejects(
    parseDetachedOfferFragment(`${new URL(href).hash}&payload=duplicate`, {
      now: () => 2000,
      candidateFactory,
    }),
    (error) => error.code === "invalid_detached_fragment",
  );
  const canonical = new URL(href).hash.slice(1);
  const match = canonical.match(
    /^oab-detached=1&payload=([^&]+)&digest=([^&]+)$/u,
  );
  const marker = match[1];
  const payload = match[2];
  const digest = match[3];
  for (const nonCanonical of [
    `payload=${payload}&${marker}=1&digest=${digest}`,
    `%6f${marker.slice(1)}=1&payload=${payload}&digest=${digest}`,
    `${marker}=1&payload=${payload.slice(0, -1)}+&digest=${digest}`,
  ]) {
    await assert.rejects(
      parseDetachedOfferFragment(nonCanonical, {
        now: () => 2000,
        candidateFactory,
      }),
      (error) => error.code === "invalid_detached_fragment",
    );
  }
  assert.throws(
    () => validateDetachedOffer(value, {
      now: () => 2000,
      candidateFactory,
      expectedReceiverOrigin: "https://other.example",
    }),
    (error) => error.code === "detached_receiver_origin_mismatch",
  );
});

test("uses a half-open detached offer validity interval", async () => {
  const value = await offer();
  assert.throws(
    () => validateDetachedOffer(value, {
      now: () => value.expiresAt,
      candidateFactory,
    }),
    (error) => error.code === "detached_signal_expired",
  );
});

test("distinguishes a future detached signal from an expired one", async () => {
  const value = await offer({ createdAt: 100_000, expiresAt: 160_000 });
  assert.throws(
    () => validateDetachedOffer(value, { now: () => 0, candidateFactory }),
    (error) => error.code === "detached_signal_from_future",
  );
});

test("enforces the receiver signaling limit and the normative 32 KiB ceiling", async () => {
  const value = await offer();
  await assert.rejects(
    createDetachedOfferLaunchUrl(
      "https://receiver.example/_oab/receive",
      value,
      {
        now: () => 2000,
        candidateFactory,
        maximumSignalingBytes: 1024,
      },
    ),
    (error) => error.code === "detached_fragment_too_large",
  );
  await assert.rejects(
    createDetachedOfferLaunchUrl(
      "https://receiver.example/_oab/receive",
      value,
      {
        now: () => 2000,
        candidateFactory,
        maximumSignalingBytes: 32769,
      },
    ),
    (error) => error.code === "invalid_signaling_limit",
  );
});
