/* ============================================================
   sound.js — 効果音
   音声ファイルを持たず WebAudio でその場で合成する。
   (サイトを1枚の静的ページのまま保ちたいので外部アセットを増やさない)
============================================================ */
(function (root) {
  'use strict';

  let ctx = null;
  let master = null;
  let enabled = true;

  try { enabled = localStorage.getItem('mj-sound') !== 'off'; } catch (e) { /* 非対応でも動く */ }

  // iOS/Safari は必ずユーザー操作の中で作る必要がある
  function unlock() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function isOn() { return enabled; }
  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem('mj-sound', enabled ? 'on' : 'off'); } catch (e) { /* noop */ }
    if (enabled) unlock();
  }
  function toggle() { setEnabled(!enabled); return enabled; }

  function ready() { return enabled && ctx && ctx.state === 'running'; }

  // ---- 基本の音づくり ----

  // 減衰する単音。slideTo を渡すと周波数が動く(しゃくり上げ/下げ)
  function tone(o) {
    if (!ready()) return;
    const t0 = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.18;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
    const peak = (o.gain === undefined ? 0.25 : o.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  // ノイズ + バンドパス。牌がぶつかる「カチッ」を作る
  function clack(o) {
    o = o || {};
    if (!ready()) return;
    const t0 = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.06;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = o.freq || 2100;
    bp.Q.value = o.q || 1.4;
    const g = ctx.createGain();
    g.gain.value = (o.gain === undefined ? 0.5 : o.gain);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0);
  }

  function chord(freqs, o) {
    o = o || {};
    freqs.forEach((f, i) => tone({
      freq: f, dur: o.dur || 0.5, type: o.type || 'triangle',
      gain: (o.gain || 0.2) / Math.sqrt(freqs.length), delay: (o.delay || 0) + i * (o.spread || 0)
    }));
  }

  function arpeggio(freqs, step, o) {
    o = o || {};
    freqs.forEach((f, i) => tone({
      freq: f, dur: o.dur || 0.26, type: o.type || 'triangle',
      gain: o.gain || 0.22, delay: (o.delay || 0) + i * step
    }));
  }

  // ---- 場面ごとの音 ----
  const S = {
    // 自分がツモってきた
    draw() { clack({ freq: 1500, gain: 0.22, dur: 0.045 }); },
    // 牌を捨てた
    discard() { clack({ freq: 2000, gain: 0.45 }); tone({ freq: 190, dur: 0.07, type: 'sine', gain: 0.14 }); },
    // NPCが牌を捨てた(自分より控えめ)
    discardNpc() { clack({ freq: 1900, gain: 0.26, dur: 0.05 }); },
    // 手牌を持ち上げた
    pick() { clack({ freq: 2600, gain: 0.16, dur: 0.03 }); },

    pon() { clack({ freq: 1700, gain: 0.6 }); clack({ freq: 1300, gain: 0.5, delay: 0.07 }); tone({ freq: 300, slideTo: 170, dur: 0.2, type: 'sine', gain: 0.28 }); },
    chi() { clack({ freq: 2100, gain: 0.55 }); clack({ freq: 1600, gain: 0.45, delay: 0.06 }); tone({ freq: 420, slideTo: 300, dur: 0.16, type: 'sine', gain: 0.22 }); },
    kan() {
      clack({ freq: 1500, gain: 0.7 }); clack({ freq: 1100, gain: 0.6, delay: 0.06 });
      clack({ freq: 900, gain: 0.5, delay: 0.12 });
      tone({ freq: 220, slideTo: 110, dur: 0.4, type: 'sawtooth', gain: 0.2 });
    },
    // リーチ宣言: 澄んだ2音
    riichi() {
      tone({ freq: 880, dur: 0.3, type: 'sine', gain: 0.3 });
      tone({ freq: 1318.5, dur: 0.5, type: 'sine', gain: 0.28, delay: 0.12 });
      clack({ freq: 2400, gain: 0.4, delay: 0.02 });
    },
    // ツモ和了: 明るく駆け上がる
    tsumo() {
      arpeggio([523.3, 659.3, 784, 1046.5], 0.075, { gain: 0.26, dur: 0.34 });
      chord([523.3, 659.3, 784, 1046.5], { dur: 1.0, gain: 0.26, delay: 0.3 });
    },
    // ロン和了: 一撃の重み
    ron() {
      clack({ freq: 700, gain: 0.8, dur: 0.16, q: 0.7 });
      tone({ freq: 130, slideTo: 65, dur: 0.5, type: 'square', gain: 0.22 });
      chord([392, 493.9, 587.3, 784], { dur: 1.0, gain: 0.3, delay: 0.1 });
    },
    // 役満: 長いファンファーレ
    yakuman() {
      arpeggio([523.3, 659.3, 784, 1046.5, 1318.5, 1568], 0.09, { gain: 0.28, dur: 0.4 });
      chord([523.3, 784, 1046.5, 1318.5], { dur: 1.6, gain: 0.3, delay: 0.55 });
      chord([261.6, 392, 523.3], { dur: 1.6, gain: 0.22, delay: 0.55 });
    },
    // 振り込んだ
    lose() {
      tone({ freq: 300, slideTo: 120, dur: 0.7, type: 'sawtooth', gain: 0.2 });
      chord([233.1, 277.2], { dur: 0.8, gain: 0.18, delay: 0.05 });
    },
    // ドラをめくった
    dora() { tone({ freq: 1568, dur: 0.5, type: 'sine', gain: 0.24 }); tone({ freq: 2093, dur: 0.4, type: 'sine', gain: 0.16, delay: 0.05 }); },
    // 流局
    draw_end() { tone({ freq: 440, slideTo: 330, dur: 0.5, type: 'triangle', gain: 0.2 }); },
    // 対局終了
    gameEnd() {
      arpeggio([523.3, 659.3, 784], 0.12, { gain: 0.26, dur: 0.4 });
      chord([523.3, 659.3, 784, 1046.5], { dur: 1.4, gain: 0.28, delay: 0.36 });
    },
    // ボタンを押した
    tap() { tone({ freq: 660, dur: 0.05, type: 'square', gain: 0.1 }); },
    // 危ない牌を切ろうとした等の警告
    warn() { tone({ freq: 220, dur: 0.12, type: 'square', gain: 0.16 }); tone({ freq: 180, dur: 0.14, type: 'square', gain: 0.16, delay: 0.1 }); },
  };

  const API = { unlock, isOn, setEnabled, toggle, play(name) { const f = S[name]; if (f) { try { f(); } catch (e) { /* 音が出なくても対局は続ける */ } } } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MJSound = API;
})(typeof window !== 'undefined' ? window : globalThis);
