import assert from "node:assert/strict";
import test from "node:test";

import { prepareContent } from "../src/content.js";
import { OAB_TRANSPORTS } from "../src/constants.js";
import { makeReceiver } from "./helpers.mjs";
import {
  consumeLinkEnvelope,
  createLinkEnvelopeHandoff,
  decodeLinkEnvelopeFragment,
} from "../src/link-envelope.js";

const REQUEST_ID = "link_sender_request_0001";
const BATCH_ID = "A".repeat(24);
const admitSession = () => ({ admitted: true, promote() { return true; }, release() {} });

function declaration() {
  return makeReceiver({
    detached: false,
    declarationId: "declaration-link-0001",
  });
}

function senderOptions(overrides = {}) {
  return {
    now: () => 1000,
    lifetimeMs: 60000,
    contentClassification: "non-confidential",
    randomToken: () => REQUEST_ID,
    ...overrides,
  };
}

async function decode(handoff, overrides = {}) {
  const url = new URL(handoff.href);
  return decodeLinkEnvelopeFragment(url.hash, {
    launchUrl: url.href,
    expectedEndpoint: "https://receiver.example/_oab/receive",
    now: () => 2000,
    declarationId: "declaration-link-0001",
    ...overrides,
  });
}

function windowFor(href) {
  const url = new URL(href);
  const windowRef = {
    isSecureContext: true,
    opener: null,
    location: {
      href: url.href,
      hash: url.hash,
      pathname: url.pathname,
      search: url.search,
    },
    history: {
      state: { retained: true },
      replaceState(_state, _title, replacement) {
        const next = new URL(replacement, windowRef.location.href);
        windowRef.location.href = next.href;
        windowRef.location.hash = next.hash;
        windowRef.location.pathname = next.pathname;
        windowRef.location.search = next.search;
      },
    },
  };
  windowRef.top = windowRef;
  return windowRef;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function rewritePayload(href, transform) {
  const url = new URL(href);
  const parameters = new URLSearchParams(url.hash.slice(1));
  const bytes = base64UrlToBytes(parameters.get("payload"));
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  transform(envelope);
  const rewritten = new TextEncoder().encode(JSON.stringify(envelope));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rewritten));
  url.hash = `oab-link=1&payload=${bytesToBase64Url(rewritten)}` +
    `&digest=${bytesToBase64Url(digest)}`;
  return url;
}

test("creates a canonical, explicitly non-confidential, text-only handoff", async () => {
  const content = prepareContent({
    title: "Portable note",
    markdown: "# Portable note\n\nNo payload server.",
    text: "Portable note\n\nNo payload server.",
    sourceApplication: "Web Notes",
    sourceUrl: "https://sender.example/note/1",
  });
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    content,
    senderOptions(),
  );
  const url = new URL(handoff.href);

  assert.equal(handoff.transport, "link-envelope/1");
  assert.equal(handoff.classification, "non-confidential");
  assert.equal(handoff.rel, "noopener noreferrer");
  assert.equal(handoff.referrerPolicy, "no-referrer");
  assert.match(url.hash, /^#oab-link=1&payload=[A-Za-z0-9_-]+&digest=[A-Za-z0-9_-]{43}$/u);
  assert.ok(handoff.decodedBytes <= handoff.fragmentBytes);
  assert.ok(handoff.fragmentBytes <= handoff.urlBytes);
  assert.equal(handoff.requestId, REQUEST_ID);

  const offer = await decode(handoff);
  assert.equal(offer.representations["text/markdown"], content.representations["text/markdown"]);
  assert.equal(offer.source.origin, null);
  assert.equal(offer.source.application, "Web Notes");
  assert.deepEqual(offer.evidence, {
    transport: "link-envelope/1",
    originVerified: false,
    appAttested: false,
    userActivationObserved: false,
    declarationIdMatched: true,
  });
});

test("never activates implicitly and rejects HTML or assets", async () => {
  await assert.rejects(
    createLinkEnvelopeHandoff(
      declaration(),
      prepareContent({ markdown: "# Needs an explicit choice" }),
      { randomToken: () => REQUEST_ID },
    ),
    (error) => error.code === "link_envelope_exposure_not_accepted",
  );
  await assert.rejects(
    createLinkEnvelopeHandoff(
      declaration(),
      prepareContent({ markdown: "# Public", html: "<h1>Public</h1>" }),
      senderOptions(),
    ),
    (error) => error.code === "link_envelope_html_unsupported",
  );
  await assert.rejects(
    createLinkEnvelopeHandoff(
      declaration(),
      prepareContent({
        markdown: "![asset](image.png)",
        assets: [{
          name: "image.png",
          mimeType: "image/png",
          data: new Blob(["image"], { type: "image/png" }),
        }],
      }),
      senderOptions(),
    ),
    (error) => error.code === "link_envelope_assets_unsupported",
  );
});

test("canonical link JSON rejects non-Unicode-scalar content", () => {
  assert.throws(
    () => prepareContent({ markdown: "broken\ud800text" }),
    (error) => error.code === "invalid_text_representation",
  );
});

test("enforces decoded, fragment, and complete URL limits independently", async () => {
  await assert.rejects(
    createLinkEnvelopeHandoff(
      declaration(),
      prepareContent({ markdown: "x".repeat(8000) }),
      senderOptions(),
    ),
    (error) => error.code === "link_envelope_decoded_too_large",
  );
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# bounded" }),
    senderOptions(),
  );
  await assert.rejects(
    decode(handoff, { maximumFragmentBytes: 64, maximumDecodedBytes: 32 }),
    (error) => error.code === "link_envelope_fragment_too_large",
  );
  await assert.rejects(
    decode(handoff, {
      maximumUrlBytes: handoff.urlBytes - 1,
      maximumFragmentBytes: Math.min(handoff.fragmentBytes, handoff.urlBytes - 1),
      maximumDecodedBytes: Math.min(handoff.decodedBytes, handoff.fragmentBytes),
    }),
    (error) => error.code === "link_envelope_url_too_large",
  );
});

test("rejects parameter ambiguity, percent aliases, tampering, and non-canonical JSON", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# canonical" }),
    senderOptions(),
  );
  const url = new URL(handoff.href);
  const duplicate = `${url.hash}&payload=again`;
  await assert.rejects(
    decodeLinkEnvelopeFragment(duplicate, {
      launchUrl: `${url.origin}${url.pathname}${duplicate}`,
    }),
    (error) => error.code === "invalid_link_envelope",
  );
  const escaped = url.hash.replace("payload=", "payload=%");
  await assert.rejects(
    decodeLinkEnvelopeFragment(escaped, {
      launchUrl: `${url.origin}${url.pathname}${escaped}`,
    }),
    (error) => error.code === "invalid_link_envelope",
  );
  const tampered = new URLSearchParams(url.hash.slice(1));
  const digestValue = tampered.get("digest");
  tampered.set(
    "digest",
    `${digestValue.slice(0, -1)}${digestValue.endsWith("A") ? "B" : "A"}`,
  );
  const tamperedFragment = `#${tampered}`;
  await assert.rejects(
    decodeLinkEnvelopeFragment(tamperedFragment, {
      launchUrl: `${url.origin}${url.pathname}${tamperedFragment}`,
      now: () => 2000,
    }),
    (error) => error.code === "link_envelope_integrity_failed",
  );

  const parameters = new URLSearchParams(url.hash.slice(1));
  const payloadBytes = base64UrlToBytes(parameters.get("payload"));
  const paddedJson = ` ${new TextDecoder().decode(payloadBytes)}`;
  const paddedBytes = new TextEncoder().encode(paddedJson);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", paddedBytes));
  const nonCanonical = `#oab-link=1&payload=${bytesToBase64Url(paddedBytes)}` +
    `&digest=${bytesToBase64Url(digest)}`;
  await assert.rejects(
    decodeLinkEnvelopeFragment(nonCanonical, {
      launchUrl: `${url.origin}${url.pathname}${nonCanonical}`,
      now: () => 2000,
    }),
    (error) => error.code === "invalid_link_envelope",
  );
});

test("rejects unsafe UI metadata on both encode and decode", async () => {
  assert.throws(
    () => prepareContent({ title: "Safe\n\u202Etitle", markdown: "# body" }),
    (error) => error.code === "invalid_display_text",
  );
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({
      title: "Safe title",
      markdown: "# body",
      sourceApplication: "App name",
    }),
    senderOptions(),
  );
  const offer = await decode(handoff);
  assert.equal(offer.title, "Safe title");
  assert.equal(offer.source.application, "App name");

  const malicious = await rewritePayload(handoff.href, (envelope) => {
    envelope.title = "Trusted\u202Eexe";
  });
  await assert.rejects(
    decodeLinkEnvelopeFragment(malicious.hash, {
      launchUrl: malicious.href,
      expectedEndpoint: "https://receiver.example/_oab/receive",
      now: () => 2000,
    }),
    (error) => error.code === "invalid_link_envelope",
  );
});

test("requires at least 128-bit-shaped request IDs and a short lifetime", async () => {
  await assert.rejects(
    createLinkEnvelopeHandoff(
      declaration(),
      prepareContent({ markdown: "# ID" }),
      senderOptions({ randomToken: () => "too_short" }),
    ),
    (error) => error.code === "invalid_request_id",
  );
  await assert.rejects(
    createLinkEnvelopeHandoff(
      declaration(),
      prepareContent({ markdown: "# TTL" }),
      senderOptions({ lifetimeMs: 300001 }),
    ),
    TypeError,
  );
  const expired = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# Expired" }),
    senderOptions({ lifetimeMs: 1000 }),
  );
  await assert.rejects(
    decode(expired, { now: () => 2000 }),
    (error) => error.code === "link_envelope_expired",
  );
});

test("distinguishes a future link envelope from an expired one", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# From the future" }),
    senderOptions({ now: () => 100_000 }),
  );
  await assert.rejects(
    decode(handoff, { now: () => 0 }),
    (error) => error.code === "link_envelope_from_future",
  );
});

test("scrubs synchronously, admits atomically, asks consent, promotes, then delivers", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# Preview only" }),
    senderOptions(),
  );
  const windowRef = windowFor(handoff.href);
  let scrubbed = false;
  let admitted = false;
  let promoted = false;
  let leaseReleased = 0;
  let delivered;
  const replaceState = windowRef.history.replaceState.bind(windowRef.history);
  windowRef.history.replaceState = (state, _title, replacement) => {
    assert.deepEqual(state, { retained: true });
    assert.equal(replacement, "/_oab/receive");
    replaceState(state, _title, replacement);
    scrubbed = true;
  };

  const delivery = await consumeLinkEnvelope({
    windowRef,
    expectedEndpoint: "https://receiver.example/_oab/receive",
    declarationId: "declaration-link-0001",
    now: () => 2000,
    batchRandomToken: () => BATCH_ID,
    async admitIncomingHandoff(request) {
      assert.equal(scrubbed, true);
      assert.equal(request.requestId, REQUEST_ID);
      assert.equal(request.channelId, null);
      assert.equal(request.transport, OAB_TRANSPORTS.linkEnvelope);
      assert.equal(request.maximumActiveSessions, 4);
      assert.equal(request.maximumReplayClaims, 512);
      assert.equal(request.replayExpiresAt, 61000);
      assert.equal(request.pendingExpiresAt, 61000);
      admitted = true;
      return {
        admitted: true,
        promote({ expiresAt }) {
          assert.equal(expiresAt, 61000);
          promoted = true;
          return true;
        },
        release() { leaseReleased += 1; },
      };
    },
    async authorizeSender(request) {
      assert.equal(scrubbed, true);
      assert.equal(admitted, true);
      assert.equal(promoted, false);
      assert.equal(request.evidence.originVerified, false);
      return { allowed: true };
    },
    async deliver(value) {
      assert.equal(scrubbed, true);
      delivered = value;
    },
  });
  assert.equal(delivery, delivered);
  assert.equal(delivery.batchId, `oab_${BATCH_ID}`);
  assert.equal(delivery.evidence.receiverAuthorized, true);
  assert.equal(delivery.representations["text/markdown"], "# Preview only");
  assert.equal(promoted, true);
  assert.equal(leaseReleased, 1);
});

test("promotion timeout fails closed and repeats idempotent release after late settlement", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# late promotion" }),
    senderOptions(),
  );
  let resolvePromotion;
  const promotion = new Promise((resolve) => { resolvePromotion = resolve; });
  let releaseCalls = 0;
  await assert.rejects(
    consumeLinkEnvelope({
      windowRef: windowFor(handoff.href),
      expectedEndpoint: "https://receiver.example/_oab/receive",
      declarationId: "declaration-link-0001",
      now: () => 2000,
      sessionPromotionTimeoutMs: 100,
      admitIncomingHandoff: async () => ({
        admitted: true,
        promote: () => promotion,
        release() { releaseCalls += 1; },
      }),
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => assert.fail("delivery must wait for promotion"),
    }),
    (error) => error.code === "session_promotion_timeout",
  );
  assert.equal(releaseCalls, 1);
  resolvePromotion(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseCalls, 2);
});

test("fails closed before consent when origin-wide session capacity is exhausted", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# Capacity" }),
    senderOptions(),
  );
  let authorized = false;
  await assert.rejects(
    consumeLinkEnvelope({
      windowRef: windowFor(handoff.href),
      expectedEndpoint: "https://receiver.example/_oab/receive",
      declarationId: "declaration-link-0001",
      now: () => 2000,
      admitIncomingHandoff: async () => ({
        admitted: false,
        reason: "session-capacity",
      }),
      authorizeSender: async () => {
        authorized = true;
        return { allowed: true };
      },
      deliver: async () => {},
    }),
    (error) => error.code === "session_capacity_exceeded",
  );
  assert.equal(authorized, false);
});

test("requires an exact admission lease and releases malformed leases", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# exact lease" }),
    senderOptions(),
  );
  let released = 0;
  await assert.rejects(
    consumeLinkEnvelope({
      windowRef: windowFor(handoff.href),
      expectedEndpoint: "https://receiver.example/_oab/receive",
      declarationId: "declaration-link-0001",
      now: () => 2000,
      admitIncomingHandoff: async () => ({
        admitted: true,
        promote() { return true; },
        release() { released += 1; },
        unexpected: true,
      }),
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => {},
    }),
    (error) => error.code === "invalid_handoff_admission",
  );
  assert.equal(released, 1);
});

test("releases an admission lease that arrives after its deadline", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# late lease" }),
    senderOptions(),
  );
  let resolveAdmission;
  const admission = new Promise((resolve) => { resolveAdmission = resolve; });
  let released = 0;
  await assert.rejects(
    consumeLinkEnvelope({
      windowRef: windowFor(handoff.href),
      expectedEndpoint: "https://receiver.example/_oab/receive",
      declarationId: "declaration-link-0001",
      now: () => 2000,
      admitIncomingHandoff: () => admission,
      handoffAdmissionTimeoutMs: 100,
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => {},
    }),
    (error) => error.code === "handoff_admission_timeout",
  );
  resolveAdmission({
    admitted: true,
    promote() { return true; },
    release() { released += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
});

test("fails closed for frames, opener relationships, missing admission, and replays", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# guarded" }),
    senderOptions(),
  );
  const baseOptions = {
    expectedEndpoint: "https://receiver.example/_oab/receive",
    declarationId: "declaration-link-0001",
    now: () => 2000,
    authorizeSender: async () => ({ allowed: true }),
    deliver: async () => {},
  };

  const framed = windowFor(handoff.href);
  framed.top = {};
  let frameScrubbed = false;
  const replaceFramed = framed.history.replaceState.bind(framed.history);
  framed.history.replaceState = (...args) => {
    replaceFramed(...args);
    frameScrubbed = true;
  };
  await assert.rejects(
    consumeLinkEnvelope({ ...baseOptions, windowRef: framed }),
    (error) => error.code === "framed_receiver_forbidden",
  );
  assert.equal(frameScrubbed, true);

  const opened = windowFor(handoff.href);
  opened.opener = {};
  let openerScrubbed = false;
  const replaceOpened = opened.history.replaceState.bind(opened.history);
  opened.history.replaceState = (...args) => {
    replaceOpened(...args);
    openerScrubbed = true;
  };
  await assert.rejects(
    consumeLinkEnvelope({ ...baseOptions, windowRef: opened }),
    (error) => error.code === "unsafe_window_relationship",
  );

  await assert.rejects(
    consumeLinkEnvelope({ ...baseOptions, windowRef: windowFor(handoff.href) }),
    (error) => error.code === "handoff_admission_required",
  );
  let authorized = false;
  await assert.rejects(
    consumeLinkEnvelope({
      ...baseOptions,
      windowRef: windowFor(handoff.href),
      admitIncomingHandoff: async () => ({ admitted: false, reason: "replay" }),
      authorizeSender: async () => {
        authorized = true;
        return { allowed: true };
      },
    }),
    (error) => error.code === "link_envelope_replayed",
  );
  assert.equal(authorized, false);

  await assert.rejects(
    consumeLinkEnvelope({
      ...baseOptions,
      windowRef: windowFor(handoff.href),
      admitIncomingHandoff: async () => ({
        admitted: false,
        reason: "replay-capacity",
      }),
    }),
    (error) => error.code === "replay_store_capacity_exceeded",
  );
});

test("scrubs even a malformed marked fragment before rejecting it", async () => {
  const href = "https://receiver.example/_oab/receive#oab-link=%ZZ";
  const windowRef = windowFor(href);
  let scrubbed = false;
  const replaceState = windowRef.history.replaceState.bind(windowRef.history);
  windowRef.history.replaceState = (...args) => {
    replaceState(...args);
    scrubbed = true;
  };
  await assert.rejects(
    consumeLinkEnvelope({
      windowRef,
      expectedEndpoint: "https://receiver.example/_oab/receive",
      declarationId: "declaration-link-0001",
      admitIncomingHandoff: admitSession,
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => {},
    }),
    (error) => error.code === "invalid_link_envelope",
  );
  assert.equal(scrubbed, true);
});

test("never permits a receiver to relax the 30-second clock-skew ceiling", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# bounded clock" }),
    senderOptions(),
  );
  await assert.rejects(
    decodeLinkEnvelopeFragment(new URL(handoff.href).hash, {
      launchUrl: handoff.href,
      declarationId: "declaration-link-0001",
      maximumClockSkewMs: 30001,
      now: () => 2000,
    }),
    /maximumClockSkewMs/u,
  );
});

test("requires an explicit current declaration binding before consuming", async () => {
  const handoff = await createLinkEnvelopeHandoff(
    declaration(),
    prepareContent({ markdown: "# declaration-bound" }),
    senderOptions(),
  );
  const windowRef = windowFor(handoff.href);
  let scrubbed = false;
  const replaceState = windowRef.history.replaceState.bind(windowRef.history);
  windowRef.history.replaceState = (...args) => {
    replaceState(...args);
    scrubbed = true;
  };
  await assert.rejects(
    consumeLinkEnvelope({
      windowRef,
      expectedEndpoint: "https://receiver.example/_oab/receive",
      admitIncomingHandoff: admitSession,
      authorizeSender: async () => ({ allowed: true }),
      deliver: async () => {},
    }),
    /declarationId is required/u,
  );
  assert.equal(scrubbed, true);
});
