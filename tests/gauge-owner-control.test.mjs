import assert from "node:assert/strict";
import test from "node:test";

import { createProofRecord } from "../netlify/functions/gauge-intake.js";
import {
  applyOwnerControl,
  IntakeValidationError,
  verifyIntakeProofRecord,
} from "../netlify/lib/gauge-owner-control.js";

const receivedAt = "2026-08-26T01:00:00.000Z";
const updatedAt = "2026-08-26T02:00:00.000Z";

function publicRecord() {
  return createProofRecord({
    source: "public-gauge-intake",
    name: "Connected Queue Test",
    contact: "owner-queue@example.test",
    asset: "Public to private control",
    message: "Diagnose the stopped intake and preserve the exact proof.",
    metadata: { service_lane: "diagnostic_250" },
  }, { receivedAt });
}

function ownerDecision(record) {
  return {
    record_key: `records/${record.raw_sha256}.json`,
    proof_id: record.proof_id,
    route: "diagnostic_intake",
    state: "ready",
    service_lane: "diagnostic_250",
    payment_status: "paid",
    payment_reference: "CASHAPP-PROOF-515",
    owner_note: "Source verified by owner. Route one controlled diagnostic and preserve the result.",
  };
}

test("owner routing appends to the original public proof chain", () => {
  const original = publicRecord();
  const originalRaw = structuredClone(original.raw_input);
  const update = applyOwnerControl(original, ownerDecision(original), { updatedAt });

  assert.equal(update.deduped, false);
  assert.deepEqual(update.record.raw_input, originalRaw);
  assert.equal(update.record.chosen_route, "hold");
  assert.equal(update.record.owner_control.route, "diagnostic_intake");
  assert.equal(update.record.owner_control.state, "ready");
  assert.equal(update.record.proof_chain.length, original.proof_chain.length + 1);
  assert.equal(update.record.proof_chain.at(-1).stage, "owner_control");
  assert.equal(verifyIntakeProofRecord(update.record), true);
});

test("identical owner decisions dedupe without adding proof events", () => {
  const original = publicRecord();
  const first = applyOwnerControl(original, ownerDecision(original), { updatedAt });
  const second = applyOwnerControl(first.record, ownerDecision(original), { updatedAt: "2026-08-26T03:00:00.000Z" });

  assert.equal(second.deduped, true);
  assert.equal(second.record.proof_chain.length, first.record.proof_chain.length);
  assert.equal(second.record.proof_head, first.record.proof_head);
});

test("paid state requires a payment proof reference", () => {
  const original = publicRecord();
  const decision = { ...ownerDecision(original), payment_reference: "" };

  assert.throws(
    () => applyOwnerControl(original, decision, { updatedAt }),
    (error) => error instanceof IntakeValidationError && /Payment proof/.test(error.message),
  );
});

test("tampered public proof is blocked from owner routing", () => {
  const original = publicRecord();
  original.raw_input.exact_wording = "tampered after ingress";

  assert.throws(
    () => applyOwnerControl(original, ownerDecision(original), { updatedAt }),
    (error) => error instanceof IntakeValidationError && /failed verification/.test(error.message),
  );
});
