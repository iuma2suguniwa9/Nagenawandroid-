/* ============================================================
   game.js — 対局進行 (状態機械) + NPC AI
   engine.js のルール判定を使い、配牌・ツモ・打牌・鳴き・和了・流局・
   局の進行(東風戦/半荘)を管理する。DOM には触れない。
   UI (ui.js) は onEvent コールバックでイベントを受け取り描画する。
============================================================ */
(function (root) {
  'use strict';
  const MJ = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.MJ;

  const SEAT_NAMES = ['あなた', 'CPU1(下家)', 'CPU2(対面)', 'CPU3(上家)'];
  const WIND_NAME = ['東', '南', '西', '北'];

  function nextSeat(s) { return (s + 1) % 4; }

  function newPlayer(seat, isHuman) {
    return {
      seat, isHuman, name: SEAT_NAMES[seat],
      score: 25000,
      hand: [], melds: [], discards: [],
      riichi: false, doubleRiichi: false, riichiDiscardIndex: -1,
      ippatsuEligible: false, drawsSinceRiichi: 0,
      tempFuriten: false,   // 同巡内フリテン (次の自摸で解除)
      riichiFuriten: false, // リーチ後にフリテンになったら和了終了まで継続
      anyDiscardCalled: false, // 流し満貫判定: 自分の捨て牌が鳴かれたか
      kuikaeForbidden: [],  // 食い替え禁止牌 (直後の打牌のみ)
      seatWind: 0, isDealer: false
    };
  }

  class MahjongGame {
    constructor(opts) {
      this.opts = Object.assign({ mode: 'tonpuu', humanSeat: 0 }, opts || {});
      this.players = [0, 1, 2, 3].map(s => newPlayer(s, s === this.opts.humanSeat));
      this.round = { roundWind: 27, roundNumber: 1, honba: 0, riichiSticks: 0, dealerSeat: 0 };
      // 雀魂準拠: 東風戦は東4局まで(未達なら南入)、半荘戦は南4局まで(未達なら西入)
      this.endWind = this.opts.mode === 'hanchan' ? 1 : 0; // 0=東 1=南
      this.RETURN_SCORE = 30000; // 返し点(オカ)
      this.UMA = [15, 5, -5, -15]; // 順位ウマ
      this.log = [];
      this.pending = null; // {type:'discard'|'call', ...}
      this.gameOver = false;
      this.listeners = [];
    }
    on(fn) { this.listeners.push(fn); }
    emit(evt) { this.listeners.forEach(fn => fn(evt)); }
    say(msg) { this.log.push(msg); this.emit({ type: 'log', message: msg }); }

    humanSeat() { return this.opts.humanSeat; }
    player(seat) { return this.players[seat]; }
    isDealer(seat) { return seat === this.round.dealerSeat; }

    // ---------------- 局の開始 ----------------
    startHand() {
      const wallAll = MJ.shuffle(Array.from({ length: 136 }, (_, i) => i));
      this.deadWall = wallAll.slice(122); // 14枚: [0-3]嶺上 [4-8]ドラ表示 [9-13]裏ドラ表示
      this.rinshanIdx = 0;
      this.doraRevealed = 1;
      this.wall = wallAll.slice(0, 122);
      this.wallPos = 0;
      this.kanCount = 0;
      this.kanSeats = [];        // 四槓散了判定: 誰が槓したか
      this.pendingKanDora = 0;   // 明槓/加槓の新ドラは打牌後にめくる (雀魂準拠)

      this.players.forEach(p => {
        p.hand = []; p.melds = []; p.discards = [];
        p.riichi = false; p.doubleRiichi = false; p.riichiDiscardIndex = -1;
        p.ippatsuEligible = false; p.drawsSinceRiichi = 0;
        p.tempFuriten = false; p.riichiFuriten = false;
        p.anyDiscardCalled = false; p.kuikaeForbidden = [];
        p.seatWind = (p.seat - this.round.dealerSeat + 4) % 4;
        p.isDealer = this.isDealer(p.seat);
      });
      for (let i = 0; i < 13; i++) {
        for (const p of this.players) p.hand.push(this.wall[this.wallPos++]);
      }
      this.turnSeat = this.round.dealerSeat;
      this.handEnded = false;
      this.firstGoAround = true; // ダブルリーチ判定用
      this.anyCallMade = false;
      this.emit({ type: 'handStart', round: JSON.parse(JSON.stringify(this.round)), players: this.playersPublicView() });
      this.say(`--- ${WIND_NAME[this.round.roundWind - 27]}${this.round.roundNumber}局 ${this.round.honba}本場 開始 ---`);
      this.doDrawPhase();
    }

    doraIndicatorTypes() {
      return this.deadWall.slice(4, 4 + this.doraRevealed).map(MJ.idToType);
    }
    uraDoraIndicatorTypes() {
      return this.deadWall.slice(9, 9 + this.doraRevealed).map(MJ.idToType);
    }

    // ---------------- ツモ ----------------
    doDrawPhase() {
      if (this.wallPos >= this.wall.length) { this.exhaustiveDraw(); return; }
      const seat = this.turnSeat;
      const p = this.players[seat];
      const tileId = this.wall[this.wallPos++];
      p.hand.push(tileId);
      this.lastDraw = { seat, tileId };
      // 同巡内フリテンは自分の自摸番で解除 (リーチ後フリテンは和了終了まで継続)
      p.tempFuriten = false;
      // 一発は「リーチ宣言〜次の自摸+打牌」の1巡のみ。2回目の自摸で消える。
      if (p.riichi) {
        p.drawsSinceRiichi++;
        if (p.drawsSinceRiichi >= 2) p.ippatsuEligible = false;
      }
      this.emit({ type: 'draw', seat, tileId, wallRemaining: this.wall.length - this.wallPos });

      // ツモ和了チェック
      const winCtx = this.buildWinContext(seat, tileId, true, {
        isHaitei: this.wallPos >= this.wall.length,
        isRinshan: false
      });
      const result = MJ.evaluateWin(winCtx);
      if (result) {
        this.pending = { type: 'tsumoChoice', seat, tileId, result };
        if (p.isHuman) { this.emit({ type: 'awaitTsumoChoice', seat, result }); return; }
        this.resolveTsumo(seat, tileId, result);
        return;
      }

      // 九種九牌 (第1自摸・鳴きなし・么九牌9種類以上で流局宣言できる)
      if (this.canDeclareKyuushu(seat)) {
        this.pending = { type: 'kyuushuChoice', seat, tileId };
        if (p.isHuman) { this.emit({ type: 'awaitKyuushuChoice', seat, kinds: this.kyuushuKinds(seat) }); return; }
        if (this.kyuushuKinds(seat) >= 9) { this.abortiveDraw('九種九牌', seat); return; }
      }

      // 暗槓/加槓チェック (打牌前)
      const kanOptions = this.ankanOptions(seat).concat(this.kakanOptions(seat));
      if (kanOptions.length > 0) {
        this.pending = { type: 'kanOrDiscard', seat, tileId, kanOptions };
        if (p.isHuman) { this.emit({ type: 'awaitKanOrDiscard', seat, kanOptions, tileId }); return; }
        const choice = this.aiChooseAnkan(seat, kanOptions);
        if (choice) { this.performSelfKan(seat, choice); return; }
      }
      this.requestDiscard(seat);
    }

    // 九種九牌: 自分の第1自摸で、まだ誰も鳴いておらず、么九牌が9種類以上
    canDeclareKyuushu(seat) {
      const p = this.players[seat];
      if (p.discards.length > 0 || this.anyCallMade) return false;
      return this.kyuushuKinds(seat) >= 9;
    }
    kyuushuKinds(seat) {
      const types = new Set(this.players[seat].hand.map(MJ.idToType).filter(MJ.isTerminalOrHonor));
      return types.size;
    }

    requestDiscard(seat) {
      const p = this.players[seat];
      this.pending = { type: 'discard', seat };
      if (p.isHuman) { this.emit({ type: 'awaitDiscard', seat, canRiichi: this.canDeclareRiichi(seat) }); return; }
      const tileId = this.aiChooseDiscard(seat);
      const declareRiichi = this.aiWantsRiichi(seat, tileId);
      this.discard(seat, tileId, declareRiichi);
    }

    canDeclareRiichi(seat) {
      const p = this.players[seat];
      if (p.riichi) return false;
      if (p.melds.some(m => m.kind !== 'ankan')) return false; // 副露していたらリーチ不可
      if (p.score < 1000) return false;
      const hand13 = p.hand.slice();
      // 直前にツモった牌を1枚抜いた状態それぞれでテンパイになるか(=現14枚のいずれかを切ってテンパイ)を確認
      for (let i = 0; i < hand13.length; i++) {
        const rest = hand13.slice(0, i).concat(hand13.slice(i + 1));
        if (MJ.isTenpai(rest, p.melds)) return true;
      }
      return false;
    }

    // ---------------- 打牌 ----------------
    discard(seat, tileId, declareRiichi) {
      const p = this.players[seat];
      const idx = p.hand.indexOf(tileId);
      if (idx === -1) throw new Error('discard: tile not in hand');
      if (p.kuikaeForbidden.includes(MJ.idToType(tileId))) {
        throw new Error('discard: 食い替えは禁止されています');
      }
      p.kuikaeForbidden = [];
      p.hand.splice(idx, 1);
      if (declareRiichi) {
        if (p.riichi) declareRiichi = false;
        else {
          p.riichi = true;
          p.doubleRiichi = this.firstGoAround && !this.anyCallMade;
          p.score -= 1000;
          this.round.riichiSticks += 1;
          p.riichiDiscardIndex = p.discards.length;
          p.ippatsuEligible = true;
          p.drawsSinceRiichi = 0;
        }
      }
      p.discards.push({ tileId, riichi: declareRiichi });
      this.emit({ type: 'discard', seat, tileId, riichi: declareRiichi });
      if (this.firstGoAround && seat === 3) this.firstGoAround = false;

      // 明槓・加槓の新ドラは打牌後にめくる (雀魂準拠。暗槓は槓した時点で即めくり)
      if (this.pendingKanDora > 0) {
        this.doraRevealed = Math.min(5, this.doraRevealed + this.pendingKanDora);
        this.pendingKanDora = 0;
      }

      this.resolveCalls(seat, tileId);
    }

    // ---------------- 食い替え (雀魂は禁止) ----------------
    // ポン: 同じ牌を即切り禁止。チー: 鳴いた牌 + 筋牌(順子の反対側)を禁止。
    kuikaeTypesFor(kind, calledType, meldTypes) {
      if (kind === 'pon') return [calledType];
      const sorted = meldTypes.slice().sort((a, b) => a - b);
      const forbidden = [calledType];
      const rank = calledType % 9;
      if (calledType === sorted[0] && rank <= 5) forbidden.push(calledType + 3);
      else if (calledType === sorted[2] && rank >= 3) forbidden.push(calledType - 3);
      return forbidden;
    }
    forbiddenDiscards(seat) { return this.players[seat].kuikaeForbidden.slice(); }

    // ---------------- 鳴き判定 ----------------
    resolveCalls(discarderSeat, tileId) {
      const tileType = MJ.idToType(tileId);
      const others = [1, 2, 3].map(d => (discarderSeat + d) % 4);

      // ロン: 雀魂は頭ハネ (捨てた人から反時計回りに最も近い1人だけが和了)
      const ronSeats = others.filter(seat => this.canRon(seat, tileId));
      if (ronSeats.length > 0) {
        const winner = ronSeats[0]; // others は下家→対面→上家の順なので先頭が頭ハネ勝者
        if (winner === this.humanSeat()) {
          this.pending = { type: 'ronChoice', discarderSeat, tileId, ronSeats: [winner] };
          this.emit({ type: 'awaitRonChoice', discarderSeat, tileId, ronSeats: [winner] });
          return;
        }
        this.resolveRon(discarderSeat, tileId, [winner]);
        return;
      }

      // ロンが無かった時点で途中流局の判定 (雀魂: これらが成立すると鳴きより優先して流局)
      const abort = this.checkAbortiveDraw();
      if (abort) { this.abortiveDraw(abort, discarderSeat); return; }

      const ponSeats = others.filter(seat => this.countInHand(seat, tileType) >= 2);
      const kanSeats = others.filter(seat => this.countInHand(seat, tileType) >= 3);
      const chiSeat = nextSeat(discarderSeat);
      const chiOptions = MJ.chiPossibilities(this.players[chiSeat].hand, tileType);
      const chiAvailable = others.includes(chiSeat) && chiOptions.length > 0;

      if (ponSeats.length > 0 || kanSeats.length > 0) {
        // 同じプレイヤーがポン/カンどちらも選べる場合がある
        const seat = (kanSeats[0] !== undefined && ponSeats.includes(kanSeats[0])) ? kanSeats[0] : (ponSeats[0] !== undefined ? ponSeats[0] : kanSeats[0]);
        const canPon = ponSeats.includes(seat);
        const canKan = kanSeats.includes(seat);
        const p = this.players[seat];
        if (p.isHuman) {
          this.pending = { type: 'ponKanChoice', seat, discarderSeat, tileId, canPon, canKan };
          this.emit({ type: 'awaitPonKanChoice', seat, discarderSeat, tileId, canPon, canKan });
          return;
        }
        const choice = this.aiPonKanDecision(seat, tileType, canPon, canKan);
        if (choice === 'kan') { this.callKan(seat, discarderSeat, tileId); return; }
        if (choice === 'pon') { this.callPon(seat, discarderSeat, tileId); return; }
        // パス -> チーの権利は失われる(優先度ルール)
        this.afterNoCall(discarderSeat);
        return;
      }

      if (chiAvailable) {
        const p = this.players[chiSeat];
        if (p.isHuman) {
          this.pending = { type: 'chiChoice', seat: chiSeat, discarderSeat, tileId, options: chiOptions };
          this.emit({ type: 'awaitChiChoice', seat: chiSeat, discarderSeat, tileId, options: chiOptions });
          return;
        }
        const choice = this.aiChiDecision(chiSeat, tileType, chiOptions);
        if (choice) { this.callChi(chiSeat, discarderSeat, tileId, choice); return; }
      }
      this.afterNoCall(discarderSeat);
    }

    afterNoCall(discarderSeat) {
      this.turnSeat = nextSeat(discarderSeat);
      this.doDrawPhase();
    }

    countInHand(seat, tileType) {
      return this.players[seat].hand.filter(id => MJ.idToType(id) === tileType).length;
    }

    canRon(seat, tileId) {
      const p = this.players[seat];
      const tileType = MJ.idToType(tileId);
      const waits = MJ.getWaits(p.hand, p.melds);
      if (!waits.includes(tileType)) return false;
      if (this.isFuriten(seat, waits)) return false;
      const ctx = this.buildWinContext(seat, tileId, false, {});
      const result = MJ.evaluateWin(ctx);
      return !!result;
    }

    // フリテン判定 (雀魂準拠)
    //  1. 自分の捨て牌に待ち牌が1枚でもある → フリテン
    //  2. 見逃した直後 (同巡内フリテン) → 次の自摸まで
    //  3. リーチ後に一度でもフリテンになったら和了終了まで継続
    isFuriten(seat, waits) {
      const p = this.players[seat];
      if (p.riichiFuriten || p.tempFuriten) return true;
      const w = waits || MJ.getWaits(p.hand, p.melds);
      return p.discards.some(d => w.includes(MJ.idToType(d.tileId)));
    }
    // ロンを見逃した時に呼ぶ
    markMissedRon(seat) {
      const p = this.players[seat];
      p.tempFuriten = true;
      if (p.riichi) p.riichiFuriten = true;
    }

    // ---------------- 途中流局 (雀魂準拠) ----------------
    checkAbortiveDraw() {
      // 四風連打: 最初の4打が全て同じ風牌、かつ鳴きなし
      if (!this.anyCallMade) {
        const firstFour = this.players.map(p => p.discards[0]).filter(Boolean);
        const totalDiscards = this.players.reduce((n, p) => n + p.discards.length, 0);
        if (totalDiscards === 4 && firstFour.length === 4) {
          const types = firstFour.map(d => MJ.idToType(d.tileId));
          if (types.every(t => t >= 27 && t <= 30 && t === types[0])) return '四風連打';
        }
      }
      // 四家立直: 4人全員がリーチ
      if (this.players.every(p => p.riichi)) return '四家立直';
      // 四槓散了: 合計4つの槓が2人以上によって行われた
      if (this.kanCount >= 4 && new Set(this.kanSeats).size >= 2) return '四槓散了';
      return null;
    }

    abortiveDraw(reason, seat) {
      this.handEnded = true;
      this.round.dealerContinues = true; // 途中流局は親流れなし (連荘)
      this.round.lastHandReason = 'abortive';
      const who = seat !== undefined ? this.players[seat].name : '';
      this.say(`--- 途中流局: ${reason}${who ? ' (' + who + ')' : ''} ---`);
      this.emit({ type: 'handEnd', reason: 'abortive', abortReason: reason, seat, players: this.playersPublicView() });
    }

    buildWinContext(seat, winTileId, isTsumo, extra) {
      const p = this.players[seat];
      const handIds = isTsumo ? p.hand.slice() : p.hand.concat([winTileId]);
      return Object.assign({
        handIds, openMelds: p.melds, winTileId, isTsumo,
        seatWindType: 27 + p.seatWind, roundWindType: this.round.roundWind,
        riichi: p.riichi && !p.doubleRiichi, doubleRiichi: p.doubleRiichi,
        ippatsu: p.ippatsuEligible && (p.riichi || p.doubleRiichi),
        isHaitei: false, isHoutei: false, isRinshan: false, isChankan: false,
        doraIndicatorTypes: this.doraIndicatorTypes(),
        uraDoraIndicatorTypes: this.uraDoraIndicatorTypes(),
        isDealer: p.isDealer
      }, extra);
    }

    // ---------------- 和了確定処理 ----------------
    resolveTsumo(seat, tileId, result) {
      const isHoutei = this.wallPos >= this.wall.length;
      const ctx = this.buildWinContext(seat, tileId, true, { isHaitei: isHoutei, isRinshan: !!this.lastWasKanDraw });
      const finalResult = MJ.evaluateWin(ctx) || result;
      this.settleWin([{ seat, result: finalResult, tileId, isTsumo: true }], null);
    }
    resolveRon(discarderSeat, tileId, ronSeats, isChankan) {
      const isHoutei = this.wallPos >= this.wall.length;
      const winners = ronSeats.map(seat => {
        const ctx = this.buildWinContext(seat, tileId, false, { isHoutei, isChankan: !!isChankan });
        return { seat, result: MJ.evaluateWin(ctx), tileId, isTsumo: false };
      });
      this.settleWin(winners, discarderSeat);
    }

    settleWin(winners, discarderSeat) {
      this.handEnded = true;
      const dealerContinues = winners.some(w => this.players[w.seat].isDealer);
      const sticks = this.round.riichiSticks; this.round.riichiSticks = 0;
      const honba = this.round.honba;

      winners.forEach((w, wi) => {
        const p = this.players[w.seat];
        const r = w.result;
        let gained = 0;
        if (w.isTsumo) {
          const pts = r.points;
          if (pts.kind === 'tsumo-dealer') {
            [1, 2, 3].forEach(d => { const os = (w.seat + d) % 4; this.players[os].score -= pts.each + honba * 100; });
            gained = pts.total + honba * 300;
          } else {
            [1, 2, 3].forEach(d => {
              const os = (w.seat + d) % 4;
              const amt = this.players[os].isDealer ? pts.fromDealer : pts.fromNonDealer;
              this.players[os].score -= amt + honba * 100;
            });
            gained = pts.total + honba * 300;
          }
        } else {
          const amt = r.points.total + honba * 300;
          this.players[discarderSeat].score -= amt;
          gained = amt;
        }
        const sticksBonus = (wi === 0 ? sticks * 1000 : 0);
        p.score += gained + sticksBonus;
        // handEnd の winners からも参照するので勝者オブジェクトに残す
        w.gained = gained;
        w.sticksBonus = sticksBonus;
        this.emit({ type: 'win', seat: w.seat, result: r, tileId: w.tileId, isTsumo: w.isTsumo, discarderSeat, gained });
        this.say(`${p.name} ${w.isTsumo ? 'ツモ' : 'ロン'}！ ${r.yaku.map(y => y.name + (y.han ? y.han + '翻' : '')).join('・')} ${r.fu}符${r.han}翻 ${gained}点`);
      });

      this.round.dealerContinues = dealerContinues;
      this.round.lastHandReason = 'win';
      this.emit({ type: 'handEnd', reason: 'win', winners, players: this.playersPublicView() });
    }

    // 流し満貫: 自分の捨て牌が全て么九牌で、1枚も鳴かれていない
    nagashiSeats() {
      return this.players.filter(p =>
        p.discards.length > 0 &&
        !p.anyDiscardCalled &&
        p.discards.every(d => MJ.isTerminalOrHonor(MJ.idToType(d.tileId)))
      ).map(p => p.seat);
    }

    exhaustiveDraw() {
      this.handEnded = true;
      const tenpaiSeats = this.players.filter(p => MJ.isTenpai(p.hand, p.melds)).map(p => p.seat);
      const notenSeats = this.players.filter(p => !MJ.isTenpai(p.hand, p.melds)).map(p => p.seat);
      const nagashi = this.nagashiSeats();

      if (nagashi.length > 0) {
        // 流し満貫はテンパイ料に代えて満貫のツモ和了として支払われる
        nagashi.forEach(s => {
          const w = this.players[s];
          if (w.isDealer) {
            [1, 2, 3].forEach(d => { this.players[(s + d) % 4].score -= 4000; });
            w.score += 12000;
          } else {
            [1, 2, 3].forEach(d => {
              const os = (s + d) % 4;
              const amt = this.players[os].isDealer ? 4000 : 2000;
              this.players[os].score -= amt;
            });
            w.score += 8000;
          }
          this.say(`${w.name} 流し満貫！`);
        });
      } else if (tenpaiSeats.length > 0 && tenpaiSeats.length < 4) {
        const gain = Math.floor(3000 / tenpaiSeats.length);
        const lose = Math.floor(3000 / notenSeats.length);
        tenpaiSeats.forEach(s => this.players[s].score += gain);
        notenSeats.forEach(s => this.players[s].score -= lose);
      }

      this.round.dealerContinues = tenpaiSeats.includes(this.round.dealerSeat);
      this.round.lastHandReason = 'draw';
      this.say(`--- 流局 (テンパイ: ${tenpaiSeats.map(s => this.players[s].name).join('、') || 'なし'}) ---`);
      this.emit({ type: 'handEnd', reason: 'draw', tenpaiSeats, nagashiSeats: nagashi, players: this.playersPublicView() });
    }

    // ---------------- 局送り ----------------
    nextHand() {
      // 東1局のみモードは1局で終了 (連荘もしない)
      if (this.opts.mode === 'east1') { this.endGame(); return; }

      if (this.round.dealerContinues) {
        this.round.honba += 1;
      } else {
        this.round.dealerSeat = nextSeat(this.round.dealerSeat);
        this.round.honba = (this.round.lastHandReason === 'win') ? 0 : this.round.honba + 1;
        this.round.roundNumber += 1;
        if (this.round.roundNumber > 4) {
          this.round.roundWind += 1;
          this.round.roundNumber = 1;
        }
      }

      // 終了判定 (雀魂準拠)
      //  ・誰かが飛んだ(0点未満)ら即終了
      //  ・規定の最終局(東風戦=東4/半荘戦=南4)を終えて誰かが3万点以上なら終了
      //  ・3万点未満なら延長戦(南入/西入)。延長戦は誰かが3万点に到達した時点で終了。
      const w = this.round.roundWind - 27;
      const maxScore = Math.max(...this.players.map(p => p.score));
      if (this.players.some(p => p.score < 0)) { this.endGame(); return; }
      if (w > this.endWind) {
        if (maxScore >= this.RETURN_SCORE) { this.endGame(); return; }
        if (w > this.endWind + 1) { this.endGame(); return; } // 延長戦も終わったら強制終了
      }
      this.startHand();
    }

    endGame() {
      this.gameOver = true;
      this.emit({ type: 'gameEnd', players: this.playersPublicView(), standings: this.finalStandings() });
    }

    // 最終順位: 25000点持ち30000点返し + ウマ(+15/+5/-5/-15)。同点は起家に近い席が上位。
    // オカ((30000-25000)*4 = 20pt)は1位が総取りする。これで全員の合計がちょうど0になる。
    finalStandings() {
      const oka = (this.RETURN_SCORE - 25000) * 4 / 1000;
      const ranked = this.players.slice().sort((a, b) => (b.score - a.score) || (a.seat - b.seat));
      return ranked.map((p, i) => ({
        rank: i + 1, seat: p.seat, name: p.name, score: p.score,
        result: Math.round(((p.score - this.RETURN_SCORE) / 1000 + this.UMA[i] + (i === 0 ? oka : 0)) * 10) / 10
      }));
    }

    // ---------------- 副露 (呼び出しから) ----------------
    callChi(seat, discarderSeat, tileId, pairTypes) {
      const p = this.players[seat];
      const ids = pairTypes.map(t => {
        const id = p.hand.find(x => MJ.idToType(x) === t);
        if (id === undefined) throw new Error('callChi: tile not found. seat=' + seat + ' pairTypes=' + JSON.stringify(pairTypes) + ' hand=' + JSON.stringify(p.hand.map(MJ.idToType)) + ' pending=' + JSON.stringify(this.pending));
        return id;
      });
      ids.forEach(id => p.hand.splice(p.hand.indexOf(id), 1));
      const calledType = MJ.idToType(tileId);
      const meldTypes = [calledType].concat(pairTypes);
      p.melds.push({ kind: 'chi', tiles: [tileId, ...ids].sort((a, b) => MJ.idToType(a) - MJ.idToType(b)), from: discarderSeat });
      p.kuikaeForbidden = this.kuikaeTypesFor('chi', calledType, meldTypes);
      this.afterCall(seat, discarderSeat);
    }
    callPon(seat, discarderSeat, tileId) {
      const p = this.players[seat];
      const t = MJ.idToType(tileId);
      const ids = p.hand.filter(x => MJ.idToType(x) === t).slice(0, 2);
      ids.forEach(id => p.hand.splice(p.hand.indexOf(id), 1));
      p.melds.push({ kind: 'pon', tiles: [tileId, ...ids], from: discarderSeat });
      p.kuikaeForbidden = this.kuikaeTypesFor('pon', t, [t, t, t]);
      this.afterCall(seat, discarderSeat);
    }
    callKan(seat, discarderSeat, tileId) {
      const p = this.players[seat];
      const t = MJ.idToType(tileId);
      const ids = p.hand.filter(x => MJ.idToType(x) === t).slice(0, 3);
      ids.forEach(id => p.hand.splice(p.hand.indexOf(id), 1));
      p.melds.push({ kind: 'minkan', tiles: [tileId, ...ids], from: discarderSeat });
      this.afterCall(seat, discarderSeat, true);
    }
    afterCall(seat, discarderSeat, isKan) {
      this.anyCallMade = true;
      // 鳴きが入ると全員の一発が消える
      this.players.forEach(pl => { pl.ippatsuEligible = false; });
      // 流し満貫判定用: 捨て牌を鳴かれた人を記録
      if (discarderSeat !== seat) this.players[discarderSeat].anyDiscardCalled = true;
      const p = this.players[seat];
      this.emit({ type: 'call', seat, discarderSeat, melds: p.melds, isKan: !!isKan });
      this.turnSeat = seat;
      if (isKan) { this.drawRinshan(seat, false); return; }
      this.requestDiscard(seat);
    }

    // ---------------- 暗槓・加槓 ----------------
    ankanOptions(seat) {
      const p = this.players[seat];
      const counts = MJ.countsFromIds(p.hand);
      const opts = [];
      for (let t = 0; t < 34; t++) if (counts[t] === 4) opts.push({ kind: 'ankan', t });
      return opts;
    }
    kakanOptions(seat) {
      const p = this.players[seat];
      const opts = [];
      p.melds.forEach((m, mi) => {
        if (m.kind !== 'pon') return;
        const t = MJ.idToType(m.tiles[0]);
        if (p.hand.some(id => MJ.idToType(id) === t)) opts.push({ kind: 'kakan', t, meldIndex: mi });
      });
      return opts;
    }
    performSelfKan(seat, choice) {
      const p = this.players[seat];
      // 槓が入ると全員の一発が消える
      this.players.forEach(pl => { pl.ippatsuEligible = false; });
      if (choice.kind === 'ankan') {
        const ids = p.hand.filter(id => MJ.idToType(id) === choice.t);
        ids.forEach(id => p.hand.splice(p.hand.indexOf(id), 1));
        p.melds.push({ kind: 'ankan', tiles: ids });
        this.emit({ type: 'call', seat, discarderSeat: seat, melds: p.melds, isKan: true, ankan: true });
        this.drawRinshan(seat, true);
      } else {
        const id = p.hand.find(x => MJ.idToType(x) === choice.t);
        p.hand.splice(p.hand.indexOf(id), 1);
        const meld = p.melds[choice.meldIndex];
        // チャンカン判定: 他家がこの牌でロン可能か
        const others = [1, 2, 3].map(d => (seat + d) % 4);
        const chankanSeats = others.filter(s => this.canRon(s, id));
        if (chankanSeats.length > 0) {
          this.resolveRon(seat, id, [chankanSeats[0]], true);
          return;
        }
        meld.kind = 'kakan';
        meld.tiles.push(id);
        this.emit({ type: 'call', seat, discarderSeat: seat, melds: p.melds, isKan: true, kakan: true });
        this.drawRinshan(seat, false);
      }
    }

    // isAnkan: 暗槓は即座に新ドラをめくる。明槓/加槓は打牌後にめくる (雀魂準拠)
    drawRinshan(seat, isAnkan) {
      this.kanCount++;
      this.kanSeats.push(seat);
      if (this.kanCount <= 4) {
        if (isAnkan) this.doraRevealed = Math.min(5, this.doraRevealed + 1);
        else this.pendingKanDora++;
      }
      const tileId = this.deadWall[this.rinshanIdx++];
      const p = this.players[seat];
      p.hand.push(tileId);
      this.lastWasKanDraw = true;
      this.emit({ type: 'rinshanDraw', seat, tileId });
      // 嶺上開花で和了る場合は明槓の新ドラも先にめくってから計算する
      if (this.pendingKanDora > 0) {
        const peek = Math.min(5, this.doraRevealed + this.pendingKanDora);
        const saved = this.doraRevealed;
        this.doraRevealed = peek;
        const testCtx = this.buildWinContext(seat, tileId, true, { isRinshan: true });
        if (!MJ.evaluateWin(testCtx)) this.doraRevealed = saved;
        else this.pendingKanDora = 0;
      }
      const ctx = this.buildWinContext(seat, tileId, true, { isRinshan: true });
      const result = MJ.evaluateWin(ctx);
      if (result) {
        if (p.isHuman) { this.pending = { type: 'tsumoChoice', seat, tileId, result, rinshan: true }; this.emit({ type: 'awaitTsumoChoice', seat, result }); return; }
        this.resolveTsumo(seat, tileId, result);
        return;
      }
      this.lastWasKanDraw = false;
      const kanOptions = this.ankanOptions(seat).concat(this.kakanOptions(seat)).filter(o => true);
      if (kanOptions.length > 0) {
        this.pending = { type: 'kanOrDiscard', seat, tileId, kanOptions };
        if (p.isHuman) { this.emit({ type: 'awaitKanOrDiscard', seat, kanOptions, tileId }); return; }
        const choice = this.aiChooseAnkan(seat, kanOptions);
        if (choice) { this.performSelfKan(seat, choice); return; }
      }
      this.requestDiscard(seat);
    }

    // ---------------- 人間からの応答 API ----------------
    humanDiscard(tileId, declareRiichi) { this.discard(this.humanSeat(), tileId, declareRiichi); }
    humanSkipKanOrDiscard() { this.requestDiscard(this.humanSeat()); }
    humanChooseKan(choice) { this.performSelfKan(this.humanSeat(), choice); }
    humanChooseTsumo() {
      const { seat, tileId, result } = this.pending;
      this.resolveTsumo(seat, tileId, result);
    }
    humanSkipTsumo() {
      const { seat } = this.pending;
      const kanOptions = this.ankanOptions(seat).concat(this.kakanOptions(seat));
      if (kanOptions.length > 0) { this.pending = { type: 'kanOrDiscard', seat, kanOptions }; this.emit({ type: 'awaitKanOrDiscard', seat, kanOptions }); return; }
      this.requestDiscard(seat);
    }
    humanChooseRon() { const { discarderSeat, tileId, ronSeats } = this.pending; this.resolveRon(discarderSeat, tileId, ronSeats); }
    humanSkipRon() {
      // 見逃し = 同巡内フリテン (リーチ中なら和了終了までフリテン継続)
      const { discarderSeat } = this.pending;
      this.markMissedRon(this.humanSeat());
      const abort = this.checkAbortiveDraw();
      if (abort) { this.abortiveDraw(abort, discarderSeat); return; }
      this.afterNoCall(discarderSeat);
    }
    humanDeclareKyuushu() { const { seat } = this.pending; this.abortiveDraw('九種九牌', seat); }
    humanSkipKyuushu() {
      const { seat } = this.pending;
      const kanOptions = this.ankanOptions(seat).concat(this.kakanOptions(seat));
      if (kanOptions.length > 0) {
        this.pending = { type: 'kanOrDiscard', seat, kanOptions };
        this.emit({ type: 'awaitKanOrDiscard', seat, kanOptions });
        return;
      }
      this.requestDiscard(seat);
    }
    humanCallPon() { const { seat, discarderSeat, tileId } = this.pending; this.callPon(seat, discarderSeat, tileId); }
    humanCallKan() { const { seat, discarderSeat, tileId } = this.pending; this.callKan(seat, discarderSeat, tileId); }
    humanCallChi(pairTypes) { const { seat, discarderSeat, tileId } = this.pending; this.callChi(seat, discarderSeat, tileId, pairTypes); }
    humanPassCall() { const { discarderSeat } = this.pending; this.afterNoCall(discarderSeat); }

    // ---------------- 進行(局終了後) ----------------
    proceedAfterHand() { this.nextHand(); }

    playersPublicView() {
      return this.players.map(p => ({
        seat: p.seat, name: p.name, score: p.score, riichi: p.riichi,
        handCount: p.hand.length, melds: p.melds, discards: p.discards,
        seatWind: p.seatWind, isDealer: p.isDealer, isHuman: p.isHuman
      }));
    }

    // ================= AI =================
    tileValue(counts, t) {
      if (t >= 27) {
        if (counts[t] >= 3) return 100;
        if (counts[t] === 2) return 45;
        return 6;
      }
      if (counts[t] >= 3) return 100;
      if (counts[t] === 2) return 46;
      const r = t % 9;
      let v = 12;
      if (r > 0 && counts[t - 1] > 0) v += 16;
      if (r < 8 && counts[t + 1] > 0) v += 16;
      if (r > 1 && counts[t - 2] > 0) v += 9;
      if (r < 7 && counts[t + 2] > 0) v += 9;
      v += (4 - Math.abs(r - 4)) * 2;
      return v;
    }

    aiChooseDiscard(seat) {
      const p = this.players[seat];
      const counts = MJ.countsFromIds(p.hand);
      // リーチ後はツモ切りのみ (待ちを変えられない)
      if (p.riichi && this.lastDraw && this.lastDraw.seat === seat && p.hand.includes(this.lastDraw.tileId)) {
        return this.lastDraw.tileId;
      }
      // 食い替え禁止牌は選択肢から除外
      const banned = p.kuikaeForbidden;
      let uniqueTypes = [...new Set(p.hand.map(MJ.idToType))].filter(t => !banned.includes(t));
      if (uniqueTypes.length === 0) uniqueTypes = [...new Set(p.hand.map(MJ.idToType))];
      const dangerTypes = new Set();
      this.players.forEach(op => { if (op.riichi && op.seat !== seat) op.discards.forEach(d => dangerTypes.add(MJ.idToType(d.tileId))); });
      const anyRiichi = this.players.some(op => op.riichi && op.seat !== seat);

      let bestType = uniqueTypes[0], bestScore = -Infinity;
      uniqueTypes.forEach(t => {
        let score = -this.tileValue(counts, t);
        if (anyRiichi && !dangerTypes.has(t)) score -= 60; // 現物以外は危険
        if (anyRiichi && dangerTypes.has(t)) score += 80; // 現物は安全なので優先して切る
        if (score > bestScore) { bestScore = score; bestType = t; }
      });
      const id = p.hand.find(x => MJ.idToType(x) === bestType);
      return id;
    }

    handIsTanyaoSafe(seat) {
      const p = this.players[seat];
      return p.hand.concat(p.melds.reduce((a, m) => a.concat(m.tiles), [])).every(id => MJ.isSimple(MJ.idToType(id)));
    }
    handIsHonitsuPath(seat, extraType) {
      const p = this.players[seat];
      const types = p.hand.concat(p.melds.reduce((a, m) => a.concat(m.tiles), [])).map(MJ.idToType);
      if (extraType !== undefined) types.push(extraType);
      const suits = new Set(types.filter(t => !MJ.isHonor(t)).map(MJ.typeSuit));
      return suits.size <= 1;
    }

    aiWantsRiichi(seat, plannedDiscard) {
      const p = this.players[seat];
      if (p.melds.some(m => m.kind !== 'ankan')) return false;
      if (p.score < 1000) return false;
      const rest = p.hand.filter(id => id !== plannedDiscard);
      return MJ.isTenpai(rest, p.melds);
    }

    aiPonKanDecision(seat, tileType, canPon, canKan) {
      const isYakuhai = tileType >= 31 && tileType <= 33 ||
        tileType === 27 + this.players[seat].seatWind || tileType === this.round.roundWind;
      const honitsuOk = this.handIsHonitsuPath(seat, tileType);
      const tanyaoOk = MJ.isSimple(tileType) && this.handIsTanyaoSafe(seat);
      if (isYakuhai) return canKan ? 'kan' : 'pon';
      if (honitsuOk && !MJ.isHonor(tileType)) return canPon ? 'pon' : (canKan ? 'kan' : 'pass');
      if (tanyaoOk) return canPon ? 'pon' : 'pass';
      return 'pass';
    }
    aiChiDecision(seat, tileType, options) {
      if (!(this.handIsTanyaoSafe(seat) && MJ.isSimple(tileType)) && !this.handIsHonitsuPath(seat, tileType)) return null;
      return options[0];
    }
    aiChooseAnkan(seat, options) {
      const p = this.players[seat];
      if (p.riichi) return null; // リーチ後は簡略化して暗槓しない(待ち変化リスク回避)
      return options.length > 0 ? options[0] : null;
    }
  }

  const API = { MahjongGame, SEAT_NAMES, WIND_NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else { root.MahjongGame = MahjongGame; root.SEAT_NAMES = SEAT_NAMES; root.WIND_NAME = WIND_NAME; }
})(typeof window !== 'undefined' ? window : globalThis);
