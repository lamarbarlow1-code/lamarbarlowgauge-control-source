import crypto from "node:crypto";

export const INTAKE_ROUTES = [
  "hold",
  "diagnostic_intake",
  "estimate_intake",
  "schedule_hold_for_owner",
  "payment_gate",
  "owner_build_queue",
  "owner_outbound_queue",
  "archive_record",
];

export const INTAKE_STATES = ["held", "ready", "active", "complete"];
export const SERVICE_LANES = [
  "file_reserve_25",
  "diagnostic_250",
  "isolated_deployment_2500_plus",
  "custom_review",
];
export const PAYMENT_STATES = ["not_required", "unpaid", "proof_submitted", "paid"];

export class IntakeValidationError extends Error {}

function clean(value, maxLength = 2000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}

export function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

function proofEntry(previousHash, ingressId, stage, payload) {
  const payloadJson = stableStringify(payload);
  return {
    stage,
    payload,
    previous_hash: previousHash,
    entry_hash: sha256((previousHash || "GENESIS") + "|" + ingressId + "|" + stage + "|" + payloadJson),
  };
}

export function verifyIntakeProofRecord(record) {
  if (!record || typeof record !== "object" || !record.ingress_id) return false;
  if (!record.raw_input || sha256(record.raw_input) !== record.raw_sha256) return false;
  if (record.proof_chain?.[0]?.payload?.raw_sha256 !== record.raw_sha256) return false;

  let previousHash = null;
  for (const entry of record.proof_chain || []) {
    if (!entry || entry.previous_hash !== previousHash) return false;
    const expected = sha256(
      (previousHash || "GENESIS") +
      "|" +
      record.ingress_id +
      "|" +
      entry.stage +
      "|" +
      stableStringify(entry.payload)
    );
    if (entry.entry_hash !== expected) return false;
    previousHash = entry.entry_hash;
  }

  return Boolean(previousHash) && record.proof_head === previousHash;
}

function requiredChoice(value, label, choices) {
  const normalized = clean(value, 100);
  if (!choices.includes(normalized)) {
    throw new IntakeValidationError(`${label} is not a governed choice.`);
  }
  return normalized;
}

function requiredText(value, label, maxLength) {
  const normalized = clean(value, maxLength);
  if (!normalized) throw new IntakeValidationError(`${label} is required.`);
  return normalized;
}

function optionalText(value, maxLength) {
  return clean(value, maxLength) || null;
}

export function normalizeIntakeUpdate(input, record) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new IntakeValidationError("Owner intake decision is required.");
  }
  if (!record || typeof record !== "object") {
    throw new IntakeValidationError("The governed intake record is missing.");
  }

  const proof_id = requiredText(input.proof_id, "Proof reference", 80);
  if (proof_id !== record.proof_id) {
    throw new IntakeValidationError("Proof reference does not match the governed record.");
  }

  const normalized = {
    proof_id,
    route: requiredChoice(input.route, "Route", INTAKE_ROUTES),
    state: requiredChoice(input.state, "Work state", INTAKE_STATES),
    service_lane: requiredChoice(input.service_lane, "Service lane", SERVICE_LANES),
    payment_status: requiredChoice(input.payment_status, "Payment status", PAYMENT_STATES),
    payment_reference: optionalText(input.payment_reference, 500),
    owner_note: requiredText(input.owner_note, "Owner decision note", 2000),
  };

  if (normalized.payment_status === "paid" && !normalized.payment_reference) {
    throw new IntakeValidationError("Payment proof or reference is required before marking an intake paid.");
  }
  if (normalized.state === "complete" && normalized.route === "hold") {
    throw new IntakeValidationError("A held intake cannot be marked complete.");
  }

  return {
    ...normalized,
    decision_hash: sha256(normalized),
  };
}

export function applyOwnerControl(record, input, options = {}) {
  if (!verifyIntakeProofRecord(record)) {
    throw new IntakeValidationError("Proof chain failed verification. No owner change was written.");
  }

  const decision = normalizeIntakeUpdate(input, record);
  if (record.owner_control?.decision_hash === decision.decision_hash) {
    return { record, decision, deduped: true };
  }

  const updatedAt = options.updatedAt || new Date().toISOString();
  const eventPayload = {
    event_id: "OWNER-" + decision.decision_hash.slice(0, 24).toUpperCase(),
    source_verified: true,
    route: decision.route,
    state: decision.state,
    service_lane: decision.service_lane,
    payment_status: decision.payment_status,
    payment_reference: decision.payment_reference,
    owner_note: decision.owner_note,
    decision_hash: decision.decision_hash,
    updated_at: updatedAt,
  };
  const entry = proofEntry(record.proof_head, record.ingress_id, "owner_control", eventPayload);
  const updated = {
    ...record,
    owner_control: eventPayload,
    proof_chain: [...record.proof_chain, entry],
    proof_head: entry.entry_hash,
  };

  if (!verifyIntakeProofRecord(updated)) {
    throw new IntakeValidationError("Updated proof chain did not verify. No owner change was written.");
  }

  return { record: updated, decision, deduped: false };
}
