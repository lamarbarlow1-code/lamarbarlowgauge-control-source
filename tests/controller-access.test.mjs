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

  const controllerRoute = await readFile(
    new URL("../dist/controller/index.html", import.meta.url),
    "utf8",
  );
  assert.match(controllerRoute, /Gauge Master Control/);

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

test("public ingress is connected to owner routing on the same proof record", async () => {
  const html = await readFile(new URL("../public/gauge-stack-controller.html", import.meta.url), "utf8");
  const controller = await readFile(new URL("../public/gauge-stack-controller.js", import.meta.url), "utf8");
  const agent = await readFile(new URL("../netlify/functions/gauge-stack-agent.mts", import.meta.url), "utf8");
  const ownerControl = await readFile(new URL("../netlify/functions/gauge-owner-control.js", import.meta.url), "utf8");

  assert.match(html, /id="intakeQueue"/);
  assert.match(html, /id="intakeDecisionForm"/);
  assert.match(controller, /action:\s*"updateIntake"/);
  assert.match(agent, /const INGRESS_STORE_NAME = "gauge-public-ingress"/);
  assert.match(agent, /readPublicIntakes\(\)/);
  assert.match(agent, /onlyIfMatch: snapshot\.etag/);
  assert.match(ownerControl, /proof_chain: \[\.\.\.record\.proof_chain, entry\]/);
  assert.match(ownerControl, /sha256\(record\.raw_input\) !== record\.raw_sha256/);
});

test("master control uses the locked GS&D logo and black, chrome, gunmetal, steel, red palette", async () => {
  const publicHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const controllerHtml = await readFile(new URL("../public/gauge-stack-controller.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/gauge-stack-controller.css", import.meta.url), "utf8");

  assert.match(publicHtml, /src="data:image\/jpeg;base64,/);
  assert.match(controllerHtml, /src="data:image\/jpeg;base64,/);
  assert.match(css, /--black:\s*#000000/);
  assert.match(css, /--gunmetal:\s*#343438/);
  assert.match(css, /--steel:\s*#807e80/);
  assert.match(css, /--chrome:\s*#cdc9c9/);
  assert.match(css, /--red:\s*#d91c1c/);
  assert.doesNotMatch(css, /#0b0f14|#141b24|#223044|#405269|#9fd1ff/i);
});
