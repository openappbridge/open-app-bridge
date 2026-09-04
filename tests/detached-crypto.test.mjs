import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  createDetachedKeyPair,
  openDetachedAnswer,
  sealDetachedAnswer,
} from "../src/detached-crypto.js";

test("canonical detached JSON rejects lone Unicode surrogates", () => {
  assert.throws(
    () => canonicalJson({ label: "broken\ud800text" }),
    (error) => error.code === "invalid_transcript",
  );
  assert.throws(
    () => canonicalJson({ ["broken\udc00key"]: true }),
    (error) => error.code === "invalid_transcript",
  );
  assert.equal(canonicalJson({ emoji: "✅" }), '{"emoji":"✅"}');
});

function transcript(overrides = {}) {
  return {
    protocol: "org.openapp.bridge",
    transport: "detached-datachannel/1",
    requestId: "r".repeat(32),
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    offerDigest: "A".repeat(43),
    ...overrides,
  };
}

test("seals an answer to an ephemeral P-256 sender key and transcript", async () => {
  const sender = await createDetachedKeyPair();
  assert.equal(sender.privateKey.extractable, false);
  assert.deepEqual(Object.keys(sender.publicKey).sort(), ["crv", "kty", "x", "y"]);
  assert.equal("d" in sender.publicKey, false);
  const answer = {
    description: { type: "answer", sdp: "opaque-browser-sdp" },
    candidates: [{ candidate: "opaque-browser-candidate" }],
  };
  const sealed = await sealDetachedAnswer(answer, {
    senderPublicKey: sender.publicKey,
    transcript: transcript(),
  });
  assert.equal(sealed.algorithm, "ECDH-P256+HKDF-SHA256+A256GCM");
  assert.notEqual(sealed.receiverPublicKey.x, sender.publicKey.x);
  assert.ok(!sealed.ciphertext.includes("opaque-browser-sdp"));

  const opened = await openDetachedAnswer(sealed, {
    senderPrivateKey: sender.privateKey,
    transcript: transcript(),
  });
  assert.deepEqual(opened, answer);
});

test("fails closed when the ciphertext, sender key, or transcript changes", async () => {
  const sender = await createDetachedKeyPair();
  const otherSender = await createDetachedKeyPair();
  const sealed = await sealDetachedAnswer({ accepted: true }, {
    senderPublicKey: sender.publicKey,
    transcript: transcript(),
  });
  const tampered = {
    ...sealed,
    ciphertext: `${sealed.ciphertext.startsWith("A") ? "B" : "A"}${
      sealed.ciphertext.slice(1)
    }`,
  };

  await assert.rejects(
    openDetachedAnswer(tampered, {
      senderPrivateKey: sender.privateKey,
      transcript: transcript(),
    }),
    (error) => error.code === "detached_answer_authentication_failed",
  );
  await assert.rejects(
    openDetachedAnswer(sealed, {
      senderPrivateKey: otherSender.privateKey,
      transcript: transcript(),
    }),
    (error) => error.code === "detached_answer_authentication_failed",
  );
  await assert.rejects(
    openDetachedAnswer(sealed, {
      senderPrivateKey: sender.privateKey,
      transcript: transcript({ receiverOrigin: "https://evil.example" }),
    }),
    (error) => error.code === "detached_answer_authentication_failed",
  );
});

test("rejects a private or malformed key in public signaling", async () => {
  const sender = await createDetachedKeyPair();
  await assert.rejects(
    sealDetachedAnswer({ accepted: true }, {
      senderPublicKey: { ...sender.publicKey, d: "secret" },
      transcript: transcript(),
    }),
    (error) => error.code === "invalid_detached_key",
  );
});
