import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_REQUEST_LIMITS,
  fetchReceiverApplicationIcon,
  fetchReceiverApplicationManifest,
  normalizeApplicationManifest,
  selectApplicationIcon,
} from "../src/index.js";

const origin = "https://writer.example";
const manifestUrl = `${origin}/manifest.webmanifest`;

function responseAt(url, body, init = {}) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  if (init.redirected != null) {
    Object.defineProperty(response, "redirected", {
      value: init.redirected,
    });
  }
  return response;
}

function pngHeader(width, height) {
  const bytes = new Uint8Array(57);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([0, 0, 0, 0, 73, 68, 65, 84], 33);
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68], 45);
  return bytes;
}

function apngHeader(width, height) {
  const png = pngHeader(width, height);
  const bytes = new Uint8Array(png.byteLength + 20);
  bytes.set(png.subarray(0, 33));
  bytes.set([0, 0, 0, 8, 97, 99, 84, 76], 33);
  bytes.set(png.subarray(33), 53);
  return bytes;
}

test("normalizes a same-origin standard web app manifest", () => {
  const application = normalizeApplicationManifest(
    {
      name: "Example Writer",
      short_name: "Writer",
      description: "A portable writing application.",
      theme_color: "#6750A4",
      icons: [
        { src: "/icon-48.png", sizes: "48x48", type: "image/png" },
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "https://tracker.example/icon.png", sizes: "512x512" },
      ],
    },
    { origin, manifestUrl },
  );

  assert.equal(application.name, "Example Writer");
  assert.equal(application.shortName, "Writer");
  assert.equal(application.themeColor, "#6750a4");
  assert.equal(application.icons.length, 2);
  assert.equal(
    selectApplicationIcon(application, 96).src,
    `${origin}/icon-192.png`,
  );
});

test("rejects non-Unicode-scalar manifest metadata without damaging astral text", () => {
  for (const value of [
    { name: "broken\ud800name" },
    { description: "broken\udfffdescription" },
    { name: "Writer", icons: [{ src: "/icon\ud800.png" }] },
    { name: "Writer", icons: [{ src: "/icon.png", purpose: "any\udfff" }] },
  ]) {
    assert.equal(
      normalizeApplicationManifest(value, { origin, manifestUrl }),
      null,
    );
  }

  const application = normalizeApplicationManifest(
    { name: "Writer \ud83d\udcdd" },
    { origin, manifestUrl },
  );
  assert.equal(application.name, "Writer 📝");
});

test("publishes immutable hard network deadline limits", () => {
  assert.deepEqual(NETWORK_REQUEST_LIMITS, {
    minimumTimeoutMs: 100,
    discovery: { defaultTimeoutMs: 8000, maximumTimeoutMs: 30000 },
    applicationManifest: { defaultTimeoutMs: 4000, maximumTimeoutMs: 15000 },
    applicationIcon: { defaultTimeoutMs: 4000, maximumTimeoutMs: 15000 },
  });
  assert.equal(Object.isFrozen(NETWORK_REQUEST_LIMITS), true);
  assert.equal(Object.isFrozen(NETWORK_REQUEST_LIMITS.discovery), true);
});

test("fetches metadata without credentials or redirects", async () => {
  let request;
  const application = await fetchReceiverApplicationManifest(
    origin,
    "/manifest.webmanifest",
    {
      fetchImpl: async (url, options) => {
        request = { url: String(url), options };
        return responseAt(
          manifestUrl,
          JSON.stringify({
            name: "Example Writer",
            icons: [{ src: "/icon.png", sizes: "192x192" }],
          }),
          {
            headers: { "Content-Type": "application/manifest+json" },
          },
        );
      },
    },
  );

  assert.equal(request.url, manifestUrl);
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.equal(application.name, "Example Writer");
});

test("rejects cross-origin metadata resources and oversized manifests", async () => {
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "https://other.example/app.json"),
    (error) => error.code === "invalid_application_manifest",
  );
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest?v=1"),
    (error) => error.code === "invalid_application_manifest",
  );
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      fetchImpl: async () =>
        responseAt(manifestUrl, "{}", {
          headers: {
            "Content-Type": "application/manifest+json",
            "Content-Length": "999999",
          },
        }),
    }),
    (error) => error.code === "application_manifest_too_large",
  );
});

test("rejects redirected, non-canonical-length, and invalid-UTF-8 manifests", async () => {
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      fetchImpl: async () => responseAt(
        "https://writer.example/elsewhere",
        "{}",
        {
          redirected: true,
          headers: { "Content-Type": "application/manifest+json" },
        },
      ),
    }),
    (error) => error.code === "application_manifest_redirected",
  );
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      fetchImpl: async () => responseAt(manifestUrl, "{}", {
        headers: {
          "Content-Type": "application/manifest+json",
          "Content-Length": "1e2",
        },
      }),
    }),
    (error) => error.code === "invalid_resource_length",
  );
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      fetchImpl: async () => responseAt(
        manifestUrl,
        new Uint8Array([0xc3, 0x28]),
        { headers: { "Content-Type": "application/manifest+json" } },
      ),
    }),
    (error) => error.code === "invalid_application_manifest",
  );
});

test("applies a hard deadline to the complete manifest fetch", async () => {
  let signal;
  const startedAt = Date.now();
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      timeoutMs: 100,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    }),
    (error) => error.code === "application_manifest_timeout",
  );
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 1000);

  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      timeoutMs: 99,
      fetchImpl: async () => {
        throw new Error("must not fetch with an invalid deadline");
      },
    }),
    TypeError,
  );
});

test("manifest deadline covers a response body that never completes", async () => {
  let signal;
  await assert.rejects(
    fetchReceiverApplicationManifest(origin, "/manifest.webmanifest", {
      timeoutMs: 100,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return responseAt(
          manifestUrl,
          new ReadableStream({ start() {} }),
          { headers: { "Content-Type": "application/manifest+json" } },
        );
      },
    }),
    (error) => error.code === "application_manifest_timeout",
  );
  assert.equal(signal.aborted, true);
});

test("fetches an application icon through the bounded credentialless path", async () => {
  const application = normalizeApplicationManifest(
    {
      name: "Writer",
      icons: [{ src: "/icon.png", type: "image/png", sizes: "192x192" }],
    },
    { origin, manifestUrl },
  );
  let request;
  const resource = await fetchReceiverApplicationIcon(application, {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return responseAt(`${origin}/icon.png`, pngHeader(192, 192), {
        headers: { "Content-Type": "image/png" },
      });
    },
  });
  assert.equal(request.url, `${origin}/icon.png`);
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.equal(resource.width, 192);
  assert.equal(resource.height, 192);
  assert.equal(resource.blob.type, "image/png");
});

test("rejects redirected, mismatched, oversized, and over-dimensional icons", async () => {
  const application = normalizeApplicationManifest(
    {
      name: "Writer",
      icons: [{ src: "/icon.png", type: "image/png", sizes: "192x192" }],
    },
    { origin, manifestUrl },
  );
  await assert.rejects(
    fetchReceiverApplicationIcon(application, {
      fetchImpl: async () => responseAt(`${origin}/other.png`, pngHeader(32, 32), {
        redirected: true,
        headers: { "Content-Type": "image/png" },
      }),
    }),
    (error) => error.code === "application_icon_redirected",
  );
  await assert.rejects(
    fetchReceiverApplicationIcon(application, {
      fetchImpl: async () => responseAt(`${origin}/icon.png`, pngHeader(32, 32), {
        headers: { "Content-Type": "image/jpeg" },
      }),
    }),
    (error) => error.code === "invalid_application_icon",
  );
  await assert.rejects(
    fetchReceiverApplicationIcon(application, {
      fetchImpl: async () => responseAt(`${origin}/icon.png`, new Uint8Array(), {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "262145",
        },
      }),
    }),
    (error) => error.code === "application_icon_too_large",
  );
  await assert.rejects(
    fetchReceiverApplicationIcon(application, {
      fetchImpl: async () => responseAt(`${origin}/icon.png`, pngHeader(2048, 1), {
        headers: { "Content-Type": "image/png" },
      }),
    }),
    (error) => error.code === "application_icon_dimensions_unsupported",
  );
  await assert.rejects(
    fetchReceiverApplicationIcon(application, {
      fetchImpl: async () => responseAt(`${origin}/icon.png`, apngHeader(32, 32), {
        headers: { "Content-Type": "image/png" },
      }),
    }),
    (error) => error.code === "animated_application_icon_forbidden",
  );
});

test("applies a hard deadline to application icon probing", async () => {
  const application = normalizeApplicationManifest(
    {
      name: "Writer",
      icons: [{ src: "/icon.png", type: "image/png", sizes: "192x192" }],
    },
    { origin, manifestUrl },
  );
  let signal;
  await assert.rejects(
    fetchReceiverApplicationIcon(application, {
      timeoutMs: 100,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    }),
    (error) => error.code === "application_icon_timeout",
  );
  assert.equal(signal.aborted, true);
});
