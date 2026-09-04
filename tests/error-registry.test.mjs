import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  OAB_ERROR_CODES,
  OAB_WIRE_ABORT_REASONS,
  isOabErrorCode,
  isOabWireAbortReason,
  toSafeErrorPresentation,
} from "../src/index.js";

test("every literal runtime error code is registered and the registry is stable", () => {
  assert.deepEqual(OAB_ERROR_CODES, [...new Set(OAB_ERROR_CODES)].sort());
  const literalCodes = new Set();
  for (const filename of readdirSync("src").filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(`src/${filename}`, "utf8");
    for (const pattern of [
      /new OabError\(\s*["']([^"']+)["']/gu,
      /asOabError\([^,]+,\s*["']([^"']+)["']/gu,
      /(?:code|tooLargeCode):\s*["']([^"']+)["']/gu,
    ]) {
      for (const match of source.matchAll(pattern)) literalCodes.add(match[1]);
    }
  }
  for (const code of literalCodes) {
    assert.equal(isOabErrorCode(code), true, `Unregistered runtime code: ${code}`);
  }
  for (const generated of [
    "authorize_manifest_required",
    "authorize_origin_required",
    "claim_detached_offer_required",
    "on_preview_required",
    "reserve_incoming_bytes_required",
  ]) {
    assert.equal(isOabErrorCode(generated), true);
  }
});

test("safe error presentations preserve codes without reflecting raw messages", () => {
  const unsafe = "sender-controlled secret must never be shown";
  const presentation = toSafeErrorPresentation({
    code: "detached_receiver_referrer_missing",
    message: unsafe,
  });
  assert.deepEqual(presentation, {
    category: "unable_to_verify",
    message: "We couldn’t verify where this share came from. Nothing was saved.",
    technicalCode: "detached_receiver_referrer_missing",
  });
  assert.equal(presentation.message.includes(unsafe), false);
  assert.equal(Object.isFrozen(presentation), true);

  assert.deepEqual(toSafeErrorPresentation(new Error(unsafe)), {
    category: "unable_to_receive",
    message:
      "We couldn’t prepare this shared content. Nothing was saved. You can return to the sending app and try again.",
    technicalCode: null,
  });
});

test("wire abort reasons are a closed non-diagnostic vocabulary", () => {
  assert.deepEqual(
    OAB_WIRE_ABORT_REASONS,
    [...new Set(OAB_WIRE_ABORT_REASONS)].sort(),
  );
  const schema = JSON.parse(readFileSync("schemas/detached-control.schema.json"));
  assert.deepEqual(schema.$defs.abort.properties.reason.enum, OAB_WIRE_ABORT_REASONS);
  for (const reason of OAB_WIRE_ABORT_REASONS) {
    assert.equal(isOabWireAbortReason(reason), true);
  }
  for (const unsafe of [
    "receiver.example",
    "secret_title",
    "detached_disposition_timeout",
    "well_formed_but_unregistered",
  ]) {
    assert.equal(isOabWireAbortReason(unsafe), false);
  }
});
