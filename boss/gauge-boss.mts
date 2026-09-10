import { decide, hashRaw, type GaugeSourceClass } from "../core/gauge-core.mts";

export type BossLane = "money" | "work" | "customers" | "proof" | "control";
export type BossActor = "gauge" | "lamar";
export type BossAuthority = "AUTO" | "AUTO_NOTIFY" | "OWNER_APPROVAL" | "HOLD";
export type BossWorkItem = {
  id: string;
  created_at: string;
  source: GaugeSourceClass;
  lane: BossLane;
  kind: string;
  title: string;
  raw_input: string;
  revenue_usd?: number | null;
  cash_collected_usd?: number | null;
  risk?: number;
  urgency?: number;
  requires_physical_presence?: boolean;
  requires_owner_judgment?: boolean;
  status?: string;
};

export const GAUGE_BOSS_LOCK = Object.freeze({
  identity: "Gauge Boss v1",
  company: "Gauge Systems & Diagnostics",
  human_owner: "Lamar Barlow",
  operating_role: "Executive operating system / management layer",
  owner_role: "Owner + lead field operator",
  lanes: ["money", "work", "customers", "proof", "control"],
  rules: [
    "Gauge Boss is subordinate to Gauge Core.",
    "Routine reversible management stays Gauge work, not Lamar work.",
    "Lamar receives one true owner decision or physical assignment at a time.",
    "No payment means no paid execution unless a locked rule says otherwise.",
    "Unknown facts are retrieved or held, never guessed.",
    "Every meaningful action ends in proof, hold, or owner escalation."
  ]
});

const OWNER_ONLY = new Set([
  "change_price_rule","spend_money","issue_refund","sign_contract","accept_legal_terms",
  "banking_action","tax_action","hire_or_fire","delete_or_destroy","transfer_ip",
  "release_protected_source","make_unverified_public_claim"
]);
const AUTO_NOTIFY = new Set(["publish_approved_content","update_non_destructive_site_content","schedule_paid_work","assign_field_work"]);
const AUTO = new Set([
  "qualify_lead","quote_locked_service","request_payment","verify_payment","send_routine_customer_message",
  "prepare_draft","collect_proof","close_proved_loop","create_ticket","follow_up","reject_out_of_scope"
]);

function authorityFor(item: BossWorkItem): BossAuthority {
  if (item.source !== "known owner" && item.source !== "unknown source") return "HOLD";
  if (OWNER_ONLY.has(item.kind) || item.requires_owner_judgment) return "OWNER_APPROVAL";
  if (AUTO_NOTIFY.has(item.kind)) return "AUTO_NOTIFY";
  if (AUTO.has(item.kind)) return "AUTO";
  return "HOLD";
}

function score(item: BossWorkItem) {
  const paid = (item.cash_collected_usd ?? 0) > 0 ? 400 : 0;
  const revenue = Math.min(Math.max(0, item.revenue_usd ?? 0) / 25, 400);
  const urgency = Math.max(0, Math.min(5, item.urgency ?? 0)) * 80;
  const risk = Math.max(0, Math.min(5, item.risk ?? 0)) * 60;
  const blocked = item.status === "blocked" || item.status === "held" ? 250 : 0;
  const done = item.status === "done" ? 10000 : 0;
  return paid + revenue + urgency + risk - blocked - done;
}

function decideItem(item: BossWorkItem) {
  const core = decide(item.raw_input, item.source, false);
  const authority = authorityFor(item);
  const decision_id = `boss_${hashRaw(`${item.id}|${item.kind}|${item.raw_input}`).slice(0, 20)}`;

  if (!core.execution_allowed) return { decision_id, item_id: item.id, lane: item.lane, authority: "HOLD", assigned_to: "gauge" as const, execution_allowed: false, core_route: core.chosen_route, reason: core.result, next_action: core.fallback ?? "Preserve and hold." };
  if (authority === "OWNER_APPROVAL") return { decision_id, item_id: item.id, lane: item.lane, authority, assigned_to: "lamar" as const, execution_allowed: false, core_route: core.chosen_route, reason: "Owner-only authority boundary.", next_action: `${item.title}: approve or reject.` };
  if (authority === "HOLD") return { decision_id, item_id: item.id, lane: item.lane, authority, assigned_to: "gauge" as const, execution_allowed: false, core_route: core.chosen_route, reason: "Authority or action type is not proven.", next_action: "Retrieve missing facts or hold." };
  const assigned_to: BossActor = item.requires_physical_presence ? "lamar" : "gauge";
  return { decision_id, item_id: item.id, lane: item.lane, authority, assigned_to, execution_allowed: true, core_route: core.chosen_route, reason: "Within locked rules.", next_action: assigned_to === "lamar" ? `Do one field action: ${item.title}` : `Gauge executes: ${item.title}` };
}

export function runBossCycle(items: BossWorkItem[]) {
  const ordered = [...items].filter((x) => x.status !== "done").sort((a,b) => score(b) - score(a));
  const queue = ordered.map(decideItem);
  const owner_decisions = queue.filter((x) => x.authority === "OWNER_APPROVAL");
  const gauge_work = queue.filter((x) => x.execution_allowed && x.assigned_to === "gauge");
  const lamar_work = queue.filter((x) => x.execution_allowed && x.assigned_to === "lamar");
  const holds = queue.filter((x) => x.authority === "HOLD");
  const selected = queue.find((x) => x.execution_allowed) ?? owner_decisions[0] ?? holds[0] ?? null;
  return { selected, queue, owner_decisions, gauge_work, lamar_work, holds };
}
