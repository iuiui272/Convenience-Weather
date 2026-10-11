// Temperature chart: consensus line, min–max band across sources, "now" marker, drag to scrub.
import { HOUR, dateKey } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

// data: { t[], best[], lo[], hi[] }  opts: { fmt, tz, now, onScrub(index|null), height }
export function drawChart(el, data, opts) {
  const { fmt, tz, now, onScrub } = opts;
  const W = Math.max(280, el.clientWidth || 340), H = opts.height || 180;
  const pl = 30, pr = 10, pt = 12, pb = 24;
  const n = data.t.length;
  if (n < 2) { el.innerHTML = ''; return; }
  const t0 = data.t[0], t1 = data.t[n - 1];
  let ymin = Math.min(...data.lo), ymax = Math.max(...data.hi);
  const pad = Math.max(1.2, (ymax - ymin) * 0.12);
  ymin -= pad; ymax += pad;
  const X = t => pl + (t - t0) / (t1 - t0) * (W - pl - pr);
  const Y = v => pt + (1 - (v - ymin) / (ymax - ymin)) * (H - pt - pb);

  const line = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${X(data.t[i]).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
  const band = `${line(data.hi)}${data.lo.map((v, i) => `L${X(data.t[n - 1 - i]).toFixed(1)} ${Y(data.lo[n - 1 - i]).toFixed(1)}`).join('')}Z`;

  // y grid (3 lines)
  let grid = '';
  const step = niceStep((ymax - ymin) / 3, fmt);
  const start = Math.ceil(ymin / step) * step;
  for (let v = start; v < ymax; v += step) {
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid"/><text x="${pl - 6}" y="${(Y(v) + 3.5).toFixed(1)}" class="ylab" text-anchor="end">${fmt.temp(v)}</text>`;
  }

  // x labels: hours for ≤48h, days otherwise
  let xl = '';
  const span = (t1 - t0) / HOUR;
  if (span <= 50) {
    const every = span <= 26 ? 4 : 8;
    for (let i = 0; i < n; i++) {
      if ((i % every) === 0) xl += `<text x="${X(data.t[i]).toFixed(1)}" y="${H - 6}" class="xlab" text-anchor="middle">${fmt.hour(data.t[i])}</text>`;
    }
  } else {
    let last = '';
    for (let i = 0; i < n; i++) {
      const k = dateKey(data.t[i], tz);
      if (k !== last) {
        last = k;
        xl += `<line x1="${X(data.t[i]).toFixed(1)}" x2="${X(data.t[i]).toFixed(1)}" y1="${pt}" y2="${H - pb}" class="grid"/>`;
        if (i + 12 < n) xl += `<text x="${(X(data.t[i]) + (W - pl - pr) / (span / 24) / 2).toFixed(1)}" y="${H - 6}" class="xlab" text-anchor="middle">${fmt.wk(data.t[i] + 12 * HOUR)}</text>`;
      }
    }
  }

  const nowX = now >= t0 && now <= t1 ? X(now) : null;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="chart" role="img" aria-label="Temperature forecast chart">
    ${grid}${xl}
    <path d="${band}" class="band"/>
    <path d="${line(data.best)}" class="best"/>
    ${nowX != null ? `<line x1="${nowX}" x2="${nowX}" y1="${pt}" y2="${H - pb}" class="nowline"/>` : ''}
    <g class="scrub" visibility="hidden"><line y1="${pt}" y2="${H - pb}" class="scrubline"/><circle r="5" class="scrubdot"/></g>
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/>
  </svg>`;

  const svg = el.firstElementChild, g = svg.querySelector('.scrub'), sl = g.querySelector('line'), dot = g.querySelector('circle'), hit = svg.querySelector('.hit');
  let down = false;
  const at = ev => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * W;
    const t = t0 + (x - pl) / (W - pl - pr) * (t1 - t0);
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(data.t[i] - t); if (d < bd) { bd = d; best = i; } }
    g.setAttribute('visibility', 'visible');
    const x0 = X(data.t[best]);
    sl.setAttribute('x1', x0); sl.setAttribute('x2', x0);
    dot.setAttribute('cx', x0); dot.setAttribute('cy', Y(data.best[best]));
    onScrub?.(best);
  };
  const end = () => { down = false; g.setAttribute('visibility', 'hidden'); onScrub?.(null); };
  hit.addEventListener('pointerdown', e => { down = true; hit.setPointerCapture?.(e.pointerId); at(e); });
  hit.addEventListener('pointermove', e => { if (down || e.pointerType === 'mouse') at(e); });
  hit.addEventListener('pointerup', end);
  hit.addEventListener('pointercancel', end);
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') end(); });
}

function niceStep(raw, fmt) {
  // work in the user's unit so grid labels land on round numbers
  const f = fmt.delta(1);
  const r = raw * f;
  const cands = [1, 2, 5, 10, 20];
  const s = cands.find(c => c >= r) || 20;
  return s / f;
}

// Two-line comparison chart (cities or days). series: [{label, color, t[], v[]}] on a shared x axis (0..n-1 hours)
export function drawCompare(el, series, opts) {
  const { fmt, xLabel } = opts;
  const W = Math.max(280, el.clientWidth || 340), H = 170, pl = 30, pr = 10, pt = 10, pb = 22;
  const all = series.flatMap(s => s.v.filter(v => v != null));
  if (!all.length) { el.innerHTML = ''; return; }
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const pad = Math.max(1.2, (ymax - ymin) * 0.12); ymin -= pad; ymax += pad;
  const len = Math.max(...series.map(s => s.v.length));
  const X = i => pl + i / (len - 1) * (W - pl - pr);
  const Y = v => pt + (1 - (v - ymin) / (ymax - ymin)) * (H - pt - pb);
  let grid = '';
  const step = niceStep((ymax - ymin) / 3, fmt);
  for (let v = Math.ceil(ymin / step) * step; v < ymax; v += step) {
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid"/><text x="${pl - 6}" y="${(Y(v) + 3.5).toFixed(1)}" class="ylab" text-anchor="end">${fmt.temp(v)}</text>`;
  }
  let xl = '';
  for (let i = 0; i < len; i += Math.ceil(len / 6)) xl += `<text x="${X(i).toFixed(1)}" y="${H - 5}" class="xlab" text-anchor="middle">${xLabel(i)}</text>`;
  const paths = series.map(s => {
    let d = '', pen = false;
    s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="chart">${grid}${xl}${paths}</svg>`;
}
