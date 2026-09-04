import assert from "node:assert/strict";
import test from "node:test";

import * as compatibility from "../src/discovery.js";
import * as canonical from "../src/discovery-document.js";
import * as publicApi from "../src/index.js";

const DISCOVERY_URL =
  "https://receiver.example/.well-known/open-app-bridge";

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
          maximumUrlBytes: 16_384,
          maximumFragmentBytes: 12_288,
          maximumDecodedBytes: 8_192,
        },
      },
      "detached-datachannel/1": {
        representations: ["text/markdown", "text/html", "text/plain"],
        assetTypes: ["image/png", "image/svg+xml"],
        receiverHelper: "/_oab/detached-helper",
        limits: {
          maximumTransferBytes: 16 * 1024 * 1024,
          maximumAssets: 32,
          maximumSignalingBytes: 32_768,
          maximumFrameBytes: 16_384,
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

function response(value, options = {}) {
  const body = value == null
    ? null
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  const result = new Response(body, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json; charset=utf-8",
      ...options.headers,
    },
  });
  Object.defineProperty(result, "url", {
    value: options.url ?? DISCOVERY_URL,
  });
  if (options.redirected != null) {
    Object.defineProperty(result, "redirected", {
      value: options.redirected,
    });
  }
  return result;
}

test("keeps discovery.js only as an exact JSON-discovery re-export", () => {
  assert.equal(compatibility.discoverReceiver, canonical.discoverReceiver);
  assert.equal(compatibility.ReceiverDeclaration, canonical.ReceiverDeclaration);
  assert.equal(compatibility.assertFreshDeclaration, canonical.assertFreshDeclaration);
  assert.equal(publicApi.discoverReceiver, canonical.discoverReceiver);
  assert.equal("OAB_HEADERS" in publicApi, false);
  assert.equal("parseReceiverHeaders" in compatibility, false);
});

test("discovers only from the exact bounded JSON well-known resource", async () => {
  let observed;
  const receiver = await publicApi.discoverReceiver("https://Receiver.Example", {
    now: () => 1000,
    fetchImpl: async (url, options) => {
      observed = { url: url.href, options };
      return response(declaration());
    },
  });

  assert.equal(observed.url, DISCOVERY_URL);
  assert.equal(observed.options.method, "GET");
  assert.equal(observed.options.mode, "cors");
  assert.equal(observed.options.credentials, "omit");
  assert.equal(observed.options.redirect, "error");
  assert.equal(observed.options.referrerPolicy, "no-referrer");
  assert.equal(observed.options.cache, "no-store");
  assert.match(observed.options.headers.Accept, /application\/json/u);
  assert.equal(receiver.origin, "https://receiver.example");
  assert.equal(receiver.endpoint, "https://receiver.example/_oab/receive");
  assert.equal(receiver.selectedVersion, "1.0");
  assert.equal(receiver.supportsTransport("link-envelope/1"), true);
  assert.equal(receiver.supportsTransport("detached-datachannel/1"), true);
  assert.equal(
    receiver.detachedDataChannel.receiverHelper,
    "https://receiver.example/_oab/detached-helper",
  );
  assert.equal(receiver.checkedAt, 1000);
  assert.equal(receiver.expiresAt, 61_000);
});

test("selects the implemented grammar from a bounded advertised version list", async () => {
  const receiver = await publicApi.discoverReceiver("https://receiver.example", {
    supportedWireVersions: ["1.0"],
    fetchImpl: async () =>
      response(declaration({ wireVersions: ["1.1", "1.0"] })),
  });
  assert.equal(receiver.selectedVersion, "1.0");
});

test("refuses header-only opt-in, URL mismatches, redirects, and unsafe media", async () => {
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(""),
    }),
    (error) => error.code === "invalid_declaration",
  );
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(declaration(), {
        url: "https://receiver.example/redirected",
      }),
    }),
    (error) => error.code === "discovery_url_mismatch",
  );
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(declaration(), { redirected: true }),
    }),
    (error) => error.code === "discovery_redirected",
  );
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(declaration(), {
        contentType: "text/html",
      }),
    }),
    (error) => error.code === "invalid_discovery_media_type",
  );
});

test("bounds declaration bytes before JSON parsing", async () => {
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response("{}", {
        headers: { "content-length": "8193" },
      }),
    }),
    (error) => error.code === "discovery_too_large",
  );
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      maximumDiscoveryBytes: 128,
      fetchImpl: async () => response(declaration()),
    }),
    (error) => error.code === "discovery_too_large",
  );
});

test("rejects duplicate JSON members and unknown top-level authority", async () => {
  const duplicate = JSON.stringify(declaration()).replace(
    '"status":"enabled"',
    '"status":"enabled","status":"disabled"',
  );
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(duplicate),
    }),
    (error) => error.code === "invalid_declaration",
  );
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response({ ...declaration(), endpointOverride: "/x" }),
    }),
    (error) => error.code === "invalid_declaration",
  );
});

test("rejects non-HTTPS origins and endpoint confusion attacks", async () => {
  for (const target of [
    "http://receiver.example",
    "https://receiver.example/path",
    "https://user@receiver.example",
  ]) {
    await assert.rejects(
      publicApi.discoverReceiver(target, {
        fetchImpl: async () => {
          throw new Error("must not fetch an invalid origin");
        },
      }),
      (error) => error.code === "invalid_origin",
    );
  }

  for (const endpoint of [
    "https://attacker.example/receive",
    "//attacker.example/receive",
    "/receive?state=1",
    "/receive#state",
    "/a/../receive",
    "/a\\receive",
    "/%2e%2e/receive",
    "/%2F%2Fattacker.example/receive",
    "/%5creceive",
    "/%252e%252e/receive",
    "/receiver%20helper",
    "/%ZZ/receive",
  ]) {
    await assert.rejects(
      publicApi.discoverReceiver("https://receiver.example", {
        fetchImpl: async () => response(declaration({ endpoint })),
      }),
      (error) => error.code === "invalid_declaration",
      endpoint,
    );
  }
});

test("rejects explicit null for non-nullable discovery TTL", async () => {
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(declaration({ discoveryTtl: null })),
    }),
    (error) => error.code === "invalid_declaration",
  );
});

test("isolates a malformed known profile without turning another into fallback", async () => {
  const malformedDetached = declaration();
  malformedDetached.transports["detached-datachannel/1"].limits.maximumFrameBytes = 16;
  const receiver = await publicApi.discoverReceiver("https://receiver.example", {
    fetchImpl: async () => response(malformedDetached),
  });
  assert.equal(receiver.supportsTransport("link-envelope/1"), true);
  assert.equal(receiver.supportsTransport("detached-datachannel/1"), false);

  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      requiredTransport: "detached-datachannel/1",
      fetchImpl: async () => response(malformedDetached),
    }),
    (error) => error.code === "unsupported_transport",
  );

  const detachedOnly = declaration({
    transports: {
      "detached-datachannel/1":
        malformedDetached.transports["detached-datachannel/1"],
    },
  });
  await assert.rejects(
    publicApi.discoverReceiver("https://receiver.example", {
      fetchImpl: async () => response(detachedOnly),
    }),
    (error) => error.code === "unsupported_transport",
  );
});

test("ignores unknown bounded profiles and rejects strict-member nulls", async () => {
  const future = declaration();
  future.transports["future-transfer/2"] = { opaque: true };
  const receiver = await publicApi.discoverReceiver("https://receiver.example", {
    fetchImpl: async () => response(future),
  });
  assert.equal(receiver.supportsTransport("future-transfer/2"), false);
  assert.ok(receiver.advertisedTransportIds.includes("future-transfer/2"));

  for (const invalid of [
    declaration({ senderPolicy: null }),
    declaration({ applicationManifest: null }),
    declaration({ extensions: null }),
  ]) {
    await assert.rejects(
      publicApi.discoverReceiver("https://receiver.example", {
        fetchImpl: async () => response(invalid),
      }),
      (error) => error.code === "invalid_declaration",
    );
  }

  const nullDeclarationId = await publicApi.discoverReceiver(
    "https://receiver.example",
    {
      fetchImpl: async () => response(declaration({ declarationId: null })),
    },
  );
  assert.equal(nullDeclarationId.declarationId, null);
});

test("rejects expired declarations at the use boundary", async () => {
  const receiver = await canonical.discoverReceiver(
    "https://receiver.example",
    {
      now: () => 0,
      fetchImpl: async () => response(declaration({ discoveryTtl: 1 })),
    },
  );
  assert.throws(
    () => canonical.assertFreshDeclaration(receiver, 1000),
    (error) => error.code === "discovery_expired",
  );
});
