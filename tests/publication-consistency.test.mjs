import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(path, "utf8");
}

test("package metadata and published support files remain self-consistent", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));

  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  for (const entry of ["docs", "spec", "examples", "SECURITY.md"]) {
    assert.ok(
      packageJson.files.includes(entry),
      `${entry} is referenced by packaged documentation or scripts`,
    );
  }
});

test("detached public API matches discovery and runtime behavior", () => {
  const signaling = read("src/detached-signaling.js");
  const index = read("src/index.js");
  const types = read("types/index.d.ts");

  assert.doesNotMatch(signaling, /DETACHED_HELPER_PATH/u);
  assert.doesNotMatch(index, /DETACHED_HELPER_PATH/u);
  assert.doesNotMatch(types, /DETACHED_HELPER_PATH/u);
  assert.match(types, /readonly channel: RTCDataChannel \| null;/u);
});

test("detached integration documentation names real, security-complete APIs", () => {
  const api = read("docs/api-reference.md");
  const sender = read("docs/sender-integration.md");
  const receiver = read("docs/receiver-integration.md");
  const senderRuntime = read("src/sender.js");

  assert.doesNotMatch(api, /parseDetachedOfferFromWindow/u);
  assert.match(api, /captureDetachedOfferFromWindow/u);
  assert.match(api, /inspectCapturedDetachedOffer/u);
  assert.match(api, /navigateToCallback\(href, senderOrigin\)/u);
  assert.match(api, /prepareDetachedTransfer\(content, options\)`/u);
  assert.match(api, /decodeLinkEnvelopeFragment\(fragment, options\)`/u);
  assert.match(api, /receiveTransfer\(options\)/u);
  assert.match(api, /sendTransfer\(preparedTransfer, options\?\)/u);
  assert.match(receiver, /navigateToCallback\(callbackHref, accepted\.offer\.senderOrigin\)/u);
  assert.doesNotMatch(sender, /randomUUID/u);
  assert.match(sender, /createDetachedAnchorHandoff/u);
  assert.match(sender, /handoff\.bind\(sendLink\)/u);
  assert.match(senderRuntime, /transferId: options\.transferId \?\? randomToken\(32\)/u);
});

test("the removed-message tombstone does not confuse package and wire versions", () => {
  const tombstone = JSON.parse(read("schemas/protocol-message.schema.json"));

  assert.deepEqual(tombstone.not, {});
  assert.doesNotMatch(tombstone.$comment, /0\.2 wire artifact/iu);
  assert.match(tombstone.$comment, /profile-specific schemas/iu);
});

test("publication CI gates real launch evidence across all browser engines", () => {
  const workflow = read(".github/workflows/ci.yml");
  const playwright = read("playwright.config.mjs");
  const browserTests = read("tests/browser/oab-browser.spec.mjs");

  assert.match(workflow, /npm run test:browser/u);
  assert.match(workflow, /playwright install --with-deps chromium firefox webkit/u);
  for (const engine of ["chromium", "firefox", "webkit"]) {
    assert.match(
      playwright,
      new RegExp(`name: ["']${engine}["']`),
    );
  }
  assert.match(browserTests, /context\.waitForEvent\("page"\)/u);
  assert.match(browserTests, /request\.isNavigationRequest\(\)/u);
  assert.match(browserTests, /window\.__oabLaunchAudit\.phase = "microtask"/u);
  assert.match(browserTests, /window\.__oabLaunchAudit\.phase = "later-task"/u);
  assert.match(browserTests, /clickTrusted: true/u);
  assert.match(browserTests, /widget\.remove\(\)/u);
  assert.match(browserTests, /receiptAvailable: false/u);
  assert.match(browserTests, /preparedSenderHref/u);
  assert.match(browserTests, /preparedVerifyHref/u);
  assert.match(browserTests, /callbackRequest\.frame\(\)\.page\(\)/u);
  assert.match(browserTests, /detachedTargets/u);
  assert.match(browserTests, /historical service worker migrates/u);
  assert.match(browserTests, /oab-test-sw-phase/u);
  assert.match(browserTests, /discoveryStatus: "disabled"/u);
  assert.match(browserTests, /x-oab-test-network-phase/u);
  assert.match(browserTests, /workerSource/u);
});
