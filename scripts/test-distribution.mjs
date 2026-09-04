import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

for (const [name, expected] of Object.entries(manifest.artifacts)) {
  const bytes = readFileSync(join(dist, name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha384 = createHash("sha384").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  if (
    bytes.byteLength !== expected.bytes ||
    sha256 !== expected.sha256 ||
    sha384 !== expected.sha384 ||
    sri !== expected.sri
  ) {
    throw new Error(`Distribution manifest does not match ${name}.`);
  }
}

const core = await import(`${pathToFileURL(join(dist, "oab.js")).href}?verify=1`);
for (const expectedExport of [
  "createHandoff",
  "discoverReceiver",
  "consumeIncomingHandoff",
  "prepareContent",
]) {
  if (typeof core[expectedExport] !== "function") {
    throw new Error(`The standalone core is missing ${expectedExport}.`);
  }
}

const widget = readFileSync(join(dist, "oab-widget.min.js"), "utf8");
const cssSri = manifest.artifacts["oab-widget.css"].sri;
if (!widget.includes("oab-widget.css") || !widget.includes(cssSri)) {
  throw new Error("The widget bundle does not pin its companion stylesheet.");
}
if (
  readFileSync(join(dist, "oab-widget.min.js")).byteLength >=
  readFileSync(join(dist, "oab-widget.js")).byteLength
) {
  throw new Error("The minified widget is not smaller than the readable bundle.");
}

process.stdout.write(
  `Distribution contract passed for ${Object.keys(manifest.artifacts).length} artifacts.\n`,
);
