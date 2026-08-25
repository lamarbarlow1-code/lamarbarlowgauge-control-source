const rows = document.getElementById("assetRows");
const syncButton = document.getElementById("syncButton");
const reloadButton = document.getElementById("reloadButton");
const syncStatus = document.getElementById("syncStatus");
const nextActions = document.getElementById("nextActions");
const proofLog = document.getElementById("proofLog");
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

let allAssets = [];
let allActions = [];
let allProof = [];
let allCorrections = [];
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
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function ownerKey() {
  let key = sessionStorage.getItem("gaugeOwnerKey") || "";
  if (!key) {
    key = (prompt("Enter the GS&D owner key.") || "").trim();
    if (key) sessionStorage.setItem("gaugeOwnerKey", key);
  }
  return key;
}

async function gaugeRequest(options = {}) {
  const key = ownerKey();
  if (!key) throw new Error("Owner key required.");

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
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Gauge controller request failed.");
  }

  return data;
}

function statusClass(status) {
  return safeText(status).replaceAll(" ", "");
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleString();
}

function renderAssets() {
  const assets = currentFilter === "All"
    ? allAssets
    : allAssets.filter((asset) => asset.asset_type === currentFilter);

  if (!assets.length) {
    rows.innerHTML = `<tr><td colspan="6">No assets found for ${currentFilter}.</td></tr>`;
    return;
  }

  rows.innerHTML = assets.map((asset) => {
    const cleanedUrl = safeUrl(asset.asset_url);
    const url = cleanedUrl
      ? `<a href="${cleanedUrl}" target="_blank" rel="noreferrer">Open</a>`
      : "—";

    return `
      <tr>
        <td>${escapeHtml(asset.asset_name)}</td>
        <td>${escapeHtml(asset.asset_type)}</td>
        <td><span class="badge ${statusClass(asset.status)}">${escapeHtml(asset.status)}</span></td>
        <td>${url}</td>
        <td>${escapeHtml(asset.notes)}</td>
        <td>${asset.last_checked_at ? new Date(asset.last_checked_at).toLocaleString() : "Not checked"}</td>
      </tr>
    `;
  }).join("");
}

function renderActions(actions = allActions) {
  if (!actions.length) {
    nextActions.innerHTML = "<li>No next actions yet. Press Sync Gauge Stack.</li>";
    return;
  }

  nextActions.innerHTML = actions.slice(0, 30).map((item) => `
    <li>
      <strong>${escapeHtml(item.status)}</strong> —
      ${escapeHtml(item.action_text)}
    </li>
  `).join("");
}

function renderProof() {
  if (!allProof.length) {
    proofLog.innerHTML = "<li>No proof log yet. Press Sync Gauge Stack.</li>";
    return;
  }

  proofLog.innerHTML = allProof.slice(0, 25).map((item) => `
    <li>
      <strong>${new Date(item.created_at).toLocaleString()}</strong> —
      ${escapeHtml(item.asset_type)} / ${escapeHtml(item.asset_name)} —
      ${escapeHtml(item.status)}
    </li>
  `).join("");
}

function renderCorrectionTargets() {
  const selected = correctionAsset.value;
  correctionAsset.innerHTML = [
    '<option value="">Select a governed asset</option>',
    ...allAssets.map((asset) => (
      `<option value="${escapeHtml(asset.id)}">${escapeHtml(asset.asset_type)} / ${escapeHtml(asset.asset_name)}</option>`
    )),
  ].join("");

  if (allAssets.some((asset) => asset.id === selected)) {
    correctionAsset.value = selected;
  }
}

function renderCorrections() {
  if (!allCorrections.length) {
    correctionsLog.innerHTML = "<li>No corrections recorded yet.</li>";
    return;
  }

  correctionsLog.innerHTML = allCorrections.slice(0, 100).map((item) => `
    <li>
      <strong>${formatDate(item.created_at)}</strong> —
      ${escapeHtml(item.correction_type)} / ${escapeHtml(item.target_asset_name)}<br />
      ${escapeHtml(item.previous_state || "No prior state recorded")} →
      ${escapeHtml(item.corrected_state)}<br />
      ${escapeHtml(item.correction_text)}
      ${item.proof_ref ? `<br />Proof: ${escapeHtml(item.proof_ref)}` : ""}
      <br /><span class="correction-hash">SHA-256 ${escapeHtml(item.content_hash)}</span>
    </li>
  `).join("");
}

async function loadRegistry() {
  syncStatus.textContent = "Reading registry…";

  const data = await gaugeRequest();

  allAssets = data.assets || [];
  allActions = data.actions || [];
  allProof = data.proof_log || [];
  allCorrections = data.corrections || [];

  renderAssets();
  renderActions();
  renderProof();
  renderCorrectionTargets();
  renderCorrections();

  syncStatus.textContent = `Loaded ${allAssets.length} assets and ${allCorrections.length} corrections.`;
}

async function syncGaugeStack() {
  syncButton.disabled = true;
  syncStatus.textContent = "Syncing Gauge Stack…";

  try {
    const data = await gaugeRequest({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "sync" }),
    });

    syncStatus.textContent = `${data.message} Checked ${data.checked_count} assets.`;
    renderActions(data.results || []);
    await loadRegistry();
  } catch (error) {
    syncStatus.textContent = error.message || "Gauge sync failed.";
  } finally {
    syncButton.disabled = false;
  }
}

async function recordCorrection(event) {
  event.preventDefault();
  recordCorrectionButton.disabled = true;
  correctionStatus.textContent = "Recording correction and preserving proof…";

  try {
    const data = await gaugeRequest({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "addCorrection",
        correction: {
          target_asset_id: correctionAsset.value,
          correction_type: correctionType.value,
          previous_state: previousState.value,
          corrected_state: correctedState.value,
          correction_text: correctionText.value,
          proof_ref: correctionProof.value,
        },
      }),
    });

    correctionStatus.textContent = data.deduped
      ? "Exact correction already exists; no duplicate was added."
      : "Correction recorded and proof preserved.";
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

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    renderAssets();
  });
});

syncButton.addEventListener("click", syncGaugeStack);
correctionForm.addEventListener("submit", recordCorrection);
reloadButton.addEventListener("click", () => loadRegistry().catch((error) => {
  syncStatus.textContent = error.message;
}));

loadRegistry().catch((error) => {
  rows.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
  syncStatus.textContent = error.message;
});
