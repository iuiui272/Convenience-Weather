// Animated sky: cross-fading gradients + a light canvas for rain, snow and stars.
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

export class Sky {
  constructor(a, b, canvas, themeMeta) {
    this.layers = [a, b]; this.front = 0; this.key = ''; this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.meta = themeMeta; this.fx = null; this.parts = []; this.raf = 0; this.t = 0;
    this.resize = () => {
      const d = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = innerWidth * d; canvas.height = innerHeight * d; this.d = d;
      this.seed();
    };
    addEventListener('resize', this.resize); this.resize();
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    reduce.addEventListener?.('change', () => this.seed());
  }

  set(theme) {
    const key = `${theme.top}|${theme.bottom}`;
    if (key !== this.key) {
      this.key = key;
      const next = this.layers[1 - this.front];
      next.style.background = `linear-gradient(180deg, ${theme.top} 0%, ${theme.bottom} 100%)`;
      next.style.opacity = '1'; this.layers[this.front].style.opacity = '0';
      this.front = 1 - this.front;
      if (this.meta) this.meta.setAttribute('content', theme.top);
      document.documentElement.style.setProperty('--sky-top', theme.top);
      document.documentElement.style.setProperty('--sky-bottom', theme.bottom);
      document.documentElement.classList.toggle('sky-light', !theme.night && /^#(8a|8d|8c|7f)/i.test(theme.top));
    }
    if (theme.fx !== this.fx) { this.fx = theme.fx; this.seed(); }
  }

  seed() {
    const W = this.canvas.width, H = this.canvas.height, d = this.d || 1;
    const n = this.fx === 'rain' ? 90 : this.fx === 'snow' ? 70 : this.fx === 'stars' ? 80 : 0;
    this.parts = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H, z: 0.4 + Math.random() * 0.8, p: Math.random() * 6.28, d,
    }));
    this.start();
  }

  start() {
    cancelAnimationFrame(this.raf);
    if (!this.fx) { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }
    if (reduce.matches || document.hidden) { this.frame(true); return; }
    const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }

  frame(still) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, d = this.d;
    c.clearRect(0, 0, W, H);
    this.t += 0.016;
    if (this.fx === 'rain') {
      c.strokeStyle = 'rgba(200,225,255,.35)'; c.lineWidth = 1.2 * d; c.beginPath();
      for (const p of this.parts) {
        const len = 14 * p.z * d;
        c.moveTo(p.x, p.y); c.lineTo(p.x - len * 0.25, p.y + len);
        if (!still) { p.y += 16 * p.z * d; p.x -= 4 * p.z * d; if (p.y > H) { p.y = -20; p.x = Math.random() * (W + 80); } }
      }
      c.stroke();
    } else if (this.fx === 'snow') {
      c.fillStyle = 'rgba(255,255,255,.8)';
      for (const p of this.parts) {
        c.beginPath(); c.arc(p.x, p.y, (1.2 + p.z * 1.6) * d, 0, 6.283); c.fill();
        if (!still) { p.y += 1.1 * p.z * d; p.x += Math.sin(this.t + p.p) * 0.5 * d; if (p.y > H) { p.y = -6; p.x = Math.random() * W; } }
      }
    } else if (this.fx === 'stars') {
      for (const p of this.parts) {
        const a = still ? 0.6 : 0.35 + 0.45 * Math.abs(Math.sin(this.t * p.z + p.p));
        c.fillStyle = `rgba(255,255,255,${a * 0.9})`;
        c.beginPath(); c.arc(p.x, p.y * 0.7, p.z * 0.9 * d, 0, 6.283); c.fill();
      }
    }
  }
}
