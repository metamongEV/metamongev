/* metamongEV — multi-provider EV mirror.
   - Beezie math is a 1:1 port of beezie-giyu.vercel.app's a(e) helper.
   - Phygitals math reuses the same BEP framing (price ÷ buyback) so the columns
     mean the same thing across providers. */

const CLAWS_URL = "/api/claws";
const PHYGITALS_URL = "/api/phygitals";
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
  alarmEnabled: true,         // default ON; first user click anywhere unlocks audio
  alarmFiring: false,
  alarmedPacks: new Set(),
};

const els = {
  rows: document.getElementById("rows"),
  refreshCountdown: document.getElementById("refreshCountdown"),
  lastSync: document.getElementById("lastSync"),
  alarmToggle: document.getElementById("alarmToggle"),
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

/* ---------- normalizers — fold each provider's raw record into one shape ---------- */

function normalizeBeezie(claw) {
  const stock = claw.clawStockCount;
  const price = claw.priceUsdc;
  const fee = claw.swapFees?.percentages?.[0];
  const adjBuyback = 90 * (1 - (Number.isFinite(fee) ? fee / 100 : 0));

  let stats;
  if (!stock) {
    stats = { ev: 0, displayAvg: 0, evPercent: 0, threshold: bep(price),
              pullsToPositiveEV: null, pullsApplicable: false, progressPercent: 0 };
  } else {
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

    stats = {
      ev, displayAvg, threshold, pullsToPositiveEV, progressPercent,
      pullsApplicable: true,
      evPercent: ev / threshold * 100,
    };
  }

  return {
    provider: "beezie",
    providerLabel: "Beezie",
    id: `beezie:${claw.id}`,
    name: claw.name,
    active: claw.status === "active" && !!stock,
    statusLabel: claw.status,
    priceMicroUsdc: price,
    adjBuybackPct: adjBuyback,
    itemCount: stock ?? null,
    itemCountLabel: "stock",
    _stats: stats,
    expansion: {
      kind: "grails",
      label: "top 10 cards",
      items: claw.topGrails || [],
    },
  };
}

function normalizePhygitals(raw) {
  const priceUsd = parseFloat(raw.mint_price);                  // raw is dollars (string)
  const buybackFrac = Number.isFinite(raw.buyback_percent) ? raw.buyback_percent : null;
  const evUsd = Number.isFinite(raw.ev) ? raw.ev : null;
  const priceMicro = Number.isFinite(priceUsd) ? priceUsd * 1e6 : null;

  // Phygitals doesn't expose a per-pack BEP table, so apply Beezie's framing:
  // BEP = price ÷ buyback_percent. (e.g. $25 / 0.85 ≈ $29.41)
  let stats;
  if (priceMicro == null || buybackFrac == null || evUsd == null || buybackFrac <= 0) {
    stats = { ev: 0, displayAvg: 0, evPercent: 0, threshold: priceMicro ?? 0,
              pullsToPositiveEV: null, pullsApplicable: false, progressPercent: 0 };
  } else {
    const displayAvg = evUsd * 1e6;
    const threshold = (priceUsd / buybackFrac) * 1e6;
    const ev = displayAvg - threshold;
    const evPercent = ev / threshold * 100;

    // Pulls-to-+EV doesn't apply to Phygitals: rarity weights are fixed,
    // so the pool's expected value doesn't shift with each pull.
    // Progress = how close current EV% is to break-even (linear: -20% → 0%, 0% → 100%).
    let progressPercent;
    if (evPercent >= 0) progressPercent = 100;
    else progressPercent = Math.max(0, Math.min(99, 100 + evPercent * 5));

    stats = {
      ev, displayAvg, threshold, evPercent,
      pullsToPositiveEV: null, pullsApplicable: false, progressPercent,
    };
  }

  return {
    provider: "phygitals",
    providerLabel: "Phygital",
    id: `phygitals:${raw.id}`,
    name: raw.name,
    active: raw.in_stock === true && raw.enable === true,
    statusLabel: raw.in_stock ? null : "out of stock",
    priceMicroUsdc: priceMicro,
    adjBuybackPct: buybackFrac != null ? buybackFrac * 100 : null,
    itemCount: Number.isFinite(raw.num_pulls_7d) ? raw.num_pulls_7d : null,
    itemCountLabel: "7d pulls",
    _stats: stats,
    expansion: {
      kind: "tiers",
      label: "rarity tiers",
      items: Array.isArray(raw.rarity_distribution) ? raw.rarity_distribution : [],
    },
  };
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
  if (!els.alarmToggle) return;
  els.alarmToggle.setAttribute("aria-pressed", state.alarmEnabled ? "true" : "false");
  els.alarmToggle.classList.toggle("is-firing", state.alarmEnabled && state.alarmFiring);
  const baseLabel = state.alarmEnabled ? "Alarm on +EV — currently on" : "Alarm on +EV — currently off";
  const label = state.alarmEnabled && state.alarmFiring ? "Alarm on +EV — firing" : baseLabel;
  els.alarmToggle.setAttribute("aria-label", label);
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
    const id = pack.id;
    if (pack.active && pack._stats.ev > 0) {
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
  const isExpanded = state.expanded.has(pack.id);
  const evColor = evColorClass(stats.evPercent);
  const inactive = !pack.active;
  const positive = stats.ev > 0 && !inactive;

  const expandLabel = pack.expansion?.label || "details";
  const buttonText = isExpanded ? `Hide ${expandLabel}` : `Show ${expandLabel}`;
  const pullsText = stats.pullsApplicable ? formatPulls(stats.pullsToPositiveEV) : "—";
  const progressLabel = stats.ev >= 0 ? "+EV" : `${stats.progressPercent.toFixed(0)}%`;
  const itemsText = pack.itemCount != null ? formatInt(pack.itemCount) : "—";
  const buybackText = pack.adjBuybackPct != null ? `${pack.adjBuybackPct.toFixed(1)}%` : "—";

  return `
    <tr class="row-pack row-pack--${pack.provider} ${inactive ? "row-closed" : ""} ${positive ? "row-pack--positive" : ""}" data-pack-id="${escapeAttr(pack.id)}">
      <td class="text-left col-pack">
        <div class="pack-cell">
          <div class="pack-cell__line">
            <span class="provider-chip provider-chip--${pack.provider}">${escapeHtml(pack.providerLabel)}</span>
            <span class="pack-name">${escapeHtml(pack.name)}</span>
            ${inactive ? `<span class="status-pill">${escapeHtml(pack.statusLabel || "inactive")}</span>` : ""}
          </div>
          <button class="row-expander" type="button" data-pack-id="${escapeAttr(pack.id)}" aria-expanded="${isExpanded}">
            <span class="row-expander__caret">${isExpanded ? "▾" : "▸"}</span>
            <span>${escapeHtml(buttonText)}</span>
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
      <td class="text-right col-pulls">${pullsText}</td>
      <td class="text-right">${formatUsd(stats.displayAvg, 2)}</td>
      <td class="text-right ${evColor}">${formatPctSigned(stats.evPercent, 2)}</td>
      <td class="text-right ${evColor}">${formatUsdSigned(stats.ev, 2)}</td>
      <td class="text-right">${formatUsd(stats.threshold, 2)}</td>
      <td class="text-right">${formatUsd(pack.priceMicroUsdc, 0)}</td>
      <td class="text-right" title="${escapeAttr(pack.adjBuybackPct != null ? `${pack.providerLabel} buyback (post-fee)` : "n/a")}">${buybackText}</td>
      <td class="text-right" title="${escapeAttr(pack.itemCountLabel)}">${itemsText}</td>
    </tr>
    ${isExpanded ? expansionRowsHtml(pack) : ""}
  `;
}

function expansionRowsHtml(pack) {
  if (pack.expansion?.kind === "tiers") return tierRowsHtml(pack);
  return grailRowsHtml(pack);
}

function emptyExpansionRow(pack, message) {
  return `
    <tr class="row-grails-empty" data-pack-id="${escapeAttr(pack.id)}">
      <td colspan="10"><div class="grails-tree"><div class="grails-tree__empty">${escapeHtml(message)}</div></div></td>
    </tr>`;
}

function grailRowsHtml(pack) {
  const grails = pack.expansion?.items || [];
  if (!grails.length) return emptyExpansionRow(pack, "No top grails reported by upstream.");

  const headerRow = `
    <tr class="row-grails-head" data-pack-id="${escapeAttr(pack.id)}">
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
      <tr class="row-grail" data-pack-id="${escapeAttr(pack.id)}">
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

function tierRowsHtml(pack) {
  const tiers = pack.expansion?.items || [];
  if (!tiers.length) return emptyExpansionRow(pack, "No rarity tiers reported by upstream.");

  // Sort tiers descending by upper bound so the rarest sits first.
  const sorted = [...tiers].sort((a, b) => (b.upper ?? 0) - (a.upper ?? 0));

  const headerRow = `
    <tr class="row-grails-head" data-pack-id="${escapeAttr(pack.id)}">
      <td colspan="10">
        <div class="grails-tree">
          <div class="grail-row grail-row--head">
            <span class="grail-col grail-col--rank">#</span>
            <span class="grail-col grail-col--tier">Tier</span>
            <span class="grail-col grail-col--name">Pull odds</span>
            <span class="grail-col grail-col--token text-right">Range</span>
            <span class="grail-col grail-col--swap text-right">Mid</span>
          </div>
        </div>
      </td>
    </tr>`;

  const rows = sorted.map((t, idx) => {
    const isLast = idx === sorted.length - 1;
    const lower = Number.isFinite(t.lower) ? t.lower : 0;
    const upper = Number.isFinite(t.upper) ? t.upper : 0;
    const weight = Number.isFinite(t.weight) ? t.weight : 0;
    const mid = (lower + upper) / 2;
    const tierKey = (t.name || "").toLowerCase();
    const swatch = t.color
      ? `<span class="tier-swatch" style="background:${escapeAttr(t.color)}"></span>`
      : "";
    const fmtUsdInline = (v) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    return `
      <tr class="row-grail" data-pack-id="${escapeAttr(pack.id)}">
        <td colspan="10">
          <div class="grails-tree">
            <div class="grail-row ${isLast ? "grail-row--last" : ""}">
              <span class="grail-col grail-col--rank">${idx + 1}</span>
              <span class="grail-col grail-col--tier">
                <span class="grail__tier ${tierClass(tierKey)}">${swatch}${escapeHtml(t.name || "—")}</span>
              </span>
              <span class="grail-col grail-col--name">${weight.toFixed(2)}%</span>
              <span class="grail-col grail-col--token text-right">${fmtUsdInline(lower)}–${fmtUsdInline(upper)}</span>
              <span class="grail-col grail-col--swap text-right">${fmtUsdInline(mid)}</span>
            </div>
          </div>
        </td>
      </tr>`;
  }).join("");

  return headerRow + rows;
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

async function fetchJson(url) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return await resp.json();
}

async function refresh() {
  els.dataState.textContent = "fetching…";
  const [beezieRes, phygitalsRes] = await Promise.allSettled([
    fetchJson(CLAWS_URL),
    fetchJson(PHYGITALS_URL),
  ]);

  const beeziePacks = beezieRes.status === "fulfilled"
    ? (beezieRes.value?.claws || []).map(normalizeBeezie)
    : [];
  const phygitalsPacks = phygitalsRes.status === "fulfilled"
    ? (phygitalsRes.value?.packs || []).map(normalizePhygitals)
    : [];

  // Beezie first (matches the curated 4-pack ordering), then Phygitals sorted by price asc.
  phygitalsPacks.sort((a, b) => (a.priceMicroUsdc ?? 0) - (b.priceMicroUsdc ?? 0));
  const packs = [...beeziePacks, ...phygitalsPacks];

  if (!packs.length) {
    const reason = [
      beezieRes.status === "rejected" ? "beezie down" : null,
      phygitalsRes.status === "rejected" ? "phygitals down" : null,
    ].filter(Boolean).join(", ") || "no data";
    els.dataState.textContent = `offline · ${reason}`;
    if (!state.packs.length) {
      els.rows.innerHTML = `<tr class="row-error"><td colspan="10">Failed to fetch upstream feeds. Retrying in 10s…</td></tr>`;
    }
    return;
  }

  // First successful load: auto-expand every pack so the grails/tiers are immediately visible.
  if (!state.defaultExpanded) {
    for (const p of packs) state.expanded.add(p.id);
    state.defaultExpanded = true;
  }
  // Drop expanded entries for packs that disappeared.
  const known = new Set(packs.map((p) => p.id));
  for (const id of [...state.expanded]) if (!known.has(id)) state.expanded.delete(id);

  state.packs = packs;

  const ts = Math.max(
    beezieRes.status === "fulfilled" ? (beezieRes.value?.timestamp ?? 0) : 0,
    phygitalsRes.status === "fulfilled" ? (phygitalsRes.value?.timestamp ?? 0) : 0,
  );
  state.lastSyncMs = ts || Date.now();
  els.lastSync.textContent = new Date(state.lastSyncMs).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const partial = beezieRes.status !== "fulfilled" || phygitalsRes.status !== "fulfilled";
  els.dataState.textContent = partial
    ? `live · ${packs.length} pack${packs.length === 1 ? "" : "s"} · partial`
    : `live · ${packs.length} pack${packs.length === 1 ? "" : "s"}`;

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
  els.alarmToggle.addEventListener("click", () => {
    state.alarmEnabled = !state.alarmEnabled;
    if (state.alarmEnabled) {
      // User gesture — unlock the audio context and play a short test bell.
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
