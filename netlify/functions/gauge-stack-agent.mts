import crypto from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  applyOwnerControl,
  IntakeValidationError,
  verifyIntakeProofRecord,
} from "../lib/gauge-owner-control.js";

type GaugeStatus =
  | "Live"
  | "Broken"
  | "Missing"
  | "Needs Login"
  | "Needs Payment"
  | "Needs Proof"
  | "Owner Review";

type GaugeAsset = {
  id: string;
  asset_name: string;
  asset_type:
    | "Apps"
    | "Files"
    | "GPTs"
    | "Projects"
    | "Payments"
    | "Intake"
    | "Contracts"
    | "Proof"
    | "Corrections"
    | "Owner Review";
  asset_url?: string | null;
  owner?: string;
  source?: string;
  status: GaugeStatus;
  proof_needed?: boolean;
  payment_needed?: boolean;
  login_needed?: boolean;
  notes?: string;
  last_checked_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

type ProofLog = {
  id: string;
  asset_id: string;
  asset_name: string;
  asset_type: string;
  status: GaugeStatus;
  proof_event: string;
  proof_data: Record<string, unknown>;
  created_at: string;
};

type NextAction = {
  id: string;
  asset_id: string;
  asset_name: string;
  asset_type: string;
  status: GaugeStatus;
  action_text: string;
  priority: number;
  done: boolean;
  created_at: string;
};

type CorrectionType = "Fix" | "Break" | "Owner Correction";

type Correction = {
  id: string;
  content_hash: string;
  target_asset_id: string;
  target_asset_name: string;
  correction_type: CorrectionType;
  previous_state: string | null;
  corrected_state: string;
  correction_text: string;
  proof_ref: string | null;
  created_by: "GS&D owner";
  created_at: string;
};

type PublicIntakeRecord = {
  schema_version: string;
  ingress_id: string;
  proof_id: string;
  received_at: string;
  raw_input: {
    source?: string;
    channel?: string;
    name?: string | null;
    contact?: string | null;
    asset?: string | null;
    exact_wording?: string;
    metadata?: Record<string, unknown>;
  };
  raw_sha256: string;
  source_check: string;
  chosen_route: string;
  result: string;
  proof_chain: Array<Record<string, unknown>>;
  proof_head: string;
  owner_control?: {
    route?: string;
    state?: string;
    service_lane?: string;
    payment_status?: string;
    payment_reference?: string | null;
    owner_note?: string;
    decision_hash?: string;
    updated_at?: string;
  };
  [key: string]: unknown;
};

type OwnerIntakeRecord = PublicIntakeRecord & {
  record_key: string;
  proof_valid: boolean;
};

class CorrectionValidationError extends Error {}
class IntakeConflictError extends Error {}

const STORE_NAME = "gauge-stack-control";
const INGRESS_STORE_NAME = "gauge-public-ingress";
const REGISTRY_KEY = "registry.json";
const PROOF_KEY = "proof-log.json";
const ACTIONS_KEY = "next-actions.json";
const CORRECTIONS_KEY = "corrections.json";
const OWNER_KEY_SHA256 = "104bc76b1eb77a8f2ecc5869417feab800e038830435dbd1e416aea76a23b633";
const CORRECTION_TYPES = new Set<CorrectionType>(["Fix", "Break", "Owner Correction"]);

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getBlobStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function getIngressStore() {
  return getStore({ name: INGRESS_STORE_NAME, consistency: "strong" });
}

function hashOwnerKey(value: string) {
  return crypto.createHash("sha256").update(value).digest();
}

function requireOwnerKey(req: Request) {
  const configuredKey = Netlify.env.get("GAUGE_OWNER_KEY");
  const configuredHash = Netlify.env.get("GAUGE_OWNER_KEY_SHA256") || OWNER_KEY_SHA256;
  if (!configuredKey && !configuredHash) {
    return json({ ok: false, error: "Private controller is locked until owner access is configured." }, 503);
  }

  const sentKey = req.headers.get("x-gauge-owner-key") || "";
  const expected = configuredKey
    ? hashOwnerKey(configuredKey)
    : Buffer.from(configuredHash, "hex");
  const supplied = hashOwnerKey(sentKey);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return json({ ok: false, error: "Private boundary." }, 401);
  }

  return null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function requiredCorrectionText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CorrectionValidationError(`${label} is required.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CorrectionValidationError(`${label} must be ${maxLength} characters or fewer.`);
  }

  return normalized;
}

function optionalCorrectionText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new CorrectionValidationError(`${label} must be text.`);
  }

  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new CorrectionValidationError(`${label} must be ${maxLength} characters or fewer.`);
  }

  return normalized;
}

function normalizeCorrection(input: unknown, assets: GaugeAsset[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CorrectionValidationError("Correction details are required.");
  }

  const raw = input as Record<string, unknown>;
  const target_asset_id = requiredCorrectionText(raw.target_asset_id, "Target asset", 120);
  const target = assets.find((asset) => asset.id === target_asset_id);
  if (!target) {
    throw new CorrectionValidationError("Target asset is not in the governed registry.");
  }

  const correction_type = requiredCorrectionText(raw.correction_type, "Correction type", 40);
  if (!CORRECTION_TYPES.has(correction_type as CorrectionType)) {
    throw new CorrectionValidationError("Correction type must be Fix, Break, or Owner Correction.");
  }

  const normalized = {
    target_asset_id,
    target_asset_name: target.asset_name,
    correction_type: correction_type as CorrectionType,
    previous_state: optionalCorrectionText(raw.previous_state, "Previous state", 500),
    corrected_state: requiredCorrectionText(raw.corrected_state, "Corrected state", 500),
    correction_text: requiredCorrectionText(raw.correction_text, "Exact correction", 2000),
    proof_ref: optionalCorrectionText(raw.proof_ref, "Proof reference", 500),
  };

  const content_hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");

  return { ...normalized, content_hash };
}

const starterAssets: GaugeAsset[] = [
  {
    id: "asset-master-control",
    asset_name: "GS&D Gauge Master Control app",
    asset_type: "Apps",
    asset_url: "https://gsd-gauge-master-control.netlify.app/",
    owner: "GS&D",
    source: "Netlify",
    status: "Live",
    proof_needed: false,
    notes: "Main operating body. Do not scatter.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-stack-controller",
    asset_name: "Gauge Stack Controller",
    asset_type: "Apps",
    asset_url: "/gauge-stack-controller.html",
    owner: "GS&D",
    source: "Master Control",
    status: "Owner Review",
    proof_needed: true,
    notes: "Control screen inside Master Control.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-agent-backend",
    asset_name: "Gauge Agent backend",
    asset_type: "Projects",
    asset_url: "/api/gauge-stack-agent",
    owner: "GS&D",
    source: "Netlify Function",
    status: "Owner Review",
    proof_needed: true,
    notes: "Reads registry, writes proof, makes next actions.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-payments",
    asset_name: "Gauge payment route",
    asset_type: "Payments",
    owner: "GS&D",
    source: "Owner Proof",
    status: "Needs Proof",
    proof_needed: true,
    payment_needed: true,
    notes: "Attach Cash App or payment proof before public routing.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-intake",
    asset_name: "Gauge Intake route",
    asset_type: "Intake",
    owner: "GS&D",
    source: "Master Control",
    status: "Owner Review",
    proof_needed: true,
    notes: "Connect inquiry forms and routing.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-contracts",
    asset_name: "GS&D Contract Proposal Package",
    asset_type: "Contracts",
    owner: "GS&D",
    source: "Files",
    status: "Needs Proof",
    proof_needed: true,
    notes: "Attach current contract files and proof copies.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-proof-log",
    asset_name: "Proof log",
    asset_type: "Proof",
    owner: "GS&D",
    source: "Netlify Blobs",
    status: "Live",
    proof_needed: false,
    notes: "Stores sync runs and asset proof events.",
    created_at: new Date().toISOString(),
  },
  {
    id: "asset-corrections",
    asset_name: "Corrections log",
    asset_type: "Corrections",
    owner: "GS&D",
    source: "Master Control",
    status: "Owner Review",
    proof_needed: true,
    notes: "Tracks fixes, breaks, and owner corrections.",
    created_at: new Date().toISOString(),
  },
];

const CONNECTED_ASSET_PATCHES: Record<string, Partial<GaugeAsset>> = {
  "asset-stack-controller": {
    asset_name: "Gauge Master Control",
    asset_url: "/controller",
    source: "Master Control",
    status: "Live",
    proof_needed: false,
    notes: "Owner controller for registry, public intake queue, routing, payment state, corrections, and proof.",
  },
  "asset-agent-backend": {
    asset_name: "Gauge Master Controller agent",
    source: "Netlify Function + Blobs",
    status: "Live",
    proof_needed: false,
    notes: "Owner-authenticated controller reads both governed registry and public ingress proof records.",
  },
  "asset-intake": {
    asset_name: "Gauge Hub Intake queue",
    asset_url: "/intake",
    source: "Gauge Public Ingress → Master Control",
    status: "Live",
    proof_needed: false,
    notes: "Exact public input, source check, route decision, payment state, and owner action stay on one proof chain.",
  },
};

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  const store = getBlobStore();
  const data = await store.get(key, { type: "json" });
  return data ?? fallback;
}

async function writeJSON(key: string, value: unknown) {
  const store = getBlobStore();
  await store.setJSON(key, value);
}

async function readAssets() {
  const assets = await readJSON<GaugeAsset[]>(REGISTRY_KEY, []);
  if (!assets.length) {
    await writeJSON(REGISTRY_KEY, starterAssets);
    return starterAssets;
  }

  let changed = false;
  const connectedAssets = assets.map((asset) => {
    const patch = CONNECTED_ASSET_PATCHES[asset.id];
    if (!patch) return asset;
    const needsPatch = Object.entries(patch).some(([key, value]) => asset[key as keyof GaugeAsset] !== value);
    if (!needsPatch) return asset;
    changed = true;
    return { ...asset, ...patch, updated_at: new Date().toISOString() };
  });

  if (changed) await writeJSON(REGISTRY_KEY, connectedAssets);
  return connectedAssets;
}

function classifyAsset(asset: GaugeAsset): GaugeStatus {
  const name = (asset.asset_name || "").trim();
  const type = (asset.asset_type || "").trim();
  const url = (asset.asset_url || "").trim();

  if (!name || !type) return "Missing";
  if (asset.login_needed) return "Needs Login";
  if (asset.payment_needed) return "Needs Payment";
  if (asset.proof_needed) return "Needs Proof";

  if (!url) {
    if (["Files", "GPTs", "Contracts", "Proof", "Corrections", "Owner Review"].includes(type)) {
      return "Owner Review";
    }
    return "Missing";
  }

  try {
    new URL(url, "https://gsd-gauge-master-control.netlify.app");
  } catch {
    return "Broken";
  }

  return "Live";
}

function actionFor(status: GaugeStatus, asset: GaugeAsset) {
  const label = `${asset.asset_type}: ${asset.asset_name}`;

  if (status === "Live") return `Keep ${label} in registry. Check proof on next sync.`;
  if (status === "Broken") return `Fix the bad link or broken route for ${label}.`;
  if (status === "Missing") return `Add the missing name, type, or link for ${label}.`;
  if (status === "Needs Login") return `Owner must log in and prove access for ${label}.`;
  if (status === "Needs Payment") return `Connect or prove the payment path for ${label}.`;
  if (status === "Needs Proof") return `Attach screenshot, link, file, receipt, or note proof for ${label}.`;
  return `Owner review needed for ${label}. Decide keep, fix, connect, or archive.`;
}

async function runSync() {
  const now = new Date().toISOString();
  const assets = await readAssets();
  const oldProof = await readJSON<ProofLog[]>(PROOF_KEY, []);
  const oldActions = await readJSON<NextAction[]>(ACTIONS_KEY, []);

  const proofItems: ProofLog[] = [];
  const nextActions: NextAction[] = [];

  const updatedAssets = assets.map((asset) => {
    const status = classifyAsset(asset);
    const action_text = actionFor(status, asset);

    proofItems.push({
      id: makeId("proof"),
      asset_id: asset.id,
      asset_name: asset.asset_name,
      asset_type: asset.asset_type,
      status,
      proof_event: "Gauge Stack Sync checked this asset.",
      proof_data: {
        checked_at: now,
        old_status: asset.status,
        new_status: status,
        asset_url: asset.asset_url || null,
      },
      created_at: now,
    });

    nextActions.push({
      id: makeId("action"),
      asset_id: asset.id,
      asset_name: asset.asset_name,
      asset_type: asset.asset_type,
      status,
      action_text,
      priority: status === "Broken" || status === "Missing" ? 1 : status === "Owner Review" ? 2 : 3,
      done: false,
      created_at: now,
    });

    return {
      ...asset,
      status,
      last_checked_at: now,
      updated_at: now,
    };
  });

  await writeJSON(REGISTRY_KEY, updatedAssets);
  await writeJSON(PROOF_KEY, [...proofItems, ...oldProof].slice(0, 500));
  await writeJSON(ACTIONS_KEY, [...nextActions, ...oldActions].slice(0, 200));

  return {
    ok: true,
    message: "Gauge Stack Sync complete.",
    checked_count: updatedAssets.length,
    results: nextActions,
  };
}

async function addCorrection(input: unknown) {
  const assets = await readAssets();
  const normalized = normalizeCorrection(input, assets);
  const corrections = await readJSON<Correction[]>(CORRECTIONS_KEY, []);
  const duplicate = corrections.find((item) => item.content_hash === normalized.content_hash);

  if (duplicate) {
    return {
      ok: true,
      message: "Exact correction already recorded.",
      deduped: true,
      correction: duplicate,
    };
  }

  const now = new Date().toISOString();
  const correction: Correction = {
    id: `correction-${normalized.content_hash.slice(0, 24)}`,
    ...normalized,
    created_by: "GS&D owner",
    created_at: now,
  };

  const oldProof = await readJSON<ProofLog[]>(PROOF_KEY, []);
  const proof: ProofLog = {
    id: `proof-${normalized.content_hash.slice(0, 24)}`,
    asset_id: "asset-corrections",
    asset_name: "Corrections log",
    asset_type: "Corrections",
    status: "Live",
    proof_event: "Owner correction recorded in the governed Corrections Log.",
    proof_data: {
      correction_id: correction.id,
      content_hash: correction.content_hash,
      target_asset_id: correction.target_asset_id,
      correction_type: correction.correction_type,
      proof_ref: correction.proof_ref,
    },
    created_at: now,
  };

  const updatedAssets = assets.map((asset) => asset.id === "asset-corrections"
    ? {
        ...asset,
        asset_url: "/api/gauge-stack-agent",
        source: "Netlify Blobs + Master Control",
        status: "Live" as GaugeStatus,
        proof_needed: false,
        notes: "Owner-only, hash-deduplicated corrections retained in corrections.json.",
        last_checked_at: now,
        updated_at: now,
      }
    : asset);

  await writeJSON(CORRECTIONS_KEY, [correction, ...corrections].slice(0, 500));
  await writeJSON(PROOF_KEY, [proof, ...oldProof].slice(0, 500));
  await writeJSON(REGISTRY_KEY, updatedAssets);

  return {
    ok: true,
    message: "Correction recorded and proof preserved.",
    deduped: false,
    correction,
  };
}

async function readPublicIntakes() {
  const ingress = getIngressStore();
  const listing = await ingress.list({ prefix: "records/" });
  const keys = listing.blobs
    .map((blob) => blob.key)
    .filter((key) => /^records\/[a-f0-9]{64}\.json$/.test(key))
    .slice(0, 2000);
  const records: OwnerIntakeRecord[] = [];

  for (let index = 0; index < keys.length; index += 25) {
    const batch = keys.slice(index, index + 25);
    const loaded = await Promise.all(batch.map(async (recordKey) => {
      const record = await ingress.get(recordKey, { type: "json" }) as PublicIntakeRecord | null;
      if (!record || typeof record !== "object" || !record.proof_id) return null;
      return {
        ...record,
        record_key: recordKey,
        proof_valid: verifyIntakeProofRecord(record),
      } as OwnerIntakeRecord;
    }));
    records.push(...loaded.filter((record): record is OwnerIntakeRecord => Boolean(record)));
  }

  return records.sort((left, right) => {
    const leftDate = Date.parse(left.owner_control?.updated_at || left.received_at || "") || 0;
    const rightDate = Date.parse(right.owner_control?.updated_at || right.received_at || "") || 0;
    return rightDate - leftDate;
  });
}

function summarizeIntakes(intakes: OwnerIntakeRecord[]) {
  const currentState = (intake: OwnerIntakeRecord) => intake.owner_control?.state || "held";
  return {
    total: intakes.length,
    held: intakes.filter((intake) => currentState(intake) === "held").length,
    ready: intakes.filter((intake) => currentState(intake) === "ready").length,
    active: intakes.filter((intake) => currentState(intake) === "active").length,
    complete: intakes.filter((intake) => currentState(intake) === "complete").length,
    needs_payment: intakes.filter((intake) => {
      const payment = intake.owner_control?.payment_status;
      const route = intake.owner_control?.route || intake.chosen_route;
      return payment === "unpaid" || payment === "proof_submitted" || route === "payment_gate";
    }).length,
    invalid_proof: intakes.filter((intake) => !intake.proof_valid).length,
  };
}

async function updatePublicIntake(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new IntakeValidationError("Owner intake decision is required.");
  }

  const raw = input as Record<string, unknown>;
  const recordKey = String(raw.record_key || "").trim();
  if (!/^records\/[a-f0-9]{64}\.json$/.test(recordKey)) {
    throw new IntakeValidationError("Governed intake record key is invalid.");
  }

  const ingress = getIngressStore();
  const snapshot = await ingress.getWithMetadata(recordKey, { type: "json" });
  if (!snapshot?.data) throw new IntakeValidationError("Governed intake record was not found.");
  if (!snapshot.etag) throw new IntakeConflictError("Intake record version could not be locked. Reload and try again.");

  const update = applyOwnerControl(snapshot.data as PublicIntakeRecord, raw);
  if (update.deduped) {
    return {
      ok: true,
      message: "Exact owner decision already exists; no duplicate proof event was added.",
      deduped: true,
      intake: {
        ...update.record,
        record_key: recordKey,
        proof_valid: true,
      },
    };
  }

  const write = await ingress.setJSON(recordKey, update.record, { onlyIfMatch: snapshot.etag });
  if (!write.modified) {
    throw new IntakeConflictError("This intake changed during the decision. Reload it before writing.");
  }

  const verified = await ingress.get(recordKey, { type: "json" }) as PublicIntakeRecord | null;
  if (!verified || verified.proof_head !== update.record.proof_head || !verifyIntakeProofRecord(verified)) {
    throw new IntakeConflictError("Owner decision write did not verify against the proof chain.");
  }

  return {
    ok: true,
    message: "Owner route, work state, and payment state appended to the original proof record.",
    deduped: false,
    intake: {
      ...verified,
      record_key: recordKey,
      proof_valid: true,
    },
  };
}

export default async (req: Request, context: Context) => {
  try {
    const authError = requireOwnerKey(req);
    if (authError) return authError;

    if (req.method === "GET") {
      const [assets, actions, proof_log, corrections, intakes] = await Promise.all([
        readAssets(),
        readJSON<NextAction[]>(ACTIONS_KEY, []),
        readJSON<ProofLog[]>(PROOF_KEY, []),
        readJSON<Correction[]>(CORRECTIONS_KEY, []),
        readPublicIntakes(),
      ]);
      return json({
        ok: true,
        system: "GS&D Gauge Master Control",
        version: "3.0-connected-control",
        assets,
        actions,
        proof_log: proof_log.slice(0, 25),
        corrections: corrections.slice(0, 100),
        intakes: intakes.slice(0, 500),
        intake_stats: summarizeIntakes(intakes),
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      if (body.action === "sync") {
        return json(await runSync());
      }

      if (body.action === "saveRegistry" && Array.isArray(body.assets)) {
        await writeJSON(REGISTRY_KEY, body.assets);
        return json({ ok: true, message: "Registry saved." });
      }

      if (body.action === "addCorrection") {
        return json(await addCorrection(body.correction));
      }

      if (body.action === "updateIntake") {
        return json(await updatePublicIntake(body.intake));
      }

      return json({ ok: false, error: "Use action: sync, saveRegistry, addCorrection, or updateIntake." }, 400);
    }

    return json({ ok: false, error: "Use GET or POST." }, 405);
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Gauge Agent error.",
      },
      error instanceof CorrectionValidationError || error instanceof IntakeValidationError
        ? 400
        : error instanceof IntakeConflictError
          ? 409
          : 500
    );
  }
};

export const config: Config = {
  path: "/api/gauge-stack-agent",
};
