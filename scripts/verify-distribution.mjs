import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildScript = join(root, "scripts/build-distribution.mjs");
const temporaryRoot = mkdtempSync(join(tmpdir(), "oab-dist-verify-"));
const first = join(temporaryRoot, "first");
const second = join(temporaryRoot, "second");

function buildAt(path) {
  const result = spawnSync(
    process.execPath,
    [buildScript, `--outdir=${path}`],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Distribution build failed.");
  }
}

function snapshot(path) {
  return new Map(
    readdirSync(path)
      .sort()
      .map((name) => [name, readFileSync(join(path, name))]),
  );
}

try {
  buildAt(first);
  buildAt(second);
  const expected = snapshot(first);
  const actual = snapshot(second);
  if (expected.size !== actual.size) {
    throw new Error("Repeated builds produced different artifact counts.");
  }
  for (const [name, bytes] of expected) {
    const other = actual.get(name);
    if (!other || !bytes.equals(other)) {
      throw new Error(`Repeated builds differ at ${name}.`);
    }
  }
  process.stdout.write(
    `Distribution reproducibility verified for ${expected.size} files.\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
