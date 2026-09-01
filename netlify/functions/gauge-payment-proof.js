import { getStore } from "@netlify/blobs";
import { verifyIntakeProofRecord } from "../lib/gauge-owner-control.js";
import {
  applyPublicPaymentProof,
  PaymentProofValidationError,
} from "../lib/gauge-payment-proof.js";

const STORE_NAME = "gauge-public-ingress";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function publicResult(update) {
  return {
    ok: true,
    proof_reference: update.submission.proof_reference,
    payment_status: "proof_submitted",
    verification_state: "owner_verification_required",
    submission_reference: update.submission.submission_id,
    deduped: update.deduped,
    persisted: true,
  };
}

export default async function handler(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    const body = {
      ok: true,
      system: "Gauge payment-proof ingress",
      status: "online",
      endpoint: "/api/gauge-payment-proof",
    };
    return request.method === "HEAD" ? new Response(null, { status: 200 }) : json(200, body);
  }

  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 50000) return json(413, { ok: false, error: "payload_too_large" });

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const rawHash = String(input.raw_hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(rawHash)) {
    return json(400, { ok: false, error: "invalid_intake_hash" });
  }

  const recordKey = "records/" + rawHash + ".json";
  try {
    const ingress = store();
    const snapshot = await ingress.getWithMetadata(recordKey, { type: "json" });
    if (!snapshot?.data) return json(404, { ok: false, error: "intake_not_found" });
    if (!snapshot.etag) return json(409, { ok: false, error: "intake_version_unavailable" });

    const update = applyPublicPaymentProof(snapshot.data, input);
    if (update.deduped) return json(200, publicResult(update));

    const write = await ingress.setJSON(recordKey, update.record, { onlyIfMatch: snapshot.etag });
    if (!write.modified) {
      return json(409, { ok: false, error: "intake_changed_reload_payment" });
    }

    const verified = await ingress.get(recordKey, { type: "json" });
    if (
      !verified ||
      verified.proof_head !== update.record.proof_head ||
      !verifyIntakeProofRecord(verified)
    ) {
      return json(503, { ok: false, error: "payment_proof_write_not_verified" });
    }

    return json(201, publicResult(update));
  } catch (error) {
    if (error instanceof PaymentProofValidationError) {
      const status = error.code === "payment_proof_already_submitted" ? 409 : 400;
      return json(status, { ok: false, error: error.code, message: error.message });
    }
    console.error("Gauge payment proof storage failed", error);
    return json(503, { ok: false, error: "payment_proof_storage_failed" });
  }
}

export const config = {
  path: "/api/gauge-payment-proof",
};
