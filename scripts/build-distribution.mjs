import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requestedOutdir = process.argv.find((value) => value.startsWith("--outdir="));
const outdir = requestedOutdir
  ? resolve(root, requestedOutdir.slice("--outdir=".length))
  : join(root, "dist");
const packageDocument = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const licenseBanner =
  `/*! Open App Bridge v${packageDocument.version} | Apache-2.0 | ` +
  "https://openappbridge.org */";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const sourceCss = readFileSync(join(root, "src/share-widget.css"), "utf8");
const cssResult = await transform(sourceCss, {
  loader: "css",
  minify: true,
  legalComments: "none",
});
const widgetCss = `${licenseBanner}\n${cssResult.code.trim()}\n`;
const stylesheetFile = "oab-widget.css";
writeFileSync(join(outdir, stylesheetFile), widgetCss);
const stylesheetIntegrity = `sha384-${createHash("sha384")
  .update(widgetCss)
  .digest("base64")}`;

function widgetDistributionPlugin() {
  const widgetPath = join(root, "src/share-widget.js");
  return {
    name: "oab-widget-distribution",
    setup(builder) {
      builder.onLoad({ filter: /share-widget\.js$/ }, (args) => {
        if (resolve(args.path) !== widgetPath) return null;
        const source = readFileSync(args.path, "utf8")
          .replace(
            /const WIDGET_STYLESHEET_URL = new URL\([\s\S]*?\)\.href;/u,
            `const WIDGET_STYLESHEET_URL = new URL("./${stylesheetFile}", import.meta.url).href;`,
          )
          .replace(
            'const WIDGET_STYLESHEET_INTEGRITY = "";',
            `const WIDGET_STYLESHEET_INTEGRITY = ${JSON.stringify(stylesheetIntegrity)};`,
          );
        return {
          contents: source,
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

async function bundle(entryPoint, outputName, { minify = false, plugins = [] } = {}) {
  await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile: join(outdir, outputName),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["es2022"],
    charset: "utf8",
    minify,
    sourcemap: "linked",
    sourcesContent: true,
    legalComments: "none",
    treeShaking: true,
    banner: { js: licenseBanner },
    plugins,
    logLevel: "silent",
  });
}

await bundle("src/index.js", "oab.js");
await bundle("src/index.js", "oab.min.js", { minify: true });
await bundle("src/share-widget.js", "oab-widget.js", {
  plugins: [widgetDistributionPlugin()],
});
await bundle("src/share-widget.js", "oab-widget.min.js", {
  minify: true,
  plugins: [widgetDistributionPlugin()],
});

const bundleArtifactNames = [
  "oab.js",
  "oab.js.map",
  "oab.min.js",
  "oab.min.js.map",
  "oab-widget.css",
  "oab-widget.js",
  "oab-widget.js.map",
  "oab-widget.min.js",
  "oab-widget.min.js.map",
].sort();

function digest(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

const artifacts = {};
for (const name of bundleArtifactNames) {
  const bytes = readFileSync(join(outdir, name));
  artifacts[name] = {
    bytes: bytes.byteLength,
    sha256: digest(bytes, "sha256"),
    sha384: digest(bytes, "sha384"),
    sri: `sha384-${digest(bytes, "sha384", "base64")}`,
  };
}

const widgetSri = artifacts["oab-widget.min.js"].sri;
writeFileSync(
  join(outdir, "INTEGRATION.md"),
  `# Open App Bridge ${packageDocument.version} release integration\n\n` +
    "## npm (recommended)\n\n" +
    "```sh\n" +
    `npm install --save-exact ${packageDocument.name}@${packageDocument.version}\n` +
    "```\n\n" +
    "```js\n" +
    'import "open-app-bridge/widget";\n' +
    "```\n\n" +
    "## Exact-version CDN sender widget\n\n" +
    "```html\n" +
    `<script type="module" src="https://cdn.jsdelivr.net/npm/${packageDocument.name}@${packageDocument.version}/dist/oab-widget.min.js" integrity="${widgetSri}" crossorigin="anonymous"></script>\n` +
    "```\n\n" +
    "The bundled module loads `oab-widget.css` beside itself and verifies that " +
    `stylesheet with ${stylesheetIntegrity}. Receiver and restricted utility ` +
    "Documents must self-host their complete first-party resource graph.\n",
);

const artifactNames = [...bundleArtifactNames, "INTEGRATION.md"].sort();
const integrationBytes = readFileSync(join(outdir, "INTEGRATION.md"));
artifacts["INTEGRATION.md"] = {
  bytes: integrationBytes.byteLength,
  sha256: digest(integrationBytes, "sha256"),
  sha384: digest(integrationBytes, "sha384"),
  sri: `sha384-${digest(integrationBytes, "sha384", "base64")}`,
};

const manifest = {
  package: packageDocument.name,
  sdkVersion: packageDocument.version,
  wireVersions: ["1.0"],
  artifacts,
};
writeFileSync(
  join(outdir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const checksumNames = [...artifactNames, "manifest.json"].sort();
for (const algorithm of ["sha256", "sha384"]) {
  const lines = checksumNames.map((name) => {
    const bytes = readFileSync(join(outdir, name));
    return `${digest(bytes, algorithm)}  ${basename(name)}`;
  });
  writeFileSync(
    join(outdir, `${algorithm.toUpperCase()}SUMS`),
    `${lines.join("\n")}\n`,
  );
}

process.stdout.write(
  `Built ${artifactNames.length} deterministic OAB artifacts in ${outdir}.\n`,
);
