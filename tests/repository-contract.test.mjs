import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

function read(path) {
  return readFileSync(path, "utf8");
}

test("normative repository contract is registry-free, preview-first, and profile-explicit", () => {
  const specification = read("spec/open-app-bridge-1.0.md");
  const readme = read("README.md");
  const detached = read("spec/transports/detached-datachannel-1.0.md");
  const link = read("spec/transports/link-envelope-1.0.md");

  assert.match(specification, /defines no receiver registry/iu);
  assert.match(specification, /There is no mandatory registry/iu);
  assert.match(specification, /persisted only after Preserve/iu);
  assert.match(specification, /Neither profile is a fallback/iu);
  assert.match(specification, /browser-window\/1.*native-link\/1.*removed/su);
  assert.match(readme, /registry-free/iu);
  assert.match(readme, /never silently changes profile/iu);
  assert.match(readme, /Every browser launch is top-level and `noopener noreferrer`/u);
  assert.match(link, /non-confidential/iu);
  assert.match(link, /provides no[\s\S]*delivery\s+receipt/iu);
  assert.match(detached, /no OAB registry/iu);
  assert.match(detached, /No fatal condition may trigger `link-envelope\/1`/u);
});

test("normative contract preserves launch, receiver, and network authority boundaries", () => {
  const specification = read("spec/open-app-bridge-1.0.md");
  const link = read("spec/transports/link-envelope-1.0.md");
  const detached = read("spec/transports/detached-datachannel-1.0.md");
  const security = read("SECURITY.md");

  for (const document of [specification, link, detached, security]) {
    assert.match(document, /event-loop task(?: boundary)?/iu);
    assert.match(document, /microtask/iu);
  }
  assert.match(
    link,
    /may report only \*\*launch initiated\*\*, \*\*launched\*\*/iu,
  );
  assert.match(link, /MUST NOT call the outcome sent, received, delivered, previewing/iu);
  assert.match(specification, /restricted receiver document begins at marked Document entry/iu);
  assert.match(specification, /login\/account\s+prompts,\s+authentication SDKs/iu);
  assert.match(
    specification,
    /remote\s+fonts,\s+CDN-hosted renderer resources/iu,
  );
  assert.match(specification, /Preserve MAY durably stage or import/iu);
  assert.match(specification, /full top-level navigation/iu);
  assert.match(
    specification,
    /complete OAB authority resource graph is network-authoritative/iu,
  );
  assert.match(specification, /separate migration deployment/iu);
  assert.match(
    specification,
    /exactly one new top-level target plus its\s+initial network request to the exact profile-defined destination/iu,
  );
  assert.match(specification, /without the real target\s+and request is not launch evidence/iu);
  assert.match(
    specification,
    /closed wire vocabulary[\s\S]*unknown value is a protocol error/iu,
  );
});

test("public runtime has no legacy WindowProxy or native-link API path", () => {
  const index = read("src/index.js");
  const sender = read("src/sender.js");
  const receiver = read("src/receiver.js");
  const constants = read("src/constants.js");

  assert.equal(existsSync("src/native-link.js"), false);
  assert.equal(existsSync("schemas/native-link-envelope.schema.json"), false);
  assert.doesNotMatch(index, /OAB_HEADERS|createAnchorHandoff|createReceiver|installReceiver/u);
  assert.doesNotMatch(constants, /browserWindow|nativeLink|browser-window|native-link/u);
  assert.doesNotMatch(sender, /window\.open|rel:\s*["']opener["']/u);
  assert.match(sender, /rel: "noopener noreferrer"/u);
  assert.match(sender, /transport_selection_required/u);
  assert.match(sender, /never chooses or falls back automatically/u);
  assert.doesNotMatch(receiver, /event\.source|event\.origin|window\.opener\.postMessage/u);
  assert.match(receiver, /ambiguous_handoff/u);
  assert.match(receiver, /captureDetachedOfferFromWindow/u);
  assert.match(receiver, /consumeLinkEnvelope/u);
  const types = read("types/index.d.ts");
  assert.match(types, /interface LinkLaunchIndication/u);
  assert.match(
    types,
    /activate\(event: MouseEvent\): Promise<LinkLaunchIndication>/u,
  );
  assert.doesNotMatch(types, /LinkLaunchReceipt/u);
  assert.match(
    types,
    /export const OAB_TRANSPORTS: Readonly<\{[\s\S]*?\}>;/u,
  );
});

test("schemas expose only the two current profiles and tombstone 0.1 messages", () => {
  const declaration = JSON.parse(read("schemas/receiver-declaration.schema.json"));
  const link = JSON.parse(read("schemas/link-envelope.schema.json"));
  const detached = JSON.parse(read("schemas/detached-offer.schema.json"));
  const removedMessages = JSON.parse(read("schemas/protocol-message.schema.json"));

  assert.equal(link.properties.transport.const, "link-envelope/1");
  assert.equal(link.properties.classification.const, "non-confidential");
  assert.equal(detached.properties.transport.const, "detached-datachannel/1");
  assert.ok(detached.required.includes("receiverHelper"));
  assert.ok(detached.required.includes("senderPublicKey"));
  assert.deepEqual(removedMessages.not, {});

  const serializedDeclaration = JSON.stringify(declaration);
  assert.match(serializedDeclaration, /link-envelope\/1/u);
  assert.match(serializedDeclaration, /detached-datachannel\/1/u);
  assert.doesNotMatch(serializedDeclaration, /browser-window\/1|native-link\/1/u);
});

test("reference deployment keeps strict COOP and the deliberate helper referrer exception", () => {
  const server = read("examples/server.mjs");
  const helper = read("examples/receiver/helper.js");
  const callback = read("examples/sender/callback.js");
  const manifest = JSON.parse(read("examples/receiver/manifest.webmanifest"));

  assert.match(server, /"Cross-Origin-Opener-Policy": "same-origin"/u);
  assert.doesNotMatch(server, /unsafe-none/u);
  assert.match(server, /connect-src 'self' https:/u);
  assert.match(
    server,
    /route === "\/examples\/receiver\/helper\.html"[\s\S]*?headers\["Referrer-Policy"\] = "origin"/u,
  );
  assert.match(
    server,
    /route === "\/\.well-known\/open-app-bridge\/callback"/u,
  );
  assert.match(server, /"Referrer-Policy": "no-referrer"/u);
  assert.equal(manifest.icons[0].type, "image/png");
  assert.equal(manifest.icons[0].src, "app-icon.png");
  assert.match(server, /route === "\/examples\/receiver\/app-icon\.png"/u);
  assert.match(helper, /runDetachedReceiverHelper/u);
  assert.match(callback, /runDetachedSenderCallback/u);
});

test("reference receiver CSP authorizes exactly its scrub-first inline bootstrap", () => {
  const receiverHtml = read("examples/receiver/index.html");
  const match = receiverHtml.match(/<script>([\s\S]*?)<\/script>/u);
  assert.ok(match);
  const sourceExpression =
    `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`;
  for (const deployment of [
    read("examples/server.mjs"),
    read("examples/server-configs/nginx.conf"),
    read("examples/server-configs/firebase.json"),
    read("examples/server-configs/netlify-headers.txt"),
  ]) {
    assert.match(deployment, new RegExp(
      sourceExpression.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u",
    ));
  }
  assert.ok(receiverHtml.indexOf("<script>") < receiverHtml.indexOf("<link rel=\"stylesheet\""));
});

test("utility bootstrap scrubs oversized handoffs without retaining the URL", () => {
  const source = read("examples/utility-bootstrap.js");
  assert.ok(
    source.indexOf("scrubbedHandoff = null;") <
    source.indexOf("module.installReceiverHelper(captured)"),
  );
  for (const pathname of [
    "/examples/receiver/helper.html",
    "/.well-known/open-app-bridge/callback",
  ]) {
    let hash = `#oab-detached=${"x".repeat(2 * 1024 * 1024)}`;
    let search = "?forbidden=1";
    let hrefReads = 0;
    let imported = false;
    const status = {
      textContent: "",
      classList: { add() { } },
    };
    const location = {
      pathname,
      get hash() { return hash; },
      get search() { return search; },
      get href() {
        hrefReads += 1;
        throw new Error("oversized handoff must not read the complete URL");
      },
      replace() {
        throw new Error("replace fallback should not be needed");
      },
    };
    const history = {
      state: null,
      replaceState(_state, _title, cleanPath) {
        assert.equal(cleanPath, pathname);
        hash = "";
        search = "";
      },
    };
    const context = {
      TextEncoder,
      location,
      history,
      window: {},
      document: {
        readyState: "complete",
        referrer: "https://sender.example/",
        getElementById() { return status; },
        addEventListener() { },
      },
      console,
      URL,
    };
    runInNewContext(source, context, {
      importModuleDynamically() {
        imported = true;
        return Promise.reject(new Error("oversized input loaded a module"));
      },
    });
    assert.equal(hash, "");
    assert.equal(search, "");
    assert.equal(hrefReads, 0);
    assert.equal(imported, false);
    assert.equal(context.window.__oabUtilityBootstrapActive, undefined);
    assert.match(status.textContent, /security limit/iu);
  }
});

test("deployment templates preserve exact OAB routes and security headers", () => {
  const nginx = read("examples/server-configs/nginx.conf");
  const firebase = JSON.parse(read("examples/server-configs/firebase.json"));
  const netlifyHeaders = read("examples/server-configs/netlify-headers.txt");
  const netlifyRedirects = read("examples/server-configs/netlify-redirects.txt");
  const deploymentReadme = read("examples/server-configs/README.md");
  const exactRoutes = [
    "/.well-known/open-app-bridge",
    "/_oab/detached-helper",
    "/.well-known/open-app-bridge/callback",
    "/_oab/receive",
  ];

  assert.doesNotMatch(nginx, /try_files/u);
  for (const route of exactRoutes) {
    assert.match(nginx, new RegExp(`location = ${route.replaceAll("/", "\\/")}`));
    assert.equal(
      firebase.hosting.rewrites.some((entry) => entry.source === route),
      true,
    );
    assert.match(netlifyRedirects, new RegExp(
      `^${route.replaceAll("/", "\\/")}\\s+`,
      "mu",
    ));
  }
  for (const source of [nginx, netlifyHeaders]) {
    assert.match(source, /Cross-Origin-Opener-Policy["': ]+same-origin/u);
    assert.match(source, /Referrer-Policy["': ]+origin/u);
    assert.match(source, /frame-ancestors 'none'/u);
  }
  assert.match(nginx, /location \^~ \/_oab\/resources\//u);
  assert.match(netlifyHeaders, /^\/_oab\/resources\/\*/mu);
  assert.equal(
    firebase.hosting.headers.some(
      (entry) => entry.source === "/_oab/resources/**",
    ),
    true,
  );
  for (const source of [nginx, netlifyHeaders, JSON.stringify(firebase)]) {
    assert.match(source, /_oab\/resources/u);
  }
  for (const source of [nginx, netlifyHeaders]) {
    assert.match(source, /service worker/iu);
    assert.match(source, /migration/iu);
  }
  assert.match(deploymentReadme, /not a deployable receiver by themselves/iu);
  assert.match(deploymentReadme, /application-supplied/iu);
  assert.match(deploymentReadme, /service-worker fetch handler/iu);
});

test("reference receiver persists only in the explicit Preserve handler", () => {
  const receiver = read("examples/receiver/receiver.js");
  const receiverHtml = read("examples/receiver/index.html");
  const strictApplication = read("examples/receiver/app/app.js");
  const preserveStart = receiver.indexOf(
    'preserveButton.addEventListener("click"',
  );
  const privatePersistCall = receiver.indexOf(
    "await handle.preserve(persistenceTransaction(delivery))",
  );
  const portablePersistCall = receiver.indexOf(
    "await persistPortableDelivery(delivery)",
  );
  const discardStart = receiver.indexOf(
    'discardButton.addEventListener("click"',
  );

  assert.ok(preserveStart >= 0);
  assert.ok(privatePersistCall > preserveStart);
  assert.ok(portablePersistCall > privatePersistCall);
  assert.ok(discardStart > portablePersistCall);
  assert.doesNotMatch(
    receiver.slice(discardStart),
    /persistPortableDelivery|persistenceTransaction\(|indexedDB\.open/u,
  );
  assert.match(receiver, /transaction\.objectStore\("documents"\)\.add\(/u);
  assert.doesNotMatch(receiver, /objectStore\("documents"\)\.put\(/u);
  assert.match(
    receiver,
    /rollback: \(\{ transactionId \}\) => deletePersisted\(transactionId\)/u,
  );
  assert.match(receiver, /commit: \(\{ signal, transactionId \}\)/u);
  assert.match(receiver, /handle\.abort\("receiver_page_closed"\)/u);
  const pagehideStart = receiver.indexOf(
    'window.addEventListener("pagehide"',
  );
  const pagehideCleanup = receiver.indexOf(
    "releaseTransientReceiverState();",
    pagehideStart,
  );
  const pagehideAbort = receiver.indexOf(
    'handle.abort("receiver_page_closed")',
    pagehideStart,
  );
  assert.ok(pagehideStart >= 0);
  assert.ok(pagehideCleanup > pagehideStart);
  assert.ok(pagehideAbort > pagehideCleanup);
  assert.match(
    receiver,
    /handle\.completion\.then[\s\S]*\.catch\(\(error\) => \{[\s\S]*showContentFreeTerminal\(error\)/u,
  );
  assert.match(
    receiver,
    /function releaseTransientReceiverState\(\)[\s\S]*verificationIntent = false;[\s\S]*incomingOrigin\.textContent = "";[\s\S]*delete incomingOrigin\.dataset\.origin;/u,
  );
  assert.doesNotMatch(receiver, /let previewAuthorization|\.consumed\s*=/u);
  const receiverSdk = read("src/receiver.js");
  assert.match(receiverSdk, /createPreviewAuthorizationGrant/u);
  assert.match(receiverSdk, /authorizeManifest: authorizeBoundManifest/u);
  assert.doesNotMatch(receiverHtml, /manifest-consent|Review incoming content/iu);
  assert.match(
    receiver,
    /onCancel = \(\) => \{[\s\S]*cleanupPreparedControls\(true\);[\s\S]*releaseTransientReceiverState\(\)/u,
  );
  assert.match(receiver, /reserveIncomingBytes/u);
  assert.doesNotMatch(read("examples/receiver/index.html"), /sender has been notified/iu);
  assert.doesNotMatch(receiver, /createObjectURL|\.innerHTML/u);
  assert.doesNotMatch(strictApplication, /createObjectURL|\.innerHTML/u);
  assert.match(receiver, /location\.replace\(strictApplicationPath\(batchId\)\)/u);
  assert.match(receiver, /\/examples\/receiver\/app\/document\/\$\{batchId\}/u);
  assert.doesNotMatch(receiver, /#batch=|open-strict-app|transitionCopy/u);
  assert.match(strictApplication, /durableDocumentIdFromCleanRoute/u);
  assert.doesNotMatch(strictApplication, /URLSearchParams/u);
  assert.doesNotMatch(strictApplication, /history\.replaceState|location\.hash\s*=/u);
  assert.ok(receiverHtml.indexOf("<script>") < receiverHtml.indexOf("<link rel=\"stylesheet\""));
  assert.doesNotMatch(receiverHtml, /<script type="module" src="receiver\.js"><\/script>/u);
  assert.doesNotMatch(receiverHtml, /window\.__oab|globalThis\.__oab/u);
  assert.match(receiverHtml, /scrubbedHandoff/u);
});

test("reference receiver admits replay state and pending capacity atomically", () => {
  const receiver = read("examples/receiver/receiver.js");
  assert.match(receiver, /indexedDB\.open\("oab-reference-receiver-security", 4\)/u);
  assert.match(
    receiver,
    /database\.transaction\(\s*\["claims", "leases"\],\s*"readwrite",?\s*\)/u,
  );
  assert.match(receiver, /pendingExpiresAt/u);
  assert.match(receiver, /replayExpiresAt/u);
  assert.match(receiver, /maximumReplayClaims/u);
  assert.match(receiver, /state: "pending"/u);
  assert.match(receiver, /state: "active"/u);
  assert.match(receiver, /promoteAdmissionLease/u);
  assert.match(receiver, /DETACHED_LIFECYCLE_LIMITS\.maximumSessionLifetimeMs/u);
  assert.match(receiver, /DETACHED_SIGNAL_LIMITS\.maximumClockSkewMs/u);
  assert.match(receiver, /record\.state !== "pending"/u);
  assert.match(receiver, /reason: outcome/u);
  assert.match(receiver, /index\("expiresAt"\)\.openCursor/u);
  assert.match(receiver, /legacyRequestId/u);
  assert.match(receiver, /legacyChannelId/u);
  assert.doesNotMatch(receiver, /claims\.clear\(\)|leases\.clear\(\)/u);
  assert.doesNotMatch(receiver, /LRU|senderOrigin.*(?:quota|bucket)/iu);
  assert.match(receiver, /await waitForReceiverForeground/u);
  assert.ok(
    receiver.indexOf("await waitForReceiverForeground") <
    receiver.indexOf("result = consumeIncomingHandoff"),
  );
  const receiverHtml = read("examples/receiver/index.html");
  assert.match(receiverHtml, /temporary page from/iu);
  assert.match(receiverHtml, /never requires a password or payment/iu);
  const detached = read("spec/transports/detached-datachannel-1.0.md");
  assert.match(detached, /MUST NOT create a missing lease/iu);
  assert.match(detached, /re-promote or extend an active lease/iu);
});

test("drop-in widget uses explicit current profiles and stores no shared payload", () => {
  const widget = read("src/share-widget.js");
  const history = read("src/share-widget-history.js");
  const packageManifest = JSON.parse(read("package.json"));

  assert.match(widget, /createLinkAnchorHandoff/u);
  assert.match(widget, /createDetachedAnchorHandoff/u);
  assert.match(widget, /OAB_TRANSPORTS\.linkEnvelope/u);
  assert.match(widget, /OAB_TRANSPORTS\.detachedDataChannel/u);
  assert.match(widget, /discoveryTimeoutMs/u);
  assert.match(widget, /applicationManifestTimeoutMs/u);
  assert.match(widget, /applicationIconTimeoutMs/u);
  assert.match(widget, /active\.activate\(event\)/u);
  assert.match(
    widget,
    /const handoff = await outcome;[\s\S]*transport === OAB_TRANSPORTS\.linkEnvelope[\s\S]*this\._dispatch\("oab-launched"/u,
  );
  assert.doesNotMatch(widget, /createAnchorHandoff|native-link\/1|browser-window\/1/u);
  assert.doesNotMatch(history, /markdown|representation|asset|payload|proof|capability/iu);
  assert.notEqual(packageManifest.private, true);
  assert.equal(packageManifest.publishConfig.access, "public");
  assert.equal(packageManifest.publishConfig.provenance, true);
  assert.equal(packageManifest.exports["./widget"].import, "./dist/oab-widget.js");
  assert.equal(
    packageManifest.exports["./widget/source"].import,
    "./src/share-widget.js",
  );
});

test("all public discovery and display-metadata reads have hard deadlines", () => {
  const limits = read("src/network-deadline.js");
  const discovery = read("src/discovery-document.js");
  const manifest = read("src/application-manifest.js");
  const specification = read("spec/open-app-bridge-1.0.md");

  assert.match(limits, /defaultTimeoutMs: 8000/u);
  assert.match(limits, /maximumTimeoutMs: 30000/u);
  assert.match(limits, /defaultTimeoutMs: 4000/u);
  assert.match(limits, /maximumTimeoutMs: 15000/u);
  assert.match(discovery, /runWithNetworkDeadline/u);
  assert.match(manifest, /application_manifest_timeout/u);
  assert.match(manifest, /application_icon_timeout/u);
  assert.match(specification, /complete well-known discovery[\s\S]*30,000 ms/iu);
  assert.match(specification, /lone UTF-16 high or low[\s\S]*surrogate/iu);
});
