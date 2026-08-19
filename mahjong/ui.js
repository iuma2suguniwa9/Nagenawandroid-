/* ============================================================
   ui.js — 画面描画とユーザー操作 (DOM)
============================================================ */
(function () {
  'use strict';
  const T = window.MJTiles;
  const WIND_NAME = window.WIND_NAME || ['東', '南', '西', '北'];

  const A = window.MJAssist;

  let game = null;
  let eventQueue = [];
  let processing = false;
  let riichiArmed = false;
  let currentAwait = null; // 直近の await イベント
  let resultQueue = []; // handEnd/gameEnd を溜めて順に表示
  let assistOn = true;   // アシスト機能のON/OFF
  let lastAnalysis = null; // 今の手番の解析結果 (手牌のハイライトにも使う)

  const $ = sel => document.querySelector(sel);
  const el = (cls, html) => { const e = document.createElement('div'); e.className = cls || ''; if (html !== undefined) e.innerHTML = html; return e; };

  // ---------------- 画面切り替え ----------------
  function showScreen(name) {
    $('#start-screen').style.display = name === 'start' ? 'block' : 'none';
    $('#game-screen').classList.toggle('on', name === 'game');
  }

  let selectedMode = 'tonpuu';
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('on'));
      card.classList.add('on');
      selectedMode = card.dataset.mode;
    });
  });
  $('#btn-start').addEventListener('click', () => {
    assistOn = $('#opt-assist').checked;
    startGame(selectedMode);
  });
  $('#btn-restart').addEventListener('click', () => { closeModal(); showScreen('start'); });
  $('#btn-assist').addEventListener('click', () => {
    assistOn = !assistOn;
    $('#btn-assist').textContent = assistOn ? 'アシストON' : 'アシストOFF';
    $('#btn-assist').classList.toggle('off', !assistOn);
    renderAssist();
    renderAll();
  });

  function startGame(mode) {
    game = new MahjongGame({ mode, humanSeat: 0 });
    eventQueue = []; processing = false; riichiArmed = false; currentAwait = null;
    lastAnalysis = null;
    $('#btn-assist').textContent = assistOn ? 'アシストON' : 'アシストOFF';
    $('#btn-assist').classList.toggle('off', !assistOn);
    game.on(evt => { eventQueue.push(evt); if (!processing) processQueue(); });
    $('#log-panel').innerHTML = '';
    showScreen('game');
    game.startHand();
  }

  // ---------------- イベントキュー ----------------
  function delayFor(evt) {
    switch (evt.type) {
      case 'draw': return 260;
      case 'discard': return 420;
      case 'call': return 520;
      case 'rinshanDraw': return 260;
      default: return 0;
    }
  }
  function processQueue() {
    if (eventQueue.length === 0) { processing = false; return; }
    processing = true;
    const evt = eventQueue.shift();
    handleEvent(evt);
    if (evt.type.indexOf('await') === 0) { processing = false; return; }
    setTimeout(processQueue, delayFor(evt));
  }

  function appendLog(msg) {
    const p = document.createElement('div');
    p.textContent = msg;
    $('#log-panel').appendChild(p);
    $('#log-panel').scrollTop = $('#log-panel').scrollHeight;
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case 'log': appendLog(evt.message); return;
      case 'handStart':
        riichiArmed = false; currentAwait = null; lastAnalysis = null;
        renderAll(); renderAssist(); setActionBar([]); return;
      case 'draw': case 'discard': case 'call': case 'rinshanDraw':
        renderAll(); return;
      case 'win':
        return; // handEnd でまとめて表示
      case 'handEnd':
        renderAll();
        resultQueue.push({ kind: 'handEnd', evt });
        maybeShowNextResult();
        return;
      case 'gameEnd':
        resultQueue.push({ kind: 'gameEnd', evt });
        maybeShowNextResult();
        return;
      case 'awaitDiscard':
        currentAwait = evt; computeAssist(); renderAll(); renderAssist();
        setActionBarForDiscard(evt); return;
      case 'awaitTsumoChoice':
        currentAwait = evt; renderAll(); showTsumoModal(evt); return;
      case 'awaitRonChoice':
        currentAwait = evt; renderAll(); showRonModal(evt); return;
      case 'awaitKanOrDiscard':
        currentAwait = evt; renderAll(); setActionBarForKan(evt); return;
      case 'awaitPonKanChoice':
        currentAwait = evt; renderAll(); setActionBarForPonKan(evt); return;
      case 'awaitChiChoice':
        currentAwait = evt; renderAll(); setActionBarForChi(evt); return;
      case 'awaitKyuushuChoice':
        currentAwait = evt; renderAll(); showKyuushuModal(evt); return;
    }
  }

  function showKyuushuModal(evt) {
    openModal(`<div class="modal-box"><h3 class="serif">九種九牌</h3>
      <p>1・9・字牌が${evt.kinds}種類あります。<br>この局を流して(途中流局)やり直せます。</p>
      <p style="font-size:12px;color:#666;margin-top:8px">流すと親は連荘（親のまま次の局へ）になります。</p>
      <button class="big-btn" id="btn-kyuushu-yes">流局にする</button>
      <button class="big-btn" id="btn-kyuushu-no" style="background:#ccc;box-shadow:0 3px 0 #999;color:#333">続ける</button></div>`);
    $('#btn-kyuushu-yes').addEventListener('click', () => { closeModal(); game.humanDeclareKyuushu(); });
    $('#btn-kyuushu-no').addEventListener('click', () => { closeModal(); game.humanSkipKyuushu(); });
  }

  // ---------------- 結果モーダル（連続表示） ----------------
  let modalBusy = false;
  function maybeShowNextResult() {
    if (modalBusy || resultQueue.length === 0) return;
    const item = resultQueue.shift();
    modalBusy = true;
    if (item.kind === 'handEnd') showHandEndModal(item.evt);
    else showGameEndModal(item.evt);
  }

  function closeModal() {
    $('#modal-overlay').classList.remove('on');
    $('#modal-overlay').innerHTML = '';
    modalBusy = false;
  }
  function openModal(html) {
    $('#modal-overlay').innerHTML = html;
    $('#modal-overlay').classList.add('on');
  }

  function showHandEndModal(evt) {
    let body = '';
    if (evt.reason === 'win') {
      body = evt.winners.map(w => {
        const p = game.player(w.seat);
        const r = w.result;
        const yakuLines = r.yaku.map(y => `<div class="yaku-line"><span>${y.name}</span><span>${y.han}翻</span></div>`).join('');
        return `<h3 class="serif">${p.name} ${w.isTsumo ? 'ツモ和了' : 'ロン和了'}</h3>
          <div class="hand-preview">${w_handPreview(w)}</div>
          ${yakuLines}
          <div class="yaku-line"><span>ドラ</span><span>${r.doraHan + r.akaHan}</span></div>
          ${(r.uraHan > 0) ? `<div class="yaku-line"><span>裏ドラ</span><span>${r.uraHan}</span></div>` : ''}
          <div class="score-big">${r.han}翻${r.fu}符 ${w.gained}点</div>`;
      }).join('<hr style="margin:12px 0;border:none;border-top:1px dashed #cbb;">');
    } else if (evt.reason === 'abortive') {
      const rows = game.players.map(p =>
        `<tr><td>${p.name}${p.isDealer ? '(親)' : ''}</td><td>${p.score}点</td></tr>`).join('');
      body = `<h3 class="serif">途中流局</h3>
        <p style="font-size:14px;margin-bottom:6px"><b>${evt.abortReason}</b></p>
        <p style="font-size:12px;color:#666">この局は無効になり、親は連荘です。</p>
        <table>${rows}</table>`;
    } else {
      const nagashi = evt.nagashiSeats || [];
      const rows = game.players.map(p => {
        const tp = evt.tenpaiSeats.includes(p.seat);
        const state = nagashi.includes(p.seat) ? '<b style="color:#c43a2f">流し満貫</b>' : (tp ? 'テンパイ' : 'ノーテン');
        return `<tr><td>${p.name}${p.isDealer ? '(親)' : ''}</td><td>${state}</td><td>${p.score}点</td></tr>`;
      }).join('');
      body = `<h3 class="serif">流局</h3>${nagashi.length ? '<p style="font-size:13px;color:#c43a2f">流し満貫が成立しました！</p>' : ''}<table>${rows}</table>`;
    }
    openModal(`<div class="modal-box">${body}
      <button class="big-btn" id="btn-next-hand">${game.gameOver ? '結果を見る' : '次の局へ'}</button>
    </div>`);
    $('#btn-next-hand').addEventListener('click', () => {
      closeModal();
      game.proceedAfterHand();
      maybeShowNextResult();
    });
  }

  function w_handPreview(w) {
    const p = game.player(w.seat);
    const concealed = w.isTsumo ? p.hand.slice() : p.hand.concat([w.tileId]);
    const types = concealed.map(id => ({ id, t: MJ.idToType(id) })).sort((a, b) => a.t - b.t);
    let html = types.map(x => T.tileHTML(x.t, { small: true, red: MJ.isRedFive(x.id), selected: x.id === w.tileId })).join('');
    p.melds.forEach(m => {
      html += '<span style="width:6px;display:inline-block"></span>';
      html += m.tiles.map(id => T.tileHTML(MJ.idToType(id), { small: true, red: MJ.isRedFive(id) })).join('');
    });
    return html;
  }

  function showGameEndModal(evt) {
    const st = evt.standings || evt.players.slice().sort((a, b) => b.score - a.score)
      .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, result: null }));
    const rows = st.map(p => {
      const res = p.result === null ? '' :
        `<td class="score-delta ${p.result >= 0 ? 'plus' : 'minus'}">${p.result > 0 ? '+' : ''}${p.result.toFixed(1)}</td>`;
      return `<tr><td>${p.rank}位</td><td>${p.name}</td><td>${p.score}点</td>${res}</tr>`;
    }).join('');
    openModal(`<div class="modal-box"><h3 class="serif">対局終了</h3>
      <table>${rows}</table>
      <p style="font-size:11.5px;color:#777;margin-top:8px">25000点持ち30000点返し／ウマ +15/+5/-5/-15</p>
      <button class="big-btn" id="btn-finish">スタート画面へ</button></div>`);
    $('#btn-finish').addEventListener('click', () => { closeModal(); showScreen('start'); });
  }

  function showTsumoModal(evt) {
    const r = evt.result;
    const yakuLines = r.yaku.map(y => `<div class="yaku-line"><span>${y.name}</span><span>${y.han}翻</span></div>`).join('');
    openModal(`<div class="modal-box"><h3 class="serif">ツモ！</h3>${yakuLines}
      <div class="score-big">${r.han}翻${r.fu}符</div>
      <button class="big-btn" id="btn-tsumo-yes">ツモ和了する</button>
      <button class="big-btn" id="btn-tsumo-no" style="background:#ccc;box-shadow:0 3px 0 #999;color:#333">見送る</button></div>`);
    $('#btn-tsumo-yes').addEventListener('click', () => { closeModal(); game.humanChooseTsumo(); });
    $('#btn-tsumo-no').addEventListener('click', () => { closeModal(); game.humanSkipTsumo(); });
  }
  function showRonModal(evt) {
    openModal(`<div class="modal-box"><h3 class="serif">ロン！</h3>
      <p>この牌で和了できます。</p>
      <button class="big-btn" id="btn-ron-yes">ロンする</button>
      <button class="big-btn" id="btn-ron-no" style="background:#ccc;box-shadow:0 3px 0 #999;color:#333">見送る</button></div>`);
    $('#btn-ron-yes').addEventListener('click', () => { closeModal(); game.humanChooseRon(); });
    $('#btn-ron-no').addEventListener('click', () => { closeModal(); game.humanSkipRon(); });
  }

  // ---------------- アシスト表示 ----------------
  function computeAssist() {
    if (!game || !assistOn) { lastAnalysis = null; return; }
    try { lastAnalysis = A.analyze(game, 0); }
    catch (e) { lastAnalysis = null; }
  }

  function miniTiles(list, max) {
    return list.slice(0, max || 8).map(w =>
      `<span class="assist-tile">${T.tileHTML(w.type, { small: true })}<small>${w.left}</small></span>`
    ).join('');
  }

  function renderAssist() {
    const box = $('#assist-panel');
    if (!game || !assistOn || !lastAnalysis) { box.innerHTML = ''; return; }
    const a = lastAnalysis;
    const rows = [];

    // 手の進み具合 + 待ち
    if (a.waits && a.waits.length > 0) {
      rows.push(`<div class="assist-row">
        <span class="assist-tag hot">テンパイ</span>
        <span class="assist-note">待ち</span>${miniTiles(a.waits)}
        ${a.furiten ? '<span class="assist-tag warn">フリテン(ロンできません)</span>' : ''}
      </div>`);
    } else if (a.shanten !== null && a.shanten >= 0) {
      rows.push(`<div class="assist-row">
        <span class="assist-tag">${A.shantenLabel(a.shanten)}</span>
        <span class="assist-note">あと${a.shanten}枚そろえばテンパイです</span>
      </div>`);
    }

    // おすすめの打牌
    if (a.candidates && a.candidates.length > 0) {
      const best = a.candidates[0];
      rows.push(`<div class="assist-row assist-rec">
        <span class="assist-tag hot">おすすめ</span>
        <span class="assist-tile">${T.tileHTML(best.type, { small: true })}</span>
        <span class="best">${best.label}切り</span>
        <span class="assist-note">→ ${A.shantenLabel(best.shanten)} / 受け入れ${best.ukeire}枚</span>
      </div>`);
    }

    // 狙える役
    if (a.yaku && a.yaku.length > 0) {
      const items = a.yaku.slice(0, 3).map(y =>
        `<div class="${y.ok ? 'done' : ''}"><b>${y.name}(${y.han})</b> … ${y.note}</div>`
      ).join('');
      rows.push(`<div class="assist-row"><span class="assist-tag">狙える役</span></div>
        <div class="assist-yaku">${items}</div>`);
    }

    box.innerHTML = `<div class="assist-box">${rows.join('')}</div>`;
  }

  // ---------------- アクションバー ----------------
  // 人間の操作でゲームを進める関数を呼ぶ前には必ずこれでボタンを即座に消す。
  // (NPCのアニメーション待ち中に古いボタンが残って二重クリックされる事故を防ぐ)
  function commit(fn) {
    return () => { setActionBar([]); currentAwait = null; fn(); };
  }
  function setActionBar(buttons) {
    const bar = $('#action-bar');
    bar.innerHTML = '';
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.cls) btn.className = b.cls;
      btn.addEventListener('click', b.onClick);
      bar.appendChild(btn);
    });
  }
  function setActionBarForDiscard(evt) {
    const buttons = [];
    if (evt.canRiichi) {
      buttons.push({ label: riichiArmed ? 'リーチ(解除)' : 'リーチ', cls: riichiArmed ? 'primary toggled' : 'primary', onClick: () => { riichiArmed = !riichiArmed; setActionBarForDiscard(evt); } });
    }
    const kanOptions = game.ankanOptions(0).concat(game.kakanOptions(0));
    if (kanOptions.length > 0 && !riichiArmed) {
      buttons.push({ label: 'カン', onClick: () => { setActionBarForKan({ seat: 0, kanOptions }); } });
    }
    setActionBar(buttons);
  }
  function setActionBarForKan(evt) {
    const buttons = evt.kanOptions.map(opt => ({
      label: (opt.kind === 'ankan' ? '暗槓 ' : '加槓 ') + MJ.typeLabel(opt.t),
      cls: 'primary',
      onClick: commit(() => { closeModal(); game.humanChooseKan(opt); })
    }));
    buttons.push({ label: '打牌へ', onClick: commit(() => game.humanSkipKanOrDiscard()) });
    setActionBar(buttons);
  }
  function setActionBarForPonKan(evt) {
    const buttons = [];
    if (evt.canPon) buttons.push({ label: 'ポン', cls: 'primary', onClick: commit(() => game.humanCallPon()) });
    if (evt.canKan) buttons.push({ label: 'カン', cls: 'primary', onClick: commit(() => game.humanCallKan()) });
    buttons.push({ label: 'パス', onClick: commit(() => game.humanPassCall()) });
    setActionBar(buttons);
  }
  function setActionBarForChi(evt) {
    const bar = $('#action-bar');
    bar.innerHTML = '';
    evt.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'primary';
      const types = opt.slice().sort((a, b) => a - b);
      btn.innerHTML = 'チー ' + types.map(MJ.typeLabel).join('');
      btn.addEventListener('click', commit(() => game.humanCallChi(opt)));
      bar.appendChild(btn);
    });
    const pass = document.createElement('button');
    pass.textContent = 'パス';
    pass.addEventListener('click', commit(() => game.humanPassCall()));
    bar.appendChild(pass);
  }

  // ---------------- 手牌クリック(打牌) ----------------
  document.addEventListener('click', e => {
    const t = e.target.closest('.hand-tile');
    if (!t || !currentAwait || currentAwait.type !== 'awaitDiscard') return;
    const tileId = +t.dataset.id;
    const p = game.player(0);
    if (game.forbiddenDiscards(0).includes(MJ.idToType(tileId))) {
      appendLog('鳴いた直後にその牌は切れません(食い替え禁止)。');
      return;
    }
    if (riichiArmed) {
      const rest = p.hand.filter(id => id !== tileId);
      if (!MJ.isTenpai(rest, p.melds)) {
        appendLog('その牌を切るとテンパイが崩れます。リーチできません。');
        return;
      }
    }
    const armed = riichiArmed;
    riichiArmed = false;
    currentAwait = null;
    lastAnalysis = null;
    setActionBar([]);
    $('#assist-panel').innerHTML = '';
    game.humanDiscard(tileId, armed);
  });

  // ---------------- 描画 ----------------
  function seatEl(seat) { return document.getElementById('seat-' + seat); }
  function riverEl(seat) { return document.getElementById('river-' + seat); }

  function renderAll() {
    if (!game) return;
    const pub = game.playersPublicView();
    const r = game.round;
    $('#roundinfo').textContent = `${WIND_NAME[r.roundWind - 27]}${r.roundNumber}局 ${r.honba}本場` + (r.riichiSticks ? ` (供託${r.riichiSticks})` : '');
    $('#wallcount').textContent = `残り${Math.max(0, game.wall.length - game.wallPos)}枚`;
    $('#dora-area').innerHTML = game.doraIndicatorTypes().map(t => T.tileHTML(t, { small: true })).join('');

    pub.forEach(p => {
      const nameDiv = seatEl(p.seat).querySelector('.nameline');
      nameDiv.className = 'nameline' + (p.riichi ? ' riichi' : '');
      nameDiv.innerHTML = `${p.isDealer ? '<span class="dealer">親</span>' : ''}${p.name} <span class="score">${p.score}</span>`;
      const handDiv = seatEl(p.seat).querySelector('.seat-hand');
      if (p.seat !== 0) {
        handDiv.innerHTML = Array.from({ length: p.handCount }).map(() => T.tileBackHTML({ small: true })).join('');
      }
      const meldDiv = seatEl(p.seat).querySelector('.meld-row');
      meldDiv.innerHTML = p.melds.map(m => meldGroupHTML(m)).join('');

      const rDiv = riverEl(p.seat);
      rDiv.innerHTML = p.discards.map(d => {
        const type = MJ.idToType(d.tileId);
        return T.tileHTML(type, { small: true, red: MJ.isRedFive(d.tileId) }).replace('class="tile', d.riichi ? 'style="transform:rotate(90deg)" class="tile' : 'class="tile');
      }).join('');
    });

    // 自分の手牌
    const me = game.player(0);
    const sorted = me.hand.slice().sort((a, b) => MJ.idToType(a) - MJ.idToType(b));
    const wrap = $('#my-hand');
    // アシストON時は「おすすめ」「危険牌」「食い替えで切れない牌」を色分けする
    const banned = game.forbiddenDiscards ? game.forbiddenDiscards(0) : [];
    const isMyDiscardTurn = currentAwait && currentAwait.type === 'awaitDiscard';
    const recoId = (assistOn && isMyDiscardTurn && lastAnalysis && lastAnalysis.candidates.length)
      ? lastAnalysis.candidates[0].tileId : null;
    const dangerByType = {};
    if (assistOn && isMyDiscardTurn && lastAnalysis) {
      lastAnalysis.candidates.forEach(c => { dangerByType[c.type] = c.danger; });
    }
    wrap.innerHTML = sorted.map(id => {
      const type = MJ.idToType(id);
      const isDrawn = game.lastDraw && game.lastDraw.seat === 0 && game.lastDraw.tileId === id;
      const cls = ['tile', 'hand-tile'];
      if (isDrawn) cls.push('drawn');
      if (banned.includes(type)) cls.push('banned');
      else if (id === recoId) cls.push('reco');
      const dg = dangerByType[type];
      if (dg === 3) cls.push('danger3');
      else if (dg === 2) cls.push('danger2');
      return `<div class="${cls.join(' ')}" data-id="${id}"><svg viewBox="0 0 100 140">${T.tileSVGInner(type, MJ.isRedFive(id))}</svg></div>`;
    }).join('');
    $('#my-melds').innerHTML = me.melds.map(m => meldGroupHTML(m)).join('');
  }

  function meldGroupHTML(m) {
    const tiles = m.tiles.map(id => {
      const concealedBack = (m.kind === 'ankan' && (id === m.tiles[0] || id === m.tiles[3]));
      return concealedBack ? T.tileBackHTML({ small: true }) : T.tileHTML(MJ.idToType(id), { small: true, red: MJ.isRedFive(id) });
    }).join('');
    return `<div class="meld-group">${tiles}</div>`;
  }

  // 初期スケルトン生成
  function buildSeats() {
    const table = $('#table');
    const layout = { 0: 'seat-bottom', 1: 'seat-right', 2: 'seat-top', 3: 'seat-left' };
    [0, 1, 2, 3].forEach(seat => {
      const s = el('seat ' + layout[seat]);
      s.id = 'seat-' + seat;
      s.innerHTML = `<div class="nameline"></div><div class="seat-hand"></div><div class="meld-row"></div>`;
      table.appendChild(s);
    });
    const riverLayout = { 0: 'river river-bottom', 1: 'river river-right', 2: 'river river-top', 3: 'river river-left' };
    [0, 1, 2, 3].forEach(seat => {
      const rdiv = el(riverLayout[seat]);
      rdiv.id = 'river-' + seat;
      table.appendChild(rdiv);
    });
    const center = el('center-info');
    center.id = 'center-info';
    center.innerHTML = `<div id="roundinfo"></div><div class="dora" id="dora-area"></div><div class="wallcount" id="wallcount"></div>`;
    table.appendChild(center);
  }
  buildSeats();
})();
