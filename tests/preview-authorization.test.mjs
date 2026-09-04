import assert from "node:assert/strict";
import test from "node:test";

import {
  PREVIEW_AUTHORIZATION_INTENT,
  createPreviewAuthorizationGrant,
} from "../src/preview-authorization.js";

function binding(overrides = {}) {
  return {
    requestId: "preview_request_000000000000000",
    senderOrigin: "https://sender.example",
    receiverOrigin: "https://receiver.example",
    receiverId: "receiver-release-1",
    transport: "detached-datachannel/1",
    intent: PREVIEW_AUTHORIZATION_INTENT,
    capabilityCeilings: {
      representations: ["text/markdown", "text/plain"],
      assetTypes: ["image/png"],
      maximumTransferBytes: 1024,
      maximumAssets: 1,
      maximumFrameBytes: 512,
    },
    expiresAt: 10_000,
    sessionGeneration: 4,
    ...overrides,
  };
}

test("preview authorization is bound, frozen, opaque, and single-use", () => {
  const expected = binding();
  const grant = createPreviewAuthorizationGrant(expected);
  assert.deepEqual(Object.keys(grant).sort(), ["consume", "revoke"]);

  const evidence = grant.consume(binding(), 9_999);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.capabilityCeilings), true);
  assert.equal(Object.isFrozen(evidence.capabilityCeilings.representations), true);
  assert.equal("sessionGeneration" in evidence, false);
  assert.equal(evidence.requestId, expected.requestId);
  assert.equal(evidence.intent, "preview");

  assert.throws(
    () => grant.consume(binding(), 9_999),
    (error) => error.code === "preview_authorization_consumed",
  );
});

test("preview authorization fails closed on every scope mismatch", () => {
  const cases = [
    { requestId: "another_request_000000000000000" },
    { senderOrigin: "https://other-sender.example" },
    { receiverOrigin: "https://other-receiver.example" },
    { receiverId: "receiver-release-2" },
    { expiresAt: 10_001 },
    { sessionGeneration: 5 },
    {
      capabilityCeilings: {
        ...binding().capabilityCeilings,
        maximumTransferBytes: 2048,
      },
    },
  ];
  for (const changed of cases) {
    const grant = createPreviewAuthorizationGrant(binding());
    assert.throws(
      () => grant.consume(binding(changed), 9_999),
      (error) => error.code === "preview_authorization_mismatch",
    );
    assert.throws(
      () => grant.consume(binding(), 9_999),
      (error) => error.code === "preview_authorization_revoked",
    );
  }
});

test("preview authorization has an enforced absolute expiry and revocation", () => {
  const expired = createPreviewAuthorizationGrant(binding());
  assert.throws(
    () => expired.consume(binding(), 10_000),
    (error) => error.code === "preview_authorization_expired",
  );

  const revoked = createPreviewAuthorizationGrant(binding());
  revoked.revoke();
  assert.throws(
    () => revoked.consume(binding(), 9_000),
    (error) => error.code === "preview_authorization_revoked",
  );
});
