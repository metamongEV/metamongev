/* metamongEV — Beezie EV mirror.
   Math is a 1:1 port of beezie-giyu.vercel.app's a(e) helper. */

const CLAWS_URL = "/api/claws";
const REFRESH_INTERVAL_MS = 10_000;
const COUNTDOWN_TICK_MS = 1_000;

/* Hardcoded BEP thresholds (microUSDC) — same map beezie-giyu uses. */
const BEP_TABLE = {
  30_000_000: 34_000_000,
  50_000_000: 56_000_000,
  250_000_000: 281_000_000,
  500_000_000: 562_000_000,
};

const TIER_LABEL = {
  grails: "Grail",
  high: "High",
  medium: "Medium",
  low: "Low",
  base: "Base",
};

const state = {
  packs: [],
  expanded: new Set(),
  defaultExpanded: false,
  lastSyncMs: null,
  countdownDeadline: Date.now() + REFRESH_INTERVAL_MS,
  alarmEnabled: false,
  alarmFiring: false,
  alarmedPacks: new Set(),
};

const els = {
  rows: document.getElementById("rows"),
  refreshCountdown: document.getElementById("refreshCountdown"),
  lastSync: document.getElementById("lastSync"),
  alarmToggle: document.getElementById("alarmToggle"),
  alarmStatus: document.getElementById("alarmStatus"),
  alarmControl: document.querySelector(".control--alarm"),
  dataState: document.getElementById("dataState"),
};

/* ---------- formatters ---------- */

function formatUsd(microUsdc, decimals = 2) {
  if (microUsdc == null || !Number.isFinite(microUsdc)) return "—";
  const v = microUsdc / 1_000_000;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function formatUsdSigned(microUsdc, decimals = 2) {
  if (microUsdc == null || !Number.isFinite(microUsdc)) return "—";
  const sign = microUsdc > 0 ? "+" : microUsdc < 0 ? "−" : "";
  return `${sign}${formatUsd(Math.abs(microUsdc), decimals)}`;
}

function formatPctSigned(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

function formatInt(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US");
}

function formatPulls(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  return p.toFixed(p < 10 ? 2 : 1);
}

/* ---------- math (mirrors beezie-giyu's a(e)) ---------- */

function bep(priceUsdc) {
  return BEP_TABLE[priceUsdc] ?? Math.ceil(1.14 * priceUsdc);
}

function packStats(claw) {
  const stock = claw.clawStockCount;
  const price = claw.priceUsdc;
  if (!stock) {
    return {
      ev: 0, displayAvg: 0, evPercent: 0, threshold: bep(price),
      pullsToPositiveEV: null, progressPercent: 0,
    };
  }
  const displayAvg = claw.totalSwapValue / stock / 0.9;
  const threshold = bep(price);
  const ev = displayAvg - threshold;
  const totalAdj = claw.totalSwapValue / 0.9;
  const baseMid = (claw.priceRanges.fromBase + claw.priceRanges.toBase) / 2 * 1e6 / 0.9;
  const surplus = totalAdj - threshold * stock;
  const baseGap = baseMid - threshold;

  let pullsToPositiveEV = null;
  if (baseGap < 0 && surplus < 0) {
    const x = Math.round((surplus / baseGap) * 100) / 100;
    if (x > 0 && x < stock) pullsToPositiveEV = x;
  }

  let progressPercent = 0;
  if (ev >= 0) progressPercent = 100;
  else if (pullsToPositiveEV != null) {
    progressPercent = Math.max(0, Math.min(99, ((stock - pullsToPositiveEV) / stock) * 100));
  }

  return { ev, displayAvg, evPercent: ev / threshold * 100, threshold, pullsToPositiveEV, progressPercent };
}

function adjustedBuybackPct(claw) {
  const fee = claw.swapFees?.percentages?.[0];
  const feeFrac = Number.isFinite(fee) ? fee / 100 : 0;
  return 90 * (1 - feeFrac);
}

/* Color classes for %EV and $EV cells.
   Breakeven band is intentionally narrow: |EV%| < 0.5 → yellow. */
function evColorClass(evPercent) {
  if (evPercent == null || !Number.isFinite(evPercent)) return "ev-color-na";
  if (Math.abs(evPercent) < 0.5) return "ev-color-breakeven";
  return evPercent > 0 ? "ev-color-positive" : "ev-color-negative";
}

function tierClass(tier) {
  switch (tier) {
    case "grails": return "tier-grail";
    case "high":   return "tier-high";
    case "medium": return "tier-medium";
    case "low":    return "tier-low";
    case "base":   return "tier-base";
    default:       return "tier-default";
  }
}

/* ---------- alarm ---------- */

let audioCtx = null;

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { audioCtx = new Ctx(); } catch { return null; }
  return audioCtx;
}

function playBell() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const tones = [
    { freq: 988,    start: 0,    dur: 0.55, gain: 0.32 },
    { freq: 1318.5, start: 0.18, dur: 0.6,  gain: 0.22 },
  ];
  for (const t of tones) {
    const osc = ctx.createOscillator();
    const partial = ctx.createOscillator();
    const gain = ctx.createGain();
    const partialGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(t.freq, now + t.start);
    partial.type = "triangle";
    partial.frequency.setValueAtTime(t.freq * 2.76, now + t.start);
    gain.gain.setValueAtTime(0, now + t.start);
    gain.gain.linearRampToValueAtTime(t.gain, now + t.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
    partialGain.gain.setValueAtTime(0, now + t.start);
    partialGain.gain.linearRampToValueAtTime(t.gain * 0.45, now + t.start + 0.012);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur * 0.7);
    osc.connect(gain).connect(ctx.destination);
    partial.connect(partialGain).connect(ctx.destination);
    osc.start(now + t.start);
    osc.stop(now + t.start + t.dur + 0.05);
    partial.start(now + t.start);
    partial.stop(now + t.start + t.dur * 0.7 + 0.05);
  }
}

function syncAlarmUi() {
  if (!els.alarmControl) return;
  els.alarmControl.classList.toggle("is-armed", state.alarmEnabled);
  els.alarmControl.classList.toggle("is-firing", state.alarmEnabled && state.alarmFiring);
  if (els.alarmStatus) {
    if (!state.alarmEnabled) els.alarmStatus.textContent = "muted";
    else if (state.alarmFiring) els.alarmStatus.textContent = "firing";
    else els.alarmStatus.textContent = "armed";
  }
}

function evaluateAlarm() {
  if (!state.alarmEnabled) {
    state.alarmFiring = false;
    state.alarmedPacks.clear();
    syncAlarmUi();
    return;
  }
  let firing = false;
  for (const pack of state.packs) {
    const id = String(pack.id);
    if (pack.status === "active" && pack._stats.ev > 0) {
      firing = true;
      if (!state.alarmedPacks.has(id)) {
        playBell();
        state.alarmedPacks.add(id);
      }
    } else {
      state.alarmedPacks.delete(id);
    }
  }
  state.alarmFiring = firing;
  syncAlarmUi();
}

/* ---------- rendering ---------- */

function packRowHtml(pack) {
  const stats = pack._stats;
  const isExpanded = state.expanded.has(String(pack.id));
  const evColor = evColorClass(stats.evPercent);
  const restocking = pack.status !== "active" || !pack.clawStockCount;
  const positive = stats.ev > 0 && !restocking;

  const buttonText = isExpanded ? "Hide top 10 cards" : "Show top 10 cards";
  const progressLabel = stats.ev >= 0 ? "+EV" : `${stats.progressPercent.toFixed(0)}%`;

  return `
    <tr class="row-pack ${restocking ? "row-closed" : ""} ${positive ? "row-pack--positive" : ""}" data-pack-id="${pack.id}">
      <td class="text-left col-pack">
        <div class="pack-cell">
          <div class="pack-cell__line">
            <span class="provider-chip">Beezie</span>
            <span class="pack-name">${escapeHtml(pack.name)}</span>
            ${restocking ? `<span class="status-pill">${escapeHtml(pack.status || "restocking")}</span>` : ""}
          </div>
          <button class="row-expander" type="button" data-pack-id="${pack.id}" aria-expanded="${isExpanded}">
            <span class="row-expander__caret">${isExpanded ? "▾" : "▸"}</span>
            <span>${buttonText}</span>
          </button>
        </div>
      </td>
      <td class="col-progress">
        <div class="progress-cell" role="progressbar"
             aria-valuenow="${stats.progressPercent.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"
             title="${progressLabel} of the way to BEP">
          <div class="progress-cell__bar">
            <div class="progress-cell__fill" style="width:${stats.progressPercent.toFixed(1)}%"></div>
          </div>
          <span class="progress-cell__label">${progressLabel}</span>
        </div>
      </td>
      <td class="text-right col-pulls">${formatPulls(stats.pullsToPositiveEV)}</td>
      <td class="text-right">${formatUsd(stats.displayAvg, 2)}</td>
      <td class="text-right ${evColor}">${formatPctSigned(stats.evPercent, 2)}</td>
      <td class="text-right ${evColor}">${formatUsdSigned(stats.ev, 2)}</td>
      <td class="text-right">${formatUsd(stats.threshold, 2)}</td>
      <td class="text-right">${formatUsd(pack.priceUsdc, 0)}</td>
      <td class="text-right">${adjustedBuybackPct(pack).toFixed(1)}%</td>
      <td class="text-right">${formatInt(pack.clawStockCount)}</td>
    </tr>
    ${isExpanded ? grailRowsHtml(pack) : ""}
  `;
}

function grailRowsHtml(pack) {
  const grails = pack.topGrails || [];
  if (!grails.length) {
    return `
      <tr class="row-grails-empty" data-pack-id="${pack.id}">
        <td colspan="10"><div class="grails-tree"><div class="grails-tree__empty">No top grails reported by upstream.</div></div></td>
      </tr>`;
  }

  const headerRow = `
    <tr class="row-grails-head" data-pack-id="${pack.id}">
      <td colspan="10">
        <div class="grails-tree">
          <div class="grail-row grail-row--head">
            <span class="grail-col grail-col--rank">#</span>
            <span class="grail-col grail-col--tier">Tier</span>
            <span class="grail-col grail-col--name">Item</span>
            <span class="grail-col grail-col--token text-right">Token</span>
            <span class="grail-col grail-col--swap text-right">Swap value</span>
          </div>
        </div>
      </td>
    </tr>`;

  const tokenRows = grails.map((g, idx) => {
    const tier = g.tier || "default";
    const name = g.name || `#${g.tokenId}`;
    const isLast = idx === grails.length - 1;
    return `
      <tr class="row-grail" data-pack-id="${pack.id}">
        <td colspan="10">
          <div class="grails-tree">
            <div class="grail-row ${isLast ? "grail-row--last" : ""}">
              <span class="grail-col grail-col--rank">${idx + 1}</span>
              <span class="grail-col grail-col--tier">
                <span class="grail__tier ${tierClass(tier)}">${escapeHtml(TIER_LABEL[tier] || tier)}</span>
              </span>
              <span class="grail-col grail-col--name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
              <span class="grail-col grail-col--token text-right">#${escapeHtml(String(g.tokenId))}</span>
              <span class="grail-col grail-col--swap text-right">${formatUsd(g.swapValue, 0)}</span>
            </div>
          </div>
        </td>
      </tr>`;
  }).join("");

  return headerRow + tokenRows;
}

function renderTable() {
  if (!state.packs.length) {
    els.rows.innerHTML = `<tr class="row-empty"><td colspan="10">No Beezie packs returned by upstream.</td></tr>`;
    return;
  }
  els.rows.innerHTML = state.packs.map(packRowHtml).join("");
}

/* ---------- expand/collapse ---------- */

els.rows.addEventListener("click", (event) => {
  const button = event.target.closest(".row-expander");
  if (!button) return;
  const id = button.dataset.packId;
  if (!id) return;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderTable();
});

/* ---------- data fetch ---------- */

async function refresh() {
  els.dataState.textContent = "fetching…";
  let payload;
  try {
    const resp = await fetch(CLAWS_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    payload = await resp.json();
  } catch (err) {
    els.dataState.textContent = `offline (${err.message || err})`;
    if (!state.packs.length) {
      els.rows.innerHTML = `<tr class="row-error"><td colspan="10">Failed to fetch /api/claws. Retrying in 10s…</td></tr>`;
    }
    return;
  }

  const claws = Array.isArray(payload?.claws) ? payload.claws : [];
  const known = new Set(claws.map((c) => String(c.id)));

  if (!state.defaultExpanded && claws.length) {
    for (const c of claws) state.expanded.add(String(c.id));
    state.defaultExpanded = true;
  }
  for (const id of [...state.expanded]) if (!known.has(id)) state.expanded.delete(id);

  for (const c of claws) c._stats = packStats(c);
  state.packs = claws;

  state.lastSyncMs = payload?.timestamp ?? Date.now();
  els.lastSync.textContent = new Date(state.lastSyncMs).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  els.dataState.textContent = `live · ${claws.length} pack${claws.length === 1 ? "" : "s"}`;

  renderTable();
  evaluateAlarm();
}

function tickCountdown() {
  const remaining = Math.max(0, state.countdownDeadline - Date.now());
  els.refreshCountdown.textContent = `${Math.ceil(remaining / 1000)}s`;
}

function scheduleNextRefresh() {
  state.countdownDeadline = Date.now() + REFRESH_INTERVAL_MS;
  tickCountdown();
}

/* ---------- escape utils ---------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---------- alarm wiring ---------- */

if (els.alarmToggle) {
  els.alarmToggle.addEventListener("change", () => {
    state.alarmEnabled = els.alarmToggle.checked;
    if (state.alarmEnabled) {
      const ctx = ensureAudioCtx();
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      playBell();
    }
    evaluateAlarm();
  });
  syncAlarmUi();
}

/* ---------- boot ---------- */

function startTimers() {
  scheduleNextRefresh();
  setInterval(() => {
    tickCountdown();
    if (Date.now() >= state.countdownDeadline) {
      scheduleNextRefresh();
      refresh();
    }
  }, COUNTDOWN_TICK_MS);
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();
  startTimers();
});
