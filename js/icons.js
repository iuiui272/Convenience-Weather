// WMO weather codes → labels, hand-drawn SVG icons, and sky gradients.

const INFO = {
  0: ['Clear', 'clear'], 1: ['Mostly clear', 'clear'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloudy'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'sleet'], 57: ['Freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'heavy'],
  66: ['Freezing rain', 'sleet'], 67: ['Freezing rain', 'sleet'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Heavy showers', 'heavy'],
  85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'thunder'], 96: ['Thunderstorm with hail', 'thunder'], 99: ['Severe thunderstorm', 'thunder'],
};
export const wmo = code => { const [label, kind] = INFO[code] || ['—', 'cloudy']; return { label, kind }; };
export const isWet = code => ['drizzle', 'rain', 'heavy', 'sleet', 'thunder'].includes(wmo(code).kind);
export const isSnow = code => wmo(code).kind === 'snow';
export const isPrecip = code => isWet(code) || isSnow(code);

// ---------- SVG pieces (64×64 viewBox) ----------
const SUN = '#FFD43B', CLOUD = '#F4F7FB', CLOUD_D = '#B4BDCB', RAIN = '#6EC6FF';
const sun = (cx, cy, r) => {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
    rays += `<path d="M${(cx + c * (r + 4)).toFixed(1)} ${(cy + s * (r + 4)).toFixed(1)}L${(cx + c * (r + 9)).toFixed(1)} ${(cy + s * (r + 9)).toFixed(1)}"/>`;
  }
  return `<g stroke="${SUN}" stroke-width="3" stroke-linecap="round" fill="none">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN}"/>`;
};
const moon = (x, y, k) => `<g transform="translate(${x} ${y}) scale(${k})"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#E9EDF9"/></g>`;
const cloud = (dark, tx = 0, ty = 0, k = 1) =>
  `<g transform="translate(${tx} ${ty}) scale(${k})"><path d="M18 48a10 10 0 0 1-1-20 14 14 0 0 1 27-3 11 11 0 0 1 3 23z" fill="${dark ? CLOUD_D : CLOUD}"/></g>`;
const drops = (n, long) => {
  const xs = n === 3 ? [24, 33, 42] : [20, 28, 36, 44];
  return `<g stroke="${RAIN}" stroke-width="${long ? 3.6 : 3}" stroke-linecap="round">${xs.map(x => `<path d="M${x} ${long ? 51 : 52}l-3 ${long ? 9 : 6}"/>`).join('')}</g>`;
};
const flakes = () => `<g fill="#fff">${[[24, 55], [33, 58], [42, 55], [28, 62], [38, 62]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.3"/>`).join('')}</g>`;
const bolt = () => `<path d="M34 40l-8 13h6l-4 11 12-15h-7l5-9z" fill="${SUN}"/>`;
const fogLines = () => `<g stroke="#C9D1DC" stroke-width="3.2" stroke-linecap="round"><path d="M14 52h36M20 58h26"/></g>`;

export function icon(code, isDay = true, size = 40) {
  const { kind } = wmo(code);
  let body;
  switch (kind) {
    case 'clear': body = isDay ? sun(32, 32, 12) : moon(10, 8, 2); break;
    case 'partly': body = (isDay ? sun(25, 24, 9) : moon(6, 4, 1.6)) + cloud(false, 2, 2); break;
    case 'cloudy': body = cloud(true, -4, -6, 1.1) + cloud(false, 4, 2, .95); break;
    case 'fog': body = cloud(true, 0, -8) + fogLines(); break;
    case 'drizzle': body = cloud(true, 0, -8) + drops(3, false); break;
    case 'rain': body = cloud(true, 0, -8) + drops(3, true); break;
    case 'heavy': body = cloud(true, 0, -8) + drops(4, true); break;
    case 'sleet': body = cloud(true, 0, -8) + drops(3, false).replace(RAIN, '#A9D8FF') + `<circle cx="42" cy="58" r="2.3" fill="#fff"/>`; break;
    case 'snow': body = cloud(false, 0, -8) + flakes(); break;
    case 'thunder': body = cloud(true, 0, -10) + bolt(); break;
    default: body = cloud(false);
  }
  return `<svg class="wx" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

// Small line icons for UI chrome (24×24, stroke currentColor)
const L = (d, extra = '') => `<svg class="li" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const ui = {
  sun: L('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  wind: L('<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>'),
  drop: L('<path d="M12 3s6 6.2 6 10.5A6 6 0 0 1 6 13.5C6 9.2 12 3 12 3z"/>'),
  thermo: L('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>'),
  eye: L('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  gauge: L('<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/>'),
  leaf: L('<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15M5 19l8-8"/>'),
  moon: L('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  clock: L('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  cal: L('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
  alert: L('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>'),
  umbrella: L('<path d="M3 12a9 9 0 0 1 18 0zM12 12v6a2 2 0 0 0 4 0"/>'),
  chart: L('<path d="M3 20h18M5 15l4-5 4 3 6-8"/>'),
  scale: L('<path d="M12 4v16M5 20h14M5 8l-3 7a3 3 0 0 0 6 0zM19 8l-3 7a3 3 0 0 0 6 0zM5 8h14"/>'),
  target: L('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>'),
  map: L('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"/>'),
  list: L('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
  gear: L('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plus: L('<path d="M12 5v14M5 12h14"/>'),
  search: L('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  locate: L('<path d="M3 11l18-8-8 18-2-8z"/>'),
  share: L('<path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  close: L('<path d="M6 6l12 12M18 6L6 18"/>'),
  compare: L('<path d="M7 4v16M17 4v16M3 8l4-4 4 4M13 16l4 4 4-4"/>'),
  refresh: L('<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>'),
  sunrise: L('<path d="M17 18a5 5 0 0 0-10 0M12 3v6M8 7l4-4 4 4M2 18h20"/>'),
  sunset: L('<path d="M17 18a5 5 0 0 0-10 0M12 9V3M8 5l4 4 4-4M2 18h20"/>'),
  glance: L('<rect x="5" y="2" width="14" height="20" rx="3"/><path d="M12 18h.01"/>'),
};

// ---------- Sky gradients ----------
// Returns { top, bottom, fx, night } for the page background.
export function skyTheme({ code = 0, isDay = true, now = Date.now(), sunrise, sunset, forceDark = false }) {
  const { kind } = wmo(code);
  const near = t => t != null && Math.abs(now - t) < 40 * 60e3;
  const twilight = near(sunrise) || near(sunset);
  let top, bottom, fx = null;
  const day = isDay && !forceDark;

  if (kind === 'thunder') { [top, bottom] = day ? ['#3a4160', '#6b6f93'] : ['#14172a', '#34375a']; fx = 'rain'; }
  else if (kind === 'rain' || kind === 'heavy' || kind === 'drizzle' || kind === 'sleet') { [top, bottom] = day ? ['#46607a', '#7f95a8'] : ['#121a27', '#2a3548']; fx = 'rain'; }
  else if (kind === 'snow') { [top, bottom] = day ? ['#8aa1b8', '#cbd8e5'] : ['#27324a', '#58667e']; fx = 'snow'; }
  else if (kind === 'fog') { [top, bottom] = day ? ['#8d99a5', '#bcc5cd'] : ['#242b35', '#4a5360']; }
  else if (kind === 'cloudy') { [top, bottom] = day ? ['#62798f', '#a3b6c6'] : ['#1c2432', '#394456']; }
  else if (kind === 'partly') { [top, bottom] = day ? ['#3f86cf', '#8cc3ec'] : ['#0d1d40', '#2a4274']; if (!day) fx = 'stars'; }
  else { [top, bottom] = day ? ['#2878d6', '#74bff5'] : ['#071433', '#223a6c']; if (!day) fx = 'stars'; }

  if (twilight && (kind === 'clear' || kind === 'partly')) { top = '#3b4a8f'; bottom = '#f2a56a'; fx = null; }
  return { top, bottom, fx, night: !day, twilight };
}
