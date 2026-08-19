/* ============================================================
   fx.js — 演出
   紙吹雪だけ canvas、それ以外は DOM + CSS アニメーション。
   端末が重いときのために粒子数は上限を決めてある。
============================================================ */
(function (root) {
  'use strict';
  const doc = root.document;

  let layer = null, cv = null, cx = null, raf = 0;
  let particles = [];
  let reduced = false;
  try { reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* noop */ }

  function ensure() {
    if (layer) return;
    layer = doc.createElement('div');
    layer.id = 'fx-layer';
    doc.body.appendChild(layer);
    cv = doc.createElement('canvas');
    cv.id = 'fx-canvas';
    layer.appendChild(cv);
    cx = cv.getContext('2d');
    resize();
    root.addEventListener('resize', resize);
  }
  function resize() {
    if (!cv) return;
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    cv.width = Math.floor(root.innerWidth * dpr);
    cv.height = Math.floor(root.innerHeight * dpr);
    cv.style.width = root.innerWidth + 'px';
    cv.style.height = root.innerHeight + 'px';
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------------- 紙吹雪 ----------------
  const CONFETTI_COLORS = ['#ffd34d', '#ff6f61', '#8fe6ae', '#6fc3ff', '#ffffff', '#f3a8ff'];
  const MAX_PARTICLES = 260;

  function confetti(opts) {
    opts = opts || {};
    if (reduced) return;
    ensure();
    const n = Math.min(opts.count || 90, MAX_PARTICLES - particles.length);
    const ox = opts.x === undefined ? root.innerWidth / 2 : opts.x;
    const oy = opts.y === undefined ? root.innerHeight * 0.38 : opts.y;
    const power = opts.power || 13;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = power * (0.35 + Math.random() * 0.9);
      particles.push({
        x: ox, y: oy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4,
        w: 5 + Math.random() * 7, h: 8 + Math.random() * 9,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.32,
        col: opts.colors ? opts.colors[(Math.random() * opts.colors.length) | 0]
          : CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        life: 0, ttl: 90 + Math.random() * 70,
      });
    }
    if (!raf) raf = requestAnimationFrame(step);
  }

  function step() {
    raf = 0;
    if (!cx) return;
    cx.clearRect(0, 0, root.innerWidth, root.innerHeight);
    particles = particles.filter(p => {
      p.life++;
      p.vy += 0.34;          // 重力
      p.vx *= 0.985;         // 空気抵抗
      p.vy *= 0.985;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (p.life > p.ttl || p.y > root.innerHeight + 40) return false;
      const fade = Math.min(1, (p.ttl - p.life) / 26);
      cx.save();
      cx.globalAlpha = fade;
      cx.translate(p.x, p.y);
      cx.rotate(p.rot);
      cx.fillStyle = p.col;
      cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * (0.4 + 0.6 * Math.abs(Math.cos(p.rot))));
      cx.restore();
      return true;
    });
    if (particles.length) raf = requestAnimationFrame(step);
    else cx.clearRect(0, 0, root.innerWidth, root.innerHeight);
  }

  // ---------------- DOM の一発演出 ----------------
  function spawn(cls, html, ms) {
    ensure();
    const e = doc.createElement('div');
    e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    layer.appendChild(e);
    setTimeout(() => { if (e.parentNode) e.parentNode.removeChild(e); }, ms);
    return e;
  }

  // 画面全体の発光
  function flash(color, ms) {
    if (reduced) return;
    const e = spawn('fx-flash', '', ms || 520);
    e.style.background = color || 'rgba(255,255,255,.85)';
    e.style.animationDuration = ((ms || 520) / 1000) + 's';
  }

  // 中心から伸びる集中線
  function rays(color, ms) {
    if (reduced) return;
    const e = spawn('fx-rays', '', ms || 900);
    e.style.setProperty('--ray', color || 'rgba(255,211,77,.55)');
  }

  // 大きな文字を叩きつける (ポン/チー/カン/リーチ/ロン/ツモ)
  function stamp(text, opts) {
    opts = opts || {};
    const ms = opts.ms || 1100;
    const e = spawn('fx-stamp ' + (opts.cls || ''), `<span>${text}</span>`, ms);
    if (opts.color) e.style.setProperty('--stamp', opts.color);
    if (reduced) e.style.animation = 'none';
    return e;
  }

  // 画面を揺らす
  function shake(strength) {
    if (reduced) return;
    const el = doc.getElementById('game-screen') || doc.body;
    el.classList.remove('fx-shake', 'fx-shake-hard');
    void el.offsetWidth; // アニメーションを確実に再生させる
    el.classList.add(strength === 'hard' ? 'fx-shake-hard' : 'fx-shake');
    setTimeout(() => el.classList.remove('fx-shake', 'fx-shake-hard'), 620);
  }

  // 要素の位置から星が弾ける
  function sparkAt(el, color) {
    if (reduced || !el) return;
    const b = el.getBoundingClientRect();
    confetti({
      x: b.left + b.width / 2, y: b.top + b.height / 2,
      count: 26, power: 8, colors: [color || '#ffd34d', '#fff6d8']
    });
  }

  // 数字が増えていく (点数表示)
  function countUp(el, to, ms) {
    if (!el) return;
    if (reduced) { el.textContent = to.toLocaleString(); return; }
    const t0 = performance.now();
    const dur = ms || 700;
    (function tick(now) {
      const k = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * eased).toLocaleString();
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }

  function clear() {
    particles = [];
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (cx) cx.clearRect(0, 0, root.innerWidth, root.innerHeight);
    if (layer) [...layer.querySelectorAll('.fx-stamp,.fx-flash,.fx-rays')].forEach(e => e.remove());
  }

  // ---------------- 場面ごとのまとまった演出 ----------------
  const SCENES = {
    call(kind) {
      const map = {
        pon: { text: 'ポン', color: '#6fc3ff' },
        chi: { text: 'チー', color: '#8fe6ae' },
        kan: { text: 'カン', color: '#ff9d92' },
      };
      const m = map[kind] || map.pon;
      stamp(m.text, { color: m.color, ms: 900 });
      shake();
    },
    riichi() {
      stamp('リーチ', { color: '#ffd34d', cls: 'wide', ms: 1300 });
      flash('rgba(255,211,77,.35)', 420);
      rays('rgba(255,211,77,.5)', 1100);
      shake();
      confetti({ count: 50, power: 11, colors: ['#ffd34d', '#fff6d8', '#ffffff'] });
    },
    tsumo(big) {
      stamp('ツモ', { color: '#ffd34d', cls: 'huge', ms: 1500 });
      flash('rgba(255,255,255,.8)', 380);
      rays('rgba(255,211,77,.6)', 1300);
      confetti({ count: big ? 180 : 110, power: big ? 17 : 13 });
      shake(big ? 'hard' : null);
    },
    ron(big) {
      stamp('ロン', { color: '#ff6f61', cls: 'huge', ms: 1500 });
      flash('rgba(255,120,90,.55)', 420);
      rays('rgba(255,120,90,.55)', 1300);
      confetti({ count: big ? 180 : 110, power: big ? 17 : 13 });
      shake('hard');
    },
    yakuman() {
      stamp('役 満', { color: '#ffd34d', cls: 'huge gold', ms: 2200 });
      flash('rgba(255,255,255,.95)', 500);
      rays('rgba(255,211,77,.75)', 2000);
      shake('hard');
      for (let i = 0; i < 5; i++) {
        setTimeout(() => confetti({
          count: 90, power: 18,
          x: root.innerWidth * (0.2 + 0.15 * i), y: root.innerHeight * 0.35
        }), i * 190);
      }
    },
    lose() {
      flash('rgba(60,10,10,.55)', 500);
      shake('hard');
    },
    win() { confetti({ count: 120, power: 14 }); },
  };

  const API = { confetti, flash, rays, stamp, shake, sparkAt, countUp, clear, scene: (n, a) => { const f = SCENES[n]; if (f) f(a); } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MJFx = API;
})(typeof window !== 'undefined' ? window : globalThis);
