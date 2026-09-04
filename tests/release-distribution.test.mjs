import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseEnvironment } from "../scripts/assert-release-environment.mjs";

const validEnvironment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_NAME: "v1.0.0",
  GITHUB_WORKFLOW_REF:
    "openappbridge/open-app-bridge/.github/workflows/release.yml@refs/tags/v1.0.0",
};

test("release publication guard accepts only the exact tagged workflow", () => {
  assert.equal(assertReleaseEnvironment(validEnvironment), true);
  for (const key of Object.keys(validEnvironment)) {
    assert.throws(
      () => assertReleaseEnvironment({ ...validEnvironment, [key]: "wrong" }),
      /npm publication is allowed only/u,
    );
  }
  assert.throws(
    () => assertReleaseEnvironment({}),
    /npm publication is allowed only/u,
  );
});
