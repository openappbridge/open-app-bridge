import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const archiveArgument = process.argv[2];
if (!archiveArgument) throw new Error("Pass the npm package archive path.");
const archive = resolve(root, archiveArgument);
const release = join(root, "release");
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

for (const name of readdirSync(join(root, "dist"))) {
  if (name === "SHA256SUMS" || name === "SHA384SUMS") continue;
  cpSync(join(root, "dist", name), join(release, name));
}
cpSync(archive, join(release, basename(archive)));

const names = readdirSync(release).sort();
for (const algorithm of ["sha256", "sha384"]) {
  const lines = names.map((name) => {
    const digest = createHash(algorithm)
      .update(readFileSync(join(release, name)))
      .digest("hex");
    return `${digest}  ${name}`;
  });
  writeFileSync(
    join(release, `${algorithm.toUpperCase()}SUMS`),
    `${lines.join("\n")}\n`,
  );
}

process.stdout.write(`Prepared ${names.length} release assets.\n`);
