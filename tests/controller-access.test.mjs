import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controllerAssets = [
  "gauge-stack-controller.html",
  "gauge-stack-controller.css",
  "gauge-stack-controller.js",
];

test("build ships the owner controller shell without exposing the protected API", async () => {
  for (const asset of controllerAssets) {
    const output = await readFile(new URL(`../dist/${asset}`, import.meta.url), "utf8");
    assert.ok(output.length > 0, `${asset} should be present in dist`);
  }

  const boundary = await readFile(
    new URL("../netlify/functions/private-boundary.mts", import.meta.url),
    "utf8",
  );
  const controller = await readFile(
    new URL("../public/gauge-stack-controller.js", import.meta.url),
    "utf8",
  );

  assert.match(boundary, /preferStatic:\s*true/);
  assert.match(controller, /x-gauge-owner-key/);
  assert.match(controller, /sessionStorage\.removeItem\("gaugeOwnerKey"\)/);
});
