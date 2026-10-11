// Turns a raw bundle (from the network or the offline cache) into everything the UI needs.
// It always works from the *current* time, so a forecast cached hours ago still shows the right "now".
import { HOUR, DAY, clamp, dateKey, hourOfDay, makeFmt } from './util.js';
import { valueAt, consensusAt, confidence, sourceWeights, weekStats, MIN_SAMPLES } from './consensus.js';
import { SOURCE_META, BLEND } from './api.js';
import { isPrecip, isSnow, wmo, skyTheme } from './icons.js';

SOURCE_META.live = { id: 'live', name: 'Live reading', full: 'Current conditions', w: 2, color: '#ffffff' };

export function prepare(bundle, ctx) {
  const now = ctx.now ?? Date.now();
  const prefs = ctx.prefs;
  const { main } = bundle;
  const H = main.hourly, D = main.daily, tz = main.tz;
  const fmt = makeFmt(prefs, tz);
  const N = H.t.length;

  // index of the current hour
  let i0 = 0;
  for (let i = 0; i < N; i++) if (H.t[i] <= now) i0 = i; else break;
  const expired = now > H.t[N - 1] + HOUR;

  // --- current conditions (re-derived from hourly data when the cache is old) ---
  const fresh = Math.abs(now - main.current.t) < 45 * 60e3;
  let cur;
  if (fresh) cur = { ...main.current, stale: false };
  else {
    const g = k => valueAt(H, now, k) ?? H[k]?.[i0];
    const near = Math.abs(now - H.t[i0]) <= Math.abs(H.t[Math.min(N - 1, i0 + 1)] - now) ? i0 : Math.min(N - 1, i0 + 1);
    cur = {
      t: now, temp: g('temp'), feels: g('feels'), hum: H.hum?.[near], isDay: H.isDay?.[near] === 1, precip: H.precip?.[near],
      code: H.code?.[near], cloud: H.cloud?.[near], pressure: H.pressure?.[near], wind: H.wind?.[near], windDir: H.windDir?.[near], gust: H.gust?.[near], stale: true,
    };
  }

  // --- sources aligned to the hourly grid ---
  const enabled = bundle.sources.filter(s => prefs.sources[s.id] !== false);
  const W = sourceWeights(enabled.map(s => s.id), ctx.acc, now);
  const srcs = enabled.map(s => {
    const vals = new Array(N).fill(null);
    for (let i = i0; i < N; i++) vals[i] = valueAt(s, H.t[i]);
    const nowV = valueAt(s, now);
    const pv = s.precip ? new Array(N).fill(null).map((_, i) => (i >= i0 ? valueAt(s, H.t[i], 'precip') : null)) : null;
    return { id: s.id, ...(SOURCE_META[s.id] || { name: s.id, color: '#aaa' }), weight: W[s.id], vals, nowV, precip: pv };
  }).filter(s => s.vals.some(v => v != null));

  const entriesAt = (i, t = H.t[i]) => {
    const e = srcs.map(s => ({ id: s.id, v: i === 'now' ? s.nowV : s.vals[i], w: s.weight.w }));
    return e;
  };
  const withBlend = (e, v) => (e.filter(x => x.v != null).length >= 2 || v == null ? e : [...e, { id: 'blend', v, w: BLEND.w }]);

  // --- hourly consensus series ---
  const series = { best: [], lo: [], hi: [], n: [], spread: [] };
  for (let i = 0; i < N; i++) {
    const obs = H.temp[i];
    if (i < i0) { series.best.push(obs); series.lo.push(obs); series.hi.push(obs); series.n.push(0); series.spread.push(0); continue; }
    const c = consensusAt(withBlend(entriesAt(i), obs));
    if (c) { series.best.push(c.best); series.lo.push(c.lo); series.hi.push(c.hi); series.n.push(c.n); series.spread.push(c.spread); }
    else { series.best.push(obs); series.lo.push(obs); series.hi.push(obs); series.n.push(1); series.spread.push(0); }
  }

  // --- the headline number ---
  const nowEntries = entriesAt('now');
  if (fresh && cur.temp != null) nowEntries.push({ id: 'live', v: cur.temp, w: SOURCE_META.live.w });
  const hc = consensusAt(withBlend(nowEntries, cur.temp)) || { best: cur.temp, lo: cur.temp, hi: cur.temp, spread: 0, n: 1, total: 1, used: [], dropped: [] };
  const hero = { ...hc, conf: confidence(hc.spread, hc.n) };
  const dev = hero.best - (cur.temp ?? hero.best); // consensus vs. raw reading, applied to "feels like" so the two stay consistent
  const feels = cur.feels == null ? null : cur.feels + dev * 0.5 + (prefs.feelBias || 0);

  // --- hourly rows ---
  const hourly = [];
  for (let i = i0; i < Math.min(N, i0 + 49); i++) {
    hourly.push({
      i, t: H.t[i], temp: i === i0 ? hero.best : series.best[i], code: H.code[i], pop: H.pop?.[i] ?? 0, precip: H.precip?.[i] ?? 0,
      isDay: H.isDay[i] === 1, n: series.n[i],
    });
  }

  // --- daily rows (with consensus highs/lows) ---
  const hkeys = H.t.map(t => dateKey(t, tz));
  const todayKey = dateKey(now, tz);
  const days = [];
  for (let k = 0; k < D.t.length; k++) {
    const key = dateKey(D.t[k] + 12 * HOUR, tz);
    if (key < todayKey || days.length >= 10) continue;
    const idx = []; for (let i = 0; i < N; i++) if (hkeys[i] === key) idx.push(i);
    let hi = D.max[k], lo = D.min[k], consensus = false, hiRange = null, loRange = null;
    if (idx.length >= 20) {
      const vals = idx.map(i => series.best[i]).filter(v => v != null);
      const covered = idx.filter(i => i < i0 || series.n[i] >= 2).length;
      if (covered >= idx.length * 0.7) { hi = Math.max(...vals); lo = Math.min(...vals); consensus = true; }
      const maxes = [], mins = [];
      for (const s of srcs) {
        const v = idx.map(i => (i < i0 ? H.temp[i] : s.vals[i])).filter(x => x != null);
        const fut = idx.filter(i => i >= i0 && s.vals[i] != null).length;
        const needed = idx.filter(i => i >= i0).length;
        if (v.length >= 18 && fut >= needed * 0.8) { maxes.push(Math.max(...v)); mins.push(Math.min(...v)); }
      }
      if (maxes.length >= 2) { hiRange = [Math.min(...maxes), Math.max(...maxes)]; loRange = [Math.min(...mins), Math.max(...mins)]; }
    }
    days.push({
      k, key, t: D.t[k], isToday: key === todayKey, code: D.code[k], hi, lo, consensus, hiRange, loRange, idx,
      pop: D.popMax?.[k] ?? 0, precipSum: D.precipSum?.[k] ?? 0, windMax: D.windMax?.[k], gustMax: D.gustMax?.[k], uvMax: D.uvMax?.[k],
      sunrise: D.sunrise?.[k], sunset: D.sunset?.[k], daylight: D.daylight?.[k],
    });
  }
  const today = days[0];

  // --- misc numbers for cards ---
  const sum = (a, from, to) => { let s = 0; for (let i = Math.max(0, from); i < Math.min(N, to); i++) s += H.precip?.[i] || 0; return s; };
  const view = {
    now, prefs, fmt, tz, bundle, city: bundle.city, main, H, D, i0, N, expired, cur, feels, hero, srcs, series, hourly, days, today,
    hkeys, weights: W, fetchedAt: bundle.fetchedAt, air: bundle.air, alerts: (bundle.alerts || []).filter(a => !a.ends || a.ends > now), errors: bundle.errors || {},
    precipPast24: sum(i0 - 23, i0 + 1), precipNext24: sum(i0 + 1, i0 + 25),
    pressureTrend: H.pressure ? (H.pressure[i0] ?? 0) - (H.pressure[Math.max(0, i0 - 3)] ?? 0) : 0,
    uv: H.uv?.[i0], vis: H.vis?.[i0], dew: H.dew?.[i0],
  };
  view.rain = rainOutlook(view);
  view.summary = summarize(view);
  view.sky = skyTheme({
    code: cur.code, isDay: cur.isDay, now, sunrise: today?.sunrise, sunset: today?.sunset, forceDark: prefs.theme === 'dark' && false,
  });
  view.moon = moonInfo(now);
  view.sunTimes = sunTimes(view);
  return view;
}

// Consensus at a given hour offset from now (0 = now), with every source listed.
export function sourcesAt(view, k) {
  const i = clamp(view.i0 + k, 0, view.N - 1);
  const rows = view.srcs.map(s => ({ id: s.id, name: s.name, color: s.color, v: k === 0 ? s.nowV : s.vals[i], w: s.weight.w, mult: s.weight.mult, precip: s.precip?.[i] }));
  let c = consensusAt(rows.map(r => ({ id: r.id, v: r.v, w: r.w })));
  if (!c) return { t: view.H.t[i], rows, c: null };
  const drop = new Set(c.dropped.map(x => x.id));
  rows.forEach(r => { r.dropped = drop.has(r.id); });
  const wet = rows.filter(r => r.precip != null);
  return {
    t: k === 0 ? view.now : view.H.t[i], rows: rows.filter(r => r.v != null), c, conf: confidence(c.spread, c.n),
    rain: wet.length ? { yes: wet.filter(r => r.precip >= 0.1).length, total: wet.length } : null,
  };
}

// ---------- Rain nowcast ----------
function rainOutlook(v) {
  const M = v.main.minutely;
  const rows = (M.t || []).map((t, i) => ({ t, p: M.precip[i] || 0 })).filter(r => r.t >= v.now - 14 * 60e3).slice(0, 8);
  if (rows.length < 4) return null;
  const wet = r => r.p >= 0.05;
  const rainingNow = wet(rows[0]);
  const change = rows.findIndex(r => wet(r) !== rainingNow);
  const max = Math.max(...rows.map(r => r.p));
  const word = max < 0.25 ? 'Light rain' : max < 1.2 ? 'Rain' : 'Heavy rain';
  const kind = isSnow(v.cur.code) ? 'Snow' : word;
  const mins = t => Math.max(1, Math.round((t - v.now) / 60e3));
  let text, sub = null, leaveBy = null;
  if (!rainingNow && change < 0) text = 'No rain expected in the next 2 hours';
  else if (!rainingNow) {
    const t = rows[change].t, m = mins(t);
    text = `${kind === 'Snow' ? 'Snow' : 'Rain'} starting in ${m} min`;
    sub = m > 12 ? `Head out before ${v.fmt.time(t - 10 * 60e3)} to stay dry.` : 'Take an umbrella if you are heading out.';
    leaveBy = t - 10 * 60e3;
  } else if (change < 0) { text = `${kind} for the next 2 hours`; }
  else { const t = rows[change].t; text = `${kind} stopping in ${mins(t)} min`; sub = `Dry from about ${v.fmt.time(t)}.`; }
  return { rows, rainingNow, text, sub, leaveBy, max, dry: !rainingNow && change < 0 };
}

// ---------- One-sentence summary ----------
function summarize(v) {
  const { H, i0, N, series, fmt, cur } = v;
  const end = Math.min(N - 1, i0 + 24);
  let hiI = i0, loI = i0;
  for (let i = i0; i <= end; i++) { if (series.best[i] > series.best[hiI]) hiI = i; if (series.best[i] < series.best[loI]) loI = i; }
  const parts = [];
  const nowT = v.hero.best;
  if (hiI > i0 && series.best[hiI] - nowT >= 1.5 && hiI - i0 <= 14) parts.push(`Warmest around ${fmt.hour(H.t[hiI])} at ${fmt.temp(series.best[hiI])}.`);
  else if (loI > i0 && nowT - series.best[loI] >= 1.5 && loI - i0 <= 14) parts.push(`Cooling to ${fmt.temp(series.best[loI])} around ${fmt.hour(H.t[loI])}.`);
  const wet = i => (H.precip?.[i] || 0) >= 0.2 || ((H.pop?.[i] || 0) >= 60 && isPrecip(H.code[i]));
  const noun = i => (isSnow(H.code[i]) ? 'Snow' : 'Rain');
  if (wet(i0) && (cur.precip || 0) >= 0.05) {
    let e = i0; while (e <= end && wet(e)) e++;
    parts.push(e > end ? `${noun(i0)} continues through the next 24 hours.` : `${noun(i0)} easing around ${fmt.hour(H.t[e])}.`);
  } else {
    let s = -1; for (let i = i0 + 1; i <= end; i++) if (wet(i)) { s = i; break; }
    if (s < 0) parts.push('No rain expected in the next 24 hours.');
    else { let e = s; while (e <= end && wet(e)) e++; parts.push(`${noun(s)} expected around ${fmt.hour(H.t[s])}${e <= end ? ` until ${fmt.hour(H.t[e])}` : ''}.`); }
  }
  let gust = 0; for (let i = i0; i <= Math.min(N - 1, i0 + 12); i++) gust = Math.max(gust, H.gust?.[i] || 0);
  if (gust >= 50) parts.push(`Gusts up to ${fmt.wind(gust)} possible.`);
  return parts.join(' ');
}

// ---------- Sun ----------
function sunTimes(v) {
  const t = v.today, nxt = v.days[1];
  if (!t) return null;
  const rise = t.sunrise, set = t.sunset;
  let frac = null;
  if (rise && set) frac = clamp((v.now - rise) / (set - rise), -0.1, 1.1);
  return { rise, set, frac, nextRise: nxt?.sunrise, daylight: t.daylight, isUp: rise && set ? v.now >= rise && v.now <= set : v.cur.isDay };
}

// ---------- Moon (computed locally, no network) ----------
export function moonInfo(now) {
  const SYN = 29.530588853, REF = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((now - REF) / DAY) % SYN + SYN) % SYN;
  const p = age / SYN;
  const illum = (1 - Math.cos(2 * Math.PI * p)) / 2;
  const names = [[0.03, 'New moon'], [0.22, 'Waxing crescent'], [0.28, 'First quarter'], [0.47, 'Waxing gibbous'], [0.53, 'Full moon'], [0.72, 'Waning gibbous'], [0.78, 'Last quarter'], [0.97, 'Waning crescent'], [1.01, 'New moon']];
  const name = names.find(([m]) => p < m)[1];
  const toFull = ((0.5 - p + 1) % 1) * SYN, toNew = ((1 - p) % 1) * SYN;
  return { p, illum, name, nextFull: now + toFull * DAY, nextNew: now + toNew * DAY, age };
}
export function moonPath(p, r = 20) {
  // Returns an SVG path for the lit part of the moon, centred on (0,0).
  const k = Math.cos(2 * Math.PI * p), rx = Math.abs(k) * r;
  const waxing = p < 0.5;
  const outer = `M0 ${-r} A${r} ${r} 0 0 1 0 ${r}`;
  const sweep = k > 0 ? 0 : 1;
  const d = `${outer} A${rx.toFixed(2)} ${r} 0 0 ${sweep} 0 ${-r}Z`;
  return { d, flip: !waxing };
}

// ---------- Category helpers ----------
export function uvInfo(uv) {
  const u = uv == null ? 0 : uv;
  if (u < 3) return { label: 'Low', color: '#30d158', tip: 'No protection needed for most people.' };
  if (u < 6) return { label: 'Moderate', color: '#ffd60a', tip: 'Wear sunscreen if you will be out for a while.' };
  if (u < 8) return { label: 'High', color: '#ff9f0a', tip: 'Sunscreen, hat and shade are a good idea.' };
  if (u < 11) return { label: 'Very high', color: '#ff453a', tip: 'Limit midday sun. Cover up and use SPF 30+.' };
  return { label: 'Extreme', color: '#bf5af2', tip: 'Avoid the sun around midday.' };
}
export function aqiInfo(a) {
  if (a == null) return null;
  if (a <= 50) return { label: 'Good', color: '#30d158', tip: 'Air quality is satisfactory.' };
  if (a <= 100) return { label: 'Moderate', color: '#ffd60a', tip: 'Unusually sensitive people may notice effects.' };
  if (a <= 150) return { label: 'Unhealthy for some', color: '#ff9f0a', tip: 'Sensitive groups should limit time outdoors.' };
  if (a <= 200) return { label: 'Unhealthy', color: '#ff453a', tip: 'Everyone may begin to feel effects.' };
  if (a <= 300) return { label: 'Very unhealthy', color: '#bf5af2', tip: 'Avoid prolonged outdoor activity.' };
  return { label: 'Hazardous', color: '#a2203f', tip: 'Stay indoors if you can.' };
}
export function pollenLevel(g) {
  if (g == null) return null;
  if (g < 1) return { label: 'None', c: 0 };
  if (g < 10) return { label: 'Low', c: 1 };
  if (g < 50) return { label: 'Moderate', c: 2 };
  if (g < 200) return { label: 'High', c: 3 };
  return { label: 'Very high', c: 4 };
}
export function feelsText(v) {
  const d = v.feels - v.hero.best;
  if (d >= 1.5) return (v.cur.hum ?? 0) > 60 ? 'Humidity is making it feel warmer.' : 'It feels warmer than the actual temperature.';
  if (d <= -1.5) return (v.cur.wind ?? 0) > 15 ? 'Wind is making it feel colder.' : 'It feels colder than the actual temperature.';
  return 'Similar to the actual temperature.';
}

// Accuracy report rows
export function accuracyRows(view) {
  return view.srcs.map(s => ({ id: s.id, name: s.name, color: s.color, ...s.weight, ...s.weight.stats, enough: s.weight.stats.n >= MIN_SAMPLES }))
    .sort((a, b) => (a.mae ?? 99) - (b.mae ?? 99));
}

export { wmo, hourOfDay };
