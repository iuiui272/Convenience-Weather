// A tiny slippy map (no libraries): CARTO dark basemap + RainViewer radar frames.
// Needs a connection; offline it shows a friendly message and the service worker serves any basemap tiles seen before.
const MIN_Z = 3, MAX_Z = 7, TILE = 256;

let metaP, metaAt = 0;
async function radarMeta() {
  if (metaP && Date.now() - metaAt < 5 * 60e3) return metaP;
  metaAt = Date.now();
  metaP = fetch('https://api.rainviewer.com/public/weather-maps.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  metaP.catch(() => { metaP = null; });
  return metaP;
}

const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };

export class RadarMap {
  constructor(el, { lat, lon, zoom = 6, interactive = true, onFrame } = {}) {
    this.el = el; this.lat = lat; this.lon = lon; this.z = zoom; this.interactive = interactive; this.onFrame = onFrame;
    this.cx = lon2x(lon, zoom); this.cy = lat2y(lat, zoom);
    this.frames = []; this.layers = []; this.cur = -1; this.timer = null; this.alive = true;
    el.classList.add('rmap');
    el.innerHTML = '<div class="rbase"></div><div class="rlayers"></div><div class="rpin"></div><div class="rmsg" hidden></div>';
    this.base = el.querySelector('.rbase'); this.lay = el.querySelector('.rlayers'); this.msg = el.querySelector('.rmsg');
    this.baseTiles = new Map();
    this.dpr = window.devicePixelRatio > 1 ? '@2x' : '';
    if (interactive) this.bind();
    this.drawBase();
  }

  size() { return [this.el.clientWidth || 320, this.el.clientHeight || 240]; }

  tileRange() {
    const [w, h] = this.size();
    const x0 = Math.floor(this.cx - w / 2 / TILE), x1 = Math.floor(this.cx + w / 2 / TILE);
    const y0 = Math.floor(this.cy - h / 2 / TILE), y1 = Math.floor(this.cy + h / 2 / TILE);
    return { x0, x1, y0, y1, w, h };
  }
  place(img, x, y) {
    const [w, h] = this.size();
    img.style.transform = `translate(${Math.round(w / 2 + (x - this.cx) * TILE)}px,${Math.round(h / 2 + (y - this.cy) * TILE)}px)`;
  }
  wrapX(x) { const n = 2 ** this.z; return ((x % n) + n) % n; }

  drawBase() {
    const { x0, x1, y0, y1 } = this.tileRange();
    const n = 2 ** this.z, want = new Set();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      const key = `${this.z}/${x}/${y}`; want.add(key);
      let img = this.baseTiles.get(key);
      if (!img) {
        img = new Image(); img.className = 'rt'; img.alt = ''; img.draggable = false; img.decoding = 'async';
        img.onerror = () => { img.style.visibility = 'hidden'; };
        img.src = `https://${'abcd'[(x + y) & 3]}.basemaps.cartocdn.com/dark_all/${this.z}/${this.wrapX(x)}/${y}${this.dpr}.png`;
        this.base.appendChild(img); this.baseTiles.set(key, img);
      }
      this.place(img, x, y);
    }
    for (const [k, img] of this.baseTiles) if (!want.has(k)) { img.remove(); this.baseTiles.delete(k); }
    this.layers.forEach((L, i) => { if (Math.abs(i - this.cur) <= 1 || L.loaded) this.drawLayer(L); });
    const pin = this.el.querySelector('.rpin'); const [w, h] = this.size();
    const px = w / 2 + (lon2x(this.lon, this.z) - this.cx) * TILE, py = h / 2 + (lat2y(this.lat, this.z) - this.cy) * TILE;
    pin.style.transform = `translate(${px}px,${py}px)`;
  }

  drawLayer(L) {
    const { x0, x1, y0, y1 } = this.tileRange();
    const n = 2 ** this.z, want = new Set();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      const key = `${this.z}/${x}/${y}`; want.add(key);
      let img = L.tiles.get(key);
      if (!img) {
        img = new Image(); img.className = 'rt'; img.alt = ''; img.draggable = false;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        img.src = `${this.host}${L.path}/${TILE}/${this.z}/${this.wrapX(x)}/${y}/2/1_1.png`;
        L.el.appendChild(img); L.tiles.set(key, img);
      }
      this.place(img, x, y);
    }
    for (const [k, img] of L.tiles) if (!want.has(k)) { img.remove(); L.tiles.delete(k); }
    L.loaded = true;
  }

  async load() {
    try {
      const j = await radarMeta();
      this.host = j.host || 'https://tilecache.rainviewer.com';
      this.frames = [...(j.radar?.past || []), ...(j.radar?.nowcast || [])];
      if (!this.frames.length) throw new Error('no frames');
      this.nowcastFrom = (j.radar?.past || []).length;
      this.layers = this.frames.map(f => { const el = document.createElement('div'); el.className = 'rlayer'; this.lay.appendChild(el); return { path: f.path, time: f.time * 1000, el, tiles: new Map(), loaded: false }; });
      this.show(this.nowcastFrom - 1);
      this.msg.hidden = true;
      return true;
    } catch {
      this.msg.hidden = false;
      this.msg.textContent = navigator.onLine ? 'Radar is unavailable right now.' : 'Radar needs a connection.';
      return false;
    }
  }

  show(i) {
    if (!this.layers.length) return;
    i = (i + this.layers.length) % this.layers.length;
    this.cur = i;
    const L = this.layers[i];
    this.drawLayer(L);
    this.layers.forEach((l, k) => { l.el.style.opacity = k === i ? '0.72' : '0'; });
    this.onFrame?.(L.time, i, i >= this.nowcastFrom);
  }
  play() {
    if (this.timer || !this.layers.length) return;
    this.layers.forEach(l => this.drawLayer(l)); // preload every frame
    this.timer = setInterval(() => { if (!this.alive) return this.pause(); this.show(this.cur + 1); }, 650);
  }
  pause() { clearInterval(this.timer); this.timer = null; }
  get playing() { return !!this.timer; }
  destroy() { this.alive = false; this.pause(); }

  setZoom(z) {
    z = Math.min(MAX_Z, Math.max(MIN_Z, z));
    if (z === this.z) return;
    const k = 2 ** (z - this.z);
    this.cx *= k; this.cy *= k; this.z = z;
    this.baseTiles.forEach(i => i.remove()); this.baseTiles.clear();
    this.layers.forEach(L => { L.tiles.forEach(i => i.remove()); L.tiles.clear(); L.loaded = false; });
    this.drawBase();
  }

  bind() {
    const ptrs = new Map(); let pinch = 0, raf = 0;
    const sched = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.drawBase(); }); };
    this.el.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; this.el.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
    this.el.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) { this.cx -= (e.clientX - prev[0]) / TILE; this.cy -= (e.clientY - prev[1]) / TILE; sched(); }
      else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (!pinch) pinch = d; else if (d / pinch > 1.6) { this.setZoom(this.z + 1); pinch = d; } else if (d / pinch < 0.62) { this.setZoom(this.z - 1); pinch = d; }
      }
    });
    const up = e => { ptrs.delete(e.pointerId); pinch = 0; };
    this.el.addEventListener('pointerup', up); this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('wheel', e => { e.preventDefault(); this.setZoom(this.z + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  }
  recenter() { this.cx = lon2x(this.lon, this.z); this.cy = lat2y(this.lat, this.z); this.drawBase(); }
}
