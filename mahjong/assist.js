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

  // ============================================================
  //  狙える役の見込み
  //  手牌を ctx にまとめ、役ごとに「あと何枚入れ替えれば形になるか」(need)
  //  を見積もる。ctx は仮定の手牌(鳴いた後など)でも作れるので、
  //  鳴きの損得もこの同じ物差しで比べられる。
  // ============================================================
  const SUIT_NAME = ['萬子', '筒子', '索子'];

  function handContext(game, seat, override) {
    const p = game.player(seat);
    const hand = override ? override.hand : p.hand;
    const melds = override ? override.melds : p.melds;
    const meldIds = melds.reduce((a, m) => a.concat(m.tiles), []);
    const allIds = hand.concat(meldIds);
    return {
      game, seat, hand, melds, allIds,
      types: allIds.map(MJ.idToType),
      counts: MJ.countsFromIds(allIds),
      concealed: MJ.countsFromIds(hand),
      // 暗槓は門前を崩さない
      isMenzen: melds.every(m => m.kind === 'ankan'),
      kanCount: melds.filter(m => m.kind.indexOf('kan') >= 0).length,
      seatWind: p.seatWind,
      roundWind: game.round.roundWind,
    };
  }

  // 数え上げの補助
  function countIf(counts, pred) { let n = 0; for (let t = 0; t < 34; t++) if (pred(t)) n += counts[t]; return n; }
  function typesWith(counts, min) { let n = 0; for (let t = 0; t < 34; t++) if (counts[t] >= min) n++; return n; }
  function typesExactly(counts, n0) { let n = 0; for (let t = 0; t < 34; t++) if (counts[t] === n0) n++; return n; }

  // 刻子を n 組そろえるのにあと何枚必要か。
  // 対子は1枚で刻子になるが、単騎からは2枚いる。アタマの要否も加える。
  function koutsuNeed(counts, n, needHead) {
    const sets = typesWith(counts, 3);
    const pairs = typesExactly(counts, 2);
    const want = Math.max(0, n - sets);
    const usePairs = Math.min(pairs, want);
    const fromSingles = want - usePairs;
    let need = usePairs + fromSingles * 2;
    // アタマに回せる対子が残っていなければ1枚足りない
    if (needHead && pairs - usePairs <= 0) need += 1;
    return { need, sets, pairs };
  }

  // 役満は13翻相当として価値を測る
  function hanValue(h) { return h >= 13 ? 13 : h; }

  // need(入れ替えが必要な枚数)が小さく、翻が高い役ほど上に来るようにする。
  // trait(タンヤオ・染め手など「条件を満たしているか」型)の need=0 は
  // 「あとは形を作るだけ」であって和了が近いわけではないので、加点は控えめにする。
  function priority(e) {
    const base = (hanValue(e.hanMenzen) + 1) * 100 / (1 + e.need * 1.15);
    const s = base + (e.need === 0 ? (e.trait ? 60 : 260) : 0);
    // 門前ツモのように「条件次第で自動的に付く」役は一覧を占領しないよう控えめに
    return e.minor ? s * 0.45 : s;
  }

  function hanText(e, isMenzen) {
    if (e.hanMenzen >= 13) return '役満';
    const h = isMenzen ? e.hanMenzen : e.hanOpen;
    if (h === null || h === undefined) return e.hanMenzen + '翻(門前のみ)';
    return h + '翻' + (isMenzen && e.hanOpen !== null && e.hanOpen < e.hanMenzen ? `(鳴くと${e.hanOpen}翻)` : '');
  }

  // 個々の役の見込みを算出する。need が大きすぎるものは候補から外す。
  function yakuList(ctx) {
    const { counts, concealed, types, isMenzen } = ctx;
    const out = [];
    const total = types.length;
    const add = e => {
      if (e.need === null || e.need === undefined) return;
      if (e.menzenOnly && !isMenzen) return;      // もう鳴いているので不可能
      if (e.need > (e.maxNeed === undefined ? 6 : e.maxNeed)) return;
      e.ok = e.need === 0;
      e.hanOpen = e.menzenOnly ? null : (e.hanOpen === undefined ? e.hanMenzen : e.hanOpen);
      e.han = hanText(e, isMenzen);
      e.score = priority(e);
      out.push(e);
    };

    // ---- タンヤオ ----
    const badTanyao = countIf(counts, MJ.isTerminalOrHonor);
    add({
      key: 'tanyao', trait: true, name: 'タンヤオ', hanMenzen: 1, need: badTanyao, maxNeed: 6,
      note: badTanyao === 0 ? '2〜8の牌だけ。1・9・字牌を使わなければ確定です'
        : `1・9・字牌が${badTanyao}枚。これを入れ替えれば成立(鳴いてもOK)`
    });

    // ---- 役牌 ----
    const yakuhai = [...new Set([31, 32, 33, 27 + ctx.seatWind, ctx.roundWind])];
    let bestYakuhai = null;
    yakuhai.forEach(t => {
      const c = counts[t];
      if (c === 0) return;
      const left = remaining(ctx.game, ctx.seat, t);
      const need = c >= 3 ? 0 : (3 - c);
      // 場に残っていない牌は諦める
      if (need > left) return;
      if (!bestYakuhai || need < bestYakuhai.need) bestYakuhai = { t, c, need, left };
    });
    if (bestYakuhai) {
      const { t, c, need, left } = bestYakuhai;
      add({
        key: 'yakuhai', name: `役牌(${MJ.typeLabel(t)})`, hanMenzen: 1, need, maxNeed: 2,
        note: need === 0 ? `${MJ.typeLabel(t)}が3枚。役が確定しています`
          : c === 2 ? `${MJ.typeLabel(t)}があと1枚でポンできます(残り${left}枚)`
            : `${MJ.typeLabel(t)}をあと2枚(残り${left}枚)`
      });
    }

    // ---- 染め手 ----
    const suitCount = [0, 0, 0];
    const honorCount = countIf(counts, MJ.isHonor);
    types.filter(t => !MJ.isHonor(t)).forEach(t => suitCount[MJ.typeSuit(t)]++);
    const bestSuit = suitCount.indexOf(Math.max(...suitCount));
    const offSuit = total - suitCount[bestSuit] - honorCount;
    add({
      key: 'honitsu', trait: true, name: '混一色', hanMenzen: 3, hanOpen: 2, need: offSuit, maxNeed: 5,
      note: offSuit === 0 ? `${SUIT_NAME[bestSuit]}と字牌だけ。形になれば成立です`
        : `${SUIT_NAME[bestSuit]}＋字牌に寄せる。他の色が${offSuit}枚`
    });
    add({
      key: 'chinitsu', trait: true, name: '清一色', hanMenzen: 6, hanOpen: 5, need: offSuit + honorCount, maxNeed: 5,
      note: (offSuit + honorCount) === 0 ? `${SUIT_NAME[bestSuit]}だけ！`
        : `${SUIT_NAME[bestSuit]}だけに寄せる。他が${offSuit + honorCount}枚`
    });

    // ---- 対々和 / 三暗刻 / 混老頭 ----
    const toitoi = koutsuNeed(counts, 4, true);
    add({
      key: 'toitoi', name: '対々和', hanMenzen: 2, need: toitoi.need, maxNeed: 5,
      note: `刻子${toitoi.sets}組・対子${toitoi.pairs}組。全部を3枚組にすると成立(ポンで進められます)`
    });
    const ankan = ctx.melds.filter(m => m.kind === 'ankan').length;
    const ankou = typesWith(concealed, 3) + ankan;
    const san = koutsuNeed(concealed, 3 - ankan, false);
    const suu = koutsuNeed(concealed, 4 - ankan, true);
    if (ankou + typesExactly(concealed, 2) >= 2) {
      add({
        key: 'sanankou', name: '三暗刻', hanMenzen: 2, need: san.need, maxNeed: 4,
        note: `暗刻が${ankou}組。あと${Math.max(0, 3 - ankou)}組（鳴いて作った刻子は数えられません）`
      });
      add({
        key: 'suuankou', name: '四暗刻', hanMenzen: 13, need: suu.need, maxNeed: 4,
        note: `暗刻が${ankou}組。4組そろえば役満（ポンした瞬間に消えます）`
      });
    }
    const simples = countIf(counts, MJ.isSimple);
    add({
      key: 'honroutou', trait: true, name: '混老頭', hanMenzen: 2, need: simples, maxNeed: 5,
      note: `1・9・字牌だけで刻子を揃える形。中張牌が${simples}枚`
    });

    // ---- 七対子 / 二盃口 ----
    const pairs = typesExactly(counts, 2);
    add({
      key: 'chiitoi', name: '七対子', hanMenzen: 2, menzenOnly: true,
      need: Math.max(0, 7 - pairs), maxNeed: 4,
      note: `対子が${pairs}組。7組で成立（鳴くと不可）`
    });

    // ---- 一盃口 / 二盃口 ----
    const peikou = countPeikou(counts);
    if (peikou.best >= 4) {
      add({
        key: 'iipeiko', name: '一盃口', hanMenzen: 1, menzenOnly: true,
        need: 6 - peikou.best, maxNeed: 3,
        note: peikou.best === 6 ? '同じ順子が2組そろっています（鳴くと消えます）'
          : `同じ順子を2組つくる形にあと${6 - peikou.best}枚（鳴くと消えます）`
      });
    }
    if (peikou.count >= 1) {
      add({
        key: 'ryanpeiko', name: '二盃口', hanMenzen: 3, menzenOnly: true,
        need: (2 - peikou.count) * 3, maxNeed: 4,
        note: `一盃口が${peikou.count}組。2組で二盃口（鳴くと不可）`
      });
    }

    // ---- 三色同順 / 一気通貫 / 三色同刻 ----
    const sanshoku = bestSanshoku(counts);
    add({
      key: 'sanshoku', name: '三色同順', hanMenzen: 2, hanOpen: 1, need: sanshoku.need, maxNeed: 5,
      note: `${sanshoku.r}${sanshoku.r + 1}${sanshoku.r + 2}を三色でそろえる形にあと${sanshoku.need}枚`
    });
    const ittsu = bestIttsu(counts);
    add({
      key: 'ittsu', name: '一気通貫', hanMenzen: 2, hanOpen: 1, need: ittsu.need, maxNeed: 5,
      note: `${SUIT_NAME[ittsu.suit]}の1〜9を1本そろえる形にあと${ittsu.need}枚`
    });
    const sanshokuKo = bestSanshokuKoutsu(counts);
    add({
      key: 'sanshokuko', name: '三色同刻', hanMenzen: 2, need: sanshokuKo.need, maxNeed: 4,
      note: `${sanshokuKo.r}の刻子を三色そろえる形にあと${sanshokuKo.need}枚`
    });

    // ---- チャンタ / 純チャン ----
    const middle = countIf(counts, t => !MJ.isHonor(t) && MJ.typeRank(t) >= 4 && MJ.typeRank(t) <= 6);
    add({
      key: 'chanta', trait: true, name: 'チャンタ', hanMenzen: 2, hanOpen: 1, need: middle, maxNeed: 5,
      note: `全ての面子に1・9・字牌を含める形。4〜6の牌が${middle}枚`
    });
    add({
      key: 'junchan', trait: true, name: '純全帯幺九', hanMenzen: 3, hanOpen: 2, need: middle + honorCount, maxNeed: 5,
      note: `字牌を使わないチャンタ。入れ替えが${middle + honorCount}枚`
    });

    // ---- 三元牌 ----
    const dragons = [31, 32, 33];
    const dragonSets = dragons.filter(t => counts[t] >= 3).length;
    const dragonPairs = dragons.filter(t => counts[t] === 2).length;
    const dragonHeld = dragons.reduce((a, t) => a + Math.min(counts[t], 3), 0);
    if (dragonHeld >= 2) {
      add({
        key: 'shousangen', name: '小三元', hanMenzen: 4, need: Math.max(0, 8 - dragonHeld), maxNeed: 4,
        note: `三元牌を2組の刻子＋1組の対子に。役牌2つ分も付きます`
      });
      add({
        key: 'daisangen', name: '大三元', hanMenzen: 13, need: Math.max(0, 9 - dragonHeld), maxNeed: 4,
        note: `白發中を全部刻子にすると役満（あと${Math.max(0, 9 - dragonHeld)}枚・ポンOK）`
      });
    }

    // ---- 四喜和 ----
    const winds = [27, 28, 29, 30];
    const windHeld = winds.reduce((a, t) => a + Math.min(counts[t], 3), 0);
    if (windHeld >= 5) {
      add({
        key: 'suushi', name: '四喜和', hanMenzen: 13, need: Math.max(0, 11 - windHeld), maxNeed: 4,
        note: `風牌を3組の刻子＋対子以上に。役満です`
      });
    }

    // ---- 字一色 / 清老頭 / 緑一色 ----
    add({
      key: 'tsuuiisou', trait: true, name: '字一色', hanMenzen: 13, need: total - honorCount, maxNeed: 4,
      note: `字牌だけで揃える役満。字牌以外が${total - honorCount}枚`
    });
    const terminals = countIf(counts, MJ.isTerminal);
    add({
      key: 'chinroutou', trait: true, name: '清老頭', hanMenzen: 13, need: total - terminals, maxNeed: 4,
      note: `1と9だけの役満。他が${total - terminals}枚`
    });
    const greens = countIf(counts, MJ.isGreenTile);
    add({
      key: 'ryuuiisou', trait: true, name: '緑一色', hanMenzen: 13, need: total - greens, maxNeed: 4,
      note: `索子の23468と發だけの役満。他が${total - greens}枚`
    });

    // ---- 国士無双 ----
    const kokushiKinds = MJ.KOKUSHI_TYPES.filter(t => counts[t] > 0).length;
    const kokushiPair = MJ.KOKUSHI_TYPES.some(t => counts[t] >= 2);
    add({
      key: 'kokushi', name: '国士無双', hanMenzen: 13, menzenOnly: true,
      need: Math.max(0, 14 - kokushiKinds - (kokushiPair ? 1 : 0)), maxNeed: 5,
      note: `13種類の1・9・字牌のうち${kokushiKinds}種類。${kokushiPair ? 'アタマもあります' : 'どれか1つを2枚に'}（鳴くと不可）`
    });

    // ---- 九蓮宝燈 ----
    if (offSuit + honorCount <= 2) {
      const need9 = churenNeed(counts, bestSuit);
      add({
        key: 'churen', name: '九蓮宝燈', hanMenzen: 13, menzenOnly: true,
        need: need9 + offSuit + honorCount, maxNeed: 4,
        note: `${SUIT_NAME[bestSuit]}の1112345678999の形。役満（鳴くと不可）`
      });
    }

    // ---- 槓子系 ----
    if (ctx.kanCount >= 2) {
      add({ key: 'sankantsu', name: '三槓子', hanMenzen: 2, need: Math.max(0, 3 - ctx.kanCount) * 2, maxNeed: 3, note: `カンが${ctx.kanCount}回。3回で成立` });
      add({ key: 'suukantsu', name: '四槓子', hanMenzen: 13, need: Math.max(0, 4 - ctx.kanCount) * 2, maxNeed: 3, note: `カンが${ctx.kanCount}回。4回で役満` });
    }

    // ---- 門前限定の基本役 ----
    if (isMenzen) {
      const hand13 = ctx.hand.length % 3 === 2 ? ctx.hand.slice(0, ctx.hand.length - 1) : ctx.hand;
      const sh = MJ.shanten(hand13, ctx.melds);
      add({
        key: 'riichi', name: 'リーチ', hanMenzen: 1, menzenOnly: true,
        need: Math.max(0, sh) * 2, maxNeed: 8,
        note: sh <= 0 ? 'テンパイ！リーチできます（一発・裏ドラも付きます）'
          : `門前のままテンパイすれば宣言できます（あと${sh}向聴）`
      });
      add({
        key: 'tsumo', name: '門前清自摸和', hanMenzen: 1, menzenOnly: true, minor: true,
        need: Math.max(0, sh) * 2, maxNeed: 8,
        note: '鳴かずに自分でツモれば1翻（鳴くと消えます）'
      });
      // 平和は「刻子を作らない・アタマが役牌でない」形
      const hasTriplet = typesWith(concealed, 3) > 0;
      const pinfuBlock = countIf(concealed, t => MJ.isHonor(t) && yakuhai.indexOf(t) >= 0);
      add({
        key: 'pinfu', trait: true, name: '平和', hanMenzen: 1, menzenOnly: true,
        need: (hasTriplet ? 2 : 0) + pinfuBlock, maxNeed: 4,
        note: '順子だけ＋役牌でないアタマ＋両面待ち（鳴くと消えます）'
      });
    }

    return out.sort((a, b) => b.score - a.score);
  }

  // 同じ順子が2組できているか(一盃口)を調べる
  function countPeikou(counts) {
    let count = 0, best = 0;
    for (let s = 0; s < 3; s++) {
      for (let r = 0; r < 7; r++) {
        const b = s * 9 + r;
        const have = Math.min(counts[b], 2) + Math.min(counts[b + 1], 2) + Math.min(counts[b + 2], 2);
        if (have > best) best = have;
        if (counts[b] >= 2 && counts[b + 1] >= 2 && counts[b + 2] >= 2) count++;
      }
    }
    return { count, best };
  }

  // 三色同順に一番近い並びを探す
  function bestSanshoku(counts) {
    let best = { need: 99, r: 1 };
    for (let r = 0; r < 7; r++) {
      let need = 0;
      for (let s = 0; s < 3; s++) {
        const b = s * 9 + r;
        need += (counts[b] ? 0 : 1) + (counts[b + 1] ? 0 : 1) + (counts[b + 2] ? 0 : 1);
      }
      if (need < best.need) best = { need, r: r + 1 };
    }
    return best;
  }

  // 一気通貫に一番近い色を探す
  function bestIttsu(counts) {
    let best = { need: 99, suit: 0 };
    for (let s = 0; s < 3; s++) {
      let need = 0;
      for (let r = 0; r < 9; r++) if (!counts[s * 9 + r]) need++;
      if (need < best.need) best = { need, suit: s };
    }
    return best;
  }

  // 三色同刻に一番近い数字を探す
  function bestSanshokuKoutsu(counts) {
    let best = { need: 99, r: 1 };
    for (let r = 0; r < 9; r++) {
      let need = 0;
      for (let s = 0; s < 3; s++) need += Math.max(0, 3 - counts[s * 9 + r]);
      if (need < best.need) best = { need, r: r + 1 };
    }
    return best;
  }

  // 九蓮宝燈 1112345678999 の形にあと何枚か
  function churenNeed(counts, suit) {
    const want = [3, 1, 1, 1, 1, 1, 1, 1, 3];
    let need = 0;
    for (let r = 0; r < 9; r++) need += Math.max(0, want[r] - counts[suit * 9 + r]);
    return need;
  }

  function yakuCandidates(game, seat, limit) {
    return yakuList(handContext(game, seat)).slice(0, limit || 6);
  }

  // ============================================================
  //  鳴きの損得
  //  「鳴いた後の手」を仮に組み立てて、鳴く前と同じ物差しで比べる。
  //  何が消えて何が残るか・向聴がどれだけ進むかを返す。
  // ============================================================

  // 13枚+副露の形から、1枚切ったあとの最小向聴数
  function bestShantenAfterDiscard(hand, melds) {
    const seen = new Set();
    let best = 99;
    hand.forEach(id => {
      const t = MJ.idToType(id);
      if (seen.has(t)) return;
      seen.add(t);
      const s = MJ.shanten(hand.filter(x => x !== id), melds);
      if (s < best) best = s;
    });
    return best === 99 ? MJ.shanten(hand, melds) : best;
  }

  // 鳴いた後の手牌を作る。usedTypes は手牌から出す牌の種類
  function simulateCall(game, seat, kind, tileId, usedTypes) {
    const p = game.player(seat);
    const hand = p.hand.slice();
    const taken = [];
    usedTypes.forEach(t => {
      const i = hand.findIndex(id => MJ.idToType(id) === t);
      if (i >= 0) taken.push(hand.splice(i, 1)[0]);
    });
    if (taken.length !== usedTypes.length) return null; // 手牌が足りない(想定外)
    const meld = { kind, tiles: [tileId].concat(taken), from: -1 };
    return { hand, melds: p.melds.concat([meld]) };
  }

  // 鳴く前と鳴いた後を比べる
  function callImpact(game, seat, kind, tileId, usedTypes) {
    const p = game.player(seat);
    const after = simulateCall(game, seat, kind, tileId, usedTypes);
    if (!after) return null;

    const beforeCtx = handContext(game, seat);
    const afterCtx = handContext(game, seat, after);
    const beforeList = yakuList(beforeCtx);
    const afterList = yakuList(afterCtx);
    const afterByKey = {};
    afterList.forEach(e => { afterByKey[e.key] = e; });
    const beforeByKey = {};
    beforeList.forEach(e => { beforeByKey[e.key] = e; });

    // 現実的に狙えている範囲だけを比べる(遠すぎる役を並べても混乱するため)
    const plausible = e => e.need <= 3;

    const lost = [], downgraded = [], worsened = [], kept = [], improved = [];
    beforeList.filter(plausible).forEach(e => {
      const a = afterByKey[e.key];
      // 鳴いた瞬間に不可能になる(門前限定)、または遠すぎて候補から外れた
      if (!a) { lost.push(e); return; }
      const bh = e.hanMenzen, ah = a.hanOpen === null ? a.hanMenzen : a.hanOpen;
      if (ah < bh) { downgraded.push({ name: e.name, from: bh, to: ah }); return; }
      // 翻は同じでも、鳴いた牌のせいで条件から遠ざかることがある(端牌をチーしてタンヤオが消える等)
      if (a.need > e.need) { worsened.push({ name: e.name, from: e.need, to: a.need }); return; }
      kept.push(e);
    });
    afterList.filter(plausible).forEach(e => {
      const b = beforeByKey[e.key];
      if (!b || b.need > e.need) improved.push({ name: e.name, need: e.need, was: b ? b.need : null });
    });

    const shBefore = MJ.shanten(p.hand, p.melds);
    const shAfter = bestShantenAfterDiscard(after.hand, after.melds);

    // 鳴いた後に成立しうる役が1つも無いと和了できない。初心者が一番はまるところ。
    const openYakuAfter = afterList.filter(e => !e.menzenOnly && e.need <= 2);

    return {
      kind, shantenBefore: shBefore, shantenAfter: shAfter,
      lost, downgraded, worsened,
      kept: kept.slice(0, 4), improved: improved.slice(0, 4),
      noYakuRisk: openYakuAfter.length === 0,
      openYaku: openYakuAfter.slice(0, 3),
    };
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

  const API = {
    analyze, discardCandidates, ukeire, yakuCandidates, callImpact,
    dangerLevel, remaining, shantenLabel, DANGER_LABEL
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MJAssist = API;
})(typeof window !== 'undefined' ? window : globalThis);
