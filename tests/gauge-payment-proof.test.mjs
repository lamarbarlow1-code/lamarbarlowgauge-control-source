import assert from "node:assert/strict";
import test from "node:test";

import { createProofRecord } from "../netlify/functions/gauge-intake.js";
import {
  applyPublicPaymentProof,
  PaymentProofValidationError,
} from "../netlify/lib/gauge-payment-proof.js";
import { verifyIntakeProofRecord } from "../netlify/lib/gauge-owner-control.js";

const receivedAt = "2026-09-01T00:00:00.000Z";
const submittedAt = "2026-09-01T00:05:00.000Z";

function intake(serviceLane = "diagnostic_250") {
  return createProofRecord({
    source: "public-gauge-intake",
    name: "Payment Test",
    contact: "payment@example.test",
    asset: "Blocked sales route",
    message: "Diagnose the payment handoff and preserve the original wording.",
    metadata: { service_lane: serviceLane },
  }, { receivedAt });
}

function paymentInput(record, overrides = {}) {
  return {
    proof_reference: record.proof_id,
    raw_hash: record.raw_sha256,
    service_lane: record.raw_input.metadata.service_lane,
    payment_reference: "CASHAPP-RECEIPT-515",
    ...overrides,
  };
}

test("public payment proof appends to the original verified proof chain", () => {
  const record = intake();
  const update = applyPublicPaymentProof(record, paymentInput(record), { submittedAt });

  assert.equal(update.deduped, false);
  assert.equal(update.record.raw_input.exact_wording, record.raw_input.exact_wording);
  assert.equal(update.record.public_payment_submission.payment_status, "proof_submitted");
  assert.equal(update.record.public_payment_submission.amount_cents, 25000);
  assert.equal(update.record.public_payment_submission.verification_state, "owner_verification_required");
  assert.equal(update.record.proof_chain.length, record.proof_chain.length + 1);
  assert.equal(update.record.proof_chain.at(-1).stage, "payment_submission");
  assert.equal(verifyIntakeProofRecord(update.record), true);
});

test("identical payment proof dedupes without a second proof event", () => {
  const record = intake();
  const first = applyPublicPaymentProof(record, paymentInput(record), { submittedAt });
  const second = applyPublicPaymentProof(first.record, paymentInput(record), { submittedAt: "2026-09-01T00:06:00.000Z" });

  assert.equal(second.deduped, true);
  assert.equal(second.record.proof_chain.length, first.record.proof_chain.length);
  assert.equal(second.record.proof_head, first.record.proof_head);
});

test("payment lane must match the original governed intake", () => {
  const record = intake("file_reserve_25");

  assert.throws(
    () => applyPublicPaymentProof(record, paymentInput(record, { service_lane: "diagnostic_250" })),
    (error) => error instanceof PaymentProofValidationError && /does not match/.test(error.message),
  );
});

test("deployment cannot be paid before the exact amount is confirmed", () => {
  const record = intake("isolated_deployment_2500_plus");

  assert.throws(
    () => applyPublicPaymentProof(record, paymentInput(record)),
    (error) => error instanceof PaymentProofValidationError && error.code === "amount_confirmation_required",
  );
});

test("a different public payment proof cannot overwrite the first submission", () => {
  const record = intake();
  const first = applyPublicPaymentProof(record, paymentInput(record), { submittedAt });

  assert.throws(
    () => applyPublicPaymentProof(first.record, paymentInput(record, { payment_reference: "DIFFERENT-RECEIPT" })),
    (error) => error instanceof PaymentProofValidationError && error.code === "payment_proof_already_submitted",
  );
});

test("tampered intake blocks a public payment proof write", () => {
  const record = intake();
  const input = paymentInput(record);
  record.raw_input.exact_wording = "tampered";

  assert.throws(
    () => applyPublicPaymentProof(record, input),
    (error) => error instanceof PaymentProofValidationError && error.code === "proof_chain_failed",
  );
});
