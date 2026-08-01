import crypto from "node:crypto";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function clean(value) {
  return String(value ?? "").trim().slice(0, 10000);
}

async function insert(table, row, supabaseUrl, anonKey) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${table}: ${response.status} ${text}`);
  }

  return text ? JSON.parse(text)[0] : null;
}

export default async function handler(request) {
  if (request.method === "GET") {
    return json(200, {
      ok: true,
      system: "GS&D Gauge Intake",
      status: "online",
      endpoint: "/api/gauge-intake",
      accepts: "POST JSON",
    });
  }

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const anonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return json(503, { ok: false, error: "database_not_configured" });
  }

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object") {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const rawMessage = clean(input.message || input.problem || input.issue || input.need);
  const senderName = clean(input.name || input.customer_name || input.owner);
  const contact = clean(input.email || input.customer_email || input.contact || input.phone);

  if (!rawMessage) {
    return json(400, { ok: false, error: "missing_message", route: "hold" });
  }

  const rawPacket = JSON.stringify(input);
  const hash = crypto.createHash("sha256").update(rawPacket).digest("hex");
  const now = new Date().toISOString();

  try {
    const intake = await insert("intakes", {
      source_channel: "gsd-netlify",
      sender_name: senderName || null,
      contact_method: contact || null,
      signal_timestamp: now,
      raw_message: rawMessage,
      requested_help: clean(input.requested_help || input.service) || null,
      urgency: "normal",
      money_or_service_signal: Boolean(input.payment || input.paid || input.service),
      proof_attached: Boolean(input.proof || input.proof_links || input.attachment),
      notes: `sha256:${hash}\nraw:${rawPacket}`,
      classification: "owner_review",
    }, supabaseUrl, anonKey);

    const proof = await insert("proofs", {
      proof_title: `Intake ${hash.slice(0, 12)}`,
      proof_type: "raw_intake_sha256",
      related_intake_id: intake.id,
      source: "gsd-netlify",
      proof_timestamp: now,
      description: `Preserved raw customer input. SHA-256: ${hash}`,
      custody_note: "Raw input preserved before routing.",
      verification_status: "unchecked",
    }, supabaseUrl, anonKey);

    const route = await insert("routes", {
      subject_kind: "intake",
      subject_id: intake.id,
      route_option: "owner_review",
      next_action: "Owner review before paid diagnostic response.",
    }, supabaseUrl, anonKey);

    const queue = await insert("owner_review_queue", {
      subject_kind: "intake",
      subject_id: intake.id,
      title: senderName ? `${senderName}: ${rawMessage.slice(0, 80)}` : rawMessage.slice(0, 100),
      route_recommendation: "owner_review",
      risk: "unverified customer intake",
      proof_needed: "Review supplied facts and request missing evidence.",
      status: "pending",
      notes: `proof_id:${proof.id}\nroute_id:${route.id}\nsha256:${hash}`,
    }, supabaseUrl, anonKey);

    return json(201, {
      ok: true,
      intake_id: intake.id,
      proof_id: proof.id,
      route_id: route.id,
      queue_id: queue.id,
      sha256: hash,
      route: "owner_review",
      result: "stored",
    });
  } catch (error) {
    console.error(error);
    return json(500, {
      ok: false,
      error: "proof_chain_write_failed",
      fallback: "hold_for_owner_review",
    });
  }
}

export const config = {
  path: ["/api/gauge-intake", "/.netlify/functions/gauge-intake"],
};
