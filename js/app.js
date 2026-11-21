// Main UI controller for the Tinkercad STL Pre-Check web application.

import { PRINTERS } from "./printers.js";
import { StlViewer, GROUP_COLORS } from "./viewer.js";
import { makePassingExampleStl, makeFloatingExampleStl, makeTooSlowExampleStl } from "./samples.js";
import { formatMinutes, calculateCoins } from "./format.js";
import { questionFor, compareChecks } from "./learning.js";
import { fixAccepted, badIds } from "./fix.js";
import { generateOrcaPreset } from "./preset.js";
import { buildPauseProject } from "./threemf.js";
import { parseStl } from "./stl.js";
import { STORE_FIDGETS } from "./store-catalog.js";

const params = new URLSearchParams(window.location.search);
const maxMinutes = Math.max(1, Math.min(600, Number(params.get("max")) || 30));
const requireLearning = params.get("learn") === "required";
const fixOff = params.get("fix") === "off";
let currentBuffer = null;
let currentFileName = "";
let lastReport = null;
let worker = null;
let requestId = 0;
let activeLegendItem = null;
let previousCheck = null;
let watchdog = null;
let fixing = null, fixNotice = null, fixUrl = null;
// Chromebooks have little memory; Tinkercad models are normally well under 10 MB.
const MAX_FILE_MB = 30;
const WATCHDOG_MS = 180000;

// Initialize DOM elements
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const maxBadge = document.getElementById("max-badge");
const progressBox = document.getElementById("progress-box");
const progressText = document.getElementById("progress-text");
const progressFill = document.getElementById("progress-fill");
const verdictCard = document.getElementById("verdict-card");
const checksList = document.getElementById("checks-list");
const statsBar = document.getElementById("stats-bar");
const comparison = document.getElementById("comparison");
const resetCamBtn = document.getElementById("reset-cam-btn");
const isolateHighlightBtn = document.getElementById("isolate-highlight-btn");
const canvas = document.getElementById("viewer-canvas");
const legendModel = document.getElementById("legend-model");
const legendModelDot = document.getElementById("legend-model-dot");
const legendHighlight = document.getElementById("legend-highlight");
const legendHighlightDot = document.getElementById("legend-highlight-dot");
const legendModelLabel = document.getElementById("legend-model-label");
const legendHighlightAction = document.getElementById("legend-highlight-action");
const legendHighlightLabel = document.getElementById("legend-highlight-label");

// View switcher elements
const tabCheck = document.getElementById("tab-check");
const tabStore = document.getElementById("tab-store");
const checkPane = document.getElementById("check-pane");
const storePane = document.getElementById("store-pane");
const storeGrid = document.getElementById("store-grid");

const viewer = new StlViewer(canvas);

// Configure class time limit and base coin ticket
const defaultCoins = calculateCoins(0, maxMinutes).coins;
maxBadge.textContent = `${maxMinutes} min max (🪙 ${defaultCoins} coins), PLA, single color`;
document.getElementById("max-mb").textContent = MAX_FILE_MB;
document.getElementById("sample-slow").textContent = `Over ${maxMinutes}-Min Limit`;
viewer.setBed(PRINTERS.p1s.bed);

// Drag-and-drop + file picker
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

// Sample buttons
document.getElementById("sample-pass").addEventListener("click", () => {
  loadBuffer(makePassingExampleStl(), "Tinkercad_Trophy_Pass.stl");
});
document.getElementById("sample-float").addEventListener("click", () => {
  loadBuffer(makeFloatingExampleStl(), "Tinkercad_Floating_Roof.stl");
});
document.getElementById("sample-slow").addEventListener("click", () => {
  loadBuffer(makeTooSlowExampleStl(), "Tinkercad_Huge_Block.stl");
});

// View switcher (Check My Design vs Fidget Store)
let storeRendered = false;
let activeStoreCard = null;

function switchView(view) {
  const isStore = view === "store";
  tabCheck?.classList.toggle("active", !isStore);
  tabStore?.classList.toggle("active", isStore);
  if (checkPane) checkPane.hidden = isStore;
  if (storePane) storePane.hidden = !isStore;
  if (isStore) {
    renderStore();
    if (window.location.hash !== "#store") {
      history.replaceState(null, "", "#store");
    }
  } else {
    if (window.location.hash === "#store") {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }
}

tabCheck?.addEventListener("click", () => switchView("check"));
tabStore?.addEventListener("click", () => switchView("store"));
window.addEventListener("hashchange", () => {
  switchView(window.location.hash === "#store" ? "store" : "check");
});
if (window.location.hash === "#store") {
  switchView("store");
}

function renderStore() {
  if (storeRendered || !storeGrid) return;
  storeRendered = true;
  storeGrid.innerHTML = "";

  for (const item of STORE_FIDGETS) {
    const card = document.createElement("article");
    card.className = "fidget-card";
    card.id = `fidget-card-${item.id}`;

    const tagsHtml = item.tags.map((t) => `<span class="fidget-tag">${escapeHtml(t)}</span>`).join("");
    const dimsText = `${item.dimensionsMm[0]} × ${item.dimensionsMm[1]} × ${item.dimensionsMm[2]} mm`;

    card.innerHTML = `
      <div class="fidget-header">
        <div class="fidget-title-group">
          <h3>${escapeHtml(item.name)}</h3>
          <div class="fidget-tags">${tagsHtml}</div>
        </div>
        <div class="fidget-cost-badge">🪙 ${item.coins} Coins</div>
      </div>
      <p class="fidget-desc">${escapeHtml(item.description)}</p>
      <div class="fidget-meta">
        <span>⏱️ ~${item.timeMinutes} min</span>
        <span>📐 ${dimsText}</span>
        <span>✨ ${escapeHtml(item.highlights)}</span>
      </div>
      <div class="fidget-actions">
        <button type="button" class="btn-inspect" data-id="${item.id}">👁️ Inspect in 3D</button>
        <a href="${item.stlPath}" download="${item.id}.stl" class="btn-download-stl">📥 Download STL</a>
      </div>
    `;

    const inspectBtn = card.querySelector(".btn-inspect");
    inspectBtn.addEventListener("click", async () => {
      if (activeStoreCard) activeStoreCard.classList.remove("active-preview");
      card.classList.add("active-preview");
      activeStoreCard = card;

      inspectBtn.disabled = true;
      inspectBtn.textContent = "Loading 3D...";
      try {
        const resp = await fetch(item.stlPath);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        loadBuffer(buf, `${item.name}.stl`);
      } catch (err) {
        showError(`Could not load ${item.name}: ${err.message}`);
      } finally {
        inspectBtn.disabled = false;
        inspectBtn.textContent = "👁️ Inspect in 3D";
      }
    });

    storeGrid.appendChild(card);
  }
}

resetCamBtn.addEventListener("click", () => {
  if (lastReport?.size) viewer.fitCamera(lastReport.size);
});
function toggleFocus() {
  const focused = viewer.setIsolated(!viewer.isolated);
  isolateHighlightBtn.textContent = focused ? "Show Whole Model" : "Zoom to Issue";
  updateLegend();
}
isolateHighlightBtn.addEventListener("click", toggleFocus);
legendHighlight.addEventListener("click", () => { if (viewer.isolateFaces?.length) toggleFocus(); });

async function handleFile(file) {
  const id = ++requestId;
  resetReport();
  if (!/\.stl$/i.test(file.name)) {
    fileInput.value = "";
    showError(`"${file.name}" is not an .stl file. In Tinkercad, click Export, choose .STL (not OBJ or the zipped download), then upload that file.`);
    return;
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    fileInput.value = "";
    showError(`This file is over ${MAX_FILE_MB} MB, which is too big to check in the browser. Export only your model from Tinkercad, or simplify it.`);
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    if (id === requestId) loadBuffer(buf, file.name);
  } catch {
    if (id === requestId) showError("Could not read this file. Try selecting it again.");
  }
  fileInput.value = "";
}

function loadBuffer(buffer, fileName) {
  ++requestId;
  fixing = fixNotice = null; // a half-finished fix must not judge the next file
  currentBuffer = buffer;
  currentFileName = fileName;
  runAnalysis(buffer, fileName);
}

function runAnalysis(buffer, fileName, apply) {
  resetReport();
  viewer.setIsolated(false);
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

  progressBox.hidden = false;
  progressText.textContent = `Checking ${fileName}...`;
  progressFill.style.width = "5%";
  verdictCard.hidden = true;
  isolateHighlightBtn.hidden = true;
  isolateHighlightBtn.textContent = "Zoom to Issue";

  // Send a copy of the buffer so it remains available for another analysis.
  const copy = buffer.slice(0);
  watchdog = setTimeout(() => {
    fixing = fixNotice = null;
    resetReport();
    showError("Checking took too long, so it was stopped. The model may be too detailed for this device. Simplify it in Tinkercad and try again.");
  }, WATCHDOG_MS);
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === "progress") {
      progressText.textContent = msg.stage;
      progressFill.style.width = `${Math.round(msg.pct * 100)}%`;
    } else if (msg.type === "error") {
      fixing = fixNotice = null;
      clearTimeout(watchdog);
      progressBox.hidden = true;
      showError(msg.message);
    } else if (msg.type === "done") {
      clearTimeout(watchdog);
      progressBox.hidden = true;
      lastReport = msg;
      if (fixing) {
        const f = fixing; fixing = null;
        const after = badIds(msg.results);
        if (!msg.fixedStl || !fixAccepted(f.before, after)) { fixNotice = { bad: true }; runAnalysis(currentBuffer, f.name); return; }
        fixNotice = { applied: msg.applied, stl: msg.fixedStl, name: f.name };
      }
      renderReport(msg, previousCheck);
      if (fixNotice) { showFixNotice(fixNotice); fixNotice = null; }
      previousCheck = { fileName: msg.fileName, results: msg.results.map(({ id, status, title }) => ({ id, status, title })) };
    }
  };
  worker.onerror = (err) => {
    fixing = fixNotice = null;
    clearTimeout(watchdog);
    progressBox.hidden = true;
    showError(err?.message || "Something went wrong while checking the STL.");
  };
  worker.postMessage({
    buffer: copy,
    fileName,
    maxMinutes,
    apply,
  }, [copy]);
}

function resetReport() {
  clearTimeout(watchdog);
  if (fixUrl) { URL.revokeObjectURL(fixUrl); fixUrl = null; }
  if (worker) { worker.terminate(); worker = null; }
  lastReport = null;
  activeLegendItem = null;
  progressBox.hidden = true;
  verdictCard.hidden = true;
  statsBar.hidden = true;
  comparison.hidden = true;
  comparison.innerHTML = "";
  checksList.innerHTML = "";
  isolateHighlightBtn.hidden = true;
  viewer.setIsolated(false);
  viewer.setModel(null, [60, 60, 40]);
  updateLegend();
}

function updateLegend() {
  const selected = activeLegendItem;
  legendModel.hidden = !lastReport;
  legendModelLabel.textContent = viewer.isolated ? "Rest of model (faded)" : "Model";
  legendModelDot.className = `dot ${selected ? "dot-gray" : "dot-blue"}`;
  legendHighlight.hidden = !selected;
  if (selected) {
    const color = ["red", "orange", "purple"].includes(selected.highlight.color) ? selected.highlight.color : "red";
    legendHighlightDot.className = `dot dot-${color}`;
    // Separate pieces each get their own swatch (up to 6), matching their colours on the model.
    legendHighlight.querySelectorAll(".dot-extra").forEach((el) => el.remove());
    const groups = selected.highlight.groups;
    if (groups?.length > 1) {
      const css = (i) => `rgb(${GROUP_COLORS[i % GROUP_COLORS.length].map((v) => Math.round(v * 255)).join(",")})`;
      legendHighlightDot.style.background = css(0);
      let anchor = legendHighlightDot;
      for (let i = 1; i < Math.min(groups.length, 6); i++) {
        const dot = document.createElement("i");
        dot.className = "dot dot-extra";
        dot.style.background = css(i);
        anchor.after(dot);
        anchor = dot;
      }
    } else {
      legendHighlightDot.style.background = "";
    }
    legendHighlightLabel.textContent = selected.title;
    const canFocus = viewer.isolateFaces?.length > 0;
    legendHighlight.disabled = !canFocus;
    legendHighlight.setAttribute("aria-pressed", String(viewer.isolated));
    legendHighlight.title = viewer.isolated ? "Zoom back out to the whole model" : "Zoom in on this issue";
    legendHighlightAction.textContent = !canFocus ? "" : viewer.isolated ? "Click to zoom out" : "Click to zoom in";
  }
}

function showError(message) {
  verdictCard.hidden = false;
  verdictCard.className = "verdict-card fail";
  verdictCard.innerHTML = `
    <div class="verdict-header">
      <span class="verdict-pill fail">CANNOT READ FILE</span>
      <h2>Could not check this file</h2>
    </div>
    <p class="verdict-summary">${escapeHtml(message)}</p>
  `;
  checksList.innerHTML = "";
}

function renderReport(rep, previous) {
  document.querySelector(".panel-left").scrollTop = 0;
  viewer.setBed(PRINTERS.p1s.bed);
  viewer.setModel(rep.placedPos, rep.size);

  const [sx, sy, sz] = rep.size || [0, 0, 0];
  const estimates = rep.estimates;
  const fittingEstimates = estimates.filter(e => e.fits);
  const rangeEstimates = fittingEstimates.length ? fittingEstimates : estimates;
  const minMinutes = Math.min(...rangeEstimates.map((e) => e.slice.minutes));
  const maxEstimate = Math.max(...rangeEstimates.map((e) => e.slice.minutes));
  const minDisplay = formatMinutes(minMinutes);
  const maxDisplay = formatMinutes(maxEstimate);

  statsBar.hidden = false;
  // Within a minute the two printers are effectively the same, so show one time.
  const noneFit = !fittingEstimates.length;
  const timeText = noneFit ? "Too large to print" : maxEstimate - minMinutes <= 1 ? `about ${maxDisplay}` : `${minDisplay} to ${maxDisplay}`;
  const coinsInfo = calculateCoins(minMinutes, rep.maxMinutes || maxMinutes);
  const costText = noneFit ? "n/a" : `🪙 ${coinsInfo.label}`;
  // Collapsed by default so the 3D view gets the room; a fresh report rebuilds it closed.
  statsBar.innerHTML = `
    <summary><span>File details</span><span class="stats-peek">${escapeHtml(rep.fileName)}, ${timeText} (${costText})</span></summary>
    <div class="stats-grid">
    <div class="stat-file"><span class="stat-label">File</span><strong>${escapeHtml(rep.fileName)}</strong></div>
    <div><span class="stat-label">Dimensions</span><strong>${sx.toFixed(0)} × ${sy.toFixed(0)} × ${sz.toFixed(0)} mm</strong></div>
    <div><span class="stat-label">${fittingEstimates.length ? "Estimated Time (printers that fit)" : "Estimated Time"}</span><strong>${timeText}</strong></div>
    <div><span class="stat-label">Print Cost</span><strong>${costText}</strong></div>
    <div><span class="stat-label">PLA</span><strong>${noneFit ? "n/a" : `~${Math.max(1, Math.round(rangeEstimates[0].slice.filamentG))} g`}</strong></div>
    </div>
  `;

  verdictCard.hidden = false;
  const fails = rep.results.filter((r) => r.status === "fail");
  const warns = rep.results.filter((r) => r.status === "warn");
  const questions = rep.results.filter(questionFor);

  if (rep.verdict === "pass") {
    verdictCard.className = "verdict-card pass";
    verdictCard.innerHTML = `
      <div class="verdict-header">
        <span class="verdict-pill pass">READY TO SUBMIT</span>
        <h2>Ready for teacher review</h2>
      </div>
      <p class="verdict-summary">
        Your model passes the printability checks. Print time depends on which printer the teacher uses; see both estimates below.${warns.length ? ` Check the ${warns.length} warning${warns.length === 1 ? "" : "s"} below.` : ""}
      </p>
      ${renderEstimateList(estimates, rep.maxMinutes)}
    `;
  } else if (rep.verdict === "review") {
    verdictCard.className = "verdict-card review";
    verdictCard.innerHTML = `<div class="verdict-header"><span class="verdict-pill review">TEACHER REVIEW NEEDED</span><h2>Print time is close to the limit</h2></div><p class="verdict-summary">Share this file with your teacher and ask them to confirm the print time in their slicer. Estimates can be inaccurate.${warns.length > 1 ? " Check the other warnings below too." : ""}</p>${renderEstimateList(estimates, rep.maxMinutes)}`;
  } else {
    verdictCard.className = "verdict-card fail";
    verdictCard.innerHTML = `
      <div class="verdict-header">
        <span class="verdict-pill fail">NEEDS FIXES (${fails.length} ISSUE${fails.length === 1 ? "" : "S"})</span>
        <h2>Fix ${fails.length === 1 ? "this problem" : `these ${fails.length} problems`} in Tinkercad, then re-upload</h2>
      </div>
      <p class="verdict-summary">
        Use "Show on 3D model" where available to locate a problem. Other checks describe the next step below.
      </p>
      ${renderEstimateList(estimates, rep.maxMinutes)}
    `;
  }

  if (questions.length) {
    verdictCard.insertAdjacentHTML("beforeend", `<p class="learning-progress" role="status" aria-live="polite"></p>`);
    updateLearningProgress(new Set(), questions.length, rep.verdict);
  }

  if (rep.traits) {
    const t = rep.traits;
    const presetObj = generateOrcaPreset(rep.fileName ? rep.fileName.replace(/\.stl$/i, "") : "Model", "ad5m", t);
    const presetDataUri = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(presetObj, null, 2));
    const presetFileName = (rep.fileName ? rep.fileName.replace(/\.stl$/i, "") : "model") + ".orca.json";

    verdictCard.insertAdjacentHTML("beforeend", `
      <div class="preset-recommendations">
        <h4 class="preset-title preset-title-caps">⚙️ Recommended Slicer Settings</h4>
        <ul class="preset-list">
          <li><strong>Layer Height:</strong> ${t.recommendedLayerHeight} mm ${t.isRelief ? "(fine vertical relief detected)" : "(standard)"}</li>
          <li><strong>Wall Generator:</strong> ${t.wallGenerator === "arachne" ? "<strong>Arachne</strong> (preserves text & contours down to one nozzle line)" : "Classic"}</li>
          ${t.reliefTooFine ? `<li><strong>Raised text:</strong> finer than the nozzle. No slicer setting fixes this; enlarge or embolden it (see the checks below).</li>` : ""}
          <li><strong>Supports & Brim:</strong> ${t.needsSupport ? "Supports enabled" : "0 supports, no brim (flat bed adhesion)"}</li>
          ${(t.colorChanges ?? []).map((c, i) => `<li><strong>Layer Pause:</strong> before layer ${c.layerIdx} (Z = ${c.layerTopMm} mm @ ${t.recommendedLayerHeight} mm layers; ${i ? "upper tier" : "relief"} starts at ${c.zMm} mm) — ${c.dropPct}% area transition for 2-color filament swap</li>`).join("")}
        </ul>
        <a class="btn-tool preset-btn" href="${presetDataUri}" download="${presetFileName}">
          📥 Download OrcaSlicer Preset (.json)
        </a>
        ${t.colorChanges?.length ? `
        <div class="two-color">
          <h4 class="preset-title">🎨 Two-color print, one extruder</h4>
          <p class="preset-note">The preset above can't hold a pause, so a pause added by hand is easy to lose. This project file already has it: in OrcaSlicer use <strong>File &gt; Open Project</strong> (not Import), keep the Flashforge AD5M printer, slice, and the printer stops at the pause so you can swap filament. Check the slider shows the orange pause marker before you print.</p>
          <label class="preset-note two-color-label">Other parts for the same plate (optional, e.g. the other side of a two-sided model):
            <input type="file" class="two-color-extra" accept=".stl" multiple>
          </label>
          <div class="two-color-buttons">${t.colorChanges.map((c, i) => `<button type="button" class="btn-tool two-color-dl preset-btn" data-z="${c.layerTopMm}">📥 Project (.3mf): pause before layer ${c.layerIdx} (Z ${c.layerTopMm} mm), ${i === t.colorChanges.length - 1 && i > 0 ? "colors only the tallest items" : i ? "colors the next tier up" : "colors everything raised"}</button>`).join("")}</div>
        </div>` : ""}
      </div>
    `);
    const box = verdictCard.querySelector(".two-color");
    box?.querySelectorAll(".two-color-dl").forEach((btn) => btn.addEventListener("click", async () => {
      const base = (rep.fileName || "model").replace(/\.stl$/i, "");
      try {
        const parts = [{ name: base, pos: parseStl(currentBuffer) }];
        for (const f of box.querySelector(".two-color-extra").files) parts.push({ name: f.name.replace(/\.stl$/i, ""), pos: parseStl(await f.arrayBuffer()) });
        // Project settings make Orca's GUI keep the pause (without them it loads geometry only).
        const projectSettings = await (await fetch(new URL("./orca-project-ad5m.json", import.meta.url))).json();
        const bytes = buildPauseProject(parts, { pauseZ: [Number(btn.dataset.z)], layerHeight: t.recommendedLayerHeight, bed: PRINTERS.ad5m.bed, projectSettings });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes], { type: "model/3mf" }));
        a.download = `${base}-2color-z${btn.dataset.z}.3mf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) {
        showError(`Couldn't build the project file: ${e.message}`);
      }
    }));
  }

  const changes = compareChecks(previous, rep);
  if (changes) {
    const fixed = changes.fixed.map(x => escapeHtml(x.title)).join("; ");
    const remaining = changes.remaining.map(x => escapeHtml(x.title)).join("; ");
    comparison.hidden = false;
    comparison.innerHTML = `<h2>Since the previous check</h2><p>Comparing ${escapeHtml(previous.fileName)} with ${escapeHtml(rep.fileName)}. Check that these are versions of the same design.</p><p>${fixed ? `Now passing: ${fixed}.` : "No earlier issues are confirmed as passing."} ${remaining ? `Still reported: ${remaining}.` : ""}</p><p>Checks are estimates; review the current results below.</p>`;
  }

  // Sort results: fail first, then warn, then pass, then info
  const order = { fail: 0, warn: 1, pass: 2, info: 3 };
  const sorted = [...rep.results].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  checksList.innerHTML = "";
  let firstFailHighlight = null;
  let firstFailEl = null;
  const answered = new Set();
  // Passing and info cards stay out of the way until asked for.
  const quiet = document.createElement("details");
  quiet.className = "quiet-checks";

  for (const item of sorted) {
    const hasHi = !!(item.highlight && ((item.highlight.faces && item.highlight.faces.length) || (item.highlight.segments && item.highlight.segments.length)));
    const div = document.createElement("div");
    div.className = `check-item status-${item.status}${hasHi ? " clickable" : ""}`;
    const badgeLabel = { fail: "FAIL", warn: "WARN", pass: "PASS", info: "INFO" }[item.status] || item.status.toUpperCase();
    div.innerHTML = `
      <div class="check-top">
        <span class="check-badge ${item.status}">${badgeLabel}</span>
        <h3 class="check-title">${escapeHtml(item.title)}</h3>
        ${hasHi ? `<button type="button" class="highlight-btn">Show on 3D model</button>` : ""}
      </div>
      <p class="check-msg">${escapeHtml(item.message)}</p>
      ${item.fix && !questionFor(item) ? `<div class="check-fix"><strong>How to fix in Tinkercad:</strong> ${escapeHtml(item.fix)}</div>` : ""}
    `;
    const question = questionFor(item);
    let fixBtn = null; // shown once the required learning question is answered
    if (question) {
      const details = document.createElement("details");
      details.className = "learning-question";
      const order = item.id.length % 2 ? [1, 0, 2] : [2, 1, 0];
      details.innerHTML = `<summary>Think about it${requireLearning ? " (required by teacher)" : " (optional)"}</summary><fieldset><legend>${escapeHtml(question.question)}</legend>${order.map(i => `<label><input type="radio" name="question-${escapeHtml(item.id)}" value="${i}"> ${escapeHtml(question.choices[i])}</label>`).join("")}</fieldset><details class="learning-hint"><summary>Show a hint</summary><p>${escapeHtml(question.hint)}</p></details><button type="button" class="btn-secondary learning-answer">Show answer</button><p class="learning-feedback" role="status" aria-live="polite"></p>`;
      details.addEventListener("click", e => e.stopPropagation());
      const feedback = details.querySelector(".learning-feedback");
      details.querySelector("fieldset").addEventListener("change", e => {
        if (e.target.value === "0") {
          answered.add(item.id);
          feedback.textContent = `Correct. ${question.explanation}`;
        } else {
          answered.delete(item.id);
          feedback.textContent = "Not quite. Try the hint or choose another answer.";
        }
        updateLearningProgress(answered, questions.length, rep.verdict);
        if (fixBtn && requireLearning) fixBtn.hidden = !answered.has(item.id);
      });
      details.querySelector(".learning-answer").addEventListener("click", () => {
        feedback.textContent = `Answer: ${question.choices[0]}. ${question.explanation} Select that answer to complete this question.`;
      });
      div.appendChild(details);
      if (item.fix) {
        const repair = document.createElement("details");
        repair.className = "repair-steps";
        repair.innerHTML = `<summary>Show repair steps</summary><div class="check-fix"><strong>How to fix in Tinkercad:</strong> ${escapeHtml(item.fix)}</div>`;
        repair.addEventListener("click", e => e.stopPropagation());
        div.appendChild(repair);
      }
    }
    if (item.noFix && !fixOff) {
      const note = document.createElement("p");
      note.className = "no-fix";
      note.textContent = item.noFix;
      div.appendChild(note);
    }
    if (item.fixable && !fixOff) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "btn-secondary", textContent: "Fix it for me" });
      b.hidden = requireLearning && !!question;
      fixBtn = b;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fixing = { before: new Set(badIds(rep.results)), name: rep.fileName };
        runAnalysis(currentBuffer, rep.fileName, item.fixable === "lower" ? { lower: true } : { scale: item.fixScale });
      });
      div.appendChild(b);
    }
    if (hasHi) {
      div.addEventListener("click", () => {
        for (const el of checksList.querySelectorAll(".check-item.active-highlight")) {
          el.classList.remove("active-highlight");
        }
        div.classList.add("active-highlight");
        viewer.setIsolated(false);
        isolateHighlightBtn.textContent = "Zoom to Issue";
        const canIsolate = viewer.setHighlight(item.highlight);
        activeLegendItem = item;
        updateLegend();
        isolateHighlightBtn.hidden = !canIsolate;
      });
      if (item.status === "fail" && !firstFailHighlight) {
        firstFailHighlight = item.highlight;
        firstFailEl = div;
      }
    }
    (item.status === "fail" || item.status === "warn" ? checksList : quiet).appendChild(div);
  }
  const quietCount = quiet.children.length;
  if (quietCount) {
    const label = document.createElement("summary");
    label.textContent = `${quietCount} passing or info check${quietCount === 1 ? "" : "s"} (show)`;
    quiet.prepend(label);
    quiet.open = !checksList.children.length; // nothing else to show: open it
    checksList.appendChild(quiet);
  }

  // Automatically highlight the first failure on the 3D model so the student sees it immediately
  if (firstFailHighlight && firstFailEl) {
    firstFailEl.classList.add("active-highlight");
    isolateHighlightBtn.hidden = !viewer.setHighlight(firstFailHighlight);
    activeLegendItem = sorted.find(item => item.highlight === firstFailHighlight);
  }
  updateLegend();
}

function showFixNotice(n) {
  const banner = document.createElement("div");
  banner.className = `fix-banner${n.bad ? " bad" : ""}`;
  if (n.bad) {
    banner.innerHTML = `<p><strong>Couldn't fix this automatically.</strong> Follow the steps below.</p>`;
  } else {
    if (fixUrl) URL.revokeObjectURL(fixUrl);
    fixUrl = URL.createObjectURL(new Blob([n.stl], { type: "model/stl" }));
    banner.innerHTML = `<p><strong>Fixed and checked again:</strong></p><ul>${n.applied.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
      <p><a class="btn-secondary" href="${fixUrl}" download="${escapeHtml(n.name.replace(/\.stl$/i, ""))}-fixed.stl">Download fixed STL</a></p>
      <p>Your Tinkercad project is not changed. Make the same change there too, or print this fixed file.</p>`;
  }
  checksList.prepend(banner);
}

function updateLearningProgress(answered, total, verdict) {
  const el = verdictCard.querySelector(".learning-progress");
  if (!el) return;
  const remaining = total - answered.size;
  el.textContent = requireLearning
    ? remaining ? `Teacher requires the learning questions: ${answered.size} of ${total} completed. Open each "Think about it" question below.` : "Learning questions completed. Your teacher still reviews the model."
    : `Optional learning questions: ${answered.size} of ${total} completed.`;
  if (requireLearning && verdict === "pass") {
    const pill = verdictCard.querySelector(".verdict-pill");
    const heading = verdictCard.querySelector("h2");
    pill.textContent = remaining ? "QUESTIONS TO COMPLETE" : "READY TO SUBMIT";
    heading.textContent = remaining ? "Complete the learning questions" : "Ready for teacher review";
  }
}

function renderEstimateList(estimates, limit) {
  return `<div class="time-breakdown">${estimates.map(({ printer, slice, fits }) => {
    if (slice.skipped) return `<span><strong>${escapeHtml(printer.name)}:</strong> too large to print</span>`;
    const time = formatMinutes(slice.minutes);
    const printerCoins = calculateCoins(slice.minutes, limit);
    const fitLabel = fits ? "fits" : "too large";
    const limitText = formatMinutes(limit);
    const limitLabel = slice.minutes <= limit ? `within ${limitText} limit` : `over ${limitText} limit`;
    return `<span><strong>${escapeHtml(printer.name)}:</strong> ${time} (🪙 ${printerCoins.label}), ${fitLabel}, ${limitLabel}</span>`;
  }).join("")}</div>`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "More results below" cue: shown while the sidebar has content out of view.
const sidebar = document.querySelector(".panel-left");
const scrollMore = document.getElementById("scroll-more");
let moreQueued = false;
function updateScrollMore() {
  moreQueued = false;
  scrollMore.hidden = sidebar.scrollHeight - sidebar.scrollTop - sidebar.clientHeight < 24;
}
function queueScrollMore() {
  if (!moreQueued) { moreQueued = true; requestAnimationFrame(updateScrollMore); }
}
sidebar.addEventListener("scroll", queueScrollMore, { passive: true });
sidebar.addEventListener("toggle", queueScrollMore, true);
window.addEventListener("resize", queueScrollMore);
new MutationObserver(queueScrollMore).observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
document.getElementById("scroll-more-btn").addEventListener("click", () => {
  sidebar.scrollBy({ top: sidebar.clientHeight * 0.8, behavior: "smooth" });
});
queueScrollMore();
