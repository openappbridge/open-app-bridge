import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OAB_WIRE_ABORT_REASONS } from "../src/wire-abort-reasons.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDirectory = join(repositoryRoot, "schemas");
const canonicalIdPattern =
  "^(?:[A-Za-z0-9_-]{24}(?:[A-Za-z0-9_-]{4}){0,26}|" +
  "[A-Za-z0-9_-]{21}(?:[A-Za-z0-9_-]{4}){0,26}[AQgw]|" +
  "[A-Za-z0-9_-]{22}(?:[A-Za-z0-9_-]{4}){0,26}" +
  "[AEIMQUYcgkosw048])$";

function readSchema(name) {
  return JSON.parse(readFileSync(join(schemasDirectory, name), "utf8"));
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const item of Object.values(value)) visit(item, callback);
}

test("all published schema documents parse, identify themselves, and resolve local refs", () => {
  const files = readdirSync(schemasDirectory)
    .filter((name) => name.endsWith(".schema.json"));
  const schemas = new Map(files.map((file) => [file, readSchema(file)]));
  const ids = new Set();
  for (const [file, schema] of schemas) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(typeof schema.$id, "string", `${file} must have an ID`);
    assert(!ids.has(schema.$id), `${schema.$id} must be unique`);
    ids.add(schema.$id);
  }
  for (const [file, schema] of schemas) {
    visit(schema, (value) => {
      if (typeof value.$ref !== "string" || value.$ref.startsWith("#")) return;
      const target = value.$ref.split("#", 1)[0];
      if (target.startsWith("urn:")) {
        assert(ids.has(target), `${file} has an unresolved schema ID ${value.$ref}`);
        return;
      }
      assert(
        files.includes(basename(target)),
        `${file} has an unresolved local schema ref ${value.$ref}`,
      );
    });
  }
});

test("all OAB protocol-bearing schemas require the canonical protocol identifier", () => {
  const files = readdirSync(schemasDirectory)
    .filter((name) => name.endsWith(".schema.json"));
  for (const file of files) {
    const schema = readSchema(file);
    const protocol = schema.properties?.protocol;
    if (!protocol) continue;
    assert.deepEqual(
      protocol,
      { const: "org.openapp.bridge" },
      `${file} must accept only the canonical OAB protocol identifier`,
    );
  }
});

test("the 0.2 schema surface contains only the explicit link and detached profiles", () => {
  const activeFiles = [
    "receiver-declaration.schema.json",
    "link-envelope.schema.json",
    "delivery.schema.json",
    "detached-offer.schema.json",
    "detached-answer.schema.json",
    "detached-transcript.schema.json",
    "detached-sealed-plaintext.schema.json",
    "detached-sealed-answer.schema.json",
    "detached-callback.schema.json",
    "detached-helper.schema.json",
    "detached-capabilities.schema.json",
    "detached-manifest.schema.json",
    "detached-control.schema.json",
    "detached-delivery.schema.json",
  ];
  const source = activeFiles
    .map((name) => readFileSync(join(schemasDirectory, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /browser-window|native-link|WindowProxy|sessionCapability/u);
  assert.match(source, /link-envelope\/1/u);
  assert.match(source, /detached-datachannel\/1/u);

  const deprecated = readSchema("protocol-message.schema.json");
  assert.deepEqual(deprecated.not, {});
  assert.match(deprecated.$id, /deprecated/u);
});

test("schema hard limits and canonical random identifiers match the wire contract", () => {
  const declaration = readSchema("receiver-declaration.schema.json");
  const detached = declaration.$defs.detachedDataChannel;
  assert.equal(
    detached.properties.limits.properties.maximumTransferBytes.maximum,
    33554432,
  );
  assert.equal(detached.properties.limits.properties.maximumAssets.maximum, 256);
  assert.equal(
    detached.properties.limits.properties.maximumSignalingBytes.maximum,
    32768,
  );
  assert.equal(
    detached.properties.limits.properties.maximumSignalingBytes.minimum,
    1024,
  );
  assert.equal(
    detached.properties.limits.properties.maximumFrameBytes.maximum,
    16384,
  );
  assert.equal(
    detached.properties.limits.properties.maximumFrameBytes.minimum,
    17,
  );

  const helper = readSchema("detached-helper.schema.json");
  assert.equal(helper.$defs.requestId.pattern, canonicalIdPattern);
  assert.equal(
    helper.$defs.channelId.pattern,
    "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
  );
  const control = readSchema("detached-control.schema.json");
  assert.equal(control.$defs.transferId.pattern, canonicalIdPattern);
  assert.equal(
    control.$defs.digest.pattern,
    "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
  );
  assert.deepEqual(
    control.$defs.abort.properties.reason.enum,
    OAB_WIRE_ABORT_REASONS,
  );

  const delivery = readSchema("detached-delivery.schema.json");
  assert(delivery.required.includes("dispositionExpiresAt"));
  assert.equal(delivery.properties.dispositionExpiresAt.type, "integer");
  assert.equal(
    delivery.properties.dispositionExpiresAt.maximum,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(delivery.properties.representations.minProperties, undefined);
  assert.equal(delivery.anyOf[0].properties.representations.minProperties, 1);
  assert.equal(delivery.anyOf[1].properties.assets.minItems, 1);
  assert.equal(
    delivery.properties.representations.additionalProperties.pattern,
    "^[^\\u0000]+$",
  );

  const linkDelivery = readSchema("delivery.schema.json");
  assert(linkDelivery.required.includes("title"));

  const id = new RegExp(canonicalIdPattern, "u");
  assert(id.test("A".repeat(22)));
  assert(id.test("A".repeat(23)));
  assert(id.test("B".repeat(24)));
  assert(id.test("A".repeat(126)));
  assert(id.test("A".repeat(127)));
  assert(id.test("B".repeat(128)));
  assert(!id.test(`${"A".repeat(21)}B`));
  assert(!id.test("A".repeat(25)));
  assert(!id.test("A".repeat(129)));
});
