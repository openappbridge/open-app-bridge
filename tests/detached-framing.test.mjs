import assert from "node:assert/strict";
import test from "node:test";

import {
  DETACHED_FRAME_TYPES,
  DETACHED_MAX_FRAME_BYTES,
  DetachedFrameReceiver,
  decodeDetachedFrame,
  encodeDetachedControl,
  encodeDetachedFrame,
  prepareDetachedTransfer,
  sendDetachedFrame,
  assertManifestMatchesCapabilities,
  validateDetachedCapabilities,
} from "../src/detached-framing.js";
import { receiveDetachedTransfer } from "../src/detached-transport.js";
import { DETACHED_RECEIVE_SECURITY_OPTIONS } from "./helpers.mjs";

function transferContent() {
  return {
    title: "Framed document",
    sourceApplication: "Sender Notes",
    sourceUrl: "https://sender.example/document/1",
    representations: {
      "text/markdown": `# Framed\n\n${"content ".repeat(6000)}`,
      "text/plain": "Framed content",
    },
    assets: [{
      name: "diagram.png",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3, 4, 5]),
    }],
  };
}

test("frames, grants, reassembles, and hashes a multi-item transfer", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  assert.ok(prepared.totalFrames > 3);
  assert.ok(prepared.manifestFrame.byteLength <= DETACHED_MAX_FRAME_BYTES);
  const receiver = new DetachedFrameReceiver({
    expectedManifestDigest: prepared.manifestDigest,
  });
  const manifestEvent = await receiver.accept(prepared.manifestFrame);
  assert.equal(manifestEvent.type, "manifest");
  assert.equal(receiver.state, "awaiting-grant");
  const grant = decodeDetachedFrame(receiver.grant());
  assert.equal(grant.typeName, "grant");

  for await (const frame of prepared.dataFrames()) {
    assert.ok(frame.byteLength <= DETACHED_MAX_FRAME_BYTES);
    await receiver.accept(frame);
  }
  const result = await receiver.accept(prepared.completionFrame);
  assert.equal(result.type, "complete");
  assert.equal(result.representations["text/plain"], "Framed content");
  assert.match(result.representations["text/markdown"], /^# Framed/u);
  assert.deepEqual(Array.from(result.assets[0].data), [1, 2, 3, 4, 5]);
  assert.equal(receiver.state, "complete");
  assert.equal(receiver.manifest, null);
});

test("rejects data before a grant and out-of-order data", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const frames = [];
  for await (const frame of prepared.dataFrames()) frames.push(frame);

  const beforeGrant = new DetachedFrameReceiver();
  await beforeGrant.accept(prepared.manifestFrame);
  await assert.rejects(
    beforeGrant.accept(frames[0]),
    (error) => error.code === "detached_frame_sequence_error",
  );
  assert.equal(beforeGrant.state, "failed");
  assert.equal(beforeGrant.manifest, null);

  const outOfOrder = new DetachedFrameReceiver();
  await outOfOrder.accept(prepared.manifestFrame);
  outOfOrder.grant();
  await assert.rejects(
    outOfOrder.accept(frames[1]),
    (error) => error.code === "detached_frame_sequence_error",
  );
});

test("accepts only exact non-echoing abort reason codes", async () => {
  const receiver = new DetachedFrameReceiver();
  await assert.rejects(
    receiver.accept(encodeDetachedControl("abort", {
      reason: "Rejected because document title was Secret",
    })),
    (error) => error.code === "invalid_detached_abort",
  );

  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const rejecting = new DetachedFrameReceiver();
  await rejecting.accept(prepared.manifestFrame);
  const abort = decodeDetachedFrame(rejecting.reject("Secret title leaked"));
  assert.deepEqual(abort.control, { reason: "user_rejected" });
  assert.equal(rejecting.manifest, null);

  const fresh = new DetachedFrameReceiver();
  await assert.rejects(
    fresh.accept(encodeDetachedControl("abort", {
      reason: "well_formed_but_unregistered",
    })),
    (error) => error.code === "invalid_detached_abort",
  );
});

test("dispose terminalizes a manifest-only receiver and clears metadata", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const receiver = new DetachedFrameReceiver();
  await receiver.accept(prepared.manifestFrame);
  assert.notEqual(receiver.manifest, null);
  receiver.grant();
  receiver.dispose();
  receiver.dispose();
  assert.equal(receiver.state, "failed");
  assert.equal(receiver.manifest, null);
  await assert.rejects(
    receiver.accept(prepared.completionFrame),
    (error) => error.code === "detached_session_terminal",
  );
});

test("disposing a prepared transfer wipes only its owned copy", async () => {
  const callerBytes = new Uint8Array([5, 6, 7, 8]);
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "owned" },
    assets: [{
      name: "owned.png",
      mimeType: "image/png",
      data: callerBytes,
    }],
  }, { transferId: "t".repeat(32) });
  const manifestFrame = prepared.manifestFrame;
  const completionFrame = prepared.completionFrame;
  assert.ok(manifestFrame.some((byte) => byte !== 0));
  assert.ok(completionFrame.some((byte) => byte !== 0));
  assert.equal(prepared.disposed, false);
  prepared.dispose();
  prepared.dispose();
  assert.equal(prepared.disposed, true);
  assert.ok(manifestFrame.every((byte) => byte === 0));
  assert.ok(completionFrame.every((byte) => byte === 0));
  assert.throws(
    () => prepared.manifest,
    (error) => error.code === "detached_transfer_disposed",
  );
  assert.deepEqual(Array.from(callerBytes), [5, 6, 7, 8]);
  await assert.rejects(
    async () => {
      for await (const _frame of prepared.dataFrames()) {
        // The generator must reject before yielding owned content bytes.
      }
    },
    (error) => error.code === "detached_transfer_disposed",
  );
});

test("a preparation failure wipes SDK-owned content copies", async () => {
  const callerBytes = new Uint8Array([91, 92, 93, 94]);
  let digestInput;
  const digestFailure = new Error("digest unavailable");
  const crypto = {
    getRandomValues(value) { return value; },
    subtle: {
      async digest(_algorithm, value) {
        digestInput = value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
        throw digestFailure;
      },
    },
  };

  await assert.rejects(
    prepareDetachedTransfer({
      representations: { "text/plain": callerBytes },
      assets: [],
    }, {
      transferId: "t".repeat(32),
      crypto,
    }),
    digestFailure,
  );
  assert.ok(digestInput.every((byte) => byte === 0));
  assert.deepEqual(Array.from(callerBytes), [91, 92, 93, 94]);
});

test("requires live asset counts to match advertised asset capability", () => {
  const base = {
    representations: ["text/plain"],
    assetTypes: [],
    maximumTransferBytes: 1024,
    maximumAssets: 0,
    maximumFrameBytes: 512,
  };
  assert.doesNotThrow(() => validateDetachedCapabilities(base));
  assert.throws(
    () => validateDetachedCapabilities({ ...base, maximumAssets: 1 }),
    (error) => error.code === "invalid_detached_capabilities",
  );
  assert.throws(
    () => validateDetachedCapabilities({
      ...base,
      assetTypes: ["image/png"],
      maximumAssets: 0,
    }),
    (error) => error.code === "invalid_detached_capabilities",
  );
  assert.throws(
    () => validateDetachedCapabilities({
      ...base,
      maximumTransferBytes: 128,
      maximumFrameBytes: 512,
    }),
    (error) => error.code === "invalid_detached_capabilities",
  );
});

test("rejects noncanonical control-frame sequence headers", () => {
  assert.throws(
    () => encodeDetachedFrame({
      type: DETACHED_FRAME_TYPES.grant,
      sequence: 1,
      totalFrames: 2,
      payload: new TextEncoder().encode("{}"),
    }),
    (error) => error.code === "invalid_detached_frame",
  );

  const frame = encodeDetachedControl("grant", { manifestDigest: "A".repeat(43) });
  const modified = frame.slice();
  new DataView(modified.buffer).setUint32(10, 2);
  assert.throws(
    () => decodeDetachedFrame(modified),
    (error) => error.code === "invalid_detached_frame",
  );
});

test("detects a modified chunk before exposing preview content", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const receiver = new DetachedFrameReceiver();
  await receiver.accept(prepared.manifestFrame);
  receiver.grant();
  let first = true;
  for await (const original of prepared.dataFrames()) {
    let frame = original;
    if (first) {
      first = false;
      frame = original.slice();
      frame[frame.length - 1] ^= 1;
    }
    await receiver.accept(frame);
  }
  await assert.rejects(
    receiver.accept(prepared.completionFrame),
    (error) => error.code === "detached_item_integrity_failed",
  );
  assert.equal(receiver.state, "failed");
});

class FakeChannel extends EventTarget {
  label = "oab-1";
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = "open";
  bufferedAmount = 300000;
  bufferedAmountLowThreshold = 0;
  sent = [];

  send(value) {
    this.sent.push(value);
  }
}

test("requires the RTCDataChannel to accept arraybuffer binary mode", async () => {
  const channel = new FakeChannel();
  Object.defineProperty(channel, "binaryType", {
    configurable: true,
    get() { return "blob"; },
    set() {},
  });
  channel.bufferedAmount = 0;
  const frame = encodeDetachedControl("abort", { reason: "user_rejected" });
  await assert.rejects(
    sendDetachedFrame(channel, frame),
    (error) => error.code === "unsafe_detached_channel",
  );
  assert.equal(channel.sent.length, 0);
});

test("waits for backpressure before sending another bounded frame", async () => {
  const channel = new FakeChannel();
  const frame = encodeDetachedFrame({
    type: DETACHED_FRAME_TYPES.data,
    itemIndex: 0,
    sequence: 0,
    totalFrames: 1,
    payload: new Uint8Array([1]),
  });
  const sending = sendDetachedFrame(channel, frame, { timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(channel.sent.length, 0);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event("bufferedamountlow"));
  await sending;
  assert.equal(channel.sent.length, 1);
});

test("backpressure waits reject caller-controlled unbounded timers", async () => {
  const channel = new FakeChannel();
  channel.bufferedAmount = 0;
  await assert.rejects(
    sendDetachedFrame(
      channel,
      encodeDetachedControl("abort", { reason: "user_rejected" }),
      { timeoutMs: 30001 },
    ),
    TypeError,
  );
});

test("reframes and enforces the receiver's negotiated frame ceiling", async () => {
  const prepared = await prepareDetachedTransfer({
    representations: { "text/plain": "x".repeat(5000) },
    assets: [],
  }, { transferId: "t".repeat(32) });
  const negotiated = await prepared.forMaximumFrameBytes(512);
  assert.equal(negotiated.maximumFrameBytes, 512);
  assert.ok(negotiated.totalFrames > prepared.totalFrames);
  assert.ok(negotiated.manifestFrame.byteLength <= 512);
  assert.ok(negotiated.completionFrame.byteLength <= 512);

  const receiver = new DetachedFrameReceiver({ maximumFrameBytes: 512 });
  await receiver.accept(negotiated.manifestFrame);
  receiver.grant();
  for await (const frame of negotiated.dataFrames()) {
    assert.ok(frame.byteLength <= 512);
    await receiver.accept(frame);
  }
  const result = await receiver.accept(negotiated.completionFrame);
  assert.equal(result.representations["text/plain"].length, 5000);

  let oversized;
  for await (const frame of prepared.dataFrames()) {
    oversized = frame;
    break;
  }
  assert.ok(oversized.byteLength > 512);
  assert.throws(
    () => decodeDetachedFrame(oversized, { maximumFrameBytes: 512 }),
    (error) => error.code === "invalid_detached_frame",
  );
  const channel = new FakeChannel();
  channel.bufferedAmount = 0;
  await assert.rejects(
    sendDetachedFrame(channel, oversized, { maximumFrameBytes: 512 }),
    (error) => error.code === "invalid_detached_frame",
  );
});

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
    const copied = value instanceof Uint8Array ? value.slice() : value;
    queueMicrotask(() => this.peer.dispatchEvent(
      new MessageEvent("message", { data: copied }),
    ));
  }

  close() {
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

test("negotiates live capabilities, previews without persisting, then finalizes", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const { sender, receiver } = pairedChannels();
  const senderControls = [];
  sender.addEventListener("message", (event) => {
    senderControls.push(decodeDetachedFrame(event.data));
  });
  let previewCallback;
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    expectedManifestDigest: prepared.manifestDigest,
    capabilities: {
      representations: ["text/markdown", "text/plain"],
      assetTypes: ["image/png"],
      maximumTransferBytes: 100000,
      maximumAssets: 2,
      maximumFrameBytes: DETACHED_MAX_FRAME_BYTES,
    },
    sourceOrigin: "https://sender.example",
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => ({ allowed: true }),
    onPreview(value) {
      assert.equal(value.evidence.persisted, false);
      previewCallback = value;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(senderControls.shift().typeName, "capabilities");
  assertManifestMatchesCapabilities(
    prepared.manifest,
    receiving.capabilities,
  );

  sender.send(prepared.manifestFrame);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(senderControls.shift().typeName, "grant");
  for await (const frame of prepared.dataFrames()) sender.send(frame);
  sender.send(prepared.completionFrame);

  const preview = await receiving.preview;
  assert.equal(preview, previewCallback);
  assert.equal(preview.source.origin, "https://sender.example");
  assert.equal(preview.source.originVerified, true);
  assert.equal(receiving.state, "previewing");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(senderControls.shift().typeName, "previewing");

  assert.equal(await receiving.complete("discarded"), "discarded");
  assert.equal(await receiving.completion, "discarded");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = senderControls.shift();
  assert.equal(result.typeName, "result");
  assert.equal(result.control.disposition, "discarded");
});

test("rejects a manifest that exceeds live receiver capabilities", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  assert.throws(
    () => assertManifestMatchesCapabilities(prepared.manifest, {
      representations: ["text/plain"],
      assetTypes: [],
      maximumTransferBytes: 100000,
      maximumAssets: 0,
      maximumFrameBytes: DETACHED_MAX_FRAME_BYTES,
    }),
    (error) => error.code === "detached_capability_mismatch",
  );
});

test("receiver rejects a malicious sender manifest before authorization or grant", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const { sender, receiver } = pairedChannels();
  let authorized = false;
  const controls = [];
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: {
      representations: ["text/plain"],
      assetTypes: [],
      maximumTransferBytes: 100000,
      maximumAssets: 0,
      maximumFrameBytes: DETACHED_MAX_FRAME_BYTES,
    },
    sourceOrigin: "https://sender.example",
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => {
      authorized = true;
      return { allowed: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controls.shift().typeName, "capabilities");
  sender.send(prepared.manifestFrame);
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "detached_capability_mismatch",
  );
  assert.equal(authorized, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controls.shift().typeName, "abort");
});

test("aggregate byte reservation fails before manifest authorization or grant", async () => {
  const prepared = await prepareDetachedTransfer(transferContent(), {
    transferId: "t".repeat(32),
  });
  const { sender, receiver } = pairedChannels();
  const controls = [];
  let manifestAuthorized = false;
  let reservationRequest;
  sender.addEventListener("message", (event) => {
    controls.push(decodeDetachedFrame(event.data));
  });
  const receiving = receiveDetachedTransfer(receiver, {
    ...DETACHED_RECEIVE_SECURITY_OPTIONS,
    capabilities: {
      representations: ["text/markdown", "text/plain"],
      assetTypes: ["image/png"],
      maximumTransferBytes: 100000,
      maximumAssets: 1,
      maximumFrameBytes: DETACHED_MAX_FRAME_BYTES,
    },
    sourceOrigin: "https://sender.example",
    reserveIncomingBytes(request) {
      reservationRequest = request;
      return { reserved: false };
    },
    authorizeVerifiedSender: async () => ({ allowed: true }),
    authorizeManifest: async () => {
      manifestAuthorized = true;
      return { allowed: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controls.shift();
  sender.send(prepared.manifestFrame);
  await assert.rejects(
    receiving.preview,
    (error) => error.code === "aggregate_byte_capacity_exceeded",
  );
  assert.equal(reservationRequest.totalBytes, prepared.manifest.totalBytes);
  assert.equal(
    reservationRequest.maximumAggregateTransferBytes,
    32 * 1024 * 1024,
  );
  assert.equal(manifestAuthorized, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controls.shift().control.reason, "resource_limit");
});

test("rejects control and bidirectional spoofing in display metadata", async () => {
  await assert.rejects(
    prepareDetachedTransfer({
      title: "Quarterly report\u202Egpj.exe",
      representations: { "text/plain": "safe content" },
      assets: [],
    }, { transferId: "t".repeat(32) }),
    (error) => error.code === "invalid_display_text",
  );
  await assert.rejects(
    prepareDetachedTransfer({
      sourceApplication: "Notes\u0000Fake",
      representations: { "text/plain": "safe content" },
      assets: [],
    }, { transferId: "t".repeat(32) }),
    (error) => error.code === "invalid_display_text",
  );
});

test("rejects a non-canonical transfer identifier", async () => {
  await assert.rejects(
    prepareDetachedTransfer({
      representations: { "text/plain": "content" },
      assets: [],
    }, { transferId: "a".repeat(25) }),
    (error) => error.code === "invalid_detached_transfer_id",
  );
});

test("bounds sender content before reading oversized blobs or unbounded maps", async () => {
  await assert.rejects(
    prepareDetachedTransfer({
      representations: {},
      assets: [{
        name: "large.bin",
        mimeType: "application/octet-stream",
        data: new Blob([new Uint8Array(11)]),
      }],
    }, {
      transferId: "t".repeat(32),
      maximumTransferBytes: 10,
    }),
    (error) => error.code === "detached_transfer_too_large",
  );
  await assert.rejects(
    prepareDetachedTransfer({
      representations: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
          `text/x-test-${index}`,
          "content",
        ]),
      ),
      assets: [],
    }, { transferId: "t".repeat(32) }),
    (error) => error.code === "invalid_detached_content",
  );
});
