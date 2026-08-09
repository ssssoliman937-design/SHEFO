// Firebase Realtime Database Engine for Deal or No Deal Football Draft

// Firebase Init using provided Database URL
const firebaseConfig = {
  apiKey: "AIzaSyAuBJweWQ6Gz97wBRxBhK7Pa3LVzSU9HXE",
  authDomain: "cuafa-9f3b6.firebaseapp.com",
  projectId: "cuafa-9f3b6",
  databaseURL: "https://cuafa-9f3b6-default-rtdb.firebaseio.com",
  storageBucket: "cuafa-9f3b6.firebasestorage.app",
  messagingSenderId: "517830998976",
  appId: "1:517830998976:web:29779ba30337baa0732625",
  measurementId: "G-P4GZVJSM96"
};

// The game itself never requires Firebase Auth - you type a name and play.
// Auth (Google sign-in, leaderboard, saved stats) is optional and only turns
// on once real keys replace the placeholders above. auth.js and app.js read
// this flag to decide whether to show the login/leaderboard UI at all.
window.FIREBASE_AUTH_ENABLED = !/^ضع_/.test(firebaseConfig.apiKey);

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// Write-side name cleanup. This is NOT the XSS defence - anyone can write to
// this database straight from a console, so the real escaping happens at render
// time (see public/js/utils.js -> esc()). Here we only keep stored names sane:
// no angle brackets, no control chars, no unbounded length. We strip instead of
// HTML-escaping so the stored value stays human-readable for the many places
// that render names via textContent.
function sanitizeName(str) {
  var cleaned = String(str || '')
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return cleaned || 'لاعب';
}

// Persistent per-tab player id. This is the ONLY identity the room logic
// relies on - it stays the same whether or not the player signs in, so two
// tabs signed into the same Google account can still be host+guest of the
// same room (an Auth uid would collide between them).
function getOrCreateSessionPlayerId() {
  let id = sessionStorage.getItem('dond_tab_player_id');
  if (!id) {
    id = 'p_' + Math.random().toString(36).substring(2, 10);
    sessionStorage.setItem('dond_tab_player_id', id);
  }
  return id;
}
const sessionPlayerId = getOrCreateSessionPlayerId();

function getMyPlayerId() {
  return sessionPlayerId;
}

// window.myPlayerId is a getter-only alias for legacy call sites elsewhere
// that read it as a plain property.
Object.defineProperty(window, 'myPlayerId', {
  get: getMyPlayerId
});

// Player cards come from data/players.json, generated into
// public/js/player-database.js by scripts/sync-players.js (npm run build) and
// loaded by index.html BEFORE this file.
if (!window.PLAYER_DATABASE) {
  console.error('player-database.js did not load. Run "npm run build" and check the script order in index.html.');
}
const PLAYER_DATABASE = window.PLAYER_DATABASE || { GK: [], DEF: [], MID: [], ATT: [], MGR: [] };

const HELPER_CARDS = [
  { id: 'steal', name: 'سرقة لاعب 🥷', desc: 'قبل المباراة تقدر تبدّل لاعب من تشكيلتك بآخر من الخصم!' },
  { id: 'protection', name: 'درع الحماية 🛡️', desc: 'اختار لاعب من تشكيلتك يتحصن ضد السرقة + قوة دفاعية +15% أثناء المحاكاة!' },
  { id: 'extra_chance', name: 'فرصة إضافية 🎲', desc: 'تتيح لك تجربة 3 بطاقات بدلاً من بطاقتين!' },
  { id: 'reveal_cards', name: 'كشف البطاقات 🔍', desc: 'استخدمها في أي جولة عشان تشوف الأربع حقائب قبل ما تختار!' },
  { id: 'max_upgrade', name: 'ترقية قصوى 🔥', desc: 'بعد الدرافت، رقّي أي لاعب من تشكيلتك لأقصى قوة (99) مع مهارة خاصة!' },
  { id: 'force_swap', name: 'استبدال إجباري 🔄', desc: 'مش عايز اللاعب اللي طلعلك؟ حطّه إجباري عند الخصم (لو عنده خانة فاضية بنفس المركز) وارسم حقائب جديدة لنفسك!' }
];

// Two squad-building modes. "classic" (default) is the original 4-a-side
// draft, unchanged. "full" is an additive 11-a-side mode (2 center-backs,
// 2 full-backs, 3 midfielders, 3 forwards/wingers - any attacker can play
// either per the brief - plus GK and MGR = 12 picks). Slot keys carry a
// number (DEF1..DEF4) so the rest of the engine can keep treating a squad
// as a flat object instead of introducing array-valued positions.
const POSITIONS_CLASSIC = ['GK', 'DEF', 'MID', 'ATT', 'MGR'];
const POSITIONS_FULL = ['GK', 'DEF1', 'DEF2', 'DEF3', 'DEF4', 'MID1', 'MID2', 'MID3', 'ATT1', 'ATT2', 'ATT3', 'MGR'];
const POSITION_NAMES_AR = {
  GK: 'حارس المرمى 🧤',
  DEF: 'المدافع 🛡️',
  MID: 'خط الوسط ⚽',
  ATT: 'المهاجم 🔥',
  MGR: 'المدرب 📋',
  DEF1: 'قلب دفاع 1 🛡️',
  DEF2: 'قلب دفاع 2 🛡️',
  DEF3: 'ظهير 1 🛡️',
  DEF4: 'ظهير 2 🛡️',
  MID1: 'وسط 1 ⚽',
  MID2: 'وسط 2 ⚽',
  MID3: 'وسط 3 ⚽',
  ATT1: 'مهاجم/جناح 1 🔥',
  ATT2: 'مهاجم/جناح 2 🔥',
  ATT3: 'مهاجم/جناح 3 🔥'
};

function getPositionsForMode(squadMode) {
  return squadMode === 'full' ? POSITIONS_FULL : POSITIONS_CLASSIC;
}

// A slot key like 'DEF3' draws from the same underlying pool as 'DEF' -
// the data set has no center-back/full-back sub-tagging, matching the
// brief's own "any attacker can play winger or striker" flexibility.
function basePositionKey(slotKey) {
  return String(slotKey).replace(/[0-9]+$/, '');
}

// Different cards can be the same real person (e.g. "Karim Benzema" and a
// higher-rated "Karim Benzema" special edition are two different ids in
// the pool) - draft exclusion has to key on the normalized real name, not
// the card id, or the same human could legally turn up twice in one match
// under two different editions, for the same side or opposite sides.
function normPlayerName(name) {
  return String(name || '')
    .replace(/\(.*?\)/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, '')
    .replace(/\bTOTW\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildEmptySquad(squadMode) {
  const squad = {};
  getPositionsForMode(squadMode).forEach(key => { squad[key] = null; });
  return squad;
}

// Picks a random filled player from a base position bucket (works whether
// that base has one slot, like classic DEF, or several, like full mode's
// DEF1..DEF4) - lets match commentary pick a specific defender/midfielder
// each event instead of always naming the same singular slot.
function pickRandomFromBase(squad, baseKey, fallback) {
  const candidates = Object.keys(squad || {})
    .filter(k => basePositionKey(k) === baseKey && squad[k])
    .map(k => squad[k]);
  if (!candidates.length) return fallback;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Same bucket lookup as pickRandomFromBase, but weighted by rating^2 so a
// 91-rated striker is actually the one scoring/saving most of the time
// instead of an 8-rating-point-lower squad-filler getting picked as often -
// realism the user asked for explicitly ("تقييم كل لاعب" driving events).
function pickWeightedFromBase(squad, baseKey, fallback) {
  const candidates = Object.keys(squad || {})
    .filter(k => basePositionKey(k) === baseKey && squad[k])
    .map(k => squad[k]);
  if (!candidates.length) return fallback;
  const weights = candidates.map(p => Math.pow(parseInt(p?.rating) || 70, 2));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// Rarity weight per player: icons/legends (rating >= 90) are a deliberately
// rare pull, not a coin flip - roughly a 1-in-13 draw relative to a gold
// card, so pulling one in a briefcase actually feels like an event. Gold
// tier (83+) pulled back too - tuned harder per explicit feedback that the
// draft was pulling in strong cards too easily.
function rarityWeight(player) {
  const rating = parseInt(player?.rating) || 0;
  if (rating >= 90) return 0.1;
  if (rating >= 83) return 0.8;
  if (rating >= 75) return 1.3;
  return 1.7;
}

// Weighted sample without replacement - the draft pool, so rarity is real
// (biased odds per pull), not cosmetic (uniform pull, rare-looking border).
function getWeightedItems(array, count) {
  const pool = [...array];
  const picked = [];
  while (pool.length && picked.length < count) {
    const weights = pool.map(rarityWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { idx = i; break; }
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

// Picks one {b, idx} entry, weighting toward higher item rating (rating^2.4
// as weight, up from ^2) so a "scouting" AI leans strong more consistently -
// a tougher opponent per explicit difficulty feedback - without ever being
// fully deterministic.
function weightedBriefcasePick(entries) {
  const weights = entries.map(e => Math.pow(e.b.item?.rating || 70, 2.4));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < entries.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return entries[i];
  }
  return entries[entries.length - 1];
}

function calcSquadChemistry(squad) {
  let chem = 0;
  const players = Object.values(squad).filter(Boolean);
  const nations = players.map(p => p.nation);
  const clubs = players.map(p => p.club);

  const nationCounts = {};
  nations.forEach(n => { nationCounts[n] = (nationCounts[n] || 0) + 1; });
  Object.values(nationCounts).forEach(c => { if (c >= 2) chem += (c * 3); });

  const clubCounts = {};
  clubs.forEach(c => { clubCounts[c] = (clubCounts[c] || 0) + 1; });
  Object.values(clubCounts).forEach(c => { if (c >= 2) chem += (c * 4); });

  return Math.min(chem, 20);
}

// Manager tactic text (e.g. "Gegenpressing ⚡", "ركن الباص الفولاذي 🧱") was
// pure flavor before this - drafted, shown on the card, but never actually
// read by the simulation. Keyword-matched instead of an exact lookup table
// since the data has ~18 distinct tactic strings (Arabic + English, some
// icon-manager "شخصية" flavor mixed in) that don't share one naming scheme.
function tacticModifier(tactic) {
  const t = String(tactic || '');
  if (/هجوم|Heavy Metal|Gegenpressing|بريسينج|ضغط عالي|🔺|⚡/.test(t)) {
    return { att: 1.08, def: 0.96, mid: 1 };
  }
  if (/دفاع|الباص|صخري|براغماتي|🧱|⛓️/.test(t)) {
    return { att: 0.94, def: 1.1, mid: 1 };
  }
  if (/Tiki-Taka|استحواذ|🌀/.test(t)) {
    return { att: 1.05, def: 1, mid: 1.08 };
  }
  return { att: 1, def: 1, mid: 1 };
}

// usedPlayerIds (really: used real-person names, see normPlayerName above)
// excludes anyone already drafted this match - by either side, across
// every round, regardless of which specific card/edition they went as -
// so the same real player can never turn up in two briefcases in the same
// room.
function generateBriefcases(positionKey, hasPlayerGivenHelper, usedPlayerIds) {
  const usedSet = usedPlayerIds && usedPlayerIds.length ? new Set(usedPlayerIds) : null;
  const pool = PLAYER_DATABASE[basePositionKey(positionKey)] || [];
  const available = usedSet ? pool.filter(p => !usedSet.has(normPlayerName(p.name))) : pool;
  const selected4 = getWeightedItems(available, 4);

  let helperAssignedIndex = -1;
  if (!hasPlayerGivenHelper && Math.random() < 0.7) {
    helperAssignedIndex = Math.floor(Math.random() * 4);
  }

  return selected4.map((item, index) => {
    let helper = null;
    if (index === helperAssignedIndex) {
      helper = HELPER_CARDS[Math.floor(Math.random() * HELPER_CARDS.length)];
    }
    return {
      cardId: index,
      item: item,
      helperCard: helper,
      isRevealed: false
    };
  });
}

const FirebaseEngine = {
  get myPlayerId() {
    return myPlayerId;
  },

  // Creating a room: fails if the requested code is already taken by someone
  // else's room (instead of silently doing nothing, which used to make the
  // "room created" success message a lie).
  createRoom(roomId, playerName, squadMode) {
    const finalRoomId = roomId && roomId.trim().length > 0
      ? roomId.trim()
      : Math.floor(1000 + Math.random() * 9000).toString();
    const mode = squadMode === 'full' ? 'full' : 'classic';

    const roomRef = db.ref('dond_rooms/' + finalRoomId);
    const sanitizedName = sanitizeName(playerName);

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      // A room code is only truly "taken" if it's still a live game. An idle
      // room (created 6+ hours ago) or one whose match already finished gets
      // recycled instead of permanently squatting the code - there's no
      // backend job that could ever clean these up otherwise (static site,
      // no Cloud Functions), so reclaiming on next use is the only realistic
      // way stale rooms ever get freed.
      const STALE_ROOM_MS = 6 * 60 * 60 * 1000;
      const isStale = room && (
        room.status === 'finished' ||
        !room.createdAt ||
        (Date.now() - room.createdAt) > STALE_ROOM_MS
      );
      if (room && room.host && room.host.id !== myPlayerId && !isStale) {
        throw new Error('ROOM_TAKEN');
      }

      const initialRoom = {
        roomId: finalRoomId,
        status: 'drafting',
        createdAt: Date.now(),
        squadMode: mode,
        usedPlayerIds: [],
        host: {
          id: myPlayerId,
          name: sanitizedName,
          squad: buildEmptySquad(mode),
          helperCard: null
        },
        guest: null,
        spectatorsCount: 0,
        currentTurn: 'host',
        positionIndex: 0,
        turnState: {
          positionKey: 'GK',
          positionNameAr: POSITION_NAMES_AR['GK'],
          briefcases: generateBriefcases('GK', false),
          pickedBriefcaseIndex: null,
          pickNumber: 0,
          status: 'waiting_pick_1'
        },
        matchSimulation: null
      };
      return roomRef.set(initialRoom).then(() => finalRoomId);
    });
  },

  // Joining a room: fails if the room doesn't exist (instead of silently
  // creating a new one under the same code, which orphaned the person who
  // mistyped a code into a game against nobody) or is already full.
  joinRoom(roomId, playerName) {
    const finalRoomId = (roomId || '').trim();
    if (!finalRoomId) return Promise.reject(new Error('EMPTY_CODE'));

    const roomRef = db.ref('dond_rooms/' + finalRoomId);
    const sanitizedName = sanitizeName(playerName);

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room || !room.host) {
        throw new Error('ROOM_NOT_FOUND');
      }
      if (room.host.id === myPlayerId) {
        // Same tab/session rejoining its own room as host.
        return finalRoomId;
      }
      if (room.guest && room.guest.id === myPlayerId) {
        return finalRoomId;
      }
      if (room.guest && room.guest.id !== myPlayerId) {
        // Both seats are taken by someone else - let this visitor in as a
        // spectator instead of hard-blocking them. myRole resolves to
        // 'spectator' automatically once listenToRoom attaches (neither
        // host.id nor guest.id matches), which already drives the existing
        // spectator banner/UI - and "leave room" already lets them back out
        // to try a different code if they'd rather play than watch.
        return finalRoomId;
      }

      const guestData = {
        id: myPlayerId,
        name: sanitizedName,
        squad: buildEmptySquad(room.squadMode),
        helperCard: null
      };
      return roomRef.child('guest').set(guestData).then(() => finalRoomId);
    });
  },

  // Used by session-restore: rejoin a room as whichever role we already
  // hold in it (host or guest), without the "room full" rule blocking us.
  enterRoom(roomId, playerName) {
    const finalRoomId = (roomId || '').trim();
    if (!finalRoomId) return Promise.reject(new Error('EMPTY_CODE'));

    const roomRef = db.ref('dond_rooms/' + finalRoomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (room && room.host && room.host.id === myPlayerId) return finalRoomId;
      if (room && room.guest && room.guest.id === myPlayerId) return finalRoomId;
      return this.joinRoom(finalRoomId, playerName);
    });
  },

  enterAiRoom(playerName, squadMode) {
    const aiRoomId = 'AI_' + Math.floor(1000 + Math.random() * 9000);
    const roomRef = db.ref('dond_rooms/' + aiRoomId);
    const sanitizedName = sanitizeName(playerName);
    const mode = squadMode === 'full' ? 'full' : 'classic';

    const initialRoom = {
      roomId: aiRoomId,
      status: 'drafting',
      createdAt: Date.now(),
      isAiMode: true,
      squadMode: mode,
      usedPlayerIds: [],
      host: {
        id: myPlayerId,
        name: sanitizedName,
        squad: buildEmptySquad(mode),
        helperCard: null
      },
      guest: {
        id: 'AI_BOT_PLAYER_ID',
        name: '🤖 البوت الذكي (AI)',
        isAi: true,
        squad: buildEmptySquad(mode),
        helperCard: null
      },
      spectatorsCount: 0,
      currentTurn: 'host',
      positionIndex: 0,
      turnState: {
        positionKey: 'GK',
        positionNameAr: POSITION_NAMES_AR['GK'],
        briefcases: generateBriefcases('GK', false),
        pickedBriefcaseIndex: null,
        pickNumber: 0,
        status: 'waiting_pick_1'
      },
      matchSimulation: null
    };

    return roomRef.set(initialRoom).then(() => aiRoomId);
  },

  // Stops listening to whatever room this client was subscribed to before.
  // Needed because listenToRoom() used to be called from four different
  // places (create/join/AI/session-restore) without ever detaching the
  // previous listener, so a session-restore followed by a manual join left
  // two live listeners double-processing every update.
  leaveRoom() {
    if (window._activeRoomRef) {
      window._activeRoomRef.off();
      window._activeRoomRef = null;
    }
  },

  listenToRoom(roomId, onUpdate) {
    this.leaveRoom();
    const roomRef = db.ref('dond_rooms/' + roomId);
    window._activeRoomRef = roomRef;

    roomRef.on('value', snapshot => {
      const room = snapshot.val();
      if (!room) return;

      // AI turn processing (AI mode only, guest is always the AI).
      if (room.isAiMode && room.currentTurn === 'guest' && room.status === 'drafting') {
        this._runAiTurn(roomId, roomRef, room);
      }

      // AI pre-match protection (AI mode only, executed automatically if the AI holds the card).
      if (room.isAiMode && room.status === 'pre_match_protect' && room.protectBy === 'guest') {
        this._runAiProtection(roomId, room);
      }

      // AI pre-match steal (AI mode only, executed automatically if the AI holds the card).
      if (room.isAiMode && room.status === 'pre_match_steal' && room.stealBy === 'guest') {
        this._runAiSteal(roomId, room);
      }

      // AI pre-match max upgrade (AI mode only, executed automatically if the AI holds the card).
      if (room.isAiMode && room.status === 'pre_match_upgrade' && room.upgradeBy === 'guest') {
        this._runAiMaxUpgrade(roomId, room);
      }

      onUpdate(room);
    });
  },

  // Scoped by roomId+positionIndex so two different rooms (or a stale
  // re-entry into the same position after a page reload) can never share the
  // same "is the AI already thinking" flag, and the flag only clears once
  // the whole pick chain (including the Firebase write) has finished -
  // previously it cleared right after scheduling the timeout, so two
  // 'value' events arriving close together could both pass the guard and
  // produce two AI picks for the same position.
  _runAiTurn(roomId, roomRef, room) {
    if (room.turnState.status !== 'waiting_pick_1') return;
    if (!window._aiActiveTurns) window._aiActiveTurns = new Set();
    const turnKey = roomId + ':' + room.positionIndex;
    if (window._aiActiveTurns.has(turnKey)) return;
    window._aiActiveTurns.add(turnKey);

    setTimeout(() => {
      const unrevealed = (room.turnState.briefcases || []).map((b, idx) => ({ b, idx })).filter(x => !x.b.isRevealed);
      if (unrevealed.length === 0) {
        window._aiActiveTurns.delete(turnKey);
        return;
      }
      // Weighted pick: a scouting AI leans toward the higher-rated briefcases
      // instead of picking blind, so its squads trend stronger than a coin-flip.
      const pick = weightedBriefcasePick(unrevealed);
      const briefcases = [...room.turnState.briefcases];
      briefcases[pick.idx].isRevealed = true;

      roomRef.child('turnState').update({
        briefcases: briefcases,
        pickedBriefcaseIndex: pick.idx,
        pickNumber: 1,
        status: 'picked_1_pending_deal'
      });

      const currentRoom = JSON.parse(JSON.stringify(room));
      currentRoom.turnState.briefcases = briefcases;
      currentRoom.turnState.pickedBriefcaseIndex = pick.idx;
      currentRoom.turnState.pickNumber = 1;

      setTimeout(() => {
        const itemRating = pick.b.item?.rating || 80;
        const posKey = basePositionKey(room.turnState.positionKey);
        // Threshold varies by position: a harder AI is pickier about its
        // spine (GK/DEF/MGR) and more willing to lock in a decent attacker
        // early since attRating already weighs ATT/MID heavily.
        const acceptThreshold = { GK: 88, DEF: 88, MID: 85, ATT: 84, MGR: 87 }[posKey] || 87;
        if (itemRating >= acceptThreshold || pick.b.helperCard) {
          FirebaseEngine.finalizeSelection(roomId, currentRoom, pick.b);
          window._aiActiveTurns.delete(turnKey);
        } else {
          roomRef.child('turnState/status').set('waiting_pick_2');
          setTimeout(() => {
            const remaining = briefcases.map((b, idx) => ({ b, idx })).filter(x => !x.b.isRevealed);
            if (remaining.length === 0) {
              window._aiActiveTurns.delete(turnKey);
              return;
            }
            const pick2 = weightedBriefcasePick(remaining);
            briefcases[pick2.idx].isRevealed = true;
            roomRef.child('turnState').update({
              briefcases: briefcases,
              pickedBriefcaseIndex: pick2.idx,
              pickNumber: 2,
              status: 'finished_turn'
            });
            currentRoom.turnState.briefcases = briefcases;
            currentRoom.turnState.pickedBriefcaseIndex = pick2.idx;
            currentRoom.turnState.pickNumber = 2;

            // Keep the better of the two offers instead of always locking in
            // pick 2 - mirrors how a real player weighs "deal or no deal".
            const pick1Value = (pick.b.item?.rating || 0) + (pick.b.helperCard ? 3 : 0);
            const pick2Value = (pick2.b.item?.rating || 0) + (pick2.b.helperCard ? 3 : 0);
            const finalPick = pick2Value >= pick1Value ? pick2.b : pick.b;

            FirebaseEngine.finalizeSelection(roomId, currentRoom, finalPick);
            window._aiActiveTurns.delete(turnKey);
          }, 1500);
        }
      }, 1500);
    }, 1200);
  },

  _runAiProtection(roomId, room) {
    if (!window._aiProtectRooms) window._aiProtectRooms = new Set();
    if (window._aiProtectRooms.has(roomId)) return;
    window._aiProtectRooms.add(roomId);

    setTimeout(() => {
      // Shields its own best player - the one an opponent's steal would
      // most want to take.
      const squad = room.guest?.squad || {};
      const stealableSlots = Object.keys(squad).filter(k => basePositionKey(k) !== 'MGR' && squad[k]);
      const bestPos = stealableSlots.reduce((best, pos) =>
        (squad[pos]?.rating ?? -1) > (squad[best]?.rating ?? -1) ? pos : best,
        stealableSlots[0]);

      if (!bestPos) {
        FirebaseEngine.skipProtection(roomId).finally(() => window._aiProtectRooms.delete(roomId));
        return;
      }
      FirebaseEngine.executeProtection(roomId, 'guest', bestPos).finally(() => {
        window._aiProtectRooms.delete(roomId);
      });
    }, 1000);
  },

  _runAiSteal(roomId, room) {
    if (!window._aiStealRooms) window._aiStealRooms = new Set();
    if (window._aiStealRooms.has(roomId)) return;
    window._aiStealRooms.add(roomId);

    setTimeout(() => {
      // A harder AI steals with intent: give up its weakest stealable slot,
      // take the opponent's strongest one, instead of a blind random swap.
      // Uses the actual filled squad slots (works for both classic's fixed
      // GK/DEF/MID/ATT keys and full mode's DEF1..ATT3 keys) rather than the
      // fixed 4-category list, so it generalizes to both squad modes.
      const stealableSlots = (squad, excludeKey) => Object.keys(squad || {})
        .filter(k => basePositionKey(k) !== 'MGR' && squad[k] && k !== excludeKey);
      const weakestPos = (squad) => stealableSlots(squad).reduce((worst, pos) =>
        (squad[pos]?.rating ?? 999) < (squad[worst]?.rating ?? 999) ? pos : worst,
        stealableSlots(squad)[0]);
      const strongestPos = (squad, excludeKey) => {
        const slots = stealableSlots(squad, excludeKey);
        return slots.reduce((best, pos) =>
          (squad[pos]?.rating ?? -1) > (squad[best]?.rating ?? -1) ? pos : best,
          slots[0]);
      };

      const myPos = weakestPos(room.guest?.squad);
      // A protected host slot has to be excluded from the AI's own target
      // search too, not just the human dropdown - otherwise the AI could
      // "choose" the shielded player, executeSteal rejects it, and the
      // match gets stuck at pre_match_steal forever with no retry.
      const oppPos = strongestPos(room.host?.squad, room.host?.protectedSlot);
      if (!oppPos) {
        FirebaseEngine.skipSteal(roomId).finally(() => window._aiStealRooms.delete(roomId));
        return;
      }
      FirebaseEngine.executeSteal(roomId, 'guest', myPos, oppPos).finally(() => {
        window._aiStealRooms.delete(roomId);
      });
    }, 1000);
  },

  _runAiMaxUpgrade(roomId, room) {
    if (!window._aiUpgradeRooms) window._aiUpgradeRooms = new Set();
    if (window._aiUpgradeRooms.has(roomId)) return;
    window._aiUpgradeRooms.add(roomId);

    setTimeout(() => {
      // Upgrades its own weakest slot - turns the squad's biggest liability
      // into another 99-rated threat instead of polishing an already-strong pick.
      const squad = room.guest?.squad || {};
      const upgradableSlots = Object.keys(squad).filter(k => basePositionKey(k) !== 'MGR' && squad[k]);
      const worstPos = upgradableSlots.reduce((worst, pos) =>
        (squad[pos]?.rating ?? 999) < (squad[worst]?.rating ?? 999) ? pos : worst,
        upgradableSlots[0]);

      if (!worstPos) {
        FirebaseEngine.skipMaxUpgrade(roomId).finally(() => window._aiUpgradeRooms.delete(roomId));
        return;
      }
      FirebaseEngine.executeMaxUpgrade(roomId, 'guest', worstPos).finally(() => {
        window._aiUpgradeRooms.delete(roomId);
      });
    }, 1000);
  },

  pickBriefcase(roomId, briefcaseIndex, roomState) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    const briefcases = [...roomState.turnState.briefcases];

    if (!briefcases[briefcaseIndex] || briefcases[briefcaseIndex].isRevealed) return;

    briefcases[briefcaseIndex].isRevealed = true;
    const playerKey = roomState.currentTurn === 'host' ? 'host' : 'guest';
    const hasExtraChance = roomState[playerKey]?.helperCard?.id === 'extra_chance';

    if (roomState.turnState.status === 'waiting_pick_1') {
      roomRef.child('turnState').update({
        briefcases: briefcases,
        pickedBriefcaseIndex: briefcaseIndex,
        pickNumber: 1,
        status: 'picked_1_pending_deal'
      });
    } else if (roomState.turnState.status === 'waiting_pick_2') {
      if (hasExtraChance) {
        // The extra_chance card grants exactly one extra "are you sure" -
        // consume it now, whether the player ends up dealing on this card
        // or rejecting it for a third one.
        roomRef.child(playerKey + '/helperCard').set(null);
        roomRef.child('turnState').update({
          briefcases: briefcases,
          pickedBriefcaseIndex: briefcaseIndex,
          pickNumber: 2,
          status: 'picked_2_pending_deal'
        });
      } else {
        roomRef.child('turnState').update({
          briefcases: briefcases,
          pickedBriefcaseIndex: briefcaseIndex,
          pickNumber: 2,
          status: 'finished_turn'
        });
        this.finalizeSelection(roomId, roomState, briefcases[briefcaseIndex]);
      }
    } else if (roomState.turnState.status === 'waiting_pick_3') {
      // Forced deal - no more chances left.
      roomRef.child('turnState').update({
        briefcases: briefcases,
        pickedBriefcaseIndex: briefcaseIndex,
        pickNumber: 3,
        status: 'finished_turn'
      });
      this.finalizeSelection(roomId, roomState, briefcases[briefcaseIndex]);
    }
  },

  confirmDeal(roomId, roomState) {
    const selectedB = roomState.turnState.briefcases[roomState.turnState.pickedBriefcaseIndex];
    this.finalizeSelection(roomId, roomState, selectedB);
  },

  rejectDeal(roomId, roomState) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    const status = roomState?.turnState?.status;
    if (status === 'picked_2_pending_deal') {
      roomRef.child('turnState').update({ status: 'waiting_pick_3' });
    } else {
      roomRef.child('turnState').update({ status: 'waiting_pick_2' });
    }
  },

  // Force-swap: a third option next to Deal/No Deal for whoever holds this
  // card - dump the just-revealed player you don't want onto the opponent's
  // SAME position slot, then redraw fresh briefcases for your own turn
  // (your turn continues, it isn't lost). Only works while that opponent
  // slot is still empty - since both sides draft the same position per
  // round and the round's first mover always goes before the second, this
  // naturally means only the round's first mover can ever land it (the
  // second mover's opponent-slot is already filled by their own earlier
  // pick this round) - rejected with SLOT_TAKEN otherwise, card stays held
  // for a future round. Re-reads fresh state instead of trusting the
  // `roomState` the caller captured, same reasoning as finalizeSelection.
  executeForceSwap(roomId, roomState) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const freshRoom = snapshot.val();
      if (!freshRoom) return null;

      const isHost = freshRoom.currentTurn === 'host';
      const playerKey = isHost ? 'host' : 'guest';
      const oppKey = isHost ? 'guest' : 'host';
      if (freshRoom[playerKey]?.helperCard?.id !== 'force_swap') {
        return Promise.reject(new Error('NO_CARD'));
      }

      const ts = freshRoom.turnState;
      if (!ts || (ts.status !== 'picked_1_pending_deal' && ts.status !== 'picked_2_pending_deal')) {
        return Promise.reject(new Error('NO_ACTIVE_PICK'));
      }
      const briefcase = ts.briefcases?.[ts.pickedBriefcaseIndex];
      if (!briefcase || !briefcase.item) {
        return Promise.reject(new Error('NO_ACTIVE_PICK'));
      }

      const positions = getPositionsForMode(freshRoom.squadMode);
      const posKey = positions[freshRoom.positionIndex];
      if (!posKey) return Promise.reject(new Error('NO_ACTIVE_PICK'));

      if (freshRoom[oppKey]?.squad?.[posKey]) {
        return Promise.reject(new Error('SLOT_TAKEN'));
      }

      const normName = normPlayerName(briefcase.item.name);
      const existingUsed = freshRoom.usedPlayerIds || [];
      const nextUsed = existingUsed.includes(normName) ? existingUsed : existingUsed.concat([normName]);

      const updates = {};
      updates[oppKey + '/squad/' + posKey] = briefcase.item;
      updates[playerKey + '/helperCard'] = null;
      updates.usedPlayerIds = nextUsed;
      updates.turnState = {
        positionKey: posKey,
        positionNameAr: POSITION_NAMES_AR[posKey],
        briefcases: generateBriefcases(posKey, false, nextUsed),
        pickedBriefcaseIndex: null,
        pickNumber: 0,
        status: 'waiting_pick_1'
      };

      return roomRef.update(updates);
    });
  },

  // Reveal Cards: every briefcase already carries its real `item` in Firebase
  // from the moment the round starts (isRevealed is purely a display flag,
  // not what actually hides the data) - so "using" this card is really just
  // consuming it. The peek itself is the client reading data it already has
  // locally; no new read/write needed for the reveal part.
  useRevealCards(roomId, playerKey) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room || room[playerKey]?.helperCard?.id !== 'reveal_cards') {
        return Promise.reject(new Error('NO_CARD'));
      }
      return roomRef.child(playerKey + '/helperCard').set(null);
    });
  },

  // Re-reads the room fresh instead of trusting the `roomState` the caller
  // captured at click time. That parameter can be stale by a real amount in
  // PvP (two devices, real network latency) - trusting it to pick
  // playerKey/posKey caused a genuine bug: a pick landing on an
  // already-passed position (or the wrong player's slot) while the actual
  // current round's slot was never written, leaving it permanently empty
  // even though the draft moved on and the match finished. `briefcase` (the
  // specific card the player clicked) is still taken from the caller - it's
  // the one thing that can't go stale, since it's the literal object they
  // picked, not a snapshot of shared room state.
  finalizeSelection(roomId, roomState, briefcase) {
    const roomRef = db.ref('dond_rooms/' + roomId);

    roomRef.once('value').then(snapshot => {
      const freshRoom = snapshot.val();
      if (!freshRoom) return;

      const isHost = freshRoom.currentTurn === 'host';
      const playerKey = isHost ? 'host' : 'guest';
      const positions = getPositionsForMode(freshRoom.squadMode);
      const posKey = positions[freshRoom.positionIndex];
      if (!posKey) return;

      const allRevealedBriefcases = (freshRoom.turnState?.briefcases || []).map(b => ({
        ...b,
        isRevealed: true
      }));

      const playerObj = freshRoom[playerKey];
      let newHelper = playerObj?.helperCard || null;
      if (briefcase.helperCard && !newHelper) {
        newHelper = briefcase.helperCard;
      }

      roomRef.child(playerKey + '/squad/' + posKey).set(briefcase.item);
      roomRef.child(playerKey + '/helperCard').set(newHelper);
      roomRef.child('turnState/briefcases').set(allRevealedBriefcases);

      // Mark this real person as drafted room-wide (both sides, every round,
      // regardless of which edition/card they were picked as) so they can
      // never be offered again in this match.
      if (briefcase.item && briefcase.item.name) {
        const normName = normPlayerName(briefcase.item.name);
        const existingUsed = freshRoom.usedPlayerIds || [];
        if (!existingUsed.includes(normName)) {
          roomRef.child('usedPlayerIds').set(existingUsed.concat([normName]));
        }
      }

      // Transition turn after 3.5 seconds, reading a fresh snapshot again so
      // we compute the next turn/position from current data, not the state
      // captured when this pick started.
      setTimeout(() => {
        roomRef.once('value').then(snapshot2 => {
          const freshRoom2 = snapshot2.val();
          if (!freshRoom2) return;

          // If another finalizeSelection call already advanced the turn in
          // the meantime (the exact race this rewrite guards against),
          // currentTurn won't match who we just picked for anymore - bail
          // instead of blindly advancing again and skipping/duplicating a
          // position.
          if (freshRoom2.currentTurn !== playerKey) return;

          let nextTurn;
          let nextPosIndex = freshRoom2.positionIndex;

          if (isHost) {
            nextTurn = 'guest';
          } else {
            nextTurn = 'host';
            nextPosIndex++;
          }

          const freshPositions = getPositionsForMode(freshRoom2.squadMode);
          if (nextPosIndex >= freshPositions.length) {
            this._offerNextProtectionOrSteal(roomId, freshRoom2);
          } else {
            const nextPosKey = freshPositions[nextPosIndex];
            const hasHelperObj = isHost ? !!freshRoom2.guest?.helperCard : !!freshRoom2.host?.helperCard;
            const newBriefcases = generateBriefcases(nextPosKey, hasHelperObj, freshRoom2.usedPlayerIds);

            roomRef.update({
              currentTurn: nextTurn,
              positionIndex: nextPosIndex,
              turnState: {
                positionKey: nextPosKey,
                positionNameAr: POSITION_NAMES_AR[nextPosKey],
                briefcases: newBriefcases,
                pickedBriefcaseIndex: null,
                pickNumber: 0,
                status: 'waiting_pick_1'
              }
            });
          }
        });
      }, 3500);
    });
  },

  // Right after the draft ends (and again after each protection choice/skip
  // resolves) - protection goes FIRST, before any steal offer, so a
  // protected slot is already on record by the time steal ever runs. Same
  // dual-offer pattern as steal below: re-checks both sides each time, so
  // whichever side hasn't been asked yet (their helperCard is still set)
  // gets offered next.
  _offerNextProtectionOrSteal(roomId, freshRoom) {
    const roomRef = db.ref('dond_rooms/' + roomId);

    // extra_chance/reveal_cards only ever mean something mid-draft (one
    // more briefcase pick / a peek before picking) - there's no "next
    // round" left to spend them in once the draft is over. This chain only
    // ever looked for protection/steal/max_upgrade, so a card banked but
    // never spent (e.g. dealt on pick_1 of a player's very last position)
    // just sat there forever, unconsumed and invisible - reading to the
    // player as it randomly vanishing. Void it explicitly here and leave a
    // notice so it's an explained loss, not a silent one.
    const staleTypes = ['extra_chance', 'reveal_cards'];
    const voidUpdates = {};
    ['host', 'guest'].forEach(side => {
      const card = freshRoom[side]?.helperCard;
      if (card && staleTypes.includes(card.id)) {
        voidUpdates[side + '/helperCard'] = null;
        voidUpdates[side + '/voidedHelperNotice'] = { cardName: card.name || '', ts: Date.now() };
      }
    });

    const applyVoids = Object.keys(voidUpdates).length ? roomRef.update(voidUpdates) : Promise.resolve();

    applyVoids.then(() => {
      const room2 = JSON.parse(JSON.stringify(freshRoom));
      Object.keys(voidUpdates).forEach(k => {
        const slash = k.indexOf('/');
        const side = k.slice(0, slash);
        const field = k.slice(slash + 1);
        room2[side] = room2[side] || {};
        room2[side][field] = voidUpdates[k];
      });

      const protectorKey = room2.host?.helperCard?.id === 'protection' ? 'host'
        : room2.guest?.helperCard?.id === 'protection' ? 'guest'
        : null;
      if (protectorKey) {
        roomRef.update({ status: 'pre_match_protect', protectBy: protectorKey });
      } else {
        this._offerNextStealOrSimulate(roomId, room2);
      }
    });
  },

  // Pre-match protection: the card holder picks ONE of their own non-MGR
  // players to shield - that specific slot becomes un-stealable (see
  // executeSteal below), on top of the flat +15% defense the card already
  // gives the whole squad during simulation (calcPower checks
  // protectedSlot directly, not the helperCard, since the card itself gets
  // consumed here before the match ever starts).
  executeProtection(roomId, protectByKey, posKey) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    if (basePositionKey(posKey) === 'MGR') {
      return Promise.reject(new Error('INVALID_POSITION'));
    }

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room || room.protectBy !== protectByKey) return null;
      if (!room[protectByKey]?.squad?.[posKey]) return null;

      const updates = {};
      updates[protectByKey + '/protectedSlot'] = posKey;
      updates[protectByKey + '/helperCard'] = null;
      updates.protectBy = null;

      return roomRef.update(updates).then(() => roomRef.once('value'));
    }).then(snapshot => {
      const freshRoom = snapshot ? snapshot.val() : null;
      if (freshRoom) this._offerNextProtectionOrSteal(roomId, freshRoom);
    });
  },

  // Declines the pre-match protection (manually, or via the 6s auto-skip
  // timer in app.js). The card is still consumed - offered and not used -
  // and no slot ends up protected.
  skipProtection(roomId) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room) return null;
      const protectorKey = room.protectBy;
      const updates = { protectBy: null };
      if (protectorKey) updates[protectorKey + '/helperCard'] = null;
      return roomRef.update(updates).then(() => roomRef.once('value'));
    }).then(snapshot => {
      const freshRoom = snapshot ? snapshot.val() : null;
      if (freshRoom) this._offerNextProtectionOrSteal(roomId, freshRoom);
    });
  },

  // After a steal is resolved (or declined) - decide what's next: if the
  // OTHER side also still holds an unconsumed steal card, give them their
  // turn too (previously only the host's steal was ever offered when both
  // sides held one - the guest's card silently went to waste), otherwise
  // kick off the match.
  _offerNextStealOrSimulate(roomId, freshRoom) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    const stealerKey = freshRoom.host?.helperCard?.id === 'steal' ? 'host'
      : freshRoom.guest?.helperCard?.id === 'steal' ? 'guest'
      : null;
    if (stealerKey) {
      roomRef.update({ status: 'pre_match_steal', stealBy: stealerKey });
    } else {
      this._offerNextMaxUpgradeOrSimulate(roomId, freshRoom);
    }
  },

  // Last pre-match phase, after protection and steal are both fully
  // resolved - offers the max_upgrade card (same dual-offer pattern as the
  // other two) before finally starting the match.
  _offerNextMaxUpgradeOrSimulate(roomId, freshRoom) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    const upgradeByKey = freshRoom.host?.helperCard?.id === 'max_upgrade' ? 'host'
      : freshRoom.guest?.helperCard?.id === 'max_upgrade' ? 'guest'
      : null;
    if (upgradeByKey) {
      roomRef.update({ status: 'pre_match_upgrade', upgradeBy: upgradeByKey });
    } else {
      this.startMatchSimulation(roomId, freshRoom);
    }
  },

  // Maxes out one of the upgrader's own non-MGR players (rating -> 99),
  // which also auto-qualifies for calcPower's existing icon-tier skill
  // bonus (>=90) and the icon-tier event weighting elsewhere - no separate
  // "skill" flag needed, the rating threshold already carries that meaning
  // everywhere else in the engine.
  executeMaxUpgrade(roomId, upgradeByKey, posKey) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    if (basePositionKey(posKey) === 'MGR') {
      return Promise.reject(new Error('INVALID_POSITION'));
    }

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room || room.upgradeBy !== upgradeByKey) return null;
      const player = room[upgradeByKey]?.squad?.[posKey];
      if (!player) return null;

      const updates = {};
      updates[upgradeByKey + '/squad/' + posKey + '/rating'] = 99;
      updates[upgradeByKey + '/squad/' + posKey + '/edition'] = 'ترقية قصوى 🔥';
      updates[upgradeByKey + '/helperCard'] = null;
      updates.upgradeBy = null;

      return roomRef.update(updates).then(() => roomRef.once('value'));
    }).then(snapshot => {
      const freshRoom = snapshot ? snapshot.val() : null;
      if (freshRoom) this._offerNextMaxUpgradeOrSimulate(roomId, freshRoom);
    });
  },

  // Declines the max_upgrade offer (manual skip only - no auto-timer here
  // either, matching protection/steal).
  skipMaxUpgrade(roomId) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room) return null;
      const upgradeByKey = room.upgradeBy;
      const updates = { upgradeBy: null };
      if (upgradeByKey) updates[upgradeByKey + '/helperCard'] = null;
      return roomRef.update(updates).then(() => roomRef.once('value'));
    }).then(snapshot => {
      const freshRoom = snapshot ? snapshot.val() : null;
      if (freshRoom) this._offerNextMaxUpgradeOrSimulate(roomId, freshRoom);
    });
  },

  // Pre-match steal: swap one of the stealer's players with one of the
  // opponent's (MGR excluded). Runs after the draft is done and before the
  // match is simulated, because the match result is computed entirely
  // up-front in startMatchSimulation - a swap during the "live" simulation
  // would be purely cosmetic.
  executeSteal(roomId, stealerKey, myPosKey, oppPosKey) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    // Any non-MGR slot key is stealable in either mode (classic's fixed
    // GK/DEF/MID/ATT or full mode's GK/DEF1..4/MID1..3/ATT1..3).
    if (basePositionKey(myPosKey) === 'MGR' || basePositionKey(oppPosKey) === 'MGR') {
      return Promise.reject(new Error('INVALID_POSITION'));
    }

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room || room.stealBy !== stealerKey) return null;

      const oppKey = stealerKey === 'host' ? 'guest' : 'host';
      // Only the SPECIFIC protected slot is off-limits now - protection no
      // longer blanket-blocks every steal against that opponent, just the
      // one player they chose to shield.
      if (room[oppKey]?.protectedSlot === oppPosKey) {
        return Promise.reject(new Error('TARGET_PROTECTED'));
      }

      const myItem = room[stealerKey]?.squad?.[myPosKey];
      const oppItem = room[oppKey]?.squad?.[oppPosKey];
      if (!myItem || !oppItem) return null;

      const updates = {};
      updates[stealerKey + '/squad/' + myPosKey] = oppItem;
      updates[oppKey + '/squad/' + oppPosKey] = myItem;
      updates[stealerKey + '/helperCard'] = null;
      updates.stealBy = null;
      // The victim previously found out only by chance, if they happened to
      // notice their squad changed on the next render. A dedicated notice
      // field (read once, client-side, keyed by ts) lets them get an actual
      // "you got stolen from" toast instead.
      updates[oppKey + '/lastStealNotice'] = {
        stolenName: oppItem.name || '---',
        receivedName: myItem.name || '---',
        stealerName: room[stealerKey]?.name || '---',
        ts: Date.now()
      };

      return roomRef.update(updates).then(() => roomRef.once('value'));
    }).then(snapshot => {
      const freshRoom = snapshot ? snapshot.val() : null;
      if (freshRoom) this._offerNextStealOrSimulate(roomId, freshRoom);
    });
  },

  // Declines the pre-match steal (manually, or via the 8s auto-skip timer in
  // app.js). The card is still consumed - it was offered and not used.
  skipSteal(roomId) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room) return null;
      const stealerKey = room.stealBy;
      const updates = { stealBy: null };
      if (stealerKey) updates[stealerKey + '/helperCard'] = null;
      return roomRef.update(updates).then(() => roomRef.once('value'));
    }).then(snapshot => {
      const freshRoom = snapshot ? snapshot.val() : null;
      if (freshRoom) this._offerNextStealOrSimulate(roomId, freshRoom);
    });
  },

  // roomsPath lets a second game (e.g. the auction game's 'mazad_rooms')
  // reuse this exact simulation - ratings/momentum/fatigue/event-weighting
  // math tuned over many iterations - without duplicating it. Defaults to
  // 'dond_rooms' so the one existing call site (below, from
  // _offerNextStealOrSimulate) is untouched.
  startMatchSimulation(roomId, roomState, roomsPath) {
    const roomRef = db.ref((roomsPath || 'dond_rooms') + '/' + roomId);

    const hostChem = typeof calcSquadChemistry === 'function' ? calcSquadChemistry(roomState.host.squad) : 10;
    const guestChem = typeof calcSquadChemistry === 'function' ? calcSquadChemistry(roomState.guest.squad) : 10;

    // Buckets a squad's players by base position (GK/DEF/MID/ATT/MGR)
    // regardless of slot key, then averages within each bucket. Classic mode
    // has exactly one player per bucket so the average is just that
    // player's rating (identical to the old hardcoded lookup) - full mode's
    // multiple DEF/MID/ATT slots average out naturally, no separate formula
    // needed for the two squad modes.
    const bucketSquad = (squad) => {
      const buckets = { GK: [], DEF: [], MID: [], ATT: [], MGR: [] };
      Object.keys(squad || {}).forEach(key => {
        const player = squad[key];
        if (!player) return;
        const base = basePositionKey(key);
        if (buckets[base]) buckets[base].push(parseInt(player.rating) || 80);
      });
      const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 80;
      return {
        gk: avg(buckets.GK), def: avg(buckets.DEF), mid: avg(buckets.MID),
        att: avg(buckets.ATT), mgr: avg(buckets.MGR), buckets
      };
    };

    const calcPower = (squad, hasProtectedSlot, chem) => {
      const b = bucketSquad(squad);

      let attRating = (b.att * 1.3) + (b.mid * 0.7) + (b.mgr * 0.15) + (chem * 0.5);
      let defRating = (b.def * 1.2) + (b.gk * 1.1) + (b.mid * 0.5) + (b.mgr * 0.15) + (chem * 0.5);
      let midAvg = b.mid;

      // Protection's flat defense boost is keyed off protectedSlot (set once
      // the player actually chooses who to shield), not the helperCard -
      // the card itself is already consumed/nulled by the time this runs.
      if (hasProtectedSlot) defRating *= 1.15;

      // Icon-tier special skills: a rating >= 90 signing is a rare pull (see
      // rarityWeight above) and should feel like one - a flat edge per
      // qualifying player on top of the raw stat math, not just a bigger
      // number in the same formula. Full mode's extra slots mean a stronger
      // squad can stack several of these.
      b.buckets.ATT.forEach(r => { if (r >= 90) attRating += 5; });
      b.buckets.MID.forEach(r => { if (r >= 90) attRating += 3; });
      b.buckets.DEF.forEach(r => { if (r >= 90) defRating += 5; });
      b.buckets.GK.forEach(r => { if (r >= 90) defRating += 5; });
      b.buckets.MGR.forEach(r => { if (r >= 90) { attRating += 2; defRating += 2; } });

      // Manager tactic now actually shapes the match instead of being pure
      // flavor text on the card - attacking tactics trade some defense for
      // attack, defensive ones the reverse, possession ones lean midfield
      // (which also feeds the possession % calc below via midAvg).
      const tacticMod = tacticModifier(squad?.MGR?.tactic);
      attRating *= tacticMod.att;
      defRating *= tacticMod.def;
      midAvg *= tacticMod.mid;

      return { attRating, defRating, total: attRating + defRating, midAvg, mgrAvg: b.mgr };
    };

    const hostStats = calcPower(roomState.host.squad, !!roomState.host.protectedSlot, hostChem);
    const guestStats = calcPower(roomState.guest.squad, !!roomState.guest.protectedSlot, guestChem);

    const hostMidPower = hostStats.midAvg + hostStats.mgrAvg * 0.3 + hostChem;
    const guestMidPower = guestStats.midAvg + guestStats.mgrAvg * 0.3 + guestChem;
    const hostPos = Math.min(72, Math.max(28, Math.round((hostMidPower / (hostMidPower + guestMidPower)) * 100)));
    const guestPos = 100 - hostPos;

    let hostGoals = 0;
    let guestGoals = 0;
    let hostShots = 0;
    let guestShots = 0;
    let hostOnTarget = 0;
    let guestOnTarget = 0;

    const events = [];
    const minutes = [6, 17, 28, 39, 45, 55, 66, 78, 86, 92];
    const shotTypes = ['صاروخية لا تُصد ولا تُرَد', 'مقوسة R2 في الزاوية 90', 'رأسية متقنة بارتقاء خرافي', 'تسديدة أرضية زاحفة على يمين الحارس', 'ركلة جزاء محكمة في الشباك'];

    const playerPerf = {};
    const trackPoints = (player, pts) => {
      if (!player || !player.name) return;
      if (!playerPerf[player.name]) {
        playerPerf[player.name] = { player, pts: (player.rating || 80) * 0.05 };
      }
      playerPerf[player.name].pts += pts;
    };

    // Momentum: scoring builds a short-lived psychological edge for the next
    // minute rolled, decaying by half each subsequent minute instead of
    // persisting flat - mirrors a team riding a goal rather than being
    // permanently "on fire". Fatigue: the side with the lower overall rating
    // (weaker bench/squad depth) fades in the last ~20 minutes, realistic for
    // a team that has to defend more and tires chasing the game.
    let hostMomentum = 0;
    let guestMomentum = 0;
    const weakerIsHost = hostStats.total < guestStats.total;

    minutes.forEach((minute) => {
      hostMomentum *= 0.5;
      guestMomentum *= 0.5;

      const isHostAttacking = Math.random() * 100 < hostPos;
      const attacker = isHostAttacking ? roomState.host : roomState.guest;
      const defender = isHostAttacking ? roomState.guest : roomState.host;

      let attPower = isHostAttacking ? hostStats.attRating : guestStats.attRating;
      let defPower = isHostAttacking ? guestStats.defRating : hostStats.defRating;
      attPower += (isHostAttacking ? hostMomentum : guestMomentum) * 5;

      if (minute >= 70) {
        const fatigueMinutes = minute - 70;
        const defenderIsHost = !isHostAttacking;
        // Apply fatigue only to the weaker overall squad's defense.
        if (defenderIsHost === weakerIsHost) {
          defPower *= (1 - Math.min(0.12, fatigueMinutes * 0.006));
        }
      }

      // Every squad slot may be empty if a draft was somehow interrupted -
      // fall back to a generic placeholder instead of dereferencing undefined.
      // pickRandomFromBase also covers full mode's multiple ATT/MID/DEF
      // slots, picking a specific (not always the same) player each event.
      const fallbackPlayer = { name: attacker.name || 'لاعب', rating: 80 };
      const attFromForwardLine = Math.random() < 0.65;
      const attPlayer = attFromForwardLine
        ? pickWeightedFromBase(attacker.squad, 'ATT', pickWeightedFromBase(attacker.squad, 'MID', fallbackPlayer))
        : pickWeightedFromBase(attacker.squad, 'MID', pickWeightedFromBase(attacker.squad, 'ATT', fallbackPlayer));
      const assistPlayer = attFromForwardLine
        ? pickWeightedFromBase(attacker.squad, 'MID', null)
        : pickWeightedFromBase(attacker.squad, 'DEF', null);
      const defGK = pickRandomFromBase(defender.squad, 'GK', { name: defender.name || 'الحارس', rating: 80 });
      const defDEF = pickRandomFromBase(defender.squad, 'DEF', { name: defender.name || 'المدافع', rating: 80 });
      const shotStyle = shotTypes[Math.floor(Math.random() * shotTypes.length)];

      if (isHostAttacking) hostShots++; else guestShots++;

      // Sensitivity widened (was ±0.17 max swing) so a genuinely stronger
      // squad matters, while the floor/ceiling keep every match winnable.
      const goalProbability = Math.min(0.62, Math.max(0.10, 0.34 + ((attPower - defPower) / 130)));
      const rand = Math.random();

      // Save chance used to be a flat +0.28 band regardless of who the
      // keeper/shooter actually were - a rating-60 keeper stopped a
      // rating-99 striker exactly as often as a rating-99 keeper would.
      // Now it shifts with the real rating gap for this specific shot
      // (still keeper vs shooter, not the whole-squad goalProbability
      // above), and miss absorbs whatever save gives up so the combined
      // save+miss width - and everything after it (card/VAR) - stays
      // unchanged at goalProbability+0.42/+0.52.
      const gkRating = parseInt(defGK?.rating) || 75;
      const shooterRating = parseInt(attPlayer?.rating) || 75;
      const saveBand = Math.min(0.40, Math.max(0.12, 0.28 + (gkRating - shooterRating) / 150));
      const missBand = 0.42 - saveBand;

      // team/player/rating are structured actor fields (on top of the
      // flavor `text`) so the broadcast-style UI can render a real player
      // badge (rating + name + team color) per event instead of parsing it
      // back out of prose.
      const team = isHostAttacking ? 'host' : 'guest';

      if (rand < goalProbability) {
        if (isHostAttacking) { hostGoals++; hostOnTarget++; hostMomentum = Math.min(2, hostMomentum + 1); }
        else { guestGoals++; guestOnTarget++; guestMomentum = Math.min(2, guestMomentum + 1); }
        trackPoints(attPlayer, 4);
        trackPoints(assistPlayer, 2);

        events.push({
          minute,
          type: 'GOAL',
          team,
          player: attPlayer?.name || 'لاعب',
          rating: attPlayer?.rating || null,
          assist: assistPlayer?.name || null,
          text: `⚽ GOALLL!! ${attPlayer?.name || 'لاعب'} يسجل هدفاً عالمياً! ${shotStyle}! (تمريرة حاسمة: ${assistPlayer?.name || 'مجهود فردي'})`,
          score: `${hostGoals} - ${guestGoals}`
        });
      } else if (rand < goalProbability + saveBand) {
        if (isHostAttacking) hostOnTarget++; else guestOnTarget++;
        trackPoints(defGK, 2.5);

        events.push({
          minute,
          type: 'SAVE',
          team: team === 'host' ? 'guest' : 'host',
          player: defGK?.name || 'الحارس',
          rating: defGK?.rating || null,
          text: `🧤 تصدي خيالي! الحارس العملاق ${defGK?.name || 'الحارس'} يرتمي بأطراف أصابعه ويبعد تسديدة ${attPlayer?.name || 'المهاجم'}!`,
          score: `${hostGoals} - ${guestGoals}`
        });
      } else if (rand < goalProbability + saveBand + missBand) {
        events.push({
          minute,
          type: 'MISS',
          team,
          player: attPlayer?.name || 'المهاجم',
          rating: attPlayer?.rating || null,
          text: `💥 القائم ينوب عن الحارس! تسديدة ${attPlayer?.name || 'المهاجم'} تصطدم بالقائم وسط ذهول الجميع!`,
          score: `${hostGoals} - ${guestGoals}`
        });
      } else if (rand < goalProbability + 0.52) {
        trackPoints(defDEF, -1);
        events.push({
          minute,
          type: 'CARD',
          team: team === 'host' ? 'guest' : 'host',
          player: defDEF?.name || 'المدافع',
          rating: defDEF?.rating || null,
          text: `🟨 بطاقة صفراء! الحكم يوجه إنذاراً للمدافع ${defDEF?.name || 'المدافع'} بعد تدخل قوي لتوقيف خطورة ${attPlayer?.name || 'المهاجم'}!`,
          score: `${hostGoals} - ${guestGoals}`
        });
      } else {
        events.push({
          minute,
          type: 'VAR',
          team,
          player: attacker.name || 'الفريق المهاجم',
          rating: null,
          text: `🖥️ تقنية الـ VAR تفحص اللقطة... الحكم يشير بمنح ركلة حرة واعدة لصالح ${attacker.name || 'الفريق المهاجم'}!`,
          score: `${hostGoals} - ${guestGoals}`
        });
      }
    });

    let mvpPlayer = null;
    let maxPts = -1;
    Object.values(playerPerf).forEach(entry => {
      if (entry.pts > maxPts) {
        maxPts = entry.pts;
        mvpPlayer = entry.player;
      }
    });
    if (!mvpPlayer) {
      mvpPlayer = pickRandomFromBase(roomState.host.squad, 'ATT', pickRandomFromBase(roomState.host.squad, 'MID', { name: roomState.host.name, rating: 90 }));
    }

    const matchSim = {
      status: 'simulating',
      currentTime: 0,
      hostGoals,
      guestGoals,
      events,
      mvpPlayer,
      stats: {
        possession: [hostPos, guestPos],
        shots: [hostShots, guestShots],
        shotsOnTarget: [hostOnTarget, guestOnTarget],
        chemistry: [hostChem, guestChem]
      }
    };

    roomRef.update({
      status: 'simulating',
      matchSimulation: matchSim,
      stealBy: null
    });

    // Run the 8-second ticker exactly once per room, on whichever client
    // reaches this point first. Previously this was gated on
    // `roomState.host.id === myPlayerId`, but this function is called by
    // whoever makes the LAST draft pick - in PvP that is always the guest,
    // so the ticker never ran and PvP matches never finished.
    // 10 ticks at 800ms = 8 real seconds total. Capped at 92 (not 90) - the
    // fixed event minutes below go up to 92 (injury time), and the event
    // feed only ever reveals an event once currentTime reaches its minute.
    // A 90 cap meant a 92' goal could count toward the final score (shown
    // separately once the match is 'finished') but its event card could
    // never actually appear in the timeline - the exact "result doesn't
    // match the events" mismatch this was reported as.
    // Composite key (not bare roomId) so a dond_rooms code and a
    // mazad_rooms code can never collide in this in-memory guard.
    const simKey = (roomsPath || 'dond_rooms') + ':' + roomId;
    if (!window._simTickerRooms) window._simTickerRooms = new Set();
    if (window._simTickerRooms.has(simKey)) return;
    window._simTickerRooms.add(simKey);

    let sec = 0;
    const interval = setInterval(() => {
      sec++;
      const timeVal = Math.min(sec * 10, 92);
      roomRef.child('matchSimulation/currentTime').set(timeVal);

      if (sec >= 10) {
        clearInterval(interval);
        window._simTickerRooms.delete(simKey);
        let winner = 'draw';
        if (hostGoals > guestGoals) winner = 'host';
        else if (guestGoals > hostGoals) winner = 'guest';

        const gameType = (roomsPath || 'dond_rooms') === 'mazad_rooms' ? 'mazad' : 'dond';
        const p1Name = room.host ? room.host.name : 'مستضيف';
        const p2Name = room.guest ? room.guest.name : 'ضيف';

        db.ref('recent_matches/' + roomId).set({
          game: gameType,
          mode: room.squadMode || 'classic',
          hostName: p1Name,
          guestName: p2Name,
          hostGoals: hostGoals,
          guestGoals: guestGoals,
          winner: winner,
          timestamp: firebase.database.ServerValue.TIMESTAMP
        }).catch(err => console.error('Error logging match to recent_matches:', err));

        roomRef.update({
          status: 'finished',
          'matchSimulation/status': 'finished',
          winner: winner
        });
      }
    }, 800);
  },

  sendEmoji(roomId, emojiSymbol) {
    if (!roomId) return;
    const roomRef = db.ref('dond_rooms/' + roomId);
    roomRef.child('lastEmoji').set({
      symbol: emojiSymbol,
      senderId: myPlayerId,
      timestamp: Date.now()
    });
  },

  // Free-text chat between host/guest. Stored as a capped array (last 30)
  // on the room itself, same pattern as everything else here, rather than
  // a second Firebase listener just for messages.
  // roomsPath defaults to 'dond_rooms' so the existing 3-arg call site is
  // unaffected - mazad's app.js passes 'mazad_rooms' explicitly.
  sendChatMessage(roomId, senderName, text, roomsPath) {
    if (!roomId) return Promise.resolve();
    const trimmed = String(text || '').trim().slice(0, 200);
    if (!trimmed) return Promise.resolve();
    const roomRef = db.ref((roomsPath || 'dond_rooms') + '/' + roomId);
    return roomRef.child('chat').once('value').then(snapshot => {
      const existing = snapshot.val() || [];
      const next = existing.concat([{
        senderId: myPlayerId,
        senderName: sanitizeName(senderName),
        text: trimmed,
        timestamp: Date.now()
      }]).slice(-30);
      return roomRef.child('chat').set(next);
    });
  },

  restartGame(roomId) {
    const roomRef = db.ref('dond_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      const emptySquad = buildEmptySquad(room && room.squadMode);
      return roomRef.update({
        status: 'drafting',
        currentTurn: 'host',
        positionIndex: 0,
        stealBy: null,
        'host/squad': emptySquad,
        'host/helperCard': null,
        'guest/squad': emptySquad,
        'guest/helperCard': null,
        turnState: {
          positionKey: 'GK',
          positionNameAr: POSITION_NAMES_AR['GK'],
          briefcases: generateBriefcases('GK', false),
          pickedBriefcaseIndex: null,
          pickNumber: 0,
          status: 'waiting_pick_1'
        },
        matchSimulation: null
      });
    });
  }
};

window.FirebaseEngine = FirebaseEngine;
