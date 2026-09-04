import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDocument = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const expected = `v${packageDocument.version}`;
if (tag !== expected) {
  throw new Error(`Release tag ${tag || "<missing>"} must equal ${expected}.`);
}
process.stdout.write(`Release tag ${tag} matches the package version.\n`);
