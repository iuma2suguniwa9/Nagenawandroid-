/* ============================================================
   tiles.js — 牌のSVG描画 (役マスター道場と同じビジュアルスタイル)
   MJ のタイプ index (0-33) を受け取って牌のSVGを返す。
============================================================ */
(function (root) {
  'use strict';
  const MJ = root.MJ;
  const SERIF = '"Hiragino Mincho ProN","Yu Mincho",serif';
  const KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function pinDot(x, y, r, color) {
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="${Math.max(5, Math.round(r * 0.5))}"/>`
      + `<circle cx="${x}" cy="${y}" r="${Math.max(2.5, r * 0.22)}" fill="${color}"/>`;
  }
  const PIN_POS = {
    1: [[50, 70]], 2: [[50, 38], [50, 102]], 3: [[28, 34], [50, 70], [72, 106]],
    4: [[30, 40], [70, 40], [30, 100], [70, 100]],
    5: [[28, 36], [72, 36], [50, 70], [28, 104], [72, 104]],
    6: [[32, 36], [68, 36], [32, 70], [68, 70], [32, 104], [68, 104]],
    7: [[24, 26], [50, 32], [76, 38], [32, 84], [68, 84], [32, 116], [68, 116]],
    8: [[32, 26], [68, 26], [32, 58], [68, 58], [32, 90], [68, 90], [32, 122], [68, 122]],
    9: [[26, 34], [50, 34], [74, 34], [26, 70], [50, 70], [74, 70], [26, 106], [50, 106], [74, 106]]
  };
  const PIN_R = { 1: 30, 2: 17, 3: 15, 4: 16, 5: 15, 6: 13, 7: 12, 8: 12, 9: 11 };
  function pinSVG(n, red) {
    if (n === 1) return `<circle cx="50" cy="70" r="32" fill="none" stroke="#2b5f9e" stroke-width="9"/><circle cx="50" cy="70" r="15" fill="#c43a2f"/>`;
    const r = PIN_R[n];
    return PIN_POS[n].map((p, i) => {
      let c = '#2b5f9e';
      if (n === 5 && i === 2) c = '#c43a2f';
      if (n === 3 && i === 1) c = '#c43a2f';
      if (n === 7 && i < 3) c = '#2e7d46';
      if (red && n === 5 && i === 2) c = '#e0463a';
      return pinDot(p[0], p[1], r, c);
    }).join('');
  }
  function stick(x, y, h, color) {
    const w = 10;
    return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="4.5" fill="${color}"/>`
      + `<rect x="${x - w / 2}" y="${y - 2}" width="${w}" height="4" fill="rgba(255,255,255,.55)"/>`;
  }
  const SOU_POS = {
    2: [[50, 40], [50, 100]], 3: [[50, 34], [32, 104], [68, 104]],
    4: [[32, 40], [68, 40], [32, 100], [68, 100]],
    5: [[30, 38], [70, 38], [50, 70], [30, 104], [70, 104]],
    6: [[30, 40], [50, 40], [70, 40], [30, 100], [50, 100], [70, 100]],
    7: [[50, 28], [30, 82], [50, 82], [70, 82], [30, 118], [50, 118], [70, 118]],
    8: [[20, 40], [40, 40], [60, 40], [80, 40], [20, 100], [40, 100], [60, 100], [80, 100]],
    9: [[28, 32], [50, 32], [72, 32], [28, 70], [50, 70], [72, 70], [28, 108], [50, 108], [72, 108]]
  };
  function souSVG(n, red) {
    if (n === 1) {
      return `<path d="M38 106 L24 130 M46 108 L44 132 M54 106 L68 128" stroke="#2e7d46" stroke-width="7" fill="none" stroke-linecap="round"/>`
        + `<ellipse cx="46" cy="80" rx="18" ry="27" fill="#2e7d46" transform="rotate(-14 46 80)"/>`
        + `<circle cx="61" cy="42" r="12" fill="#c43a2f"/><polygon points="71,39 86,44 71,49" fill="#d9a441"/><circle cx="63" cy="39" r="2.6" fill="#fff"/>`;
    }
    const h = n >= 7 ? 26 : 30;
    return SOU_POS[n].map((p, i) => {
      let c = '#2e7d46';
      if (n === 5 && i === 2) c = '#c43a2f';
      if (n === 7 && i === 0) c = '#c43a2f';
      if (n === 9 && i >= 3 && i <= 5) c = '#c43a2f';
      if (red && n === 5 && i === 2) c = '#e0463a';
      return stick(p[0], p[1], h, c);
    }).join('');
  }
  function manSVG(n, red) {
    const col = red ? '#c43a2f' : '#1f2a52';
    return `<text x="50" y="62" font-size="56" font-weight="700" text-anchor="middle" fill="${col}" font-family='${SERIF}'>${KANJI[n]}</text>`
      + `<text x="50" y="126" font-size="50" font-weight="700" text-anchor="middle" fill="#b03028" font-family='${SERIF}'>萬</text>`;
  }
  function honorSVG(idx) {
    const NAMES = ['東', '南', '西', '北', '', '', ''];
    if (idx === 4) return `<rect x="22" y="26" width="56" height="88" rx="9" fill="none" stroke="#8fb0d3" stroke-width="6"/>`;
    const names = ['東', '南', '西', '北', '', '發', '中'];
    const color = idx === 6 ? '#c43a2f' : idx === 5 ? '#2e7d46' : '#2b2b26';
    return `<text x="50" y="94" font-size="72" font-weight="700" text-anchor="middle" fill="${color}" font-family='${SERIF}'>${names[idx]}</text>`;
  }

  function tileSVGInner(type, red) {
    if (type >= 27) return honorSVG(type - 27);
    const suit = MJ.typeSuit(type), rank = MJ.typeRank(type);
    if (suit === MJ.M) return manSVG(rank, red);
    if (suit === MJ.P) return pinSVG(rank, red);
    return souSVG(rank, red);
  }

  function tileHTML(type, opts) {
    opts = opts || {};
    const cls = 'tile' + (opts.small ? ' tile-s' : '') + (opts.selected ? ' selected' : '') + (opts.dim ? ' dim' : '');
    return `<div class="${cls}" data-type="${type}"><svg viewBox="0 0 100 140">${tileSVGInner(type, !!opts.red)}</svg></div>`;
  }
  function tileBackHTML(opts) {
    opts = opts || {};
    return `<div class="tile tileback${opts.small ? ' tile-s' : ''}"></div>`;
  }

  root.MJTiles = { tileHTML, tileBackHTML, tileSVGInner };
})(typeof window !== 'undefined' ? window : globalThis);
