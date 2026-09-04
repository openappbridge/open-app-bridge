import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function assertReleaseEnvironment(environment = process.env) {
  const packageDocument = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const expectedTag = `v${packageDocument.version}`;
  const failures = [];
  if (environment.GITHUB_ACTIONS !== "true") failures.push("GitHub Actions");
  if (environment.GITHUB_EVENT_NAME !== "push") failures.push("a tag push event");
  if (environment.GITHUB_REF_TYPE !== "tag") failures.push("a tag ref");
  if (environment.GITHUB_REF_NAME !== expectedTag) failures.push(expectedTag);
  if (
    !environment.GITHUB_WORKFLOW_REF?.includes(
      "/.github/workflows/release.yml@",
    )
  ) {
    failures.push("the release.yml workflow");
  }
  if (failures.length > 0) {
    throw new Error(
      `npm publication is allowed only from ${failures.join(", ")}.`,
    );
  }
  return true;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  assertReleaseEnvironment();
  process.stdout.write("Release publication environment verified.\n");
}
