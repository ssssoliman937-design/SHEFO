// UI controller for the Auction ("المزاد") game. Loaded after
// public/js/firebase-engine.js and public/mazad/js/auction-engine.js, reuses
// their globals (db, esc, PLAYER_DATABASE, POSITIONS_CLASSIC/FULL,
// POSITION_NAMES_AR, basePositionKey, AuctionEngine) without redeclaring them.

let reloadingForUpdate = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    reg.update();
  }).catch(err => console.log('SW Registration error:', err));
}

document.addEventListener('DOMContentLoaded', () => {

  let myRole = 'spectator';
  let myPlayerName = 'لاعب';
  let roomState = null;
  let currentRoomId = null;
  let matchSummaryShown = false;
  let lastRenderedRoundKey = null;
  let chatPanelOpen = false;
  let lastRenderedChatCount = 0;
  let mazadPeekActive = false; // admin-eye peek state, resets each round - see isAdminPlayer()
  let lastPeekRoundKey = null;

  // Same real-account check as the deal game (public/js/app.js) - see the
  // comment there for why this isn't a typed-name check.
  function isAdminPlayer() {
    return typeof UserProfileManager !== 'undefined' && UserProfileManager.isAdmin && UserProfileManager.isAdmin();
  }

  setTimeout(() => {
    const loader = document.getElementById('app-loading-screen');
    if (loader) loader.classList.add('fade-out');
  }, 400);

  // Auth/Profile/Leaderboard - entirely optional, same as /deal/. Only
  // shows sign-in/leaderboard UI once FIREBASE_AUTH_ENABLED flips true
  // (real Firebase Auth keys, not the placeholder ones).
  if (typeof AuthManager !== 'undefined') {
    AuthManager.init();
    if (typeof UserProfileManager !== 'undefined') UserProfileManager.init();
  }
  if (typeof LeaderboardManager !== 'undefined') LeaderboardManager.init();
  if (window.FIREBASE_AUTH_ENABLED) {
    document.querySelectorAll('.auth-signed-out').forEach(el => el.classList.remove('hidden'));
    const btnLeaderboardEl = document.getElementById('btn-leaderboard');
    if (btnLeaderboardEl) btnLeaderboardEl.classList.remove('hidden');
  }
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    if (typeof AuthManager !== 'undefined') AuthManager.signOut();
  });

  function launchConfetti(durationMs = 3000) {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#ffd700', '#00ff88', '#00d2ff', '#ff3366', '#ffffff'];
    const particles = Array.from({ length: 90 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: Math.random() * 4 + 2,
      vx: Math.random() * 2 - 1,
      rotation: Math.random() * 360,
      rv: Math.random() * 6 - 3
    }));
    const startTime = Date.now();
    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.y += p.vy; p.x += p.vx; p.rotation += p.rv;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      });
      if (Date.now() - startTime < durationMs) requestAnimationFrame(render);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    render();
  }

  function reportPlayerName(name) {
    return String(name || '')
      .replace(/\(.*?\)/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, '')
      .trim();
  }

  function formatMoney(n) {
    return (parseInt(n) || 0).toLocaleString('en-US');
  }

  // DOM refs
  const viewLobby = document.getElementById('view-lobby');
  const viewAuction = document.getElementById('view-auction');
  const viewMatch = document.getElementById('view-simulation');

  const playerNameInput = document.getElementById('player-name-input');
  const createRoomIdInput = document.getElementById('create-room-id');
  const joinRoomIdInput = document.getElementById('join-room-id');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const btnPlayAi = document.getElementById('btn-play-ai');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnSoundToggle = document.getElementById('btn-sound-toggle');

  const roomInfoBar = document.getElementById('room-info-bar');
  const displayRoomId = document.getElementById('display-room-id');
  const userRoleBadge = document.getElementById('user-role-badge');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnCopyInviteLink = document.getElementById('btn-copy-invite-link');
  const notificationBanner = document.getElementById('notification-banner');
  const spectatorBanner = document.getElementById('spectator-banner');

  const btnToggleChat = document.getElementById('btn-toggle-chat');
  const btnCloseChat = document.getElementById('btn-close-chat');
  const chatPanel = document.getElementById('chat-panel');
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatUnreadDot = document.getElementById('chat-unread-dot');

  const aucHostName = document.getElementById('auc-host-name');
  const aucGuestName = document.getElementById('auc-guest-name');
  const aucHostFill = document.getElementById('auc-host-budget-fill');
  const aucGuestFill = document.getElementById('auc-guest-budget-fill');
  const aucHostText = document.getElementById('auc-host-budget-text');
  const aucGuestText = document.getElementById('auc-guest-budget-text');
  const aucWaitingGuest = document.getElementById('auc-waiting-guest');
  const aucRoundResult = document.getElementById('auc-round-result');
  const aucBiddingBlock = document.getElementById('auc-bidding-block');
  const aucRoundLabel = document.getElementById('auc-round-label');
  const aucTurnPill = document.getElementById('auc-turn-pill');
  const aucPlayerRating = document.getElementById('auc-player-rating');
  const aucPlayerName = document.getElementById('auc-player-name');
  const aucPlayerMeta = document.getElementById('auc-player-meta');
  const aucCurrentBid = document.getElementById('auc-current-bid');
  const aucCurrentBidder = document.getElementById('auc-current-bidder');
  const aucBidInput = document.getElementById('auc-bid-input');
  const btnPlaceBid = document.getElementById('btn-place-bid');
  const btnPassBid = document.getElementById('btn-pass-bid');
  const aucMinHint = document.getElementById('auc-min-hint');
  const btnAdminRevealMazad = document.getElementById('btn-admin-reveal-mazad');
  const aucAdminPeek = document.getElementById('auc-admin-peek');
  const aucPeekBonus = document.getElementById('auc-peek-bonus');
  const aucPeekConsolation = document.getElementById('auc-peek-consolation');
  const aucLineupStrip = document.getElementById('mc-lineup-strip');
  const btnToggleRules = document.getElementById('btn-toggle-rules');
  const rulesCollapseBody = document.getElementById('rules-collapse-body');
  const lobbyStage2 = document.getElementById('lobby-stage-2');
  const btnToggleAucLineup = document.getElementById('btn-toggle-auc-lineup');
  const aucLineupCollapseBody = document.getElementById('auc-lineup-collapse-body');

  const simHostName = document.getElementById('sim-host-name');
  const simGuestName = document.getElementById('sim-guest-name');
  const simHostScore = document.getElementById('sim-host-score');
  const simGuestScore = document.getElementById('sim-guest-score');
  const simTimer = document.getElementById('sim-clock');
  const commentaryFeed = document.getElementById('sim-events-list');
  const mcStatusPill = document.getElementById('mc-status-pill');
  const mcStatusText = document.getElementById('mc-status-text');
  const mcSummaryPending = document.getElementById('mc-summary-pending');
  const mcSummaryContent = document.getElementById('mc-summary-content');
  const mcLineupStripFinal = document.getElementById('mc-lineup-strip-final');
  const winnerAnnouncement = document.getElementById('winner-title');
  const finalScoreText = document.getElementById('final-score-display');
  const statHostPos = document.getElementById('stat-host-pos');
  const statGuestPos = document.getElementById('stat-guest-pos');
  const statHostShots = document.getElementById('stat-host-shots');
  const statGuestShots = document.getElementById('stat-guest-shots');
  const statHostOntarget = document.getElementById('stat-host-ontarget');
  const statGuestOntarget = document.getElementById('stat-guest-ontarget');
  const btnRematchHome = document.getElementById('btn-rematch-home');

  document.querySelectorAll('.mc-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => switchMatchTab(tabBtn.dataset.tab));
  });
  function switchMatchTab(target) {
    document.querySelectorAll('.mc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    document.querySelectorAll('.mc-tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `mc-panel-${target}`));
  }

  function showView(viewId) {
    [viewLobby, viewAuction, viewMatch].forEach(view => {
      if (!view) return;
      if (view.id === viewId) { view.classList.remove('hidden'); view.classList.add('active'); }
      else { view.classList.add('hidden'); view.classList.remove('active'); }
    });
  }

  function showNotification(msg) {
    if (!notificationBanner) return;
    notificationBanner.textContent = msg;
    notificationBanner.classList.remove('hidden');
    setTimeout(() => notificationBanner.classList.add('hidden'), 3500);
  }

  function renderLineupStrip(container, squadMode, guestSquad, guestName, hostSquad, hostName) {
    if (!container) return;
    const posKeys = getPositionsForMode(squadMode);
    function buildGroup(teamKey, squad, name) {
      const rows = posKeys.map((key) => {
        const item = squad ? squad[key] : null;
        const label = POSITION_NAMES_AR[key] || key;
        const badge = item
          ? `<div class="rating-badge ${teamKey}">${esc(item.rating)}</div>`
          : `<div class="rating-badge empty">?</div>`;
        const pname = item ? esc(reportPlayerName(item.name)) : '---';
        return `<div class="strip-row${item ? '' : ' empty'}"><span class="pos-chip">${esc(label)}</span>${badge}<span class="pname">${pname}</span></div>`;
      }).join('');
      const teamIcon = teamKey === 'host' ? '👑' : '⚽';
      return `<div class="strip-group ${teamKey}"><div class="strip-head ${teamKey}">${teamIcon} ${esc(name)}</div>${rows}</div>`;
    }
    container.innerHTML =
      buildGroup('guest', guestSquad, guestName) +
      '<div class="strip-mid-line">خط المنتصف</div>' +
      buildGroup('host', hostSquad, hostName);
  }

  const EVENT_TYPE_ICON = { GOAL: '⚽', SAVE: '🧤', MISS: '🥅', CARD: '🟨', VAR: '🖥️' };
  const EVENT_CAPTIONS = {
    GOAL: evt => evt.assist ? `تمريرة حاسمة: ${evt.assist}` : 'هدف من مجهود فردي رائع',
    SAVE: () => 'تصدي رائع يحرم المنافس من هدف محقق',
    MISS: () => 'تسديدة قوية تصطدم بالقائم',
    CARD: () => 'بطاقة صفراء بعد تدخل قوي',
    VAR: () => 'مراجعة الحكم للقطة عبر تقنية الفيديو'
  };
  function eventCaption(evt) {
    const fn = EVENT_CAPTIONS[evt.type];
    return fn ? fn(evt) : String(evt.text || '');
  }

  function renderCommentaryFeed(events, currentMinute) {
    commentaryFeed.innerHTML = '<div class="spine-line"></div>';
    const initEvt = document.createElement('div');
    initEvt.className = 'spine-evt center';
    initEvt.innerHTML = `<div class="spine-chip">🎙️</div><div class="spine-card"><div class="spine-pname">بداية المباراة</div><div class="spine-pcap">صافرة الحكم انطلقت والكرة في الملعب!</div></div>`;
    commentaryFeed.appendChild(initEvt);
    (events || []).forEach(evt => {
      if (evt.minute <= currentMinute) {
        const div = document.createElement('div');
        const typeClass = String(evt.type || '').toLowerCase();
        const sideClass = evt.team === 'guest' ? 'guest' : 'host';
        div.className = `spine-evt ${typeClass} ${sideClass}`;
        const typeIcon = EVENT_TYPE_ICON[evt.type] || '📣';
        const ratingSuffix = evt.rating ? ` (${esc(evt.rating)})` : '';
        div.innerHTML = `<div class="spine-min">${esc(evt.minute)}'</div><div class="spine-chip">${typeIcon}</div><div class="spine-card"><div class="spine-pname">${esc(evt.player || '')}${ratingSuffix}</div><div class="spine-pcap">${esc(eventCaption(evt))}</div></div>`;
        commentaryFeed.appendChild(div);
        if (evt.type === 'GOAL' && evt.minute === currentMinute) {
          window.soundFX?.playCheer();
          document.body.classList.add('flash-goal');
          setTimeout(() => document.body.classList.remove('flash-goal'), 1500);
        }
      }
    });
    commentaryFeed.scrollTop = commentaryFeed.scrollHeight;
  }

  function renderMatchView() {
    simHostName.textContent = roomState.host.name;
    simGuestName.textContent = roomState.guest ? roomState.guest.name : 'الضيف';

    renderLineupStrip(mcLineupStripFinal, roomState.squadMode,
      roomState.guest?.squad, roomState.guest ? roomState.guest.name : 'الضيف',
      roomState.host.squad, roomState.host.name);

    if (!roomState.matchSimulation) return;
    const currentMinute = roomState.matchSimulation.currentTime || 0;
    if (roomState.status === 'finished') {
      simHostScore.textContent = roomState.matchSimulation.hostGoals;
      simGuestScore.textContent = roomState.matchSimulation.guestGoals;
    } else {
      const revealedGoals = (roomState.matchSimulation.events || []).filter(evt => evt.type === 'GOAL' && evt.minute <= currentMinute);
      simHostScore.textContent = revealedGoals.filter(evt => evt.team !== 'guest').length;
      simGuestScore.textContent = revealedGoals.filter(evt => evt.team === 'guest').length;
    }
    simTimer.textContent = `${currentMinute}'`;

    if (currentMinute === 0 && roomState.status !== 'finished') {
      mcStatusPill?.classList.remove('ft');
      if (mcStatusText) mcStatusText.textContent = 'مباشر LIVE';
      mcSummaryPending?.classList.remove('hidden');
      mcSummaryContent?.classList.add('hidden');
      switchMatchTab('events');
    }

    renderCommentaryFeed(roomState.matchSimulation.events, currentMinute);

    if (roomState.status === 'finished' && !matchSummaryShown) {
      matchSummaryShown = true;

      if (myRole !== 'spectator' && typeof UserProfileManager !== 'undefined') {
        let result = 'draw';
        if (myRole === 'host' && roomState.winner === 'host') result = 'win';
        if (myRole === 'host' && roomState.winner === 'guest') result = 'loss';
        if (myRole === 'guest' && roomState.winner === 'guest') result = 'win';
        if (myRole === 'guest' && roomState.winner === 'host') result = 'loss';
        const gameKey = 'mazad_' + (roomState.squadMode === 'full' ? 'full' : 'classic');
        UserProfileManager.recordMatchResult(result, gameKey);
      }

      setTimeout(() => {
        mcStatusPill?.classList.add('ft');
        if (mcStatusText) mcStatusText.textContent = 'انتهت FT';
        mcSummaryPending?.classList.add('hidden');
        mcSummaryContent?.classList.remove('hidden');
        switchMatchTab('summary');

        const sim = roomState.matchSimulation;
        const stats = sim.stats || { possession: [50, 50], shots: [0, 0], shotsOnTarget: [0, 0] };
        finalScoreText.textContent = `${sim.guestGoals} - ${sim.hostGoals}`;
        if (sim.mvpPlayer) {
          const mvpElem = document.getElementById('mvp-player-name');
          if (mvpElem) mvpElem.textContent = `${sim.mvpPlayer.name} (${sim.mvpPlayer.rating || 90})`;
        }
        if (roomState.winner === 'host') {
          winnerAnnouncement.textContent = `👑 فاز ${roomState.host.name} بالمزاد!`;
          if (myRole === 'host') launchConfetti(4000);
        } else if (roomState.winner === 'guest') {
          winnerAnnouncement.textContent = `⚽ فاز ${roomState.guest ? roomState.guest.name : 'الضيف'} بالمزاد!`;
          if (myRole === 'guest') launchConfetti(4000);
        } else {
          winnerAnnouncement.textContent = `🤝 تعادل حماسي بين الطرفين!`;
          launchConfetti(2500);
        }
        statHostPos.textContent = `${stats.possession[0]}%`;
        statGuestPos.textContent = `${stats.possession[1]}%`;
        const barHost = document.getElementById('bar-host-pos');
        const barGuest = document.getElementById('bar-guest-pos');
        if (barHost) barHost.style.width = `${stats.possession[0]}%`;
        if (barGuest) barGuest.style.width = `${stats.possession[1]}%`;
        statHostShots.textContent = stats.shots[0];
        statGuestShots.textContent = stats.shots[1];
        statHostOntarget.textContent = stats.shotsOnTarget[0];
        statGuestOntarget.textContent = stats.shotsOnTarget[1];
      }, 1000);
    }
  }

  // ---------- auction view rendering ----------
  function renderBudgetRow() {
    const mode = roomState.squadMode;
    const start = roomState.budgetStart || 0;
    aucHostName.textContent = `👑 ${roomState.host.name}`;
    aucGuestName.textContent = roomState.guest ? `⚽ ${roomState.guest.name}` : '⚽ في انتظار الضيف...';
    const hostRemaining = start - (roomState.host.budgetSpent || 0);
    const guestRemaining = roomState.guest ? (start - (roomState.guest.budgetSpent || 0)) : start;
    aucHostFill.style.width = start ? `${Math.max(0, (hostRemaining / start) * 100)}%` : '0%';
    aucGuestFill.style.width = start ? `${Math.max(0, (guestRemaining / start) * 100)}%` : '0%';
    aucHostText.textContent = `${formatMoney(hostRemaining)} / ${formatMoney(start)}`;
    aucGuestText.textContent = `${formatMoney(guestRemaining)} / ${formatMoney(start)}`;
  }

  function renderRoundResult() {
    const r = roomState.lastRoundResult;
    if (!r) { aucRoundResult.classList.add('hidden'); return; }
    aucRoundResult.classList.remove('hidden');
    const winnerName = roomState[r.winnerSide]?.name || '---';
    if (r.type === 'contested') {
      let msg = `🏆 ${esc(winnerName)} كسب ${esc(reportPlayerName(r.player?.name))} بـ ${formatMoney(r.winningBid)}`;
      if (r.bonusPlayer) msg += ` + بونص مجاني: ${esc(reportPlayerName(r.bonusPlayer.name))} 🎁`;
      if (r.consolationPlayer) msg += ` — والطرف التاني اخد تعويض: ${esc(reportPlayerName(r.consolationPlayer.name))}`;
      aucRoundResult.innerHTML = msg;
    } else {
      aucRoundResult.innerHTML = `🎁 ${esc(winnerName)} اخد ${esc(reportPlayerName(r.player?.name))} مجانًا (بدون منافسة على المركز)`;
    }
  }

  function renderBiddingBlock() {
    const rs = roomState.roundState;
    if (!roomState.guest) {
      aucWaitingGuest.classList.remove('hidden');
      aucBiddingBlock.classList.add('hidden');
      return;
    }
    aucWaitingGuest.classList.add('hidden');

    if (!rs || rs.status !== 'bidding') {
      aucBiddingBlock.classList.add('hidden');
      return;
    }
    aucBiddingBlock.classList.remove('hidden');

    const roundKey = `${roomState.roundNumber}:${rs.basePosition}`;
    aucRoundLabel.textContent = `الجولة ${roomState.roundNumber} — ${POSITION_NAMES_AR[rs.basePosition] || rs.basePosition}`;

    if (lastPeekRoundKey !== roundKey) {
      lastPeekRoundKey = roundKey;
      mazadPeekActive = false;
    }
    if (btnAdminRevealMazad) btnAdminRevealMazad.classList.toggle('hidden', !isAdminPlayer());
    if (aucAdminPeek) {
      aucAdminPeek.classList.toggle('hidden', !mazadPeekActive);
      if (mazadPeekActive) {
        aucPeekBonus.textContent = rs.previewBonus ? `${reportPlayerName(rs.previewBonus.name)} (${rs.previewBonus.rating})` : 'مفيش متاح';
        aucPeekConsolation.textContent = rs.previewConsolation ? `${reportPlayerName(rs.previewConsolation.name)} (${rs.previewConsolation.rating})` : 'مفيش متاح';
      }
    }

    if (roundKey !== lastRenderedRoundKey) {
      const cardEl = document.getElementById('auc-player-card');
      if (cardEl) {
        cardEl.classList.remove('pop-in');
        void cardEl.offsetWidth; // force reflow so the class re-add actually restarts the animation
        cardEl.classList.add('pop-in');
      }
    }

    const isMyTurn = myRole === rs.turn;
    aucTurnPill.textContent = myRole === 'spectator' ? 'المزايدة جارية' : (isMyTurn ? 'دورك تزايد' : 'دور الخصم');
    aucTurnPill.classList.toggle('waiting', !isMyTurn || myRole === 'spectator');

    aucPlayerRating.textContent = rs.player?.rating ?? '?';
    aucPlayerName.textContent = reportPlayerName(rs.player?.name);
    aucPlayerMeta.textContent = [rs.player?.club, rs.player?.nation].filter(Boolean).join(' — ');

    aucCurrentBid.textContent = formatMoney(rs.currentBid);
    aucCurrentBidder.textContent = rs.currentBidder ? `(${roomState[rs.currentBidder]?.name || ''})` : '';

    const minNext = mazadMinNextBid(roomState.squadMode, rs.currentBid);
    aucMinHint.textContent = `أقل مزايدة ممكنة: ${formatMoney(minNext)}`;
    if (roundKey !== lastRenderedRoundKey || !aucBidInput.value) {
      aucBidInput.value = minNext;
    }
    aucBidInput.min = minNext;

    const canAct = isMyTurn && myRole !== 'spectator';
    btnPlaceBid.disabled = !canAct;
    btnPassBid.disabled = !canAct || rs.currentBid <= 0;

    lastRenderedRoundKey = roundKey;
  }

  function onRoomUpdate(room) {
    roomState = room;
    myRole = room.host && room.host.id === AuctionEngine.myPlayerId ? 'host'
      : (room.guest && room.guest.id === AuctionEngine.myPlayerId ? 'guest' : 'spectator');

    roomInfoBar.classList.remove('hidden');
    displayRoomId.textContent = room.roomId;
    userRoleBadge.textContent = myRole === 'host' ? '👑 مستضيف' : myRole === 'guest' ? '⚽ ضيف' : '👁️ مراقب';
    spectatorBanner.classList.toggle('hidden', myRole !== 'spectator');
    btnLeaveRoom.classList.remove('hidden');
    btnToggleChat?.classList.toggle('hidden', myRole === 'spectator');
    renderChatMessages(room.chat || []);

    if (room.status === 'simulating' || room.status === 'finished') {
      showView('view-simulation');
      renderMatchView();
      return;
    }

    showView('view-auction');
    renderBudgetRow();
    renderRoundResult();
    renderBiddingBlock();
    renderLineupStrip(aucLineupStrip, room.squadMode,
      room.guest?.squad, room.guest ? room.guest.name : 'الضيف',
      room.host.squad, room.host.name);
  }

  function enterRoomFlow(roomId, name) {
    currentRoomId = roomId;
    myPlayerName = name;
    matchSummaryShown = false;
    lastRenderedRoundKey = null;
    sessionStorage.setItem('mazad_active_room_id', roomId);
    localStorage.setItem('mazad_player_name', name);
    AuctionEngine.listenToRoom(roomId, onRoomUpdate);
  }

  btnCreateRoom?.addEventListener('click', () => {
    const name = (playerNameInput.value || '').trim();
    if (name.length < 3) { showNotification('اكتب اسمك (3 حروف على الأقل)'); return; }
    const mode = document.getElementById('mode-full').checked ? 'full' : 'classic';
    btnCreateRoom.disabled = true;
    AuctionEngine.createRoom(createRoomIdInput.value, name, mode)
      .then(roomId => enterRoomFlow(roomId, name))
      .catch(err => {
        console.error('createRoom error:', err);
        showNotification(err && err.message === 'ROOM_TAKEN' ? '❌ كود الغرفة ده مستخدم بالفعل' : `❌ حصل خطأ: ${err && err.message || err}`);
      })
      .finally(() => { btnCreateRoom.disabled = false; });
  });

  btnPlayAi?.addEventListener('click', () => {
    const name = (playerNameInput.value || '').trim();
    if (name.length < 3) { showNotification('اكتب اسمك (3 حروف على الأقل)'); return; }
    const mode = document.getElementById('mode-full').checked ? 'full' : 'classic';
    btnPlayAi.disabled = true;
    AuctionEngine.enterAiRoom(name, mode)
      .then(roomId => enterRoomFlow(roomId, name))
      .catch(err => {
        console.error('enterAiRoom error:', err);
        showNotification(`❌ حصل خطأ: ${err && err.message || err}`);
      })
      .finally(() => { btnPlayAi.disabled = false; });
  });

  btnJoinRoom?.addEventListener('click', () => {
    const name = (playerNameInput.value || '').trim();
    if (name.length < 3) { showNotification('اكتب اسمك (3 حروف على الأقل)'); return; }
    if (!joinRoomIdInput.value.trim()) { showNotification('اكتب كود الغرفة'); return; }
    btnJoinRoom.disabled = true;
    AuctionEngine.joinRoom(joinRoomIdInput.value, name)
      .then(roomId => enterRoomFlow(roomId, name))
      .catch(err => {
        console.error('joinRoom error:', err);
        showNotification(err && err.message === 'ROOM_NOT_FOUND' ? '❌ الغرفة دي مش موجودة' : `❌ حصل خطأ: ${err && err.message || err}`);
      })
      .finally(() => { btnJoinRoom.disabled = false; });
  });

  btnLeaveRoom?.addEventListener('click', () => {
    AuctionEngine.leaveRoom();
    sessionStorage.removeItem('mazad_active_room_id');
    currentRoomId = null;
    window.location.reload();
  });

  // Live text chat - same "capped array on the room object" pattern as the
  // deal game, reusing FirebaseEngine.sendChatMessage with 'mazad_rooms'.
  btnToggleChat?.addEventListener('click', () => {
    chatPanelOpen = !chatPanelOpen;
    chatPanel.classList.toggle('hidden', !chatPanelOpen);
    if (chatPanelOpen) {
      chatUnreadDot.classList.add('hidden');
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      chatInput.focus();
    }
  });
  btnCloseChat?.addEventListener('click', () => {
    chatPanelOpen = false;
    chatPanel.classList.add('hidden');
  });
  chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !currentRoomId) return;
    FirebaseEngine.sendChatMessage(currentRoomId, myPlayerName, text, 'mazad_rooms');
    chatInput.value = '';
  });

  function renderChatMessages(messages) {
    if (messages.length === lastRenderedChatCount) return;
    const isNewIncoming = messages.length > lastRenderedChatCount;
    const newestIsMine = isNewIncoming && messages[messages.length - 1]?.senderId === AuctionEngine.myPlayerId;
    lastRenderedChatCount = messages.length;

    chatMessagesEl.innerHTML = messages.map(m => `
      <div class="chat-msg ${m.senderId === AuctionEngine.myPlayerId ? 'mine' : ''}">
        <span class="chat-sender">${esc(m.senderName)}</span>${esc(m.text)}
      </div>
    `).join('');
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    if (isNewIncoming && !newestIsMine && !chatPanelOpen) {
      chatUnreadDot.classList.remove('hidden');
    }
  }

  btnCopyCode?.addEventListener('click', () => {
    if (!currentRoomId) return;
    navigator.clipboard?.writeText(currentRoomId).then(() => showNotification('📋 اتنسخ الكود!'));
  });

  btnCopyInviteLink?.addEventListener('click', () => {
    if (!currentRoomId) return;
    const inviteUrl = `${location.origin}${location.pathname}?room=${currentRoomId}`;
    navigator.clipboard?.writeText(inviteUrl).then(() => {
      showNotification('🔗 اتنسخ رابط الدعوة! ابعته لصاحبك يدخل يكتب اسمه ويلعب فورًا.');
    });
  });

  btnAdminRevealMazad?.addEventListener('click', () => {
    mazadPeekActive = !mazadPeekActive;
    renderBiddingBlock();
  });

  btnPlaceBid?.addEventListener('click', () => {
    if (!currentRoomId) return;
    const amount = parseInt(aucBidInput.value) || 0;
    btnPlaceBid.disabled = true;
    AuctionEngine.placeBid(currentRoomId, amount)
      .catch(err => {
        console.error('placeBid error:', err);
        const messages = {
          BID_TOO_LOW: '❌ لازم تزايد بمبلغ أعلى',
          OVER_BUDGET: '❌ الميزانية متكفيش',
          NOT_YOUR_TURN: '❌ مش دورك',
          NO_ACTIVE_ROUND: '❌ مفيش جولة شغالة دلوقتي'
        };
        showNotification(messages[err.message] || `❌ حصل خطأ: ${err && err.message || err}`);
      })
      // A rejected bid never touches the room in Firebase, so the usual
      // "room changed -> re-render resets disabled" path never fires here -
      // without this, one bad amount (or a stale minimum) permanently
      // freezes the button until something else happens to change.
      .finally(() => { btnPlaceBid.disabled = false; });
  });

  btnPassBid?.addEventListener('click', () => {
    if (!currentRoomId) return;
    btnPassBid.disabled = true;
    AuctionEngine.passBid(currentRoomId)
      .catch(err => {
        console.error('passBid error:', err);
        showNotification(err && err.message === 'NO_BID_YET' ? '❌ لازم حد يزايد الأول' : `❌ حصل خطأ: ${err && err.message || err}`);
      })
      .finally(() => { btnPassBid.disabled = false; });
  });

  btnRematchHome?.addEventListener('click', () => {
    if (!currentRoomId) return;
    matchSummaryShown = false;
    lastRenderedRoundKey = null;
    // active_room_id stays in sessionStorage on purpose - the room is still
    // alive after a rematch, so a refresh keeps restoring the same match.
    AuctionEngine.restartAuction(currentRoomId).catch(err => {
      console.error('restartAuction error:', err);
      showNotification(`❌ حصل خطأ: ${err && err.message || err}`);
    });
  });

  btnSoundToggle?.addEventListener('click', () => {
    btnSoundToggle.textContent = btnSoundToggle.textContent === '🔊' ? '🔇' : '🔊';
    if (window.soundFX?.toggleMute) window.soundFX.toggleMute();
  });

  // Rules stay collapsed by default - one tap away instead of always on
  // screen, same declutter pattern as the deal lobby's tutorial link.
  btnToggleRules?.addEventListener('click', () => {
    const nowOpen = !rulesCollapseBody.classList.contains('open');
    btnToggleRules.classList.toggle('open', nowOpen);
    rulesCollapseBody.classList.toggle('open', nowOpen);
  });

  // Lobby stage 2 (mode/create/join) only reveals once a usable name is
  // typed - one decision at a time instead of the whole lobby at once.
  function syncLobbyStage2() {
    if (!lobbyStage2 || !playerNameInput) return;
    lobbyStage2.classList.toggle('hidden', playerNameInput.value.trim().length < 3);
  }
  playerNameInput?.addEventListener('input', syncLobbyStage2);
  syncLobbyStage2();

  // Lineup panel during the auction - collapsed by default so the player
  // on the block stays the focal point.
  btnToggleAucLineup?.addEventListener('click', () => {
    const nowOpen = !aucLineupCollapseBody.classList.contains('open');
    btnToggleAucLineup.classList.toggle('open', nowOpen);
    aucLineupCollapseBody.classList.toggle('open', nowOpen);
  });

  // Deep link (?room=xxxx) + session restore, same pattern as the deal
  // game's app.js - a pasted invite link is otherwise a dead end with
  // nothing pre-filled.
  const urlParams = new URLSearchParams(window.location.search);
  const startParam = urlParams.get('room');
  const savedRoomId = sessionStorage.getItem('mazad_active_room_id');
  const savedName = localStorage.getItem('mazad_player_name');

  if (savedRoomId && savedName && !startParam) {
    playerNameInput.value = savedName;
    AuctionEngine.enterRoom(savedRoomId, savedName)
      .then(roomId => enterRoomFlow(roomId, savedName))
      .catch(() => sessionStorage.removeItem('mazad_active_room_id'));
  } else if (startParam && startParam.length > 0) {
    if (joinRoomIdInput) joinRoomIdInput.value = startParam;
    if (savedName) {
      playerNameInput.value = savedName;
      syncLobbyStage2();
      showNotification(`رابط دعوة من صاحبك - جاري الانضمام للمزاد ${startParam}...`);
      setTimeout(() => { btnJoinRoom?.click(); }, 400);
    } else {
      showNotification('📨 رابط دعوة من صاحبك! اكتب اسمك وانضم فورًا.');
      playerNameInput?.focus();
      if (playerNameInput) playerNameInput.placeholder = 'اكتب اسمك للانضمام لمزاد صاحبك';
    }
  } else if (savedName) {
    playerNameInput.value = savedName;
    syncLobbyStage2();
  }

  // Back to Hub Button & Swipe Gesture Integration
  const backToHubBtn = document.querySelector('.back-to-hub-btn');
  if (backToHubBtn) {
    backToHubBtn.addEventListener('click', (e) => {
      if (btnLeaveRoom && !btnLeaveRoom.classList.contains('hidden')) {
        e.preventDefault();
        if (confirm('هتخرج من المزاد وترجع لمركز الألعاب. متابعة؟')) {
          AuctionEngine.leaveRoom();
          sessionStorage.removeItem('mazad_active_room_id');
          window.location.href = '/';
        }
      }
    });
  }

  // Swipe gesture to go back (on mobile)
  let touchStartX = 0;
  let touchStartY = 0;
  
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  
  document.addEventListener('touchend', (e) => {
    if (e.changedTouches.length !== 1) return;
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    
    const diffX = touchEndX - touchStartX;
    const diffY = Math.abs(touchEndY - touchStartY);
    
    if (diffY < 60) {
      const screenWidth = window.innerWidth;
      let triggered = false;
      
      if (touchStartX < 50 && diffX > 100) {
        triggered = true; // Left to right
      } else if (touchStartX > screenWidth - 50 && diffX < -100) {
        triggered = true; // Right to left
      }
      
      if (triggered) {
        if (btnLeaveRoom && !btnLeaveRoom.classList.contains('hidden')) {
          if (confirm('هتخرج من المزاد وترجع لمركز الألعاب. متابعة؟')) {
            AuctionEngine.leaveRoom();
            sessionStorage.removeItem('mazad_active_room_id');
            window.location.href = '/';
          }
        } else {
          window.location.href = '/';
        }
      }
    }
  }, { passive: true });

});

