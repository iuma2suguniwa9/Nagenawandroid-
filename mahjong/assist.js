/* ============================================================
   assist.js — 初心者アシスト (ヒント・受け入れ計算・役の見込み)
   engine.js の向聴数/待ち計算をもとに「何を切ればいいか」
   「今どの役が狙えるか」を日本語で提示する。DOM には触れない。
============================================================ */
(function (root) {
  'use strict';
  const MJ = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.MJ;

  // ---------- 場に見えている牌から残り枚数を数える ----------
  // 自分の手牌・全員の捨て牌・全員の副露・ドラ表示牌 は「見えている」
  function visibleCounts(game, seat) {
    const c = new Array(34).fill(0);
    const me = game.player(seat);
    me.hand.forEach(id => c[MJ.idToType(id)]++);
    game.players.forEach(p => {
      p.discards.forEach(d => c[MJ.idToType(d.tileId)]++);
      p.melds.forEach(m => m.tiles.forEach(id => c[MJ.idToType(id)]++));
    });
    game.doraIndicatorTypes().forEach(t => c[t]++);
    return c;
  }
  function remaining(game, seat, type) {
    return Math.max(0, 4 - visibleCounts(game, seat)[type]);
  }

  // ---------- 受け入れ (有効牌) の計算 ----------
  // ある13枚の形から、何を引けば向聴数が進むか + その残り枚数合計
  function ukeire(game, seat, hand13, melds) {
    const base = MJ.shanten(hand13, melds);
    const vis = visibleCounts(game, seat);
    const tiles = [];
    let total = 0;
    for (let t = 0; t < 34; t++) {
      const held = hand13.filter(id => MJ.idToType(id) === t).length;
      if (held >= 4) continue;
      // その牌を引いた14枚の向聴数が下がれば有効牌。
      // (テンパイ時は和了牌を引くと -1 になるので、そのまま待ち牌が求まる)
      const test = hand13.concat([MJ.makeTile(t, 3)]);
      if (MJ.shanten(test, melds) < base) {
        const left = Math.max(0, 4 - vis[t]);
        tiles.push({ type: t, left });
        total += left;
      }
    }
    return { shanten: base, tiles, total };
  }

  // ---------- 打牌候補の評価 ----------
  // 14枚の手牌それぞれを切った場合の 向聴数 / 受け入れ枚数 / 危険度 を返し、
  // 「向聴が最も進む → 受け入れが広い → 危険度が低い」順に並べる。
  function discardCandidates(game, seat) {
    const p = game.player(seat);
    const banned = game.forbiddenDiscards ? game.forbiddenDiscards(seat) : [];
    const seen = new Set();
    const cands = [];
    p.hand.forEach(id => {
      const t = MJ.idToType(id);
      if (seen.has(t) || banned.includes(t)) return;
      seen.add(t);
      const rest = p.hand.filter(x => x !== id);
      const u = ukeire(game, seat, rest, p.melds);
      cands.push({
        tileId: id, type: t, label: MJ.typeLabel(t),
        shanten: u.shanten, ukeire: u.total, ukeireTiles: u.tiles,
        danger: dangerLevel(game, seat, t)
      });
    });
    cands.sort((a, b) =>
      a.shanten - b.shanten || b.ukeire - a.ukeire || a.danger - b.danger
    );
    return cands;
  }

  // ---------- 危険度 (リーチ者に対する放銃しやすさの目安) ----------
  // 0=安全(現物) 1=比較的安全(字牌/スジ) 2=やや危険 3=危険
  function dangerLevel(game, seat, type) {
    const threats = game.players.filter(p => p.seat !== seat && p.riichi);
    if (threats.length === 0) return 0;
    let worst = 0;
    threats.forEach(th => {
      // 現物(その人の捨て牌にある)なら絶対に当たらない
      const genbutsu = th.discards.some(d => MJ.idToType(d.tileId) === type);
      if (genbutsu) return;
      let lv;
      if (MJ.isHonor(type)) {
        // 場に3枚見えている字牌は当たりにくい
        lv = remaining(game, seat, type) <= 1 ? 1 : 2;
      } else {
        const r = MJ.typeRank(type);
        const base = type - (r - 1);
        // スジ判定 (4を切るなら1と7が捨てられているか)
        const sujiSafe =
          (r >= 4 && r <= 6)
            ? th.discards.some(d => MJ.idToType(d.tileId) === base + (r - 4)) &&
              th.discards.some(d => MJ.idToType(d.tileId) === base + (r + 2))
            : th.discards.some(d => {
                const dr = MJ.typeRank(MJ.idToType(d.tileId));
                return MJ.typeSuit(MJ.idToType(d.tileId)) === MJ.typeSuit(type) &&
                  (r <= 3 ? dr === r + 3 : dr === r - 3);
              });
        if (sujiSafe) lv = 1;
        else if (r === 1 || r === 9) lv = 2;
        else lv = 3;
      }
      if (lv > worst) worst = lv;
    });
    return worst;
  }
  const DANGER_LABEL = ['安全', 'やや安全', '注意', '危険'];

  // ---------- 狙える役の見込み ----------
  // 今の手牌から現実的に狙える役を、達成度つきで返す。
  function yakuCandidates(game, seat) {
    const p = game.player(seat);
    const allIds = p.hand.concat(p.melds.reduce((a, m) => a.concat(m.tiles), []));
    const types = allIds.map(MJ.idToType);
    const counts = MJ.countsFromIds(allIds);
    const isMenzen = p.melds.every(m => m.kind === 'ankan');
    const total = types.length;
    const out = [];

    // --- タンヤオ ---
    const badForTanyao = types.filter(MJ.isTerminalOrHonor).length;
    out.push({
      name: 'タンヤオ', han: '1翻', open: true,
      ok: badForTanyao === 0,
      note: badForTanyao === 0 ? '成立中！1・9・字牌を引いても使わないように'
        : `1・9・字牌があと${badForTanyao}枚。これを全部入れ替えれば狙えます`,
      score: 100 - badForTanyao * 18
    });

    // --- 役牌 ---
    const yakuhaiTypes = [31, 32, 33, 27 + p.seatWind, game.round.roundWind];
    const yakuhaiReady = [];
    [...new Set(yakuhaiTypes)].forEach(t => {
      if (counts[t] >= 3) yakuhaiReady.push({ t, n: counts[t], done: true });
      else if (counts[t] === 2) yakuhaiReady.push({ t, n: 2, done: false });
    });
    if (yakuhaiReady.length > 0) {
      const done = yakuhaiReady.filter(y => y.done);
      out.push({
        name: '役牌', han: '1翻', open: true,
        ok: done.length > 0,
        note: done.length > 0
          ? `${done.map(y => MJ.typeLabel(y.t)).join('・')}が揃っていて役が確定しています`
          : `${yakuhaiReady.map(y => MJ.typeLabel(y.t)).join('・')}があと1枚でポンできます(残り${yakuhaiReady.map(y => remaining(game, seat, y.t)).join('/')}枚)`,
        score: done.length > 0 ? 120 : 95
      });
    }

    // --- 混一色 / 清一色 ---
    const suitCount = [0, 0, 0], honorCount = types.filter(MJ.isHonor).length;
    types.filter(t => !MJ.isHonor(t)).forEach(t => suitCount[MJ.typeSuit(t)]++);
    const bestSuit = suitCount.indexOf(Math.max(...suitCount));
    const offSuit = total - suitCount[bestSuit] - honorCount;
    const suitName = ['萬子', '筒子', '索子'][bestSuit];
    if (offSuit <= 4) {
      out.push({
        name: honorCount > 0 ? '混一色' : '清一色',
        han: honorCount > 0 ? (isMenzen ? '3翻' : '2翻') : (isMenzen ? '6翻' : '5翻'),
        open: true,
        ok: offSuit === 0,
        note: offSuit === 0
          ? `${suitName}${honorCount > 0 ? '＋字牌' : ''}だけで揃っています！`
          : `${suitName}に寄せると狙えます。他の色があと${offSuit}枚`,
        score: 90 - offSuit * 12
      });
    }

    // --- 対々和 ---
    let pairsOrSets = 0;
    for (let t = 0; t < 34; t++) if (counts[t] >= 2) pairsOrSets++;
    if (pairsOrSets >= 3) {
      out.push({
        name: '対々和', han: '2翻', open: true,
        ok: false,
        note: `同じ牌の組が${pairsOrSets}組あります。全部を3枚ずつにすると成立(ポンOK)`,
        score: 40 + pairsOrSets * 8
      });
    }

    // --- 七対子 ---
    let pairs = 0;
    for (let t = 0; t < 34; t++) if (counts[t] === 2) pairs++;
    if (pairs >= 4 && isMenzen) {
      out.push({
        name: '七対子', han: '2翻', open: false,
        ok: pairs === 7,
        note: `対子が${pairs}組。あと${7 - pairs}組で成立します(鳴くと不可)`,
        score: 40 + pairs * 9
      });
    }

    // --- 平和・リーチ ---
    if (isMenzen) {
      const sh = MJ.shanten(p.hand.length % 3 === 2 ? p.hand.slice(0, p.hand.length - 1) : p.hand, p.melds);
      out.push({
        name: 'リーチ', han: '1翻', open: false,
        ok: sh <= 0,
        note: sh <= 0 ? 'テンパイ！リーチできます'
          : `門前を維持すれば狙えます(あと${sh}向聴)`,
        score: sh <= 0 ? 130 : 70 - sh * 8
      });
    }

    // --- チャンタ ---
    const chantaBad = types.filter(t => !MJ.isTerminalOrHonor(t)).length;
    if (chantaBad <= 5) {
      out.push({
        name: 'チャンタ', han: isMenzen ? '2翻' : '1翻', open: true,
        ok: false,
        note: `1・9・字牌が多い手。全ての面子に端牌を入れると成立(残り${chantaBad}枚が中張牌)`,
        score: 35 + (14 - chantaBad) * 3
      });
    }

    return out.sort((a, b) => (b.ok - a.ok) || (b.score - a.score)).slice(0, 5);
  }

  // ---------- まとめて1回で取得 ----------
  function analyze(game, seat) {
    const p = game.player(seat);
    const drawn = p.hand.length % 3 === 2; // 自摸後(打牌前)か
    const hand13 = drawn ? null : p.hand;
    const result = {
      isMyTurn: drawn,
      shanten: null, waits: [], candidates: [], yaku: yakuCandidates(game, seat)
    };
    if (drawn) {
      result.candidates = discardCandidates(game, seat);
      result.shanten = result.candidates.length ? result.candidates[0].shanten : null;
      // 現在テンパイなら待ちも出す
      const best = result.candidates[0];
      if (best && best.shanten === 0) {
        const rest = p.hand.filter(x => x !== best.tileId);
        result.waits = MJ.getWaits(rest, p.melds).map(t => ({
          type: t, label: MJ.typeLabel(t), left: remaining(game, seat, t)
        }));
      }
    } else {
      result.shanten = MJ.shanten(p.hand, p.melds);
      if (result.shanten === 0) {
        result.waits = MJ.getWaits(p.hand, p.melds).map(t => ({
          type: t, label: MJ.typeLabel(t), left: remaining(game, seat, t)
        }));
      }
    }
    // フリテン警告
    if (result.waits.length > 0 && game.isFuriten) {
      result.furiten = game.isFuriten(seat, result.waits.map(w => w.type));
    }
    return result;
  }

  function shantenLabel(s) {
    if (s === null || s === undefined) return '';
    if (s <= -1) return '和了形';
    if (s === 0) return 'テンパイ';
    return s + '向聴';
  }

  const API = { analyze, discardCandidates, ukeire, yakuCandidates, dangerLevel, remaining, shantenLabel, DANGER_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MJAssist = API;
})(typeof window !== 'undefined' ? window : globalThis);
