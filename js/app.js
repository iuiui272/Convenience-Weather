// Quorum: app shell, state, navigation, sheets, offline handling.
import { $, $$, esc, clamp, debounce, HOUR, makeFmt } from './util.js';
import {
  loadPrefs, savePrefs, loadCities, saveCities, lastCityCookie, cityId, idbGet, idbSet, idbDel, idbClear, requestPersistence,
} from './store.js';
import { fetchBundle, searchPlaces, reverseGeocode } from './api.js';
import { recordPredictions, evaluate } from './consensus.js';
import { prepare } from './model.js';
import { Sky } from './fx.js';
import { ui as I, wmo, skyTheme } from './icons.js';
import { RadarMap } from './radar.js';
import { drawCompare } from './chart.js';
import * as V from './ui.js';

const VERSION = '1.0.0';
const BASE = new URL('./', document.baseURI).href;
const STALE_MS = 10 * 60e3;

const S = {
  prefs: loadPrefs(), cities: loadCities(), activeId: null,
  data: {},      // id -> { bundle, view }
  acc: {},       // id -> { preds, acc }
  ui: {},        // id -> per-page UI state
  loading: new Set(), errors: {},
  edit: false, persisted: false, needsRefresh: false,
  cmp: { mode: 'cities', a: null, b: null },
  radar: null, wake: null,
};
const wide = matchMedia('(min-width: 820px)');
const el = {};

// ======================================================= boot

async function init() {
  for (const k of ['pager', 'dots', 'clist', 'results', 'q', 'empty', 'bar', 'toast', 'glance']) el[k] = $('#' + k);
  el.sky = new Sky($('#bgA'), $('#bgB'), $('#fx'), $('meta[name="theme-color"]'));
  applyTheme();
  el.sky.set(skyTheme({ code: 0, isDay: true }));

  // Shared link: ?lat=..&lon=..&n=Name
  const q = new URLSearchParams(location.search);
  if (q.has('lat') && q.has('lon')) {
    const lat = +q.get('lat'), lon = +q.get('lon');
    if (isFinite(lat) && isFinite(lon)) addCity({ name: (q.get('n') || 'Shared place').slice(0, 60), admin: '', country: '', lat, lon }, { quiet: true });
    history.replaceState(null, '', BASE);
  }
  S.activeId = S.cities.find(c => c.id === lastCityCookie())?.id || S.cities[0]?.id || null;

  bind();
  registerSW();
  requestPersistence().then(p => { S.persisted = !!p; });

  syncPages(); renderDots(); renderList(); toggleEmpty();
  // paint cached forecasts first (works offline), then go to the network
  await Promise.all(S.cities.map(async c => {
    const [bundle, rec] = await Promise.all([idbGet('fc:' + c.id), idbGet('acc:' + c.id)]);
    S.acc[c.id] = rec || { preds: {}, acc: {} };
    if (bundle) S.data[c.id] = { bundle };
  }));
  S.cities.forEach(c => renderPage(c.id));
  renderList();
  if (S.activeId) setActive(S.activeId, { scroll: true, instant: true });
  refreshHere();
  if (q.get('glance') === '1') openGlance();

  // Active city first, then the rest, one after another to stay polite to the APIs
  if (S.activeId) await loadCity(S.activeId);
  for (const c of S.cities) if (c.id !== S.activeId) await loadCity(c.id);

  setInterval(() => { if (!document.hidden && !pointerDown) rerenderActive(); }, 120e3);
}

let pointerDown = false;
addEventListener('pointerdown', () => { pointerDown = true; }, { passive: true });
addEventListener('pointerup', () => { pointerDown = false; }, { passive: true });

// ======================================================= helpers
const cityById = id => S.cities.find(c => c.id === id);
const uiState = id => (S.ui[id] ||= { h: '24', off: 0, day: null, alertOpen: null });
const pageEl = id => el.pager.querySelector(`.page[data-id="${CSS.escape(id)}"]`);
const activeView = () => S.data[S.activeId]?.view;

function toast(msg, { label, onClick, ms = 3500 } = {}) {
  const t = el.toast;
  t.innerHTML = `<span>${esc(msg)}</span>${label ? `<button>${esc(label)}</button>` : ''}`;
  t.classList.add('show');
  t.querySelector('button')?.addEventListener('click', () => { t.classList.remove('show'); onClick?.(); });
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), label ? 9000 : ms);
}

function applyTheme() {
  const t = S.prefs.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}

// ======================================================= pages & cities
function syncPages() {
  const ids = new Set(S.cities.map(c => c.id));
  $$('.page', el.pager).forEach(p => { if (!ids.has(p.dataset.id)) p.remove(); });
  S.cities.forEach((c, i) => {
    let p = pageEl(c.id);
    if (!p) {
      p = document.createElement('section');
      p.className = 'page'; p.dataset.id = c.id;
      p.innerHTML = '<div class="mini"></div><div class="scroll"><div class="ptr"><i></i></div><div class="content"></div></div>';
      bindScroll(p);
      el.pager.appendChild(p);
    }
    if (el.pager.children[i] !== p) el.pager.insertBefore(p, el.pager.children[i] || null);
  });
}

function bindScroll(p) {
  const sc = p.querySelector('.scroll');
  let raf = 0, maxPull = 0;
  sc.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0; const y = sc.scrollTop;
      p.style.setProperty('--p', clamp(y / 150, 0, 1).toFixed(3));
      if (y < 0) { maxPull = Math.max(maxPull, -y); p.style.setProperty('--pull', clamp(-y / 70, 0, 1).toFixed(2)); } else p.style.setProperty('--pull', '0');
    });
  }, { passive: true });
  const end = () => { if (maxPull > 72) loadCity(p.dataset.id, { force: true }); maxPull = 0; };
  sc.addEventListener('touchend', end, { passive: true });
  sc.addEventListener('touchcancel', () => { maxPull = 0; }, { passive: true });
}

function renderPage(id) {
  const city = cityById(id), p = pageEl(id);
  if (!city || !p) return;
  const content = p.querySelector('.content'), sc = p.querySelector('.scroll');
  const d = S.data[id], st = uiState(id);
  p.classList.toggle('loading', S.loading.has(id));
  if (!d?.bundle) {
    content.innerHTML = S.errors[id] ? V.errorState(city, S.errors[id]) : V.skeleton(city);
    return;
  }
  try {
    const view = prepare(d.bundle, { prefs: S.prefs, acc: S.acc[id]?.acc });
    d.view = view;
    st.loading = S.loading.has(id); st.offline = !navigator.onLine;
    const top = sc.scrollTop;
    content.innerHTML = V.page(view, st);
    p.querySelector('.mini').innerHTML = V.mini(view);
    V.mountPage(p, view, st);
    sc.scrollTop = top;
    if (id === S.activeId) onActiveView(view);
  } catch (err) {
    console.error(err);
    content.innerHTML = V.errorState(city, 'Something went wrong reading the saved forecast.');
  }
}

function onActiveView(view) {
  el.sky.set(view.sky);
  document.title = `${view.fmt.temp(view.hero.best)} ${view.city.name} · Quorum`;
  if (!el.glance.hidden) renderGlance();
}
const renderAll = () => { S.cities.forEach(c => renderPage(c.id)); renderList(); };
const rerenderActive = () => { if (S.activeId) { renderPage(S.activeId); renderList(); } };

function rerenderCard(id, name) {
  const d = S.data[id], p = pageEl(id);
  if (!d?.view || !p) return;
  const card = p.querySelector(`[data-card="${name}"]`);
  if (!card) return;
  card.innerHTML = V.renderCard(name, d.view, uiState(id));
  if (name === 'chart') V.mountChart(card, d.view, uiState(id));
}

function renderDots() {
  el.dots.innerHTML = S.cities.map(c => `<button class="dot ${c.id === S.activeId ? 'on' : ''}" data-act="dot" data-id="${esc(c.id)}" aria-label="${esc(c.name)}">${c.isCurrent ? I.locate : ''}</button>`).join('');
}

function renderList() {
  el.clist.innerHTML = S.cities.length
    ? S.cities.map(c => V.listRow(c, S.data[c.id]?.view, { edit: S.edit })).join('')
    : '<p class="muted pad">Add a city to see its forecast.</p>';
  el.clist.querySelector(`[data-id="${CSS.escape(S.activeId || '')}"]`)?.closest('.lrow')?.classList.add('active');
}

function toggleEmpty() {
  const none = !S.cities.length;
  el.empty.hidden = !none; el.pager.hidden = none; el.bar.hidden = none;
  document.body.classList.toggle('no-cities', none);
}

function setActive(id, { scroll = true, instant = false } = {}) {
  if (!cityById(id)) return;
  S.activeId = id;
  saveCities(S.cities, id);
  $$('.page', el.pager).forEach(p => p.classList.toggle('active', p.dataset.id === id));
  renderDots();
  el.clist.querySelectorAll('.lrow').forEach(r => r.classList.toggle('active', r.querySelector('[data-id]')?.dataset.id === id));
  const v = S.data[id]?.view;
  if (v) onActiveView(v);
  if (scroll && !wide.matches) {
    const i = S.cities.findIndex(c => c.id === id);
    if (instant) el.pager.scrollLeft = i * el.pager.clientWidth; else el.pager.scrollTo({ left: i * el.pager.clientWidth, behavior: 'smooth' });
  }
  loadCity(id);
}

// ======================================================= data
async function loadCity(id, { force = false } = {}) {
  const city = cityById(id);
  if (!city || S.loading.has(id)) return;
  if (!S.data[id]) {
    const cached = await idbGet('fc:' + id);
    if (cached) { S.data[id] = { bundle: cached }; renderPage(id); renderList(); }
  }
  if (!navigator.onLine) { renderPage(id); return; }
  const age = S.data[id] ? Date.now() - S.data[id].bundle.fetchedAt : Infinity;
  if (!force && age < STALE_MS) return;

  S.loading.add(id); renderPage(id);
  try {
    const bundle = await fetchBundle(city, S.prefs);
    S.data[id] = { bundle }; delete S.errors[id];
    idbSet('fc:' + id, bundle);
    await learn(id, bundle);
    if (!city.tz && bundle.main.tz) { city.tz = bundle.main.tz; saveCities(S.cities, S.activeId); }
    iosTip();
  } catch (err) {
    console.warn('fetch failed', id, err);
    if (S.data[id]) toast('Couldn’t update. Showing your saved forecast.');
    else S.errors[id] = 'The forecast service didn’t respond.';
  } finally {
    S.loading.delete(id); renderPage(id); renderList();
  }
}

async function learn(id, bundle) {
  const rec = S.acc[id] || (S.acc[id] = (await idbGet('acc:' + id)) || { preds: {}, acc: {} });
  const now = Date.now();
  evaluate(rec.preds, rec.acc, { t: bundle.main.hourly.t, temp: bundle.main.hourly.temp }, now);
  recordPredictions(rec.preds, bundle.sources, now);
  idbSet('acc:' + id, rec);
}

async function refreshAll(force = true) {
  for (const c of S.cities) await loadCity(c.id, { force });
}

function iosTip() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.standalone === false && !localStorage.getItem('q.tip')) {
    localStorage.setItem('q.tip', '1');
    setTimeout(() => toast('Tip: tap Share, then Add to Home Screen, to keep forecasts offline.', { ms: 9000 }), 1500);
  }
}

// ======================================================= adding / removing cities
function addCity(info, { quiet = false, current = false } = {}) {
  const id = current ? 'here' : cityId(info.lat, info.lon);
  let c = cityById(id);
  if (c) { if (!quiet) { setActive(id); closeList(); } return c; }
  c = { id, name: info.name, admin: info.admin || '', country: info.country || '', lat: +info.lat, lon: +info.lon, tz: info.tz || null, isCurrent: !!current };
  if (current) S.cities.unshift(c); else S.cities.push(c);
  S.acc[id] = S.acc[id] || { preds: {}, acc: {} };
  saveCities(S.cities, S.activeId);
  if (!quiet) {
    syncPages(); renderList(); toggleEmpty();
    S.activeId = id; setActive(id, { instant: false });
    closeList();
  }
  return c;
}

async function removeCity(id) {
  const i = S.cities.findIndex(c => c.id === id);
  if (i < 0) return;
  S.cities.splice(i, 1);
  delete S.data[id]; delete S.acc[id]; delete S.ui[id];
  idbDel('fc:' + id); idbDel('acc:' + id);
  saveCities(S.cities, S.activeId);
  syncPages(); toggleEmpty();
  if (S.activeId === id) {
    const next = S.cities[Math.min(i, S.cities.length - 1)];
    S.activeId = next?.id || null;
    if (next) setActive(next.id, { instant: true });
  }
  renderDots(); renderList();
}

function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(p => res(p.coords), e => rej(e), { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60e3 });
  });
}

async function useMyLocation() {
  try {
    toast('Finding your location…');
    const { latitude: lat, longitude: lon } = await locate();
    const place = await reverseGeocode(lat, lon);
    el.toast.classList.remove('show');
    const existing = cityById('here');
    if (existing) { Object.assign(existing, place, { lat, lon }); delete S.data.here; saveCities(S.cities, S.activeId); setActive('here'); loadCity('here', { force: true }); renderList(); }
    else addCity({ ...place, lat, lon }, { current: true });
    closeList();
  } catch {
    toast('Location is turned off. You can search for a city instead.');
  }
}

async function refreshHere() {
  const here = cityById('here');
  if (!here || !navigator.geolocation) return;
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm && perm.state !== 'granted') return;
    const { latitude: lat, longitude: lon } = await locate();
    const moved = Math.hypot((lat - here.lat) * 111, (lon - here.lon) * 111 * Math.cos(lat * Math.PI / 180));
    if (moved > 3) {
      Object.assign(here, await reverseGeocode(lat, lon), { lat, lon });
      saveCities(S.cities, S.activeId); delete S.data.here; renderPage('here'); loadCity('here', { force: true });
    }
  } catch { /* keep the saved position */ }
}

// ======================================================= search
const doSearch = debounce(async text => {
  const out = el.results;
  if (text.trim().length < 2) { out.innerHTML = ''; document.body.classList.remove('searching'); return; }
  document.body.classList.add('searching');
  if (!navigator.onLine) { out.innerHTML = '<p class="muted pad">Searching needs a connection.</p>'; return; }
  out.innerHTML = '<p class="muted pad">Searching…</p>';
  try {
    const r = await searchPlaces(text.trim());
    out.innerHTML = r.length ? r.map(V.searchResult).join('') : '<p class="muted pad">No places found. Try a different spelling.</p>';
  } catch { out.innerHTML = '<p class="muted pad">Search isn’t available right now.</p>'; }
}, 250);

function clearSearch() { el.q.value = ''; el.results.innerHTML = ''; document.body.classList.remove('searching'); }

// ======================================================= lists & sheets
const openList = () => { document.body.classList.add('list-open'); };
const closeList = () => { if (!wide.matches) document.body.classList.remove('list-open'); clearSearch(); };

function openSheet(name) {
  const s = $('#sheet-' + name);
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
  document.body.classList.add('modal');
  if (name === 'settings') renderSettings();
  if (name === 'compare') openCompare();
  if (name === 'radar') openRadar();
}
function closeSheet(name) {
  const s = $('#sheet-' + name);
  s.classList.remove('open');
  setTimeout(() => { s.hidden = true; if (!$$('.sheet.open').length) document.body.classList.remove('modal'); }, 320);
  if (name === 'radar') { S.radar?.destroy(); S.radar = null; }
  if (name === 'settings' && S.needsRefresh) { S.needsRefresh = false; refreshAll(true); }
}

// ---- settings
function renderSettings() {
  $('#settingsBody').innerHTML = V.settings(S.prefs, { persisted: S.persisted, version: VERSION });
}

function onSettingsClick(e) {
  const seg = e.target.closest('.seg[data-pref] button');
  if (seg) {
    const key = seg.parentElement.dataset.pref;
    S.prefs[key] = seg.dataset.v; savePrefs(S.prefs);
    $$('button', seg.parentElement).forEach(b => b.setAttribute('aria-pressed', String(b === seg)));
    if (key === 'theme') applyTheme();
    renderAll();
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'glance': closeSheet('settings'); openGlance(); break;
    case 'share': shareCity(); break;
    case 'refresh-all': toast('Refreshing every city…'); refreshAll(true); break;
    case 'clear-cache':
      Object.keys(S.data).forEach(id => idbDel('fc:' + id)); toast('Saved forecasts cleared. They will reload from the network.');
      caches?.keys().then(ks => ks.filter(k => k.includes('tiles')).forEach(k => caches.delete(k)));
      break;
    case 'clear-acc':
      S.cities.forEach(c => { S.acc[c.id] = { preds: {}, acc: {} }; idbSet('acc:' + c.id, S.acc[c.id]); });
      renderAll(); toast('Accuracy history reset.');
      break;
  }
}
function onSettingsChange(e) {
  const t = e.target;
  if (t.dataset.src) {
    if (t.checked) { delete S.prefs.sources[t.dataset.src]; S.needsRefresh = true; } else S.prefs.sources[t.dataset.src] = false;
    savePrefs(S.prefs); renderAll();
  } else if (t.id === 'key-owm' || t.id === 'key-wapi') {
    S.prefs.keys[t.id.slice(4)] = t.value.trim(); savePrefs(S.prefs); S.needsRefresh = true;
  }
}
const applyBias = debounce(() => { savePrefs(S.prefs); renderAll(); }, 120);
function onSettingsInput(e) {
  if (e.target.id !== 'feelBias') return;
  const v = +e.target.value; S.prefs.feelBias = v;
  $('#feelOut').textContent = v === 0 ? 'Neutral' : (v > 0 ? '+' : '−') + Math.abs(v) + '°C';
  applyBias();
}

// ---- share & glance
async function shareCity() {
  const v = activeView(); if (!v) return;
  const c = v.city;
  const url = `${BASE}?lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}&n=${encodeURIComponent(c.name)}`;
  const text = `${c.name}: ${v.fmt.temp(v.hero.best)}, ${wmo(v.cur.code).label}. ${v.summary}`;
  try {
    if (navigator.share) await navigator.share({ title: `Weather in ${c.name}`, text, url });
    else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Forecast link copied.'); }
  } catch { /* cancelled */ }
}

async function openGlance() {
  if (!activeView()) { toast('Load a forecast first.'); return; }
  el.glance.hidden = false; renderGlance();
  requestAnimationFrame(() => el.glance.classList.add('open'));
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
}
function closeGlance() {
  el.glance.classList.remove('open');
  setTimeout(() => { el.glance.hidden = true; }, 250);
  S.wake?.release?.().catch(() => {}); S.wake = null;
}
function renderGlance() {
  const v = activeView(); if (!v) return;
  const f = v.fmt, t = v.today;
  el.glance.innerHTML = `<div class="gl"><div class="gcity">${esc(v.city.name)}</div><div class="gtemp">${f.temp(v.hero.best)}</div>
    <div class="gcond">${wmo(v.cur.code).label}</div><div class="ghl">H:${f.temp(t?.hi ?? v.hero.best)}  L:${f.temp(t?.lo ?? v.hero.best)}</div>
    <div class="grain">${v.rain ? esc(v.rain.text) : esc(v.summary)}</div>
    <div class="gconf">${v.hero.n > 1 ? `${v.hero.n} sources · ${v.hero.conf.label.toLowerCase()}` : 'single source'}</div><div class="ghint">Tap anywhere to close</div></div>`;
}

// ---- compare
function openCompare() {
  const ids = S.cities.filter(c => S.data[c.id]?.view).map(c => c.id);
  const c = S.cmp;
  if (!ids.includes(c.a)) c.a = S.activeId && ids.includes(S.activeId) ? S.activeId : ids[0];
  if (!ids.includes(c.b) || c.b === c.a) c.b = ids.find(i => i !== c.a) || c.a;
  if (ids.length < 2) c.mode = 'days';
  if (c.mode === 'days') { c.a = 0; c.b = 1; c.dayCity = S.activeId; }
  renderCompare();
}

function renderCompare() {
  const c = S.cmp;
  const cityList = S.cities.filter(x => S.data[x.id]?.view).map(x => [x.id, x.name]);
  let dayList = [];
  if (c.mode === 'days') {
    const v = S.data[S.activeId]?.view;
    if (v) dayList = v.days.map((d, k) => [k, `${d.isToday ? 'Today' : v.fmt.wk(d.t + 12 * HOUR)} ${v.fmt.day(d.t + 12 * HOUR)}`]);
  }
  const body = $('#compareBody');
  body.innerHTML = V.compareShell(cityList, dayList, c);
  const rows = c.mode === 'cities' ? cityRows(c.a, c.b) : dayRows(+c.a, +c.b);
  if (!rows) { body.querySelector('.cbody').innerHTML = '<p class="muted pad">Pick two to compare.</p>'; return; }
  body.querySelector('.cbody').innerHTML = V.compareBody(rows.table);
  drawCompare(body.querySelector('.cchart'), rows.series, { fmt: rows.fmt, xLabel: rows.xLabel });
  const lg = rows.series.map((s, i) => `<span><i class="${i ? 'cB' : 'cA'}"></i>${esc(s.label)}</span>`).join('');
  body.querySelector('.cchart').insertAdjacentHTML('afterend', `<div class="legend">${lg}</div>`);
}

function cityRows(a, b) {
  const A = S.data[a]?.view, B = S.data[b]?.view;
  if (!A || !B) return null;
  const col = v => {
    const f = v.fmt, t = v.today;
    return [f.temp(v.hero.best), `${f.temp(t.hi)} / ${f.temp(t.lo)}`, f.temp(v.feels), `${t.pop}%`, f.precip(t.precipSum), f.wind(v.cur.wind), t.uvMax != null ? String(Math.round(t.uvMax)) : '–', v.hero.n > 1 ? v.hero.conf.label.replace(' confidence', '') : 'Single source'];
  };
  const labels = ['Now', 'High / low', 'Feels like', 'Rain chance', 'Rain today', 'Wind', 'UV peak', 'Sources agree'];
  const ca = col(A), cb = col(B);
  return {
    table: labels.map((l, i) => [l, ca[i], cb[i]]), fmt: A.fmt, xLabel: i => (i === 0 ? 'Now' : `+${i}h`),
    series: [{ label: A.city.name, color: '#5ac8fa', v: A.hourly.map(h => h.temp) }, { label: B.city.name, color: '#ff9f0a', v: B.hourly.map(h => h.temp) }],
  };
}

function dayRows(a, b) {
  const v = S.data[S.activeId]?.view; if (!v) return null;
  const A = v.days[a], B = v.days[b]; if (!A || !B) return null;
  const f = v.fmt, rng = r => (r ? `${f.temp(r[0])}–${f.temp(r[1])}` : '–');
  const sr = d => d.idx.map(i => v.series.best[i]);
  const n = Math.min(A.idx.length, B.idx.length, 24);
  const row = (l, g) => [l, g(A), g(B)];
  return {
    table: [row('High', d => f.temp(d.hi)), row('Low', d => f.temp(d.lo)), row('Sources’ high', d => rng(d.hiRange)), row('Rain chance', d => `${d.pop}%`),
      row('Rain total', d => f.precip(d.precipSum)), row('Wind up to', d => f.wind(d.windMax)), row('UV peak', d => (d.uvMax != null ? String(Math.round(d.uvMax)) : '–'))],
    fmt: f, xLabel: i => f.hour(v.H.t[A.idx[i]]),
    series: [
      { label: `${A.isToday ? 'Today' : f.wk(A.t + 12 * HOUR)}`, color: '#5ac8fa', v: sr(A).slice(0, n) },
      { label: `${B.isToday ? 'Today' : f.wk(B.t + 12 * HOUR)}`, color: '#ff9f0a', v: sr(B).slice(0, n) },
    ],
  };
}

// ---- radar
async function openRadar() {
  const v = activeView(); if (!v) { closeSheet('radar'); toast('Load a forecast first.'); return; }
  await new Promise(r => setTimeout(r, 60)); // let the sheet lay out so the map has a size
  const box = $('#radarMap'), time = $('#rtime'), slider = $('#rslider'), play = $('#rplay');
  S.radar?.destroy();
  const m = S.radar = new RadarMap(box, {
    lat: v.city.lat, lon: v.city.lon, zoom: 6,
    onFrame: (t, i, fc) => { time.textContent = `${v.fmt.time(t)}${fc ? ' · forecast' : ''}`; slider.value = i; },
  });
  const ok = await m.load();
  slider.max = Math.max(0, m.layers.length - 1);
  play.disabled = !ok;
  if (ok) { m.play(); play.setAttribute('aria-pressed', 'true'); }
}

// ======================================================= events
function bind() {
  // pager scroll → active city (phones)
  el.pager.addEventListener('scroll', debounce(() => {
    if (wide.matches || !el.pager.clientWidth) return;
    const c = S.cities[Math.round(el.pager.scrollLeft / el.pager.clientWidth)];
    if (c && c.id !== S.activeId) setActive(c.id, { scroll: false });
  }, 70), { passive: true });

  // page interactions
  el.pager.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const page = b.closest('.page'), id = page?.dataset.id; if (!id) return;
    const st = uiState(id), v = S.data[id]?.view;
    switch (b.dataset.act) {
      case 'chart-h': st.h = b.dataset.v; rerenderCard(id, 'chart'); break;
      case 'src-off': st.off = +b.dataset.v; rerenderCard(id, 'sources'); break;
      case 'day': { const k = +b.dataset.v; st.day = st.day === k ? null : k; rerenderCard(id, 'daily'); break; }
      case 'alert': { const k = +b.dataset.v; st.alertOpen = st.alertOpen === k ? null : k; rerenderCard(id, 'alerts'); break; }
      case 'refresh': loadCity(id, { force: true }); break;
      case 'to-sources': page.querySelector('[data-card="sources"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
      case 'open-radar': if (v) openSheet('radar'); break;
    }
  });

  // toolbar & list
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act], [data-open], [data-close]');
    if (!b) return;
    if (b.dataset.open) { openSheet(b.dataset.open); return; }
    if (b.dataset.close) { closeSheet(b.dataset.close); return; }
    switch (b.dataset.act) {
      case 'list': openList(); break;
      case 'list-close': closeList(); break;
      case 'dot': case 'pick': setActive(b.dataset.id); closeList(); break;
      case 'del': removeCity(b.dataset.id); break;
      case 'edit': S.edit = !S.edit; $('#btnEdit').textContent = S.edit ? 'Done' : 'Edit'; renderList(); break;
      case 'add': addCity({ name: b.dataset.name, admin: b.dataset.admin, country: b.dataset.country, lat: +b.dataset.lat, lon: +b.dataset.lon }); clearSearch(); break;
      case 'locate': useMyLocation(); break;
      case 'focus-search': openList(); setTimeout(() => el.q.focus(), 80); break;
      case 'glance-close': closeGlance(); break;
      case 'cmp-mode': S.cmp.mode = b.dataset.v; S.cmp.a = S.cmp.mode === 'days' ? 0 : null; S.cmp.b = S.cmp.mode === 'days' ? 1 : null; openCompare(); break;
      case 'r-play': if (S.radar) { if (S.radar.playing) { S.radar.pause(); b.setAttribute('aria-pressed', 'false'); } else { S.radar.play(); b.setAttribute('aria-pressed', 'true'); } } break;
      case 'r-zoom': S.radar?.setZoom(S.radar.z + +b.dataset.v); break;
      case 'r-center': S.radar?.recenter(); break;
    }
  });
  el.glance.addEventListener('click', closeGlance);

  el.q.addEventListener('input', () => doSearch(el.q.value));
  el.q.addEventListener('keydown', e => { if (e.key === 'Enter') el.results.querySelector('.sres')?.click(); });

  const sb = $('#settingsBody');
  sb.addEventListener('click', onSettingsClick); sb.addEventListener('change', onSettingsChange); sb.addEventListener('input', onSettingsInput);

  $('#compareBody').addEventListener('change', e => {
    const k = e.target.dataset.cmp; if (!k) return;
    S.cmp[k] = e.target.value; renderCompare();
  });
  $('#rslider').addEventListener('input', e => { S.radar?.pause(); $('#rplay').setAttribute('aria-pressed', 'false'); S.radar?.show(+e.target.value); });

  addEventListener('keydown', e => { if (e.key === 'Escape') { $$('.sheet.open').forEach(s => closeSheet(s.id.replace('sheet-', ''))); if (!el.glance.hidden) closeGlance(); closeList(); } });
  addEventListener('online', () => { toast('Back online. Updating…'); rerenderActive(); refreshAll(false); });
  addEventListener('offline', () => { toast('You’re offline. Showing saved forecasts.'); rerenderActive(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    rerenderActive();
    if (S.activeId) loadCity(S.activeId);
  });
  wide.addEventListener('change', () => { document.body.classList.remove('list-open'); if (S.activeId) setActive(S.activeId, { instant: true }); });
}

// ======================================================= service worker
function registerSW() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  addEventListener('load', async () => {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('A new version is ready.', { label: 'Reload', onClick: () => { w.postMessage('SKIP_WAITING'); } });
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
      setInterval(() => reg.update().catch(() => {}), 60 * 60e3);
    } catch (e) { console.warn('SW registration failed', e); }
  });
}

init();
