import assert from "node:assert/strict";
import test from "node:test";

import {
  PreparedContent,
  allowOrigin,
  assertContentMatchesReceiver,
  blockOrigin,
  evaluateSender,
  normalizeSenderPolicy,
  prepareContent,
} from "../src/index.js";
import { makeReceiver } from "./helpers.mjs";

test("prepares equivalent text representations and safe binary assets", () => {
  const content = prepareContent({
    title: " Portable note ",
    markdown: "# Portable note",
    html: "<h1>Portable note</h1>",
    text: "Portable note",
    assets: [
      {
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        data: new Blob(["<svg></svg>"], { type: "image/svg+xml" }),
      },
    ],
  });

  assert.equal(content.title, "Portable note");
  assert.deepEqual(content.representationTypes, [
    "text/markdown",
    "text/html",
    "text/plain",
  ]);
  assert.equal(content.assets[0].name, "diagram.svg");
  assert.equal(content.assets[0].size, 11);
  assert.equal(content.totalBytes, content.textBytes + 11);
});

test("supports explicitly negotiated canonical text media types", () => {
  const content = prepareContent({
    representations: {
      "application/json": '{"answer":42}',
    },
  }, {
    representations: ["application/json"],
    assetTypes: [],
    maximumAssets: 0,
  });
  assert.deepEqual(content.representationTypes, ["application/json"]);
  assert.equal(content.representations["application/json"], '{"answer":42}');
});

test("prepared content and receiver declarations cannot be forged", () => {
  assert.throws(() => new PreparedContent({}), TypeError);
  assert.throws(
    () => assertContentMatchesReceiver(
      Object.create(PreparedContent.prototype),
      makeReceiver(),
    ),
    (error) => error.code === "content_not_prepared",
  );
});

test("rejects path-bearing, executable, and MIME-confused assets", () => {
  const invalid = [
    { name: "../image.png", mimeType: "image/png" },
    { name: "payload.exe", mimeType: "application/octet-stream" },
    { name: "image.png", mimeType: "image/svg+xml" },
  ];
  for (const asset of invalid) {
    assert.throws(
      () =>
        prepareContent({
          assets: [{ ...asset, data: new Blob(["x"]) }],
        }),
      (error) =>
        ["invalid_asset", "unsupported_asset", "asset_type_mismatch"].includes(
          error.code,
        ),
    );
  }
});

test("block rules override allow rules for canonical origins", () => {
  let policy = normalizeSenderPolicy({ unknownSenders: "deny" });
  policy = allowOrigin(policy, "https://Research.Example/");
  const verified = {
    origin: "https://research.example",
    originVerified: true,
  };
  assert.equal(evaluateSender(policy, verified), "allow");
  assert.equal(evaluateSender(policy, {
    origin: "https://research.example",
    originVerified: false,
  }), "ask");
  policy = blockOrigin(policy, "https://research.example");
  assert.equal(evaluateSender(policy, verified), "block");
  assert.equal(evaluateSender(policy, {
    origin: "https://unknown.example",
    originVerified: true,
  }), "deny");
});
