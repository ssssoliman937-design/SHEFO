// Google Sign-In Authentication Module
// Uses Firebase Auth (compat) with Google provider

const AuthManager = (() => {
  let currentUser = null;
  let authReadyResolve = null;
  const authReady = new Promise(resolve => { authReadyResolve = resolve; });

  function init() {
    // Auth is entirely optional - the game is playable by just typing a name
    // (see firebase-engine.js -> FIREBASE_AUTH_ENABLED). Skip touching
    // firebase.auth() at all when the config still has placeholder keys,
    // otherwise every call fails with auth/invalid-api-key.
    if (!window.FIREBASE_AUTH_ENABLED) {
      if (authReadyResolve) { authReadyResolve(); authReadyResolve = null; }
      return;
    }
    try {
      firebase.auth().onAuthStateChanged(user => {
        if (!user) {
          const savedMock = localStorage.getItem('dond_local_guest');
          if (savedMock) {
            try { user = JSON.parse(savedMock); } catch(e){}
          }
        }
        currentUser = user;
        if (authReadyResolve) { authReadyResolve(); authReadyResolve = null; }
        _updateUI(user);
      });
    } catch (err) {
      console.error('Firebase Auth Error:', err.message);
      if (authReadyResolve) { authReadyResolve(); authReadyResolve = null; }
    }
  }

  async function signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const result = await firebase.auth().signInWithPopup(provider);
      return result.user;
    } catch (err) {
      // If popup blocked, try redirect
      if (err.code === 'auth/popup-blocked') {
        await firebase.auth().signInWithRedirect(provider);
        return null;
      }
      console.error('Auth error:', err.message);
      throw err;
    }
  }

  // Phone sign-in: two-step flow (Firebase compat SDK requires an invisible
  // reCAPTCHA verifier attached to a real DOM node before sending the SMS
  // code). #recaptcha-container must exist in the page - both games' lobby
  // markup has it next to the phone number field. confirmationResult is
  // held here between the two steps of one attempt; a fresh sendPhoneCode()
  // call replaces it (matches - you can only have one pending code request
  // in flight at a time).
  let recaptchaVerifier = null;
  let confirmationResult = null;

  function _ensureRecaptcha() {
    if (recaptchaVerifier) return recaptchaVerifier;
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', { size: 'invisible' });
    return recaptchaVerifier;
  }

  async function sendPhoneCode(phoneNumber) {
    const verifier = _ensureRecaptcha();
    confirmationResult = await firebase.auth().signInWithPhoneNumber(phoneNumber, verifier);
  }

  async function verifyPhoneCode(code) {
    if (!confirmationResult) throw new Error('NO_PENDING_CODE');
    const result = await confirmationResult.confirm(code);
    confirmationResult = null;
    return result.user;
  }

  async function signInAsGuest() {
    try {
      const result = await firebase.auth().signInAnonymously();
      return result.user;
    } catch (err) {
      if (err.code === 'auth/network-request-failed') {
        console.warn('Network error: Falling back to local offline guest mode.');
        const mockUser = { 
          uid: 'guest_' + Math.random().toString(36).substring(2, 10), 
          isAnonymous: true, 
          isLocal: true, 
          displayName: 'ضيف' 
        };
        localStorage.setItem('dond_local_guest', JSON.stringify(mockUser));
        currentUser = mockUser;
        _updateUI(mockUser);
        return mockUser;
      }
      console.error('Guest Auth error:', err.message);
      throw err;
    }
  }

  async function signOut() {
    localStorage.removeItem('dond_local_guest');
    try { await firebase.auth().signOut(); } catch(e){}
    currentUser = null;
    _updateUI(null);
  }

  function getUser() { return currentUser; }
  function getUid() { return currentUser ? currentUser.uid : null; }
  function getName() { 
    if (!currentUser) return null;
    return currentUser.isAnonymous ? 'ضيف_' + currentUser.uid.substring(0, 4) : currentUser.displayName;
  }
  function getPhoto() { return currentUser ? currentUser.photoURL : null; }
  function isSignedIn() { return !!currentUser; }
  function isGuest() { return currentUser ? currentUser.isAnonymous : false; }

  function _updateUI(user) {
    const authSection = document.getElementById('auth-section');
    const profileBadge = document.getElementById('user-profile-badge');
    const nameInput = document.getElementById('player-name-input');

    if (user) {
      // Signed in
      if (authSection) authSection.classList.add('signed-in');
      if (profileBadge) {
        profileBadge.classList.remove('hidden');
        const avatar = profileBadge.querySelector('.user-avatar');
        const nameEl = profileBadge.querySelector('.user-display-name');
        if (avatar) avatar.src = user.photoURL || '/dond_app_icon.png';
        if (nameEl) nameEl.textContent = getName() || 'لاعب';
      }
      // Prefill the name field from the account, but never lock it - the
      // player can still type their own in-game name over it.
      if (nameInput && !nameInput.value) {
        nameInput.value = getName() || '';
      }
      if (window.FIREBASE_AUTH_ENABLED) {
        _toggle('.auth-signed-in', true);
        _toggle('.auth-signed-out', false);
      }
    } else {
      // Signed out
      if (authSection) authSection.classList.remove('signed-in');
      if (profileBadge) profileBadge.classList.add('hidden');
      if (window.FIREBASE_AUTH_ENABLED) {
        _toggle('.auth-signed-in', false);
        _toggle('.auth-signed-out', true);
      }
    }
  }

  function _toggle(selector, show) {
    document.querySelectorAll(selector).forEach(el => {
      el.classList.toggle('hidden', !show);
    });
  }

  return { init, signInWithGoogle, signInAsGuest, sendPhoneCode, verifyPhoneCode, signOut, getUser, getUid, getName, getPhoto, isSignedIn, isGuest, authReady };
})();
