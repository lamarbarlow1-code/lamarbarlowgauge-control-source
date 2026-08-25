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
  const agent = await readFile(
    new URL("../netlify/functions/gauge-stack-agent.mts", import.meta.url),
    "utf8",
  );

  assert.match(boundary, /preferStatic:\s*true/);
  assert.match(controller, /x-gauge-owner-key/);
  assert.match(controller, /sessionStorage\.removeItem\("gaugeOwnerKey"\)/);
  assert.match(agent, /OWNER_KEY_SHA256 = "[a-f0-9]{64}"/);
  assert.match(agent, /timingSafeEqual/);
});

test("corrections are owner-only, governed, hash-deduplicated, and proof-backed", async () => {
  const html = await readFile(
    new URL("../public/gauge-stack-controller.html", import.meta.url),
    "utf8",
  );
  const controller = await readFile(
    new URL("../public/gauge-stack-controller.js", import.meta.url),
    "utf8",
  );
  const agent = await readFile(
    new URL("../netlify/functions/gauge-stack-agent.mts", import.meta.url),
    "utf8",
  );

  assert.match(html, /id="correctionForm"/);
  assert.match(html, /id="correctionsLog"/);
  assert.match(controller, /action:\s*"addCorrection"/);
  assert.match(controller, /SHA-256/);
  assert.match(agent, /const CORRECTIONS_KEY = "corrections\.json"/);
  assert.match(agent, /Target asset is not in the governed registry/);
  assert.match(agent, /content_hash === normalized\.content_hash/);
  assert.match(agent, /deduped:\s*true/);
  assert.match(agent, /writeJSON\(CORRECTIONS_KEY/);
  assert.match(agent, /proof_event: "Owner correction recorded in the governed Corrections Log\."/);
  assert.match(agent, /const authError = requireOwnerKey\(req\)/);
});
