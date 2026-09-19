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

  // 저장 성공 여부를 반환 (localStorage 한도 초과 시 예외 대신 false)
  function save(games) {
    try {
      localStorage.setItem(KEY, JSON.stringify(games));
      return true;
    } catch (err) {
      Toast.show('저장 공간이 부족해 저장하지 못했습니다', 'error');
      return false;
    }
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
          if (!save(data)) throw new Error('저장 공간이 부족합니다.');
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

// ===== IMAGE DB (IndexedDB) =====
// 커버 이미지는 Blob으로 IndexedDB에 저장하고, games에는 coverImageId만 둔다.
const ImageDB = (() => {
  const DB_NAME = 'game-images';
  const STORE = 'images';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB를 지원하지 않습니다')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('DB가 다른 탭에서 사용 중입니다')); };
    });
    return dbPromise;
  }

  // fn(store)이 반환한 request의 결과를 트랜잭션 완료 후 resolve
  function run(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let result;
      const req = fn(t.objectStore(STORE));
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('트랜잭션이 취소되었습니다'));
    }));
  }

  function newId() {
    return 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  async function saveImage(blob, id = newId()) {
    await run('readwrite', s => s.put({ id, blob, createdAt: Date.now() }));
    return id;
  }

  async function getImage(id) {
    const rec = await run('readonly', s => s.get(id));
    return rec ? rec.blob : null;
  }

  function deleteImage(id) {
    return run('readwrite', s => s.delete(id));
  }

  async function getAllImageIds() {
    return (await run('readonly', s => s.getAllKeys())) || [];
  }

  // 저장공간 표시용: 이미지 개수와 총 바이트
  function getStats() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const stats = { count: 0, bytes: 0, sizes: new Map() };
      t.objectStore(STORE).openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        const size = cur.value.blob ? cur.value.blob.size : 0;
        stats.count++;
        stats.bytes += size;
        stats.sizes.set(cur.key, size);
        cur.continue();
      };
      t.oncomplete = () => resolve(stats);
      t.onerror = () => reject(t.error);
    }));
  }

  return { openDB, newId, saveImage, getImage, deleteImage, getAllImageIds, getStats };
})();

// ===== IMAGE URL (objectURL 수명 관리) =====
// scope 단위로 objectURL을 추적하고, release(scope) 때 한꺼번에 revoke한다.
const ImageURL = (() => {
  const urls = new Map();  // scope -> Set<url>
  const gens = new Map();  // scope -> 세대 번호 (release 이후 도착한 늦은 결과를 버리기 위함)

  function gen(scope) { return gens.get(scope) || 0; }

  function track(scope, url) {
    if (!urls.has(scope)) urls.set(scope, new Set());
    urls.get(scope).add(url);
  }

  // Blob을 objectURL로 만들어 scope에 등록 (직접 가진 Blob용)
  function fromBlob(blob, scope) {
    const url = URL.createObjectURL(blob);
    track(scope, url);
    return url;
  }

  // IndexedDB에서 id로 조회해 objectURL 반환. 없거나 scope가 이미 해제됐으면 null
  async function urlFor(id, scope) {
    const g = gen(scope);
    const blob = await ImageDB.getImage(id);
    if (!blob) return null;
    if (g !== gen(scope)) return null;
    return fromBlob(blob, scope);
  }

  function release(scope) {
    gens.set(scope, gen(scope) + 1);
    const set = urls.get(scope);
    if (set) set.forEach(u => URL.revokeObjectURL(u));
    urls.delete(scope);
  }

  // container 안의 <img data-image-id>를 채운다. 이미지가 없으면 플레이스홀더로 교체
  function hydrate(container, scope) {
    container.querySelectorAll('img[data-image-id]').forEach(img => {
      const placeholder = () => {
        if (!img.isConnected) return;
        const ph = document.createElement('div');
        ph.className = img.dataset.ph || 'game-card-placeholder';
        ph.textContent = '🎮';
        img.replaceWith(ph);
      };
      urlFor(img.dataset.imageId, scope).then(url => {
        if (!img.isConnected) { if (url) URL.revokeObjectURL(url); return; }
        if (url) { img.alt = img.dataset.alt || ''; img.src = url; }
        else placeholder();
      }).catch(placeholder);
    });
  }

  // 단일 <img> + 플레이스홀더 요소 쌍(상세 모달, 타임라인 팝업)
  function showCover(imgEl, phEl, game, scope) {
    const showPh = () => {
      imgEl.classList.add('hidden');
      imgEl.removeAttribute('src');
      phEl.classList.remove('hidden');
    };
    const showImg = src => {
      imgEl.src = src;
      imgEl.classList.remove('hidden');
      phEl.classList.add('hidden');
    };
    if (game.coverImageId) {
      showPh();
      urlFor(game.coverImageId, scope).then(u => { if (u) showImg(u); }).catch(() => {});
    } else if (game.coverImage) {
      showImg(game.coverImage); // 아직 변환되지 않은 옛 base64
    } else {
      showPh();
    }
  }

  // 카드/목록용 <img> 마크업. id가 있으면 hydrate가 채우고, 옛 base64면 바로 src
  function imgHtml(game, cls, phCls) {
    if (game.coverImageId) {
      return `<img class="${cls}" data-image-id="${game.coverImageId}" data-ph="${phCls}" data-alt="${game.title.replace(/"/g, '&quot;')}" alt="" loading="lazy">`;
    }
    if (game.coverImage) {
      return `<img class="${cls}" src="${game.coverImage}" alt="${game.title.replace(/"/g, '&quot;')}" loading="lazy">`;
    }
    return `<div class="${phCls}">🎮</div>`;
  }

  return { fromBlob, urlFor, release, hydrate, showCover, imgHtml };
})();

// coverImageId가 더 이상 어떤 게임에서도 쓰이지 않으면 IndexedDB에서 삭제
async function deleteImageIfUnused(id, games) {
  if (!id) return;
  if (games.some(g => g.coverImageId === id)) return;
  try { await ImageDB.deleteImage(id); } catch { /* 정리 메뉴에서 다시 지울 수 있음 */ }
}

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

// ===== MIGRATION (base64 coverImage → IndexedDB coverImageId) =====
const Migration = (() => {
  const FLAG = 'game_imagesMigrated';
  let running = null;

  function isLegacy(g) {
    return typeof g.coverImage === 'string' && g.coverImage.startsWith('data:image');
  }

  // dataURL → Blob (재압축 없이 그대로 바이너리로 변환)
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = (dataUrl.slice(5, comma).split(';')[0]) || 'image/jpeg';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function setFlag() {
    try { localStorage.setItem(FLAG, '1'); } catch { /* 스캔이 멱등이라 무시해도 안전 */ }
  }

  function showProgress(done, total) {
    document.getElementById('migrate-overlay').classList.remove('hidden');
    document.getElementById('migrate-text').textContent = `이미지 변환 중... ${done}/${total}`;
    document.getElementById('migrate-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
  }

  function hideProgress() {
    document.getElementById('migrate-overlay').classList.add('hidden');
  }

  async function doRun() {
    const targets = Storage.load().filter(isLegacy);
    if (targets.length === 0) {
      setFlag();
      return { converted: 0, failed: 0 };
    }

    const created = [];          // 이번에 IndexedDB에 만든 id (롤백용)
    const idMap = new Map();     // game.id -> 새 이미지 id
    let failed = 0;
    let snapshot = null;         // games 저장 직전 상태 (롤백용, 메모리 보관)

    try {
      showProgress(0, targets.length);

      // 1) 변환 + IndexedDB 저장 + 저장된 것 다시 읽어 검증. localStorage는 아직 건드리지 않음
      for (let i = 0; i < targets.length; i++) {
        const g = targets[i];
        try {
          const blob = dataUrlToBlob(g.coverImage);
          const id = ImageDB.newId();
          await ImageDB.saveImage(blob, id);
          created.push(id);
          const back = await ImageDB.getImage(id);
          if (!back || back.size !== blob.size) throw new Error('검증 실패');
          idMap.set(g.id, id);
        } catch {
          failed++;   // 이 게임은 원본 base64 그대로 유지
        }
        showProgress(i + 1, targets.length);
      }

      if (idMap.size === 0) throw new Error('변환된 이미지가 없습니다');

      // 2) 최신 games에 반영 (그 사이 바뀐 게임은 건드리지 않음)
      const applied = new Set();
      snapshot = Storage.load();
      const next = snapshot.map(g => {
        const id = idMap.get(g.id);
        if (!id || !isLegacy(g)) return g;
        applied.add(id);
        const { coverImage, ...rest } = g;
        return { ...rest, coverImageId: id };
      });

      if (!Storage.save(next)) throw new Error('games 저장 실패');

      // 3) 저장 결과 검증
      const check = Storage.load();
      const ok = [...idMap.entries()].every(([gid, id]) => {
        if (!applied.has(id)) return true;
        const g = check.find(x => x.id === gid);
        return g && g.coverImageId === id && !isLegacy(g);
      });
      if (!ok) throw new Error('저장 결과 검증 실패');

      // 반영되지 않은(그 사이 바뀐 게임의) 이미지는 정리
      for (const id of created) {
        if (!applied.has(id)) { try { await ImageDB.deleteImage(id); } catch { /* 무시 */ } }
      }

      if (failed === 0) setFlag();
      else Toast.show(`이미지 ${failed}개는 변환하지 못해 원본을 유지했습니다`, 'error');
      return { converted: applied.size, failed };
    } catch (err) {
      // 롤백: games를 원본으로 되돌리고, 새로 만든 이미지를 지운다
      if (snapshot) {
        try {
          const cur = localStorage.getItem('games');
          if (cur !== JSON.stringify(snapshot)) Storage.save(snapshot);
        } catch { /* 무시 */ }
      }
      for (const id of created) {
        try { await ImageDB.deleteImage(id); } catch { /* 무시 */ }
      }
      Toast.show('이미지 변환 실패 (원본 유지): ' + err.message, 'error');
      return { converted: 0, failed: targets.length };
    } finally {
      hideProgress();
    }
  }

  // 동시에 여러 번 호출돼도 한 번만 실행
  function run() {
    if (!running) running = doRun().finally(() => { running = null; });
    return running;
  }

  return { run, isLegacy, dataUrlToBlob };
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

  // 서버 데이터로 덮어쓰되, 서버 쪽에 커버가 없고 로컬에는 있는 게임은 로컬 커버를 유지
  // (아직 서버에 올라가지 않은 이미지가 동기화 한 번으로 사라지는 것을 방지)
  function mergeCovers(local, remote) {
    const byId = new Map(local.map(g => [g.id, g]));
    const adopt = [];   // 서버가 준 imageId로 저장해야 하는 로컬 base64 (덮어써서 사라지는 것 방지)
    const merged = remote.map(r => {
      const l0 = byId.get(r.id);
      if (r.coverImageId && l0 && Migration.isLegacy(l0)) {
        adopt.push({ id: r.coverImageId, dataUrl: l0.coverImage });
      }
      if (r.coverImageId || r.coverImage) return r;
      const l = byId.get(r.id);
      if (!l || !(l.coverImageId || l.coverImage)) return r;
      const m = { ...r };
      if (l.coverImageId) m.coverImageId = l.coverImageId;
      if (l.coverImage) m.coverImage = l.coverImage;
      return m;
    });
    return { merged, adopt };
  }

  // 텍스트 데이터 동기화. 성공 여부를 반환
  async function pull(manual) {
    const secret = getSecret();
    if (!secret) {
      SecretKeyModal.open();
      return false;
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
        return false;
      }

      if (!res.ok) throw new Error(`서버 오류 (${res.status})`);

      const data = await res.json();
      if (Array.isArray(data.games)) {
        const { merged, adopt } = mergeCovers(Storage.load(), data.games);
        // 덮어쓰기 전에 로컬 base64를 IndexedDB에 확보 (이미 있으면 건너뜀)
        for (const a of adopt) {
          try {
            if (!(await ImageDB.getImage(a.id))) {
              await ImageDB.saveImage(Migration.dataUrlToBlob(a.dataUrl), a.id);
            }
          } catch { /* 실패해도 텍스트 동기화는 계속 */ }
        }
        if (Storage.save(merged)) {
          // 서버 데이터로 교체되면서 더 이상 참조되지 않는 이미지는 정리 메뉴에서 제거
          Gallery.render();
          if (Router.getCurrent() === 'stats') Stats.render();
        }
      } else {
        // 서버에 데이터 없으면 로컬 데이터를 서버로 push
        const local = Storage.load();
        if (local.length > 0) syncUp(local);
      }

      setStatus('synced');
      if (manual) Toast.show('동기화 완료', 'success');
      return true;
    } catch (err) {
      if (!navigator.onLine) {
        setStatus('offline');
        if (manual) Toast.show('오프라인 상태입니다', 'error');
      } else {
        setStatus('failed');
        if (manual) Toast.show('동기화 실패: ' + err.message, 'error');
      }
      return false;
    }
  }

  // 텍스트 동기화 후, 변환 안 된 이미지가 있으면 변환하고 변환 결과를 서버에도 반영.
  // 이미지 변환 실패와 무관하게 텍스트 동기화는 항상 먼저 수행된다.
  async function syncDown(manual = false) {
    const ok = await pull(manual);
    const r = await Migration.run();
    if (r.converted > 0) {
      Gallery.render();
      if (Router.getCurrent() === 'stats') Stats.render();
      if (ok && getSecret()) syncUp(Storage.load());
    }
    return ok;
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
  let originalCoverId = null;  // 수정 시작 시점의 coverImageId (교체/제거 시 삭제 대상)
  let coverId = null;          // 현재 선택된 기존 이미지 id
  let coverLegacy = null;      // 아직 변환되지 않은 옛 base64 (있으면 그대로 유지)
  let coverBlob = null;        // 새로 고른 이미지 (등록/수정 버튼 누를 때 IndexedDB에 저장)
  let submitting = false;

  function open(game = null) {
    editingId = game ? game.id : null;
    originalCoverId = game ? (game.coverImageId || null) : null;
    coverId = originalCoverId;
    coverLegacy = game ? (game.coverImage || null) : null;
    coverBlob = null;

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
    renderCoverPreview();
    Router.showView('form');
  }

  function close() {
    ImageURL.release('form');
    coverBlob = null;
    Router.showView('gallery');
    Gallery.render();
  }

  function setStars(val) {
    document.querySelectorAll('#star-input .star').forEach(s => {
      s.classList.toggle('on', parseInt(s.dataset.val) <= val);
    });
    document.getElementById('field-rating').value = val;
  }

  // 최대 1000px, JPEG 품질 0.65로 압축해 Blob 반환
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(src);
        const MAX = 1000;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width >= height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';   // 투명 PNG가 JPEG 변환 때 검게 되지 않도록
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('이미지 압축 실패'));
        }, 'image/jpeg', 0.65);
      };
      img.onerror = () => {
        URL.revokeObjectURL(src);
        reject(new Error('이미지를 읽을 수 없습니다'));
      };
      img.src = src;
    });
  }

  function renderCoverPreview() {
    const preview = document.getElementById('cover-preview');
    ImageURL.release('form');
    const placeholder = '<span class="cover-placeholder">🎮</span>';

    const setImg = url => { preview.innerHTML = `<img src="${url}" alt="커버">`; };

    if (coverBlob) {
      setImg(ImageURL.fromBlob(coverBlob, 'form'));
    } else if (coverId) {
      preview.innerHTML = placeholder;
      ImageURL.urlFor(coverId, 'form').then(u => { if (u) setImg(u); }).catch(() => {});
    } else if (coverLegacy) {
      setImg(coverLegacy);
    } else {
      preview.innerHTML = placeholder;
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
      compressImage(file).then(blob => {
        coverBlob = blob;
        renderCoverPreview();
      }).catch(err => {
        Toast.show(err.message, 'error');
        renderCoverPreview();
      });
    });

    // Remove cover
    document.getElementById('btn-remove-cover').addEventListener('click', () => {
      coverBlob = null;
      coverId = null;
      coverLegacy = null;
      document.getElementById('field-cover').value = '';
      renderCoverPreview();
    });

    // Submit
    document.getElementById('game-form').addEventListener('submit', async e => {
      e.preventDefault();
      if (submitting) return;
      const title = document.getElementById('field-title').value.trim();
      if (!title) {
        alert('게임 제목을 입력해주세요.');
        return;
      }

      submitting = true;
      const submitBtn = document.getElementById('btn-submit-form');
      submitBtn.disabled = true;
      let newImageId = null;

      try {
        // 새 이미지 먼저 IndexedDB에 저장 (실패하면 텍스트도 저장하지 않고 중단)
        let finalId = coverId;
        let finalLegacy = coverLegacy;
        if (coverBlob) {
          try {
            newImageId = await ImageDB.saveImage(coverBlob);
          } catch (err) {
            Toast.show('이미지 저장 실패: ' + err.message, 'error');
            return;
          }
          finalId = newImageId;
          finalLegacy = null;
        }

        const endingEl = document.querySelector('input[name="ending"]:checked');
        const game = {
          id: editingId || uid(),
          createdAt: editingId ? undefined : new Date().toISOString(),
          title,
          coverImageId: finalId || null,
          coverImage: finalLegacy || undefined,
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

        if (!Storage.save(games)) {
          if (newImageId) await deleteImageIfUnused(newImageId, games.filter(g => g.id !== game.id));
          return;
        }
        newImageId = null; // 저장 성공 — 롤백 불필요

        // 교체/제거된 옛 이미지 삭제 (새 게임 목록 저장 이후에)
        if (originalCoverId && originalCoverId !== finalId) {
          await deleteImageIfUnused(originalCoverId, games);
        }

        Sync.syncUp(games);

        ImageURL.release('form');
        closeAllDropdowns();
        Router.showView('gallery');
        Gallery.render();
      } finally {
        submitting = false;
        submitBtn.disabled = false;
      }
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

    ImageURL.release('gallery');   // 이전 렌더의 objectURL 정리

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

    ImageURL.hydrate(container, 'gallery');
  }

  function makeCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.dataset.id = game.id;

    const coverHtml = ImageURL.imgHtml(game, 'game-card-cover', 'game-card-placeholder');

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

    ImageURL.release('detail');
    ImageURL.showCover(
      document.getElementById('detail-cover'),
      document.getElementById('detail-cover-placeholder'),
      game, 'detail'
    );

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
    ImageURL.release('detail');
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

    document.getElementById('detail-delete').addEventListener('click', async () => {
      if (!confirm('이 게임 기록을 삭제할까요?')) return;
      const all = Storage.load();
      const target = all.find(g => g.id === currentId);
      const games = all.filter(g => g.id !== currentId);
      if (!Storage.save(games)) return;
      if (target) await deleteImageIfUnused(target.coverImageId, games);
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
    ImageURL.release('list');
    list.innerHTML = '';

    games.forEach(game => {
      const li = document.createElement('li');
      li.className = 'platform-game-item';

      const coverHtml = ImageURL.imgHtml(game, 'plt-item-cover', 'plt-item-placeholder');

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

    ImageURL.hydrate(list, 'list');
    document.getElementById('platform-overlay').classList.remove('hidden');
  }

  function openPlatformModal(platform, yearGames) {
    const games = yearGames.filter(g => g.platform === platform);
    openGameListModal(`${platform} (${games.length}개)`, games);
  }

  function closePlatformModal() {
    document.getElementById('platform-overlay').classList.add('hidden');
    ImageURL.release('list');
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

    ImageURL.release('popup');
    ImageURL.showCover(
      document.getElementById('tl-popup-cover'),
      document.getElementById('tl-popup-placeholder'),
      game, 'popup'
    );

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
    ImageURL.release('popup');
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

// ===== IMAGE EXPORT =====
const ImageExport = (() => {
  function formatYM(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function starsText(rating) {
    const r = Math.max(0, Math.min(5, rating || 0));
    return '★'.repeat(r) + '☆'.repeat(5 - r);
  }

  // coverMap: 커버 imageId -> dataURL (html2canvas는 objectURL을 안정적으로 그리지 못함)
  function buildCaptureDom(year, games, coverMap) {
    const sorted = [...games].sort((a, b) => {
      const aD = a.startDate || a.endDate || '';
      const bD = b.startDate || b.endDate || '';
      return aD.localeCompare(bD);
    });

    const cleared = games.filter(g => g.ending === 'Yes').length;
    const today = new Date();
    const todayStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;

    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'position:fixed', 'left:-9999px', 'top:0',
      'width:1080px',
      "font-family:'Jua','Segoe UI',sans-serif",
      'background:#F0F9FF',
      'overflow:hidden',
    ].join(';');

    // ── 헤더 ──
    const header = document.createElement('div');
    header.style.cssText = [
      'background:linear-gradient(135deg,#1E40AF 0%,#2563EB 55%,#0EA5E9 100%)',
      'padding:52px 56px 44px',
      'text-align:center',
    ].join(';');
    header.innerHTML = `
      <div style="font-size:56px;font-weight:900;color:#fff;letter-spacing:-1px;margin-bottom:14px;line-height:1.1;">${year}년 게임 결산</div>
      <div style="font-size:28px;color:rgba(255,255,255,0.88);font-weight:600;">총 ${games.length}개 게임 &nbsp;·&nbsp; ${cleared}개 클리어</div>
    `;
    wrap.appendChild(header);

    // ── 게임 목록 ──
    const list = document.createElement('div');
    list.style.cssText = 'padding:28px 32px;display:flex;flex-direction:column;gap:14px;';

    sorted.forEach(game => {
      const card = document.createElement('div');
      card.style.cssText = [
        'background:#fff',
        'border-radius:16px',
        'padding:18px 22px',
        'display:flex',
        'gap:22px',
        'align-items:center',
        'box-shadow:0 2px 14px rgba(37,99,235,0.11)',
      ].join(';');

      // 커버
      const coverWrap = document.createElement('div');
      coverWrap.style.cssText = [
        'width:130px', 'height:130px',
        'border-radius:12px',
        'overflow:hidden',
        'background:#EFF6FF',
        'flex-shrink:0',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font-size:50px',
      ].join(';');

      const coverSrc = game.coverImageId ? coverMap.get(game.coverImageId) : game.coverImage;
      if (coverSrc) {
        const img = document.createElement('img');
        img.src = coverSrc;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        coverWrap.appendChild(img);
      } else {
        coverWrap.textContent = '🎮';
      }

      // 정보
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';

      let badgeColor, badgeText;
      if (game.ending === 'Yes')      { badgeColor = '#16A34A'; badgeText = '● 클리어'; }
      else if (game.ending === '진행중') { badgeColor = '#D97706'; badgeText = '● 진행중'; }
      else                             { badgeColor = '#9CA3AF'; badgeText = '●'; }

      const startYM = formatYM(game.startDate);
      const endYM   = formatYM(game.endDate);
      let period = '';
      if (startYM && endYM && startYM !== endYM) period = `${startYM} ~ ${endYM}`;
      else if (startYM && endYM)                  period = startYM;
      else if (startYM)                           period = `${startYM} ~`;
      else if (endYM)                             period = `~ ${endYM}`;

      info.innerHTML = `
        <div style="font-size:27px;font-weight:900;color:#1E3A8A;margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${game.title}</div>
        <div style="font-size:26px;color:#F59E0B;letter-spacing:3px;margin-bottom:10px;line-height:1;">${starsText(game.rating)}</div>
        <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
          <span style="color:${badgeColor};font-size:19px;font-weight:700;">${badgeText}</span>
          ${period ? `<span style="color:#64748B;font-size:17px;">${period}</span>` : ''}
        </div>
      `;

      card.appendChild(coverWrap);
      card.appendChild(info);
      list.appendChild(card);
    });

    wrap.appendChild(list);

    // ── 푸터 ──
    const footer = document.createElement('div');
    footer.style.cssText = [
      'text-align:center',
      'padding:22px 32px 30px',
      'color:#94A3B8',
      'font-size:18px',
      'border-top:1px solid #BFDBFE',
      'margin:0 32px 0',
    ].join(';');
    footer.textContent = `Generated by 게임 기록  ·  ${todayStr}`;
    wrap.appendChild(footer);

    // 하단 여백
    const spacer = document.createElement('div');
    spacer.style.height = '24px';
    wrap.appendChild(spacer);

    return wrap;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // 캡처 전에 모든 커버를 IndexedDB에서 읽어 dataURL로 변환. 없는 이미지는 🎮로 대체
  async function loadCoverMap(games) {
    const map = new Map();
    for (const g of games) {
      if (!g.coverImageId || map.has(g.coverImageId)) continue;
      try {
        const blob = await ImageDB.getImage(g.coverImageId);
        if (blob) map.set(g.coverImageId, await blobToDataUrl(blob));
      } catch { /* 이 게임만 플레이스홀더 */ }
    }
    return map;
  }

  async function exportImage(year, games) {
    if (games.length === 0) {
      Toast.show('저장할 게임이 없습니다', 'error');
      return;
    }

    const btn = document.getElementById('btn-save-image');
    btn.disabled = true;
    btn.textContent = '⏳ 이미지 생성 중...';

    let dom = null;

    try {
      const coverMap = await loadCoverMap(games);
      dom = buildCaptureDom(year, games, coverMap);
      document.body.appendChild(dom);

      // 이미지가 모두 디코딩된 뒤에 캡처
      await Promise.all([...dom.querySelectorAll('img')].map(i => i.decode().catch(() => {})));

      const canvas = await html2canvas(dom, {
        useCORS: true,
        scale: 1,
        backgroundColor: '#F0F9FF',
        logging: false,
        width: 1080,
      });

      const today = new Date();
      const ds = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
      const filename = `게임결산_${year}년_${ds}.png`;

      const link = document.createElement('a');
      link.download = filename;
      link.href = canvas.toDataURL('image/png');
      link.click();

      Toast.show('이미지가 저장되었습니다. Download 폴더에서 확인해주세요.', 'success');
    } catch (err) {
      Toast.show('이미지 저장 실패: ' + err.message, 'error');
    } finally {
      if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
      btn.disabled = false;
      btn.textContent = '📸 이미지 저장';
    }
  }

  function init() {
    document.getElementById('btn-save-image').addEventListener('click', () => {
      const year = parseInt(document.getElementById('stats-year').value);
      const games = Storage.load().filter(g => getYear(g) === year.toString());
      exportImage(year, games);
    });
  }

  return { init };
})();

// ===== STORAGE TOOLS (사용량 / 정리 / 이미지 백업·복원) =====
const StorageTools = (() => {
  const LS_LIMIT = 5 * 1024 * 1024;   // localStorage 한도(약 5MB)
  const BACKUP_TYPE = 'game-log-images';

  function fmt(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }

  // localStorage는 같은 도메인의 모든 앱이 공유하므로 전체 키를 합산
  function localStorageBytes() {
    let chars = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        chars += k.length + (localStorage.getItem(k) || '').length;
      }
    } catch { /* 무시 */ }
    return chars;
  }

  function gaugeHtml(label, used, limit, note) {
    const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    const over = limit && used > limit * 0.9 ? ' usage-danger' : '';
    return `
      <div class="usage-row">
        <div class="usage-head"><span>${label}</span><span>${fmt(used)}${limit ? ' / ' + fmt(limit) : ''}</span></div>
        <div class="usage-bar"><div class="usage-fill${over}" style="width:${pct}%"></div></div>
        ${note ? `<div class="usage-note">${note}</div>` : ''}
      </div>`;
  }

  async function openUsage() {
    const overlay = document.getElementById('usage-overlay');
    const body = document.getElementById('usage-body');
    body.innerHTML = '<p class="usage-note">계산 중...</p>';
    overlay.classList.remove('hidden');

    const gamesChars = (localStorage.getItem('games') || '').length;
    let html = gaugeHtml('localStorage (같은 도메인 앱 전체)', localStorageBytes(), LS_LIMIT,
      `이 앱의 게임 목록: ${fmt(gamesChars)}`);

    try {
      const st = await ImageDB.getStats();
      html += gaugeHtml('이 앱의 이미지 (IndexedDB)', st.bytes, 0, `커버 이미지 ${st.count}개`);
    } catch {
      html += '<p class="usage-note">IndexedDB 사용량을 읽지 못했습니다.</p>';
    }

    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        html += gaugeHtml('브라우저 전체 (이 도메인)', est.usage || 0, est.quota || 0,
          '다른 앱과 캐시를 포함한 참고용 수치입니다');
      }
    } catch { /* 무시 */ }

    body.innerHTML = html;
  }

  // games가 참조하지 않는 고아 이미지 제거
  async function cleanup() {
    try {
      const ids = await ImageDB.getAllImageIds();
      const used = new Set(Storage.load().map(g => g.coverImageId).filter(Boolean));
      const orphans = ids.filter(id => !used.has(id));
      if (orphans.length === 0) {
        Toast.show('정리할 이미지가 없습니다', 'info');
        return;
      }
      const st = await ImageDB.getStats();
      const bytes = orphans.reduce((sum, id) => sum + (st.sizes.get(id) || 0), 0);
      if (!confirm(`사용하지 않는 이미지 ${orphans.length}개(${fmt(bytes)})를 삭제할까요?\n\n※ 이미지를 복원한 직후라면 먼저 동기화를 한 뒤 정리하세요.`)) return;
      for (const id of orphans) await ImageDB.deleteImage(id);
      Toast.show(`${orphans.length}개 이미지를 정리했습니다 (${fmt(bytes)})`, 'success');
    } catch (err) {
      Toast.show('정리 실패: ' + err.message, 'error');
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // 현재 게임이 참조하는 이미지를 JSON 파일 하나로 백업
  async function backupImages() {
    const ids = [...new Set(Storage.load().map(g => g.coverImageId).filter(Boolean))];
    if (ids.length === 0) {
      Toast.show('백업할 이미지가 없습니다', 'info');
      return;
    }
    const btn = document.getElementById('backup-make');
    btn.disabled = true;
    try {
      const parts = [`{"type":"${BACKUP_TYPE}","version":1,"createdAt":${JSON.stringify(new Date().toISOString())},"images":[`];
      let count = 0;
      for (const id of ids) {
        const blob = await ImageDB.getImage(id);
        if (!blob) continue;   // 이 기기에 없는 이미지는 건너뜀
        parts.push((count ? ',' : '') + JSON.stringify({ id, data: await blobToDataUrl(blob) }));
        count++;
      }
      parts.push(']}');
      if (count === 0) {
        Toast.show('이 기기에는 백업할 이미지가 없습니다', 'error');
        return;
      }
      const file = new Blob(parts, { type: 'application/json' });
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = `game-log-images-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      Toast.show(`이미지 ${count}개를 백업했습니다`, 'success');
    } catch (err) {
      Toast.show('백업 실패: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // 백업 파일에서 복원 (이미 있는 이미지는 건너뜀)
  async function restoreImages(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.type !== BACKUP_TYPE || !Array.isArray(data.images)) {
        throw new Error('이미지 백업 파일이 아닙니다');
      }
      const existing = new Set(await ImageDB.getAllImageIds());
      let restored = 0, skipped = 0, failed = 0;
      for (const img of data.images) {
        if (!img || !img.id || typeof img.data !== 'string' || !img.data.startsWith('data:image')) { failed++; continue; }
        if (existing.has(img.id)) { skipped++; continue; }
        try {
          await ImageDB.saveImage(Migration.dataUrlToBlob(img.data), img.id);
          restored++;
        } catch { failed++; }
      }
      Gallery.render();
      if (Router.getCurrent() === 'stats') Stats.render();
      Toast.show(`복원 ${restored}개 · 건너뜀 ${skipped}개${failed ? ` · 실패 ${failed}개` : ''}`, failed ? 'error' : 'success');
    } catch (err) {
      Toast.show('복원 실패: ' + err.message, 'error');
    }
  }

  function init() {
    const usage = document.getElementById('usage-overlay');
    document.getElementById('usage-close').addEventListener('click', () => usage.classList.add('hidden'));
    usage.addEventListener('click', e => { if (e.target === usage) usage.classList.add('hidden'); });

    const backup = document.getElementById('backup-overlay');
    document.getElementById('backup-close').addEventListener('click', () => backup.classList.add('hidden'));
    backup.addEventListener('click', e => { if (e.target === backup) backup.classList.add('hidden'); });

    document.getElementById('backup-make').addEventListener('click', backupImages);
    document.getElementById('backup-restore').addEventListener('click', () => {
      document.getElementById('images-restore-input').click();
    });
    document.getElementById('images-restore-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      backup.classList.add('hidden');
      await restoreImages(file);
    });
  }

  function openBackup() {
    document.getElementById('backup-overlay').classList.remove('hidden');
  }

  return { init, openUsage, openBackup, cleanup };
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

    document.getElementById('menu-usage').addEventListener('click', () => {
      closeAllDropdowns();
      StorageTools.openUsage();
    });

    document.getElementById('menu-cleanup').addEventListener('click', () => {
      closeAllDropdowns();
      StorageTools.cleanup();
    });

    document.getElementById('menu-images').addEventListener('click', () => {
      closeAllDropdowns();
      StorageTools.openBackup();
    });

    document.getElementById('import-file-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const count = await Storage.importJSON(file);
        alert(`${count}개의 게임 기록을 가져왔습니다.`);
        await Migration.run();   // 예전 JSON 백업에 base64 커버가 있으면 변환
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
  ImageExport.init();
  StorageTools.init();

  // 브라우저가 저장소를 임의로 비우지 않도록 요청 (실패해도 무방)
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Initial render
  Router.showView('gallery');
  Gallery.render();

  // Auto-sync on startup
  // (syncDown은 텍스트 동기화 후 이미지 마이그레이션까지 처리)
  if (Sync.getSecret()) {
    Sync.syncDown();
  } else {
    SecretKeyModal.open();
    Migration.run().then(r => { if (r.converted > 0) Gallery.render(); });
  }

  // PWA
  generateIcons();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
});
