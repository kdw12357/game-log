/* =============================================
   GAME LOG APP
   ============================================= */

// ===== STORAGE =====
const Storage = (() => {
  const KEY = 'games';
  const OLD_KEY = 'game-log-data';

  function load() {
    const old = localStorage.getItem(OLD_KEY);
    if (old && !localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, old);
      localStorage.removeItem(OLD_KEY);
    }
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  }

  function save(games) {
    localStorage.setItem(KEY, JSON.stringify(games));
  }

  function exportJSON() {
    const data = load();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `game-log-${dateStr(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const data = JSON.parse(e.target.result);
          if (!Array.isArray(data)) throw new Error('올바르지 않은 형식입니다.');
          save(data);
          resolve(data.length);
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  function dateStr(d) {
    return d.toISOString().slice(0, 10);
  }

  return { load, save, exportJSON, importJSON };
})();

// ===== UTILS =====
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function starsHtml(rating, dim = true) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += i <= rating ? '★' : (dim ? '<span class="dim">★</span>' : '');
  }
  return html;
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function getYear(game) {
  const d = game.endDate || game.startDate;
  if (!d) return '날짜 미정';
  return new Date(d + 'T00:00:00').getFullYear().toString();
}

function endingLabel(val) {
  if (val === 'Yes') return '클리어';
  if (val === 'No') return 'No';
  return '진행 중';
}

function endingBadgeClass(val) {
  if (val === 'Yes') return 'badge-ending-yes';
  if (val === 'No') return 'badge-ending-no';
  return 'badge-ending-playing';
}

function closeAllDropdowns() {
  document.getElementById('menu-dropdown').classList.add('hidden');
}

// ===== ROUTER =====
const Router = (() => {
  let current = 'gallery';

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.classList.add('hidden');
    });
    const el = document.getElementById(`${name}-view`);
    if (el) {
      el.classList.remove('hidden');
      el.classList.add('active');
    }
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    current = name;
    window.scrollTo(0, 0);
  }

  return { showView, getCurrent: () => current };
})();

// ===== TOAST =====
const Toast = (() => {
  function show(msg, type = 'info') {
    const existing = document.getElementById('toast-el');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'toast-el';
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('toast-visible'));
    });
    setTimeout(() => {
      el.classList.remove('toast-visible');
      setTimeout(() => el.remove(), 300);
    }, 2500);
  }

  return { show };
})();

// ===== SYNC =====
const Sync = (() => {
  const SYNC_URL = 'https://reading-proxy.kdw12357.workers.dev/sync?key=games';

  function getSecret() {
    return localStorage.getItem('syncSecret') || '';
  }

  function setStatus(state) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = 'sync-indicator sync-' + state;
    const labels = {
      synced: '동기화됨',
      syncing: '동기화 중...',
      offline: '오프라인',
      failed: '동기화 실패',
      idle: ''
    };
    el.textContent = labels[state] ?? '';
  }

  async function syncDown(manual = false) {
    const secret = getSecret();
    if (!secret) {
      SecretKeyModal.open();
      return;
    }

    setStatus('syncing');
    try {
      const res = await fetch(SYNC_URL, {
        headers: { 'X-Sync-Secret': secret }
      });

      if (res.status === 401) {
        setStatus('failed');
        Toast.show('비밀 키가 올바르지 않습니다', 'error');
        SecretKeyModal.open();
        return;
      }

      if (!res.ok) throw new Error(`서버 오류 (${res.status})`);

      const data = await res.json();
      if (Array.isArray(data.games)) {
        Storage.save(data.games);
        Gallery.render();
        if (Router.getCurrent() === 'stats') Stats.render();
      } else {
        // 서버에 데이터 없으면 로컬 데이터를 서버로 push
        const local = Storage.load();
        if (local.length > 0) syncUp(local);
      }

      setStatus('synced');
      if (manual) Toast.show('동기화 완료', 'success');
    } catch (err) {
      if (!navigator.onLine) {
        setStatus('offline');
        if (manual) Toast.show('오프라인 상태입니다', 'error');
      } else {
        setStatus('failed');
        if (manual) Toast.show('동기화 실패: ' + err.message, 'error');
      }
    }
  }

  async function syncUp(games) {
    const secret = getSecret();
    if (!secret) return;

    setStatus('syncing');
    try {
      const res = await fetch(SYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sync-Secret': secret
        },
        body: JSON.stringify({ games })
      });

      if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
      setStatus('synced');
    } catch {
      setStatus('failed');
      Toast.show('동기화 실패 (로컬 저장 완료)', 'error');
    }
  }

  return { syncDown, syncUp, getSecret, setStatus };
})();

// ===== SECRET KEY MODAL =====
const SecretKeyModal = (() => {
  function open() {
    const current = localStorage.getItem('syncSecret') || '';
    document.getElementById('secret-key-input').value = current;
    document.getElementById('secret-modal-overlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('secret-key-input').focus(), 100);
  }

  function close() {
    document.getElementById('secret-modal-overlay').classList.add('hidden');
  }

  function init() {
    document.getElementById('secret-key-confirm').addEventListener('click', () => {
      const val = document.getElementById('secret-key-input').value.trim();
      if (!val) {
        Toast.show('비밀 키를 입력해주세요', 'error');
        return;
      }
      localStorage.setItem('syncSecret', val);
      close();
      Sync.syncDown();
    });

    document.getElementById('secret-key-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('secret-key-confirm').click();
    });

    document.getElementById('secret-key-delete').addEventListener('click', () => {
      if (!confirm('비밀 키를 삭제할까요? 동기화가 비활성화됩니다.')) return;
      localStorage.removeItem('syncSecret');
      Sync.setStatus('idle');
      close();
      Toast.show('비밀 키가 삭제되었습니다', 'info');
    });

    document.getElementById('secret-key-cancel').addEventListener('click', close);

    document.getElementById('secret-modal-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('secret-modal-overlay')) close();
    });
  }

  return { open, close, init };
})();

// ===== FORM =====
const Form = (() => {
  let editingId = null;
  let coverBase64 = null;

  function open(game = null) {
    editingId = game ? game.id : null;
    coverBase64 = game ? (game.coverImage || null) : null;

    document.getElementById('form-title').textContent = game ? '게임 수정' : '게임 등록';
    document.getElementById('btn-submit-form').textContent = game ? '수정' : '등록';
    document.getElementById('field-id').value = game ? game.id : '';
    document.getElementById('field-title').value = game ? game.title : '';
    document.getElementById('field-platform').value = game ? (game.platform || '') : '';
    document.getElementById('field-start-date').value = game ? (game.startDate || '') : '';
    document.getElementById('field-end-date').value = game ? (game.endDate || '') : '';
    document.getElementById('field-review').value = game ? (game.review || '') : '';
    document.getElementById('field-rating').value = game ? (game.rating || 0) : 0;
    document.getElementById('field-cover').value = '';

    const ending = game ? (game.ending || '진행중') : '진행중';
    document.querySelectorAll('input[name="ending"]').forEach(r => {
      r.checked = r.value === ending;
    });

    setStars(game ? (game.rating || 0) : 0);
    renderCoverPreview(coverBase64);
    Router.showView('form');
  }

  function close() {
    Router.showView('gallery');
    Gallery.render();
  }

  function setStars(val) {
    document.querySelectorAll('#star-input .star').forEach(s => {
      s.classList.toggle('on', parseInt(s.dataset.val) <= val);
    });
    document.getElementById('field-rating').value = val;
  }

  function compressImage(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const MAX = 1200;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            if (width >= height) { height = Math.round(height * MAX / width); width = MAX; }
            else { width = Math.round(width * MAX / height); height = MAX; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderCoverPreview(base64) {
    const preview = document.getElementById('cover-preview');
    if (base64) {
      preview.innerHTML = `<img src="${base64}" alt="커버">`;
    } else {
      preview.innerHTML = '<span class="cover-placeholder">🎮</span>';
    }
  }

  function init() {
    // Star click
    document.querySelectorAll('#star-input .star').forEach(s => {
      s.addEventListener('click', () => setStars(parseInt(s.dataset.val)));
      s.addEventListener('mouseover', () => {
        document.querySelectorAll('#star-input .star').forEach(x => {
          x.classList.toggle('on', parseInt(x.dataset.val) <= parseInt(s.dataset.val));
        });
      });
      s.addEventListener('mouseout', () => {
        const cur = parseInt(document.getElementById('field-rating').value);
        document.querySelectorAll('#star-input .star').forEach(x => {
          x.classList.toggle('on', parseInt(x.dataset.val) <= cur);
        });
      });
    });

    // Cover upload
    document.getElementById('field-cover').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      document.getElementById('cover-preview').innerHTML = '<span class="cover-placeholder">이미지 처리 중...</span>';
      compressImage(file).then(compressed => {
        coverBase64 = compressed;
        renderCoverPreview(coverBase64);
      });
    });

    // Remove cover
    document.getElementById('btn-remove-cover').addEventListener('click', () => {
      coverBase64 = null;
      document.getElementById('field-cover').value = '';
      renderCoverPreview(null);
    });

    // Submit
    document.getElementById('game-form').addEventListener('submit', e => {
      e.preventDefault();
      const title = document.getElementById('field-title').value.trim();
      if (!title) {
        alert('게임 제목을 입력해주세요.');
        return;
      }

      const endingEl = document.querySelector('input[name="ending"]:checked');
      const game = {
        id: editingId || uid(),
        createdAt: editingId ? undefined : new Date().toISOString(),
        title,
        coverImage: coverBase64,
        platform: document.getElementById('field-platform').value,
        ending: endingEl ? endingEl.value : '진행중',
        rating: parseInt(document.getElementById('field-rating').value) || 0,
        startDate: document.getElementById('field-start-date').value,
        endDate: document.getElementById('field-end-date').value,
        review: document.getElementById('field-review').value.trim(),
      };

      const games = Storage.load();
      if (editingId) {
        const idx = games.findIndex(g => g.id === editingId);
        if (idx !== -1) {
          game.createdAt = games[idx].createdAt;
          games[idx] = game;
        }
      } else {
        games.unshift(game);
      }
      Storage.save(games);
      Sync.syncUp(games);

      closeAllDropdowns();
      Router.showView('gallery');
      Gallery.render();
    });

    // Cancel / Close
    document.getElementById('btn-cancel-form').addEventListener('click', close);
    document.getElementById('btn-close-form').addEventListener('click', close);
  }

  return { open, init };
})();

// ===== GALLERY =====
const Gallery = (() => {
  function getYears(games) {
    const ySet = new Set(games.map(getYear));
    return Array.from(ySet).sort((a, b) => {
      if (a === '날짜 미정') return 1;
      if (b === '날짜 미정') return -1;
      return b - a;
    });
  }

  function buildYearOptions(games) {
    const sel = document.getElementById('year-filter');
    const years = getYears(games);
    const curYear = new Date().getFullYear().toString();
    const prev = sel.value;

    sel.innerHTML = '<option value="all">전체</option>';
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y === '날짜 미정' ? y : `${y}년`;
      sel.appendChild(opt);
    });

    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
    } else {
      sel.value = years.includes(curYear) ? curYear : (years[0] || 'all');
    }
  }

  function render() {
    const games = Storage.load();
    buildYearOptions(games);
    renderFiltered(games);
  }

  function renderFiltered(games) {
    const filterVal = document.getElementById('year-filter').value;
    const container = document.getElementById('gallery-container');
    const empty = document.getElementById('gallery-empty');
    const countEl = document.getElementById('gallery-count');

    let filtered = filterVal === 'all' ? games : games.filter(g => getYear(g) === filterVal);

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      countEl.textContent = '';
      return;
    }

    empty.classList.add('hidden');
    countEl.textContent = `${filtered.length}개`;

    // Group by year
    const grouped = {};
    filtered.forEach(g => {
      const y = getYear(g);
      if (!grouped[y]) grouped[y] = [];
      grouped[y].push(g);
    });

    const years = Object.keys(grouped).sort((a, b) => {
      if (a === '날짜 미정') return 1;
      if (b === '날짜 미정') return -1;
      return b - a;
    });

    container.innerHTML = '';
    years.forEach(year => {
      const section = document.createElement('div');
      section.className = 'year-section';
      section.innerHTML = `<h2 class="year-heading">${year === '날짜 미정' ? '날짜 미정' : year + '년'}</h2>`;

      const grid = document.createElement('div');
      grid.className = 'game-grid';

      grouped[year].forEach(game => {
        grid.appendChild(makeCard(game));
      });

      section.appendChild(grid);
      container.appendChild(section);
    });
  }

  function makeCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.dataset.id = game.id;

    let coverHtml;
    if (game.coverImage) {
      coverHtml = `<img class="game-card-cover" src="${game.coverImage}" alt="${game.title}" loading="lazy">`;
    } else {
      coverHtml = `<div class="game-card-placeholder">🎮</div>`;
    }

    const endingBadge = game.ending === 'Yes'
      ? `<span class="card-badge-ending">클리어</span>`
      : '';

    const stars = starsHtml(game.rating);

    card.innerHTML = `
      ${coverHtml}
      ${endingBadge}
      <div class="game-card-body">
        <div class="card-title">${game.title}</div>
        <div class="card-stars">${stars || '<span class="dim">★★★★★</span>'}</div>
      </div>
    `;

    card.addEventListener('click', () => Detail.open(game.id));
    return card;
  }

  function init() {
    document.getElementById('year-filter').addEventListener('change', () => {
      renderFiltered(Storage.load());
    });
    document.getElementById('btn-add-first').addEventListener('click', () => Form.open());

    const rawgInput = document.getElementById('rawg-input');
    const rawgBtn = document.getElementById('rawg-btn');
    function doRawgSearch() {
      const q = rawgInput.value.trim();
      if (!q) return;
      window.open('https://namu.wiki/w/' + encodeURIComponent(q), '_blank');
    }
    rawgBtn.addEventListener('click', doRawgSearch);
    rawgInput.addEventListener('keydown', e => { if (e.key === 'Enter') doRawgSearch(); });
  }

  return { render, init };
})();

// ===== DETAIL =====
const Detail = (() => {
  let currentId = null;

  function open(id) {
    const games = Storage.load();
    const game = games.find(g => g.id === id);
    if (!game) return;
    currentId = id;

    const coverImg = document.getElementById('detail-cover');
    const coverPh = document.getElementById('detail-cover-placeholder');
    if (game.coverImage) {
      coverImg.src = game.coverImage;
      coverImg.classList.remove('hidden');
      coverPh.classList.add('hidden');
    } else {
      coverImg.classList.add('hidden');
      coverPh.classList.remove('hidden');
    }

    document.getElementById('detail-title').textContent = game.title;
    document.getElementById('detail-platform').textContent = game.platform || '플랫폼 미입력';
    document.getElementById('detail-stars').innerHTML = starsHtml(game.rating) || '<span class="dim">★★★★★</span>';

    const endingEl = document.getElementById('detail-ending');
    endingEl.textContent = endingLabel(game.ending);
    endingEl.className = endingBadgeClass(game.ending);

    const dates = [
      game.startDate ? `시작: ${formatDate(game.startDate)}` : '',
      game.endDate ? `종료: ${formatDate(game.endDate)}` : '',
    ].filter(Boolean).join('  →  ');
    document.getElementById('detail-dates').textContent = dates;
    document.getElementById('detail-review').textContent = game.review || '한줄평 없음';

    document.getElementById('detail-overlay').classList.remove('hidden');
  }

  function close() {
    document.getElementById('detail-overlay').classList.add('hidden');
    currentId = null;
  }

  function init() {
    document.getElementById('detail-close').addEventListener('click', close);
    document.getElementById('detail-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('detail-overlay')) close();
    });

    document.getElementById('detail-edit').addEventListener('click', () => {
      const games = Storage.load();
      const game = games.find(g => g.id === currentId);
      close();
      Form.open(game);
    });

    document.getElementById('detail-delete').addEventListener('click', () => {
      if (!confirm('이 게임 기록을 삭제할까요?')) return;
      const games = Storage.load().filter(g => g.id !== currentId);
      Storage.save(games);
      Sync.syncUp(games);
      close();
      Gallery.render();
      if (Router.getCurrent() === 'stats') Stats.render();
    });
  }

  return { open, close, init };
})();

// ===== STATS =====
const Stats = (() => {
  let tlYear = new Date().getFullYear();
  let tlMonth = new Date().getMonth(); // 0-indexed
  let tlPopupGameId = null;
  let currentYearGames = [];

  function getYears(games) {
    const ySet = new Set(games.map(getYear).filter(y => y !== '날짜 미정'));
    const cur = new Date().getFullYear().toString();
    if (!ySet.has(cur)) ySet.add(cur);
    return Array.from(ySet).sort((a, b) => b - a);
  }

  function buildYearOptions(games) {
    const sel = document.getElementById('stats-year');
    const years = getYears(games);
    const curYear = new Date().getFullYear().toString();
    const prev = sel.value;

    sel.innerHTML = '';
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = `${y}년`;
      sel.appendChild(opt);
    });

    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
    } else {
      sel.value = curYear;
    }
  }

  function render() {
    const games = Storage.load();
    buildYearOptions(games);
    renderYear(parseInt(document.getElementById('stats-year').value), games);
  }

  function renderYear(year, games) {
    tlYear = year;
    const yearGames = games.filter(g => getYear(g) === year.toString());
    currentYearGames = yearGames;

    // 4-1 Summary
    document.getElementById('stat-cleared').textContent = yearGames.filter(g => g.ending === 'Yes').length;
    document.getElementById('stat-total').textContent = yearGames.length;
    document.getElementById('stat-playing').textContent = yearGames.filter(g => g.ending === '진행중').length;

    // 4-2 Platform
    renderPlatforms(yearGames);

    // 4-3 Timeline
    renderTimeline(year, tlMonth, games);
  }

  function renderPlatforms(yearGames) {
    const counts = {};
    yearGames.forEach(g => {
      if (!g.platform) return;
      counts[g.platform] = (counts[g.platform] || 0) + 1;
    });

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const container = document.getElementById('platform-cards');
    container.innerHTML = '';

    sorted.forEach(([name, count]) => {
      const card = document.createElement('div');
      card.className = 'platform-card';
      card.innerHTML = `
        <div class="platform-card-name">${name}</div>
        <div class="platform-card-count">${count}</div>
      `;
      card.addEventListener('click', () => openPlatformModal(name, yearGames));
      container.appendChild(card);
    });
  }

  function openGameListModal(title, games) {
    document.getElementById('platform-modal-title').textContent = title;

    const list = document.getElementById('platform-game-list');
    list.innerHTML = '';

    games.forEach(game => {
      const li = document.createElement('li');
      li.className = 'platform-game-item';

      const coverHtml = game.coverImage
        ? `<img class="plt-item-cover" src="${game.coverImage}" alt="">`
        : `<div class="plt-item-placeholder">🎮</div>`;

      const endingStr = endingLabel(game.ending);
      const starsStr = game.rating ? '★'.repeat(game.rating) : '평점 없음';

      li.innerHTML = `
        ${coverHtml}
        <div class="plt-item-info">
          <div class="plt-item-title">${game.title}</div>
          <div class="plt-item-meta">${endingStr} · ${starsStr}</div>
        </div>
      `;
      li.addEventListener('click', () => {
        closePlatformModal();
        Detail.open(game.id);
      });
      list.appendChild(li);
    });

    document.getElementById('platform-overlay').classList.remove('hidden');
  }

  function openPlatformModal(platform, yearGames) {
    const games = yearGames.filter(g => g.platform === platform);
    openGameListModal(`${platform} (${games.length}개)`, games);
  }

  function closePlatformModal() {
    document.getElementById('platform-overlay').classList.add('hidden');
  }

  // ---- TIMELINE ----
  function renderTimeline(year, month, allGames) {
    tlYear = year;
    tlMonth = month;

    const label = `${year}년 ${month + 1}월`;
    document.getElementById('tl-label').textContent = label;

    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month, daysInMonth, 23, 59, 59);

    const relevant = allGames.filter(g => {
      const s = g.startDate ? new Date(g.startDate + 'T00:00:00') : null;
      const e = g.endDate ? new Date(g.endDate + 'T00:00:00') : null;
      if (!s && !e) return false;
      const start = s || e;
      const end = e || s;
      return start <= monthEnd && end >= monthStart;
    });

    const container = document.getElementById('timeline-container');
    const emptyEl = document.getElementById('timeline-empty');

    if (relevant.length === 0) {
      container.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    const DAY_WIDTH = 30;
    const daysAreaWidth = daysInMonth * DAY_WIDTH;

    // Header row
    container.innerHTML = '';
    const headerRow = document.createElement('div');
    headerRow.className = 'tl-row-header';
    headerRow.innerHTML = `<div class="tl-header-label">게임</div>`;
    const headerDays = document.createElement('div');
    headerDays.className = 'tl-days';
    headerDays.style.width = daysAreaWidth + 'px';
    for (let d = 1; d <= daysInMonth; d++) {
      const col = document.createElement('div');
      col.className = 'tl-day-col';
      col.textContent = d;
      headerDays.appendChild(col);
    }
    headerRow.appendChild(headerDays);
    container.appendChild(headerRow);

    relevant.forEach(game => {
      const row = document.createElement('div');
      row.className = 'tl-row';

      const labelDiv = document.createElement('div');
      labelDiv.className = 'tl-game-label';
      labelDiv.innerHTML = `<span class="tl-game-name">${game.title}</span>`;
      row.appendChild(labelDiv);

      const barArea = document.createElement('div');
      barArea.className = 'tl-bar-area';
      barArea.style.position = 'relative';
      barArea.style.width = daysAreaWidth + 'px';

      const s = game.startDate ? new Date(game.startDate + 'T00:00:00') : new Date(game.endDate + 'T00:00:00');
      const e = game.endDate ? new Date(game.endDate + 'T00:00:00') : new Date(game.startDate + 'T00:00:00');

      const clampedStart = Math.max(1, s.getFullYear() === year && s.getMonth() === month ? s.getDate() : 1);
      const clampedEnd = Math.min(daysInMonth, e.getFullYear() === year && e.getMonth() === month ? e.getDate() : daysInMonth);

      const leftPct = ((clampedStart - 1) / daysInMonth) * 100;
      const widthPct = ((clampedEnd - clampedStart + 1) / daysInMonth) * 100;

      const bar = document.createElement('div');
      bar.className = 'tl-bar';
      bar.style.left = leftPct + '%';
      bar.style.width = `calc(${widthPct}% - 4px)`;
      bar.innerHTML = `<span class="tl-bar-text">${game.title}</span>`;
      bar.addEventListener('click', e => {
        e.stopPropagation();
        openTlPopup(game.id);
      });

      barArea.appendChild(bar);
      row.appendChild(barArea);
      container.appendChild(row);
    });
  }

  function openTlPopup(id) {
    const games = Storage.load();
    const game = games.find(g => g.id === id);
    if (!game) return;
    tlPopupGameId = id;

    const popupCover = document.getElementById('tl-popup-cover');
    const popupPh = document.getElementById('tl-popup-placeholder');
    if (game.coverImage) {
      popupCover.src = game.coverImage;
      popupCover.classList.remove('hidden');
      popupPh.classList.add('hidden');
    } else {
      popupCover.classList.add('hidden');
      popupPh.classList.remove('hidden');
    }

    document.getElementById('tl-popup-title').textContent = game.title;
    const meta = [
      game.platform || '',
      endingLabel(game.ending),
      game.rating ? '★'.repeat(game.rating) : '',
    ].filter(Boolean).join(' · ');
    document.getElementById('tl-popup-meta').textContent = meta;

    document.getElementById('tl-popup').classList.remove('hidden');
    document.getElementById('tl-popup-backdrop').classList.remove('hidden');
  }

  function closeTlPopup() {
    document.getElementById('tl-popup').classList.add('hidden');
    document.getElementById('tl-popup-backdrop').classList.add('hidden');
    tlPopupGameId = null;
  }

  function init() {
    document.getElementById('stats-year').addEventListener('change', e => {
      const games = Storage.load();
      renderYear(parseInt(e.target.value), games);
    });

    document.getElementById('tl-prev').addEventListener('click', () => {
      tlMonth--;
      if (tlMonth < 0) { tlMonth = 11; tlYear--; }
      renderTimeline(tlYear, tlMonth, Storage.load());
    });

    document.getElementById('tl-next').addEventListener('click', () => {
      tlMonth++;
      if (tlMonth > 11) { tlMonth = 0; tlYear++; }
      renderTimeline(tlYear, tlMonth, Storage.load());
    });

    document.getElementById('platform-close').addEventListener('click', e => {
      e.stopPropagation();
      closePlatformModal();
    });
    document.getElementById('platform-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('platform-overlay')) closePlatformModal();
    });

    document.getElementById('card-cleared').addEventListener('click', () => {
      const games = currentYearGames.filter(g => g.ending === 'Yes');
      openGameListModal(`${tlYear}년 · 클리어 (${games.length}개)`, games);
    });

    document.getElementById('card-total').addEventListener('click', () => {
      openGameListModal(`${tlYear}년 · 총 플레이 (${currentYearGames.length}개)`, currentYearGames);
    });

    document.getElementById('card-playing').addEventListener('click', () => {
      const games = currentYearGames.filter(g => g.ending === '진행중');
      openGameListModal(`${tlYear}년 · 진행 중 (${games.length}개)`, games);
    });

    document.getElementById('tl-popup-close').addEventListener('click', closeTlPopup);
    document.getElementById('tl-popup-backdrop').addEventListener('click', closeTlPopup);

    document.getElementById('tl-popup-detail').addEventListener('click', () => {
      const id = tlPopupGameId;
      closeTlPopup();
      Detail.open(id);
    });
  }

  return { render, init };
})();

// ===== MENU =====
const Menu = (() => {
  function init() {
    const btn = document.getElementById('btn-menu');
    const dropdown = document.getElementById('menu-dropdown');

    btn.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', closeAllDropdowns);
    dropdown.addEventListener('click', e => e.stopPropagation());

    document.getElementById('menu-export').addEventListener('click', () => {
      closeAllDropdowns();
      Storage.exportJSON();
    });

    document.getElementById('menu-import').addEventListener('click', () => {
      closeAllDropdowns();
      document.getElementById('import-file-input').click();
    });

    document.getElementById('menu-sync').addEventListener('click', () => {
      closeAllDropdowns();
      Sync.syncDown(true);
    });

    document.getElementById('menu-secret').addEventListener('click', () => {
      closeAllDropdowns();
      SecretKeyModal.open();
    });

    document.getElementById('import-file-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const count = await Storage.importJSON(file);
        alert(`${count}개의 게임 기록을 가져왔습니다.`);
        Sync.syncUp(Storage.load());
        Gallery.render();
        if (Router.getCurrent() === 'stats') Stats.render();
      } catch (err) {
        alert('가져오기 실패: ' + err.message);
      }
      e.target.value = '';
    });
  }

  return { init };
})();

// ===== PWA / ICONS =====
function generateIcons() {
  const sizes = [192, 512];
  sizes.forEach(size => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Background
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#1E40AF');
    grad.addColorStop(1, '#0F172A');
    ctx.fillStyle = grad;
    roundRect(ctx, 0, 0, size, size, size * 0.18);
    ctx.fill();

    // Gamepad body
    const cx = size / 2, cy = size / 2;
    const s = size * 0.55;
    ctx.fillStyle = '#3B82F6';
    ctx.beginPath();
    ctx.ellipse(cx, cy, s / 2, s / 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // D-pad left
    const dp = size * 0.08;
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - s * 0.32 - dp * 0.5, cy - dp * 1.5, dp, dp * 3);
    ctx.fillRect(cx - s * 0.32 - dp * 1.5, cy - dp * 0.5, dp * 3, dp);

    // Buttons right
    const br = size * 0.04;
    const bx = cx + s * 0.25, by = cy;
    ctx.fillStyle = '#06B6D4';
    ctx.beginPath(); ctx.arc(bx, by - br * 2.2, br, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FBBF24';
    ctx.beginPath(); ctx.arc(bx + br * 2.2, by, br, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#EF4444';
    ctx.beginPath(); ctx.arc(bx, by + br * 2.2, br, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#4ADE80';
    ctx.beginPath(); ctx.arc(bx - br * 2.2, by, br, 0, Math.PI * 2); ctx.fill();

    // Handles
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.ellipse(cx - s * 0.38, cy + s * 0.15, s * 0.16, s * 0.22, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + s * 0.38, cy + s * 0.15, s * 0.16, s * 0.22, 0.3, 0, Math.PI * 2);
    ctx.fill();

    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('link');
      link.rel = 'icon';
      link.sizes = `${size}x${size}`;
      link.href = url;
      document.head.appendChild(link);
    }, 'image/png');
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      Router.showView(tab);
      if (tab === 'gallery') Gallery.render();
      if (tab === 'stats') Stats.render();
    });
  });

  // Add game button
  document.getElementById('btn-add-game').addEventListener('click', () => {
    closeAllDropdowns();
    Form.open();
  });

  // Init modules
  Form.init();
  Gallery.init();
  Detail.init();
  Stats.init();
  Menu.init();
  SecretKeyModal.init();

  // Initial render
  Router.showView('gallery');
  Gallery.render();

  // Auto-sync on startup
  if (Sync.getSecret()) {
    Sync.syncDown();
  } else {
    SecretKeyModal.open();
  }

  // PWA
  generateIcons();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
});
