import { createHash } from "node:crypto";

export type GaugeSourceClass = "known owner" | "unknown source" | "duplicate" | "hostile" | "incomplete";
export type GaugeIntent = "destructive" | "payment" | "diagnostic" | "build" | "document" | "customer" | "unknown";
export type GaugeParsedCommand = { intent: GaugeIntent; destructive: boolean; malformed: boolean; contradictory: boolean };
export type GaugeDecision = { raw_input: string; raw_sha256: string; source_class: GaugeSourceClass; parsed_command: GaugeParsedCommand; chosen_route: string; execution_allowed: boolean; result: string; fallback: string | null };

export const GAUGE_SEALED_LOOP = Object.freeze({
  name: "Gauge",
  owner: "Lamar / Gauge Systems & Diagnostics",
  invariants: [
    "Truth is established from evidence, not title, status, money, identity, popularity, or persuasion.",
    "Proof must remain attached to the truth claim that it supports.",
    "Every action and claim retains an attributable source.",
    "Custody of the record cannot be silently transferred, erased, flattened, or rewritten.",
    "Unknown or conflicting evidence produces HOLD, never invented certainty.",
    "A loop is not closed because someone says it is closed; closure requires proof of the terminal state."
  ]
});

export function hashRaw(raw: string) { return createHash("sha256").update(raw, "utf8").digest("hex"); }

export function classifyIntent(raw: string): GaugeIntent {
  const s = raw.toLowerCase();
  if (/\b(delete|erase|destroy|remove|overwrite|wipe|purge|drop)\b/.test(s)) return "destructive";
  if (/\b(pay|payment|invoice|charge|checkout|cash|stripe)\b/.test(s)) return "payment";
  if (/\b(diagnos|fault|code|symptom|repair|equipment|vehicle|machine)\b/.test(s)) return "diagnostic";
  if (/\b(build|deploy|code|site|website|api|route|function|agent|system)\b/.test(s)) return "build";
  if (/\b(document|policy|contract|proof|record|file|packet)\b/.test(s)) return "document";
  if (/\b(customer|reply|message|email|intake|form)\b/.test(s)) return "customer";
  return "unknown";
}

export function parseCommand(raw: string): GaugeParsedCommand {
  const intent = classifyIntent(raw);
  const s = raw.toLowerCase();
  const saysDelete = /\b(delete|erase|remove|wipe|purge)\b/.test(s);
  const saysKeep = /\b(do not delete|don't delete|keep everything|everything stays|preserve)\b/.test(s);
  return { intent, destructive: intent === "destructive", malformed: !raw.trim(), contradictory: saysDelete && saysKeep };
}

export function routeFor(intent: GaugeIntent) {
  return ({ destructive: "owner_confirmation_hold", payment: "payment_gate", diagnostic: "diagnostic_ticket", build: "master_control_build", document: "proof_document_route", customer: "customer_route", unknown: "active_hold" } as Record<GaugeIntent, string>)[intent];
}

export function decide(raw: string, source: GaugeSourceClass, duplicate = false): GaugeDecision {
  const parsed = parseCommand(raw);
  const raw_sha256 = hashRaw(raw);
  if (duplicate) return { raw_input: raw, raw_sha256, source_class: "duplicate", parsed_command: parsed, chosen_route: "duplicate_hold", execution_allowed: false, result: "Duplicate detected before send. No second execution permitted.", fallback: "Use the existing proof record and route result." };
  if (parsed.malformed) return { raw_input: raw, raw_sha256, source_class: "incomplete", parsed_command: parsed, chosen_route: "input_hold", execution_allowed: false, result: "Malformed or empty command held. No execution permitted.", fallback: "Require complete owner input." };
  if (parsed.contradictory) return { raw_input: raw, raw_sha256, source_class: source, parsed_command: parsed, chosen_route: "contradiction_hold", execution_allowed: false, result: "Contradictory command held. No execution permitted.", fallback: "Require owner resolution of the contradiction." };
  if (source !== "known owner") return { raw_input: raw, raw_sha256, source_class: source, parsed_command: parsed, chosen_route: "source_hold", execution_allowed: false, result: `Source classified as ${source}. Input preserved; no execution permitted.`, fallback: "Owner review required before release." };
  if (parsed.destructive) return { raw_input: raw, raw_sha256, source_class: source, parsed_command: parsed, chosen_route: "owner_confirmation_hold", execution_allowed: false, result: "Destructive action detected. Command preserved and held.", fallback: "Explicit owner confirmation required before destructive execution." };
  if (parsed.intent === "unknown") return { raw_input: raw, raw_sha256, source_class: source, parsed_command: parsed, chosen_route: "active_hold", execution_allowed: false, result: "Intent not proven. Command preserved and held.", fallback: "Owner clarification required." };
  return { raw_input: raw, raw_sha256, source_class: source, parsed_command: parsed, chosen_route: routeFor(parsed.intent), execution_allowed: true, result: "Command validated and assigned to exactly one route.", fallback: null };
}

export const GAUGE_CORE_LOCK = Object.freeze({
  identity: "Gauge v5.6",
  owner: "Lamar / Gauge Systems & Diagnostics",
  sealed_loop: GAUGE_SEALED_LOOP,
  rules: [
    "Preserve exact raw input.", "Hash raw input before routing.", "Unknown, hostile, incomplete, duplicate, malformed, and contradictory input cannot execute.",
    "One input routes to exactly one active route.", "Destructive actions require explicit owner confirmation.", "No parallel duplicate writes.",
    "Every route must end in a proof record or a hold record.", "Safe failure means hold or queue, never silent discard.",
    "Durable state is the source of truth; chat is not the source of truth."
  ]
});
