import assert from "node:assert/strict";
import test from "node:test";

import {
  DETACHED_MAX_FRAME_BYTES,
  decodeDetachedFrame,
  prepareDetachedTransfer,
} from "../src/detached-framing.js";
import {
  acceptDetachedOffer,
  createDetachedSenderSession,
  receiveDetachedTransfer,
} from "../src/detached-transport.js";
import {
  captureDetachedReceiverHandoff,
  createDetachedOfferLaunchUrl,
} from "../src/index.js";
import {
  DETACHED_RECEIVE_SECURITY_OPTIONS,
  makeReceiver,
  makeWindow,
  trustedClick,
  trustedHandoffClick,
} from "./helpers.mjs";

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

const PUBLIC_KEY = Object.freeze({
  kty: "EC",
  crv: "P-256",
  x: "eqA7LQOcOpEEChnW42P3tHbmqgCuppA8yNU0pAnqRRQ",
  y: "ZrjVaSBX1AAlsg87tX8CYy-gPYASWDI8CyHD9C7a7ic",
});

const CAPABILITIES = Object.freeze({
  representations: Object.freeze(["text/plain"]),
  assetTypes: Object.freeze(["image/png"]),
  maximumTransferBytes: 20_000,
  maximumAssets: 1,
  maximumFrameBytes: DETACHED_MAX_FRAME_BYTES,
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

function offer() {
  return {
    protocol: "org.openapp.bridge",
    wireVersion: "1.0",
    transport: "detached-datachannel/1",
    transportVersion: "1",
    requestId: "request_123456789012345678901234",
    channelId: "c".repeat(43),
    createdAt: 1_000,
    expiresAt: 61_000,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/detached-helper",
    declarationId: "declaration-test-0001",
    senderPublicKey: PUBLIC_KEY,
    description: { type: "offer", sdp: DATA_SDP },
    candidates: [HOST_CANDIDATE],
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class PairedChannel extends EventTarget {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  label = "oab-1";
  peer = null;

  send(value) {
    if (this.readyState !== "open") throw new Error("channel closed");
    const copied = value instanceof Uint8Array ? value.slice() : value;
    queueMicrotask(() => this.peer.dispatchEvent(
      new MessageEvent("message", { data: copied }),
    ));
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function pairedChannels() {
  const sender = new PairedChannel();
  const receiver = new PairedChannel();
  sender.peer = receiver;
  receiver.peer = sender;
  return { sender, receiver };
}

function compatibleCrypto() {
  const provider = globalThis.crypto;
  const subtle = new Proxy(provider.subtle, {
    get(target, property) {
      if (property === "exportKey") {
        return async (format, key) => {
          const exported = await target.exportKey(format, key);
          if (format === "jwk" && exported?.kty === "EC") {
            return {
              kty: exported.kty,
              crv: exported.crv,
              x: exported.x,
              y: exported.y,
            };
          }
          return exported;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    subtle,
    getRandomValues: provider.getRandomValues.bind(provider),
  };
}

function rtcPair() {
  const senderChannel = new PairedChannel();
  const receiverChannel = new PairedChannel();
  senderChannel.readyState = "connecting";
  receiverChannel.readyState = "connecting";
  senderChannel.peer = receiverChannel;
  receiverChannel.peer = senderChannel;
  let receiverConnection;

  class PairedPeerConnection extends EventTarget {
    closed = false;
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
        const candidate = new Event("icecandidate");
        candidate.candidate = { toJSON: () => HOST_CANDIDATE };
        this.dispatchEvent(candidate);
        const complete = new Event("icecandidate");
        complete.candidate = null;
        this.dispatchEvent(complete);
      });
    }
    async setRemoteDescription(value) {
      this.remoteDescription = value;
      if (this.role === "sender" && value.type === "answer") {
        senderChannel.readyState = "open";
        receiverChannel.readyState = "open";
        const incoming = new Event("datachannel");
        incoming.channel = receiverChannel;
        receiverConnection.dispatchEvent(incoming);
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

test("uses one capped RTC setup deadline across a stalled receiver await", async () => {
  let releaseRemoteDescription;
  const stalled = new Promise((resolve) => {
    releaseRemoteDescription = resolve;
  });
  class StalledPeerConnection extends EventTarget {
    closed = false;
    getConfiguration() { return { iceServers: [] }; }
    getTransceivers() { return []; }
    getSenders() { return []; }
    getReceivers() { return []; }
    setRemoteDescription() { return stalled; }
    close() { this.closed = true; }
  }
  const connection = new StalledPeerConnection();
  await assert.rejects(
    acceptDetachedOffer(offer(), {
      receiverOrigin: "https://receiver.example",
      verificationAuthorized: true,
      now: () => 2_000,
      channelTimeoutMs: 100,
      candidateFactory,
      peerConnectionFactory: () => connection,
    }),
    (error) => error.code === "detached_channel_timeout",
  );
  assert.equal(connection.closed, true);
  releaseRemoteDescription();
  await tick();
  assert.equal(connection.closed, true);
});

test("sender and receiver cancel phase timers through terminal Discard", async () => {
  const { senderConnection, receiverConnection } = rtcPair();
  const crypto = compatibleCrypto();
  const common = {
    crypto,
    now: () => 1_000,
    candidateFactory,
    channelTimeoutMs: 1_000,
  };
  const sender = await createDetachedSenderSession({
    ...common,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverEndpoint: "https://receiver.example/_oab/receive",
    receiverHelper: "https://receiver.example/_oab/detached-helper",
    declarationId: null,
    expectedReceiverCapabilities: CAPABILITIES,
    randomToken: (label) => label === "requestId"
      ? "r".repeat(32)
      : "c".repeat(43),
    peerConnectionFactory: () => senderConnection,
  });
  assert.equal(sender.offer.expiresAt - sender.offer.createdAt, 120_000);
  const receiver = await acceptDetachedOffer(sender.offer, {
    ...common,
    receiverOrigin: "https://receiver.example",
    verificationAuthorized: true,
    peerConnectionFactory: () => receiverConnection,
  });
  await Promise.all([
    sender.acceptSealedAnswer(receiver.sealedAnswer),
    receiver.connected,
  ]);
  const receiving = receiver.receiveTransfer({
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "complete flow" },
    assets: [{
      name: "private.png",
      mimeType: "image/png",
      data: new Uint8Array([4, 5, 6]),
    }],
  }, { transferId: "t".repeat(32) });
  const sent = await sender.sendTransfer(prepared, {
    dispositionTimeoutMs: 1_000,
  });
  const preview = await receiving.preview;
  await receiving.complete("discarded");
  assert.equal(await sent.completion, "discarded");
  assert.deepEqual(Array.from(preview.assets[0].data), [0, 0, 0]);
  assert.equal(sender.state, "discarded");
  assert.equal(receiver.state, "discarded");
  assert.equal(senderConnection.closed, true);
  assert.equal(receiverConnection.closed, true);
});

test("sender independently enforces connected-to-preview deadline", async () => {
  const { senderConnection, receiverConnection } = rtcPair();
  const crypto = compatibleCrypto();
  const common = {
    crypto,
    now: () => 1_000,
    candidateFactory,
    channelTimeoutMs: 1_000,
  };
  const sender = await createDetachedSenderSession({
    ...common,
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverEndpoint: "https://receiver.example/_oab/receive",
    receiverHelper: "https://receiver.example/_oab/detached-helper",
    declarationId: null,
    expectedReceiverCapabilities: CAPABILITIES,
    connectedToPreviewTimeoutMs: 100,
    randomToken: (label) => label === "requestId"
      ? "r".repeat(32)
      : "c".repeat(43),
    peerConnectionFactory: () => senderConnection,
  });
  const receiver = await acceptDetachedOffer(sender.offer, {
    ...common,
    receiverOrigin: "https://receiver.example",
    verificationAuthorized: true,
    transferTimeoutMs: 1_000,
    peerConnectionFactory: () => receiverConnection,
  });
  await Promise.all([
    sender.acceptSealedAnswer(receiver.sealedAnswer),
    receiver.connected,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sender.state, "failed");
  assert.equal(senderConnection.closed, true);
  assert.equal(sender.channel, null);
  assert.equal(sender.offer, null);
  assert.equal(sender.transcript, null);
  receiver.close();
});

test("disposition expiry becomes Discard and wipes preview asset bytes", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "preview" },
    assets: [{
      name: "private.png",
      mimeType: "image/png",
      data: new Uint8Array([7, 8, 9]),
    }],
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const controls = [];
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 100,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  const preview = await receiving.preview;
  assert.deepEqual(Array.from(preview.assets[0].data), [7, 8, 9]);

  assert.equal(await receiving.completion, "discarded");
  assert.equal(receiving.state, "discarded");
  assert.deepEqual(Array.from(preview.assets[0].data), [0, 0, 0]);
  assert.equal(receiver.readyState, "closed");
  await tick();
  assert.equal(
    controls.some((frame) =>
      frame.typeName === "result" &&
      frame.control.disposition === "discarded"),
    true,
  );
});

test("Discard awaits and reports byte-reservation release settlement", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "cleanup" },
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  let releaseReservation;
  const reservationSettlement = new Promise((_, reject) => {
    releaseReservation = reject;
  });
  let releaseCalled = false;
  const cleanupFailures = [];
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    reserveIncomingBytes: async () => ({
      reserved: true,
      release() {
        releaseCalled = true;
        return reservationSettlement;
      },
    }),
    onCleanupError: (failure) => cleanupFailures.push(failure),
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  await receiving.preview;

  let completeSettled = false;
  const completing = receiving.complete("discarded").then((value) => {
    completeSettled = true;
    return value;
  });
  await tick();
  assert.equal(releaseCalled, true);
  assert.equal(completeSettled, false);
  const releaseError = new Error("reservation release failed");
  releaseReservation(releaseError);
  assert.equal(await completing, "discarded");
  assert.equal(cleanupFailures.length, 1);
  assert.equal(cleanupFailures[0].operation, "byte-reservation-release");
  assert.equal(cleanupFailures[0].error, releaseError);
});

test("a committed Preserve cannot become Discard while its receipt is backpressured", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "preserved" },
    assets: [{
      name: "preserved.png",
      mimeType: "image/png",
      data: new Uint8Array([7, 8, 9]),
    }],
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const controls = [];
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 100,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  const preview = await receiving.preview;

  receiver.bufferedAmount = 300 * 1024;
  const completion = receiving.preserve({
    commit: async () => "preserved",
    rollback: async () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(receiving.state, "preserved");
  assert.equal(await receiving.completion, "preserved");
  assert.deepEqual(Array.from(preview.assets[0].data), [0, 0, 0]);

  receiver.bufferedAmount = 0;
  receiver.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(await completion, "preserved");
  await tick();
  assert.equal(
    controls.some((frame) =>
      frame.typeName === "result" &&
      frame.control.disposition === "preserved"),
    true,
  );
  assert.equal(
    controls.some((frame) =>
      frame.typeName === "result" &&
      frame.control.disposition === "discarded"),
    false,
  );
});

test("an expiring Preserve aborts its commit, rolls back, and can never report preserved", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "transactional" },
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 100,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview(delivery) {
      assert.equal(Number.isSafeInteger(delivery.dispositionExpiresAt), true);
      assert.equal(delivery.dispositionExpiresAt > Date.now(), true);
    },
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  const preview = await receiving.preview;
  assert.equal(receiving.dispositionExpiresAt, preview.dispositionExpiresAt);
  await assert.rejects(
    receiving.complete("preserved"),
    (error) => error.code === "preserve_transaction_required",
  );

  let stagedDurably = false;
  let rolledBack = false;
  const preserving = receiving.preserve({
    commit({ signal }) {
      stagedDurably = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async rollback({ reason }) {
      assert.equal(reason.code, "detached_disposition_timeout");
      stagedDurably = false;
      rolledBack = true;
    },
  });
  await assert.rejects(
    preserving,
    (error) => error.code === "detached_disposition_timeout",
  );
  assert.equal(await receiving.completion, "discarded");
  assert.equal(receiving.state, "discarded");
  assert.equal(stagedDurably, false);
  assert.equal(rolledBack, true);
});

test("a late-settling commit is rolled back before Discard becomes observable", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "late commit" },
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 100,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  await receiving.preview;

  const order = [];
  receiving.completion.then(() => order.push("completion"));
  const preserving = receiving.preserve({
    // Deliberately violates the signal requirement to verify the SDK's
    // defensive wait-before-rollback ordering.
    commit: () => new Promise((resolve) => setTimeout(resolve, 120)),
    rollback: async () => { order.push("rollback"); },
  });
  await assert.rejects(
    preserving,
    (error) => error.code === "detached_disposition_timeout",
  );
  assert.equal(await receiving.completion, "discarded");
  assert.deepEqual(order, ["rollback", "completion"]);
});

test("a commit that ignores cancellation becomes an explicit indeterminate failure", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "unresponsive commit" },
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 100,
    preserveSettlementTimeoutMs: 100,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  await receiving.preview;

  let rollbackCount = 0;
  const preserving = receiving.preserve({
    commit: () => new Promise(() => {}),
    async rollback(context) {
      rollbackCount += 1;
      assert.equal(context.commitSettlement, "timeout");
      assert.equal(context.reason.code, "preserve_commit_unresponsive");
    },
  });
  await assert.rejects(
    preserving,
    (error) => error.code === "preserve_commit_unresponsive",
  );
  await assert.rejects(
    receiving.completion,
    (error) => error.code === "preserve_commit_unresponsive",
  );
  assert.equal(receiving.state, "failed");
  assert.equal(rollbackCount, 1);
});

test("receiver abort during Preserve waits for commit settlement and rollback", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "abort transaction" },
    assets: [{
      name: "abort.png",
      mimeType: "image/png",
      data: new Uint8Array([4, 5, 6]),
    }],
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  const preview = await receiving.preview;

  const order = [];
  const publicCompletion = receiving.completion.catch((error) => {
    order.push("completion");
    throw error;
  });
  let stagedDurably = false;
  const preserving = receiving.preserve({
    commit({ signal }) {
      stagedDurably = true;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          // A storage adapter may resolve after synchronously cancelling its
          // write. The SDK must still preserve the real abort reason.
          setTimeout(() => resolve("cancelled"), 10);
        }, { once: true });
      });
    },
    async rollback() {
      stagedDurably = false;
      order.push("rollback");
    },
  });
  await tick();
  const aborting = receiving.abort("receiver_cancelled");
  assert.equal(receiving.state, "preserving");
  await assert.rejects(
    preserving,
    (error) => error.code === "detached_receiver_aborted",
  );
  await aborting;
  await assert.rejects(
    publicCompletion,
    (error) => error.code === "detached_receiver_aborted",
  );
  assert.deepEqual(order, ["rollback", "completion"]);
  assert.equal(stagedDurably, false);
  assert.deepEqual(Array.from(preview.assets[0].data), [0, 0, 0]);
  assert.equal(receiving.state, "aborted");
});

test("rollback failure during coordinated abort is explicit and never labelled Discard", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "rollback failure" },
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview() {},
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  await receiving.preview;

  const rollbackFailure = new Error("durable cleanup unavailable");
  const preserving = receiving.preserve({
    commit({ signal }) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("cancelled"), {
          once: true,
        });
      });
    },
    rollback: async () => { throw rollbackFailure; },
  });
  await tick();
  const aborting = receiving.abort("receiver_cancelled");
  await assert.rejects(
    preserving,
    (error) =>
      error.code === "preserve_rollback_failed" &&
      error.cause === rollbackFailure,
  );
  await aborting;
  await assert.rejects(
    receiving.completion,
    (error) => error.code === "preserve_rollback_failed",
  );
  assert.equal(receiving.state, "failed");
});

test("missing low-level onPreview fails closed before previewing", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "preview" },
    assets: [],
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const controls = [];
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
  });
  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "on_preview_required",
  );
  await tick();
  assert.equal(controls.some((frame) => frame.typeName === "previewing"), false);
  assert.equal(controls.some((frame) => frame.typeName === "abort"), true);
  assert.equal(receiver.readyState, "closed");
});

test("late sender authorization cannot resurrect an aborted receive session", async () => {
  const { sender, receiver } = pairedChannels();
  let releaseAuthorization;
  const authorization = new Promise((resolve) => {
    releaseAuthorization = resolve;
  });
  const controls = [];
  let authorizationSignal;
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    authorizeVerifiedSender: (_evidence, { signal }) => {
      authorizationSignal = signal;
      return authorization;
    },
    authorizeManifest: async () => ({ allowed: true }),
  });
  await tick();
  assert.equal(authorizationSignal.aborted, false);
  const aborted = receiving.abort("receiver_closed");
  assert.equal(authorizationSignal.aborted, true);
  releaseAuthorization({ allowed: true });
  await aborted;
  await tick();
  assert.equal(receiving.state, "aborted");
  assert.equal(receiver.readyState, "closed");
  assert.equal(controls.some((frame) => frame.typeName === "capabilities"), false);
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "detached_receiver_aborted",
  );
});

test("terminal abort cancels pending manifest authorization and prevents Grant", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "manifest authorization" },
    assets: [],
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const controls = [];
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  let manifestSignal;
  let releaseAuthorization;
  const authorization = new Promise((resolve) => {
    releaseAuthorization = resolve;
  });
  let authorizationStarted;
  const started = new Promise((resolve) => { authorizationStarted = resolve; });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: (_manifest, _digest, { signal }) => {
      manifestSignal = signal;
      authorizationStarted();
      return authorization;
    },
    onPreview() {},
  });

  await tick();
  sender.send(prepared.manifestFrame);
  await started;
  assert.equal(manifestSignal.aborted, false);
  const aborted = receiving.abort("receiver_closed");
  assert.equal(manifestSignal.aborted, true);
  releaseAuthorization({ allowed: true });
  await aborted;
  await tick();

  assert.equal(receiving.state, "aborted");
  assert.equal(controls.some((frame) => frame.typeName === "grant"), false);
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "detached_receiver_aborted",
  );
});

test("terminal abort cancels pending preview presentation and prevents acknowledgement", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "pending preview" },
    assets: [],
  }, { transferId: "t".repeat(32) });
  const { sender, receiver } = pairedChannels();
  const controls = [];
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  let previewSignal;
  let releasePreview;
  const presentation = new Promise((resolve) => { releasePreview = resolve; });
  let previewStarted;
  const started = new Promise((resolve) => { previewStarted = resolve; });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    dispositionTimeoutMs: 1_000,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview(_delivery, { signal }) {
      previewSignal = signal;
      previewStarted();
      return presentation;
    },
  });

  await tick();
  sender.send(prepared.manifestFrame);
  await tick();
  await tick();
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);
  await started;
  assert.equal(previewSignal.aborted, false);
  const aborted = receiving.abort("receiver_closed");
  assert.equal(previewSignal.aborted, true);
  releasePreview();
  await aborted;
  await tick();

  assert.equal(receiving.state, "aborted");
  assert.equal(controls.some((frame) => frame.typeName === "previewing"), false);
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "detached_receiver_aborted",
  );
});

test("inbound token buckets fail closed before excess frames are parsed", async () => {
  const { sender, receiver } = pairedChannels();
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: CAPABILITIES,
    sourceOrigin: "https://sender.example",
    transferTimeoutMs: 1_000,
    maximumFramesPerSecond: 1,
    maximumBytesPerSecond: 64 * 1024 * 1024,
    rateNow: () => 0,
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
  });
  sender.send(new Uint8Array([0]));
  sender.send(new Uint8Array([0]));
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "detached_receive_rate_exceeded",
  );
  assert.equal(receiver.readyState, "closed");
  assert.equal(receiving.state, "failed");
});

test("receiver facade close during atomic admission remains absorbing", async () => {
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer(),
    { now: () => 1_000, candidateFactory },
  );
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.document = { referrer: "" };
  let admissionStarted;
  const started = new Promise((resolve) => {
    admissionStarted = resolve;
  });
  let resolveAdmission;
  const admission = new Promise((resolve) => {
    resolveAdmission = resolve;
  });
  let helperCreated = false;
  const controller = captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
    windowRef,
    now: () => 2_000,
    candidateFactory,
    admitIncomingHandoff() {
      admissionStarted();
      return admission;
    },
    broadcastChannelFactory() {
      helperCreated = true;
      throw new Error("a closed preparation must not create a helper");
    },
  });
  const preparing = controller.prepare();
  await started;
  controller.close();
  resolveAdmission({
    admitted: true,
    promote() { return true; },
    release() {},
  });
  await assert.rejects(
    preparing,
    (error) => error.code === "invalid_detached_state",
  );
  assert.equal(controller.state, "closed");
  assert.equal(helperCreated, false);
});

test("receiver facade releases a late admission lease after close", async () => {
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer(),
    { now: () => 1_000, candidateFactory },
  );
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.document = { referrer: "" };
  let admissionStarted;
  const started = new Promise((resolve) => { admissionStarted = resolve; });
  let resolveAdmission;
  const admission = new Promise((resolve) => { resolveAdmission = resolve; });
  let released = 0;
  let helperCreated = false;
  const controller = captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
    windowRef,
    now: () => 2_000,
    candidateFactory,
    admitIncomingHandoff() {
      admissionStarted();
      return admission;
    },
    broadcastChannelFactory() {
      helperCreated = true;
      throw new Error("a closed preparation must not create a helper");
    },
  });
  const preparing = controller.prepare();
  await started;
  controller.close();
  resolveAdmission({
    admitted: true,
    promote() { return true; },
    release() { released += 1; },
  });
  await assert.rejects(
    preparing,
    (error) => error.code === "invalid_detached_state",
  );
  assert.equal(controller.state, "closed");
  assert.equal(helperCreated, false);
  assert.equal(released, 1);
});

test("receiver Verify rejects an offer that expired after preparation", async () => {
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer(),
    { now: () => 1_000, candidateFactory },
  );
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.document = { referrer: "" };
  let currentTime = 2_000;
  const localChannel = {
    closeCalled: false,
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    close() { this.closeCalled = true; },
  };
  let leaseReleased = 0;
  const controller = captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
    windowRef,
    now: () => currentTime,
    candidateFactory,
    admitIncomingHandoff: async (request) => {
      assert.equal(request.channelId, "c".repeat(43));
      assert.equal(request.maximumActiveSessions, 4);
      return {
        admitted: true,
        promote() { return true; },
        release() { leaseReleased += 1; },
      };
    },
    broadcastChannelFactory: () => localChannel,
  });
  const prepared = await controller.prepare();
  currentTime = 61_001;
  const event = trustedClick();
  assert.throws(
    () => prepared.verify(event),
    (error) => error.code === "detached_offer_expired",
  );
  assert.equal(event.defaultPrevented, true);
  assert.equal(controller.state, "expired");
  assert.equal(prepared.href, "");
  assert.equal(localChannel.closeCalled, true);
  await Promise.resolve();
  assert.equal(leaseReleased, 1);
});

test("receiver Verify fails terminally before navigation when callbacks are missing", async () => {
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer(),
    { now: () => 1_000, candidateFactory },
  );
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.document = { referrer: "" };
  const localChannel = {
    closed: false,
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    close() { this.closed = true; },
  };
  let released = 0;
  const controller = captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
    windowRef,
    now: () => 2_000,
    candidateFactory,
    admitIncomingHandoff: async () => ({
      admitted: true,
      promote() { return true; },
      release() { released += 1; },
    }),
    broadcastChannelFactory: () => localChannel,
  });
  const prepared = await controller.prepare();
  const event = trustedHandoffClick(prepared);
  assert.throws(
    () => prepared.verify(event),
    (error) => error.code === "authorize_origin_required",
  );
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.currentTarget.href, "");
  assert.equal(controller.state, "failed");
  assert.equal(prepared.href, "");
  assert.equal(localChannel.closed, true);
  await Promise.resolve();
  assert.equal(released, 1);
});

test("receiver Verify preserves its native helper anchor through a full task", async () => {
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer(),
    { now: () => 1_000, candidateFactory },
  );
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.document = { referrer: "" };
  const authorizationFailure = new Error("stop after boundary observation");
  let authorizationCalled = false;
  let authorizationSignal;
  const controller = captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
    windowRef,
    now: () => 2_000,
    candidateFactory,
    admitIncomingHandoff: async () => ({
      admitted: true,
      promote() { return true; },
      release() {},
    }),
    broadcastChannelFactory(name) {
      const [, , , requestId, channelId] = name.split(":");
      return {
        postMessage() {},
        addEventListener(type, listener) {
          if (type === "message") {
            queueMicrotask(() => listener({
              data: { type: "helper-ready", requestId, channelId },
            }));
          }
        },
        removeEventListener() {},
        close() {},
      };
    },
    authorizeOrigin: async (_evidence, { signal }) => {
      authorizationCalled = true;
      authorizationSignal = signal;
      throw authorizationFailure;
    },
    authorizeManifest: async () => ({ allowed: true }),
    reserveIncomingBytes: async () => ({
      admitted: true,
      release() {},
    }),
    onPreview() {},
  });
  const prepared = await controller.prepare();
  const event = trustedHandoffClick(prepared);
  const anchor = event.currentTarget;
  const verification = prepared.verify(event);

  assert.equal(controller.state, "verifying");
  assert.notEqual(anchor.href, "");
  assert.equal(authorizationCalled, false);
  await Promise.resolve();
  assert.notEqual(anchor.href, "");
  assert.equal(authorizationCalled, false);

  await assert.rejects(verification, authorizationFailure);
  assert.equal(anchor.href, "");
  assert.equal(authorizationCalled, true);
  assert.equal(authorizationSignal.aborted, true);
  assert.equal(controller.state, "failed");
});

test("receiver rejects helper-ready deadlines above the 15-second ceiling", async () => {
  const href = await createDetachedOfferLaunchUrl(
    "https://receiver.example/_oab/receive",
    offer(),
    { now: () => 1_000, candidateFactory },
  );
  const parsed = new URL(href);
  const windowRef = makeWindow({
    origin: parsed.origin,
    href: parsed.href,
    hash: parsed.hash,
    pathname: parsed.pathname,
  });
  windowRef.document = { referrer: "" };
  assert.throws(
    () => captureDetachedReceiverHandoff(makeReceiver({ link: false }), {
      windowRef,
      now: () => 2_000,
      helperReadyTimeoutMs: 15_001,
      candidateFactory,
      admitIncomingHandoff: async () => ({
        admitted: false,
        reason: "session-capacity",
      }),
    }),
    /helperReadyTimeoutMs/u,
  );
  assert.equal(windowRef.location.hash, "");
});

test("hard lifecycle ceilings reject oversized configuration", async () => {
  const { receiver } = pairedChannels();
  assert.throws(
    () => receiveDetachedTransfer(receiver, {
      ...DETACHED_RECEIVE_SECURITY_OPTIONS,
      capabilities: CAPABILITIES,
      sourceOrigin: "https://sender.example",
      transferTimeoutMs: 600_001,
    }),
    /transferTimeoutMs/u,
  );
  assert.throws(
    () => receiveDetachedTransfer(receiver, {
      ...DETACHED_RECEIVE_SECURITY_OPTIONS,
      capabilities: CAPABILITIES,
      sourceOrigin: "https://sender.example",
      dispositionTimeoutMs: 3_600_001,
    }),
    /dispositionTimeoutMs/u,
  );
  assert.throws(
    () => receiveDetachedTransfer(receiver, {
      ...DETACHED_RECEIVE_SECURITY_OPTIONS,
      capabilities: CAPABILITIES,
      sourceOrigin: "https://sender.example",
      maximumFramesPerSecond: 4_097,
    }),
    /maximumFramesPerSecond/u,
  );
  assert.throws(
    () => receiveDetachedTransfer(receiver, {
      ...DETACHED_RECEIVE_SECURITY_OPTIONS,
      capabilities: CAPABILITIES,
      sourceOrigin: "https://sender.example",
      maximumBytesPerSecond: 64 * 1024 * 1024 + 1,
    }),
    /maximumBytesPerSecond/u,
  );
  const senderOptions = {
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    expectedReceiverCapabilities: CAPABILITIES,
    randomToken: (label) => label === "requestId"
      ? "r".repeat(32)
      : "c".repeat(43),
  };
  await assert.rejects(
    createDetachedSenderSession({
      ...senderOptions,
      lifetimeMs: 300_001,
    }),
    /lifetimeMs/u,
  );
  await assert.rejects(
    createDetachedSenderSession({
      ...senderOptions,
      channelTimeoutMs: 30_001,
    }),
    /channelTimeoutMs/u,
  );
  await assert.rejects(
    createDetachedSenderSession({
      ...senderOptions,
      connectedToPreviewTimeoutMs: 600_001,
    }),
    /connectedToPreviewTimeoutMs/u,
  );
});
