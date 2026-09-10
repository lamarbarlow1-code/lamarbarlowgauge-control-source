import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { randomUUID, createHash } from "node:crypto";
import { GAUGE_CORE_LOCK, hashRaw, type GaugeSourceClass } from "../../core/gauge-core.mts";
import { GAUGE_BOSS_LOCK, runBossCycle, type BossWorkItem } from "../../boss/gauge-boss.mts";

const STORE_NAME = "gauge-boss-v1";
const CURRENT_KEY = "current-cycle.json";
const OWNER_KEY_SHA256 = "104bc76b1eb77a8f2ecc5869417feab800e038830435dbd1e416aea76a23b633";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function store() { return getStore({ name: STORE_NAME, consistency: "strong" }); }
function hashKey(value: string) { return createHash("sha256").update(value).digest(); }
function requireOwnerKey(req: Request) {
  const configuredKey = Netlify.env.get("GAUGE_OWNER_KEY");
  const configuredHash = Netlify.env.get("GAUGE_OWNER_KEY_SHA256") || OWNER_KEY_SHA256;
  if (!configuredKey && !configuredHash) return json({ ok: false, error: "Gauge Boss is locked until owner access is configured." }, 503);
  const supplied = hashKey(req.headers.get("x-gauge-owner-key") || "");
  const expected = configuredKey ? hashKey(configuredKey) : Buffer.from(configuredHash, "hex");
  if (supplied.length !== expected.length || !Buffer.from(supplied).equals(expected)) return json({ ok: false, error: "Private boundary." }, 401);
  return null;
}
function normalizeSource(v: unknown): GaugeSourceClass {
  return ["known owner","unknown source","hostile","incomplete"].includes(String(v)) ? v as GaugeSourceClass : "unknown source";
}
function validItems(v: unknown): v is BossWorkItem[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 250 && v.every((x: any) => x && typeof x.id === "string" && x.id.trim() && typeof x.created_at === "string" && x.created_at.trim() && ["money","work","customers","proof","control"].includes(x.lane) && typeof x.kind === "string" && x.kind.trim() && typeof x.title === "string" && x.title.trim() && typeof x.raw_input === "string" && x.raw_input.trim());
}
async function writeProof(proof: any) { await store().setJSON(`proof/${proof.at}-${proof.id}.json`, proof); }
async function listProof(limit = 20) {
  const s = store();
  const { blobs } = await s.list({ prefix: "proof/" });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  const out = [];
  for (const key of keys) { const item = await s.get(key, { type: "json" }); if (item) out.push(item); }
  return out;
}

export default async (req: Request, _context: Context) => {
  try {
    if (req.method === "GET") {
      const current_cycle = await store().get(CURRENT_KEY, { type: "json" });
      return json({ ok: true, system: "Gauge", layer: "Gauge Boss", version: "1.0.0", role: "Executive operating system / management layer", owner_role: "Owner + lead field operator", lanes: ["money","work","customers","proof","control"], core_lock: GAUGE_CORE_LOCK, boss_lock: GAUGE_BOSS_LOCK, current_cycle: current_cycle ?? null, proof_log: await listProof() });
    }
    if (req.method !== "POST") return json({ ok: false, error: "Use GET or POST." }, 405);
    const authError = requireOwnerKey(req); if (authError) return authError;
    const body = await req.json().catch(() => null);
    if (!body || body.action !== "cycle") return json({ ok: false, error: "Unknown action held. Use action: cycle." }, 400);
    if (!validItems(body.items)) return json({ ok: false, error: "Boss queue held. Supply 1-250 complete work items." }, 400);

    const items: BossWorkItem[] = body.items.map((x: BossWorkItem) => ({ ...x, source: normalizeSource(x.source) }));
    const cycle = runBossCycle(items);
    const at = new Date().toISOString();
    const id = randomUUID();
    const raw = JSON.stringify(items);
    const proof = { id, at, proof_type: "boss_cycle", raw_sha256: hashRaw(raw), source_class: "known owner", chosen_route: "gauge_boss_management_cycle", selected: cycle.selected, owner_decisions: cycle.owner_decisions, gauge_work: cycle.gauge_work, lamar_work: cycle.lamar_work, holds: cycle.holds, queue_count: cycle.queue.length, result: cycle.selected ? `Gauge Boss selected ${cycle.selected.item_id} and assigned it to ${cycle.selected.assigned_to}.` : "No work remained in supplied queue." };
    await store().setJSON(CURRENT_KEY, { at, id, input_count: items.length, cycle });
    await writeProof(proof);
    return json({ ok: true, cycle, proof });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Unknown Gauge Boss error." }, 500);
  }
};

export const config: Config = { path: "/api/gauge-boss" };
