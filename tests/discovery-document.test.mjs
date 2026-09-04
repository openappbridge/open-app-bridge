import assert from "node:assert/strict";
import test from "node:test";

import { OAB_TRANSPORTS } from "../src/constants.js";
import {
  ReceiverDeclaration,
  assertFreshDeclaration,
  discoverReceiver,
} from "../src/discovery-document.js";

function declaration(overrides = {}) {
  return {
    protocol: "org.openapp.bridge",
    wireVersions: ["1.0"],
    status: "enabled",
    endpoint: "/_oab/receive",
    intents: ["preview"],
    transports: {
      "link-envelope/1": {
        representations: ["text/markdown", "text/plain"],
        assetTypes: [],
        limits: {
          maximumUrlBytes: 16384,
          maximumFragmentBytes: 12288,
          maximumDecodedBytes: 8192,
        },
      },
      "detached-datachannel/1": {
        representations: ["text/markdown", "text/html", "text/plain"],
        assetTypes: ["image/png", "image/svg+xml"],
        receiverHelper: "/_oab/detached-receiver",
        limits: {
          maximumTransferBytes: 16777216,
          maximumAssets: 32,
          maximumSignalingBytes: 32768,
          maximumFrameBytes: 16384,
        },
      },
    },
    senderPolicy: "user-controlled",
    declarationId: "declaration-2026-08-28",
    discoveryTtl: 60,
    extensions: {},
    ...overrides,
  };
}

function jsonResponse(value, options = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/octet-stream",
      ...options.headers,
    },
  });
  Object.defineProperty(response, "url", {
    value:
      options.url ??
      "https://receiver.example/.well-known/open-app-bridge",
  });
  return response;
}

test("discovers a bounded canonical JSON declaration with explicit transports", async () => {
  let request;
  const receiver = await discoverReceiver("https://Editor.Example/", {
    now: () => 1000,
    fetchImpl: async (url, options) => {
      request = { url: url.href, options };
      return jsonResponse(declaration(), {
        url: "https://editor.example/.well-known/open-app-bridge",
      });
    },
  });

  assert.ok(receiver instanceof ReceiverDeclaration);
  assert.equal(request.url, "https://editor.example/.well-known/open-app-bridge");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.match(request.options.headers.Accept, /application\/json/u);
  assert.equal(receiver.endpoint, "https://editor.example/_oab/receive");
  assert.equal(receiver.selectedVersion, "1.0");
  assert.deepEqual(receiver.wireVersions, ["1.0"]);
  assert.equal(receiver.supportsTransport(OAB_TRANSPORTS.linkEnvelope), true);
  assert.equal(
    receiver.supportsTransport(OAB_TRANSPORTS.detachedDataChannel),
    true,
  );
  assert.deepEqual(receiver.linkEnvelope.assetTypes, []);
  assert.equal(
    receiver.detachedDataChannel.receiverHelper,
    "https://editor.example/_oab/detached-receiver",
  );
  assert.deepEqual(receiver.representations, [
    "text/markdown",
    "text/plain",
    "text/html",
  ]);
  assert.deepEqual(receiver.assetTypes, ["image/png", "image/svg+xml"]);
  assert.equal(receiver.expiresAt, 61000);
});

test("receiver declarations can only originate from verified discovery", () => {
  assert.throws(() => new ReceiverDeclaration({}), TypeError);
  assert.throws(
    () => assertFreshDeclaration(Object.create(ReceiverDeclaration.prototype)),
    (error) => error.code === "discovery_required",
  );
});

test("applies a hard deadline to discovery and aborts the network operation", async () => {
  let signal;
  const startedAt = Date.now();
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      timeoutMs: 100,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    }),
    (error) => error.code === "discovery_timeout",
  );
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 1000);

  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      timeoutMs: 30001,
      fetchImpl: async () => {
        throw new Error("must not fetch with an invalid deadline");
      },
    }),
    TypeError,
  );
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      applicationManifestTimeoutMs: 15001,
      fetchImpl: async () => {
        throw new Error("must not fetch with an invalid metadata deadline");
      },
    }),
    TypeError,
  );
});

test("discovery deadline covers a response body that never completes", async () => {
  let signal;
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      timeoutMs: 100,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        const response = new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(response, "url", {
          value: "https://receiver.example/.well-known/open-app-bridge",
        });
        return response;
      },
    }),
    (error) => error.code === "discovery_timeout",
  );
  assert.equal(signal.aborted, true);
});

test("bounds optional manifest delay without failing core discovery", async () => {
  const withManifest = declaration({
    applicationManifest: "/manifest.webmanifest",
  });
  let manifestSignal;
  const receiver = await discoverReceiver("https://receiver.example", {
    applicationManifestTimeoutMs: 100,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/.well-known/open-app-bridge")) {
        return jsonResponse(withManifest);
      }
      manifestSignal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(receiver.application, null);
  assert.equal(manifestSignal.aborted, true);
});

test("caller cancellation is never swallowed as optional manifest failure", async () => {
  const controller = new AbortController();
  const withManifest = declaration({
    applicationManifest: "/manifest.webmanifest",
  });
  let startManifest;
  const manifestStarted = new Promise((resolve) => { startManifest = resolve; });
  const pending = discoverReceiver("https://receiver.example", {
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/.well-known/open-app-bridge")) {
        return jsonResponse(withManifest);
      }
      startManifest(options.signal);
      return new Promise(() => {});
    },
  });
  const manifestSignal = await manifestStarted;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(manifestSignal.aborted, true);
});

test("fails closed without an explicit media type or bounded body stream", async () => {
  const exactUrl =
    "https://receiver.example/.well-known/open-app-bridge";
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        redirected: false,
        url: exactUrl,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(declaration())),
            );
            controller.close();
          },
        }),
      }),
    }),
    (error) => error.code === "invalid_discovery_media_type",
  );

  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        redirected: false,
        url: exactUrl,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
      }),
    }),
    (error) => error.code === "bounded_response_required",
  );
});

test("requires status, versions, and a non-empty explicit transport map", async () => {
  for (const value of [
    declaration({ status: "disabled" }),
    declaration({ wireVersions: ["2.0"] }),
    declaration({ transports: {} }),
  ]) {
    await assert.rejects(
      discoverReceiver("https://receiver.example", {
        fetchImpl: async () => jsonResponse(value),
      }),
      (error) => [
        "receiver_disabled",
        "unsupported_version",
        "invalid_declaration",
      ].includes(error.code),
    );
  }
  const omitted = declaration();
  delete omitted.transports;
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () => jsonResponse(omitted),
    }),
    (error) => error.code === "invalid_declaration",
  );
});

test("selects only an implemented wire grammar and fails closed otherwise", async () => {
  const negotiated = await discoverReceiver("https://receiver.example", {
    fetchImpl: async () =>
      jsonResponse(declaration({ wireVersions: ["1.1", "1.0"] })),
  });
  assert.equal(negotiated.selectedVersion, "1.0");
  assert.deepEqual(negotiated.wireVersions, ["1.1", "1.0"]);

  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      supportedWireVersions: ["1.1", "1.0"],
      fetchImpl: async () => jsonResponse(declaration()),
    }),
    TypeError,
  );

  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () =>
        jsonResponse(declaration({ wireVersions: ["3.0"] })),
    }),
    (error) => error.code === "unsupported_version",
  );

  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () => jsonResponse(declaration({
        wireVersions: ["1.8", "1.7", "1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0"],
      })),
    }),
    (error) => error.code === "invalid_declaration",
  );
});

test("ignores bounded unknown transports but never treats them as supported", async () => {
  const value = declaration();
  value.transports["future-safe/2"] = {
    opaque: { boundedByTheWholeDocument: true },
  };
  const receiver = await discoverReceiver("https://receiver.example", {
    fetchImpl: async () => jsonResponse(value),
  });
  assert.deepEqual(receiver.advertisedTransportIds, [
    "link-envelope/1",
    "detached-datachannel/1",
    "future-safe/2",
  ]);
  assert.equal(receiver.supportsTransport("future-safe/2"), false);
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      requiredTransport: "future-safe/2",
      fetchImpl: async () => jsonResponse(value),
    }),
    (error) => error.code === "unsupported_transport",
  );
});

test("rejects unknown known-transport fields, unsafe helper paths, and hard-limit excess", async () => {
  const unknown = declaration();
  unknown.transports["link-envelope/1"].unexpected = true;
  const helperQuery = declaration();
  helperQuery.transports["detached-datachannel/1"].receiverHelper =
    "/_oab/helper?state=1";
  const signaling = declaration();
  signaling.transports["detached-datachannel/1"].limits.maximumSignalingBytes =
    32769;
  const signalingLow = declaration();
  signalingLow.transports[
    "detached-datachannel/1"
  ].limits.maximumSignalingBytes = 1023;
  const frame = declaration();
  frame.transports["detached-datachannel/1"].limits.maximumFrameBytes = 16385;
  const linkUrl = declaration();
  linkUrl.transports["link-envelope/1"].limits.maximumUrlBytes = 65537;
  const linkFragment = declaration();
  linkFragment.transports["link-envelope/1"].limits.maximumFragmentBytes =
    32769;
  const linkDecoded = declaration();
  linkDecoded.transports["link-envelope/1"].limits.maximumDecodedBytes = 24577;

  for (const [value, requiredTransport] of [
    [unknown, "link-envelope/1"],
    [helperQuery, "detached-datachannel/1"],
    [signaling, "detached-datachannel/1"],
    [signalingLow, "detached-datachannel/1"],
    [frame, "detached-datachannel/1"],
    [linkUrl, "link-envelope/1"],
    [linkFragment, "link-envelope/1"],
    [linkDecoded, "link-envelope/1"],
  ]) {
    await assert.rejects(
      discoverReceiver("https://receiver.example", {
        requiredTransport,
        fetchImpl: async () => jsonResponse(value),
      }),
      (error) => error.code === "unsupported_transport",
    );
  }
});

test("rejects unknown top-level fields and duplicate JSON member names", async () => {
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () =>
        jsonResponse({ ...declaration(), unexpected: "not an extension" }),
    }),
    (error) => error.code === "invalid_declaration",
  );
  const duplicate = JSON.stringify(declaration()).replace(
    '"status":"enabled"',
    '"status":"enabled","status":"disabled"',
  );
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () => jsonResponse(duplicate),
    }),
    (error) => error.code === "invalid_declaration",
  );
});

test("bounds the body before parsing and rejects every redirect", async () => {
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () =>
        jsonResponse(declaration(), {
          headers: { "content-length": "8193" },
        }),
    }),
    (error) => error.code === "discovery_too_large",
  );
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      maximumDiscoveryBytes: 128,
      fetchImpl: async () => jsonResponse(declaration()),
    }),
    (error) => error.code === "discovery_too_large",
  );
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () => {
        const response = jsonResponse(declaration());
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    }),
    (error) => error.code === "discovery_redirected",
  );
});

test("rejects a response whose final URL differs from the exact discovery URL", async () => {
  await assert.rejects(
    discoverReceiver("https://receiver.example", {
      fetchImpl: async () =>
        jsonResponse(declaration(), {
          url: "https://receiver.example/redirected-discovery",
        }),
    }),
    (error) => error.code === "discovery_url_mismatch",
  );
});

test("accepts ignored extension data without letting it alter known fields", async () => {
  const receiver = await discoverReceiver("https://receiver.example", {
    fetchImpl: async () => jsonResponse(declaration({
      extensions: {
        "example.test/display": { accent: "blue", status: "disabled" },
      },
    })),
  });
  assert.equal(receiver.selectedVersion, "1.0");
  assert.equal(receiver.extensions["example.test/display"].status, "disabled");
});
