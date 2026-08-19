/* ============================================================
   engine.js — 麻雀ルールエンジン (牌・面子分解・役判定・点数計算)
   DOM に依存しない純粋ロジック。Node からも同じコードでテスト可能。
============================================================ */
(function (root) {
  'use strict';

  // ---------- 牌の基本定義 ----------
  // タイプ index: 0-8 萬子1-9 / 9-17 筒子1-9 / 18-26 索子1-9 / 27-33 字牌(東南西北白發中)
  const M = 0, P = 1, S = 2, Z = 3;
  const HONOR_KANJI = ['東', '南', '西', '北', '白', '發', '中'];

  function typeSuit(t) { return t < 9 ? M : t < 18 ? P : t < 27 ? S : Z; }
  function typeRank(t) { return t < 27 ? (t % 9) + 1 : (t - 27) + 1; }
  function isHonor(t) { return t >= 27; }
  function isTerminal(t) { return t < 27 && (t % 9 === 0 || t % 9 === 8); }
  function isTerminalOrHonor(t) { return isHonor(t) || isTerminal(t); }
  function isSimple(t) { return !isTerminalOrHonor(t); }
  const GREEN_TYPES = [19, 20, 21, 23, 25, 30]; // 2,3,4,6,8索 + 發
  function isGreenTile(t) { return GREEN_TYPES.indexOf(t) !== -1; }

  function typeLabel(t) {
    if (t >= 27) return HONOR_KANJI[t - 27];
    const suitCh = t < 9 ? '萬' : t < 18 ? '筒' : '索';
    return typeRank(t) + suitCh;
  }

  // id: 0-135 (type*4 + copyIndex)。copyIndex===3 の 5(赤ドラ候補)は赤扱い。
  function idToType(id) { return Math.floor(id / 4); }
  function isRedFive(id) {
    const t = idToType(id), copy = id % 4;
    return copy === 3 && (t === 4 || t === 13 || t === 22);
  }
  function makeTile(type, copy) { return type * 4 + copy; }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function countsFromIds(ids) {
    const c = new Array(34).fill(0);
    ids.forEach(id => c[idToType(id)]++);
    return c;
  }

  function nextDoraType(indicatorType) {
    if (indicatorType >= 27 && indicatorType <= 30) return 27 + ((indicatorType - 27 + 1) % 4); // 東南西北
    if (indicatorType >= 31 && indicatorType <= 33) return 31 + ((indicatorType - 31 + 1) % 3); // 白發中
    const suitBase = indicatorType - (indicatorType % 9);
    const rank0 = indicatorType % 9; // 0-8
    return suitBase + ((rank0 + 1) % 9);
  }

  // ---------- 面子分解 ----------
  // counts: 34要素配列。meldsNeeded 組の面子(順子/刻子)+雀頭1組に分解できる全パターンを返す。
  function decomposeConcealed(counts, meldsNeeded) {
    const work = counts.slice();
    const results = [];
    function rec(melds, pairT) {
      let i = -1;
      for (let k = 0; k < 34; k++) { if (work[k] > 0) { i = k; break; } }
      if (i === -1) {
        if (melds.length === meldsNeeded && pairT !== null) {
          results.push({ melds: melds.map(m => ({ type: m.type, t: m.t })), pair: pairT });
        }
        return;
      }
      if (pairT === null && work[i] >= 2) {
        work[i] -= 2;
        rec(melds, i);
        work[i] += 2;
      }
      if (melds.length < meldsNeeded && work[i] >= 3) {
        work[i] -= 3;
        melds.push({ type: 'triplet', t: i });
        rec(melds, pairT);
        melds.pop();
        work[i] += 3;
      }
      if (melds.length < meldsNeeded && i < 27 && (i % 9) <= 6 && work[i + 1] > 0 && work[i + 2] > 0) {
        work[i]--; work[i + 1]--; work[i + 2]--;
        melds.push({ type: 'run', t: i });
        rec(melds, pairT);
        melds.pop();
        work[i]++; work[i + 1]++; work[i + 2]++;
      }
    }
    rec([], null);
    return results;
  }

  function isChiitoitsu(counts) {
    let pairs = 0;
    for (let i = 0; i < 34; i++) {
      if (counts[i] === 2) pairs++;
      else if (counts[i] !== 0) return false;
    }
    return pairs === 7;
  }

  const KOKUSHI_TYPES = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  function isKokushi(counts) {
    let pair = false;
    for (const t of KOKUSHI_TYPES) {
      if (counts[t] === 0) return false;
      if (counts[t] >= 2) pair = true;
    }
    for (let i = 0; i < 34; i++) {
      if (KOKUSHI_TYPES.indexOf(i) === -1 && counts[i] > 0) return false;
    }
    return pair;
  }
  function isKokushi13sided(preWinCounts) {
    // preWinCounts: 和了牌を除いた13枚。13種すべて1枚ずつ(対子なし)なら13面待ち。
    for (const t of KOKUSHI_TYPES) { if (preWinCounts[t] !== 1) return false; }
    for (let i = 0; i < 34; i++) { if (KOKUSHI_TYPES.indexOf(i) === -1 && preWinCounts[i] > 0) return false; }
    return true;
  }

  // openMelds: [{kind:'chi'|'pon'|'minkan'|'ankan'|'kakan', tiles:[id,...]}]
  function winDecompositions(handIds, openMelds) {
    const results = [];
    const meldsNeeded = 4 - openMelds.length;
    const counts = countsFromIds(handIds);
    const total = handIds.length;
    if (openMelds.length === 0) {
      if (isChiitoitsu(counts)) results.push({ kind: 'chiitoi' });
      if (isKokushi(counts)) results.push({ kind: 'kokushi' });
    }
    if (total === meldsNeeded * 3 + 2) {
      const decomps = decomposeConcealed(counts, meldsNeeded);
      decomps.forEach(d => results.push({ kind: 'regular', concealedMelds: d.melds, pair: d.pair }));
    }
    return results;
  }

  function isComplete(handIds, openMelds) {
    return winDecompositions(handIds, openMelds).length > 0;
  }

  // hand13ish: 副露を除いた手牌 (13 - 3*副露数 枚)。その状態でのテンパイ判定/待ち牌一覧。
  function getWaits(hand13ish, openMelds) {
    const baseCounts = countsFromIds(hand13ish);
    const waits = [];
    for (let t = 0; t < 34; t++) {
      if (baseCounts[t] >= 4) continue;
      const testIds = hand13ish.concat([makeTile(t, 3)]);
      if (isComplete(testIds, openMelds)) waits.push(t);
    }
    return waits;
  }
  function isTenpai(hand13ish, openMelds) {
    return getWaits(hand13ish, openMelds).length > 0;
  }

  // ---------- 待ちの種類判定 (符計算用) ----------
  function waitInfoForRegular(decomp, winType) {
    // 和了牌が面子(順子/刻子)側にも解釈できる場合はそちらを優先する
    // (例: 78s+99s で 9s 待ち = 789s+99s のリャンメン。pair 一致だけで単騎と決めない)
    for (const m of decomp.allMelds) {
      if (m.type === 'triplet' && m.t === winType) return { kind: 'shanpon', fu: 0, meld: m };
      if (m.type === 'run') {
        const pos = winType - m.t;
        if (pos >= 0 && pos <= 2) {
          const r = typeRank(m.t);
          if ((r === 1 && pos === 2) || (r === 7 && pos === 0)) return { kind: 'penchan', fu: 2, meld: m };
          if (pos === 1) return { kind: 'kanchan', fu: 2, meld: m };
          return { kind: 'ryanmen', fu: 0, meld: m };
        }
      }
    }
    if (decomp.pair === winType) return { kind: 'tanki', fu: 2 };
    return { kind: 'ryanmen', fu: 0 };
  }

  // ---------- 役判定 + 点数計算 ----------
  // ctx = {
  //   handIds, openMelds, winTileId, isTsumo,
  //   seatWindType(27-30), roundWindType(27-28),
  //   riichi, doubleRiichi, ippatsu,
  //   isHaitei, isHoutei, isRinshan, isChankan,
  //   doraIndicatorTypes: [t,...], uraDoraIndicatorTypes: [t,...] (リーチ時のみ有効)
  // }
  function evaluateWin(ctx) {
    const winType = idToType(ctx.winTileId);
    const decomps = winDecompositions(ctx.handIds, ctx.openMelds);
    if (decomps.length === 0) return null;

    const isMenzen = ctx.openMelds.every(m => m.kind === 'ankan');
    const allTileTypes = ctx.handIds.map(idToType).concat(
      ctx.openMelds.reduce((a, m) => a.concat(m.tiles.map(idToType)), [])
    );

    // ドラ計算 (通常役の判定とは独立)
    let doraHan = 0;
    (ctx.doraIndicatorTypes || []).forEach(indT => {
      const doraT = nextDoraType(indT);
      doraHan += allTileTypes.filter(t => t === doraT).length;
    });
    let uraHan = 0;
    if (ctx.riichi || ctx.doubleRiichi) {
      (ctx.uraDoraIndicatorTypes || []).forEach(indT => {
        const doraT = nextDoraType(indT);
        uraHan += allTileTypes.filter(t => t === doraT).length;
      });
    }
    const allIds = ctx.handIds.concat(ctx.openMelds.reduce((a, m) => a.concat(m.tiles), []));
    const akaHan = allIds.filter(isRedFive).length;
    const bonusHan = doraHan + uraHan + akaHan;

    let best = null;

    decomps.forEach(d => {
      const result = evaluateOneDecomposition(d, ctx, winType, isMenzen);
      if (!result) return; // 役なし(ドラのみ)は和了不可
      const totalHanForScore = result.isYakuman ? 0 : result.han + bonusHan;
      const points = scoreFromHanFu(totalHanForScore, result.fu, ctx.isDealer, ctx.isTsumo, result.isYakuman, result.yakumanUnits);
      const totalPoints = points.total;
      if (!best || totalPoints > best.totalPoints) {
        best = {
          yaku: result.yaku,
          han: result.isYakuman ? result.han : result.han + bonusHan,
          yakuHan: result.han,
          doraHan, uraHan, akaHan,
          fu: result.fu,
          isYakuman: result.isYakuman,
          yakumanUnits: result.yakumanUnits,
          points, totalPoints
        };
      }
    });
    return best;
  }

  function evaluateOneDecomposition(d, ctx, winType, isMenzen) {
    if (d.kind === 'chiitoi') return evalChiitoi(ctx, winType);
    if (d.kind === 'kokushi') return evalKokushi(ctx, winType);
    return evalRegular(d, ctx, winType, isMenzen);
  }

  function evalChiitoi(ctx, winType) {
    const counts = countsFromIds(ctx.handIds);
    const types = [];
    for (let i = 0; i < 34; i++) if (counts[i] > 0) types.push(i);
    const yaku = [{ name: '七対子', han: 2 }];
    let han = 2;
    if (types.every(isSimple)) { yaku.push({ name: '断幺九', han: 1 }); han += 1; }
    const allHonor = types.every(isHonor);
    const allSuitedOne = (() => {
      const suits = new Set(types.filter(t => !isHonor(t)).map(typeSuit));
      return suits.size <= 1;
    })();
    if (allHonor) { yaku.push({ name: '字一色', han: 13, isYakuman: true }); return { yaku, han: 13, fu: 25, isYakuman: true, yakumanUnits: 1 }; }
    if (allSuitedOne) {
      const hasHonor = types.some(isHonor);
      if (hasHonor) { yaku.push({ name: '混一色', han: 2 }); han += 2; }
      else { yaku.push({ name: '清一色', han: 5 }); han += 5; }
    }
    return { yaku, han, fu: 25, isYakuman: false };
  }

  function evalKokushi(ctx, winType) {
    const counts = countsFromIds(ctx.handIds);
    const pre = counts.slice();
    pre[winType]--;
    const doubleWait = isKokushi13sided(pre);
    const han = doubleWait ? 26 : 13;
    return {
      yaku: [{ name: doubleWait ? '国士無双十三面待ち' : '国士無双', han, isYakuman: true }],
      han, fu: 25, isYakuman: true, yakumanUnits: doubleWait ? 2 : 1
    };
  }

  function evalRegular(d, ctx, winType, isMenzen) {
    // 面子統合: 副露 + 手牌側の分解結果
    const allMelds = d.concealedMelds.map(m => ({
      type: m.type, t: m.t, concealed: true, isKan: false, size: m.type === 'run' ? 3 : 3
    }));
    ctx.openMelds.forEach(om => {
      const t = idToType(om.tiles[0]);
      allMelds.push({
        type: om.kind === 'chi' ? 'run' : 'triplet',
        t,
        concealed: om.kind === 'ankan',
        isKan: om.kind === 'ankan' || om.kind === 'minkan' || om.kind === 'kakan',
        size: om.tiles.length
      });
    });
    const pairType = d.pair;

    const wait = waitInfoForRegular({ pair: pairType, allMelds }, winType);
    // ロンで刻子を完成させた場合、その面子は「明刻」扱い(符が下がる)
    if (!ctx.isTsumo && wait.meld && wait.meld.type === 'triplet') {
      wait.meld.concealed = false;
    }

    const yaku = [];
    let han = 0;
    const add = (name, h) => { yaku.push({ name, han: h }); han += h; };

    // --- 役満チェック ---
    const yakumanList = [];
    const dragonTriplets = allMelds.filter(m => m.type === 'triplet' && m.t >= 31 && m.t <= 33);
    const windTriplets = allMelds.filter(m => m.type === 'triplet' && m.t >= 27 && m.t <= 30);
    const allTypesUsed = allMelds.map(m => m.t).concat([pairType]);

    if (dragonTriplets.length === 3) yakumanList.push({ name: '大三元', han: 13 });
    if (windTriplets.length === 4) yakumanList.push({ name: '大四喜', han: 26, units: 2 });
    else if (windTriplets.length === 3 && pairType >= 27 && pairType <= 30) yakumanList.push({ name: '小四喜', han: 13 });
    const ankouCountForYakuman = allMelds.filter(m => m.type === 'triplet' && m.concealed).length;
    if (ankouCountForYakuman === 4) {
      const tankiWin = wait.kind === 'tanki';
      yakumanList.push({ name: tankiWin ? '四暗刻単騎' : '四暗刻', han: tankiWin ? 26 : 13, units: tankiWin ? 2 : 1 });
    }
    if (allTypesUsed.every(isHonor)) yakumanList.push({ name: '字一色', han: 13 });
    if (allTypesUsed.every(isTerminal)) yakumanList.push({ name: '清老頭', han: 13 });
    if (allTypesUsed.every(isGreenTile)) yakumanList.push({ name: '緑一色', han: 13 });
    if (allMelds.filter(m => m.isKan).length === 4) yakumanList.push({ name: '四槓子', han: 13 });
    // 九蓮宝燈 (門前・清一色・特定形)。和了牌を除いた形が 1112345678999 ちょうどなら
    // 9面待ち = 純正九蓮宝燈 (雀魂ではダブル役満)。
    if (isMenzen && ctx.openMelds.length === 0) {
      const suits = new Set(allTypesUsed.filter(t => !isHonor(t)).map(typeSuit));
      if (suits.size === 1 && !allTypesUsed.some(isHonor)) {
        const suit = [...suits][0];
        const base = suit * 9;
        const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
        const c = countsFromIds(ctx.handIds);
        let ok = true;
        for (let r = 0; r < 9; r++) if (c[base + r] < need[r]) ok = false;
        if (ok) {
          const pre = c.slice();
          pre[winType]--;
          let junsei = true;
          for (let r = 0; r < 9; r++) if (pre[base + r] !== need[r]) junsei = false;
          if (junsei) yakumanList.push({ name: '純正九蓮宝燈', han: 26, units: 2 });
          else yakumanList.push({ name: '九蓮宝燈', han: 13 });
        }
      }
    }

    if (yakumanList.length > 0) {
      const units = yakumanList.reduce((s, y) => s + (y.units || 1), 0);
      const totalHan = yakumanList.reduce((s, y) => s + y.han, 0);
      return { yaku: yakumanList, han: totalHan, fu: 25, isYakuman: true, yakumanUnits: units };
    }

    // --- 通常役 ---
    if (ctx.doubleRiichi) add('ダブルリーチ', 2);
    else if (ctx.riichi) add('リーチ', 1);
    if (ctx.ippatsu && (ctx.riichi || ctx.doubleRiichi)) add('一発', 1);
    if (ctx.isTsumo && isMenzen) add('門前清自摸和', 1);
    if (ctx.isHaitei) add(ctx.isTsumo ? '海底摸月' : '河底撈魚', 1);
    if (ctx.isRinshan) add('嶺上開花', 1);
    if (ctx.isChankan) add('槍槓', 1);

    const onlyRuns = allMelds.every(m => m.type === 'run');
    const pairIsYakuhai = pairType >= 31 && pairType <= 33;
    if (isMenzen && onlyRuns && !pairIsYakuhai && wait.kind === 'ryanmen') add('平和', 1);

    if (allTypesUsed.every(isSimple)) add('断幺九', 1);

    allMelds.forEach(m => {
      if (m.type !== 'triplet') return;
      let h = 0;
      if (m.t >= 31 && m.t <= 33) h = 1;
      if (m.t === ctx.roundWindType) h += 1;
      if (m.t === ctx.seatWindType) h += 1;
      if (h > 0) add('役牌(' + typeLabel(m.t) + ')', h);
    });

    if (dragonTriplets.length === 2 && pairIsYakuhai) add('小三元', 2);

    // 一盃口 / 二盃口
    const runTypes = allMelds.filter(m => m.type === 'run').map(m => m.t);
    const runCounts = {};
    runTypes.forEach(t => runCounts[t] = (runCounts[t] || 0) + 1);
    const dupPairs = Object.values(runCounts).filter(c => c >= 2).length;
    if (isMenzen) {
      if (dupPairs >= 2) add('二盃口', 3);
      else if (dupPairs === 1) add('一盃口', 1);
    }

    // 三色同順
    for (let r = 0; r < 7; r++) {
      if (runCounts[r] && runCounts[9 + r] && runCounts[18 + r]) { add('三色同順', isMenzen ? 2 : 1); break; }
    }
    // 三色同刻
    const tripTypes = allMelds.filter(m => m.type === 'triplet').map(m => m.t);
    for (let r = 0; r < 9; r++) {
      if (tripTypes.indexOf(r) !== -1 && tripTypes.indexOf(9 + r) !== -1 && tripTypes.indexOf(18 + r) !== -1) { add('三色同刻', 2); break; }
    }
    // 一気通貫
    [0, 9, 18].forEach(base => {
      if (runCounts[base] && runCounts[base + 3] && runCounts[base + 6]) add('一気通貫', isMenzen ? 2 : 1);
    });

    // チャンタ / 純チャン
    const meldsHaveTerminalOrHonor = allMelds.every(m => {
      if (m.type === 'triplet') return isTerminalOrHonor(m.t);
      return m.t % 9 === 0 || m.t % 9 === 6; // 123 or 789 の順子
    });
    if (meldsHaveTerminalOrHonor && isTerminalOrHonor(pairType)) {
      const hasHonorTile = allTypesUsed.some(isHonor);
      if (hasHonorTile) add('混全帯幺九', isMenzen ? 2 : 1);
      else add('純全帯幺九', isMenzen ? 3 : 2);
    }

    // 対々和 / 三暗刻
    if (allMelds.every(m => m.type === 'triplet')) add('対々和', 2);
    const ankouCount = allMelds.filter(m => m.type === 'triplet' && m.concealed).length;
    if (ankouCount === 3) add('三暗刻', 2);
    if (allMelds.filter(m => m.isKan).length === 3) add('三槓子', 2);

    // 混老頭
    if (allTypesUsed.every(isTerminalOrHonor) && allTypesUsed.some(isHonor) && allTypesUsed.some(isTerminal)) add('混老頭', 2);

    // 混一色 / 清一色
    const nonHonorSuits = new Set(allTypesUsed.filter(t => !isHonor(t)).map(typeSuit));
    if (nonHonorSuits.size === 1) {
      const hasHonorTile = allTypesUsed.some(isHonor);
      if (hasHonorTile) add('混一色', isMenzen ? 3 : 2);
      else add('清一色', isMenzen ? 6 : 5);
    }

    if (han === 0) return null; // 役なし = 和了不可 (ドラのみは無効)

    const fu = computeFu(ctx, allMelds, pairType, wait, isMenzen, ctx.isTsumo, yaku.some(y => y.name === '平和'));
    return { yaku, han, fu, isYakuman: false };
  }

  function computeFu(ctx, allMelds, pairType, wait, isMenzen, isTsumo, isPinfu) {
    if (isPinfu) return isTsumo ? 20 : 30;
    let fu = 20;
    if (!isTsumo && isMenzen) fu += 10;
    if (isTsumo) fu += 2;
    allMelds.forEach(m => {
      if (m.type !== 'triplet') return;
      const simple = isSimple(m.t);
      let base = simple ? 4 : 8;
      if (m.isKan) base *= 4;
      if (!m.concealed) base /= 2;
      fu += base;
    });
    if (pairType === ctx.roundWindType) fu += 2;
    if (pairType === ctx.seatWindType) fu += 2;
    if (pairType >= 31 && pairType <= 33) fu += 2;
    fu += wait.fu || 0;
    return Math.ceil(fu / 10) * 10;
  }

  function scoreFromHanFu(han, fu, isDealer, isTsumo, isYakuman, yakumanUnits) {
    let base;
    if (isYakuman) base = 8000 * (yakumanUnits || 1);
    else if (han >= 13) base = 8000;
    else if (han >= 11) base = 6000;
    else if (han >= 8) base = 4000;
    else if (han >= 6) base = 3000;
    else {
      base = fu * Math.pow(2, 2 + han);
      if (han >= 5 || base > 2000) base = 2000;
    }
    const roundUp100 = x => Math.ceil(x / 100) * 100;
    if (isTsumo) {
      if (isDealer) {
        const each = roundUp100(base * 2);
        return { kind: 'tsumo-dealer', each, total: each * 3 };
      }
      const fromDealer = roundUp100(base * 2), fromNonDealer = roundUp100(base * 1);
      return { kind: 'tsumo-nondealer', fromDealer, fromNonDealer, total: fromDealer + fromNonDealer * 2 };
    }
    const total = roundUp100(isDealer ? base * 6 : base * 4);
    return { kind: 'ron', total };
  }

  // ---------- 向聴数 (シャンテン数) ----------
  // counts: 34要素。openMeldCount: 副露数。通常形のシャンテン数を返す (0=テンパイ, -1=和了形)。
  function regularShanten(counts, openMeldCount) {
    const c = counts.slice();
    let best = 8;
    const maxSets = 4 - openMeldCount;
    function done(sets, partials, hasPair) {
      const totalSets = sets + openMeldCount;
      let p = partials;
      if (totalSets + p > 4) p = 4 - totalSets;
      const s = 8 - 2 * totalSets - p - (hasPair ? 1 : 0);
      if (s < best) best = s;
    }
    function rec2(i, sets, partials, hasPair) {
      while (i < 34 && c[i] === 0) i++;
      if (i >= 34) { done(sets, partials, hasPair); return; }
      if (sets < maxSets) {
        if (c[i] >= 3) { c[i] -= 3; rec2(i, sets + 1, partials, hasPair); c[i] += 3; }
        if (i < 27 && (i % 9) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
          c[i]--; c[i + 1]--; c[i + 2]--;
          rec2(i, sets + 1, partials, hasPair);
          c[i]++; c[i + 1]++; c[i + 2]++;
        }
      }
      if (c[i] >= 2) {
        if (!hasPair) { c[i] -= 2; rec2(i, sets, partials, true); c[i] += 2; }
        if (sets + openMeldCount + partials < 4) { c[i] -= 2; rec2(i, sets, partials + 1, hasPair); c[i] += 2; }
      }
      if (sets + openMeldCount + partials < 4 && i < 27 && (i % 9) <= 7 && c[i + 1] > 0) {
        c[i]--; c[i + 1]--; rec2(i, sets, partials + 1, hasPair); c[i]++; c[i + 1]++;
      }
      if (sets + openMeldCount + partials < 4 && i < 27 && (i % 9) <= 6 && c[i + 2] > 0) {
        c[i]--; c[i + 2]--; rec2(i, sets, partials + 1, hasPair); c[i]++; c[i + 2]++;
      }
      const saved = c[i];
      c[i] = 0;
      rec2(i + 1, sets, partials, hasPair);
      c[i] = saved;
    }
    rec2(0, 0, 0, false);
    return best;
  }

  function chiitoiShanten(counts) {
    let pairs = 0, kinds = 0;
    for (let i = 0; i < 34; i++) {
      if (counts[i] > 0) kinds++;
      if (counts[i] >= 2) pairs++;
    }
    return 6 - pairs + Math.max(0, 7 - kinds);
  }
  function kokushiShanten(counts) {
    let kinds = 0, hasPair = false;
    for (const t of KOKUSHI_TYPES) {
      if (counts[t] > 0) kinds++;
      if (counts[t] >= 2) hasPair = true;
    }
    return 13 - kinds - (hasPair ? 1 : 0);
  }

  // handIds: 13 - 3*副露数 枚 (ツモ牌を切った後の形)。-1=和了形 0=テンパイ 1=イーシャンテン…
  function shanten(handIds, openMelds) {
    const counts = countsFromIds(handIds);
    const openCount = (openMelds || []).length;
    let s = regularShanten(counts, openCount);
    if (openCount === 0) {
      s = Math.min(s, chiitoiShanten(counts), kokushiShanten(counts));
    }
    return s;
  }

  // ---------- チー候補 ----------
  function chiPossibilities(handIds, discardType) {
    if (discardType >= 27) return [];
    const counts = countsFromIds(handIds);
    const r = discardType % 9;
    const base = discardType - r;
    const options = [];
    const has = t => counts[t] > 0;
    if (r >= 2 && has(discardType - 2) && has(discardType - 1)) options.push([discardType - 2, discardType - 1]);
    if (r >= 1 && r <= 7 && has(discardType - 1) && has(discardType + 1)) options.push([discardType - 1, discardType + 1]);
    if (r <= 6 && has(discardType + 1) && has(discardType + 2)) options.push([discardType + 1, discardType + 2]);
    return options;
  }

  const MJ = {
    M, P, S, Z, HONOR_KANJI,
    typeSuit, typeRank, isHonor, isTerminal, isTerminalOrHonor, isSimple, isGreenTile,
    typeLabel, idToType, isRedFive, makeTile, shuffle, countsFromIds, nextDoraType,
    decomposeConcealed, isChiitoitsu, isKokushi, KOKUSHI_TYPES,
    winDecompositions, isComplete, getWaits, isTenpai,
    evaluateWin, scoreFromHanFu, chiPossibilities,
    shanten, regularShanten, chiitoiShanten, kokushiShanten
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MJ;
  else root.MJ = MJ;
})(typeof window !== 'undefined' ? window : globalThis);
