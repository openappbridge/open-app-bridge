import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureDetachedOfferFromWindow,
  createDetachedAnswerCallbackUrl,
  createDetachedReceiverHelperSession,
  inspectCapturedDetachedOffer,
  runDetachedReceiverHelper,
  runDetachedSenderCallback,
  waitForDetachedAnswer,
} from "../src/detached-callback.js";

function broadcastNetwork() {
  const groups = new Map();
  return (name) => {
    const listeners = new Set();
    const channel = {
      postMessage(data) {
        for (const peer of groups.get(name) ?? []) {
          if (peer === channel) continue;
          queueMicrotask(() => {
            for (const listener of peer.listeners) listener({ data });
          });
        }
      },
      addEventListener(type, listener) {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "message") listeners.delete(listener);
      },
      close() {
        groups.get(name)?.delete(channel);
      },
      listeners,
    };
    if (!groups.has(name)) groups.set(name, new Set());
    groups.get(name).add(channel);
    return channel;
  };
}

function detachedWindow(urlValue, referrer = "") {
  const url = new URL(urlValue);
  const events = new EventTarget();
  const windowRef = {
    isSecureContext: true,
    opener: null,
    location: {
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replacedWith: null,
      replace(value) {
        this.replacedWith = value;
      },
    },
    history: {
      state: null,
      replaceState(_state, _title, replacement) {
        windowRef.location.hash = "";
        windowRef.location.search = "";
        windowRef.location.replacedWith = replacement;
      },
    },
    document: { referrer },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  windowRef.parent = windowRef;
  return windowRef;
}

const requestId = "request_123456789012345678901234";
const channelId = "c".repeat(43);

test("reference callback is content-free and has no deceptive interaction surface", () => {
  const callback = readFileSync(
    new URL("../examples/sender/callback.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    callback,
    /<(?:form|input|textarea|select|button|iframe)\b|contenteditable\s*=|type\s*=\s*["']password["']/iu,
  );
  assert.doesNotMatch(callback, /https?:\/\//iu);
  assert.match(callback, /contains no shared content/iu);
  assert.match(callback, /should close automatically/iu);
});

test("uses a noopener same-origin helper to navigate itself to the fixed callback", async () => {
  const factory = broadcastNetwork();
  const main = createDetachedReceiverHelperSession({
    protocol: "org.openapp.bridge",
    transport: "detached-datachannel/1",
    helperRequestId: requestId,
    helperChannelId: channelId,
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  assert.equal(main.rel, "noopener noreferrer");
  const helperWindow = detachedWindow(main.href);
  const helper = runDetachedReceiverHelper(helperWindow, {
    broadcastChannelFactory: factory,
    readyIntervalMs: 10,
  });
  assert.equal(await main.waitUntilReady(1000), undefined);

  const callbackUrl = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://receiver.example",
      envelope: { ciphertext: "opaque" },
    },
  );
  const credentialed = new URL(callbackUrl);
  credentialed.username = "attacker";
  assert.throws(
    () => main.navigateToCallback(credentialed.href, "https://sender.example"),
    (error) => error.code === "invalid_detached_callback",
  );
  main.navigateToCallback(callbackUrl, "https://sender.example");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(helperWindow.location.replacedWith, callbackUrl);
  assert.equal(helperWindow.location.hash, "");
  helper.close();
  main.close();
});

test("offers a same-tab helper continuation when automatic navigation does not complete", async () => {
  const factory = broadcastNetwork();
  const main = createDetachedReceiverHelperSession({
    protocol: "org.openapp.bridge",
    transport: "detached-datachannel/1",
    helperRequestId: requestId,
    helperChannelId: channelId,
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  const helperWindow = detachedWindow(main.href);
  let fallback;
  const helper = runDetachedReceiverHelper(helperWindow, {
    broadcastChannelFactory: factory,
    readyIntervalMs: 10,
    navigationFallbackDelayMs: 250,
    onNavigationFallback(details) {
      fallback = details;
      return true;
    },
  });
  await main.waitUntilReady(1_000);
  const callbackUrl = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://receiver.example",
      envelope: { ciphertext: "opaque" },
    },
  );
  main.navigateToCallback(callbackUrl, "https://sender.example");
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.deepEqual(fallback, {
    href: callbackUrl,
    senderOrigin: "https://sender.example",
  });
  helper.close();
  main.close();
});

test("pagehide terminalizes a receiver helper and releases its envelope", async () => {
  const factory = broadcastNetwork();
  const main = createDetachedReceiverHelperSession({
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  const helperWindow = detachedWindow(main.href);
  const helper = runDetachedReceiverHelper(helperWindow, {
    broadcastChannelFactory: factory,
    readyIntervalMs: 10,
  });
  await main.waitUntilReady(1000);
  assert.notEqual(helper.envelope, null);
  helperWindow.dispatchEvent(new Event("pagehide"));
  assert.equal(helper.envelope, null);
  main.close();
});

test("bounds and scrubs the complete helper fragment before decoding", () => {
  const oversized = detachedWindow(
    `https://receiver.example/_oab/helper#oab-detached-helper=1&payload=${"A".repeat(4097)}`,
  );
  assert.throws(
    () => runDetachedReceiverHelper(oversized),
    (error) => error.code === "invalid_detached_helper",
  );
  assert.equal(oversized.location.hash, "");

  const reordered = detachedWindow(
    "https://receiver.example/_oab/helper#payload=AAAA&oab-detached-helper=1",
  );
  assert.throws(
    () => runDetachedReceiverHelper(reordered),
    (error) => error.code === "invalid_detached_helper",
  );
  assert.equal(reordered.location.hash, "");
});

test("adopts a privately retained helper capture only after the real URL was scrubbed", async () => {
  const factory = broadcastNetwork();
  const main = createDetachedReceiverHelperSession({
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  const launch = new URL(main.href);
  const helperWindow = detachedWindow(
    "https://receiver.example/_oab/helper",
  );
  const helper = runDetachedReceiverHelper(helperWindow, {
    broadcastChannelFactory: factory,
    readyIntervalMs: 10,
    scrubbedHandoff: {
      fragment: launch.hash,
      href: launch.href,
      hadQuery: false,
      referrer: "",
    },
  });
  await main.waitUntilReady(1000);
  helper.close();
  main.close();

  assert.throws(
    () => runDetachedReceiverHelper(helperWindow, {
      broadcastChannelFactory: factory,
      scrubbedHandoff: {
        fragment: launch.hash,
        href: launch.href.replace("receiver.example", "attacker.example"),
        hadQuery: false,
        referrer: "",
      },
    }),
    (error) => error.code === "invalid_detached_helper",
  );
});

test("scrubs hostile callback query state even when its fragment is absent", async () => {
  const callback = detachedWindow(
    "https://sender.example/.well-known/open-app-bridge/callback?token=secret",
    "https://receiver.example/",
  );
  await assert.rejects(
    runDetachedSenderCallback(callback),
    (error) => error.code === "detached_fragment_missing",
  );
  assert.equal(callback.location.search, "");
  assert.equal(callback.location.hash, "");
  assert.equal(
    callback.location.replacedWith,
    "/.well-known/open-app-bridge/callback",
  );
});

test("closing local rendezvous waits settles them and removes listeners", async () => {
  const factory = broadcastNetwork();
  const waiting = waitForDetachedAnswer({
    requestId,
    channelId,
    receiverOrigin: "https://receiver.example",
  }, {
    broadcastChannelFactory: factory,
    timeoutMs: 1000,
  });
  waiting.close();
  await assert.rejects(
    waiting.promise,
    (error) => error.code === "detached_answer_wait_closed",
  );

  const main = createDetachedReceiverHelperSession({
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  const ready = main.waitUntilReady(1000);
  main.close();
  await assert.rejects(
    ready,
    (error) => error.code === "detached_helper_closed",
  );
});

test("validates the complete helper launch before opening a rendezvous channel", () => {
  const hostname = Array.from(
    { length: 28 },
    (_, index) => String.fromCharCode(97 + (index % 26)).repeat(63),
  ).join(".");
  const receiverOrigin = `https://${hostname}`;
  let channelsOpened = 0;

  assert.throws(
    () => createDetachedReceiverHelperSession({
      receiverOrigin,
      receiverHelper: `${receiverOrigin}/_oab/helper`,
      helperRequestId: requestId,
      helperChannelId: channelId,
    }, {
      broadcastChannelFactory() {
        channelsOpened += 1;
        return { close() {} };
      },
    }),
    (error) => error.code === "invalid_detached_helper" &&
      /fragment exceeds 4096 bytes/iu.test(error.message),
  );
  assert.equal(channelsOpened, 0);
});

test("expires and cleans up an idle receiver helper within 30 seconds", async () => {
  const factory = broadcastNetwork();
  const main = createDetachedReceiverHelperSession({
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  const helperWindow = detachedWindow(main.href);
  let closed = false;
  helperWindow.close = () => { closed = true; };
  let timeoutError;
  runDetachedReceiverHelper(helperWindow, {
    broadcastChannelFactory: factory,
    readyIntervalMs: 10,
    timeoutMs: 100,
    onTimeout(error) { timeoutError = error; },
  });
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(timeoutError?.code, "detached_helper_timeout");
  assert.equal(closed, true);
  main.close();
});

test("relays only an opaque sealed answer over the sender-origin channel", async () => {
  const factory = broadcastNetwork();
  const waiting = waitForDetachedAnswer({
    requestId,
    channelId,
    receiverOrigin: "https://receiver.example",
  }, {
    broadcastChannelFactory: factory,
    timeoutMs: 1000,
  });
  const sealed = {
    algorithm: "ECDH-P256+HKDF-SHA256+A256GCM",
    receiverPublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    salt: "salt",
    iv: "iv",
    ciphertext: "opaque-ciphertext",
  };
  const href = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://receiver.example",
      envelope: sealed,
    },
  );
  const callbackWindow = detachedWindow(
    href,
    "https://receiver.example/",
  );
  const callbackResult = await runDetachedSenderCallback(callbackWindow, {
    broadcastChannelFactory: factory,
  });
  assert.equal(callbackResult, undefined);
  assert.deepEqual(await waiting.promise, sealed);
  assert.equal(callbackWindow.location.hash, "");
});

test("callback uses pre-render scrubbed URL and referrer evidence", async () => {
  const factory = broadcastNetwork();
  const waiting = waitForDetachedAnswer({
    requestId,
    channelId,
    receiverOrigin: "https://receiver.example",
  }, {
    broadcastChannelFactory: factory,
    timeoutMs: 1000,
  });
  const href = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://receiver.example",
      envelope: { ciphertext: "scrub-first" },
    },
  );
  const launch = new URL(href);
  const callbackWindow = detachedWindow(
    launch.origin + launch.pathname,
  );
  await runDetachedSenderCallback(callbackWindow, {
    broadcastChannelFactory: factory,
    scrubbedHandoff: {
      fragment: launch.hash,
      href: launch.href,
      hadQuery: false,
      referrer: "https://receiver.example/",
    },
  });
  assert.deepEqual(await waiting.promise, { ciphertext: "scrub-first" });
});

test("sender callback rejects alternate same-origin routes after scrubbing", async () => {
  const href = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://receiver.example",
      envelope: { ciphertext: "opaque" },
    },
  );
  const wrongRoute = detachedWindow(
    href.replace(
      /\/\.well-known\/open-app-bridge\/callback/u,
      "/alternate-callback",
    ),
    "https://receiver.example/",
  );
  await assert.rejects(
    runDetachedSenderCallback(wrongRoute),
    (error) => error.code === "detached_callback_endpoint_mismatch",
  );
  assert.equal(wrongRoute.location.hash, "");
});

test("rejects any helper or callback page that retains an opener", async () => {
  const factory = broadcastNetwork();
  const main = createDetachedReceiverHelperSession({
    protocol: "org.openapp.bridge",
    transport: "detached-datachannel/1",
    helperRequestId: requestId,
    helperChannelId: channelId,
    receiverOrigin: "https://receiver.example",
    receiverHelper: "https://receiver.example/_oab/helper",
  }, { broadcastChannelFactory: factory });
  const helperWindow = detachedWindow(main.href);
  helperWindow.opener = {};
  assert.throws(
    () => runDetachedReceiverHelper(helperWindow, {
      broadcastChannelFactory: factory,
    }),
    (error) => error.code === "detached_opener_forbidden",
  );
  main.close();
});

test("fails closed for an empty or mismatched callback referrer", async () => {
  const factory = broadcastNetwork();
  const href = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://receiver.example",
      envelope: { ciphertext: "opaque" },
    },
  );
  await assert.rejects(
    runDetachedSenderCallback(detachedWindow(href), {
      broadcastChannelFactory: factory,
    }),
    (error) => error.code === "detached_receiver_referrer_missing",
  );
  await assert.rejects(
    runDetachedSenderCallback(
      detachedWindow(href, "https://other.example/path"),
      { broadcastChannelFactory: factory },
    ),
    (error) => error.code === "detached_receiver_origin_mismatch",
  );
});

test("rejects missing referrer evidence before asynchronous callback parsing", async () => {
  let broadcastOpened = false;
  const callbackWindow = detachedWindow(
    "https://sender.example/.well-known/open-app-bridge/callback#malformed",
  );
  await assert.rejects(
    runDetachedSenderCallback(callbackWindow, {
      broadcastChannelFactory() {
        broadcastOpened = true;
        throw new Error("must not open");
      },
    }),
    (error) => error.code === "detached_receiver_referrer_missing",
  );
  assert.equal(broadcastOpened, false);
  assert.equal(callbackWindow.location.hash, "");
});

test("sender listener ignores an outer receiver-origin mutation", async () => {
  const factory = broadcastNetwork();
  const waiting = waitForDetachedAnswer({
    requestId,
    channelId,
    receiverOrigin: "https://receiver.example",
  }, {
    broadcastChannelFactory: factory,
    timeoutMs: 100,
  });
  const mutatedHref = await createDetachedAnswerCallbackUrl(
    "https://sender.example",
    {
      requestId,
      channelId,
      receiverOrigin: "https://evil.example",
      envelope: { ciphertext: "attacker-answer" },
    },
  );
  await runDetachedSenderCallback(
    detachedWindow(mutatedHref, "https://evil.example/"),
    { broadcastChannelFactory: factory },
  );
  await assert.rejects(
    waiting.promise,
    (error) => error.code === "detached_answer_timeout",
  );
});

test("captures and scrubs an opaque offer before any WebRTC or crypto work", async () => {
  const receiverWindow = detachedWindow(
    "https://receiver.example/_oab/receive#opaque-untrusted-bootstrap",
  );
  const capture = captureDetachedOfferFromWindow(receiverWindow);
  assert.equal(capture.fragment, "#opaque-untrusted-bootstrap");
  assert.equal(receiverWindow.location.hash, "");
  await assert.rejects(
    inspectCapturedDetachedOffer(capture),
    (error) => error.code === "invalid_detached_fragment",
  );
});
