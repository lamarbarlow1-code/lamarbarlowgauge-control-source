import {
  sha256,
  stableStringify,
  verifyIntakeProofRecord,
} from "./gauge-owner-control.js";

export const PAYMENT_LANES = Object.freeze({
  file_reserve_25: Object.freeze({
    label: "$25 file / reserve",
    amount_cents: 2500,
    direct_payment: true,
  }),
  diagnostic_250: Object.freeze({
    label: "$250 diagnostic",
    amount_cents: 25000,
    direct_payment: true,
  }),
  isolated_deployment_2500_plus: Object.freeze({
    label: "$2,500+ isolated deployment",
    amount_cents: 250000,
    direct_payment: false,
  }),
});

export class PaymentProofValidationError extends Error {
  constructor(message, code = "invalid_payment_proof") {
    super(message);
    this.name = "PaymentProofValidationError";
    this.code = code;
  }
}

function clean(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function paymentProofEntry(record, payload) {
  return {
    stage: "payment_submission",
    payload,
    previous_hash: record.proof_head,
    entry_hash: sha256(
      record.proof_head +
      "|" +
      record.ingress_id +
      "|payment_submission|" +
      stableStringify(payload)
    ),
  };
}

export function normalizePublicPaymentProof(input, record) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PaymentProofValidationError("Payment proof is required.");
  }
  if (!record || typeof record !== "object") {
    throw new PaymentProofValidationError("The governed intake record is missing.");
  }

  const proofReference = clean(input.proof_reference, 80).toUpperCase();
  const rawHash = clean(input.raw_hash, 64).toLowerCase();
  const serviceLane = clean(input.service_lane, 80);
  const paymentReference = clean(input.payment_reference, 500);
  const lane = PAYMENT_LANES[serviceLane];

  if (!/^GSD-[A-F0-9]{32}$/.test(proofReference) || proofReference !== record.proof_id) {
    throw new PaymentProofValidationError("Proof reference does not match the governed intake.");
  }
  if (!/^[a-f0-9]{64}$/.test(rawHash) || rawHash !== record.raw_sha256) {
    throw new PaymentProofValidationError("Intake hash does not match the governed intake.");
  }
  if (!lane) {
    throw new PaymentProofValidationError("Service lane is not a governed payment choice.");
  }

  const recordedLane = clean(record.raw_input?.metadata?.service_lane, 80);
  if (recordedLane && recordedLane !== serviceLane) {
    throw new PaymentProofValidationError("Payment lane does not match the original intake.");
  }
  if (!lane.direct_payment) {
    throw new PaymentProofValidationError(
      "Deployment payment requires an owner-confirmed exact amount.",
      "amount_confirmation_required"
    );
  }
  if (paymentReference.length < 3) {
    throw new PaymentProofValidationError("Cash App receipt or transaction reference is required.");
  }

  const normalized = {
    proof_reference: proofReference,
    raw_hash: rawHash,
    service_lane: serviceLane,
    amount_cents: lane.amount_cents,
    amount_label: lane.label,
    payment_reference: paymentReference,
    payment_status: "proof_submitted",
  };

  return {
    ...normalized,
    submission_hash: sha256(normalized),
  };
}

export function applyPublicPaymentProof(record, input, options = {}) {
  if (!verifyIntakeProofRecord(record)) {
    throw new PaymentProofValidationError(
      "Intake proof chain failed verification. No payment proof was written.",
      "proof_chain_failed"
    );
  }

  const normalized = normalizePublicPaymentProof(input, record);
  const existing = record.public_payment_submission;
  if (existing?.submission_hash === normalized.submission_hash) {
    return { record, submission: existing, deduped: true };
  }
  if (existing) {
    throw new PaymentProofValidationError(
      "A payment proof is already attached to this intake. GS&D must verify or correct it.",
      "payment_proof_already_submitted"
    );
  }

  const submittedAt = options.submittedAt || new Date().toISOString();
  const submission = {
    ...normalized,
    submission_id: "PAY-" + normalized.submission_hash.slice(0, 24).toUpperCase(),
    submitted_at: submittedAt,
    verification_state: "owner_verification_required",
  };
  const entry = paymentProofEntry(record, submission);
  const updated = {
    ...record,
    public_payment_submission: submission,
    proof_chain: [...record.proof_chain, entry],
    proof_head: entry.entry_hash,
  };

  if (!verifyIntakeProofRecord(updated)) {
    throw new PaymentProofValidationError(
      "Updated payment proof chain did not verify. No payment proof was written.",
      "proof_chain_failed"
    );
  }

  return { record: updated, submission, deduped: false };
}
