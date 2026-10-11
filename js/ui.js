// HTML renderers for every card, list row and sheet. Pure functions: view → string.
import { esc, clamp, tempColor, cardinal, ago, HOUR, hourOfDay } from './util.js';
import { icon, ui as I, wmo } from './icons.js';
import { SOURCE_META, EXTRA, MODELS } from './api.js';
import { sourcesAt, uvInfo, aqiInfo, pollenLevel, feelsText, moonPath, accuracyRows } from './model.js';
import { MIN_SAMPLES } from './consensus.js';
import { drawChart } from './chart.js';
import { RadarMap } from './radar.js';

const card = (name, inner, cls = '') => `<section class="card c-${name} ${cls}" data-card="${name}">${inner}</section>`;
const title = (ico, text, right = '') => `<h3 class="ct">${ico}<span>${text}</span>${right}</h3>`;
const seg = (act, opts, cur) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-act="${act}" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
const metaOf = id => SOURCE_META[id] || { name: id, color: '#aaa' };

// ---------- Hero ----------
export function stripSVG(v) {
  const h = v.hero, W = 150;
  const half = Math.max(1.5, h.spread * 0.75);
  const X = val => clamp(8 + (val - (h.best - half)) / (2 * half) * (W - 16), 6, W - 6);
  const dots = [...h.used.map(u => [u, false]), ...(h.dropped || []).map(u => [u, true])].map(([u, drop]) => {
    const c = metaOf(u.id).color;
    return drop ? `<circle cx="${X(u.v).toFixed(1)}" cy="8" r="3" fill="none" stroke="${c}" stroke-width="1.3" opacity=".8"/>` : `<circle cx="${X(u.v).toFixed(1)}" cy="8" r="3.3" fill="${c}" opacity=".95"/>`;
  }).join('');
  const bx = X(h.best);
  return `<svg class="strip" viewBox="0 0 ${W} 16" width="${W}" height="16" aria-hidden="true"><line x1="6" x2="${W - 6}" y1="8" y2="8" stroke="rgba(255,255,255,.28)" stroke-width="1.5" stroke-linecap="round"/>${dots}<path d="M${bx} 1.5l4.2 6.5-4.2 6.5-4.2-6.5z" fill="#fff"/></svg>`;
}

export function hero(v, st) {
  const c = v.city, f = v.fmt, h = v.hero, t = v.today;
  const loc = c.isCurrent ? 'My location' : [c.admin, c.country].filter(Boolean).join(', ');
  const age = Date.now() - v.fetchedAt;
  const stale = (st.offline || age > 45 * 60e3) && !st.loading;
  const consText = h.n > 1
    ? `<b>${h.conf.label}</b> · ${h.n} sources${h.spread >= 0.05 ? ` within ${f.deltaStr(h.spread)}` : ' agree'}`
    : `<b>Single source</b> · no cross-check available`;
  const w = wmo(v.cur.code);
  return `<header class="hero">
    <div class="hcity">${c.isCurrent ? I.locate.replace('class="li"', 'class="li loc"') : ''}<h1>${esc(c.name)}</h1></div>
    <div class="hloc">${esc(loc)}</div>
    <div class="htemp" aria-label="${f.temp(h.best)} ${w.label}">${f.temp(h.best)}</div>
    <div class="hcond">${w.label}</div>
    <div class="hhl">H:${f.temp(t?.hi ?? h.best)}  L:${f.temp(t?.lo ?? h.best)}</div>
    <button class="cons ${h.conf.level}" data-act="to-sources" aria-label="Show source comparison">${stripSVG(v)}<span>${consText}</span></button>
    ${stale ? `<div class="chip warn">${st.offline ? 'Offline · ' : ''}Last updated ${ago(age)}</div>` : ''}
    ${v.expired ? `<div class="chip warn">This forecast has run out. Connect to refresh.</div>` : ''}
    <p class="hsum">${esc(v.summary)}</p>
  </header>`;
}

export function mini(v) {
  const w = wmo(v.cur.code);
  return `<div class="mrow"><b>${esc(v.city.name)}</b><span>${v.fmt.temp(v.hero.best)}<i>|</i>${w.label}</span></div>`;
}

// ---------- Alerts ----------
export function alerts(v, st) {
  const col = s => ({ Extreme: '#ff453a', Severe: '#ff9f0a', Moderate: '#ffd60a' }[s] || '#64d2ff');
  return v.alerts.map((a, i) => `<div class="alert" style="--ac:${col(a.severity)}">
    <button data-act="alert" data-v="${i}" aria-expanded="${st.alertOpen === i}"><b>${esc(a.event)}</b><span>${esc(a.headline || '')}</span></button>
    ${st.alertOpen === i ? `<div class="abody">${esc((a.description || '').slice(0, 900))}${a.instruction ? `<br><br><b>What to do:</b> ${esc(a.instruction.slice(0, 400))}` : ''}</div>` : ''}
  </div>`).join('');
}

// ---------- Next 2 hours ----------
export function rain(v) {
  const r = v.rain;
  const mx = Math.max(0.6, r.max);
  const bars = r.rows.map(x => `<i style="height:${Math.max(3, Math.round(clamp(x.p / mx, 0, 1) * 42))}px" class="${x.p >= 0.05 ? 'wet' : ''}"></i>`).join('');
  return `${title(I.umbrella, 'Next 2 hours')}
    <div class="rtext">${r.text}</div>${r.sub ? `<div class="rsub">${esc(r.sub)}</div>` : ''}
    <div class="rbars ${r.dry ? 'dry' : ''}" aria-hidden="true">${bars}</div>
    <div class="raxis"><span>Now</span><span>+1 h</span><span>+2 h</span></div>`;
}

// ---------- Hourly strip ----------
export function hourly(v) {
  const f = v.fmt, rows = v.hourly;
  const evs = [];
  v.days.slice(0, 4).forEach(d => {
    if (d.sunrise) evs.push({ t: d.sunrise, kind: 'rise' });
    if (d.sunset) evs.push({ t: d.sunset, kind: 'set' });
  });
  const items = [];
  rows.forEach((r, j) => {
    const p = Math.round(r.pop / 10) * 10;
    items.push(`<div class="hr"><span class="hl">${j === 0 ? 'Now' : f.hour(r.t)}</span>${icon(r.code, r.isDay, 34)}<span class="pp">${p >= 20 ? p + '%' : ''}</span><b>${f.temp(r.temp)}</b></div>`);
    const nextT = rows[j + 1]?.t ?? Infinity;
    evs.filter(e => e.t > r.t && e.t < nextT).forEach(e => items.push(`<div class="hr ev"><span class="hl">${f.time(e.t)}</span>${e.kind === 'rise' ? I.sunrise : I.sunset}<span class="pp"></span><b>${e.kind === 'rise' ? 'Sunrise' : 'Sunset'}</b></div>`));
  });
  return `${title(I.clock, 'Hourly forecast')}<div class="hscroll">${items.join('')}</div>`;
}

// ---------- Temperature chart ----------
export function chart(v, st) {
  return `${title(I.chart, 'Temperature', seg('chart-h', [['24', '24 h'], ['48', '48 h'], ['168', '7 d']], st.h))}
    <div class="readout" aria-live="polite"></div>
    <div class="chartbox"></div>
    <div class="legend"><span><i class="lg-line"></i>Best estimate</span><span><i class="lg-band"></i>Range of sources</span></div>`;
}

export function chartSlice(v, hours) {
  const a = v.i0, b = Math.min(v.N - 1, v.i0 + hours);
  const sl = arr => arr.slice(a, b + 1);
  const best = sl(v.series.best).map((x, i) => (i === 0 ? v.hero.best : x));
  return { t: sl(v.H.t), best, lo: sl(v.series.lo).map((x, i) => Math.min(x, best[i])), hi: sl(v.series.hi).map((x, i) => Math.max(x, best[i])) };
}

export function mountChart(el, v, st) {
  const box = el.querySelector('.chartbox'), out = el.querySelector('.readout');
  const f = v.fmt;
  const base = () => {
    out.innerHTML = `<div class="rt-main">${f.temp(v.hero.best)} <small>now · ${v.hero.n > 1 ? `${v.hero.n} sources` : 'one source'}</small></div><div class="rt-sub">Drag across the chart to see each source.</div>`;
  };
  base();
  const data = chartSlice(v, +st.h || 24);
  drawChart(box, data, {
    fmt: f, tz: v.tz, now: v.now,
    onScrub: idx => {
      if (idx == null) return base();
      const s = sourcesAt(v, idx);
      const when = idx === 0 ? 'Now' : `${f.wk(data.t[idx])} ${f.hour(data.t[idx])}`;
      const chips = s.rows.map(r => `<span class="chp ${r.dropped ? 'drop' : ''}"><i style="background:${r.color}"></i>${esc(r.name)} ${f.temp(r.v)}</span>`).join('');
      out.innerHTML = `<div class="rt-main">${f.temp(data.best[idx])} <small>${when}${s.c ? ` · ${f.temp(s.c.lo)}–${f.temp(s.c.hi)}` : ''}</small></div><div class="chips">${chips}</div>`;
    },
  });
}

// ---------- Sources compared ----------
export function sources(v, st) {
  const f = v.fmt, k = +st.off || 0;
  const s = sourcesAt(v, k);
  const head = seg('src-off', [[0, 'Now'], [3, '+3 h'], [6, '+6 h'], [12, '+12 h'], [24, '+24 h'], [48, '+48 h']], k);
  let body;
  if (!s.c) body = `<p class="muted">No sources available for this time.</p>`;
  else {
    const vals = s.rows.map(r => r.v);
    const lo = Math.min(...vals), hi = Math.max(...vals), mid = (lo + hi) / 2, half = Math.max(1.5, (hi - lo) / 2 + 0.6);
    const pos = x => clamp((x - (mid - half)) / (2 * half) * 100, 2, 98);
    const rows = [...s.rows].sort((a, b) => b.v - a.v).map(r => `<div class="srow ${r.dropped ? 'drop' : ''}">
      <span class="sn"><i style="background:${r.color}"></i>${esc(r.name)}</span>
      <span class="trk"><span class="tick" style="left:${pos(s.c.best)}%"></span><span class="dot" style="left:${pos(r.v)}%;background:${r.color}"></span></span>
      <b class="sv">${f.temp(r.v)}</b>
      <span class="sw" title="Weight in the best estimate">${r.dropped ? 'ignored' : r.mult !== 1 ? `${r.w.toFixed(1)}×` : ''}</span></div>`).join('');
    const when = k === 0 ? 'right now' : `${f.wk(s.t)} ${f.hour(s.t)}`;
    body = `<div class="shead"><div><b class="big">${f.temp(s.c.best)}</b><small> best estimate ${when}</small></div>
      <div class="sconf ${s.conf.level}">${s.conf.label}${s.c.n > 1 ? ` · ${f.deltaStr(s.c.spread)} spread` : ''}</div></div>
      <div class="srows">${rows}</div>
      ${s.rain ? `<p class="note">${rainNote(s.rain)}</p>` : ''}`;
  }
  const failed = Object.keys(v.errors).filter(id => SOURCE_META[id]).map(id => SOURCE_META[id].name);
  return `${title(I.scale, 'Sources compared')}${head}${body}
    <p class="note">The best estimate is a weighted median. Far-off outliers are ignored, and sources that have been closer here lately count for more.${failed.length ? ` Unavailable right now: ${esc(failed.join(', '))}.` : ''}</p>`;
}

function rainNote({ yes, total }) {
  if (yes === 0) return `All ${total} models expect it to stay dry.`;
  if (yes === total) return `All ${total} models expect rain.`;
  return `${yes} of ${total} models expect rain.`;
}

// ---------- 10-day ----------
export function daily(v, st) {
  const f = v.fmt;
  const gmin = Math.min(...v.days.map(d => d.lo)), gmax = Math.max(...v.days.map(d => d.hi));
  const span = Math.max(1, gmax - gmin);
  const rows = v.days.map((d, k) => {
    const left = (d.lo - gmin) / span * 100, wd = Math.max(8, (d.hi - d.lo) / span * 100);
    const dot = d.isToday ? `<u style="left:${clamp((v.hero.best - gmin) / span * 100, 0, 100)}%"></u>` : '';
    const p = Math.round(d.pop / 10) * 10;
    const open = st.day === k;
    return `<button class="drow" data-act="day" data-v="${k}" aria-expanded="${open}">
      <span class="dn">${d.isToday ? 'Today' : f.wk(d.t + 12 * HOUR)}</span>
      <span class="di">${icon(d.code, true, 28)}<small>${p >= 20 ? p + '%' : ''}</small></span>
      <span class="dl">${f.temp(d.lo)}</span>
      <span class="bar"><i style="left:${left.toFixed(1)}%;width:${wd.toFixed(1)}%;background:linear-gradient(90deg,${tempColor(d.lo)},${tempColor(d.hi)})"></i>${dot}</span>
      <span class="dh">${f.temp(d.hi)}</span></button>
      ${open ? dayDetail(v, d) : ''}`;
  }).join('');
  return `${title(I.cal, '10-day forecast')}<div class="drows">${rows}</div>`;
}
function dayDetail(v, d) {
  const f = v.fmt;
  const range = (r, kind) => (r ? `<div><span>Sources ${kind}</span><b>${f.temp(r[0])}–${f.temp(r[1])}</b></div>` : '');
  return `<div class="dd">
    <div><span>Best estimate</span><b>${f.temp(d.hi)} / ${f.temp(d.lo)}</b></div>
    ${range(d.hiRange, 'high')}${range(d.loRange, 'low')}
    <div><span>${wmo(d.code).label}</span><b>${d.pop}% chance</b></div>
    <div><span>Rain total</span><b>${f.precip(d.precipSum)}</b></div>
    <div><span>Wind up to</span><b>${f.wind(d.windMax)}</b></div>
    <div><span>UV peak</span><b>${d.uvMax != null ? Math.round(d.uvMax) : '–'}</b></div>
    <div><span>Sun</span><b>${d.sunrise ? f.time(d.sunrise) : '–'} – ${d.sunset ? f.time(d.sunset) : '–'}</b></div>
    ${d.consensus ? '' : '<div class="full"><span>Further out, only one forecast is available.</span></div>'}
  </div>`;
}

// ---------- Small cards ----------
export function uv(v) {
  const u = v.uv ?? 0, info = uvInfo(u);
  let peak = '';
  if (v.today) {
    let bi = -1;
    for (const i of v.today.idx) if ((v.H.uv?.[i] ?? 0) > (bi < 0 ? 0 : v.H.uv[bi])) bi = i;
    if (bi >= 0 && v.H.uv[bi] >= 0.5) peak = `Peak ${Math.round(v.H.uv[bi])} at ${v.fmt.hour(v.H.t[bi])}.`;
  }
  return `${title(I.sun, 'UV index')}<div class="big">${Math.round(u)}</div><div class="lab">${info.label}</div>
    <div class="ubar"><i style="left:${clamp(u / 12, 0, 1) * 100}%"></i></div><p class="foot">${peak} ${info.tip}</p>`;
}
export function wind(v) {
  const c = v.cur, f = v.fmt, deg = c.windDir ?? 0;
  const ticks = [...Array(36)].map((_, i) => {
    const a = i * 10 * Math.PI / 180, m = i % 9 === 0, r1 = m ? 37 : 40, r2 = 44;
    return `<line x1="${(50 + Math.sin(a) * r1).toFixed(1)}" y1="${(50 - Math.cos(a) * r1).toFixed(1)}" x2="${(50 + Math.sin(a) * r2).toFixed(1)}" y2="${(50 - Math.cos(a) * r2).toFixed(1)}" class="${m ? 'tm' : 'tn'}"/>`;
  }).join('');
  return `${title(I.wind, 'Wind')}<svg class="compass" viewBox="0 0 100 100" aria-hidden="true">${ticks}
    <text x="50" y="30" class="cl">N</text><text x="74" y="53" class="cl">E</text><text x="50" y="77" class="cl">S</text><text x="26" y="53" class="cl">W</text>
    <g transform="rotate(${deg} 50 50)"><path d="M50 3l5.5 9h-11z" fill="#fff"/></g>
    <text x="50" y="52" class="cs">${f.wind(c.wind).split(' ')[0]}</text><text x="50" y="62" class="cu">${f.windUnit()}</text></svg>
    <p class="foot">From the ${cardinal(deg)}. Gusts up to ${f.wind(c.gust ?? c.wind)}.</p>`;
}
export function sun(v) {
  const s = v.sunTimes, f = v.fmt;
  if (!s || !s.rise) return `${title(I.sunset, 'Sun')}<p class="foot">Sun times are unavailable.</p>`;
  const up = s.isUp;
  const t = clamp(s.frac, 0, 1), mx = 80 - 68 * Math.cos(Math.PI * t), my = 56 - 68 * Math.sin(Math.PI * t);
  return `${title(up ? I.sunset : I.sunrise, up ? 'Sunset' : 'Sunrise')}
    <div class="big sm">${f.time(up ? s.set : (v.now < s.rise ? s.rise : s.nextRise ?? s.rise))}</div>
    <svg class="arc" viewBox="0 0 160 66" aria-hidden="true"><line x1="4" x2="156" y1="56" y2="56" class="hz"/><path d="M12 56A68 68 0 0 1 148 56" class="ap"/>
      ${up ? `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6" fill="#FFD43B"/>` : ''}</svg>
    <p class="foot">${up ? `Sunrise was ${f.time(s.rise)}.` : `Sunset ${f.time(s.set)}.`}${s.daylight ? ` ${Math.floor(s.daylight / 3600)} h ${Math.round(s.daylight % 3600 / 60)} min of daylight.` : ''}</p>`;
}
export function precip(v) {
  const f = v.fmt;
  return `${title(I.drop, 'Precipitation')}<div class="big sm">${f.precip(v.precipPast24)}</div><div class="lab">in the last 24 h</div>
    <p class="foot">${v.precipNext24 >= 0.1 ? `${f.precip(v.precipNext24)} expected in the next 24 h.` : 'None expected in the next 24 h.'}</p>`;
}
export function feels(v) {
  const f = v.fmt, b = v.prefs.feelBias || 0;
  return `${title(I.thermo, 'Feels like')}<div class="big">${v.feels == null ? '–' : f.temp(v.feels)}</div>
    <p class="foot">${feelsText(v)}${b ? ` Adjusted ${b > 0 ? '+' : '−'}${f.deltaInt(Math.abs(b))} for how you feel the cold.` : ''}</p>`;
}
export function humidity(v) {
  const f = v.fmt;
  return `${title(I.drop, 'Humidity')}<div class="big">${Math.round(v.cur.hum ?? 0)}%</div>
    <p class="foot">The dew point is ${v.dew == null ? '–' : f.temp(v.dew)} right now.</p>`;
}
export function visibility(v) {
  const f = v.fmt, m = v.vis;
  const t = m == null ? '' : m >= 10000 ? 'Clear view.' : m >= 4000 ? 'Slightly hazy.' : m >= 1000 ? 'Poor visibility.' : 'Very poor visibility.';
  return `${title(I.eye, 'Visibility')}<div class="big sm">${f.dist(m)}</div><p class="foot">${t}</p>`;
}
export function pressure(v) {
  const f = v.fmt, d = v.pressureTrend;
  const t = Math.abs(d) < 0.6 ? 'Steady' : d > 0 ? 'Rising' : 'Falling';
  return `${title(I.gauge, 'Pressure')}<div class="big sm">${f.pressure(v.cur.pressure)}</div><div class="lab">${d > 0.6 ? '↗' : d < -0.6 ? '↘' : '→'} ${t}</div>
    <p class="foot">${d < -2 ? 'A quick drop can mean unsettled weather.' : d > 2 ? 'Rising pressure usually brings clearer skies.' : 'No big change over the last 3 hours.'}</p>`;
}
export function aqi(v) {
  const a = v.air?.us_aqi, info = aqiInfo(a);
  if (!info) return null;
  return `${title(I.leaf, 'Air quality')}<div class="big">${Math.round(a)}</div><div class="lab">${info.label}</div>
    <div class="abar"><i style="left:${clamp(a / 300, 0, 1) * 100}%"></i></div>
    <p class="foot">${info.tip}${v.air.pm2_5 != null ? ` PM2.5: ${v.air.pm2_5.toFixed(0)} µg/m³.` : ''}</p>`;
}
export function pollen(v) {
  const a = v.air;
  if (!a) return null;
  const list = [['Alder', a.alder_pollen], ['Birch', a.birch_pollen], ['Grass', a.grass_pollen], ['Mugwort', a.mugwort_pollen], ['Olive', a.olive_pollen], ['Ragweed', a.ragweed_pollen]]
    .map(([n, g]) => [n, pollenLevel(g)]).filter(([, l]) => l).sort((x, y) => y[1].c - x[1].c).slice(0, 4);
  if (!list.length) return null;
  return `${title(I.leaf, 'Pollen')}<div class="plist">${list.map(([n, l]) => `<div><span>${n}</span><b class="pl${l.c}">${l.label}</b></div>`).join('')}</div>`;
}
export function moon(v) {
  const m = v.moon, f = v.fmt;
  const { d, flip } = moonPath(m.p, 22);
  const full = m.p < 0.5 ? `Full moon ${f.day(m.nextFull)}.` : `Full moon ${f.day(m.nextFull)}.`;
  return `${title(I.moon, 'Moon')}<svg class="moonsvg" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="22" fill="rgba(255,255,255,.14)"/>
    <g transform="translate(28 28)${flip ? ' scale(-1 1)' : ''}"><path d="${d}" fill="#F3EFDD"/></g></svg>
    <div class="lab">${m.name}</div><p class="foot">${Math.round(m.illum * 100)}% lit. ${full}</p>`;
}
export function radarCard() {
  return `${title(I.map, 'Rain radar')}<div class="rmini" data-act="open-radar" role="button" aria-label="Open rain radar"></div><p class="foot">Tap to open the full radar.</p>`;
}

// ---------- Report card (accuracy learning) ----------
export function accuracy(v) {
  const f = v.fmt, rows = accuracyRows(v);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const body = !total
    ? `<p class="muted">Quorum is learning how each source performs at this location. It logs what every source predicts, then checks it against what actually happened. Open the app again tomorrow to see results.</p>`
    : rows.map(r => {
      const w = r.mae == null ? 0 : clamp(1 - r.mae / 3, 0.06, 1) * 100;
      return `<div class="arow"><span class="sn"><i style="background:${r.color}"></i>${esc(r.name)}</span>
        <span class="abarw"><i style="width:${w.toFixed(0)}%;background:${r.color}"></i></span>
        <span class="av">${r.enough ? `${f.deltaStr(r.mae)} off` : `${r.n}/${MIN_SAMPLES}`}</span></div>`;
    }).join('');
  const best = rows.find(r => r.enough);
  return `${title(I.target, 'Forecast report card')}
    ${best ? `<p class="lead">${esc(best.name)} has been the closest here this week, ${f.deltaStr(best.mae)} off on average.</p>` : ''}
    <div class="arows">${body}</div>
    <p class="note">Last 7 days at this location, scored against Open-Meteo's observation-based analysis. Sources with more samples and smaller errors get more say in the best estimate.</p>`;
}

// ---------- Page assembly ----------
export function page(v, st) {
  const parts = [hero(v, st)];
  if (v.alerts.length) parts.push(card('alerts', alerts(v, st), 'wide'));
  if (v.rain) parts.push(card('rain', rain(v), 'wide'));
  parts.push(card('hourly', hourly(v), 'wide'));
  parts.push(card('chart', chart(v, st), 'wide'));
  parts.push(card('daily', daily(v, st), 'half'));
  parts.push(card('sources', sources(v, st), 'half'));
  parts.push('<div class="grid">');
  const small = [['uv', uv], ['wind', wind], ['sun', sun], ['precip', precip], ['feels', feels], ['humidity', humidity], ['vis', visibility], ['pressure', pressure], ['aqi', aqi], ['pollen', pollen], ['moon', moon]];
  for (const [n, fn] of small) { const h = fn(v); if (h) parts.push(card(n, h, 'sm')); }
  parts.push('</div>');
  parts.push(card('radar', radarCard(), 'wide'));
  parts.push(card('accuracy', accuracy(v), 'wide'));
  const age = Date.now() - v.fetchedAt;
  parts.push(`<footer class="pfoot"><button data-act="refresh">${I.refresh}<span>${st.loading ? 'Updating…' : `Updated ${ago(age)}`}</span></button>
    <p>Forecasts from ${esc(v.srcs.map(s => s.name).join(', ') || 'Open-Meteo')}. Air quality by Open-Meteo. Nothing leaves your device except the requests to these services.</p></footer>`);
  return parts.join('');
}

const CARD_FN = { alerts, rain, hourly, chart, daily, sources };
export function renderCard(name, v, st) { return CARD_FN[name](v, st); }

export function mountPage(root, v, st) {
  const ch = root.querySelector('[data-card="chart"]');
  if (ch) mountChart(ch, v, st);
  const rm = root.querySelector('.rmini');
  if (rm) {
    root._radar?.destroy?.();
    const make = () => { const m = new RadarMap(rm, { lat: v.city.lat, lon: v.city.lon, zoom: 6, interactive: false }); root._radar = m; m.load(); };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); make(); } }, { rootMargin: '200px' });
      io.observe(rm);
    } else make();
  }
}

// ---------- Loading & empty states ----------
export function skeleton(city) {
  return `<header class="hero skel"><div class="hcity"><h1>${esc(city.name)}</h1></div><div class="hloc">${esc(city.isCurrent ? 'My location' : [city.admin, city.country].filter(Boolean).join(', '))}</div>
    <div class="htemp">–°</div><div class="hcond">Loading forecast…</div></header>
    ${['wide', 'wide', 'half', 'half'].map(c => `<section class="card ${c} shimmer"><div class="sk"></div></section>`).join('')}`;
}
export function errorState(city, msg) {
  return `<header class="hero"><div class="hcity"><h1>${esc(city.name)}</h1></div><div class="htemp">–</div></header>
    <section class="card wide"><h3 class="ct">${I.alert}<span>Can’t load this forecast</span></h3><p class="muted">${esc(msg)} Check your connection, then try again.</p>
    <button class="btn" data-act="refresh">${I.refresh}<span>Try again</span></button></section>`;
}

// ---------- City list rows ----------
export function listRow(city, v, { edit }) {
  const f = v?.fmt;
  const sky = v?.sky;
  const lt = v ? new Intl.DateTimeFormat(undefined, { timeZone: v.tz, hour: 'numeric', minute: '2-digit', ...(v.prefs.clock === '24' ? { hourCycle: 'h23' } : v.prefs.clock === '12' ? { hour12: true } : {}) }).format(Date.now()) : '';
  const sub = [city.isCurrent ? 'My location' : '', lt].filter(Boolean).join(' · ');
  return `<div class="lrow ${edit ? 'edit' : ''}" style="--t:${sky?.top || '#2878d6'};--b:${sky?.bottom || '#74bff5'}">
    <button class="lmain" data-act="pick" data-id="${esc(city.id)}">
      <span class="lt"><b>${esc(city.name)}</b><small>${esc(sub || [city.admin, city.country].filter(Boolean).join(', '))}</small><em>${v ? wmo(v.cur.code).label : 'Loading…'}</em></span>
      <span class="lr"><span class="ltemp">${v ? f.temp(v.hero.best) : '–'}</span><small>${v ? `H:${f.temp(v.today?.hi ?? v.hero.best)} L:${f.temp(v.today?.lo ?? v.hero.best)}` : ''}</small></span>
    </button>
    <button class="ldel" data-act="del" data-id="${esc(city.id)}" aria-label="Remove ${esc(city.name)}">${I.close}</button></div>`;
}

export function searchResult(r) {
  return `<button class="sres" data-act="add" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${esc(r.name)}" data-admin="${esc(r.admin)}" data-country="${esc(r.country)}">
    <b>${esc(r.name)}</b><small>${esc([r.admin, r.country].filter(Boolean).join(', '))}</small></button>`;
}

// ---------- Settings ----------
export function settings(p, env) {
  const row = (label, ctrl, hint = '') => `<div class="srw"><div><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</div>${ctrl}</div>`;
  const pseg = (key, opts) => `<div class="seg" role="group" data-pref="${key}">${opts.map(([v, l]) => `<button data-v="${v}" aria-pressed="${p[key] === v}">${l}</button>`).join('')}</div>`;
  const toggle = (id, label, hint, on, extra = '') => `<label class="srw tgl"><div><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</div><span class="sw2"><input type="checkbox" data-src="${id}" ${on ? 'checked' : ''}><i></i></span></label>${extra}`;
  const srcRows = [
    ...MODELS.map(m => toggle(m.id, esc(m.full), '', p.sources[m.id] !== false)),
    toggle('metno', EXTRA.metno.full, 'Best effort from the browser', p.sources.metno !== false),
    toggle('nws', EXTRA.nws.full, 'United States only', p.sources.nws !== false),
    toggle('owm', 'OpenWeather', 'Needs your free API key below', p.sources.owm !== false),
    toggle('wapi', 'WeatherAPI.com', 'Needs your free API key below', p.sources.wapi !== false),
  ].join('');
  const bias = p.feelBias || 0;
  return `<div class="sgroup"><h4>Units</h4>
      ${row('Temperature', pseg('temp', [['c', '°C'], ['f', '°F']]))}
      ${row('Wind', pseg('wind', [['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s'], ['kn', 'kn']]))}
      ${row('Rain', pseg('precip', [['mm', 'mm'], ['in', 'in']]))}
      ${row('Pressure', pseg('pressure', [['hpa', 'hPa'], ['inhg', 'inHg'], ['mmhg', 'mmHg']]))}
      ${row('Clock', pseg('clock', [['auto', 'Auto'], ['12', '12 h'], ['24', '24 h']]))}
      ${row('Menus', pseg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]), 'Weather screens always follow the sky.')}
    </div>
    <div class="sgroup"><h4>Feels-like calibration</h4>
      <div class="srw col"><div><b>How do you feel the cold?</b><small>Shifts every “feels like” number to match you.</small></div>
      <input type="range" id="feelBias" min="-4" max="4" step="0.5" value="${bias}" aria-label="Feels-like adjustment">
      <div class="rlab"><span>Runs cold</span><output id="feelOut">${bias === 0 ? 'Neutral' : (bias > 0 ? '+' : '−') + Math.abs(bias) + '°C'}</output><span>Runs warm</span></div></div>
    </div>
    <div class="sgroup"><h4>Sources</h4><p class="muted">Turn sources off to leave them out of the best estimate. Changes apply at the next refresh.</p>${srcRows}
      <div class="srw col"><div><b>OpenWeather key</b><small>Stored only on this device.</small></div><input class="inp" id="key-owm" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste key" value="${esc(p.keys.owm)}"></div>
      <div class="srw col"><div><b>WeatherAPI key</b><small>Stored only on this device.</small></div><input class="inp" id="key-wapi" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste key" value="${esc(p.keys.wapi)}"></div>
    </div>
    <div class="sgroup"><h4>Tools</h4>
      <button class="btn wide" data-act="glance">${I.glance}<span>Glance mode</span></button>
      <button class="btn wide" data-act="share">${I.share}<span>Share this forecast</span></button>
      <button class="btn wide" data-act="refresh-all">${I.refresh}<span>Refresh every city</span></button>
    </div>
    <div class="sgroup"><h4>Data on this device</h4>
      <p class="muted">${env.persisted ? 'Storage is protected from automatic clean-up.' : 'On iPhone and iPad, add Quorum to your Home Screen (Share → Add to Home Screen) so Safari keeps your forecasts and accuracy history.'}</p>
      <button class="btn wide danger" data-act="clear-cache">${I.close}<span>Clear cached forecasts</span></button>
      <button class="btn wide danger" data-act="clear-acc">${I.close}<span>Reset accuracy history</span></button>
      <p class="muted">Quorum ${esc(env.version)} · Forecast data from Open-Meteo, MET Norway, NWS and others. Radar by RainViewer, map © OpenStreetMap contributors © CARTO.</p>
    </div>`;
}

// ---------- Compare sheet ----------
export function compareShell(cities, days, st) {
  const opt = (arr, sel) => arr.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const list = st.mode === 'cities' ? cities : days;
  return `${seg('cmp-mode', [['cities', 'Two cities'], ['days', 'Two days']], st.mode)}
    <div class="cpick"><label><i class="cA"></i><select data-cmp="a" aria-label="First">${opt(list, st.a)}</select></label>
    <label><i class="cB"></i><select data-cmp="b" aria-label="Second">${opt(list, st.b)}</select></label></div>
    <div class="cbody"></div>`;
}
export function compareBody(rows) {
  const row = ([label, a, b]) => `<div class="crow"><span class="ca">${esc(a)}</span><span class="cl">${esc(label)}</span><span class="cb">${esc(b)}</span></div>`;
  return `<div class="cchart"></div><div class="ctable">${rows.map(row).join('')}</div>`;
}

export { hourOfDay };
