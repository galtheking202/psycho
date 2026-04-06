"use strict";

const SIM_PART_SECONDS = 20 * 60; // 20 minutes per part

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  pdfId:      null,
  answerKey:  null,
  userAnswers: {},
  graded:     false,

  // Simulation
  simMode:         false,   // toggle is on
  simActive:       false,   // a simulation session is running
  simParts:        [],      // flat ordered [{sectionName,sectionKey,partLabel,slot,answers}]
  simPartIdx:      0,       // which part is currently active
  simCountdown:    SIM_PART_SECONDS,
  simCountInterval:null,
  simPartStart:    null,    // Date.now() when this part's timer started

  // Time tracking (per part)
  answerLog: [],   // [{slot,q,val,partElapsed_ms,sectionName,partLabel,partIdx}]
  partTimes: [],   // [total_ms_used_per_part]  indexed by part
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const pdfSelect        = $("pdf-select");
const gradeBtn         = $("grade-btn");
const progressBadge    = $("progress-badge");
const welcome          = $("welcome");
const appLayout        = $("app-layout");
const pdfFrame         = $("pdf-frame");
const panelLoading     = $("panel-loading");
const panelError       = $("panel-error");
const panelErrorMsg    = $("panel-error-msg");
const answerSections   = $("answer-sections");
const resultsOverlay   = $("results-overlay");
const closeResultsBtn  = $("close-results");
const ringFill         = $("ring-fill");
const scoreNum         = $("score-num");
const scoreDenom       = $("score-denom");
const resultsBreakdown = $("results-breakdown");
const simToggle        = $("sim-toggle");
const simBar           = $("sim-bar");
const simBarSection    = $("sim-bar-section");
const simBarCounter    = $("sim-bar-counter");
const simBarPart       = $("sim-bar-part");
const simCountdownEl   = $("sim-countdown");
const simFooter        = $("sim-footer");
const simSubmitBtn     = $("sim-submit-btn");

// Auth / Stats DOM refs
const authBtn          = $("auth-btn");
const statsBtn         = $("stats-btn");
const authOverlay      = $("auth-overlay");
const closeAuthBtn     = $("close-auth");
const statsOverlay     = $("stats-overlay");
const closeStatsBtn    = $("close-stats");
const authForm         = $("auth-form");
const authUsernameEl   = $("auth-username");
const authPasswordEl   = $("auth-password");
const authSubmitEl     = $("auth-submit");
const authErrorEl      = $("auth-error");
const statsBody        = $("stats-body");

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------
const auth = {
  token:    localStorage.getItem("psycho_token"),
  username: localStorage.getItem("psycho_username"),
};
let authMode = "login"; // "login" | "register"

function updateAuthUI() {
  if (auth.token) {
    authBtn.textContent = auth.username;
    authBtn.classList.add("logged-in");
    authBtn.title = "לחץ לצאת";
  } else {
    authBtn.textContent = "כניסה";
    authBtn.classList.remove("logged-in");
    authBtn.title = "";
  }
}
updateAuthUI();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
let _allPdfs = [];

async function init() {
  try {
    _allPdfs = await api("/api/pdfs");
    await refreshPdfSelect();
  } catch {
    pdfSelect.innerHTML = `<option value="">שגיאה בטעינת רשימה</option>`;
  }
}

async function refreshPdfSelect() {
  let completedIds = new Set();
  if (auth.token) {
    try {
      const stats = await apiAuth("/api/stats");
      completedIds = new Set(stats.completed_pdf_ids);
    } catch { /* not logged in or error */ }
  }
  const cur = pdfSelect.value;
  pdfSelect.innerHTML =
    `<option value="">בחר מבחן...</option>` +
    _allPdfs.map(p => {
      const done = completedIds.has(p.id) ? " ✓" : "";
      return `<option value="${esc(p.id)}">${esc(p.name)}${done}</option>`;
    }).join("");
  if (cur) pdfSelect.value = cur;
}

// ---------------------------------------------------------------------------
// PDF selection
// ---------------------------------------------------------------------------
pdfSelect.addEventListener("change", async () => {
  const id = pdfSelect.value;
  if (!id) { showWelcome(); return; }
  await loadPdf(id);
});

async function loadPdf(id) {
  // Stop any running sim
  endSim(false);

  state.pdfId       = id;
  state.answerKey   = null;
  state.userAnswers = {};
  state.graded      = false;

  welcome.classList.add("hidden");
  appLayout.classList.remove("hidden");
  pdfFrame.src = `/api/pdf/${encodeURIComponent(id)}/file`;

  answerSections.classList.add("hidden");
  answerSections.innerHTML = "";
  panelError.classList.add("hidden");
  panelLoading.classList.remove("hidden");
  gradeBtn.disabled  = true;
  simToggle.disabled = true;
  progressBadge.classList.add("hidden");

  try {
    const key = await api(`/api/pdf/${encodeURIComponent(id)}/answers`);
    state.answerKey = key;
    panelLoading.classList.add("hidden");
    simToggle.disabled = false;      // enable sim button now that key is ready

    if (state.simMode) {
      startSim();
    } else {
      buildFullPanel(key);
      updateProgress();
      gradeBtn.disabled = false;
    }
  } catch (e) {
    panelLoading.classList.add("hidden");
    panelError.classList.remove("hidden");
    panelErrorMsg.textContent = e.message || "שגיאה לא ידועה";
  }
}

// ---------------------------------------------------------------------------
// Simulation toggle
// ---------------------------------------------------------------------------
simToggle.addEventListener("click", () => {
  console.log("[sim] clicked — simActive:", state.simActive, "simMode:", state.simMode, "hasKey:", !!state.answerKey);

  if (state.simActive) {
    if (!confirm("לצאת מהסימולציה ולאפס את הניסיון?")) return;
    endSim(true);
    return;
  }

  state.simMode = !state.simMode;
  simToggle.classList.toggle("active", state.simMode);

  if (state.simMode) {
    console.log("[sim] starting simulation…");
    startSim();
  } else {
    console.log("[sim] returning to practice mode");
    buildFullPanel(state.answerKey);
    updateProgress();
    gradeBtn.disabled = false;
    gradeBtn.classList.remove("hidden");
  }
});

// ---------------------------------------------------------------------------
// Simulation: start
// ---------------------------------------------------------------------------
function startSim() {
  console.log("[sim] startSim() — sections:", state.answerKey?.sections?.length);
  if (!state.answerKey) return;

  // Build flat ordered list of parts
  state.simParts = [];
  state.answerKey.sections.forEach(sec =>
    sec.parts.forEach(part =>
      state.simParts.push({
        sectionName: sec.name,
        sectionKey:  sec.key,
        partLabel:   part.label,
        slot:        `${sec.key}__${part.label}`,
        answers:     part.answers,
      })
    )
  );

  state.simActive   = true;
  state.simPartIdx  = 0;
  state.answerLog   = [];
  state.partTimes   = [];
  state.userAnswers = {};

  simToggle.classList.add("active");
  simToggle.textContent = "⏱ ביטול סימולציה";
  gradeBtn.classList.add("hidden");
  progressBadge.classList.add("hidden");

  console.log("[sim] parts built:", state.simParts.length, "→ showing part 0");
  showSimPart(0);
}

// ---------------------------------------------------------------------------
// Simulation: show a specific part
// ---------------------------------------------------------------------------
function showSimPart(idx) {
  state.simPartIdx = idx;
  const part = state.simParts[idx];
  const isLast = idx === state.simParts.length - 1;

  // Update sticky header
  simBarSection.textContent = part.sectionName;
  simBarCounter.textContent = `${idx + 1} / ${state.simParts.length}`;
  simBarPart.textContent    = part.partLabel;
  simBar.classList.remove("hidden");

  // Update submit button
  simSubmitBtn.textContent = isLast ? "סיים מבחן ✓" : "סיים פרק ←";
  simSubmitBtn.classList.toggle("last", isLast);
  simSubmitBtn.disabled = false;
  simFooter.classList.remove("hidden");

  // Build questions for this part only
  buildPartPanel(part);

  // Start countdown
  startPartTimer();
}

// ---------------------------------------------------------------------------
// Simulation: render only current part's questions
// ---------------------------------------------------------------------------
function buildPartPanel(part) {
  answerSections.innerHTML = "";
  const qNums = Object.keys(part.answers).sort((a, b) => +a - +b);
  qNums.forEach(qNum =>
    answerSections.appendChild(
      buildQuestionRow(part.slot, qNum, part.sectionName, part.partLabel)
    )
  );
  answerSections.classList.remove("hidden");

  // Restore any already-given answers (in case user went back - we don't allow that,
  // but this restores state if buildPartPanel is called again)
  const saved = state.userAnswers[part.slot] || {};
  Object.entries(saved).forEach(([qNum, val]) => {
    const row = answerSections.querySelector(`[data-slot="${CSS.escape(part.slot)}"][data-q="${qNum}"]`);
    if (row) row.querySelectorAll(".opt-btn").forEach(b => b.classList.toggle("selected", b.dataset.val === val));
  });
}

// ---------------------------------------------------------------------------
// Simulation: countdown
// ---------------------------------------------------------------------------
function startPartTimer() {
  clearInterval(state.simCountInterval);
  state.simCountdown = SIM_PART_SECONDS;
  state.simPartStart = Date.now();
  renderCountdown();
  state.simCountInterval = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  state.simCountdown = Math.max(0, state.simCountdown - 1);
  renderCountdown();
  if (state.simCountdown === 0) submitCurrentPart(true);
}

function renderCountdown() {
  const mm = String(Math.floor(state.simCountdown / 60)).padStart(2, "0");
  const ss = String(state.simCountdown % 60).padStart(2, "0");
  simCountdownEl.textContent = `${mm}:${ss}`;
  simCountdownEl.classList.toggle("warn",   state.simCountdown <= 300 && state.simCountdown > 60);
  simCountdownEl.classList.toggle("urgent", state.simCountdown <= 60);
}

// ---------------------------------------------------------------------------
// Simulation: submit part / finish
// ---------------------------------------------------------------------------
simSubmitBtn.addEventListener("click", () => submitCurrentPart(false));

async function submitCurrentPart(timedOut) {
  clearInterval(state.simCountInterval);
  state.simCountInterval = null;

  // Record how long this part took
  const elapsed = Date.now() - state.simPartStart;
  state.partTimes[state.simPartIdx] = elapsed;

  const isLast = state.simPartIdx === state.simParts.length - 1;

  if (isLast) {
    simSubmitBtn.disabled = true;
    await gradeSimulation();
  } else {
    // Advance to next part
    state.simPartIdx++;
    showSimPart(state.simPartIdx);
  }
}

async function gradeSimulation() {
  simSubmitBtn.textContent = "בודק…";
  simSubmitBtn.disabled    = true;

  try {
    const data = await api(`/api/pdf/${encodeURIComponent(state.pdfId)}/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: state.userAnswers }),
    });
    state.graded = true;
    showResults(data);
  } catch (e) {
    alert(`שגיאה בבדיקת התשובות: ${e.message}`);
    simSubmitBtn.textContent = "סיים מבחן ✓";
    simSubmitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Simulation: end / reset
// ---------------------------------------------------------------------------
function endSim(resetPanel) {
  clearInterval(state.simCountInterval);
  state.simCountInterval = null;
  state.simActive  = false;
  state.simParts   = [];
  state.simPartIdx = 0;
  state.answerLog  = [];
  state.partTimes  = [];

  simBar.classList.add("hidden");
  simFooter.classList.add("hidden");

  simToggle.textContent = "⏱ סימולציה";
  simToggle.classList.toggle("active", state.simMode);

  if (resetPanel && state.answerKey) {
    state.userAnswers = {};
    gradeBtn.classList.remove("hidden");
    buildFullPanel(state.answerKey);
    updateProgress();
    gradeBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Normal mode: build full panel (all sections and parts)
// ---------------------------------------------------------------------------
function buildFullPanel(key) {
  panelLoading.classList.add("hidden");
  answerSections.innerHTML = "";

  key.sections.forEach((section) => {
    const sectionEl = document.createElement("div");
    sectionEl.className = "section-block";

    const titleEl = document.createElement("div");
    titleEl.className   = "section-title";
    titleEl.textContent = section.name;
    sectionEl.appendChild(titleEl);

    section.parts.forEach((part) => {
      const partEl = document.createElement("div");
      partEl.className = "part-block";

      const partLabel = document.createElement("div");
      partLabel.className   = "part-label";
      partLabel.textContent = part.label;
      partEl.appendChild(partLabel);

      const slot = `${section.key}__${part.label}`;
      Object.keys(part.answers).sort((a, b) => +a - +b).forEach(qNum =>
        partEl.appendChild(buildQuestionRow(slot, qNum, section.name, part.label))
      );

      sectionEl.appendChild(partEl);
    });

    answerSections.appendChild(sectionEl);
  });

  answerSections.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Build a single question row (shared by both modes)
// ---------------------------------------------------------------------------
function buildQuestionRow(slot, qNum, sectionName, partLabel) {
  const row = document.createElement("div");
  row.className    = "question-row";
  row.dataset.slot = slot;
  row.dataset.q    = qNum;

  const numEl = document.createElement("span");
  numEl.className   = "q-num";
  numEl.textContent = `${qNum}.`;
  row.appendChild(numEl);

  const opts = document.createElement("div");
  opts.className = "options";

  [1, 2, 3, 4].forEach((val) => {
    const btn = document.createElement("button");
    btn.className   = "opt-btn";
    btn.textContent = val;
    btn.dataset.val = val;
    btn.addEventListener("click", () => {
      const ripple = document.createElement("span");
      ripple.className = "btn-ripple";
      btn.appendChild(ripple);
      ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
      btn.classList.remove("btn-pop");
      void btn.offsetWidth;
      btn.classList.add("btn-pop");
      onAnswer(slot, qNum, String(val), row, sectionName, partLabel);
    });
    opts.appendChild(btn);
  });

  row.appendChild(opts);
  return row;
}

// ---------------------------------------------------------------------------
// Record an answer
// ---------------------------------------------------------------------------
function onAnswer(slot, qNum, val, row, sectionName, partLabel) {
  if (state.graded) return;

  if (!state.userAnswers[slot]) state.userAnswers[slot] = {};
  state.userAnswers[slot][qNum] = val;

  // Log timing for simulation
  if (state.simActive && state.simPartStart !== null) {
    const partElapsed_ms = Date.now() - state.simPartStart;
    state.answerLog = state.answerLog.filter(e => !(e.slot === slot && e.q === qNum));
    state.answerLog.push({
      slot, q: qNum, val,
      partElapsed_ms,
      sectionName, partLabel,
      partIdx: state.simPartIdx,
    });
  }

  row.querySelectorAll(".opt-btn").forEach(btn =>
    btn.classList.toggle("selected", btn.dataset.val === val)
  );

  updateProgress();
}

// ---------------------------------------------------------------------------
// Progress badge
// ---------------------------------------------------------------------------
function updateProgress() {
  if (!state.answerKey) return;
  let answered = 0, total = 0;
  state.answerKey.sections.forEach(sec =>
    sec.parts.forEach(part => {
      const slot = `${sec.key}__${part.label}`;
      total    += Object.keys(part.answers).length;
      answered += Object.keys(state.userAnswers[slot] || {}).length;
    })
  );
  progressBadge.classList.remove("hidden");
  progressBadge.textContent = `${answered} / ${total} שאלות`;
}

// ---------------------------------------------------------------------------
// Normal grade button
// ---------------------------------------------------------------------------
gradeBtn.addEventListener("click", async () => {
  if (!state.pdfId || !state.answerKey) return;
  gradeBtn.disabled    = true;
  gradeBtn.textContent = "בודק…";
  try {
    const data = await api(`/api/pdf/${encodeURIComponent(state.pdfId)}/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: state.userAnswers }),
    });
    state.graded = true;
    applyGradeToPanel(data);
    showResults(data);
  } catch (e) {
    alert(`שגיאה בבדיקת התשובות: ${e.message}`);
  } finally {
    gradeBtn.textContent = "בדוק תשובות";
    gradeBtn.disabled    = false;
  }
});

// ---------------------------------------------------------------------------
// Apply grade colours to panel
// ---------------------------------------------------------------------------
function applyGradeToPanel(data) {
  data.results.forEach((res) => {
    Object.entries(res.details).forEach(([qNum, detail]) => {
      const row = document.querySelector(
        `.question-row[data-slot="${CSS.escape(res.slot)}"][data-q="${qNum}"]`
      );
      if (!row) return;
      row.querySelectorAll(".opt-btn").forEach((btn) => {
        btn.disabled = true;
        const v = btn.dataset.val;
        btn.classList.remove("selected");
        if      (detail.is_correct && v === detail.correct)       btn.classList.add("grade-correct");
        else if (!detail.is_correct && v === detail.given)        btn.classList.add("grade-wrong");
        else if (!detail.is_correct && v === detail.correct)      btn.classList.add("grade-show-correct");
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Results modal
// ---------------------------------------------------------------------------
function showResults(data) {
  const total   = data.total_questions;
  const correct = data.total_correct;
  const pct     = total > 0 ? correct / total : 0;
  const circumference = 2 * Math.PI * 50;

  scoreNum.textContent   = correct;
  scoreDenom.textContent = `/ ${total}`;
  ringFill.setAttribute("stroke-dasharray",
    `${(pct * circumference).toFixed(1)} ${circumference}`);
  ringFill.style.stroke =
    pct >= 0.6 ? "var(--green)" : pct >= 0.4 ? "var(--gold)" : "var(--red)";

  resultsBreakdown.innerHTML = data.results.map(r => `
    <div class="result-row">
      <div>
        <div class="section-name">${esc(r.section)}</div>
        <div class="part-name">${esc(r.part)}</div>
      </div>
      <div class="result-score">${r.correct} / ${r.total}</div>
    </div>
  `).join("");

  renderPsychoScores(data);
  resultsOverlay.classList.remove("hidden");

  // Save stats if logged in
  if (auth.token && state.pdfId && state.answerKey) {
    recordStats(data).catch(() => {});
  }
}

async function recordStats(data) {
  const pdfName = state.answerKey?.name || state.pdfId;
  await apiAuth("/api/stats/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pdf_id:   state.pdfId,
      pdf_name: pdfName,
      results:  data.results,
    }),
  });
  // Refresh dropdown to show ✓ mark
  refreshPdfSelect().catch(() => {});
}

// ---------------------------------------------------------------------------
// Time analysis
// ---------------------------------------------------------------------------
function renderTimeAnalysis() {
  // Per-part total times
  const partTotals = state.partTimes.map((ms, i) => {
    const part = state.simParts[i];
    const used = SIM_PART_SECONDS * 1000 - (state.simCountdown > 0 && i === state.simPartIdx ? state.simCountdown * 1000 : 0);
    return { part, ms };
  });

  // Per-question timing within each part: sort log per part, compute gaps
  const byPart = {};
  state.answerLog.forEach(e => {
    if (!byPart[e.partIdx]) byPart[e.partIdx] = [];
    byPart[e.partIdx].push(e);
  });
  Object.values(byPart).forEach(log => log.sort((a, b) => a.partElapsed_ms - b.partElapsed_ms));

  const allQTimes = [];
  Object.entries(byPart).forEach(([pidxStr, log]) => {
    log.forEach((e, i) => {
      const prev = i === 0 ? 0 : log[i - 1].partElapsed_ms;
      allQTimes.push({ ...e, time_on_q: e.partElapsed_ms - prev });
    });
  });

  // Summary stats
  const totalMs  = state.partTimes.reduce((s, ms) => s + ms, 0);
  const totalSec = Math.floor(totalMs / 1000);
  const mm  = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss  = String(totalSec % 60).padStart(2, "0");
  const avg = allQTimes.length ? Math.round(totalMs / allQTimes.length / 1000) : 0;

  $("time-summary").innerHTML = `
    <div class="time-stat">סה"כ זמן: <strong>${mm}:${ss}</strong></div>
    <div class="time-stat">ממוצע לשאלה: <strong>${avg}ש'</strong></div>
    <div class="time-stat">שאלות שנענו: <strong>${allQTimes.length}</strong></div>
  `;

  // Per-part breakdown — clickable cards that open chart overlay
  const timeTableEl = $("time-table");
  timeTableEl.innerHTML = `<div class="time-table-header">זמן לפי פרק</div>`;

  partTotals.forEach(({ part, ms }, pidx) => {
    const s  = Math.floor(ms / 1000);
    const pm = String(Math.floor(s / 60)).padStart(2, "0");
    const ps = String(s % 60).padStart(2, "0");

    const row = document.createElement("div");
    row.className = "time-row time-row-clickable";
    row.title = "לחץ לפתוח גרף";
    row.innerHTML = `
      <span class="tr-section">${esc(part.sectionName)}</span>
      <span class="tr-q">${esc(part.partLabel)}</span>
      <span class="tr-time">${pm}:${ps}</span>
      <span class="tr-chevron">📊</span>`;
    timeTableEl.appendChild(row);

    row.addEventListener("click", () => openPartChart(pidx, part, byPart));
  });

  // Slowest questions
  const avgMs  = allQTimes.length ? totalMs / allQTimes.length : 0;
  const sorted = [...allQTimes].sort((a, b) => b.time_on_q - a.time_on_q);
  const slowHeader = document.createElement("div");
  slowHeader.className = "time-table-header";
  slowHeader.style.marginTop = "10px";
  slowHeader.textContent = "שאלות לפי זמן (ארוך ← קצר)";
  timeTableEl.appendChild(slowHeader);

  sorted.forEach(e => {
    const cls = e.time_on_q > avgMs * 2 ? "very-slow" : e.time_on_q > avgMs * 1.4 ? "slow" : "";
    const r = document.createElement("div");
    r.className = `time-row ${cls}`;
    r.innerHTML = `
      <span class="tr-section">${esc(e.sectionName)} · ${esc(e.partLabel)}</span>
      <span class="tr-q">שאלה ${esc(e.q)}</span>
      <span class="tr-time">${fmtMs(e.time_on_q)}</span>`;
    timeTableEl.appendChild(r);
  });
}

// ---------------------------------------------------------------------------
// Chart overlay
// ---------------------------------------------------------------------------
const chartOverlay  = $("chart-overlay");
const chartTitleEl  = $("chart-title");
const chartSvgEl    = $("chart-svg");
const chartTooltip  = $("chart-tooltip");
const closeChartBtn = $("close-chart");

closeChartBtn.addEventListener("click", () => chartOverlay.classList.add("hidden"));
chartOverlay.addEventListener("click", e => { if (e.target === chartOverlay) chartOverlay.classList.add("hidden"); });

function openPartChart(pidx, part, byPart) {
  const log = (byPart[pidx] || []).slice().sort((a, b) => Number(a.q) - Number(b.q));

  chartTitleEl.textContent = `${part.sectionName} — ${part.partLabel}`;
  chartOverlay.classList.remove("hidden");

  if (!log.length) {
    chartSvgEl.innerHTML = `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
      font-size="16" fill="#94a3b8">אין נתוני תזמון לפרק זה</text>`;
    return;
  }

  const times = log.map((e, i) => {
    const prev = i === 0 ? 0 : log[i - 1].partElapsed_ms;
    return { q: e.q, ms: e.partElapsed_ms - prev };
  });

  // Use requestAnimationFrame so the SVG has its rendered size
  requestAnimationFrame(() => drawSvgChart(times));
}

function drawSvgChart(times) {
  const svg     = chartSvgEl;
  const W       = svg.clientWidth  || 700;
  const H       = svg.clientHeight || 340;
  const PAD     = { top: 24, right: 16, bottom: 44, left: 54 };
  const plotW   = W - PAD.left - PAD.right;
  const plotH   = H - PAD.top  - PAD.bottom;
  const n       = times.length;
  const maxMs   = Math.max(...times.map(t => t.ms));
  const avgMs   = times.reduce((s, t) => s + t.ms, 0) / n;

  // Y-axis nice max
  const niceMax = niceNumber(maxMs);

  // Bar geometry
  const gap     = Math.max(2, plotW * 0.06 / n);
  const barW    = (plotW - gap * (n + 1)) / n;

  // SVG NS helper
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };

  svg.innerHTML = "";

  // Background
  svg.appendChild(el("rect", { x:0, y:0, width:W, height:H, fill:"#f8fafc", rx:8 }));

  // Y gridlines + labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val  = (niceMax / yTicks) * i;
    const yPos = PAD.top + plotH - (val / niceMax) * plotH;
    // gridline
    svg.appendChild(el("line", {
      x1: PAD.left, y1: yPos, x2: PAD.left + plotW, y2: yPos,
      stroke: i === 0 ? "#94a3b8" : "#e2e8f0",
      "stroke-width": i === 0 ? 1.5 : 1,
      "stroke-dasharray": i === 0 ? "" : "3 3"
    }));
    // label
    const lbl = el("text", {
      x: PAD.left - 8, y: yPos + 4,
      "text-anchor": "end", "font-size": 11, fill: "#64748b"
    });
    lbl.textContent = fmtMs(val);
    svg.appendChild(lbl);
  }

  // Average line
  const avgY = PAD.top + plotH - (avgMs / niceMax) * plotH;
  const avgLine = el("line", {
    x1: PAD.left, y1: avgY, x2: PAD.left + plotW, y2: avgY,
    stroke: "#6366f1", "stroke-width": 1.5, "stroke-dasharray": "6 3", opacity: 0.7
  });
  svg.appendChild(avgLine);
  const avgLbl = el("text", { x: PAD.left + plotW - 4, y: avgY - 5,
    "text-anchor": "end", "font-size": 10, fill: "#6366f1" });
  avgLbl.textContent = `ממוצע ${fmtMs(avgMs)}`;
  svg.appendChild(avgLbl);

  // Bars
  times.forEach(({ q, ms }, i) => {
    const barH  = Math.max(2, (ms / niceMax) * plotH);
    const x     = PAD.left + gap + i * (barW + gap);
    const y     = PAD.top + plotH - barH;
    const color = ms > avgMs * 1.8 ? "#ef4444" : ms > avgMs * 1.2 ? "#f59e0b" : "#3b82f6";

    // Bar rect (animated via CSS height trick — use transform instead)
    const rect = el("rect", {
      x, y, width: barW, height: barH,
      fill: color, rx: 3,
      class: "chart-bar-rect",
      "data-ms": ms, "data-q": q,
      style: "cursor:pointer; transition: opacity .15s;"
    });

    // Hover events
    rect.addEventListener("mouseenter", (ev) => showTooltip(ev, q, ms));
    rect.addEventListener("mousemove",  (ev) => moveTooltip(ev));
    rect.addEventListener("mouseleave", () => hideTooltip());

    svg.appendChild(rect);

    // X label (question number)
    const xLbl = el("text", {
      x: x + barW / 2, y: PAD.top + plotH + 16,
      "text-anchor": "middle", "font-size": 11, fill: "#475569"
    });
    xLbl.textContent = q;
    svg.appendChild(xLbl);
  });

  // X axis label
  const xAxisLbl = el("text", {
    x: PAD.left + plotW / 2, y: H - 4,
    "text-anchor": "middle", "font-size": 12, fill: "#64748b"
  });
  xAxisLbl.textContent = "מספר שאלה";
  svg.appendChild(xAxisLbl);
}

function niceNumber(ms) {
  if (ms <= 0) return 60000;
  const magnitude = Math.pow(10, Math.floor(Math.log10(ms)));
  const fraction  = ms / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude * 1.1; // 10% headroom
}

function showTooltip(ev, q, ms) {
  chartTooltip.textContent = `שאלה ${q}: ${fmtMs(ms)}`;
  chartTooltip.classList.remove("hidden");
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const rect   = chartSvgEl.getBoundingClientRect();
  const bodyRect = document.getElementById("chart-overlay").querySelector(".chart-modal-body").getBoundingClientRect();
  const x = ev.clientX - bodyRect.left;
  const y = ev.clientY - bodyRect.top;
  chartTooltip.style.left = `${x}px`;
  chartTooltip.style.top  = `${y}px`;
}
function hideTooltip() {
  chartTooltip.classList.add("hidden");
}

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}ש'`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Psychometric score calculation
// ---------------------------------------------------------------------------

// Source: "טבלת מעבר מציוני גלם לציונים בסולם האחיד" (correct_answers_to_score.png)
// Index = raw score (number correct). Value = [english, quantitative, verbal].
// null = that raw score is not achievable for that topic.
const RAW_TO_UNIFORM = [
  /* 0 */  [50,  50,  50 ],
  /* 1 */  [52,  52,  51 ],
  /* 2 */  [54,  54,  52 ],
  /* 3 */  [56,  56,  53 ],
  /* 4 */  [58,  58,  54 ],
  /* 5 */  [60,  60,  56 ],
  /* 6 */  [62,  62,  58 ],
  /* 7 */  [63,  65,  60 ],
  /* 8 */  [65,  67,  62 ],
  /* 9 */  [66,  70,  64 ],
  /* 10 */ [68,  72,  66 ],
  /* 11 */ [70,  75,  68 ],
  /* 12 */ [73,  77,  70 ],
  /* 13 */ [75,  80,  73 ],
  /* 14 */ [78,  82,  75 ],
  /* 15 */ [80,  85,  77 ],
  /* 16 */ [83,  88,  79 ],
  /* 17 */ [85,  91,  81 ],
  /* 18 */ [88,  93,  84 ],
  /* 19 */ [90,  96,  86 ],
  /* 20 */ [93,  99,  88 ],
  /* 21 */ [95,  102, 91 ],
  /* 22 */ [98,  105, 93 ],
  /* 23 */ [100, 108, 96 ],
  /* 24 */ [103, 111, 98 ],
  /* 25 */ [105, 114, 101],
  /* 26 */ [107, 117, 103],
  /* 27 */ [110, 120, 105],
  /* 28 */ [112, 122, 108],
  /* 29 */ [115, 125, 110],
  /* 30 */ [117, 128, 112],
  /* 31 */ [119, 131, 114],
  /* 32 */ [122, 133, 117],
  /* 33 */ [124, 136, 119],
  /* 34 */ [127, 138, 122],
  /* 35 */ [129, 141, 124],
  /* 36 */ [132, 143, 126],
  /* 37 */ [134, 145, 129],
  /* 38 */ [137, 146, 131],
  /* 39 */ [139, 148, 134],
  /* 40 */ [142, 150, 136],
  /* 41 */ [144, null,138],
  /* 42 */ [146, null,141],
  /* 43 */ [148, null,143],
  /* 44 */ [150, null,146],
  /* 45 */ [null,null,148],
  /* 46 */ [null,null,150],
];

// [weighted_min, weighted_max, result_min, result_max]
// Source: score_to_test_result.png
const WEIGHTED_BANDS = [
  [50,  50,  200, 200],
  [51,  55,  221, 248],
  [56,  60,  249, 276],
  [61,  65,  277, 304],
  [66,  70,  305, 333],
  [71,  75,  334, 361],
  [76,  80,  362, 389],
  [81,  85,  390, 418],
  [86,  90,  419, 446],
  [91,  95,  447, 474],
  [96,  100, 475, 503],
  [101, 105, 504, 531],
  [106, 110, 532, 559],
  [111, 115, 560, 587],
  [116, 120, 588, 616],
  [121, 125, 617, 644],
  [126, 130, 645, 672],
  [131, 135, 673, 701],
  [136, 140, 702, 729],
  [141, 145, 730, 761],
  [146, 149, 762, 795],
  [150, 150, 800, 800],
];

function rawToUniform(raw, topicIdx) {
  const capped = Math.min(raw, RAW_TO_UNIFORM.length - 1);
  return RAW_TO_UNIFORM[capped]?.[topicIdx] ?? null;
}

function weightedToResult(ws) {
  const clamped = Math.max(50, Math.min(150, Math.round(ws)));
  for (const [wMin, wMax, rMin, rMax] of WEIGHTED_BANDS) {
    if (clamped >= wMin && clamped <= wMax) {
      if (wMin === wMax) return `${rMin}`;
      const t = (clamped - wMin) / (wMax - wMin);
      const result = Math.round(rMin + t * (rMax - rMin));
      return `${rMin}–${rMax}`;
    }
  }
  return "—";
}

function calculatePsychoScores(gradeData) {
  // Sum correct per section across all parts
  const sectionTotals = {};
  gradeData.results.forEach(r => {
    const key = r.section;
    if (!sectionTotals[key]) sectionTotals[key] = { correct: 0, total: 0 };
    sectionTotals[key].correct += r.correct;
    sectionTotals[key].total   += r.total;
  });

  // Identify topics by section name
  const findSection = (keyword) => {
    const key = Object.keys(sectionTotals).find(k => k.includes(keyword));
    return key ? sectionTotals[key] : null;
  };

  const verbal = findSection("מילולית");
  const quant  = findSection("כמותית");
  const eng    = findSection("אנגלית");

  if (!verbal || !quant || !eng) return null; // can't compute without all 3

  const V = rawToUniform(verbal.correct, 2); // verbal = index 2
  const Q = rawToUniform(quant.correct,  1); // quant  = index 1
  const E = rawToUniform(eng.correct,    0); // english= index 0

  if (V === null || Q === null || E === null) return null;

  const multidisciplinary = (2*V + 2*Q + E) / 5;
  const verbalEmphasis    = (3*V + Q + E)   / 5;
  const quantEmphasis     = (3*Q + V + E)   / 5;

  return {
    topics: [
      { label: "חשיבה מילולית", correct: verbal.correct, total: verbal.total, uniform: V },
      { label: "חשיבה כמותית", correct: quant.correct,  total: quant.total,  uniform: Q },
      { label: "אנגלית",        correct: eng.correct,    total: eng.total,    uniform: E },
    ],
    composites: [
      { label: "רב-תחומי",   weighted: multidisciplinary, result: weightedToResult(multidisciplinary) },
      { label: "דגש מילולי", weighted: verbalEmphasis,    result: weightedToResult(verbalEmphasis)    },
      { label: "דגש כמותי",  weighted: quantEmphasis,     result: weightedToResult(quantEmphasis)     },
    ],
  };
}

function renderPsychoScores(gradeData) {
  const el = $("psycho-scores");
  const scores = calculatePsychoScores(gradeData);
  if (!scores) { el.classList.add("hidden"); return; }

  const hasTimingData = state.answerLog.length > 0;

  const compositeRows = scores.composites.map(c => `
    <div class="psych-composite-row">
      <span class="psych-comp-label">${esc(c.label)}</span>
      <span class="psych-comp-weighted">${Math.round(c.weighted)}</span>
      <span class="psych-comp-arrow">→</span>
      <span class="psych-comp-result">${esc(c.result)}</span>
    </div>`).join("");

  el.innerHTML = `
    <div class="psych-section-title">ציון פסיכומטרי מוערך</div>
    <div class="psych-topics" id="psych-topics-row"></div>
    <div class="psych-composites">
      <div class="psych-comp-header">
        <span>סוג ציון</span><span>ציון משוקלל</span><span></span><span>אומדן תוצאה</span>
      </div>
      ${compositeRows}
    </div>
    <p class="psych-disclaimer">* הציונים הם אומדן בלבד ועשויים להשתנות בהתאם לנורמות המבחן הספציפי</p>
  `;

  const topicsRow = $("psych-topics-row");
  scores.topics.forEach(t => {
    const card = document.createElement("div");
    card.className = "psych-topic-card" + (hasTimingData ? " psych-topic-card--clickable" : "");
    card.innerHTML = `
      <div class="psych-topic-label">${esc(t.label)}</div>
      <div class="psych-topic-raw">${t.correct}/${t.total} נכון</div>
      <div class="psych-topic-uniform">${t.uniform}</div>
      <div class="psych-topic-uniform-lbl">ציון אחיד</div>
      ${hasTimingData ? '<div class="psych-topic-chart-hint">📊 גרף זמנים</div>' : ''}
    `;
    if (hasTimingData) {
      card.addEventListener("click", () => openSectionChart(t.label));
    }
    topicsRow.appendChild(card);
  });

  el.classList.remove("hidden");
}

function openSectionChart(sectionName) {
  const sectionLog = state.answerLog.filter(e => e.sectionName === sectionName);
  if (!sectionLog.length) return;

  // Group by partIdx, compute per-question times within each part
  const byPart = {};
  sectionLog.forEach(e => {
    if (!byPart[e.partIdx]) byPart[e.partIdx] = [];
    byPart[e.partIdx].push(e);
  });
  Object.values(byPart).forEach(log => log.sort((a, b) => Number(a.q) - Number(b.q)));

  // Build flat times array ordered by part then question
  const times = [];
  Object.keys(byPart).sort((a, b) => Number(a) - Number(b)).forEach(pidx => {
    const log = byPart[pidx].slice().sort((a, b) => a.partElapsed_ms - b.partElapsed_ms);
    const partLabel = state.simParts[Number(pidx)]?.partLabel || `פרק ${Number(pidx) + 1}`;
    const shortPart = partLabel.includes("ראשון") ? "א" : partLabel.includes("שני") ? "ב" : String(Number(pidx) + 1);
    log.forEach((e, i) => {
      const prev = i === 0 ? 0 : log[i - 1].partElapsed_ms;
      times.push({ q: `${shortPart}${e.q}`, ms: e.partElapsed_ms - prev });
    });
  });

  chartTitleEl.textContent = `${sectionName} — גרף זמנים לפי שאלה`;
  chartOverlay.classList.remove("hidden");
  requestAnimationFrame(() => drawSvgChart(times));
}

// ---------------------------------------------------------------------------
// Close results
// ---------------------------------------------------------------------------
closeResultsBtn.addEventListener("click", () => resultsOverlay.classList.add("hidden"));
resultsOverlay.addEventListener("click", e => {
  if (e.target === resultsOverlay) resultsOverlay.classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Welcome / reset
// ---------------------------------------------------------------------------
function showWelcome() {
  endSim(false);
  state.pdfId       = null;
  state.answerKey   = null;
  state.userAnswers = {};
  state.graded      = false;
  appLayout.classList.add("hidden");
  welcome.classList.remove("hidden");
  gradeBtn.classList.remove("hidden");
  gradeBtn.disabled = true;
  progressBadge.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiAuth(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
  return api(path, { ...opts, headers });
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Auth modal logic
// ---------------------------------------------------------------------------

authBtn.addEventListener("click", () => {
  if (auth.token) {
    // Logged in → logout
    auth.token    = null;
    auth.username = null;
    localStorage.removeItem("psycho_token");
    localStorage.removeItem("psycho_username");
    updateAuthUI();
    refreshPdfSelect().catch(() => {});
  } else {
    openAuthModal("login");
  }
});

statsBtn.addEventListener("click", () => {
  statsOverlay.classList.remove("hidden");
  renderStatsPage();
});

closeAuthBtn.addEventListener("click",  () => authOverlay.classList.add("hidden"));
closeStatsBtn.addEventListener("click", () => statsOverlay.classList.add("hidden"));
authOverlay.addEventListener("click",   e => { if (e.target === authOverlay)  authOverlay.classList.add("hidden"); });
statsOverlay.addEventListener("click",  e => { if (e.target === statsOverlay) statsOverlay.classList.add("hidden"); });

// "יש להתחבר" button inside stats page
statsBody.addEventListener("click", e => {
  if (e.target.id === "stats-login-btn") {
    statsOverlay.classList.add("hidden");
    openAuthModal("login");
  }
});

function openAuthModal(mode) {
  authMode = mode;
  authErrorEl.classList.add("hidden");
  authErrorEl.textContent = "";
  authForm.reset();
  setAuthTab(mode);
  authOverlay.classList.remove("hidden");
  authUsernameEl.focus();
}

function setAuthTab(mode) {
  authMode = mode;
  $("tab-login").classList.toggle("active",    mode === "login");
  $("tab-register").classList.toggle("active", mode === "register");
  authSubmitEl.textContent = mode === "login" ? "כניסה" : "הרשמה";
}

$("tab-login").addEventListener("click",    () => setAuthTab("login"));
$("tab-register").addEventListener("click", () => setAuthTab("register"));

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = authUsernameEl.value.trim();
  const password = authPasswordEl.value;
  authErrorEl.classList.add("hidden");
  authSubmitEl.disabled    = true;
  authSubmitEl.textContent = "...";
  try {
    const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const data = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    auth.token    = data.token;
    auth.username = data.username;
    localStorage.setItem("psycho_token",    data.token);
    localStorage.setItem("psycho_username", data.username);
    updateAuthUI();
    authOverlay.classList.add("hidden");
    refreshPdfSelect().catch(() => {});
  } catch (err) {
    let msg = err.message || "שגיאה";
    // Parse JSON error detail from FastAPI
    try { const j = JSON.parse(msg.replace(/^HTTP \d+: /, "")); msg = j.detail || msg; } catch {}
    authErrorEl.textContent = msg;
    authErrorEl.classList.remove("hidden");
  } finally {
    authSubmitEl.disabled    = false;
    authSubmitEl.textContent = authMode === "login" ? "כניסה" : "הרשמה";
  }
});

// ---------------------------------------------------------------------------
// Stats page rendering
// ---------------------------------------------------------------------------

async function renderStatsPage() {
  if (!auth.token) {
    statsBody.innerHTML = `
      <div class="stats-login-prompt">
        <p>יש להתחבר כדי לצפות בסטטיסטיקה</p>
        <button id="stats-login-btn" class="btn-auth-submit">כניסה</button>
      </div>`;
    return;
  }

  statsBody.innerHTML = `<div class="stats-login-prompt"><div class="spinner"></div></div>`;

  let stats;
  try {
    stats = await apiAuth("/api/stats");
  } catch (err) {
    statsBody.innerHTML = `<p style="color:var(--red);padding:20px">שגיאה בטעינת נתונים</p>`;
    return;
  }

  const avgPct = stats.total_possible > 0
    ? Math.round((stats.total_correct / stats.total_possible) * 100)
    : 0;

  let html = `
    <div class="stats-summary">
      <div class="stat-card">
        <div class="stat-card-val">${stats.tests.length}</div>
        <div class="stat-card-lbl">מבחנים</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-val">${stats.total_attempts}</div>
        <div class="stat-card-lbl">פרקים שהושלמו</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-val">${avgPct}%</div>
        <div class="stat-card-lbl">ממוצע כללי</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-val">${stats.total_correct}/${stats.total_possible}</div>
        <div class="stat-card-lbl">סה"כ נכון/אפשרי</div>
      </div>
    </div>`;

  if (!stats.tests.length) {
    html += `<div class="stats-empty">טרם הושלמו מבחנים</div>`;
  } else {
    stats.tests.forEach((test, ti) => {
      const testTotal   = test.attempts.reduce((s, a) => s + a.total,   0);
      const testCorrect = test.attempts.reduce((s, a) => s + a.score, 0);
      const testPct     = testTotal > 0 ? Math.round(testCorrect / testTotal * 100) : 0;

      html += `
        <div class="stats-test-block">
          <div class="stats-test-header" data-ti="${ti}">
            <span class="stats-test-name">${esc(test.pdf_name)}</span>
            <span class="stats-test-meta">${test.attempts.length} פרקים · ${testCorrect}/${testTotal} (${testPct}%)</span>
            <span class="stats-test-chevron">▼</span>
          </div>
          <div class="stats-attempts-list" id="stats-test-${ti}" style="display:none">`;

      test.attempts.forEach(a => {
        const pct   = a.total > 0 ? a.score / a.total : 0;
        const cls   = pct >= 0.6 ? "good" : pct >= 0.4 ? "ok" : "bad";
        const date  = new Date(a.completed_at).toLocaleDateString("he-IL");
        html += `
          <div class="stats-attempt-row">
            <span class="attempt-section">${esc(a.section_name)}</span>
            <span class="attempt-part">${esc(a.part_label)}</span>
            <span class="attempt-score ${cls}">${a.score}/${a.total}</span>
            <span class="attempt-date">${date}</span>
          </div>`;
      });

      html += `</div></div>`;
    });
  }

  statsBody.innerHTML = html;

  // Accordion toggle
  statsBody.querySelectorAll(".stats-test-header").forEach(hdr => {
    hdr.addEventListener("click", () => {
      const ti   = hdr.dataset.ti;
      const list = $(`stats-test-${ti}`);
      const open = list.style.display !== "none";
      list.style.display = open ? "none" : "flex";
      hdr.classList.toggle("open", !open);
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();
