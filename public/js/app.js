// PWA Service Worker Registration - auto-reloads once a new worker takes
// control (sw.js now calls skipWaiting() on install) instead of relying on
// the user noticing an "update available" banner. The reloadingForUpdate
// guard stops a second registration/controllerchange pair from looping.
let reloadingForUpdate = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    console.log('📱 PWA Service Worker Registered!');
    reg.update();
  }).catch(err => console.log('SW Registration error:', err));
}

document.addEventListener('DOMContentLoaded', () => {

  // esc() and safeImageUrl() are defined in utils.js (loaded before this
  // file) and shared with leaderboard.js - the only actual XSS boundary,
  // since Firebase has no write auth yet and every value here is
  // attacker-controllable.

  // State
  let myRole = 'spectator';
  let myPlayerName = 'لاعب';
  let roomState = null;
  let currentRoomId = null;
  let turnTimerInterval = null;
  let turnTimerSeconds = 15;
  let lastProcessedEmojiTimestamp = 0;
  let lastNotifiedHelperCardId = null;
  let lastStealNoticeTs = 0;
  let lastVoidedNoticeTs = 0;
  let matchRecorded = false; // Prevents duplicate stat recording
  let resultModalTimeoutId = null;
  let peekActive = false; // local-only "reveal_cards"/admin-eye peek state, resets each round
  let lastPeekRoundKey = null;

  // Admin/dev convenience account - gets a permanent eye toggle above the
  // briefcases. Gated on the real signed-in Google account (user-profile.js
  // -> isAdmin()), not a typed name - a plain-name check would let anyone
  // rename themselves to get the same peek in a real match against someone
  // who doesn't know about it. This is NOT a data-security feature either
  // way: every briefcase's `item` is already written to Firebase in full
  // the moment a round starts (see generateBriefcases in firebase-engine.js)
  // - isRevealed is only a display flag, so this data is already technically
  // visible to anyone who opens devtools or the Firebase console regardless
  // of this toggle existing.
  function isAdminPlayer() {
    return typeof UserProfileManager !== 'undefined' && UserProfileManager.isAdmin && UserProfileManager.isAdmin();
  }

  // Dismiss Loading Screen
  setTimeout(() => {
    const loader = document.getElementById('app-loading-screen');
    if (loader) loader.classList.add('fade-out');
  }, 400);

  // Confetti Particle System for Celebrations
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

    let animId;
    const startTime = Date.now();

    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.y += p.vy;
        p.x += p.vx;
        p.rotation += p.rv;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      });

      if (Date.now() - startTime < durationMs) {
        animId = requestAnimationFrame(render);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    render();
  }

  // Haptic Feedback for Mobile
  function triggerHaptic(pattern = [30, 50, 30]) {
    if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  }

  // DOM Elements
  const viewLobby = document.getElementById('view-lobby');
  const viewDraft = document.getElementById('view-draft');
  const viewMatch = document.getElementById('view-simulation');

  const roomInfoBar = document.getElementById('room-info-bar');
  const displayRoomId = document.getElementById('display-room-id');
  const userRoleBadge = document.getElementById('user-role-badge');
  const spectatorsCount = document.getElementById('spectators-count');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnSoundToggle = document.getElementById('btn-sound-toggle');
  const notificationBanner = document.getElementById('notification-banner');
  const spectatorBanner = document.getElementById('spectator-banner');

  // Chat & Voice Elements
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnToggleChat = document.getElementById('btn-toggle-chat');
  const btnCloseChat = document.getElementById('btn-close-chat');
  const chatPanel = document.getElementById('chat-panel');
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatUnreadDot = document.getElementById('chat-unread-dot');
  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const voiceVolumeRow = document.getElementById('voice-volume-row');
  const voiceVolumeSlider = document.getElementById('voice-volume-slider');
  const voiceVolumeLabel = document.getElementById('voice-volume-label');
  const remoteVoiceAudio = document.getElementById('remote-voice-audio');
  let lastRenderedChatCount = 0;
  let chatPanelOpen = false;

  // Timer & Emoji Elements
  const turnTimerRing = document.getElementById('turn-timer-ring');
  const turnTimerNum = document.getElementById('turn-timer-num');
  const timerCircleProgress = document.getElementById('timer-circle-progress');
  const emojiFloatingContainer = document.getElementById('emoji-floating-container');

  // Auth Elements
  const btnGoogleLogin = document.getElementById('btn-google-login');
  const btnLogout = document.getElementById('btn-logout');

  // PWA & SW Elements
  const pwaInstallBanner = document.getElementById('pwa-install-banner');
  const btnInstallPwa = document.getElementById('btn-install-pwa');
  const btnDismissPwa = document.getElementById('btn-dismiss-pwa');
  const swUpdateBanner = document.getElementById('sw-update-banner');
  const btnUpdateSw = document.getElementById('btn-update-sw');

  // Lobby Inputs
  const playerNameInput = document.getElementById('player-name-input');
  const createRoomIdInput = document.getElementById('create-room-id');
  const joinRoomIdInput = document.getElementById('join-room-id');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const btnPlayAi = document.getElementById('btn-play-ai');

  // Draft Elements
  const currentPositionTitle = document.getElementById('current-position-title');
  const currentTurnDesc = document.getElementById('current-turn-desc');
  const hostNameTag = document.getElementById('host-name-tag');
  const guestNameTag = document.getElementById('guest-name-tag');
  const briefcasesContainer = document.getElementById('briefcases-container');
  const btnAdminReveal = document.getElementById('btn-admin-reveal');
  const btnUseRevealCards = document.getElementById('btn-use-reveal-cards');
  const decisionPanel = document.getElementById('decision-panel');
  const pickedCardPreview = document.getElementById('picked-card-preview');
  const btnDeal = document.getElementById('btn-deal');
  const btnNoDeal = document.getElementById('btn-no-deal');
  const btnForceSwap = document.getElementById('btn-force-swap');

  const lineupStripEl = document.getElementById('lineup-strip');

  // Match Center Elements
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
  const mcLineupStripEl = document.getElementById('mc-lineup-strip');
  const winnerAnnouncement = document.getElementById('winner-title');
  const finalScoreText = document.getElementById('final-score-display');
  const statHostPos = document.getElementById('stat-host-pos');
  const statGuestPos = document.getElementById('stat-guest-pos');
  const statHostShots = document.getElementById('stat-host-shots');
  const statGuestShots = document.getElementById('stat-guest-shots');
  const statHostOntarget = document.getElementById('stat-host-ontarget');
  const statGuestOntarget = document.getElementById('stat-guest-ontarget');
  const btnRematch = document.getElementById('btn-rematch');
  const btnSaveMatch = document.getElementById('btn-save-match');

  // Match center tab switching - plain show/hide, no router needed for 4 tabs.
  document.querySelectorAll('.mc-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.tab;
      document.querySelectorAll('.mc-tab').forEach(b => b.classList.toggle('active', b === tabBtn));
      document.querySelectorAll('.mc-tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `mc-panel-${target}`));
    });
  });
  function switchMatchTab(target) {
    document.querySelectorAll('.mc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    document.querySelectorAll('.mc-tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `mc-panel-${target}`));
  }

  // VIEW SWITCHER
  function showView(viewId) {
    [viewLobby, viewDraft, viewMatch].forEach(view => {
      if (!view) return;
      if (view.id === viewId) {
        view.classList.remove('hidden');
        view.classList.add('active');
      } else {
        view.classList.add('hidden');
        view.classList.remove('active');
      }
    });
  }

  // Player ID card - the revealed-briefcase design picked from the mockup
  // (barcode strip, punch-hole corner, position-tagged photo slot). No real
  // player photos exist in the data set (and hotlinking real footballers'
  // photos without rights isn't an option), so the photo slot is a plain
  // athlete silhouette - the standard "no photo on file" convention on real
  // trading cards - instead of a single generic emoji.
  // Strips the trailing slot number so full-mode keys (DEF2, ATT3, ...)
  // still resolve to the same base position as classic mode's plain keys.
  function basePositionKey(slotKey) {
    return String(slotKey).replace(/[0-9]+$/, '');
  }

  function playerPhotoHTML(posKey) {
    if (basePositionKey(posKey) === 'MGR') return '📋';
    return '<div class="player-silhouette"></div>';
  }

  // Icon-only helper card badge (steal/protection/extra_chance) - the id-card
  // and fifa-card layouts both already use their top-left/top-right corners
  // for the eyebrow label and rating number, so a badge carrying the full
  // Arabic name ("سرقة لاعب 🥷") had nowhere left to go without covering
  // one of them. A single small emoji fits the leftover gap between the two.
  const HELPER_ICON = { steal: '🥷', protection: '🛡️', extra_chance: '🎲', reveal_cards: '🔍', max_upgrade: '🔥' };

  function buildPlayerCardHTML(item, posKey, tierLabel, isIcon) {
    return `
      <div class="id-card">
        <div class="id-card-head">
          <span class="id-rating">${esc(item.rating)}</span>
          <span class="id-eyebrow">${esc(basePositionKey(posKey))} · ${esc(tierLabel)}</span>
        </div>
        <div class="id-photo">${playerPhotoHTML(posKey)}</div>
        <div class="id-name">${esc(item.name)}</div>
        <div class="id-club">${esc(item.club)} · ${esc(item.nation)}</div>
        ${isIcon ? '<div class="id-skill-badge">⭐ مهارة خاصة</div>' : ''}
        <div class="id-barcode"></div>
      </div>
    `;
  }

  let notificationTimeoutId = null;
  function showNotification(msg, duration = 4000) {
    notificationBanner.textContent = msg;
    notificationBanner.classList.remove('hidden');
    if (notificationTimeoutId) clearTimeout(notificationTimeoutId);
    notificationTimeoutId = setTimeout(() => {
      notificationBanner.classList.add('hidden');
      notificationTimeoutId = null;
    }, duration);
  }

  // Safe Audio Trigger Helper
  function safePlaySound(methodName) {
    try {
      if (window.soundFX && typeof window.soundFX[methodName] === 'function') {
        window.soundFX[methodName]();
      }
    } catch (err) {
      console.warn('Audio play error:', err);
    }
  }

  // Initialize Auth & Profile - both are entirely optional, the game is
  // playable by just typing a name (see firebase-engine.js -> FIREBASE_AUTH_ENABLED).
  if (typeof AuthManager !== 'undefined') {
    AuthManager.init();
    if (typeof UserProfileManager !== 'undefined') {
      UserProfileManager.init();
    }
  }

  if (typeof LeaderboardManager !== 'undefined') {
    LeaderboardManager.init();
  }

  if (window.FIREBASE_AUTH_ENABLED) {
    document.querySelectorAll('.auth-signed-out').forEach(el => el.classList.remove('hidden'));
    const btnLeaderboard = document.getElementById('btn-leaderboard');
    if (btnLeaderboard) btnLeaderboard.classList.remove('hidden');
  }

  // Remember the typed name locally so returning players don't retype it.
  if (playerNameInput) {
    const savedName = localStorage.getItem('dond_player_name');
    if (savedName && !playerNameInput.value) playerNameInput.value = savedName;
    playerNameInput.addEventListener('change', () => {
      const v = playerNameInput.value.trim();
      if (v) localStorage.setItem('dond_player_name', v);
    });
  }

  // Lobby stage 2 (mode/AI/create/join) only reveals once a usable name is
  // typed - requireName() already enforces the same 3-char minimum on every
  // action button, this is purely showing one decision at a time instead of
  // the whole lobby at once. Checked on load too, since a returning
  // player's name may already be pre-filled above.
  const lobbyStage2 = document.getElementById('lobby-stage-2');
  function syncLobbyStage2() {
    if (!lobbyStage2 || !playerNameInput) return;
    lobbyStage2.classList.toggle('hidden', playerNameInput.value.trim().length < 3);
  }
  if (playerNameInput) {
    playerNameInput.addEventListener('input', syncLobbyStage2);
    syncLobbyStage2();
  }

  const btnOpenTutorialLink = document.getElementById('btn-open-tutorial');
  if (btnOpenTutorialLink) {
    btnOpenTutorialLink.addEventListener('click', () => {
      document.getElementById('tutorial-modal')?.classList.remove('hidden');
    });
  }

  // Lineup panel during the draft - collapsed by default so the open
  // briefcase stays the focal point, one tap away from the full roster.
  const btnToggleLineup = document.getElementById('btn-toggle-lineup');
  const lineupCollapseBody = document.getElementById('lineup-collapse-body');
  if (btnToggleLineup && lineupCollapseBody) {
    btnToggleLineup.addEventListener('click', () => {
      const nowOpen = !lineupCollapseBody.classList.contains('open');
      btnToggleLineup.classList.toggle('open', nowOpen);
      lineupCollapseBody.classList.toggle('open', nowOpen);
    });
  }

  // Auth Event Listeners
  if (btnGoogleLogin) {
    btnGoogleLogin.addEventListener('click', async () => {
      try {
        await AuthManager.signInWithGoogle();
        showNotification('تم تسجيل الدخول بنجاح! 🟢');
      } catch (err) {
        showNotification('حدث خطأ أثناء تسجيل الدخول بـ Google: ' + err.message);
      }
    });
  }

  const btnGuestLogin = document.getElementById('btn-guest-login');
  if (btnGuestLogin) {
    btnGuestLogin.addEventListener('click', async () => {
      try {
        await AuthManager.signInAsGuest();
        showNotification('تم تسجيل الدخول كضيف! 👤');
      } catch (err) {
        showNotification('حدث خطأ أثناء الدخول كضيف: ' + err.message);
      }
    });
  }

  // Phone sign-in - two-step (send code, then verify it).
  const phoneNumberInput = document.getElementById('phone-number-input');
  const phoneCodeInput = document.getElementById('phone-code-input');
  const phoneAuthStep1 = document.getElementById('phone-auth-step1');
  const phoneAuthStep2 = document.getElementById('phone-auth-step2');
  const btnSendPhoneCode = document.getElementById('btn-send-phone-code');
  const btnVerifyPhoneCode = document.getElementById('btn-verify-phone-code');

  if (btnSendPhoneCode) {
    btnSendPhoneCode.addEventListener('click', async () => {
      const phone = (phoneNumberInput?.value || '').trim();
      if (!phone.startsWith('+')) {
        showNotification('❌ اكتب رقمك بالكود الدولي (مثال: +20 لمصر) قبل الرقم');
        return;
      }
      btnSendPhoneCode.disabled = true;
      try {
        await AuthManager.sendPhoneCode(phone);
        showNotification('📩 اتبعت الكود على رقمك! اكتبه تحت');
        phoneAuthStep1?.classList.add('hidden');
        phoneAuthStep2?.classList.remove('hidden');
      } catch (err) {
        console.error('Phone code send error:', err);
        showNotification('❌ حصل خطأ: ' + (err.message || err));
      } finally {
        btnSendPhoneCode.disabled = false;
      }
    });
  }

  if (btnVerifyPhoneCode) {
    btnVerifyPhoneCode.addEventListener('click', async () => {
      const code = (phoneCodeInput?.value || '').trim();
      if (!code) { showNotification('❌ اكتب الكود اللي جالك'); return; }
      btnVerifyPhoneCode.disabled = true;
      try {
        await AuthManager.verifyPhoneCode(code);
        showNotification('✅ تم تسجيل الدخول برقم التليفون!');
        phoneAuthStep2?.classList.add('hidden');
        phoneAuthStep1?.classList.remove('hidden');
        if (phoneCodeInput) phoneCodeInput.value = '';
      } catch (err) {
        console.error('Phone code verify error:', err);
        showNotification('❌ الكود غلط أو منتهي، جرب تاني');
      } finally {
        btnVerifyPhoneCode.disabled = false;
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await AuthManager.signOut();
        showNotification('تم تسجيل الخروج 🔴');
      } catch (err) {
        console.error(err);
      }
    });
  }

  // PWA Install Logic
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (pwaInstallBanner) pwaInstallBanner.classList.remove('hidden');
  });

  if (btnInstallPwa) {
    btnInstallPwa.addEventListener('click', async () => {
      if (pwaInstallBanner) pwaInstallBanner.classList.add('hidden');
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log('User response to the install prompt:', outcome);
        deferredPrompt = null;
      }
    });
  }

  if (btnDismissPwa) {
    btnDismissPwa.addEventListener('click', () => {
      if (pwaInstallBanner) pwaInstallBanner.classList.add('hidden');
    });
  }

  // Tutorial Logic
  const tutorialModal = document.getElementById('tutorial-modal');
  const btnCloseTutorial = document.getElementById('btn-close-tutorial');
  const btnStartTutorial = document.getElementById('btn-start-tutorial');

  if (tutorialModal && !localStorage.getItem('tutorial_seen')) {
    setTimeout(() => {
      tutorialModal.classList.remove('hidden');
    }, 1000); // show a second after load
  }

  function closeTutorial() {
    if (tutorialModal) tutorialModal.classList.add('hidden');
    localStorage.setItem('tutorial_seen', 'true');
  }

  if (btnCloseTutorial) btnCloseTutorial.addEventListener('click', closeTutorial);
  if (btnStartTutorial) btnStartTutorial.addEventListener('click', closeTutorial);

  // SW Auto-Update Logic
  let currentAppVersion = null;
  
  // Settings Logic
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const settingsModal = document.getElementById('settings-modal');
  const volumeSlider = document.getElementById('volume-slider');
  const themeToggle = document.getElementById('theme-toggle');

  if (btnOpenSettings && settingsModal) {
    btnOpenSettings.addEventListener('click', () => {
      settingsModal.classList.remove('hidden');
    });
    btnCloseSettings.addEventListener('click', () => {
      settingsModal.classList.add('hidden');
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      if (window.soundFX) {
        window.soundFX.setVolume(vol);
      }
    });
  }

  if (themeToggle) {
    themeToggle.addEventListener('change', (e) => {
      if (e.target.checked) {
        document.body.classList.add('battery-saver');
      } else {
        document.body.classList.remove('battery-saver');
      }
    });
  }

  // Fetch initial version
  fetch('/version.json?t=' + Date.now())
    .then(r => r.json())
    .then(data => { currentAppVersion = data.version; })
    .catch(err => console.log('Version fetch err:', err));

  // Poll for updates every 10 minutes
  setInterval(() => {
    fetch('/version.json?t=' + Date.now())
      .then(r => r.json())
      .then(data => {
        if (currentAppVersion && data.version !== currentAppVersion) {
          if (swUpdateBanner) swUpdateBanner.classList.remove('hidden');
        }
      })
      .catch(err => console.log('Version check err:', err));
  }, 10 * 60 * 1000);

  if (btnUpdateSw) {
    btnUpdateSw.addEventListener('click', () => {
      // location.reload(true) is a non-standard argument every modern browser
      // ignores, and the service worker serves HTML cache-first, so a plain
      // reload could just re-show the stale page. Force the waiting worker to
      // activate and reload once the new one has taken control.
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then(reg => {
          if (reg) {
            reg.update();
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
          }, { once: true });
          setTimeout(() => window.location.reload(), 1500);
        });
      } else {
        window.location.reload();
      }
    });
  }

  // Reads the room-error Error thrown by FirebaseEngine and returns an
  // Arabic message - each failure path used to be unreachable because
  // enterRoom() resolved before the write even landed, so the UI claimed
  // success no matter what actually happened.
  function roomErrorMessage(err) {
    switch (err && err.message) {
      case 'ROOM_TAKEN': return '⚠️ كود الغرفة ده مستخدم بالفعل من مستضيف آخر! جرّب كود مختلف.';
      case 'ROOM_NOT_FOUND': return '⚠️ مفيش غرفة بالكود ده. تأكد من الكود وحاول تاني.';
      case 'ROOM_FULL': return '⚠️ الغرفة دي مكتملة بالفعل (مستضيف + ضيف).';
      case 'EMPTY_CODE': return '⚠️ اكتب كود الغرفة أولاً.';
      default: return 'حدث خطأ أثناء الاتصال بسيرفر الغرف! يرجى التأكد من الاتصال بالإنترنت.';
    }
  }

  function requireName() {
    const nameVal = playerNameInput.value.trim();
    if (!nameVal || nameVal.length < 3) {
      showNotification('⚠️ يرجى كتابة اسمك في اللعبة أولاً (3 حروف على الأقل)!');
      playerNameInput.focus();
      return null;
    }
    return nameVal;
  }

  // LOBBY EVENT LISTENERS
  function getSelectedSquadMode() {
    const checked = document.querySelector('input[name="squad-mode"]:checked');
    return checked ? checked.value : 'classic';
  }

  btnCreateRoom?.addEventListener('click', (e) => {
    if (e) e.preventDefault();
    const nameVal = requireName();
    if (!nameVal) return;
    myPlayerName = nameVal;
    localStorage.setItem('dond_player_name', nameVal);

    const roomId = createRoomIdInput.value.trim();
    safePlaySound('playClick');

    FirebaseEngine.createRoom(roomId, myPlayerName, getSelectedSquadMode())
      .then(finalId => {
        currentRoomId = finalId;
        sessionStorage.setItem('active_room_id', finalId);
        sessionStorage.setItem('active_player_name', myPlayerName);
        showNotification(`تم إنشاء الغرفة بنجاح! كود الغرفة: ${finalId}`);
        showView('view-draft');
        FirebaseEngine.listenToRoom(finalId, handleRoomStateUpdate);
      })
      .catch(err => {
        console.error('Firebase Room Error:', err);
        showNotification(roomErrorMessage(err));
      });
  });

  btnJoinRoom?.addEventListener('click', (e) => {
    if (e) e.preventDefault();
    const nameVal = requireName();
    if (!nameVal) return;
    myPlayerName = nameVal;
    localStorage.setItem('dond_player_name', nameVal);

    const roomId = joinRoomIdInput.value.trim();
    if (!roomId) {
      showNotification('⚠️ اكتب كود الغرفة أولاً.');
      joinRoomIdInput.focus();
      return;
    }

    safePlaySound('playClick');

    FirebaseEngine.joinRoom(roomId, myPlayerName)
      .then(finalId => {
        currentRoomId = finalId;
        sessionStorage.setItem('active_room_id', finalId);
        sessionStorage.setItem('active_player_name', myPlayerName);
        showNotification(`تم الانضمام للغرفة بنجاح! كود الغرفة: ${finalId}`);
        showView('view-draft');
        FirebaseEngine.listenToRoom(finalId, handleRoomStateUpdate);
      })
      .catch(err => {
        console.error('Firebase Room Error:', err);
        showNotification(roomErrorMessage(err));
      });
  });

  if (btnPlayAi) {
    btnPlayAi.addEventListener('click', (e) => {
      if (e) e.preventDefault();
      const nameVal = requireName();
      if (!nameVal) return;
      myPlayerName = nameVal;
      localStorage.setItem('dond_player_name', nameVal);
      safePlaySound('playClick');

      FirebaseEngine.enterAiRoom(myPlayerName, getSelectedSquadMode())
        .then(aiId => {
          currentRoomId = aiId;
          sessionStorage.setItem('active_room_id', aiId);
          sessionStorage.setItem('active_player_name', myPlayerName);
          showNotification('🤖 تم بدء المباراة الفردية ضد البوت الذكي! حظ سعيد.');
          showView('view-draft');
          FirebaseEngine.listenToRoom(aiId, handleRoomStateUpdate);
        })
        .catch(err => {
          console.error('Firebase AI Room Error:', err);
          showNotification(roomErrorMessage(err));
        });
    });
  }

  btnCopyCode?.addEventListener('click', () => {
    if (roomState && roomState.roomId) {
      navigator.clipboard.writeText(roomState.roomId);
      showNotification(`تم نسخ كود الغرفة: ${roomState.roomId}`);
    }
  });

  const btnCopyInviteLink = document.getElementById('btn-copy-invite-link');
  if (btnCopyInviteLink) {
    btnCopyInviteLink.addEventListener('click', () => {
      if (!roomState || !roomState.roomId) return;
      const inviteUrl = `${location.origin}${location.pathname}?room=${roomState.roomId}`;
      navigator.clipboard.writeText(inviteUrl);
      showNotification('🔗 اتنسخ رابط الدعوة! ابعته لصاحبك يدخل يكتب اسمه ويلعب فورًا.');
    });
  }

  // Deep links (?room=xxxx) & session restore. Works in any browser - this
  // used to be trapped inside a `window.Telegram.WebApp` guard, which meant
  // a shared link or a mid-game refresh silently did nothing outside the
  // Telegram Mini App.
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const startParam = urlParams.get('room');
    const modeParam = urlParams.get('mode');

    // Session Restore Auto-Join
    const savedRoomId = sessionStorage.getItem('active_room_id');
    const savedPlayerName = sessionStorage.getItem('active_player_name');

    if (savedRoomId && savedPlayerName && !startParam) {
      myPlayerName = savedPlayerName;
      currentRoomId = savedRoomId;
      if (playerNameInput) playerNameInput.value = myPlayerName;
      showNotification(`استعادة الجلسة: جاري العودة للغرفة ${savedRoomId}...`);
      FirebaseEngine.enterRoom(savedRoomId, myPlayerName)
        .then(finalId => {
          showView('view-draft');
          FirebaseEngine.listenToRoom(finalId, handleRoomStateUpdate);
        })
        .catch(() => {
          sessionStorage.removeItem('active_room_id');
        });
    } else if (startParam && startParam.length > 0) {
      if (joinRoomIdInput) joinRoomIdInput.value = startParam;
      const savedName = localStorage.getItem('dond_player_name');
      if (savedName && playerNameInput) {
        // Name already known from a previous visit - join immediately,
        // no extra click needed for an invite link to actually work.
        playerNameInput.value = savedName;
        showNotification(`رابط دعوة من صاحبك - جاري الانضمام للغرفة ${startParam}...`);
        setTimeout(() => { if (btnJoinRoom) btnJoinRoom.click(); }, 400);
      } else if (playerNameInput) {
        // First-time visitor: the only thing standing between them and the
        // game is their name - put the cursor right there instead of
        // leaving them to notice the join button on their own.
        showNotification('📨 رابط دعوة من صاحبك! اكتب اسمك وانضم فورًا.');
        playerNameInput.focus();
        playerNameInput.placeholder = 'اكتب اسمك للانضمام لغرفة صاحبك';
      }
    }

    if (modeParam === 'ai') {
      setTimeout(() => {
        if (btnPlayAi) btnPlayAi.click();
      }, 600);
    }
  } catch (err) {
    console.log('Deep link init notice:', err);
  }

  btnSoundToggle?.addEventListener('click', () => {
    if (!window.soundFX) return;
    const isMuted = window.soundFX.toggleMute();
    btnSoundToggle.textContent = isMuted ? '🔇' : '🔊';
    showNotification(isMuted ? 'تم كتم الصوت 🔇' : 'تم تشغيل الصوت 🔊');
  });

  // Emoji & Chat Logic - sends through FirebaseEngine.sendEmoji(), which
  // writes to dond_rooms/{id}/lastEmoji. This bar used to check a
  // FirebaseEngine.db property that never existed and write to a
  // completely different, unread path, so it never sent anything.
  const emojiBtns = document.querySelectorAll('.emoji-btn, .chat-btn');
  emojiBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentRoomId) return;
      const msg = btn.getAttribute('data-emoji') || btn.getAttribute('data-msg');
      if (typeof FirebaseEngine !== 'undefined' && msg) {
        FirebaseEngine.sendEmoji(currentRoomId, msg);
      }
      triggerHaptic([20]);
    });
  });

  function renderFloatingEmoji(symbol) {
    const el = document.createElement('div');
    el.className = 'floating-emoji-item';
    el.textContent = symbol;
    el.style.left = `${15 + Math.random() * 70}%`;
    emojiFloatingContainer.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // Live text chat - stored as a capped array on the room object itself
  // (dond_rooms/{id}/chat), same "one listener, whole room" pattern as the
  // rest of the engine instead of a second Firebase listener.
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
    FirebaseEngine.sendChatMessage(currentRoomId, myPlayerName, text);
    chatInput.value = '';
  });

  function renderChatMessages(messages) {
    if (messages.length === lastRenderedChatCount) return;
    const isNewIncoming = messages.length > lastRenderedChatCount;
    const newestIsMine = isNewIncoming && messages[messages.length - 1]?.senderId === FirebaseEngine.myPlayerId;
    lastRenderedChatCount = messages.length;

    chatMessagesEl.innerHTML = messages.map(m => `
      <div class="chat-msg ${m.senderId === FirebaseEngine.myPlayerId ? 'mine' : ''}">
        <span class="chat-sender">${esc(m.senderName)}</span>${esc(m.text)}
      </div>
    `).join('');
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    if (isNewIncoming && !newestIsMine) {
      if (!chatPanelOpen) chatUnreadDot.classList.remove('hidden');
      triggerHaptic([15]);
    }
  }

  function leaveCurrentRoom() {
    if (typeof VoiceChat !== 'undefined') VoiceChat.cleanup();
    if (typeof FirebaseEngine !== 'undefined') FirebaseEngine.leaveRoom();
    sessionStorage.removeItem('active_room_id');
    sessionStorage.removeItem('active_player_name');
    roomState = null;
    currentRoomId = null;
    myRole = 'spectator';
    lastRenderedChatCount = 0;
    lastNotifiedHelperCardId = null;
    chatPanelOpen = false;
    chatPanel.classList.add('hidden');
    btnToggleChat.classList.add('hidden');
    btnToggleMic.classList.add('hidden');
    btnLeaveRoom.classList.add('hidden');
    roomInfoBar.classList.add('hidden');
    btnToggleMic.classList.remove('mic-active');
    btnToggleMic.textContent = '🎤';
    voiceVolumeRow.classList.add('hidden');
    showView('view-lobby');
  }

  btnLeaveRoom?.addEventListener('click', () => {
    if (confirm('هتخرج من الغرفة وترجع للقائمة الرئيسية. متابعة؟')) {
      leaveCurrentRoom();
    }
  });

  // Voice call - WebRTC audio between host and guest, signaled through the
  // room's own Firebase path (no separate server). Defined in
  // voice-chat.js; guarded here in case that file failed to load.
  if (typeof VoiceChat !== 'undefined') {
    VoiceChat.onStateChange = (state) => {
      if (state === 'connected' || state === 'completed') {
        showNotification('✅ اتصلت بصاحبك - المكالمة شغالة دلوقتي');
      } else if (state === 'failed') {
        showNotification('🔇 فشل الاتصال الصوتي - جرّب شبكة تانية أو تأكد إنكم الاتنين ضغطتوا زرار المايك');
      } else if (state === 'disconnected') {
        showNotification('🔇 الاتصال الصوتي انقطع');
      } else if (state === 'audio-blocked') {
        showNotification('🔊 المتصفح منع تشغيل الصوت تلقائي - دوس زرار السماعة عشان تسمع صاحبك');
      }
    };
  }

  const VOICE_ERROR_MESSAGES = {
    NotAllowedError: '⚠️ لازم تسمح للمتصفح يستخدم المايك عشان المكالمة تشتغل.',
    NotFoundError: '⚠️ مفيش مايك متاح على الجهاز ده.',
    NotReadableError: '⚠️ حاجة تانية شغالة بالمايك دلوقتي - قفلها وجرب تاني.'
  };

  btnToggleMic?.addEventListener('click', () => {
    if (typeof VoiceChat === 'undefined' || !currentRoomId || myRole === 'spectator') return;
    VoiceChat.toggle(currentRoomId, myRole, roomState?.isAiMode).then(isActive => {
      btnToggleMic.classList.toggle('mic-active', isActive);
      btnToggleMic.textContent = isActive ? '🔴' : '🎤';
      voiceVolumeRow.classList.toggle('hidden', !isActive);
      showNotification(isActive ? '🎤 بندور على صاحبك... هتوصلك رسالة لما تتصل فعلاً' : '🔇 اتقفلت المكالمة');
    }).catch(err => {
      console.log('Voice chat error:', err);
      showNotification(VOICE_ERROR_MESSAGES[err?.name] || '⚠️ مش قادر أوصل للمايك بتاعك - تأكد من إذن المتصفح');
    });
  });

  voiceVolumeSlider?.addEventListener('input', () => {
    const vol = parseInt(voiceVolumeSlider.value, 10) / 100;
    remoteVoiceAudio.volume = vol;
    voiceVolumeLabel.textContent = `${voiceVolumeSlider.value}%`;
  });

  // DRAFT ACTION LISTENERS
  btnDeal?.addEventListener('click', () => {
    triggerHaptic([40, 60, 40]);
    safePlaySound('playDeal');
    FirebaseEngine.confirmDeal(currentRoomId, roomState);
  });

  btnNoDeal?.addEventListener('click', () => {
    triggerHaptic([30, 40]);
    safePlaySound('playClick');
    FirebaseEngine.rejectDeal(currentRoomId, roomState);
  });

  if (btnForceSwap) {
    btnForceSwap.addEventListener('click', () => {
      triggerHaptic([30, 40, 30]);
      safePlaySound('playClick');
      FirebaseEngine.executeForceSwap(currentRoomId, roomState).catch(err => {
        console.error('Force swap error:', err);
        if (err && err.message === 'SLOT_TAKEN') {
          showNotification('🔄 خانة الخصم في المركز ده مليانة بالفعل - جرب في جولة تانية!');
        }
      });
    });
  }

  if (btnAdminReveal) {
    btnAdminReveal.addEventListener('click', () => {
      peekActive = !peekActive;
      safePlaySound('playClick');
      renderDraftView();
    });
  }

  if (btnUseRevealCards) {
    btnUseRevealCards.addEventListener('click', () => {
      if (!roomState || !currentRoomId) return;
      const playerKey = myRole === 'host' ? 'host' : 'guest';
      safePlaySound('playClick');
      FirebaseEngine.useRevealCards(currentRoomId, playerKey)
        .then(() => { peekActive = true; renderDraftView(); })
        .catch(() => showNotification('⚠️ الكارت ده اتستخدم أو مش متاح دلوقتي.'));
    });
  }

  // Strips edition decoration for the report image but keeps the full name
  // (not just surname) - a report row has room for it.
  function reportPlayerName(name) {
    return String(name || '')
      .replace(/\(.*?\)/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, '')
      .trim();
  }

  function fitCanvasText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  function drawRatingBadge(ctx, cx, cy, rating, color) {
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.font = "bold 12px 'Oswald', 'Cairo', sans-serif";
    ctx.fillStyle = '#04120d';
    ctx.fillText(String(rating), cx, cy + 4);
  }

  // Builds a single shareable PNG "match report" - both full lineups (each
  // player's name AND rating, the realism detail the user asked to also
  // show in the saved image, not just drive the simulation math) plus the
  // score, MVP, stats and event log. Pure Canvas 2D, no external assets.
  async function buildMatchReportCanvas(exportData) {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { /* best-effort */ }
    }

    const squadMode = exportData.squadMode === 'full' ? 'full' : 'classic';
    const slots = squadMode === 'full' ? POSITION_SLOTS_FULL : POSITION_SLOTS_CLASSIC;
    const events = exportData.events || [];

    const width = 1000;
    const rowH = 30;
    const headerH = 200;
    const statsH = 90;
    const squadsHeaderH = 40;
    const squadsH = squadsHeaderH + slots.length * rowH + 20;
    const eventsHeaderH = 44;
    const eventRowH = 38;
    const eventsH = eventsHeaderH + Math.max(events.length, 1) * eventRowH + 20;
    const footerH = 50;
    const height = headerH + statsH + squadsH + eventsH + footerH;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.direction = 'rtl';

    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, '#0c1f18');
    bgGrad.addColorStop(1, '#050b09');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, width - 12, height - 12);

    const hostName = exportData.squads.host.name || 'المستضيف';
    const guestName = exportData.squads.guest.name || 'الضيف';

    let y = 44;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#d4af37';
    ctx.font = "bold 30px 'Cairo', Tahoma, sans-serif";
    ctx.fillText('🏆 تقرير المباراة', width / 2, y);

    y += 26;
    ctx.font = "14px 'Cairo', Tahoma, sans-serif";
    ctx.fillStyle = '#9fb0a6';
    let dateStr = '';
    try { dateStr = new Date(exportData.savedAt).toLocaleString('ar-EG'); } catch (e) { dateStr = exportData.savedAt || ''; }
    ctx.fillText(dateStr, width / 2, y);

    y += 42;
    ctx.font = "bold 22px 'Cairo', Tahoma, sans-serif";
    ctx.fillStyle = '#59d5c8';
    ctx.fillText(fitCanvasText(ctx, hostName, 300), width * 0.75, y);
    ctx.fillStyle = '#3ccb6f';
    ctx.fillText(fitCanvasText(ctx, guestName, 300), width * 0.25, y);

    y += 56;
    ctx.font = "bold 56px 'Oswald', 'Cairo', sans-serif";
    ctx.fillStyle = '#d4af37';
    // ctx.direction is 'rtl' for the Arabic text elsewhere on this canvas,
    // but a bare "6 - 0" under RTL is exactly the digit-neutral-digit
    // pattern the bidi algorithm can silently flip to "0 - 6" - force ltr
    // for this one draw. Guest-first (not host-first) because guestName is
    // drawn on the LEFT (width*0.25) and hostName on the RIGHT (width*0.75)
    // above - under forced LTR the first number in the string lands on the
    // left, so it has to be guest's to sit under guest's own name.
    ctx.direction = 'ltr';
    ctx.fillText(`${exportData.finalScore.guest} - ${exportData.finalScore.host}`, width / 2, y);
    ctx.direction = 'rtl';

    y += 34;
    ctx.font = "16px 'Cairo', Tahoma, sans-serif";
    ctx.fillStyle = '#f5f7f0';
    let winnerText = '🤝 تعادل';
    if (exportData.winner === 'host') winnerText = `🏆 فاز ${hostName}`;
    if (exportData.winner === 'guest') winnerText = `🏆 فاز ${guestName}`;
    ctx.fillText(fitCanvasText(ctx, winnerText, width - 80), width / 2, y);

    y = headerH + 20;
    if (exportData.stats) {
      const [hp, gp] = exportData.stats.possession || [50, 50];
      const [hs, gs] = exportData.stats.shots || [0, 0];
      const [hot, got] = exportData.stats.shotsOnTarget || [0, 0];
      ctx.font = "14px 'Cairo', Tahoma, sans-serif";
      ctx.fillStyle = '#9fb0a6';
      ctx.fillText(`الاستحواذ  ${hp}% - ${gp}%`, width / 2, y);
      y += 24;
      ctx.fillText(`التسديدات  ${hs} - ${gs}    |    على المرمى  ${hot} - ${got}`, width / 2, y);
      y += 24;
    }
    if (exportData.mvp && exportData.mvp.name) {
      ctx.font = "bold 16px 'Cairo', Tahoma, sans-serif";
      ctx.fillStyle = '#d4af37';
      ctx.fillText(`🌟 أفضل لاعب في المباراة: ${reportPlayerName(exportData.mvp.name)} (${exportData.mvp.rating || '-'})`, width / 2, y);
    }

    y = headerH + statsH;
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.25)';
    ctx.beginPath();
    ctx.moveTo(30, y);
    ctx.lineTo(width - 30, y);
    ctx.stroke();

    // Two squad columns - host on the right, guest on the left (mirrors the
    // in-app pitch map's host/guest halves), each row showing position,
    // full player name, AND rating badge per slot.
    const centerX = width / 2;
    const hostColRight = width - 40;
    const hostColLeft = centerX + 20;
    const guestColLeft = 40;
    const guestColRight = centerX - 20;

    let sy = y + 30;
    ctx.textAlign = 'right';
    ctx.font = "bold 18px 'Cairo', Tahoma, sans-serif";
    ctx.fillStyle = '#59d5c8';
    ctx.fillText(`🧢 تشكيلة ${fitCanvasText(ctx, hostName, hostColRight - hostColLeft - 20)}`, hostColRight, sy);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#3ccb6f';
    ctx.fillText(`🧢 تشكيلة ${fitCanvasText(ctx, guestName, guestColRight - guestColLeft - 20)}`, guestColLeft, sy);

    const squadTop = sy + squadsHeaderH - 4;
    slots.forEach((slotKey, i) => {
      const rowY = squadTop + i * rowH;
      const hostP = exportData.squads.host.squad ? exportData.squads.host.squad[slotKey] : null;
      const guestP = exportData.squads.guest.squad ? exportData.squads.guest.squad[slotKey] : null;
      const label = SLOT_LABELS[slotKey] || slotKey;

      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(30, rowY - rowH * 0.68, width - 60, rowH - 4);
      }

      // Host row: [label] outer-right, [rating badge] inner-left, [name] between.
      ctx.textAlign = 'right';
      ctx.font = "12px 'Cairo', Tahoma, sans-serif";
      ctx.fillStyle = '#9fb0a6';
      ctx.fillText(label, hostColRight, rowY);
      if (hostP) {
        drawRatingBadge(ctx, hostColLeft + 16, rowY - 4, hostP.rating, '#59d5c8');
        ctx.textAlign = 'right';
        ctx.font = "bold 14px 'Cairo', Tahoma, sans-serif";
        ctx.fillStyle = '#f5f7f0';
        ctx.fillText(fitCanvasText(ctx, reportPlayerName(hostP.name), hostColRight - hostColLeft - 100), hostColRight - 60, rowY);
      } else {
        ctx.textAlign = 'right';
        ctx.font = "13px 'Cairo', Tahoma, sans-serif";
        ctx.fillStyle = '#5c6b63';
        ctx.fillText('---', hostColRight - 60, rowY);
      }

      // Guest row: mirrored.
      ctx.textAlign = 'left';
      ctx.font = "12px 'Cairo', Tahoma, sans-serif";
      ctx.fillStyle = '#9fb0a6';
      ctx.fillText(label, guestColLeft, rowY);
      if (guestP) {
        drawRatingBadge(ctx, guestColRight - 16, rowY - 4, guestP.rating, '#3ccb6f');
        ctx.textAlign = 'left';
        ctx.font = "bold 14px 'Cairo', Tahoma, sans-serif";
        ctx.fillStyle = '#f5f7f0';
        ctx.fillText(fitCanvasText(ctx, reportPlayerName(guestP.name), guestColRight - guestColLeft - 100), guestColLeft + 60, rowY);
      } else {
        ctx.textAlign = 'left';
        ctx.font = "13px 'Cairo', Tahoma, sans-serif";
        ctx.fillStyle = '#5c6b63';
        ctx.fillText('---', guestColLeft + 60, rowY);
      }
    });

    y = squadTop + slots.length * rowH + 24;
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.25)';
    ctx.beginPath();
    ctx.moveTo(30, y);
    ctx.lineTo(width - 30, y);
    ctx.stroke();

    y += 30;
    ctx.textAlign = 'center';
    ctx.font = "bold 17px 'Cairo', Tahoma, sans-serif";
    ctx.fillStyle = '#d4af37';
    ctx.fillText('⚡ أحداث المباراة', width / 2, y);

    y += 20;
    events.forEach((evt) => {
      const icon = EVENT_TYPE_ICON[evt.type] || '📣';
      const caption = eventCaption(evt);
      const isHost = evt.team !== 'guest';
      const dotColor = isHost ? '#59d5c8' : '#3ccb6f';

      ctx.textAlign = 'right';
      ctx.font = "bold 12px 'Oswald', 'Cairo', sans-serif";
      ctx.fillStyle = '#d4af37';
      ctx.fillText(`${evt.minute}'`, width - 40, y);

      ctx.beginPath();
      ctx.arc(width - 66, y - 4, 4, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();

      // Player name and Arabic caption are drawn as two SEPARATE fillText
      // calls (not concatenated into one string) - a mixed Latin-name +
      // Arabic-caption run inside one RTL string gets bidi-reordered by the
      // canvas text engine (runs swap visual order), which the live HTML
      // feed never hits because each piece already lives in its own
      // element. Two isolated draws sidesteps that entirely.
      ctx.textAlign = 'right';
      ctx.font = "bold 13px 'Cairo', Tahoma, sans-serif";
      ctx.fillStyle = '#f5f7f0';
      const nameLine = `${icon} ${reportPlayerName(evt.player || '')}`;
      ctx.fillText(fitCanvasText(ctx, nameLine, width - 170), width - 78, y);

      ctx.textAlign = 'left';
      ctx.font = "11px 'Oswald', 'Cairo', sans-serif";
      ctx.fillStyle = '#9fb0a6';
      // Same digit-neutral-digit bidi risk as the big score above.
      ctx.direction = 'ltr';
      ctx.fillText(evt.score || '', 40, y);
      ctx.direction = 'rtl';

      y += 17;
      ctx.textAlign = 'right';
      ctx.font = "11px 'Cairo', Tahoma, sans-serif";
      ctx.fillStyle = '#9fb0a6';
      ctx.fillText(fitCanvasText(ctx, caption, width - 170), width - 78, y);

      y += eventRowH - 17;
    });

    y += 14;
    ctx.textAlign = 'center';
    ctx.font = "12px 'Cairo', Tahoma, sans-serif";
    ctx.fillStyle = '#5c6b63';
    ctx.fillText(`Deal or No Deal Football ⚽ · غرفة ${exportData.roomId || ''}`, width / 2, y);

    return canvas;
  }

  // Downloads a single shareable PNG "match report" built from roomState /
  // matchSimulation - both full lineups with per-player ratings, score,
  // MVP, and the event log. Image only (no JSON file) - the user wants a
  // picture to share, not a data dump. Saved to the device, no server
  // storage.
  if (btnSaveMatch) {
    btnSaveMatch.addEventListener('click', async () => {
      if (!roomState) return;
      safePlaySound('playClick');
      const sim = roomState.matchSimulation || {};
      const exportData = {
        savedAt: new Date().toISOString(),
        roomId: roomState.roomId,
        squadMode: roomState.squadMode || 'classic',
        winner: roomState.winner || 'draw',
        finalScore: { host: sim.hostGoals || 0, guest: sim.guestGoals || 0 },
        mvp: sim.mvpPlayer || null,
        stats: sim.stats || null,
        events: sim.events || [],
        squads: {
          host: { name: roomState.host?.name, squad: roomState.host?.squad },
          guest: { name: roomState.guest?.name, squad: roomState.guest?.squad }
        }
      };
      const dateStr = new Date().toISOString().slice(0, 10);

      try {
        const canvas = await buildMatchReportCanvas(exportData);
        canvas.toBlob((imgBlob) => {
          if (!imgBlob) return;
          const imgUrl = URL.createObjectURL(imgBlob);
          const imgA = document.createElement('a');
          imgA.href = imgUrl;
          imgA.download = `match-${roomState.roomId || 'game'}-${dateStr}.png`;
          document.body.appendChild(imgA);
          imgA.click();
          imgA.remove();
          URL.revokeObjectURL(imgUrl);
          showNotification('💾 اتحفظت صورة المباراة على جهازك!');
        }, 'image/png');
      } catch (err) {
        console.warn('Match report image generation failed:', err);
        showNotification('⚠️ تعذّر إنشاء صورة المباراة على المتصفح ده');
      }
    });
  }

  btnRematch?.addEventListener('click', () => {
    triggerHaptic([30, 40]);
    safePlaySound('playClick');
    if (resultModalTimeoutId) { clearTimeout(resultModalTimeoutId); resultModalTimeoutId = null; }
    // NOTE: active_room_id is intentionally kept in sessionStorage here - the
    // room is still alive after a rematch, so a refresh should still restore
    // it (clearing it here used to break refresh-recovery right after rematch).
    FirebaseEngine.restartGame(currentRoomId);
  });

  // REALTIME FIREBASE STATE LISTENER

  function handleRoomStateUpdate(updatedState) {
    roomState = updatedState;
    if (!roomState) return;

    // Floating emoji reactions from the other player(s).
    const lastEmoji = roomState.lastEmoji;
    if (lastEmoji && lastEmoji.timestamp > lastProcessedEmojiTimestamp) {
      lastProcessedEmojiTimestamp = lastEmoji.timestamp;
      if (lastEmoji.senderId !== FirebaseEngine.myPlayerId) {
        renderFloatingEmoji(lastEmoji.symbol);
      }
    }

    // Determine myRole dynamically with 100% precision from Firebase Player IDs
    if (roomState.host && roomState.host.id === FirebaseEngine.myPlayerId) {
      myRole = 'host';
    } else if (roomState.guest && roomState.guest.id === FirebaseEngine.myPlayerId) {
      myRole = 'guest';
    } else {
      myRole = 'spectator';
    }

    updateRoomUI();
  }

  // UI RENDER FUNCTIONS

  function updateRoomUI() {
    if (!roomState) return;

    // Header info bar
    roomInfoBar.classList.remove('hidden');
    displayRoomId.textContent = roomState.roomId;
    const currentRoomIdDisplay = document.getElementById('current-room-id-display');
    if (currentRoomIdDisplay) currentRoomIdDisplay.textContent = roomState.roomId;
    spectatorsCount.textContent = `👁️ ${roomState.spectatorsCount || 0}`;

    // Role pill badge
    if (myRole === 'host') {
      userRoleBadge.textContent = 'المستضيف 👑';
      userRoleBadge.style.background = 'var(--neon-blue)';
      spectatorBanner.classList.add('hidden');
    } else if (myRole === 'guest') {
      userRoleBadge.textContent = 'الضيف ⚽';
      userRoleBadge.style.background = 'var(--neon-green)';
      spectatorBanner.classList.add('hidden');
    } else {
      userRoleBadge.textContent = 'مراقب 👁️';
      userRoleBadge.style.background = 'var(--gold-primary)';
      spectatorBanner.classList.remove('hidden');
    }

    // There was previously no way back to the lobby short of a hard
    // reload - once a room existed, sessionStorage restore put you right
    // back into it every time. This is the only exit.
    btnLeaveRoom.classList.remove('hidden');

    // Chat & voice call only make sense between two real people, not
    // against the AI, and not before a guest has actually joined.
    const isRealMultiplayer = !roomState.isAiMode && !!roomState.guest;
    if (isRealMultiplayer && myRole !== 'spectator') {
      btnToggleChat.classList.remove('hidden');
      btnToggleMic.classList.remove('hidden');
    } else {
      btnToggleChat.classList.add('hidden');
      btnToggleMic.classList.add('hidden');
      chatPanel.classList.add('hidden');
      chatPanelOpen = false;
      voiceVolumeRow.classList.add('hidden');
    }
    renderChatMessages(roomState.chat || []);

    if (roomState.status === 'drafting') {
      matchRecorded = false; // Reset for next match
      if ((roomState.positionIndex || 0) === 0 && !roomState.host?.helperCard && !roomState.guest?.helperCard) {
        lastNotifiedHelperCardId = null; // Fresh draft (incl. rematch) - allow helper toasts again
        lastStealNoticeTs = 0;
        lastVoidedNoticeTs = 0;
        stealSelectedMyKey = null;
        stealSelectedOppKey = null;
      }
      hideStealPanels();
      hideProtectPanels();
      hideUpgradePanels();
      showView('view-draft');
      renderDraftView();
      renderSquads();
    } else if (roomState.status === 'pre_match_protect') {
      // Protection is offered first, before steal - see
      // _offerNextProtectionOrSteal in firebase-engine.js.
      hideStealPanels();
      hideUpgradePanels();
      showView('view-draft');
      briefcasesContainer.innerHTML = '';
      decisionPanel.classList.add('hidden');
      currentPositionTitle.textContent = 'قبل صافرة البداية 🛡️';
      currentTurnDesc.textContent = roomState.protectBy === myRole
        ? '🛡️ معاك درع الحماية! دوس على لاعب من تشكيلتك عشان تحصّنه.'
        : '⏳ الخصم بيقرر يحصّن لاعب بدرع الحماية... المباراة هتبدأ بعدها.';
      currentTurnDesc.style.color = 'var(--accent-purple)';
      renderSquads();
      applyProtectModeHighlight();
      renderProtectPanel();
    } else if (roomState.status === 'pre_match_steal') {
      hideProtectPanels();
      hideUpgradePanels();
      showView('view-draft');
      briefcasesContainer.innerHTML = '';
      decisionPanel.classList.add('hidden');
      currentPositionTitle.textContent = 'قبل صافرة البداية 🥷';
      currentTurnDesc.textContent = roomState.stealBy === myRole
        ? '🥷 معاك بطاقة سرقة! قرر تبدّل لاعب ولا تكمل بتشكيلتك زي ما هي.'
        : '⏳ الخصم بيقرر يستخدم بطاقة السرقة... المباراة هتبدأ فور ما يخلص.';
      currentTurnDesc.style.color = 'var(--accent-purple)';
      renderSquads();
      renderStealPanel();
    } else if (roomState.status === 'pre_match_upgrade') {
      // Last pre-match phase, after protection and steal both resolve -
      // see _offerNextMaxUpgradeOrSimulate in firebase-engine.js.
      hideStealPanels();
      hideProtectPanels();
      showView('view-draft');
      briefcasesContainer.innerHTML = '';
      decisionPanel.classList.add('hidden');
      currentPositionTitle.textContent = 'قبل صافرة البداية 🔥';
      currentTurnDesc.textContent = roomState.upgradeBy === myRole
        ? '🔥 معاك ترقية قصوى! دوس على لاعب من تشكيلتك عشان ترقّيه.'
        : '⏳ الخصم بيقرر يرقّي لاعب لأقصى قوة... المباراة هتبدأ بعدها.';
      currentTurnDesc.style.color = 'var(--accent-purple)';
      renderSquads();
      applyProtectModeHighlight();
      renderUpgradePanel();
    } else if (roomState.status === 'simulating' || roomState.status === 'finished') {
      hideStealPanels();
      hideProtectPanels();
      hideUpgradePanels();
      showView('view-simulation');
      renderMatchView();
    }
  }

  function renderDraftView() {
    const isHostTurn = roomState.currentTurn === 'host';
    const activePlayerName = isHostTurn ? roomState.host.name : (roomState.guest ? roomState.guest.name : 'الضيف');

    currentPositionTitle.textContent = roomState.turnState.positionNameAr || 'حارس المرمى';

    hostNameTag.textContent = roomState.host.name;
    guestNameTag.textContent = roomState.guest ? roomState.guest.name : 'في الانتظار...';

    if (isHostTurn) {
      hostNameTag.classList.add('active-turn');
      guestNameTag.classList.remove('active-turn');
      document.getElementById('host-squad-card')?.classList.add('active-turn-box');
      document.getElementById('guest-squad-card')?.classList.remove('active-turn-box');
    } else {
      guestNameTag.classList.add('active-turn');
      hostNameTag.classList.remove('active-turn');
      document.getElementById('guest-squad-card')?.classList.add('active-turn-box');
      document.getElementById('host-squad-card')?.classList.remove('active-turn-box');
    }

    // Turn description
    const isMyTurn = (myRole === 'host' && isHostTurn) || (myRole === 'guest' && !isHostTurn);
    const posName = roomState.turnState.positionNameAr || 'اللاعبين';

    if (isMyTurn) {
      // Pick 2 is only forced when the active player has no unconsumed
      // extra_chance card - otherwise it leads to another Deal/No Deal
      // decision instead of an automatic pick.
      const activePlayerObj = isHostTurn ? roomState.host : roomState.guest;
      const hasExtraChance = activePlayerObj?.helperCard?.id === 'extra_chance';
      let tryLabel = 'المحاولة الأولى';
      if (roomState.turnState.status === 'waiting_pick_2') {
        tryLabel = hasExtraChance ? 'المحاولة الثانية' : 'المحاولة الثانية - إجبارية';
      } else if (roomState.turnState.status === 'waiting_pick_3') {
        tryLabel = 'المحاولة الثالثة - إجبارية (آخر فرصة)';
      }
      currentTurnDesc.textContent = `🎯 دورك الآن لاختيار ${posName}! (${tryLabel})`;
      currentTurnDesc.style.color = 'var(--neon-green)';
    } else if (myRole === 'spectator') {
      currentTurnDesc.textContent = `👁️ بث مباشر: متابعة اختيار ${posName} بواسطة اللاعب (${activePlayerName})...`;
      currentTurnDesc.style.color = 'var(--gold-primary)';
    } else {
      currentTurnDesc.textContent = `⏳ دور الخصم (${activePlayerName}) اختيار ${posName}... ستتحول لك الدورة فوراً عند انتهائه!`;
      currentTurnDesc.style.color = 'var(--neon-blue)';
    }

    // Briefcases Rendering
    briefcasesContainer.innerHTML = '';
    const briefcases = roomState.turnState.briefcases || [];

    // Add lock waiting notice if not my turn
    let waitingNotice = document.getElementById('waiting-turn-notice');
    if (!waitingNotice) {
      waitingNotice = document.createElement('div');
      waitingNotice.id = 'waiting-turn-notice';
      waitingNotice.className = 'waiting-notice hidden';
      briefcasesContainer.parentNode.insertBefore(waitingNotice, briefcasesContainer);
    }

    if (myRole === 'host' && !roomState.guest) {
      waitingNotice.classList.remove('hidden');
      waitingNotice.innerHTML = `👑 <strong>أنت المستضيف!</strong> كود الغرفة الخاص بك هو [<strong>${esc(roomState.roomId)}</strong>]. افتح نافذة جديدة واضغط <strong>"الانضمام كـ ضيف ⚽"</strong> وأدخل الكود [<strong>${esc(roomState.roomId)}</strong>] لتبدأ اللعبة بينكما فوراً!`;
    } else if (!isMyTurn && myRole !== 'spectator') {
      waitingNotice.classList.remove('hidden');
      waitingNotice.innerHTML = `👁️ <strong>متابعة سريعة (دور الخصم):</strong> اللاعب (<strong>${esc(activePlayerName)}</strong>) يختار الآن <strong>${esc(posName)}</strong>... ستنقل لك الدورة والاختيارات فور انتهائه!`;
    } else if (myRole === 'spectator') {
      waitingNotice.classList.remove('hidden');
      waitingNotice.innerHTML = `👁️ <strong>بث مباشر (مراقب):</strong> اللاعب (<strong>${esc(activePlayerName)}</strong>) يحدد اختيار <strong>${esc(posName)}</strong> حالياً...`;
    } else {
      waitingNotice.classList.add('hidden');
    }

    // Peek bar: the admin eye (always available to that one account) and
    // the reveal_cards helper card (available to whoever drafted it, once)
    // both end in the same place - showing what's actually under each
    // unrevealed briefcase this round, read straight from data already
    // sitting in roomState (see useRevealCards in firebase-engine.js).
    const myHelperForPeek = isHostTurn ? roomState.host?.helperCard : roomState.guest?.helperCard;
    const roundKey = currentRoomId + ':' + (roomState.positionIndex || 0);
    if (lastPeekRoundKey !== roundKey) {
      lastPeekRoundKey = roundKey;
      peekActive = false;
    }
    if (btnAdminReveal) btnAdminReveal.classList.toggle('hidden', !isAdminPlayer());
    if (btnUseRevealCards) {
      btnUseRevealCards.classList.toggle('hidden', !(isMyTurn && myHelperForPeek?.id === 'reveal_cards' && !peekActive));
    }

    briefcases.forEach((b, index) => {
      const bCard = document.createElement('div');
      bCard.className = `briefcase-card ${b.isRevealed ? 'revealed' : ''} ${!isMyTurn ? 'disabled-turn' : ''}`;

      if (!b.isRevealed) {
        const peekHTML = peekActive && b.item
          ? `<div class="peek-overlay"><span class="peek-rating">${esc(b.item.rating)}</span><span class="peek-name">${esc(reportPlayerName(b.item.name))}</span>${b.helperCard ? `<span class="peek-helper">${esc(HELPER_ICON[b.helperCard.id] || '🎁')}</span>` : ''}</div>`
          : '';
        bCard.innerHTML = `
          <div class="mystery-card-wrapper">
            ${peekHTML}
            <div class="mystery-badge">SPECIAL CARD</div>
            <div class="mystery-qmark">${index + 1}</div>
            <div class="briefcase-num">حقيبة رقم ${index + 1}</div>
          </div>
        `;

        const isDecisionPending = roomState.turnState.status === 'picked_1_pending_deal' || roomState.turnState.status === 'picked_2_pending_deal';
        if (isMyTurn && !isDecisionPending) {
          bCard.style.cursor = 'pointer';
          bCard.onclick = () => {
            safePlaySound('playClick');
            FirebaseEngine.pickBriefcase(currentRoomId, index, roomState);
          };
        } else {
          bCard.style.cursor = 'not-allowed';
          bCard.onclick = isDecisionPending
            ? () => showNotification('⏳ قرّر أول: Deal ولا No Deal؟')
            : null;
        }
      } else {
        // Revealed FIFA Card item
        const item = b.item || {};
        const rating = parseInt(item.rating) || 0;
        const isLegendary = rating >= 90;
        if (isLegendary && isMyTurn) {
            safePlaySound('playGoal'); // Using goal sound for legendary
        }
        const tier = rating >= 90 ? { cls: 'tier-icon', label: 'أيقونة' }
          : rating >= 83 ? { cls: 'tier-gold', label: 'ذهبي' }
          : rating >= 75 ? { cls: 'tier-silver', label: 'فضي' }
          : { cls: 'tier-bronze', label: 'برونزي' };
        bCard.classList.add(tier.cls);
        bCard.innerHTML = `
          ${b.helperCard ? `<div class="helper-tag" title="${esc(b.helperCard.name)}">${esc(HELPER_ICON[b.helperCard.id] || '🎁')}</div>` : ''}
          ${buildPlayerCardHTML(item, roomState.turnState.positionKey, tier.label, isLegendary)}
        `;
      }

      briefcasesContainer.appendChild(bCard);
    });

    // Decision Panel (Deal / No Deal) - also shown on the second pick when
    // the active player is spending an extra_chance card for a third try.
    if (isMyTurn && (roomState.turnState.status === 'picked_1_pending_deal' || roomState.turnState.status === 'picked_2_pending_deal')) {
      decisionPanel.classList.remove('hidden');
      const pickedB = briefcases[roomState.turnState.pickedBriefcaseIndex];
      const activePlayerObj2 = isHostTurn ? roomState.host : roomState.guest;
      if (pickedB && pickedB.item) {
        const canGoAgain = roomState.turnState.status === 'picked_1_pending_deal' && activePlayerObj2?.helperCard?.id === 'extra_chance';
        pickedCardPreview.innerHTML = `
          <div class="fifa-card inline">
            <span class="fifa-rating">${esc(pickedB.item.rating)}</span> -
            <span class="fifa-name">${esc(pickedB.item.name)}</span> (${esc(pickedB.item.club)})
            ${pickedB.helperCard ? `<div class="helper-tag inline" title="${esc(pickedB.helperCard.name)}">${esc(HELPER_ICON[pickedB.helperCard.id] || '🎁')}</div>` : ''}
          </div>
          ${canGoAgain ? `<div class="extra-chance-hint">🎲 معاك "فرصة إضافية" - لو رفضت هتاخد بطاقة تالتة بدل ما تتحسم عليك!</div>` : ''}
        `;
      }
      if (btnForceSwap) {
        btnForceSwap.classList.toggle('hidden', activePlayerObj2?.helperCard?.id !== 'force_swap');
      }
    } else {
      decisionPanel.classList.add('hidden');
      if (btnForceSwap) btnForceSwap.classList.add('hidden');
    }
  }

  // Helper cards used to attach completely silently (protection especially -
  // it only ever showed up as a passive badge). A one-time toast the moment
  // you draft one makes it a real, noticed event instead of an invisible
  // stat bump - lastNotifiedHelperCardId stops it firing again on every
  // re-render while you still hold the same card.
  function notifyHelperCardPickup(helperCard) {
    if (!helperCard || helperCard.id === lastNotifiedHelperCardId) return;
    lastNotifiedHelperCardId = helperCard.id;
    const messages = {
      steal: '🥷 حصلت على كارت سرقة! هتقدر تستخدمه قبل المباراة تبدّل لاعب من الخصم.',
      protection: '🛡️ حصلت على درع الحماية! قبل المباراة هتختار لاعب من تشكيلتك يتحصن ضد السرقة، ودفاعك هيبقى أقوى.',
      extra_chance: '🎲 حصلت على فرصة إضافية! لو رفضت أول بطاقة، هتقدر تجرب تالتة.',
      reveal_cards: '🔍 حصلت على كشف البطاقات! في أي جولة جاية تقدر تستخدمها تشوف الأربع حقائب قبل ما تختار.',
      max_upgrade: '🔥 حصلت على ترقية قصوى! بعد الدرافت هتقدر ترقّي أي لاعب من تشكيلتك لأقصى قوة.'
    };
    showNotification(messages[helperCard.id] || `🎁 حصلت على: ${helperCard.name}`);
  }

  // The stolen-from side used to only find out by chance, if they happened
  // to notice their squad changed on the next render. executeSteal now
  // writes a one-shot notice on the victim's own side; ts-dedupe (same
  // pattern as lastNotifiedHelperCardId) stops it re-firing every re-render.
  function notifyStealVictim(notice) {
    if (!notice || notice.ts === lastStealNoticeTs) return;
    lastStealNoticeTs = notice.ts;
    showNotification(`🥷 ${notice.stealerName} سرقلك ${notice.stolenName} وبدّله بـ ${notice.receivedName}!`);
  }

  // extra_chance/reveal_cards banked but never spent before the draft ended
  // (see _offerNextProtectionOrSteal in firebase-engine.js) get voided
  // server-side with a notice, instead of just silently vanishing.
  function notifyVoidedHelper(notice) {
    if (!notice || notice.ts === lastVoidedNoticeTs) return;
    lastVoidedNoticeTs = notice.ts;
    showNotification(`⌛ كارت "${notice.cardName}" اتلغى لأن الدرافت خلص قبل ما تقدر تستخدمه.`);
  }

  function renderSquads() {
    const myHelperCard = myRole === 'host' ? roomState.host?.helperCard
      : myRole === 'guest' ? roomState.guest?.helperCard
      : null;
    notifyHelperCardPickup(myHelperCard);
    if (myRole !== 'spectator') {
      notifyStealVictim(roomState[myRole]?.lastStealNotice);
      notifyVoidedHelper(roomState[myRole]?.voidedHelperNotice);
    }

    renderLineupStrip(
      lineupStripEl,
      roomState.squadMode,
      roomState.guest?.squad, roomState.guest ? roomState.guest.name : 'في انتظار الضيف...', roomState.guest?.helperCard,
      roomState.host.squad, roomState.host.name, roomState.host.helperCard
    );
  }

  // posKeys/labels depend on squadMode: classic is the original single slot
  // per position, "full" is 2 center-backs + 2 full-backs + 3 midfielders +
  // 3 forwards/wingers + GK + MGR (12 picks). Both draw from the same
  // underlying position pool per basePositionKey() - no separate data set.
  const POSITION_SLOTS_CLASSIC = ['GK', 'DEF', 'MID', 'ATT', 'MGR'];
  const POSITION_SLOTS_FULL = ['GK', 'DEF1', 'DEF2', 'DEF3', 'DEF4', 'MID1', 'MID2', 'MID3', 'ATT1', 'ATT2', 'ATT3', 'MGR'];
  const SLOT_LABELS = {
    GK: 'حارس', DEF: 'مدافع', MID: 'وسط', ATT: 'مهاجم', MGR: 'مدرب',
    DEF1: 'قلب دفاع 1', DEF2: 'قلب دفاع 2', DEF3: 'ظهير 1', DEF4: 'ظهير 2',
    MID1: 'وسط 1', MID2: 'وسط 2', MID3: 'وسط 3',
    ATT1: 'مهاجم 1', ATT2: 'مهاجم 2', ATT3: 'مهاجم 3'
  };

  // Row-based lineup: every slot (including MGR - folded into the same list
  // instead of a separate dugout element) is a full-width row, so there is
  // no percentage-position math left to collide, at any screen size or
  // player count - guest's XI on top, host's below a halfway divider.
  function renderLineupStrip(container, squadMode, guestSquad, guestName, guestHelperCard, hostSquad, hostName, hostHelperCard) {
    if (!container) return;
    const posKeys = squadMode === 'full' ? POSITION_SLOTS_FULL : POSITION_SLOTS_CLASSIC;
    // Selection odds are literally uniform (HELPER_CARDS[random index]) -
    // computed, not hardcoded, so it stays correct if a card gets added.
    const cardOddsPct = Math.round(100 / HELPER_CARDS.length);

    function buildGroup(teamKey, squad, name, helperCard) {
      const rows = posKeys.map((key) => {
        const item = squad ? squad[key] : null;
        const label = SLOT_LABELS[key] || key;
        const badge = item
          ? `<div class="rating-badge ${teamKey}">${esc(item.rating)}</div>`
          : `<div class="rating-badge empty">?</div>`;
        const pname = item ? esc(reportPlayerName(item.name)) : '---';
        // data-poskey/data-team let the protection-selection click handler
        // (event-delegated on the container, since this HTML is rebuilt on
        // every render) identify which row was pressed without re-binding
        // a listener per row per render.
        return `<div class="strip-row${item ? '' : ' empty'}" data-poskey="${esc(key)}" data-team="${teamKey}"><span class="pos-chip">${esc(label)}</span>${badge}<span class="pname">${pname}</span></div>`;
      }).join('');
      // Only the card's own owner ever sees its name here - the opponent
      // used to see it too (both squads were always passed in full,
      // unfiltered by viewer role), which spoiled any card that's supposed
      // to be a surprise (steal, forced swap). A spectator sees neither.
      let helperHTML = '';
      if (helperCard && teamKey === myRole) {
        helperHTML = ` <span class="helper-badge">${esc(helperCard.name)} <small>(${cardOddsPct}%)</small></span>`;
      } else if (helperCard) {
        helperHTML = ` <span class="helper-badge helper-badge-hidden">🎴 كارت مساعدة</span>`;
      }
      const teamIcon = teamKey === 'host' ? '👑' : '⚽';
      return `
        <div class="strip-group ${teamKey}">
          <div class="strip-head ${teamKey}">${teamIcon} ${esc(name)}${helperHTML}</div>
          ${rows}
        </div>
      `;
    }

    container.innerHTML =
      buildGroup('guest', guestSquad, guestName, guestHelperCard) +
      '<div class="strip-mid-line">خط المنتصف</div>' +
      buildGroup('host', hostSquad, hostName, hostHelperCard);
  }

  // Marks the current player's own non-empty, non-MGR rows as clickable
  // during the pre-match protection choice - "press a player from your
  // squad to shield them" is the literal interaction that was asked for,
  // reusing the lineup rows instead of a separate dropdown panel.
  // Shared by protection (shield a slot) and max_upgrade (max a slot) -
  // both are "press a player from your own lineup" interactions, just with
  // different target CSS classes and a different FirebaseEngine call.
  function applyProtectModeHighlight() {
    const isMyProtectTurn = roomState?.status === 'pre_match_protect' && roomState.protectBy === myRole;
    const isMyUpgradeTurn = roomState?.status === 'pre_match_upgrade' && roomState.upgradeBy === myRole;
    lineupStripEl?.querySelectorAll('.strip-row').forEach((row) => {
      const isMine = row.dataset.team === myRole;
      const hasPlayer = !row.classList.contains('empty');
      row.classList.toggle('protect-selectable', isMyProtectTurn && isMine && hasPlayer);
      row.classList.toggle('upgrade-selectable', isMyUpgradeTurn && isMine && hasPlayer);
    });
  }

  if (lineupStripEl) {
    lineupStripEl.addEventListener('click', (e) => {
      if (!currentRoomId) return;
      const protectRow = e.target.closest('.strip-row.protect-selectable');
      if (protectRow?.dataset.poskey) {
        safePlaySound('playClick');
        FirebaseEngine.executeProtection(currentRoomId, myRole, protectRow.dataset.poskey);
        return;
      }
      const upgradeRow = e.target.closest('.strip-row.upgrade-selectable');
      if (upgradeRow?.dataset.poskey) {
        safePlaySound('playClick');
        FirebaseEngine.executeMaxUpgrade(currentRoomId, myRole, upgradeRow.dataset.poskey);
      }
    });
  }

  // PRE-MATCH PROTECTION PANEL - waits indefinitely for the player to act
  // (protect/skip), no auto-skip timer.
  const protectActionPanel = document.getElementById('protect-action-panel');
  const protectWaitingPanel = document.getElementById('protect-waiting-panel');
  const btnSkipProtect = document.getElementById('btn-skip-protect');

  function hideProtectPanels() {
    if (protectActionPanel) protectActionPanel.classList.add('hidden');
    if (protectWaitingPanel) protectWaitingPanel.classList.add('hidden');
  }

  function renderProtectPanel() {
    if (!roomState || roomState.status !== 'pre_match_protect') return;
    const iAmProtector = roomState.protectBy === myRole;

    if (!iAmProtector) {
      if (protectActionPanel) protectActionPanel.classList.add('hidden');
      if (protectWaitingPanel) protectWaitingPanel.classList.remove('hidden');
      return;
    }

    if (protectWaitingPanel) protectWaitingPanel.classList.add('hidden');
    if (protectActionPanel) protectActionPanel.classList.remove('hidden');
  }

  if (btnSkipProtect) {
    btnSkipProtect.addEventListener('click', () => {
      if (!currentRoomId) return;
      safePlaySound('playClick');
      FirebaseEngine.skipProtection(currentRoomId);
    });
  }

  // PRE-MATCH MAX UPGRADE PANEL - last pre-match phase, same shape as
  // protection above.
  const upgradeActionPanel = document.getElementById('upgrade-action-panel');
  const upgradeWaitingPanel = document.getElementById('upgrade-waiting-panel');
  const btnSkipUpgrade = document.getElementById('btn-skip-upgrade');

  function hideUpgradePanels() {
    if (upgradeActionPanel) upgradeActionPanel.classList.add('hidden');
    if (upgradeWaitingPanel) upgradeWaitingPanel.classList.add('hidden');
  }

  function renderUpgradePanel() {
    if (!roomState || roomState.status !== 'pre_match_upgrade') return;
    const iAmUpgrader = roomState.upgradeBy === myRole;

    if (!iAmUpgrader) {
      if (upgradeActionPanel) upgradeActionPanel.classList.add('hidden');
      if (upgradeWaitingPanel) upgradeWaitingPanel.classList.remove('hidden');
      return;
    }

    if (upgradeWaitingPanel) upgradeWaitingPanel.classList.add('hidden');
    if (upgradeActionPanel) upgradeActionPanel.classList.remove('hidden');
  }

  if (btnSkipUpgrade) {
    btnSkipUpgrade.addEventListener('click', () => {
      if (!currentRoomId) return;
      safePlaySound('playClick');
      FirebaseEngine.skipMaxUpgrade(currentRoomId);
    });
  }

  // PRE-MATCH STEAL PANEL - same click-a-row-in-the-lineup-strip pattern as
  // protection/max_upgrade above (applyProtectModeHighlight), instead of the
  // old two <select> dropdowns: click your own player first, then the
  // opponent's player you want, then confirm in a modal before it commits.
  const stealActionPanel = document.getElementById('steal-action-panel');
  const stealWaitingPanel = document.getElementById('steal-waiting-panel');
  const stealInstruction = document.getElementById('steal-instruction');
  const btnSkipSteal = document.getElementById('btn-skip-steal');
  const stealInputsRow = document.querySelector('#steal-action-panel .steal-inputs');
  const stealProtectedNote = document.getElementById('steal-protected-note');
  const stealTargetProtected = document.getElementById('steal-target-protected');
  const btnSkipStealProtected = document.getElementById('btn-skip-steal-protected');
  const stealConfirmModal = document.getElementById('steal-confirm-modal');
  const stealConfirmText = document.getElementById('steal-confirm-text');
  const btnStealConfirmYes = document.getElementById('btn-steal-confirm-yes');
  const btnStealConfirmAgain = document.getElementById('btn-steal-confirm-again');
  const btnStealConfirmClose = document.getElementById('btn-steal-confirm-close');

  let stealSelectedMyKey = null;
  let stealSelectedOppKey = null;

  function hideStealPanels() {
    if (stealActionPanel) stealActionPanel.classList.add('hidden');
    if (stealWaitingPanel) stealWaitingPanel.classList.add('hidden');
    if (stealConfirmModal) stealConfirmModal.classList.add('hidden');
    stealSelectedMyKey = null;
    stealSelectedOppKey = null;
  }

  function applyStealModeHighlight() {
    const isMyStealTurn = roomState?.status === 'pre_match_steal' && roomState.stealBy === myRole;
    const oppRole = myRole === 'host' ? 'guest' : 'host';
    const oppProtectedSlot = roomState?.[oppRole]?.protectedSlot || null;
    lineupStripEl?.querySelectorAll('.strip-row').forEach((row) => {
      const isMine = row.dataset.team === myRole;
      const isOpp = row.dataset.team === oppRole;
      const hasPlayer = !row.classList.contains('empty');
      const isMgr = basePositionKey(row.dataset.poskey) === 'MGR';
      const pickingMy = isMyStealTurn && !stealSelectedMyKey;
      const pickingOpp = isMyStealTurn && !!stealSelectedMyKey;
      row.classList.toggle('steal-my-selectable', pickingMy && isMine && hasPlayer && !isMgr);
      row.classList.toggle('steal-my-picked', isMyStealTurn && isMine && row.dataset.poskey === stealSelectedMyKey);
      row.classList.toggle('steal-opp-selectable',
        pickingOpp && isOpp && hasPlayer && !isMgr && row.dataset.poskey !== oppProtectedSlot);
    });
  }

  function renderStealPanel() {
    if (!roomState || roomState.status !== 'pre_match_steal') return;
    const iAmStealer = roomState.stealBy === myRole;

    if (!iAmStealer) {
      if (stealActionPanel) stealActionPanel.classList.add('hidden');
      if (stealWaitingPanel) stealWaitingPanel.classList.remove('hidden');
      return;
    }

    if (stealWaitingPanel) stealWaitingPanel.classList.add('hidden');
    if (stealActionPanel) stealActionPanel.classList.remove('hidden');

    const oppRole = roomState.stealBy === 'host' ? 'guest' : 'host';
    const oppSquad = roomState[oppRole]?.squad || {};
    const oppProtectedSlot = roomState[oppRole]?.protectedSlot || null;

    // Protection now shields one specific player, not the whole squad - the
    // protected slot is just excluded from selection below. The "nothing to
    // steal" fallback only fires in the edge case where every other
    // opponent slot happens to be empty too.
    const stealableCount = Object.keys(oppSquad)
      .filter(k => basePositionKey(k) !== 'MGR' && oppSquad[k] && k !== oppProtectedSlot).length;
    const noTargetsLeft = stealableCount === 0;
    if (stealInputsRow) stealInputsRow.classList.toggle('hidden', noTargetsLeft);
    if (stealTargetProtected) stealTargetProtected.classList.toggle('hidden', !noTargetsLeft);

    if (!noTargetsLeft) {
      if (stealInstruction) {
        stealInstruction.textContent = stealSelectedMyKey
          ? '🥷 دلوقتي دوس على لاعب الخصم اللي عايز تاخده بدل لاعبك المختار:'
          : '🥷 لديك بطاقة (سرقة لاعب)! دوس على لاعب من تشكيلتك في القائمة على اليمين، وبعدين دوس على لاعب الخصم اللي عايز تاخده (المدرب مستثنى):';
      }
      if (stealProtectedNote) {
        const protectedItem = oppProtectedSlot ? oppSquad[oppProtectedSlot] : null;
        stealProtectedNote.textContent = protectedItem
          ? `🛡️ ${protectedItem.name} محمي - مش هيبان في القائمة`
          : '';
        stealProtectedNote.classList.toggle('hidden', !protectedItem);
      }
      applyStealModeHighlight();
    }
  }

  if (lineupStripEl) {
    lineupStripEl.addEventListener('click', (e) => {
      if (!currentRoomId || !roomState || roomState.status !== 'pre_match_steal') return;

      const myPickedRow = e.target.closest('.strip-row.steal-my-picked');
      if (myPickedRow) {
        // Tapping your own already-picked player again backs out to step 1.
        stealSelectedMyKey = null;
        safePlaySound('playClick');
        applyStealModeHighlight();
        renderStealPanel();
        return;
      }

      const myRow = e.target.closest('.strip-row.steal-my-selectable');
      if (myRow?.dataset.poskey) {
        stealSelectedMyKey = myRow.dataset.poskey;
        safePlaySound('playClick');
        applyStealModeHighlight();
        renderStealPanel();
        return;
      }

      const oppRow = e.target.closest('.strip-row.steal-opp-selectable');
      if (oppRow?.dataset.poskey && stealSelectedMyKey) {
        stealSelectedOppKey = oppRow.dataset.poskey;
        const oppRole = myRole === 'host' ? 'guest' : 'host';
        const myItem = roomState[myRole]?.squad?.[stealSelectedMyKey];
        const oppItem = roomState[oppRole]?.squad?.[stealSelectedOppKey];
        if (stealConfirmText && myItem && oppItem) {
          stealConfirmText.textContent = `هتبدل ${myItem.name} (${myItem.rating}) بـ ${oppItem.name} (${oppItem.rating})؟`;
        }
        safePlaySound('playClick');
        stealConfirmModal?.classList.remove('hidden');
      }
    });
  }

  function closeStealConfirm(clearMyPick) {
    stealConfirmModal?.classList.add('hidden');
    stealSelectedOppKey = null;
    if (clearMyPick) stealSelectedMyKey = null;
    applyStealModeHighlight();
    renderStealPanel();
  }

  if (btnStealConfirmYes) {
    btnStealConfirmYes.addEventListener('click', () => {
      if (!roomState || !currentRoomId || !stealSelectedMyKey || !stealSelectedOppKey) return;
      const myKey = stealSelectedMyKey;
      const oppKey = stealSelectedOppKey;
      stealConfirmModal?.classList.add('hidden');
      safePlaySound('playClick');
      FirebaseEngine.executeSteal(currentRoomId, roomState.stealBy, myKey, oppKey)
        .then(() => { stealSelectedMyKey = null; stealSelectedOppKey = null; })
        .catch(err => {
          console.error('Steal error:', err);
          stealSelectedOppKey = null;
          applyStealModeHighlight();
          if (err && err.message === 'TARGET_PROTECTED') {
            showNotification('🛡️ الخصم محمي بدرع الحماية - مينفعش تسرق منه!');
          }
        });
    });
  }
  if (btnStealConfirmAgain) {
    btnStealConfirmAgain.addEventListener('click', () => closeStealConfirm(false));
  }
  if (btnStealConfirmClose) {
    btnStealConfirmClose.addEventListener('click', () => closeStealConfirm(true));
  }

  if (btnSkipStealProtected) {
    btnSkipStealProtected.addEventListener('click', () => {
      if (!currentRoomId) return;
      safePlaySound('playClick');
      FirebaseEngine.skipSteal(currentRoomId);
    });
  }

  if (btnSkipSteal) {
    btnSkipSteal.addEventListener('click', () => {
      if (!currentRoomId) return;
      safePlaySound('playClick');
      FirebaseEngine.skipSteal(currentRoomId);
    });
  }

  function renderMatchView() {
    simHostName.textContent = roomState.host.name;
    simGuestName.textContent = roomState.guest ? roomState.guest.name : 'الضيف';

    renderLineupStrip(
      mcLineupStripEl,
      roomState.squadMode,
      roomState.guest?.squad, roomState.guest ? roomState.guest.name : 'الضيف', roomState.guest?.helperCard,
      roomState.host.squad, roomState.host.name, roomState.host.helperCard
    );

    if (roomState.matchSimulation) {
      const currentMinute = roomState.matchSimulation.currentTime || 0;
      // Score shown on the scoreboard must track only the goals whose event
      // has actually been revealed on the timeline yet - matchSimulation
      // already holds the final score from the moment the sim starts, so
      // showing it directly spoiled the outcome before any event played.
      if (roomState.status === 'finished') {
        simHostScore.textContent = roomState.matchSimulation.hostGoals;
        simGuestScore.textContent = roomState.matchSimulation.guestGoals;
      } else {
        const revealedGoals = (roomState.matchSimulation.events || [])
          .filter(evt => evt.type === 'GOAL' && evt.minute <= currentMinute);
        const hostSoFar = revealedGoals.filter(evt => evt.team !== 'guest').length;
        const guestSoFar = revealedGoals.filter(evt => evt.team === 'guest').length;
        simHostScore.textContent = hostSoFar;
        simGuestScore.textContent = guestSoFar;
      }
      simTimer.textContent = `${currentMinute}'`;

      // Fresh kickoff (currentTime still 0) - reset the header/tab back to
      // the live view instead of leaving last match's "FT"/summary state
      // showing for the first frame of a rematch.
      if (currentMinute === 0 && roomState.status !== 'finished') {
        if (mcStatusPill) mcStatusPill.classList.remove('ft');
        if (mcStatusText) mcStatusText.textContent = 'مباشر LIVE';
        if (mcSummaryPending) mcSummaryPending.classList.remove('hidden');
        if (mcSummaryContent) mcSummaryContent.classList.add('hidden');
        switchMatchTab('events');
      }

      renderCommentaryFeed(roomState.matchSimulation.events, currentMinute);

      if (roomState.status === 'finished') {
        if (resultModalTimeoutId) clearTimeout(resultModalTimeoutId);
        resultModalTimeoutId = setTimeout(() => {
          resultModalTimeoutId = null;

          if (mcStatusPill) mcStatusPill.classList.add('ft');
          if (mcStatusText) mcStatusText.textContent = 'انتهت FT';
          if (mcSummaryPending) mcSummaryPending.classList.add('hidden');
          if (mcSummaryContent) mcSummaryContent.classList.remove('hidden');
          switchMatchTab('summary');

          const sim = roomState.matchSimulation;
          const stats = sim.stats || { possession: [50, 50], shots: [0, 0], shotsOnTarget: [0, 0] };
          // Guest-first, matching the header scoreboard's order (mc-score is
          // guest-then-host so the LTR-forced digits land next to their own
          // team block) - showing host-first here instead made the exact
          // same match look like it had two different scores on one screen.
          finalScoreText.textContent = `${sim.guestGoals} - ${sim.hostGoals}`;

          if (sim.mvpPlayer) {
            const mvpElem = document.getElementById('mvp-player-name');
            if (mvpElem) {
              mvpElem.textContent = `${sim.mvpPlayer.name} (${sim.mvpPlayer.rating || 90})`;
            }
          }

          if (roomState.winner === 'host') {
            winnerAnnouncement.textContent = `👑 فاز ${roomState.host.name} بالمباراة!`;
            if (myRole === 'host') { launchConfetti(4000); safePlaySound('playDeal'); }
          } else if (roomState.winner === 'guest') {
            winnerAnnouncement.textContent = `⚽ فاز ${roomState.guest ? roomState.guest.name : 'الضيف'} بالمباراة!`;
            if (myRole === 'guest') { launchConfetti(4000); safePlaySound('playDeal'); }
          } else {
            winnerAnnouncement.textContent = `🤝 تعادل حماسي بين الطرفين!`;
            launchConfetti(2500);
          }

          // Record Stats
          if (!matchRecorded && typeof UserProfileManager !== 'undefined') {
            let result = 'draw';
            if (myRole === 'host' && roomState.winner === 'host') result = 'win';
            if (myRole === 'host' && roomState.winner === 'guest') result = 'loss';
            if (myRole === 'guest' && roomState.winner === 'guest') result = 'win';
            if (myRole === 'guest' && roomState.winner === 'host') result = 'loss';
            
            if (myRole !== 'spectator') {
              const gameKey = 'dond_' + (roomState.squadMode === 'full' ? 'full' : 'classic');
              UserProfileManager.recordMatchResult(result, gameKey);
            }
            matchRecorded = true;
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
  }

  // Small icon-per-type badge, matching a real live-score app's event
  // timeline (a ball for goals, gloves for saves, etc.) instead of relying
  // on the flavor text alone to signal what happened.
  const EVENT_TYPE_ICON = {
    GOAL: '⚽', SAVE: '🧤', MISS: '🥅', CARD: '🟨', VAR: '🖥️'
  };

  // Short structured caption per event type - built from fields directly
  // instead of re-parsing the long flavor `text` (which repeats the actor's
  // name), so the secondary line reads like a real broadcast-app caption.
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

  // Center-spine timeline (Yalla Shoot style): a vertical line down the
  // middle, host events branch right, guest events branch left, kickoff
  // sits centered on the spine with no branch.
  function renderCommentaryFeed(events, currentMinute) {
    commentaryFeed.innerHTML = '<div class="spine-line"></div>';

    const initEvt = document.createElement('div');
    initEvt.className = 'spine-evt center';
    initEvt.innerHTML = `
      <div class="spine-chip">🎙️</div>
      <div class="spine-card"><div class="spine-pname">بداية المباراة</div><div class="spine-pcap">صافرة الحكم انطلقت والكرة في الملعب!</div></div>
    `;
    commentaryFeed.appendChild(initEvt);

    (events || []).forEach(evt => {
      if (evt.minute <= currentMinute) {
        const div = document.createElement('div');
        // className is not an HTML sink, but normalize the type so a malformed
        // event object cannot throw and kill the whole feed render.
        const typeClass = String(evt.type || '').toLowerCase();
        const sideClass = evt.team === 'guest' ? 'guest' : 'host';
        div.className = `spine-evt ${typeClass} ${sideClass}`;
        const typeIcon = EVENT_TYPE_ICON[evt.type] || '📣';
        const ratingSuffix = evt.rating ? ` (${esc(evt.rating)})` : '';
        div.innerHTML = `
          <div class="spine-min">${esc(evt.minute)}'</div>
          <div class="spine-chip">${typeIcon}</div>
          <div class="spine-card">
            <div class="spine-pname">${esc(evt.player || '')}${ratingSuffix}</div>
            <div class="spine-pcap">${esc(eventCaption(evt))}</div>
          </div>
        `;
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

  // Back to Hub Button & Swipe Gesture Integration
  const backToHubBtn = document.querySelector('.back-to-hub-btn');
  if (backToHubBtn) {
    backToHubBtn.addEventListener('click', (e) => {
      if (btnLeaveRoom && !btnLeaveRoom.classList.contains('hidden')) {
        e.preventDefault();
        if (confirm('هتخرج من الغرفة وترجع لمركز الألعاب. متابعة؟')) {
          leaveCurrentRoom();
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
          if (confirm('هتخرج من الغرفة وترجع لمركز الألعاب. متابعة؟')) {
            leaveCurrentRoom();
            window.location.href = '/';
          }
        } else {
          window.location.href = '/';
        }
      }
    }
  }, { passive: true });

});

