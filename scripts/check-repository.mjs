import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDuplicateJsonMembers } from "../src/discovery-document.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  "README.md",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "DISTRIBUTION.md",
  "GOVERNANCE.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "COMPATIBILITY.md",
  "docs/api-reference.md",
  "docs/architecture.md",
  "docs/error-codes.md",
  "docs/human-interaction-contract.md",
  "docs/inert-preview-contract.md",
  "docs/interoperability-checklist.md",
  "docs/receiver-integration.md",
  "docs/security-privacy-questionnaire.md",
  "docs/sender-integration.md",
  "docs/share-widget.md",
  "docs/threat-model.md",
  "docs/utility-page-lifecycle.md",
  "spec/open-app-bridge-1.0.md",
  "spec/transports/link-envelope-1.0.md",
  "spec/transports/detached-datachannel-1.0.md",
  "schemas/receiver-declaration.schema.json",
  "schemas/link-envelope.schema.json",
  "schemas/delivery.schema.json",
  "schemas/detached-offer.schema.json",
  "schemas/detached-answer.schema.json",
  "schemas/detached-transcript.schema.json",
  "schemas/detached-sealed-plaintext.schema.json",
  "schemas/detached-sealed-answer.schema.json",
  "schemas/detached-helper.schema.json",
  "schemas/detached-callback.schema.json",
  "schemas/detached-capabilities.schema.json",
  "schemas/detached-manifest.schema.json",
  "schemas/detached-control.schema.json",
  "schemas/detached-delivery.schema.json",
  "src/index.js",
  "src/error-codes.js",
  "src/network-deadline.js",
  "src/wire-abort-reasons.js",
  "src/discovery-document.js",
  "src/link-envelope.js",
  "src/detached-crypto.js",
  "src/detached-signaling.js",
  "src/detached-callback.js",
  "src/detached-framing.js",
  "src/detached-transport.js",
  "src/sender.js",
  "src/receiver.js",
  "types/index.d.ts",
  "examples/sender/index.html",
  "examples/sender/callback.html",
  "examples/sender/callback.js",
  "examples/utility-bootstrap.js",
  "examples/receiver/index.html",
  "examples/receiver/helper.html",
  "examples/receiver/helper.js",
  "examples/receiver/app/index.html",
  "examples/widget/index.html",
  "examples/server-configs/netlify-redirects.txt",
  "examples/server-configs/README.md",
  "tests/fixtures/active-content-attacks.json",
  "tests/browser/oab-browser.spec.mjs",
  "playwright.config.mjs",
  "src/share-widget.js",
  "src/share-widget-history.js",
  "src/share-widget.css",
  "types/widget.d.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "scripts/build-distribution.mjs",
  "scripts/verify-distribution.mjs",
  "scripts/test-distribution.mjs",
  "scripts/prepare-release-assets.mjs",
  "scripts/verify-release-tag.mjs",
  "scripts/assert-release-environment.mjs",
];

const failures = [];
for (const relative of required) {
  if (!existsSync(join(root, relative))) failures.push(`Missing ${relative}`);
}

function filesBelow(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    if ([".git", "dist", "node_modules", "release"].includes(name)) continue;
    if (name.endsWith(".tgz") || name === "package-result.json") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) result.push(...filesBelow(path));
    else result.push(path);
  }
  return result;
}

const files = filesBelow(root);
for (const path of files.filter((value) => value.endsWith(".json"))) {
  try {
    const source = readFileSync(path, "utf8");
    assertNoDuplicateJsonMembers(source);
    JSON.parse(source);
  } catch (error) {
    failures.push(`Invalid JSON ${path.slice(root.length + 1)}: ${error.message}`);
  }
}

const markdownLink = /\[[^\]]+\]\(([^)]+)\)/gu;
for (const path of files.filter((value) => value.endsWith(".md"))) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(markdownLink)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/u.test(target)) continue;
    const resolved = normalize(join(dirname(path), decodeURIComponent(target)));
    if (!existsSync(resolved)) {
      failures.push(
        `Broken link in ${path.slice(root.length + 1)}: ${match[1]}`,
      );
    }
  }
}

const retiredBrandForms = [
  ["Open", "Content", "Bridge"].join(" "),
  ["open", "content", "bridge"].join("-"),
  ["open", "content", "bridge"].join("_"),
  ["Open", "Content", "Bridge"].join(""),
  ["open", "Content", "Bridge"].join(""),
  ["org", "opencontent", "bridge"].join("."),
  ["O", "C", "B"].join(""),
  ["O", "c", "b"].join(""),
  ["o", "c", "b"].join(""),
];
for (const path of files) {
  const relative = path.slice(root.length + 1);
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const source = bytes.toString("utf8");
  for (const retired of retiredBrandForms) {
    if (relative.includes(retired) || source.includes(retired)) {
      failures.push(`Retired protocol branding remains in ${relative}.`);
      break;
    }
  }
}

const receiverSource = readFileSync(join(root, "src/receiver.js"), "utf8");
if (/postMessage\([^\n]+,\s*["']\*["']/u.test(receiverSource)) {
  failures.push("Receiver responses must never use wildcard target origins.");
}
if (receiverSource.includes("innerHTML")) {
  failures.push("The reference receiver must not render incoming innerHTML.");
}

const activeRuntime = [
  "src/constants.js",
  "src/discovery-document.js",
  "src/link-envelope.js",
  "src/detached-signaling.js",
  "src/detached-callback.js",
  "src/detached-transport.js",
  "src/sender.js",
  "src/receiver.js",
  "src/share-widget.js",
].map((relative) => readFileSync(join(root, relative), "utf8")).join("\n");
if (/browser-window\/1|native-link\/1/u.test(activeRuntime)) {
  failures.push("Active runtime code must not retain removed transport identifiers.");
}
if (/window\.open\s*\(/u.test(activeRuntime)) {
  failures.push("OAB launches must use trusted native anchors, not window.open().");
}
if (/rel:\s*["'](?!noopener noreferrer)/u.test(
  readFileSync(join(root, "src/sender.js"), "utf8"),
)) {
  failures.push("Every sender launch must use noopener noreferrer.");
}

const packageDocument = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageDocument.private === true) {
  failures.push("The official SDK package must not be marked private.");
}
if (
  packageDocument.publishConfig?.access !== "public" ||
  packageDocument.publishConfig?.provenance !== true
) {
  failures.push("The npm package must require public access and provenance.");
}
if (packageDocument.devDependencies?.esbuild !== "0.28.2") {
  failures.push("The distribution bundler must remain exactly pinned.");
}
if (packageDocument.scripts?.prepublishOnly !== "node scripts/assert-release-environment.mjs") {
  failures.push("npm publication must retain the release-workflow-only guard.");
}
if (!readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/u).includes("dist/")) {
  failures.push("Generated dist artifacts must remain excluded from Git.");
}
for (const removed of [
  "src/native-link.js",
  "schemas/native-link-envelope.schema.json",
]) {
  if (existsSync(join(root, removed))) {
    failures.push(`Removed legacy artifact is still present: ${removed}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Repository check passed: ${files.length} public files verified.\n`,
  );
}
