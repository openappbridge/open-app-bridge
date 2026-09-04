import assert from "node:assert/strict";
import test from "node:test";

import {
  OAB_TRANSPORTS,
  consumeIncomingHandoff,
  createHandoff,
  createLinkAnchorHandoff,
} from "../src/index.js";
import {
  admitSession,
  makeReceiver,
  makeWindow,
  memoryReplayGuard,
  trustedHandoffClick,
} from "./helpers.mjs";

test("link handoff opens without an opener and reaches transient preview only", async () => {
  const declaration = makeReceiver({ detached: false });
  const senderWindow = makeWindow();
  const handoff = await createLinkAnchorHandoff(
    declaration,
    {
      title: "Portable note",
      markdown: "# Portable note\n\nEditable text.",
      text: "Portable note\n\nEditable text.",
      sourceApplication: "Example sender",
      sourceUrl: "https://sender.example/document?secret=removed#section",
    },
    {
      windowRef: senderWindow,
      contentClassification: "non-confidential",
      now: () => 1000,
    },
  );

  assert.equal(handoff.transport, OAB_TRANSPORTS.linkEnvelope);
  assert.equal(handoff.target, "_blank");
  assert.equal(handoff.rel, "noopener noreferrer");
  assert.equal(handoff.referrerPolicy, "no-referrer");
  assert.equal(handoff.result, undefined);
  const launch = new URL(handoff.href);
  assert.equal(
    (await handoff.activate(trustedHandoffClick(handoff))).receiptAvailable,
    false,
  );
  assert.equal(handoff.href, "");

  const receiverWindow = makeWindow({
    origin: declaration.origin,
    href: launch.href,
    pathname: launch.pathname,
    hash: launch.hash,
  });
  const replay = memoryReplayGuard();
  let authorization;
  let preview;
  const delivery = await consumeIncomingHandoff(declaration, {
    windowRef: receiverWindow,
    now: () => 1001,
    batchRandomToken: () => "A".repeat(22),
    admitIncomingHandoff: ({ requestId }) =>
      replay.claim(requestId)
        ? admitSession()
        : { admitted: false, reason: "replay" },
    authorizeSender(value) {
      authorization = value;
      return { allowed: true };
    },
    deliver(value) {
      preview = value;
    },
  });

  assert.equal(receiverWindow.location.hash, "");
  assert.equal(authorization.evidence.originVerified, false);
  assert.equal(delivery, preview);
  assert.equal(delivery.representations["text/markdown"], "# Portable note\n\nEditable text.");
  assert.equal(delivery.source.url, "https://sender.example/document");
  assert.equal(delivery.evidence.receiverAuthorized, true);
  assert.equal(Object.hasOwn(delivery, "completion"), false);
});

test("an explicitly selected profile never falls back", async () => {
  const declaration = makeReceiver({ detached: false });
  await assert.rejects(
    createHandoff(declaration, { markdown: "private" }, {
      transport: OAB_TRANSPORTS.detachedDataChannel,
      windowRef: makeWindow(),
    }),
    (error) => error.code === "unsupported_transport",
  );
});
