import crypto from "node:crypto";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function clean(value, max = 10000) {
  return String(value ?? "").trim().slice(0, max);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function preserveRaw(input) {
  const exact = input.message ?? input.problem ?? input.issue ?? input.need ?? input.text ?? input.body ?? "";
  return {
    source: input.source ?? input.source_channel ?? "gsd-netlify",
    channel: input.channel ?? "form",
    owner: input.owner ?? null,
    name: input.name ?? input.customer_name ?? null,
    contact: input.email ?? input.customer_email ?? input.contact ?? input.phone ?? null,
    exact_wording: String(exact),
    screenshot: input.screenshot ?? input.attachment ?? input.proof ?? null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

function classifySource(raw, input, duplicate) {
  if (!clean(raw.exact_wording)) return "incomplete";
  if (duplicate) return "duplicate";

  const explicit = clean(input.source_class || raw.metadata?.source_class, 64).toLowerCase();
  if (["known_owner", "unknown_source", "duplicate", "hostile", "incomplete"].includes(explicit)) return explicit;
  if (clean(input.risk || raw.metadata?.risk, 64).toLowerCase() === "hostile") return "hostile";

  const owner = clean(raw.owner, 200).toLowerCase();
  const source = clean(raw.source, 200).toLowerCase();
  const knownOwner = owner.includes("lamar") || source.includes("lamar") || source.includes("master-control") || source.includes("known-owner");
  return knownOwner ? "known_owner" : "unknown_source";
}

function parseCommand(raw) {
  const exact = clean(raw.exact_wording);
  const lower = exact.toLowerCase();
  const words = lower.match(/[a-z0-9&'-]+/g) || [];
  const destructiveWords = words.filter((w) => ["delete", "remove", "erase", "wipe", "destroy", "cancel", "close", "revoke"].includes(w));

  let intent = "record_only";
  if (/diagnos|symptom|fault|code/.test(lower)) intent = "diagnostic_request";
  else if (/quote|estimate|\bbid\b|price/.test(lower)) intent = "estimate_request";
  else if (/schedule|appointment|\bbook\b/.test(lower)) intent = "schedule_request";
  else if (/\bpay\b|payment|cash app|invoice/.test(lower)) intent = "payment_route";
  else if (/\bbuild\b|deploy|publish|update|\bfix\b|connect/.test(lower)) intent = "build_or_change";

  const destructive = destructiveWords.length > 0;
  const contradictory = destructive && /(keep|preserve|do not delete|don't delete|nothing gets deleted)/.test(lower);

  return {
    intent,
    exact_wording: exact,
    destructive,
    destructive_words: destructiveWords,
    contradictory,
  };
}

function validateCommand(parsed) {
  if (!parsed.exact_wording) return { valid: false, reason: "malformed_command" };
  if (parsed.contradictory) return { valid: false, reason: "contradictory_command" };
  if (parsed.destructive) return { valid: false, reason: "owner_confirmation_required" };
  return { valid: true, reason: null };
}

function chooseRoute(sourceClass, parsed, validation) {
  if (["unknown_source", "duplicate", "hostile", "incomplete"].includes(sourceClass)) return "hold";
  if (!validation.valid) return validation.reason === "owner_confirmation_required" ? "owner_confirm" : "hold";

  if (parsed.intent === "diagnostic_request") return "diagnostic_intake";
  if (parsed.intent === "estimate_request") return "estimate_intake";
  if (parsed.intent === "schedule_request") return "schedule_hold_for_owner";
  if (parsed.intent === "payment_route") return "payment_gate";
  if (parsed.intent === "build_or_change") return "owner_build_queue";
  return "archive_record";
}

async function apiRequest(method, path, body, supabaseUrl, anonKey, prefer = "return=representation") {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function findProofByHash(hash, supabaseUrl, anonKey) {
  const title = encodeURIComponent(`Gauge Raw ${hash}`);
  const rows = await apiRequest("GET", `proofs?proof_title=eq.${title}&select=id,proof_title&limit=1`, undefined, supabaseUrl, anonKey);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function insert(table, row, supabaseUrl, anonKey) {
  const rows = await apiRequest("POST", table, row, supabaseUrl, anonKey);
  return Array.isArray(rows) ? rows[0] : rows;
}

export default async function handler(request) {
  if (request.method === "GET") {
    return json(200, {
      ok: true,
      system: "Gauge AI Control Kernel",
      version: "2.0-bombproof",
      status: "online",
      endpoint: "/api/gauge-intake",
      accepts: ["text", "email", "form", "screenshot"],
    });
  }

  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const anonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) return json(503, { ok: false, error: "database_not_configured", fallback: "hold" });

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object") return json(400, { ok: false, error: "invalid_json", fallback: "hold" });

  const raw = preserveRaw(input);
  if (!clean(raw.exact_wording)) return json(400, { ok: false, source_check: "incomplete", route: "hold", result: "paused_no_external_action" });

  const hashPayload = { ...raw, received_at: undefined };
  const hash = sha256(hashPayload);
  const now = new Date().toISOString();

  try {
    const existingProof = await findProofByHash(hash, supabaseUrl, anonKey);
    const sourceCheck = classifySource(raw, input, Boolean(existingProof));
    const parsed = parseCommand(raw);
    const validation = validateCommand(parsed);
    const chosenRoute = chooseRoute(sourceCheck, parsed, validation);
    const accepted = !["hold", "owner_confirm"].includes(chosenRoute);
    const result = chosenRoute === "hold" ? "paused_no_external_action" : chosenRoute === "owner_confirm" ? "paused_owner_confirmation_required" : "accepted_for_single_route";

    if (sourceCheck === "duplicate") {
      return json(200, {
        ok: true,
        system: "Gauge AI Control Kernel",
        version: "2.0-bombproof",
        proof_chain: { raw_input: raw, raw_hash: hash, source_check: sourceCheck, parsed_command: parsed, command_validation: validation, chosen_route: "hold", route_lock: "one_input_one_route", result, fallback: "existing_proof_record" },
        existing_proof_id: existingProof.id,
      });
    }

    const intake = await insert("intakes", {
      source_channel: clean(raw.channel || raw.source, 200),
      sender_name: clean(raw.name, 500) || null,
      contact_method: clean(raw.contact, 1000) || null,
      signal_timestamp: now,
      raw_message: raw.exact_wording,
      requested_help: parsed.intent,
      urgency: clean(input.urgency, 100) || "normal",
      money_or_service_signal: parsed.intent === "payment_route" || Boolean(input.payment || input.paid || input.service),
      proof_attached: Boolean(raw.screenshot),
      notes: `sha256:${hash}\nraw:${stableStringify(raw)}\nvalidation:${stableStringify(validation)}`,
      classification: sourceCheck,
    }, supabaseUrl, anonKey);

    const proof = await insert("proofs", {
      proof_title: `Gauge Raw ${hash}`,
      proof_type: "raw_input_sha256",
      related_intake_id: intake.id,
      source: clean(raw.source, 200),
      proof_timestamp: now,
      description: `Raw input preserved. SHA-256: ${hash}`,
      custody_note: `source=${sourceCheck}; intent=${parsed.intent}; route=${chosenRoute}; result=${result}`,
      verification_status: accepted ? "unchecked" : "held",
    }, supabaseUrl, anonKey);

    const route = await insert("routes", {
      subject_kind: "intake",
      subject_id: intake.id,
      route_option: chosenRoute,
      next_action: accepted ? `Execute only route: ${chosenRoute}.` : chosenRoute === "owner_confirm" ? "Owner confirmation required before destructive action." : "Hold. Owner review required before any external action.",
    }, supabaseUrl, anonKey);

    let queue = null;
    if (!accepted || chosenRoute === "schedule_hold_for_owner" || chosenRoute === "owner_build_queue") {
      queue = await insert("owner_review_queue", {
        subject_kind: "intake",
        subject_id: intake.id,
        title: clean(raw.name, 300) ? `${clean(raw.name, 300)}: ${clean(raw.exact_wording, 80)}` : clean(raw.exact_wording, 100),
        route_recommendation: chosenRoute,
        risk: sourceCheck === "known_owner" ? validation.reason || "owner route" : sourceCheck,
        proof_needed: sourceCheck === "known_owner" ? "Proof before execution if action changes external state." : "Verify source and proof before execution.",
        status: "pending",
        notes: `proof_id:${proof.id}\nroute_id:${route.id}\nsha256:${hash}`,
      }, supabaseUrl, anonKey);
    }

    return json(201, {
      ok: true,
      system: "Gauge AI Control Kernel",
      version: "2.0-bombproof",
      proof_chain: {
        raw_input: raw,
        raw_hash: hash,
        source_check: sourceCheck,
        parsed_command: parsed,
        command_validation: validation,
        chosen_route: chosenRoute,
        route_lock: "one_input_one_route",
        result,
        fallback: accepted ? "queue_route_if_down_preserve_proof" : "hold_for_owner_review",
      },
      ids: { intake_id: intake.id, proof_id: proof.id, route_id: route.id, queue_id: queue?.id || null },
    });
  } catch (error) {
    console.error(error);
    return json(500, { ok: false, error: "proof_chain_write_failed", result: "paused_no_external_action", fallback: "hold_for_owner_review" });
  }
}

export const config = {
  path: ["/api/gauge-intake", "/.netlify/functions/gauge-intake"],
};
