import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const port = Number.parseInt(process.env.PORT || "8080", 10);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function serviceWorkerTestPhase(request) {
  const match = String(request.headers.cookie ?? "").match(
    /(?:^|;\s*)oab-test-sw-phase=(legacy|migration|enabled)(?:;|$)/u,
  );
  return match?.[1] ?? "enabled";
}

function discoveryDocument(phase = "enabled") {
  return {
    protocol: "org.openapp.bridge",
    wireVersions: ["1.0"],
    status: phase === "enabled" ? "enabled" : "disabled",
    endpoint: "/examples/receiver/index.html",
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
        receiverHelper: "/examples/receiver/helper.html",
        representations: ["text/markdown", "text/html", "text/plain"],
        assetTypes: [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "image/svg+xml",
        ],
        limits: {
          maximumSignalingBytes: 32768,
          maximumFrameBytes: 16384,
          maximumTransferBytes: 16777216,
          maximumAssets: 32,
        },
      },
    },
    declarationId: "reference-example-2026-08-28",
    senderPolicy: "user-controlled",
    discoveryTtl: 60,
    applicationManifest: "/examples/receiver/manifest.webmanifest",
    extensions: {},
  };
}

const strictPageHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), display-capture=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const senderPageCsp =
  "default-src 'self'; " +
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; " +
  "img-src 'self' blob: data: https: http://localhost:* http://127.0.0.1:*; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const swTestPhase = serviceWorkerTestPhase(request);
  if (url.pathname === "/.well-known/open-app-bridge") {
    const body = JSON.stringify(discoveryDocument(swTestPhase));
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-OAB-Test-Network-Phase": swTestPhase,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
    return;
  }

  if (url.pathname === "/_oab-test/historical-worker.js") {
    const common =
      `const release = ${JSON.stringify(swTestPhase)};\n` +
      "self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));\n" +
      "self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));\n";
    const legacyFetch = swTestPhase === "legacy"
      ? "self.addEventListener('fetch', (event) => {\n" +
        "  const url = new URL(event.request.url);\n" +
        "  if (url.origin !== self.location.origin) return;\n" +
        "  event.respondWith((async () => {\n" +
        "    const response = await fetch(event.request);\n" +
        "    const headers = new Headers(response.headers);\n" +
        "    headers.set('X-OAB-Legacy-Intercepted', release);\n" +
        "    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });\n" +
        "  })());\n" +
        "});\n"
      : "// Deliberately no fetch, message, sync, push, or telemetry handler.\n";
    const body = `${common}${legacyFetch}`;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "text/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "X-Content-Type-Options": "nosniff",
      "X-OAB-Test-Network-Phase": swTestPhase,
    });
    response.end(body);
    return;
  }

  if (
    swTestPhase !== "enabled" &&
    [
      "/examples/receiver/index.html",
      "/examples/receiver/helper.html",
      "/.well-known/open-app-bridge/callback",
    ].includes(url.pathname)
  ) {
    response.writeHead(404, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-OAB-Test-Network-Phase": swTestPhase,
    });
    response.end("OAB is disabled during historical service-worker migration.");
    return;
  }

  const route = url.pathname.endsWith("/")
    ? `${url.pathname}index.html`
    : url.pathname;
  let relative;
  try {
    relative = normalize(decodeURIComponent(route)).replace(/^[/\\]+/u, "");
  } catch (_) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid path");
    return;
  }
  if (route === "/.well-known/open-app-bridge/callback") {
    relative = "examples/sender/callback.html";
  }
  if (
    /^\/examples\/receiver\/app\/document\/[A-Za-z0-9_-]{16,128}$/u.test(
      url.pathname,
    )
  ) {
    relative = "examples/receiver/app/index.html";
  }
  const path = join(root, relative);
  const isInsideRoot = path === root || path.startsWith(`${root}${sep}`);
  if (!isInsideRoot || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const headers = {
    "Content-Type": mimeTypes[extname(path)] || "application/octet-stream",
    "Cache-Control": "no-store",
    "X-OAB-Test-Network-Phase": swTestPhase,
  };
  if (route === "/examples/receiver/manifest.webmanifest") {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
  }
  if (route === "/examples/receiver/app-icon.png") {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    headers["X-Content-Type-Options"] = "nosniff";
  }
  if (
    route.endsWith(".html") ||
    route.startsWith("/examples/receiver/app/document/") ||
    route === "/.well-known/open-app-bridge/callback"
  ) {
    Object.assign(headers, strictPageHeaders);
  }
  if (
    route.startsWith("/examples/sender/") ||
    route.startsWith("/examples/widget/")
  ) {
    // Sender surfaces must be able to discover any user-selected HTTPS
    // receiver. Scripts remain self-only; the broader connect/img policies
    // are limited to receiver discovery and optional manifest display media.
    headers["Content-Security-Policy"] = senderPageCsp;
  }
  if (route === "/examples/receiver/index.html") {
    headers["Content-Security-Policy"] =
      "default-src 'self'; " +
      "script-src 'self' 'sha256-yWjp6X7L9yDoL9kNnbJwPcOSFZc7Jycj8BFWlRpxWV0='; " +
      "img-src 'self' blob:; object-src 'none'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'";
  }
  if (route === "/examples/receiver/helper.html") {
    headers["Content-Security-Policy"] =
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    headers["Referrer-Policy"] = "origin";
  }
  if (route === "/.well-known/open-app-bridge/callback") {
    headers["Content-Security-Policy"] =
      "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  }
  response.writeHead(200, headers);
  createReadStream(path).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`OAB sender:   http://localhost:${port}/examples/sender/`);
  console.log(`OAB receiver: http://127.0.0.1:${port}/examples/receiver/`);
  console.log(`OAB widget:   http://localhost:${port}/examples/widget/`);
});
