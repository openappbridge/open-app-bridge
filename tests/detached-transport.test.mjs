import assert from "node:assert/strict";
import test from "node:test";

import { createDetachedKeyPair } from "../src/detached-crypto.js";
import { prepareDetachedTransfer } from "../src/detached-framing.js";
import {
  acceptDetachedOffer,
  createDetachedSenderSession,
} from "../src/detached-transport.js";
import { DETACHED_RECEIVE_SECURITY_OPTIONS } from "./helpers.mjs";

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

const RECEIVER_CAPABILITIES = Object.freeze({
  representations: Object.freeze(["text/plain"]),
  assetTypes: Object.freeze([]),
  maximumTransferBytes: 10000,
  maximumAssets: 0,
  maximumFrameBytes: 512,
});

function candidateFactory(value) {
  const parts = value.candidate.split(" ");
  return {
    type: "host",
    protocol: parts[2].toLowerCase(),
    address: parts[4],
    port: Number(parts[5]),
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
  localDescription = null;
  remoteDescription = null;
  closed = false;

  getConfiguration() { return { iceServers: [] }; }
  getTransceivers() { return []; }
  getSenders() { return []; }
  getReceivers() { return []; }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: DATA_SDP }; }
  async createAnswer() {
    return { type: "answer", sdp: DATA_SDP };
  }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate() {}
  async setLocalDescription(value) {
    this.localDescription = value;
    queueMicrotask(() => {
      const candidateEvent = new Event("icecandidate");
      candidateEvent.candidate = { toJSON: () => CANDIDATE };
      this.dispatchEvent(candidateEvent);
      const completeEvent = new Event("icecandidate");
      completeEvent.candidate = null;
      this.dispatchEvent(completeEvent);
    });
  }
  close() { this.closed = true; }
}

class PairedDataChannel extends EventTarget {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  label = "oab-1";
  peer = null;

  send(value) {
    if (this.readyState !== "open") throw new Error("channel closed");
    const copy = value instanceof Uint8Array ? value.slice() : value;
    queueMicrotask(() => this.peer.dispatchEvent(
      new MessageEvent("message", { data: copy }),
    ));
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function rtcPair() {
  const senderChannel = new PairedDataChannel();
  const receiverChannel = new PairedDataChannel();
  senderChannel.peer = receiverChannel;
  receiverChannel.peer = senderChannel;
  let receiverConnection;

  class PairedPeerConnection extends EventTarget {
    constructor(role) {
      super();
      this.role = role;
    }
    getConfiguration() { return { iceServers: [] }; }
    getTransceivers() { return []; }
    getSenders() { return []; }
    getReceivers() { return []; }
    createDataChannel() { return senderChannel; }
    async createOffer() { return { type: "offer", sdp: DATA_SDP }; }
    async createAnswer() { return { type: "answer", sdp: DATA_SDP }; }
    async addIceCandidate() {}
    async setLocalDescription(value) {
      this.localDescription = value;
      queueMicrotask(() => {
        const candidateEvent = new Event("icecandidate");
        candidateEvent.candidate = { toJSON: () => CANDIDATE };
        this.dispatchEvent(candidateEvent);
        const completeEvent = new Event("icecandidate");
        completeEvent.candidate = null;
        this.dispatchEvent(completeEvent);
      });
    }
    async setRemoteDescription(value) {
      this.remoteDescription = value;
      if (this.role === "sender" && value.type === "answer") {
        senderChannel.readyState = "open";
        receiverChannel.readyState = "open";
        const dataChannelEvent = new Event("datachannel");
        dataChannelEvent.channel = receiverChannel;
        receiverConnection.dispatchEvent(dataChannelEvent);
        senderChannel.dispatchEvent(new Event("open"));
        receiverChannel.dispatchEvent(new Event("open"));
      }
    }
    close() { this.closed = true; }
  }

  const senderConnection = new PairedPeerConnection("sender");
  receiverConnection = new PairedPeerConnection("receiver");
  return { senderConnection, receiverConnection };
}

async function signalingOffer() {
  const senderKeys = await createDetachedKeyPair();
  return {
    protocol: "org.openapp.bridge",
    wireVersion: "1.0",
    transport: "detached-datachannel/1",
    transportVersion: "1",
    requestId: "request_123456789012345678901234",
    channelId: "c".repeat(43),
    createdAt: 1000,
    expiresAt: 61000,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
    declarationId: "declaration-id",
    senderPublicKey: senderKeys.publicKey,
    description: { type: "offer", sdp: DATA_SDP },
    candidates: [CANDIDATE],
  };
}

test("creates a content-free noopener sender launch", async () => {
  const connection = new FakePeerConnection();
  const session = await createDetachedSenderSession({
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverEndpoint: "https://receiver.example/_oab/receive",
    receiverHelper: "https://receiver.example/_oab/helper",
    declarationId: "declaration-id",
    now: () => 1000,
    randomToken: (label) => label === "requestId"
      ? "request_123456789012345678901234"
      : "c".repeat(43),
    candidateFactory,
    expectedReceiverCapabilities: RECEIVER_CAPABILITIES,
    peerConnectionFactory: () => connection,
  });
  assert.equal(session.rel, "noopener noreferrer");
  assert.equal("summary" in session.offer, false);
  assert.equal("source" in session.offer, false);
  assert.ok(!session.launchHref.includes("document"));
  session.close();
});

test("returns a sealed receiver answer before the data channel can open", async () => {
  const connection = new FakePeerConnection();
  const started = Date.now();
  const session = await acceptDetachedOffer(await signalingOffer(), {
    receiverOrigin: "https://receiver.example",
    verificationAuthorized: true,
    now: () => 2000,
    candidateFactory,
    peerConnectionFactory: () => connection,
    channelTimeoutMs: 100,
  });
  assert.equal(session.state, "answer-ready");
  assert.ok(session.sealedAnswer.ciphertext);
  assert.ok(Date.now() - started < 100);
  await assert.rejects(
    session.connected,
    (error) => error.code === "detached_channel_timeout",
  );
  assert.equal(session.state, "failed");
});

test("closing an answer-ready receiver settles connected and revokes session state", async () => {
  const connection = new FakePeerConnection();
  const session = await acceptDetachedOffer(await signalingOffer(), {
    receiverOrigin: "https://receiver.example",
    verificationAuthorized: true,
    now: () => 2000,
    candidateFactory,
    peerConnectionFactory: () => connection,
    channelTimeoutMs: 1000,
  });
  const connected = session.connected;

  assert.equal(session.state, "answer-ready");
  session.close();

  await assert.rejects(
    connected,
    (error) => error.code === "invalid_detached_state" ||
      error.code === "detached_channel_closed",
  );
  assert.equal(session.state, "closed");
  assert.equal(session.connected, null);
  assert.equal(session.connection, null);
  assert.equal(session.offer, null);
  assert.equal(session.sealedAnswer, null);
  assert.equal(connection.closed, true);
});

test("does not create WebRTC state before explicit receiver authorization", async () => {
  let created = false;
  await assert.rejects(
    acceptDetachedOffer(await signalingOffer(), {
      receiverOrigin: "https://receiver.example",
      verificationAuthorized: false,
      peerConnectionFactory: () => {
        created = true;
        return new FakePeerConnection();
      },
    }),
    (error) => error.code === "detached_verification_authorization_required",
  );
  assert.equal(created, false);
});

test("runs the complete verified capability, grant, preview, and result flow", async (t) => {
  const { senderConnection, receiverConnection } = rtcPair();
  const common = {
    now: () => 1000,
    candidateFactory,
    channelTimeoutMs: 1000,
  };
  const sender = await createDetachedSenderSession({
    ...common,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverEndpoint: "https://receiver.example/_oab/receive",
    receiverHelper: "https://receiver.example/_oab/helper",
    declarationId: null,
    randomToken: (label) => label === "requestId"
      ? "r".repeat(32)
      : "c".repeat(43),
    expectedReceiverCapabilities: RECEIVER_CAPABILITIES,
    peerConnectionFactory: () => senderConnection,
  });
  const receiver = await acceptDetachedOffer(sender.offer, {
    ...common,
    receiverOrigin: "https://receiver.example",
    verificationAuthorized: true,
    peerConnectionFactory: () => receiverConnection,
  });
  t.after(() => {
    sender.close();
    receiver.close();
  });
  await Promise.all([
    sender.acceptSealedAnswer(receiver.sealedAnswer),
    receiver.connected,
  ]);
  assert.equal(sender.state, "connected");
  assert.equal(receiver.state, "connected");

  let senderAuthorization;
  let manifestAuthorization;
  const receiving = receiver.receiveTransfer({
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: RECEIVER_CAPABILITIES,
    authorizeVerifiedSender(value) {
      senderAuthorization = value;
      return { allowed: true };
    },
    authorizeManifest(manifest) {
      manifestAuthorization = manifest;
      return { allowed: true };
    },
    onPreview() {},
  });
  const prepared = await prepareDetachedTransfer({
    title: "Detached transfer",
    sourceApplication: "Test Sender",
    sourceUrl: "https://sender.example/document",
    representations: { "text/plain": "x".repeat(5000) },
    assets: [],
  }, { transferId: "t".repeat(32) });
  const preparedManifest = prepared.manifest;
  let yields = 0;
  const sent = await sender.sendTransfer(prepared, {
    yieldEveryFrames: 1,
    async yieldControl() { yields += 1; },
  });
  const preview = await receiving.preview;
  assert.equal(sent.status, "previewing");
  assert.equal(preview.representations["text/plain"].length, 5000);
  assert.equal(preview.source.origin, "https://sender.example");
  assert.equal(preview.source.application, "Test Sender");
  assert.equal(preview.source.url, "https://sender.example/document");
  assert.equal(preview.evidence.persisted, false);
  assert.equal(senderAuthorization.originVerified, true);
  assert.deepEqual(manifestAuthorization, preparedManifest);
  assert.ok(yields > 0);

  await receiving.preserve({
    commit: async () => "committed",
    rollback: async () => {},
  });
  assert.equal(await sent.completion, "preserved");
  assert.equal(sender.state, "preserved");
  assert.equal(receiver.state, "preserved");
});
