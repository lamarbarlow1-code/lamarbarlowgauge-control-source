const rows = document.getElementById("assetRows");
const syncButton = document.getElementById("syncButton");
const reloadButton = document.getElementById("reloadButton");
const lockButton = document.getElementById("lockButton");
const syncStatus = document.getElementById("syncStatus");
const nextActions = document.getElementById("nextActions");
const proofLog = document.getElementById("proofLog");
const intakeQueue = document.getElementById("intakeQueue");
const intakeFilter = document.getElementById("intakeFilter");
const intakeDecisionForm = document.getElementById("intakeDecisionForm");
const decisionRecordKey = document.getElementById("decisionRecordKey");
const decisionProofId = document.getElementById("decisionProofId");
const decisionTitle = document.getElementById("decisionTitle");
const decisionRoute = document.getElementById("decisionRoute");
const decisionState = document.getElementById("decisionState");
const decisionLane = document.getElementById("decisionLane");
const decisionPayment = document.getElementById("decisionPayment");
const decisionPaymentReference = document.getElementById("decisionPaymentReference");
const decisionNote = document.getElementById("decisionNote");
const recordDecisionButton = document.getElementById("recordDecisionButton");
const decisionStatus = document.getElementById("decisionStatus");
const closeDecisionButton = document.getElementById("closeDecisionButton");
const correctionForm = document.getElementById("correctionForm");
const correctionAsset = document.getElementById("correctionAsset");
const correctionType = document.getElementById("correctionType");
const previousState = document.getElementById("previousState");
const correctedState = document.getElementById("correctedState");
const correctionText = document.getElementById("correctionText");
const correctionProof = document.getElementById("correctionProof");
const recordCorrectionButton = document.getElementById("recordCorrectionButton");
const correctionStatus = document.getElementById("correctionStatus");
const correctionsLog = document.getElementById("correctionsLog");

const metricElements = {
  total: document.getElementById("metricTotal"),
  held: document.getElementById("metricHeld"),
  ready: document.getElementById("metricReady"),
  active: document.getElementById("metricActive"),
  needs_payment: document.getElementById("metricPayment"),
  invalid_proof: document.getElementById("metricInvalid"),
};

const validRoutes = new Set([
  "hold",
  "diagnostic_intake",
  "estimate_intake",
  "schedule_hold_for_owner",
  "payment_gate",
  "owner_build_queue",
  "owner_outbound_queue",
  "archive_record",
]);
const validLanes = new Set([
  "file_reserve_25",
  "diagnostic_250",
  "isolated_deployment_2500_plus",
  "custom_review",
]);

let allAssets = [];
let allActions = [];
let allProof = [];
let allCorrections = [];
let allIntakes = [];
let intakeStats = {};
let currentFilter = "All";

function safeText(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function escapeHtml(value) {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, window.location.origin);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function ownerKey() {
  let key = sessionStorage.getItem("gaugeOwnerKey") || "";
  if (!key) {
    key = (prompt("Enter the GS&D Gauge owner key.") || "").trim();
    if (key) sessionStorage.setItem("gaugeOwnerKey", key);
  }
  return key;
}

async function gaugeRequest(options = {}) {
  const key = ownerKey();
  if (!key) throw new Error("Owner key required. No protected records were loaded.");

  const response = await fetch("/api/gauge-stack-agent", {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-gauge-owner-key": key,
    },
  });
  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    sessionStorage.removeItem("gaugeOwnerKey");
    throw new Error("Owner key rejected. Reload and enter the current key.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Gauge controller request failed.");
  return data;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleString();
}

function words(value) {
  return safeText(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function intakeState(intake) {
  return intake.owner_control?.state || "held";
}

function activeRoute(intake) {
  return intake.owner_control?.route || intake.chosen_route || "hold";
}

function activeLane(intake) {
  const lane = intake.owner_control?.service_lane || intake.raw_input?.metadata?.service_lane;
  return validLanes.has(lane) ? lane : "custom_review";
}

function renderMetrics() {
  for (const [key, element] of Object.entries(metricElements)) {
    element.textContent = String(intakeStats[key] || 0);
  }
}

function renderIntakes() {
  const filter = intakeFilter.value;
  const filtered = allIntakes.filter((intake) => {
    const state = intakeState(intake);
    if (filter === "all") return true;
    if (filter === "open") return state !== "complete";
    return state === filter;
  });

  if (!filtered.length) {
    intakeQueue.innerHTML = '<p class="empty-state">No governed intake records match this view.</p>';
    return;
  }

  intakeQueue.innerHTML = filtered.map((intake) => {
    const raw = intake.raw_input || {};
    const control = intake.owner_control || {};
    const proofClass = intake.proof_valid ? "proof-good" : "proof-bad";
    const proofLabel = intake.proof_valid ? "Proof verified" : "Proof failed — locked";
    const selected = decisionRecordKey.value === intake.record_key ? " selected" : "";
    return `
      <article class="intake-card${selected}">
        <div class="intake-card-head">
          <div>
            <span class="proof-state ${proofClass}">${proofLabel}</span>
            <h3>${escapeHtml(raw.name || "Unnamed intake")}</h3>
            <p>${escapeHtml(raw.asset || "No asset named")} • ${escapeHtml(formatDate(intake.received_at))}</p>
          </div>
          <span class="work-state ${escapeHtml(intakeState(intake))}">${escapeHtml(words(intakeState(intake)))}</span>
        </div>
        <blockquote>${escapeHtml(raw.exact_wording || "No exact wording recorded")}</blockquote>
        <dl class="intake-facts">
          <div><dt>Contact</dt><dd>${escapeHtml(raw.contact)}</dd></div>
          <div><dt>Proof</dt><dd>${escapeHtml(intake.proof_id)}</dd></div>
          <div><dt>Source</dt><dd>${escapeHtml(words(intake.source_check))}</dd></div>
          <div><dt>Current route</dt><dd>${escapeHtml(words(activeRoute(intake)))}</dd></div>
          <div><dt>Lane</dt><dd>${escapeHtml(words(activeLane(intake)))}</dd></div>
          <div><dt>Payment</dt><dd>${escapeHtml(words(control.payment_status || "unpaid"))}</dd></div>
        </dl>
        ${control.owner_note ? `<p class="owner-note"><strong>Owner:</strong> ${escapeHtml(control.owner_note)}</p>` : ""}
        <div class="intake-card-actions">
          <button type="button" data-intake-key="${escapeHtml(intake.record_key)}" ${intake.proof_valid ? "" : "disabled"}>${control.decision_hash ? "Update controlled route" : "Open owner decision"}</button>
          <code>SHA-256 ${escapeHtml(intake.raw_sha256)}</code>
        </div>
      </article>
    `;
  }).join("");
}

function selectIntake(recordKey) {
  const intake = allIntakes.find((item) => item.record_key === recordKey);
  if (!intake || !intake.proof_valid) return;
  const raw = intake.raw_input || {};
  const control = intake.owner_control || {};
  const route = activeRoute(intake);

  decisionRecordKey.value = intake.record_key;
  decisionProofId.value = intake.proof_id;
  decisionTitle.textContent = `${raw.name || "Unnamed intake"} — ${raw.asset || intake.proof_id}`;
  decisionRoute.value = validRoutes.has(route) ? route : "hold";
  decisionState.value = control.state || "held";
  decisionLane.value = activeLane(intake);
  decisionPayment.value = control.payment_status || (raw.metadata?.payment_reference ? "proof_submitted" : "unpaid");
  decisionPaymentReference.value = control.payment_reference || raw.metadata?.payment_reference || "";
  decisionNote.value = control.owner_note || "";
  decisionStatus.textContent = "Review the exact record. No change has been written.";
  intakeDecisionForm.hidden = false;
  renderIntakes();
  intakeDecisionForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAssets() {
  const assets = currentFilter === "All" ? allAssets : allAssets.filter((asset) => asset.asset_type === currentFilter);
  if (!assets.length) {
    rows.innerHTML = `<tr><td colspan="6">No assets found for ${escapeHtml(currentFilter)}.</td></tr>`;
    return;
  }

  rows.innerHTML = assets.map((asset) => {
    const cleanedUrl = safeUrl(asset.asset_url);
    const url = cleanedUrl ? `<a href="${cleanedUrl}" target="_blank" rel="noreferrer">Open</a>` : "—";
    const statusClass = safeText(asset.status).replace(/[^a-z0-9]/gi, "");
    return `<tr><td>${escapeHtml(asset.asset_name)}</td><td>${escapeHtml(asset.asset_type)}</td><td><span class="badge ${statusClass}">${escapeHtml(asset.status)}</span></td><td>${url}</td><td>${escapeHtml(asset.notes)}</td><td>${asset.last_checked_at ? escapeHtml(formatDate(asset.last_checked_at)) : "Not checked"}</td></tr>`;
  }).join("");
}

function renderActions(actions = allActions) {
  nextActions.innerHTML = actions.length
    ? actions.slice(0, 30).map((item) => `<li><strong>${escapeHtml(item.status)}</strong> — ${escapeHtml(item.action_text)}</li>`).join("")
    : "<li>No next actions yet. Run governed sync.</li>";
}

function renderProof() {
  proofLog.innerHTML = allProof.length
    ? allProof.slice(0, 25).map((item) => `<li><strong>${escapeHtml(formatDate(item.created_at))}</strong> — ${escapeHtml(item.proof_event || `${item.asset_type} / ${item.asset_name}`)} — ${escapeHtml(item.status)}</li>`).join("")
    : "<li>No registry proof events yet. Intake proof stays on each intake record.</li>";
}

function renderCorrectionTargets() {
  const selected = correctionAsset.value;
  correctionAsset.innerHTML = ['<option value="">Select a governed asset</option>', ...allAssets.map((asset) => `<option value="${escapeHtml(asset.id)}">${escapeHtml(asset.asset_type)} / ${escapeHtml(asset.asset_name)}</option>`)].join("");
  if (allAssets.some((asset) => asset.id === selected)) correctionAsset.value = selected;
}

function renderCorrections() {
  correctionsLog.innerHTML = allCorrections.length
    ? allCorrections.slice(0, 100).map((item) => `<li><strong>${escapeHtml(formatDate(item.created_at))}</strong> — ${escapeHtml(item.correction_type)} / ${escapeHtml(item.target_asset_name)}<br>${escapeHtml(item.previous_state || "No prior state recorded")} → ${escapeHtml(item.corrected_state)}<br>${escapeHtml(item.correction_text)}${item.proof_ref ? `<br>Proof: ${escapeHtml(item.proof_ref)}` : ""}<br><span class="correction-hash">SHA-256 ${escapeHtml(item.content_hash)}</span></li>`).join("")
    : "<li>No corrections recorded yet.</li>";
}

async function loadRegistry() {
  syncStatus.textContent = "Authenticating and reading connected Gauge state…";
  const data = await gaugeRequest();
  allAssets = data.assets || [];
  allActions = data.actions || [];
  allProof = data.proof_log || [];
  allCorrections = data.corrections || [];
  allIntakes = data.intakes || [];
  intakeStats = data.intake_stats || {};
  renderAssets();
  renderActions();
  renderProof();
  renderCorrectionTargets();
  renderCorrections();
  renderMetrics();
  renderIntakes();
  syncStatus.textContent = `${data.system || "Gauge Master Control"} connected: ${allIntakes.length} intake records, ${allAssets.length} governed assets, ${allCorrections.length} corrections.`;
}

async function syncGaugeStack() {
  syncButton.disabled = true;
  syncStatus.textContent = "Running governed asset sync…";
  try {
    const data = await gaugeRequest({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync" }) });
    syncStatus.textContent = `${data.message} Checked ${data.checked_count} assets.`;
    await loadRegistry();
  } catch (error) {
    syncStatus.textContent = error.message || "Gauge sync failed.";
  } finally {
    syncButton.disabled = false;
  }
}

async function recordIntakeDecision(event) {
  event.preventDefault();
  if (!decisionRecordKey.value) return;
  const confirmed = window.confirm("Append this owner decision to the intake proof chain? The original public input will remain unchanged.");
  if (!confirmed) return;

  recordDecisionButton.disabled = true;
  decisionStatus.textContent = "Locking record version and appending proof…";
  try {
    const data = await gaugeRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "updateIntake",
        intake: {
          record_key: decisionRecordKey.value,
          proof_id: decisionProofId.value,
          route: decisionRoute.value,
          state: decisionState.value,
          service_lane: decisionLane.value,
          payment_status: decisionPayment.value,
          payment_reference: decisionPaymentReference.value,
          owner_note: decisionNote.value,
        },
      }),
    });
    decisionStatus.textContent = data.message;
    await loadRegistry();
    selectIntake(data.intake.record_key);
    decisionStatus.textContent = data.deduped ? "Exact decision already existed; no duplicate event added." : "Owner decision verified on the original proof chain.";
  } catch (error) {
    decisionStatus.textContent = error.message || "Owner decision could not be recorded.";
  } finally {
    recordDecisionButton.disabled = false;
  }
}

async function recordCorrection(event) {
  event.preventDefault();
  recordCorrectionButton.disabled = true;
  correctionStatus.textContent = "Recording correction and preserving proof…";
  try {
    const data = await gaugeRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "addCorrection", correction: { target_asset_id: correctionAsset.value, correction_type: correctionType.value, previous_state: previousState.value, corrected_state: correctedState.value, correction_text: correctionText.value, proof_ref: correctionProof.value } }),
    });
    correctionStatus.textContent = data.deduped ? "Exact correction already exists; no duplicate was added." : "Correction recorded and proof preserved.";
    previousState.value = "";
    correctedState.value = "";
    correctionText.value = "";
    correctionProof.value = "";
    await loadRegistry();
  } catch (error) {
    correctionStatus.textContent = error.message || "Correction could not be recorded.";
  } finally {
    recordCorrectionButton.disabled = false;
  }
}

document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  currentFilter = button.dataset.filter;
  renderAssets();
}));

intakeQueue.addEventListener("click", (event) => {
  const button = event.target.closest("[data-intake-key]");
  if (button) selectIntake(button.dataset.intakeKey);
});
intakeFilter.addEventListener("change", renderIntakes);
intakeDecisionForm.addEventListener("submit", recordIntakeDecision);
closeDecisionButton.addEventListener("click", () => {
  intakeDecisionForm.hidden = true;
  decisionRecordKey.value = "";
  renderIntakes();
});
syncButton.addEventListener("click", syncGaugeStack);
correctionForm.addEventListener("submit", recordCorrection);
reloadButton.addEventListener("click", () => loadRegistry().catch((error) => { syncStatus.textContent = error.message; }));
lockButton.addEventListener("click", () => {
  sessionStorage.removeItem("gaugeOwnerKey");
  allAssets = [];
  allActions = [];
  allProof = [];
  allCorrections = [];
  allIntakes = [];
  intakeStats = {};
  intakeDecisionForm.hidden = true;
  rows.innerHTML = '<tr><td colspan="6">Owner session locked.</td></tr>';
  intakeQueue.innerHTML = '<p class="empty-state">Owner session locked. Reload to authenticate.</p>';
  renderMetrics();
  syncStatus.textContent = "Owner session locked and key removed from this tab.";
});

loadRegistry().catch((error) => {
  rows.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
  intakeQueue.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  syncStatus.textContent = error.message;
});
