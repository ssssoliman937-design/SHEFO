// User Profile and Stats Manager
// Handles saving and loading player stats to Firebase Realtime Database.
// Extended beyond the original wins/losses/coins tracker: per-game/mode
// stats (so dond and mazad, and classic vs full within each, each get
// their own record instead of one shared bucket), a bio, and rate-limited
// name/photo changes (once per 7 days each).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Founder/admin account - the game's own developer, signed in with Gmail
// or phone. Gets every badge unlocked, no weekly name/photo rate limit, and
// eye peek in both games. Checked against live Firebase Auth user's email
// or phone, not a stored flag - nothing to tamper with client-side.
const ADMIN_EMAIL = 'slyman776688@gmail.com';
const ADMIN_PHONE = '+201146131457';
const FOUNDER_BADGE = { id: 'founder', icon: '👑', label: 'مؤسس اللعبة' };

// Every badge is derived purely from stats already tracked - no separate
// "achievements" ledger to keep in sync. Order matters for display (best
// milestone per category shown last/highlighted by the caller if wanted).
const BADGE_DEFS = [
  { id: 'first_match', icon: '⚽', label: 'ضربة البداية', desc: 'العب أول مباراة لك في أي لعبة', check: (p) => (p.totalMatches || 0) >= 1 },
  { id: 'first_dond_win', icon: '💼', label: 'صائد الصفقات', desc: 'فز بأول مباراة لك في صفقة أم لا صفقة', check: (p) => {
      return Object.entries(p.stats || {}).some(([k, s]) => k.startsWith('dond_') && (s.wins || 0) >= 1);
  } },
  { id: 'first_mazad_win', icon: '🔨', label: 'مطرقة المزاد', desc: 'فز بأول مباراة لك في المزاد', check: (p) => {
      return Object.entries(p.stats || {}).some(([k, s]) => k.startsWith('mazad_') && (s.wins || 0) >= 1);
  } },
  { id: 'wins_5', icon: '🔥', label: 'البلدوزر', desc: 'سجّل 5 انتصارات إجمالاً', check: (p) => (p.wins || 0) >= 5 },
  { id: 'wins_15', icon: '🏆', label: 'الأسطورة الكروية', desc: 'سجّل 15 انتصاراً إجمالاً', check: (p) => (p.wins || 0) >= 15 },
  { id: 'matches_30', icon: '⚔️', label: 'اللاعب الوفي', desc: 'العب 30 مباراة إجمالاً في الموقع', check: (p) => (p.totalMatches || 0) >= 30 }
];

const UserProfileManager = (() => {
  let profile = {
    wins: 0, losses: 0, draws: 0, totalMatches: 0, lastPlayed: 0,
    bio: '', lastNameChange: 0, lastPhotoChange: 0, stats: {}
  };

  let onProfileChangeCb = null;

  function isAdmin() {
    const u = AuthManager.getUser();
    if (!u) return false;
    return u.email === ADMIN_EMAIL || u.phoneNumber === ADMIN_PHONE;
  }

  function init() {
    AuthManager.authReady.then(() => {
      if (AuthManager.isSignedIn()) {
        _loadProfile();
      } else {
        profile = { wins: 0, losses: 0, draws: 0, totalMatches: 0, lastPlayed: 0, bio: '', lastNameChange: 0, lastPhotoChange: 0, stats: {} };
        _updateUI();
        unlockedBadgeIdsCache = [];
      }
    });
  }

  function onProfileChange(cb) {
    onProfileChangeCb = cb;
  }

  async function _loadProfile() {
    const uid = AuthManager.getUid();
    if (!uid) return;

    try {
      const snap = await db.ref(`users/${uid}/profile`).once('value');
      if (snap.exists()) {
        const data = snap.val();
        profile = { ...profile, ...data, stats: data.stats || {} };
      } else {
        await _saveProfile();
      }
      _updateUI();
      checkNewBadges();
      if (onProfileChangeCb) onProfileChangeCb(profile);
    } catch (err) {
      console.error('Error loading profile:', err);
    }
  }

  async function _saveProfile() {
    const uid = AuthManager.getUid();
    if (!uid) return;

    try {
      const authUser = AuthManager.getUser();
      await db.ref(`users/${uid}/profile`).update({
        ...profile,
        name: profile.name || AuthManager.getName(),
        photoURL: profile.photoURL || AuthManager.getPhoto(),
        email: (authUser && authUser.email) || profile.email || null,
        phone: (authUser && authUser.phoneNumber) || profile.phone || null,
        lastUpdated: firebase.database.ServerValue.TIMESTAMP
      });
    } catch (err) {
      console.error('Error saving profile:', err);
    }
  }

  // gameKey e.g. 'dond_classic' / 'dond_full' / 'mazad_classic' / 'mazad_full'
  // - kept as one flat string (not a nested game/mode split) so leaderboard
  // queries stay a single orderByChild() per category instead of needing a
  // compound index.
  async function recordMatchResult(result, gameKey) {
    if (!AuthManager.isSignedIn()) return;

    profile.totalMatches = (profile.totalMatches || 0) + 1;
    profile.lastPlayed = Date.now();

    const bucket = { ...(profile.stats?.[gameKey] || { wins: 0, losses: 0, draws: 0, totalMatches: 0 }) };
    bucket.totalMatches = (bucket.totalMatches || 0) + 1;

    if (result === 'win') {
      profile.wins = (profile.wins || 0) + 1;
      profile.coins = (profile.coins || 0) + 50;
      bucket.wins = (bucket.wins || 0) + 1;
    } else if (result === 'loss') {
      profile.losses = (profile.losses || 0) + 1;
      profile.coins = (profile.coins || 0) + 10;
      bucket.losses = (bucket.losses || 0) + 1;
    } else if (result === 'draw') {
      profile.draws = (profile.draws || 0) + 1;
      profile.coins = (profile.coins || 0) + 20;
      bucket.draws = (bucket.draws || 0) + 1;
    }

    if (gameKey) {
      profile.stats = { ...(profile.stats || {}), [gameKey]: bucket };
    }

    await _saveProfile();
    _updateUI();
    checkNewBadges();
    if (onProfileChangeCb) onProfileChangeCb(profile);
  }

  // Returns { ok: true } or { ok: false, waitMs } - the actual write is
  // still gated by the caller checking this first. Rate limiting only
  // lives here client-side (see docs/firebase-rules.json's comment on this
  // - a truly tamper-proof version needs a Cloud Function).
  function canChangeName() {
    if (isAdmin()) return { ok: true };
    const last = profile.lastNameChange || 0;
    const waitMs = WEEK_MS - (Date.now() - last);
    return waitMs <= 0 ? { ok: true } : { ok: false, waitMs };
  }
  function canChangePhoto() {
    if (isAdmin()) return { ok: true };
    const last = profile.lastPhotoChange || 0;
    const waitMs = WEEK_MS - (Date.now() - last);
    return waitMs <= 0 ? { ok: true } : { ok: false, waitMs };
  }

  async function updateName(newName) {
    const check = canChangeName();
    if (!check.ok) throw new Error('NAME_RATE_LIMITED');
    const trimmed = String(newName || '').trim().slice(0, 24);
    if (trimmed.length < 3) throw new Error('NAME_TOO_SHORT');
    profile.name = trimmed;
    profile.lastNameChange = Date.now();
    await _saveProfile();
    _updateUI();
    if (onProfileChangeCb) onProfileChangeCb(profile);
  }

  async function updatePhotoURL(url) {
    const check = canChangePhoto();
    if (!check.ok) throw new Error('PHOTO_RATE_LIMITED');
    profile.photoURL = url;
    profile.lastPhotoChange = Date.now();
    await _saveProfile();
    _updateUI();
    if (onProfileChangeCb) onProfileChangeCb(profile);
  }

  async function updateBio(text) {
    profile.bio = String(text || '').trim().slice(0, 140);
    await _saveProfile();
    if (onProfileChangeCb) onProfileChangeCb(profile);
  }

  // Uploads to Storage at avatars/{uid} (2MB/image-only cap enforced by
  // storage.rules), then saves the resulting download URL the same way a
  // pasted URL would be saved - one path for "photo changed", not two.
  async function uploadPhoto(file) {
    const check = canChangePhoto();
    if (!check.ok) throw new Error('PHOTO_RATE_LIMITED');
    const uid = AuthManager.getUid();
    if (!uid) throw new Error('NOT_SIGNED_IN');
    if (!file.type.startsWith('image/')) throw new Error('NOT_AN_IMAGE');
    if (file.size > 2 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');

    const ref = firebase.storage().ref('avatars/' + uid);
    await ref.put(file);
    const url = await ref.getDownloadURL();
    await updatePhotoURL(url);
    return url;
  }

  function getBadges() {
    if (isAdmin()) return [FOUNDER_BADGE, ...BADGE_DEFS];
    return BADGE_DEFS.filter(b => b.check(profile));
  }

  function getProfile() {
    return { ...profile };
  }

  function getAllBadgeDefs() {
    return BADGE_DEFS;
  }

  let unlockedBadgeIdsCache = null;

  function showBadgeUnlockPopup(badge) {
    if (window.soundFX && typeof window.soundFX.playDeal === 'function') {
      window.soundFX.playDeal();
    }
    
    const popup = document.createElement('div');
    popup.className = 'badge-unlock-popup';
    popup.style.cssText = `
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translate(-50%, 100px);
      background: rgba(11, 26, 20, 0.95);
      border: 2px solid var(--gold, #d4af37);
      border-radius: 16px;
      padding: 20px 30px;
      box-shadow: 0 10px 35px rgba(0, 0, 0, 0.95), 0 0 25px rgba(212, 175, 55, 0.4);
      z-index: 999999;
      text-align: center;
      direction: rtl;
      width: 90%;
      max-width: 400px;
      opacity: 0;
      transition: transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.5s ease;
      font-family: 'Cairo', sans-serif;
    `;
    
    popup.innerHTML = `
      <div style="font-size: 2.2rem; margin-bottom: 10px; animation: bounceBadge 1s infinite alternate;">${esc(badge.icon)}</div>
      <div style="color: var(--gold, #d4af37); font-weight: 900; font-size: 1.25rem; margin-bottom: 6px;">🎉 إنجاز جديد مفتوح! 🎉</div>
      <div style="color: #fff; font-weight: 700; font-size: 1.1rem; margin-bottom: 8px;">${esc(badge.label)}</div>
      <div style="color: var(--text-muted, #9fb0a6); font-size: 0.85rem;">${esc(badge.desc)}</div>
    `;
    
    document.body.appendChild(popup);
    
    setTimeout(() => {
      popup.style.transform = 'translate(-50%, 0)';
      popup.style.opacity = '1';
    }, 100);
    
    setTimeout(() => {
      popup.style.transform = 'translate(-50%, 100px)';
      popup.style.opacity = '0';
      setTimeout(() => popup.remove(), 600);
    }, 6000);
  }

  function checkNewBadges() {
    const currentBadges = getBadges();
    const currentIds = currentBadges.map(b => b.id);

    if (unlockedBadgeIdsCache === null) {
      unlockedBadgeIdsCache = currentIds;
      return;
    }

    const newlyUnlocked = currentBadges.filter(b => !unlockedBadgeIdsCache.includes(b.id));
    if (newlyUnlocked.length > 0) {
      newlyUnlocked.forEach(b => {
        if (b.id !== 'founder') {
          showBadgeUnlockPopup(b);
        }
      });
      unlockedBadgeIdsCache = [...unlockedBadgeIdsCache, ...newlyUnlocked.map(b => b.id)];
    }
  }

  function _updateUI() {
    const recordEl = document.getElementById('user-record-display');
    if (recordEl) {
      if (AuthManager.isSignedIn()) {
        recordEl.innerHTML = `فوز: ${parseInt(profile.wins) || 0} | خسارة: ${parseInt(profile.losses) || 0} | تعادل: ${parseInt(profile.draws) || 0} <br> <span style="color:var(--gold-primary); font-weight:bold;">🪙 الكوينز: ${parseInt(profile.coins) || 0}</span>`;
      } else {
        recordEl.innerHTML = '';
      }
    }
  }

  return {
    init, recordMatchResult, getProfile, onProfileChange,
    canChangeName, canChangePhoto, updateName, updatePhotoURL, updateBio, uploadPhoto,
    getBadges, isAdmin, getAllBadgeDefs
  };
})();
