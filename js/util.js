// Small helpers: DOM, formatting, units, time zones.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const HOUR = 3600e3;
export const DAY = 86400e3;
export const lerp = (a, b, p) => a + (b - a) * p;

// ---------- Intl formatters (cached) ----------
const cache = new Map();
function dtf(opts) {
  const key = JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(undefined, opts); cache.set(key, f); }
  return f;
}
const clockOpts = clock => clock === '24' ? { hourCycle: 'h23' } : clock === '12' ? { hour12: true } : {};

export function dateKey(t, tz) {
  const p = dtf({ timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t);
  const g = k => p.find(x => x.type === k).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
export function hourOfDay(t, tz) {
  const p = dtf({ timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t);
  return +p.find(x => x.type === 'hour').value + (+p.find(x => x.type === 'minute').value) / 60;
}

// ---------- Units & formatting ----------
export function isUS() { return /-US$/i.test(navigator.language || ''); }

export function makeFmt(prefs, tz) {
  const P = prefs;
  const tc = c => (P.temp === 'f' ? c * 9 / 5 + 32 : c);
  const zero = n => (Object.is(n, -0) || n === 0 ? 0 : n);
  const co = clockOpts(P.clock);
  const f = {
    tz,
    tempN: c => zero(Math.round(tc(c))),
    temp: c => (c == null || isNaN(c) ? '–' : zero(Math.round(tc(c))) + '°'),
    tempUnit: () => (P.temp === 'f' ? '°F' : '°C'),
    // size of a temperature *difference* in the user's unit
    delta: d => (P.temp === 'f' ? d * 1.8 : d),
    deltaStr: d => (P.temp === 'f' ? d * 1.8 : d).toFixed(1) + '°',
    deltaInt: d => Math.max(1, Math.round(P.temp === 'f' ? d * 1.8 : d)) + '°',
    windUnit: () => ({ kmh: 'km/h', mph: 'mph', ms: 'm/s', kn: 'kn' }[P.wind]),
    windN: k => ({ kmh: k, mph: k * 0.621371, ms: k / 3.6, kn: k * 0.539957 }[P.wind]),
    wind: k => { if (k == null) return '–'; const v = f.windN(k); return (P.wind === 'ms' ? v.toFixed(1) : Math.round(v)) + ' ' + f.windUnit(); },
    precip: mm => {
      if (mm == null) return '–';
      if (P.precip === 'in') { const v = mm / 25.4; return (v < 0.1 ? v.toFixed(2) : v.toFixed(1)) + ' in'; }
      return (mm < 10 ? mm.toFixed(1) : Math.round(mm)) + ' mm';
    },
    pressure: h => {
      if (h == null) return '–';
      if (P.pressure === 'inhg') return (h * 0.02953).toFixed(2) + ' inHg';
      if (P.pressure === 'mmhg') return Math.round(h * 0.750062) + ' mmHg';
      return Math.round(h) + ' hPa';
    },
    dist: m => {
      if (m == null) return '–';
      if (P.wind === 'mph') { const mi = m / 1609.344; return (mi >= 10 ? Math.round(mi) : mi.toFixed(1)) + ' mi'; }
      const km = m / 1000; return (km >= 10 ? Math.round(km) : km.toFixed(1)) + ' km';
    },
    time: t => dtf({ timeZone: tz, hour: 'numeric', minute: '2-digit', ...co }).format(t),
    hour: t => dtf({ timeZone: tz, hour: 'numeric', ...co }).format(t).replace(' ', '\u202f'),
    wk: t => dtf({ timeZone: tz, weekday: 'short' }).format(t),
    wkLong: t => dtf({ timeZone: tz, weekday: 'long' }).format(t),
    day: t => dtf({ timeZone: tz, month: 'short', day: 'numeric' }).format(t),
  };
  return f;
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 36) return h + ' h ago';
  return Math.round(h / 24) + ' d ago';
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// Temperature → colour for the daily range bars
const STOPS = [[-15, [120, 150, 255]], [0, [90, 190, 255]], [10, [70, 210, 200]], [18, [150, 220, 90]], [25, [255, 214, 10]], [32, [255, 149, 0]], [40, [255, 69, 58]]];
export function tempColor(c) {
  if (c <= STOPS[0][0]) return `rgb(${STOPS[0][1]})`;
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1];
    if (c <= b) { const p = (c - a) / (b - a); return `rgb(${ca.map((v, k) => Math.round(lerp(v, cb[k], p))).join(',')})`; }
  }
  return `rgb(${STOPS.at(-1)[1]})`;
}

export const uid = () => Math.random().toString(36).slice(2, 9);
