// Storage layers:
//  - cookies:       tiny prefs mirror (units, theme, last city). Scoped to the app's path so it works on
//                   project pages like https://user.github.io/repo/ without leaking to sibling sites.
//  - localStorage:  prefs + city list.
//  - IndexedDB:     forecast cache, prediction log and accuracy stats (offline data).
import { isUS } from './util.js';

const BASE = new URL('./', document.baseURI).pathname;

export const cookie = {
  get(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  },
  set(name, val, days = 365) {
    try {
      document.cookie = `${name}=${encodeURIComponent(val)}; Max-Age=${days * 86400}; Path=${BASE}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    } catch { /* cookies disabled */ }
  },
  del(name) { document.cookie = `${name}=; Max-Age=0; Path=${BASE}`; },
};

// ---------- Preferences ----------
export function defaultPrefs() {
  const us = isUS();
  return {
    temp: us ? 'f' : 'c', wind: us ? 'mph' : 'kmh', precip: us ? 'in' : 'mm', pressure: us ? 'inhg' : 'hpa',
    clock: 'auto', theme: 'auto',
    feelBias: 0,                 // °C; negative = "I run cold"
    sources: {},                 // id -> false when disabled
    keys: { owm: '', wapi: '' }, // optional user-supplied API keys (stored only on this device)
  };
}

export function loadPrefs() {
  const p = defaultPrefs();
  try { Object.assign(p, JSON.parse(localStorage.getItem('q.prefs') || '{}')); } catch { /* ignore */ }
  // If localStorage was wiped (Safari ITP) restore the essentials from the cookie mirror.
  const c = cookie.get('q_u');
  if (c && !localStorage.getItem('q.prefs')) {
    const [temp, wind, precip, pressure, theme] = c.split('|');
    Object.assign(p, { temp, wind, precip, pressure, theme: theme || 'auto' });
  }
  p.keys = { owm: '', wapi: '', ...(p.keys || {}) };
  p.sources = p.sources || {};
  return p;
}

export function savePrefs(p) {
  try { localStorage.setItem('q.prefs', JSON.stringify(p)); } catch { /* quota/private mode */ }
  cookie.set('q_u', [p.temp, p.wind, p.precip, p.pressure, p.theme].join('|'));
}

// ---------- Cities ----------
export const cityId = (lat, lon) => `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;

export function loadCities() {
  try { const a = JSON.parse(localStorage.getItem('q.cities') || '[]'); if (Array.isArray(a)) return a; } catch { /* ignore */ }
  return [];
}
export function saveCities(list, activeId) {
  try { localStorage.setItem('q.cities', JSON.stringify(list)); } catch { /* ignore */ }
  if (activeId) cookie.set('q_c', activeId);
}
export const lastCityCookie = () => cookie.get('q_c');

// ---------- IndexedDB key/value (falls back to localStorage) ----------
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('no idb'));
      const r = indexedDB.open('quorum', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
  const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv'));
  t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
}));

export async function idbGet(k) {
  try { return await tx('readonly', s => s.get(k)); }
  catch { try { return JSON.parse(localStorage.getItem('kv:' + k)); } catch { return undefined; } }
}
export async function idbSet(k, v) {
  try { await tx('readwrite', s => s.put(v, k)); }
  catch { try { localStorage.setItem('kv:' + k, JSON.stringify(v)); } catch { /* quota */ } }
}
export async function idbDel(k) {
  try { await tx('readwrite', s => s.delete(k)); } catch { /* ignore */ }
  try { localStorage.removeItem('kv:' + k); } catch { /* ignore */ }
}
export async function idbClear() {
  try { await tx('readwrite', s => s.clear()); } catch { /* ignore */ }
  Object.keys(localStorage).filter(k => k.startsWith('kv:')).forEach(k => localStorage.removeItem(k));
}

// Ask the browser not to evict our data (honoured for installed PWAs).
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
