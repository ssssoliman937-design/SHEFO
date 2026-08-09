// Profile settings modal controller - shared by both games (deal + mazad
// both load this after auth.js/user-profile.js). Handles the "✏️" button
// on the profile badge: editable name/photo (rate-limited to once/week via
// UserProfileManager.canChangeName/canChangePhoto), a bio field, and a
// read-only badges list computed from stats.

document.addEventListener('DOMContentLoaded', () => {
  const btnOpenProfile = document.getElementById('btn-open-profile');
  const profileModal = document.getElementById('profile-modal');
  const btnCloseProfile = document.getElementById('btn-close-profile');
  const avatarPreview = document.getElementById('profile-avatar-preview');
  const nameInput = document.getElementById('profile-name-input');
  const nameHint = document.getElementById('profile-name-hint');
  const btnSaveName = document.getElementById('btn-save-name');
  const photoFileInput = document.getElementById('profile-photo-file');
  const photoHint = document.getElementById('profile-photo-hint');
  const bioInput = document.getElementById('profile-bio-input');
  const btnSaveBio = document.getElementById('btn-save-bio');
  const badgesList = document.getElementById('profile-badges-list');

  if (!profileModal || typeof UserProfileManager === 'undefined') return;

  // app.js's showNotification() is a closure-local function in both games
  // (never attached to window), so this separate DOMContentLoaded listener
  // can't call it directly - write to the shared #notification-banner
  // element itself instead, same element/behavior both games' own
  // showNotification() already uses.
  let notifTimeoutId = null;
  function notify(msg, duration = 4000) {
    const banner = document.getElementById('notification-banner');
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.remove('hidden');
    if (notifTimeoutId) clearTimeout(notifTimeoutId);
    notifTimeoutId = setTimeout(() => banner.classList.add('hidden'), duration);
  }

  function formatWait(ms) {
    const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
    return `متاح تاني بعد ${days} يوم`;
  }

  function renderBadges() {
    if (!badgesList) return;
    const unlockedBadges = UserProfileManager.getBadges();
    const isAdmin = typeof UserProfileManager.isAdmin === 'function' && UserProfileManager.isAdmin();
    const allDefs = [
      ...(isAdmin ? [{ id: 'founder', icon: '👑', label: 'مؤسس اللعبة', desc: 'مطور اللعبة ومؤسسها' }] : []),
      ...UserProfileManager.getAllBadgeDefs()
    ];

    badgesList.innerHTML = allDefs.map(b => {
      const isUnlocked = unlockedBadges.some(ub => ub.id === b.id);
      if (isUnlocked) {
        return `<span class="profile-badge-chip unlocked" title="${esc(b.desc || b.label)} (مفتوح)">${esc(b.icon)} ${esc(b.label)}</span>`;
      } else {
        return `<span class="profile-badge-chip locked" title="طريقة الفتح: ${esc(b.desc)}">${esc(b.icon)} ${esc(b.label)}</span>`;
      }
    }).join('');
  }

  function populateModal() {
    const p = UserProfileManager.getProfile();
    if (avatarPreview) avatarPreview.src = safeImageUrl(p.photoURL, '/dond_app_icon.png');
    if (nameInput) nameInput.value = p.name || '';
    if (bioInput) bioInput.value = p.bio || '';

    const nameCheck = UserProfileManager.canChangeName();
    if (nameHint) nameHint.textContent = nameCheck.ok ? '' : formatWait(nameCheck.waitMs);
    if (btnSaveName) btnSaveName.disabled = !nameCheck.ok;

    const photoCheck = UserProfileManager.canChangePhoto();
    if (photoHint) photoHint.textContent = photoCheck.ok ? '' : formatWait(photoCheck.waitMs);
    if (photoFileInput) photoFileInput.disabled = !photoCheck.ok;

    renderBadges();
  }

  btnOpenProfile?.addEventListener('click', () => {
    if (typeof AuthManager === 'undefined' || !AuthManager.isSignedIn()) {
      notify('⚠️ سجل دخولك الأول عشان تقدر تعدّل بروفايلك');
      return;
    }
    populateModal();
    profileModal.classList.remove('hidden');
  });
  btnCloseProfile?.addEventListener('click', () => profileModal.classList.add('hidden'));

  btnSaveName?.addEventListener('click', async () => {
    try {
      await UserProfileManager.updateName(nameInput.value);
      notify('✅ اتغيّر اسمك!');
      populateModal();
    } catch (err) {
      const messages = {
        NAME_RATE_LIMITED: '❌ تقدر تغيّر اسمك مرة كل أسبوع بس',
        NAME_TOO_SHORT: '❌ الاسم لازم يكون 3 حروف على الأقل'
      };
      notify(messages[err.message] || '❌ حصل خطأ');
    }
  });

  photoFileInput?.addEventListener('change', async () => {
    const file = photoFileInput.files && photoFileInput.files[0];
    if (!file) return;
    try {
      await UserProfileManager.uploadPhoto(file);
      notify('✅ اتغيّرت صورتك!');
      populateModal();
    } catch (err) {
      const messages = {
        PHOTO_RATE_LIMITED: '❌ تقدر تغيّر صورتك مرة كل أسبوع بس',
        NOT_AN_IMAGE: '❌ لازم تختار صورة',
        FILE_TOO_LARGE: '❌ الصورة كبيرة أوي (حد أقصى 2 ميجا)',
        NOT_SIGNED_IN: '❌ سجل دخولك الأول'
      };
      notify(messages[err.message] || '❌ حصل خطأ في رفع الصورة');
    } finally {
      photoFileInput.value = '';
    }
  });

  btnSaveBio?.addEventListener('click', async () => {
    await UserProfileManager.updateBio(bioInput.value);
    notify('✅ اتحفظ الوصف!');
  });
});
