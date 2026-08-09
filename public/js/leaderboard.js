// Leaderboard Manager
// Fetches top players from Firebase Realtime Database and renders them.
//
// Shared by both public/deal/index.html and public/mazad/index.html, so it
// has no game-specific assumptions beyond the 4 category keys below. Each
// category is its own leaderboard, scoped to users/{uid}/profile/stats/{gameKey}
// (the old flat users/{uid}/profile/{wins,losses,draws} cross-game total is
// left completely alone - it's still written elsewhere and still means
// "total across every game mode").

const LeaderboardManager = (() => {
  let isFetching = false;

  // Founder account - ranked normally, marked with badge. Matched by email
  // or phone (see user-profile.js), not a database flag.
  const ADMIN_EMAIL = 'slyman776688@gmail.com';
  const ADMIN_PHONE = '+201146131457';

  // The 4 leaderboard categories that exist right now. `key` is the
  // Firebase gameKey segment under profile/stats/, `id` is the DOM id of
  // its tab button, `label` is the exact Arabic tab text.
  const CATEGORIES = [
    { key: 'dond_classic', id: 'lb-tab-dond-classic', label: '⚡ صفقة سريع' },
    { key: 'dond_full', id: 'lb-tab-dond-full', label: '🏟️ صفقة كامل' },
    { key: 'mazad_classic', id: 'lb-tab-mazad-classic', label: '🔨 مزاد سريع' },
    { key: 'mazad_full', id: 'lb-tab-mazad-full', label: '🔨 مزاد كامل' }
  ];

  // Safety net only - the real fix is adding these 4 buttons directly to
  // index.html. If they're already there (real ids present), do nothing so
  // we never duplicate buttons. Only runs when the HTML hasn't been
  // updated yet.
  function _ensureTabButtons() {
    if (document.getElementById(CATEGORIES[0].id)) return;

    // Find the row the old 2-tab pair lived in, so the new buttons land in
    // the same visual slot. Preference order:
    // 1) the shared ".lb-tabs" row class (current markup in both
    //    public/deal/index.html and public/mazad/index.html has this on
    //    the container div wrapping lb-tab-all/lb-tab-weekly).
    // 2) the old #lb-tab-all button's own parentNode, in case the class
    //    isn't there for some reason but the old button id still is.
    // 3) a freshly created row inserted right before #leaderboard-list, so
    //    the modal never ends up with zero tabs.
    let container = document.querySelector('.lb-tabs');
    const oldTabAll = document.getElementById('lb-tab-all');
    const oldTabWeekly = document.getElementById('lb-tab-weekly');

    if (!container && oldTabAll && oldTabAll.parentNode) {
      container = oldTabAll.parentNode;
    }

    if (!container) {
      const listEl = document.getElementById('leaderboard-list');
      if (!listEl || !listEl.parentNode) return; // nothing to attach to, bail quietly
      container = document.createElement('div');
      container.className = 'lb-tabs';
      container.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:-10px;margin-bottom:15px;flex-wrap:wrap;';
      listEl.parentNode.insertBefore(container, listEl);
    }

    // The all/weekly pair is being fully replaced by the 4 category tabs -
    // drop them so the modal doesn't show stale controls next to the new ones.
    if (oldTabAll) oldTabAll.remove();
    if (oldTabWeekly) oldTabWeekly.remove();

    CATEGORIES.forEach((cat, i) => {
      const btn = document.createElement('button');
      btn.id = cat.id;
      // Same classes/inline-style pattern the old lb-tab-all/lb-tab-weekly
      // buttons used, just 4 instead of 2.
      btn.className = 'btn-secondary' + (i === 0 ? ' active' : '');
      btn.style.cssText = 'padding:5px 15px;border-radius:20px;font-size:0.9rem;' + (i === 0 ? '' : 'opacity:0.5;');
      btn.textContent = cat.label;
      container.appendChild(btn);
    });
  }

  function init() {
    _ensureTabButtons();

    const btnOpen = document.getElementById('btn-leaderboard');
    const btnClose = document.getElementById('btn-close-leaderboard');
    const modal = document.getElementById('leaderboard-modal');

    // Tabs - 4 category buttons instead of the old all/weekly pair.
    const tabButtons = CATEGORIES.map(cat => document.getElementById(cat.id));

    function _activateTab(gameKey) {
      tabButtons.forEach((btn, i) => {
        if (!btn) return;
        const isActive = CATEGORIES[i].key === gameKey;
        btn.classList.toggle('active', isActive);
        btn.style.opacity = isActive ? '1' : '0.5';
      });
      _fetchAndRender(gameKey);
    }

    if (btnOpen) {
      btnOpen.addEventListener('click', () => {
        if (modal) modal.classList.remove('hidden');
        _activateTab(CATEGORIES[0].key); // default active tab on open: dond_classic
      });
    }

    if (btnClose) {
      btnClose.addEventListener('click', () => {
        if (modal) modal.classList.add('hidden');
      });
    }

    tabButtons.forEach((btn, i) => {
      if (!btn) return;
      btn.addEventListener('click', () => _activateTab(CATEGORIES[i].key));
    });
  }

  async function _fetchAndRender(gameKey) {
    const listEl = document.getElementById('leaderboard-list');
    if (!listEl) return;

    if (isFetching) return;
    isFetching = true;

    listEl.innerHTML = '<div class="loader-spinner">جاري تحميل المتصدرين...</div>';

    try {
      // Fetch top 10 users ordered by wins within this specific game
      // category (users/{uid}/profile/stats/{gameKey}/wins), not the old
      // cross-game total. docs/firebase-rules.json indexes this path.
      const statPath = 'profile/stats/' + gameKey + '/wins';
      const snap = await db.ref('users')
                           .orderByChild(statPath)
                           .limitToLast(10)
                           .once('value');

      const users = [];
      snap.forEach(child => {
        const data = child.val();
        const catStats = data && data.profile && data.profile.stats && data.profile.stats[gameKey];
        // Skip users who have no stats entry at all for this category -
        // the query still returns them (missing sorts lowest) when fewer
        // than 10 users exist total, but they don't belong on this tab.
        if (data && data.profile && catStats) {
          users.push({
            name: data.profile.name || 'لاعب مجهول',
            wins: catStats.wins || 0,
            losses: catStats.losses || 0,
            photo: data.profile.photoURL || '',
            isFounder: data.profile.email === ADMIN_EMAIL || data.profile.phone === ADMIN_PHONE
          });
        }
      });

      // Sort descending (Firebase orders ascending by default). The founder
      // account ranks purely on real wins here, same as everyone else - no
      // pinning to #1.
      users.sort((a, b) => b.wins - a.wins);

      listEl.innerHTML = '';

      if (users.length === 0) {
        listEl.innerHTML = '<div class="empty-state">لا يوجد بيانات حتى الآن. كن أول المتصدرين!</div>';
        isFetching = false;
        return;
      }

      users.forEach((u, index) => {
        let rankClass = '';
        if (index === 0) rankClass = 'rank-first';
        else if (index === 1) rankClass = 'rank-second';
        else if (index === 2) rankClass = 'rank-third';

        let medal = `#${index + 1}`;
        if (index === 0) medal = '🥇';
        else if (index === 1) medal = '🥈';
        else if (index === 2) medal = '🥉';

        // u.photo/u.name come straight from a Firebase path anyone can write
        // to unauthenticated (users/*/profile). safeImageUrl() rejects
        // anything that isn't a plain http(s) URL (blocks the classic
        // `x" onerror="...` attribute-injection payload), and esc() covers
        // the name.
        const item = document.createElement('div');
        item.className = `leaderboard-item ${rankClass}`;
        item.innerHTML = `
          <div class="lb-rank">${medal}</div>
          <div class="lb-player">
            <img src="${esc(safeImageUrl(u.photo, '/dond_app_icon.png'))}" class="lb-avatar" onerror="this.src='/dond_app_icon.png'">
            <span class="lb-name">${esc(u.name)}${u.isFounder ? ' <span style="color:var(--gold-primary,#d4af37); font-size:0.75em;">(مؤسس اللعبة)</span>' : ''}</span>
          </div>
          <div class="lb-stats">
            <span class="lb-wins">${esc(u.wins)} فوز</span>
          </div>
        `;
        listEl.appendChild(item);
      });

    } catch (err) {
      console.error('Leaderboard error:', err);
      listEl.innerHTML = '<div class="error-msg">حدث خطأ في جلب البيانات!</div>';
    } finally {
      isFetching = false;
    }
  }

  return { init };
})();
