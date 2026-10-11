// The "best temperature" engine:
//   1. interpolate every source onto the same timestamps
//   2. drop outliers (when there are enough sources)
//   3. take a smooth weighted median, weights = base trust × recent accuracy at this location
//   4. report the spread so the UI can show how much the sources agree
// Plus a tiny learning loop: log what each source predicted, compare it to what happened, re-weight.
import { HOUR, DAY, clamp } from './util.js';
import { SOURCE_META } from './api.js';

// Linear interpolation of a {t[], temp[]} series at time x. Returns null when there is no data nearby.
export function valueAt(s, x, key = 'temp', maxGap = 7 * HOUR) {
  const t = s.t, v = s[key];
  if (!t || !v || !t.length || x < t[0] - 1 || x > t[t.length - 1] + 1) return null;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
  const a = v[lo], b = v[hi];
  if (t[lo] === x || hi === lo) return a;
  if (t[hi] === x) return b;
  if (a == null || b == null) return a != null && x - t[lo] < HOUR / 2 ? a : b != null && t[hi] - x < HOUR / 2 ? b : null;
  if (t[hi] - t[lo] > maxGap) return null;
  return a + (b - a) * (x - t[lo]) / (t[hi] - t[lo]);
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * p, f = Math.floor(i), c = Math.ceil(i);
  return sorted[f] + (sorted[c] - sorted[f]) * (i - f);
}

// Weighted percentile with linear interpolation between mid-points of cumulative weight (smooth, no jumps).
export function weightedPercentile(items, p) {
  const s = [...items].sort((a, b) => a.v - b.v);
  const W = s.reduce((a, x) => a + x.w, 0);
  let c = 0;
  const pts = s.map(x => { const mid = (c + x.w / 2) / W; c += x.w; return [mid, x.v]; });
  if (p <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (p >= last[0]) return last[1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (p <= pts[i + 1][0]) { const [a, va] = pts[i], [b, vb] = pts[i + 1]; return va + (vb - va) * (p - a) / (b - a); }
  }
  return last[1];
}

// entries: [{id, v, w}] → consensus for one moment in time.
export function consensusAt(entries) {
  const e = entries.filter(x => x.v != null && isFinite(x.v));
  if (!e.length) return null;
  let used = e;
  if (e.length >= 4) {
    const vals = e.map(x => x.v).sort((a, b) => a - b);
    const med = percentile(vals, 0.5);
    const mad = percentile(vals.map(v => Math.abs(v - med)).sort((a, b) => a - b), 0.5) * 1.4826;
    const lim = Math.max(2, 2.5 * mad);
    const keep = e.filter(x => Math.abs(x.v - med) <= lim);
    if (keep.length >= 3) used = keep;
  }
  const vs = used.map(x => x.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  return {
    best: weightedPercentile(used, 0.5), lo, hi, spread: hi - lo, n: used.length, total: e.length,
    used, dropped: e.filter(x => !used.includes(x)),
  };
}

export function confidence(spreadC, n) {
  if (n < 2) return { level: 'single', label: 'Single source' };
  if (spreadC <= 1.2) return { level: 'high', label: 'High confidence' };
  if (spreadC <= 3) return { level: 'medium', label: 'Medium confidence' };
  return { level: 'low', label: 'Low confidence' };
}

// ---------- Accuracy tracking ----------
// preds: { [hourMs]: { [sourceId]: [tempC, madeAtMs] } }
// acc:   { [sourceId]: { d: { 'YYYY-MM-DD': [count, sumAbsErr, sumSignedErr] } } }
const dayKey = t => new Date(t).toISOString().slice(0, 10);

export function recordPredictions(preds, sources, now) {
  const start = Math.ceil((now + 3 * HOUR) / HOUR) * HOUR;
  for (let h = start; h <= now + 36 * HOUR; h += HOUR) {
    for (const s of sources) {
      const v = valueAt(s, h);
      if (v == null) continue;
      const slot = preds[h] || (preds[h] = {});
      if (!slot[s.id]) slot[s.id] = [Math.round(v * 10) / 10, now];
    }
  }
  for (const k of Object.keys(preds)) if (+k < now - 3 * DAY) delete preds[k];
}

// obs: {t[], temp[]} — observation-based hourly values (Open-Meteo's analysis for the past hours).
export function evaluate(preds, acc, obs, now) {
  let scored = 0;
  for (const k of Object.keys(preds)) {
    const h = +k;
    if (h > now - HOUR) continue;
    const o = valueAt(obs, h);
    if (o == null) { if (h < now - 47 * HOUR) delete preds[k]; continue; }
    const bucket = dayKey(h);
    for (const [id, [v]] of Object.entries(preds[k])) {
      const err = v - o;
      const a = acc[id] || (acc[id] = { d: {} });
      const b = a.d[bucket] || (a.d[bucket] = [0, 0, 0]);
      b[0]++; b[1] += Math.abs(err); b[2] += err; scored++;
    }
    delete preds[k];
  }
  const cutoff = dayKey(now - 14 * DAY);
  for (const a of Object.values(acc)) for (const d of Object.keys(a.d)) if (d < cutoff) delete a.d[d];
  return scored;
}

// Last-7-days stats for one source.
export function weekStats(accEntry, now = Date.now()) {
  if (!accEntry) return { n: 0, mae: null, bias: null };
  const cutoff = dayKey(now - 7 * DAY);
  let n = 0, abs = 0, signed = 0;
  for (const [d, b] of Object.entries(accEntry.d)) if (d >= cutoff) { n += b[0]; abs += b[1]; signed += b[2]; }
  return n ? { n, mae: abs / n, bias: signed / n } : { n: 0, mae: null, bias: null };
}

export const MIN_SAMPLES = 6;

// Source weights = base trust × accuracy multiplier (relative to how the other sources did).
export function sourceWeights(sourceIds, acc, now = Date.now()) {
  const stats = Object.fromEntries(sourceIds.map(id => [id, weekStats(acc?.[id], now)]));
  const scored = sourceIds.filter(id => stats[id].n >= MIN_SAMPLES);
  const avg = scored.length >= 2 ? scored.reduce((a, id) => a + stats[id].mae, 0) / scored.length : null;
  const out = {};
  for (const id of sourceIds) {
    const base = SOURCE_META[id]?.w ?? 1;
    let mult = 1;
    if (avg != null && stats[id].n >= MIN_SAMPLES) mult = clamp((0.5 + avg) / (0.5 + stats[id].mae), 0.4, 2.2);
    out[id] = { base, mult, w: base * mult, stats: stats[id] };
  }
  return out;
}
