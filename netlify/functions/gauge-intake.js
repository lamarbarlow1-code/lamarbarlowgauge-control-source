import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "gauge-public-ingress";
const HOSTILE = /\b(ignore (all|the) (rules|instructions)|bypass safeguards|forge proof|fake proof|impersonate owner)\b/i;

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

function clean(value, max = 10000) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    const safeKey = clean(key, 80);
    if (!safeKey) continue;
    if (typeof item === "boolean" || typeof item === "number" || item === null) {
      output[safeKey] = item;
    } else {
      output[safeKey] = clean(item, 4000);
    }
  }
  return output;
}

function stableStringify(value) {
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

function preserveRaw(input) {
  const exact = input.message ?? input.problem ?? input.issue ?? input.need ?? input.text ?? input.body ?? "";
  return {
    source: clean(input.source || "gsd-netlify", 200),
    channel: clean(input.channel || "form", 80),
    name: clean(input.name ?? input.customer_name, 500) || null,
    contact: clean(input.email ?? input.customer_email ?? input.contact ?? input.phone, 1000) || null,
    asset: clean(input.asset ?? input.subject ?? input.operation, 1000) || null,
    exact_wording: String(exact).slice(0, 20000),
    metadata: cleanMetadata(input.metadata),
  };
}

function verifiedOwner(request) {
  const configured = Netlify.env.get("GAUGE_OWNER_KEY");
  const supplied = request.headers.get("x-gauge-owner-key") || "";
  if (!configured || !supplied) return false;
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function classifySource(raw, options = {}) {
  if (!clean(raw.exact_wording)) return "incomplete";
  if (options.duplicate) return "duplicate";
  if (HOSTILE.test(raw.exact_wording)) return "hostile";
  return options.verifiedOwner ? "known_owner" : "unknown_source";
}

export function parseCommand(raw) {
  const exact = clean(raw.exact_wording, 20000);
  const lower = exact.toLowerCase();
  const words = lower.match(/[a-z0-9&'-]+/g) || [];
  const destructiveWords = words.filter((word) =>
    ["delete", "remove", "erase", "wipe", "destroy", "cancel", "close", "revoke", "publish", "send", "file", "pay"].includes(word)
  );

  let intent = "record_only";
  if (/diagnos|symptom|fault|code|inspect|analy[sz]e|verify|trace/.test(lower)) intent = "diagnostic_request";
  else if (/quote|estimate|\bbid\b|price/.test(lower)) intent = "estimate_request";
  else if (/schedule|appointment|\bbook\b/.test(lower)) intent = "schedule_request";
  else if (/\bpay\b|payment|cash app|invoice/.test(lower)) intent = "payment_route";
  else if (/\bbuild\b|deploy|publish|update|\bfix\b|connect|repair|change/.test(lower)) intent = "build_or_change";
  else if (/\bsend\b|email|message|reply|post/.test(lower)) intent = "communication_request";

  const destructive = destructiveWords.length > 0;
  const contradictory = /\b(do not|don't|never)\b.*\b(do|send|publish|delete|pay|file)\b/.test(lower);

  return {
    intent,
    exact_wording: exact,
    destructive,
    destructive_words: destructiveWords,
    contradictory,
  };
}

export function validateCommand(parsed) {
  if (!parsed.exact_wording) return { valid: false, reason: "malformed_command" };
  if (parsed.contradictory) return { valid: false, reason: "contradictory_command" };
  if (parsed.destructive) return { valid: false, reason: "owner_confirmation_required" };
  return { valid: true, reason: null };
}

export function chooseRoute(sourceClass, parsed, validation) {
  if (["unknown_source", "duplicate", "hostile", "incomplete"].includes(sourceClass)) return "hold";
  if (!validation.valid) return validation.reason === "owner_confirmation_required" ? "owner_confirm" : "hold";
  if (parsed.intent === "diagnostic_request") return "diagnostic_intake";
  if (parsed.intent === "estimate_request") return "estimate_intake";
  if (parsed.intent === "schedule_request") return "schedule_hold_for_owner";
  if (parsed.intent === "payment_route") return "payment_gate";
  if (parsed.intent === "build_or_change") return "owner_build_queue";
  if (parsed.intent === "communication_request") return "owner_outbound_queue";
  return "archive_record";
}

function proofEntry(previousHash, ingressId, stage, payload) {
  const payloadJson = stableStringify(payload);
  const entryHash = sha256((previousHash || "GENESIS") + "|" + ingressId + "|" + stage + "|" + payloadJson);
  return {
    stage,
    payload,
    previous_hash: previousHash,
    entry_hash: entryHash,
  };
}

export function createProofRecord(input, options = {}) {
  const raw = preserveRaw(input);
  const rawHash = sha256(raw);
  const ingressId = "IN-" + rawHash.slice(0, 24).toUpperCase();
  const proofId = "GSD-" + rawHash.slice(0, 32).toUpperCase();
  const sourceCheck = classifySource(raw, options);
  const parsed = parseCommand(raw);
  const validation = validateCommand(parsed);
  const chosenRoute = chooseRoute(sourceCheck, parsed, validation);
  const accepted = !["hold", "owner_confirm"].includes(chosenRoute);
  const result = chosenRoute === "hold"
    ? "paused_no_external_action"
    : chosenRoute === "owner_confirm"
      ? "paused_owner_confirmation_required"
      : "accepted_for_single_route";
  const receivedAt = options.receivedAt || new Date().toISOString();

  const ingressProof = proofEntry(null, ingressId, "ingress", {
    raw_sha256: rawHash,
    source: raw.source,
    source_check: sourceCheck,
    received_at: receivedAt,
  });
  const decisionProof = proofEntry(ingressProof.entry_hash, ingressId, "decision", {
    parsed_command: parsed,
    command_validation: validation,
    chosen_route: chosenRoute,
    result,
  });

  return {
    schema_version: "gauge-public-proof-v1",
    ingress_id: ingressId,
    proof_id: proofId,
    received_at: receivedAt,
    raw_input: raw,
    raw_sha256: rawHash,
    source_check: sourceCheck,
    parsed_command: parsed,
    command_validation: validation,
    chosen_route: chosenRoute,
    route_lock: "one_input_one_route",
    result,
    fallback: accepted ? "queue_route_if_down_preserve_proof" : "hold_for_owner_review",
    proof_chain: [ingressProof, decisionProof],
    proof_head: decisionProof.entry_hash,
  };
}

export function verifyProofRecord(record) {
  let previousHash = null;
  for (const entry of record.proof_chain || []) {
    if (entry.previous_hash !== previousHash) return false;
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

function publicSummary(record, extra = {}) {
  return {
    ok: true,
    system: "Gauge governed intake",
    version: "2.1-public-adapter",
    proof_reference: record.proof_id,
    ingress_reference: record.ingress_id,
    raw_hash: record.raw_sha256,
    source_check: record.source_check,
    route: record.chosen_route,
    result: record.result,
    fallback: record.fallback,
    proof_head: record.proof_head,
    ...extra,
  };
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export default async function handler(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    try {
      await store().get("_health");
      const body = {
        ok: true,
        system: "Gauge governed intake",
        version: "2.1-public-adapter",
        status: "online",
        storage: "reachable",
        endpoint: "/api/gauge-intake",
        accepts: ["text", "email", "form", "screenshot_reference"],
      };
      return request.method === "HEAD" ? new Response(null, { status: 200 }) : json(200, body);
    } catch {
      return request.method === "HEAD"
        ? new Response(null, { status: 503 })
        : json(503, { ok: false, error: "proof_storage_unreachable", result: "paused_no_external_action", fallback: "netlify_form_hold" });
    }
  }

  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 500000) return json(413, { ok: false, error: "payload_too_large", fallback: "netlify_form_hold" });

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return json(400, { ok: false, error: "invalid_json", fallback: "netlify_form_hold" });
  }

  const proofRecord = createProofRecord(input, { verifiedOwner: verifiedOwner(request) });
  if (!clean(proofRecord.raw_input.exact_wording)) {
    return json(400, {
      ok: false,
      source_check: "incomplete",
      route: "hold",
      result: "paused_no_external_action",
      fallback: "netlify_form_hold",
    });
  }

  const dryRun = input.dry_run === true || new URL(request.url).searchParams.get("dry_run") === "1";
  if (dryRun) return json(200, publicSummary(proofRecord, { dry_run: true, persisted: false }));

  const key = "records/" + proofRecord.raw_sha256 + ".json";
  try {
    const existing = await store().get(key, { type: "json" });
    if (existing) {
      const duplicateRecord = {
        ...existing,
        source_check: "duplicate",
        chosen_route: "hold",
        result: "paused_no_external_action",
        fallback: "existing_proof_record",
      };
      return json(200, publicSummary(duplicateRecord, { duplicate: true, persisted: true }));
    }

    await store().setJSON(key, proofRecord);
    const verified = await store().get(key, { type: "json" });
    if (!verified || verified.proof_head !== proofRecord.proof_head) {
      return json(503, {
        ok: false,
        error: "proof_write_not_verified",
        result: "paused_no_external_action",
        fallback: "netlify_form_hold",
      });
    }

    return json(201, publicSummary(proofRecord, { duplicate: false, persisted: true }));
  } catch (error) {
    console.error("Gauge proof storage failed", error);
    return json(503, {
      ok: false,
      error: "proof_storage_failed",
      result: "paused_no_external_action",
      fallback: "netlify_form_hold",
    });
  }
}

export const config = {
  path: "/api/gauge-intake",
};
