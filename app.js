/* 오박사의 메모장 — 오프라인 우선 PWA
   저장: localStorage(메모·설정) + IndexedDB(사진)
   동기화: GitHub 비공개 저장소 (notes.json, images/*.json)
   보안: 잠근 메모는 AES-256-GCM (PBKDF2 마스터 비밀번호) */
'use strict';
(() => {

/* ───────── 기본 도구 ───────── */
const $ = s => document.querySelector(s);
const K = {
  notes: 'obm.notes', settings: 'obm.settings', vault: 'obm.vault', meta: 'obm.meta',
  uploaded: 'obm.uploaded', imgdel: 'obm.imgdel', notified: 'obm.notified', filter: 'obm.filter'
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('이 기기의 저장 공간이 가득 찼습니다. 휴지통을 비우거나 사진을 줄여주세요.'); } }
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstLine = t => (t || '').split('\n').find(l => l.trim()) || '';
const DAY = 86400000;

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  note: '<path d="M6 3.5h8.5l4 4V20a.5.5 0 0 1-.5.5H6.5A.5.5 0 0 1 6 20z"/><path d="M14.5 3.5V8h4M9 12.5h6M9 16h4"/>',
  pin: '<path d="M9 3.5h6l-1 5.5 3 3V14H7v-2l3-3z"/><path d="M12 14v6.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 7.6-1.8"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="M20.5 16l-5-5-8.5 8.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17.5 10h.01M7.5 14h9"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  restore: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5h4"/>',
  all: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.5H14M5.5 21v-4.5H10"/>'
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

const KINDS = {
  todo:  { label: '할일',   icon: 'check' },
  idea:  { label: '아이디어', icon: 'bulb' },
  event: { label: '일정',   icon: 'cal' },
  memo:  { label: '메모',   icon: 'note' }
};

/* ───────── 상태 ───────── */
let notes = LS.get(K.notes, {});
let settings = Object.assign({ theme: 'chalk', kind: 'todo', remindMin: 10, autoLockMin: 5, gh: null }, LS.get(K.settings, {}));
let vault = LS.get(K.vault, null);
let meta = Object.assign({ dirty: false, lastSync: 0, seeded: false }, LS.get(K.meta, {}));
let uploaded = new Set(LS.get(K.uploaded, []));
let imgDel = new Set(LS.get(K.imgdel, []));
let notified = LS.get(K.notified, {});

let filter = LS.get(K.filter, 'all');
let tagFilter = null, query = '', editing = null, selected = null;
let editSeq = 0;
let key = null;              // 잠금 해제된 암호 키 (메모리에만)
const plain = new Map();     // 잠근 메모의 해독된 글 (메모리에만)
const imgCache = new Map();  // 사진 id → dataURL (표시용)
const imgLoading = new Set();
let undoStack = [];
let qKind = KINDS[settings.kind] ? settings.kind : 'todo';
let qImages = [];
let qLocked = false;

const saveSettings = () => LS.set(K.settings, settings);
const saveMeta = () => LS.set(K.meta, meta);
function saveNotes(changed = true) {
  LS.set(K.notes, notes);
  if (changed) { editSeq++; meta.dirty = true; saveMeta(); scheduleSync(); }
}

/* ───────── IndexedDB (사진) ───────── */
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('obm', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('images', mode);
      const req = fn(t.objectStore('images'));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    get: id => run('readonly', s => s.get(id)),
    put: v => run('readwrite', s => s.put(v)),
    del: id => run('readwrite', s => s.delete(id)),
    all: () => run('readonly', s => s.getAll())
  };
})();

/* ───────── 암호화 ───────── */
const te = new TextEncoder(), td = new TextDecoder();
function b64(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
async function deriveKey(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(salt), iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function enc(k, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(str));
  return { iv: b64(iv), ct: b64(ct) };
}
async function dec(k, o) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, k, unb64(o.ct));
  return td.decode(pt);
}
async function newVault(pw) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const iter = 310000;
  const k = await deriveKey(pw, salt, iter);
  return { k, v: { salt, iter, check: await enc(k, 'obaksa-ok'), changedAt: Date.now() } };
}
async function tryKey(pw, v = vault) {
  const k = await deriveKey(pw, v.salt, v.iter);
  try { return (await dec(k, v.check)) === 'obaksa-ok' ? k : null; } catch { return null; }
}
async function decryptAll() {
  if (!key) return;
  for (const n of Object.values(notes)) {
    if (n.locked && n.enc && !plain.has(n.id)) {
      try { plain.set(n.id, await dec(key, n.enc)); } catch { /* 다른 비밀번호로 잠긴 메모 */ }
    }
  }
}
let lockTimer = null;
function touchLock() {
  clearTimeout(lockTimer);
  if (key) lockTimer = setTimeout(() => { lockNow(); toast('잠깐 쉬는 동안 비밀 메모를 다시 잠갔습니다'); }, (settings.autoLockMin || 5) * 60000);
}
function lockedImageIds() {
  const s = new Set();
  for (const n of Object.values(notes)) if (n.locked) (n.images || []).forEach(i => s.add(i));
  return s;
}
function lockNow() {
  key = null; plain.clear(); clearTimeout(lockTimer);
  const li = lockedImageIds();
  for (const id of li) imgCache.delete(id);
  if (editing && notes[editing] && notes[editing].locked) editing = null;
  render();
}
/* 키가 필요할 때: 없으면 비밀번호를 만들거나 물어봄 */
async function ensureKey(purpose = '비밀 메모를 열려면') {
  if (key) { touchLock(); return true; }
  return vault ? askUnlock(purpose) : askSetup();
}

/* ───────── 메모 도우미 ───────── */
const textOf = n => n.locked ? (plain.has(n.id) ? plain.get(n.id) : null) : (n.text || '');
function tagsOf(t) {
  if (!t) return [];
  const out = new Set();
  for (const m of t.matchAll(/(?:^|\s)#([^\s#.,!?()\[\]{}"'<>]+)/g)) out.add(m[1]);
  return [...out];
}
function richText(t) {
  return esc(t)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)#([^\s#.,!?()\[\]{}"'<>&]+)/g, '$1<span class="tag">#$2</span>')
    .replace(/\n/g, '<br>');
}
const live = () => Object.values(notes).filter(n => !n.purged);

function parseDue(d) {
  if (!d) return null;
  const [ds, ts] = d.split('T');
  const [y, m, dd] = ds.split('-').map(Number);
  if (!y || !m || !dd) return null;
  if (ts) { const [hh, mm] = ts.split(':').map(Number); return { date: new Date(y, m - 1, dd, hh || 0, mm || 0), allDay: false }; }
  return { date: new Date(y, m - 1, dd, 23, 59), allDay: true };
}
function dueLabel(d) {
  const p = parseDue(d); if (!p) return '';
  const now = new Date();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d1 = new Date(p.date.getFullYear(), p.date.getMonth(), p.date.getDate());
  const diff = Math.round((d1 - d0) / DAY);
  const wd = '일월화수목금토'[p.date.getDay()];
  const day = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : diff === -1 ? '어제'
    : `${p.date.getMonth() + 1}/${p.date.getDate()}(${wd})`;
  const time = p.allDay ? '' : ` ${pad(p.date.getHours())}:${pad(p.date.getMinutes())}`;
  const extra = diff > 2 ? ` · D-${diff}` : diff < -1 ? ` · ${-diff}일 지남` : '';
  return day + time + extra;
}
function dueState(n) {
  const p = parseDue(n.due); if (!p) return '';
  if (n.done) return 'past';
  const now = Date.now();
  if (p.date.getTime() < now) return 'over';
  const today = new Date(); today.setHours(23, 59, 59, 999);
  return p.date <= today || p.date.getTime() - now < DAY ? 'soon' : '';
}

/* ───────── 메모 조작 ───────── */
function touch(n) { n.updatedAt = Date.now(); }
function patch(id, p) {
  const n = notes[id]; if (!n) return;
  Object.assign(n, p); touch(n); saveNotes(); render();
}
const pendingEnc = new Map();
function setText(id, t) {
  const n = notes[id]; if (!n) return;
  if (n.locked) {
    plain.set(id, t); touch(n);
    clearTimeout(pendingEnc.get(id));
    pendingEnc.set(id, setTimeout(() => flushEnc(id), 350));
  } else {
    n.text = t; touch(n); saveNotes();
  }
}
async function flushEnc(id) {
  clearTimeout(pendingEnc.get(id)); pendingEnc.delete(id);
  const n = notes[id]; if (!n || !n.locked || !key || !plain.has(id)) return;
  n.enc = await enc(key, plain.get(id)); touch(n); saveNotes();
}
function trash(id, silent) {
  const n = notes[id]; if (!n) return;
  if (editing === id) editing = null;
  Object.assign(n, { deleted: true, deletedAt: Date.now() }); touch(n); saveNotes();
  undoStack.push(id); if (undoStack.length > 20) undoStack.shift();
  if (!silent) toast('휴지통으로 옮겼습니다', '되돌리기', undoDelete);
  render();
}
function undoDelete() {
  const id = undoStack.pop(); const n = id && notes[id];
  if (!n || !n.deleted) return;
  Object.assign(n, { deleted: false, deletedAt: null }); touch(n); saveNotes(); selected = id; render();
  toast('되살렸습니다');
}
async function purge(id) {
  const n = notes[id]; if (!n) return;
  for (const iid of n.images || []) { imgDel.add(iid); imgCache.delete(iid); uploaded.delete(iid); try { await idb.del(iid); } catch {} }
  LS.set(K.imgdel, [...imgDel]); LS.set(K.uploaded, [...uploaded]);
  notes[id] = { id, purged: true, updatedAt: Date.now() };
  plain.delete(id); if (editing === id) editing = null;
  saveNotes(); render();
}
function cleanup() {
  const now = Date.now();
  for (const n of Object.values(notes)) {
    if (n.deleted && !n.purged && n.deletedAt && now - n.deletedAt > 30 * DAY) purge(n.id);
    if (n.purged && now - n.updatedAt > 120 * DAY) delete notes[n.id];
  }
  LS.set(K.notes, notes);
}
function newNoteObj(p) {
  const now = Date.now();
  return Object.assign({ id: uid(), kind: 'todo', text: '', done: false, due: null, pinned: false, deleted: false,
    deletedAt: null, images: [], locked: false, enc: null, createdAt: now, updatedAt: now }, p);
}

/* 비밀 메모로 바꾸기 / 풀기 */
async function lockNote(id) {
  if (!await ensureKey('메모를 잠그려면')) return;
  const n = notes[id]; if (!n || n.locked) return;
  const t = n.text || '';
  n.enc = await enc(key, t); n.text = ''; n.locked = true; plain.set(id, t);
  await encryptImages(n.images || []);
  touch(n); saveNotes(); render();
  toast('잠갔습니다. 비밀번호 없이는 아무도 볼 수 없습니다');
}
async function unlockNote(id) {
  if (!await ensureKey('잠금을 풀려면')) return;
  const n = notes[id]; if (!n || !n.locked) return;
  if (pendingEnc.has(id)) await flushEnc(id);
  const t = plain.has(id) ? plain.get(id) : await dec(key, n.enc);
  n.text = t; n.locked = false; n.enc = null; plain.delete(id);
  await decryptImages(n.images || []);
  touch(n); saveNotes(); render();
  toast('잠금을 풀었습니다');
}
async function encryptImages(ids) {
  for (const iid of ids) {
    const rec = await idb.get(iid);
    if (rec && rec.data) {
      await idb.put({ id: iid, mime: rec.mime, enc: await enc(key, rec.data), createdAt: rec.createdAt });
      uploaded.delete(iid);
    }
  }
  LS.set(K.uploaded, [...uploaded]);
}
async function decryptImages(ids) {
  for (const iid of ids) {
    const rec = await idb.get(iid);
    if (rec && rec.enc) {
      const data = await dec(key, rec.enc);
      await idb.put({ id: iid, mime: rec.mime, data, createdAt: rec.createdAt });
      imgCache.set(iid, data); uploaded.delete(iid);
    }
  }
  LS.set(K.uploaded, [...uploaded]);
}

/* ───────── 사진 ───────── */
function resizeImage(file, max = 1600, q = 0.82) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      let w = im.naturalWidth, h = im.naturalHeight;
      const s = Math.min(1, max / Math.max(w, h));
      w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/webp', q);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', q);
      res(out);
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('사진을 읽을 수 없습니다')); };
    im.src = url;
  });
}
async function ingest(file, lockIt) {
  const data = await resizeImage(file);
  const id = 'i' + uid();
  const mime = data.slice(5, data.indexOf(';'));
  const rec = { id, mime, createdAt: Date.now() };
  if (lockIt && key) rec.enc = await enc(key, data); else rec.data = data;
  await idb.put(rec);
  imgCache.set(id, data);
  return id;
}
async function addFiles(files, target) {
  const imgs = [...files].filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return;
  const n = target && notes[target];
  if (n && n.locked && !await ensureKey('비밀 메모에 사진을 넣으려면')) return;
  let added = 0;
  for (const f of imgs) {
    try {
      const id = await ingest(f, n ? n.locked : false);
      if (n) { n.images = [...(n.images || []), id]; touch(n); } else qImages.push(id);
      added++;
    } catch (e) { toast(e.message); }
  }
  if (n) saveNotes();
  render(); renderQuickThumbs();
  if (added) toast(`사진 ${added}장을 붙였습니다`);
}
async function loadImg(id) {
  if (imgCache.has(id) || imgLoading.has(id)) return;
  imgLoading.add(id);
  let changed = false;
  try {
    let rec = await idb.get(id);
    if (!rec && gh() && navigator.onLine) {
      rec = await ghGetImage(id);
      if (rec) { await idb.put(rec); uploaded.add(id); LS.set(K.uploaded, [...uploaded]); }
    }
    if (!rec) { imgCache.set(id, null); changed = true; }
    else if (rec.data) { imgCache.set(id, rec.data); changed = true; }
    else if (rec.enc && key) { imgCache.set(id, await dec(key, rec.enc)); changed = true; }
  } catch { /* 다음에 다시 시도 */ }
  finally { imgLoading.delete(id); }
  if (changed) render();
}
async function removeImage(noteId, iid) {
  const n = notes[noteId]; if (!n) return;
  n.images = (n.images || []).filter(x => x !== iid); touch(n);
  imgDel.add(iid); LS.set(K.imgdel, [...imgDel]); uploaded.delete(iid); LS.set(K.uploaded, [...uploaded]);
  imgCache.delete(iid); try { await idb.del(iid); } catch {}
  saveNotes(); render();
}
function thumbsHTML(ids, removable) {
  return (ids || []).map(id => {
    const src = imgCache.get(id);
    if (src === undefined) loadImg(id);
    const x = removable ? `<button type="button" class="thumb-x" data-act="rmimg" data-img="${id}" aria-label="사진 빼기">${ic('x')}</button>` : '';
    const inner = src ? `<img class="thumb" src="${src}" alt="첨부 사진" data-act="view" data-img="${id}" loading="lazy">`
      : `<span class="thumb ph" title="${src === null ? '사진을 찾을 수 없습니다' : '불러오는 중'}">${ic('image')}</span>`;
    return `<span class="thumb-w">${inner}${x}</span>`;
  }).join('');
}

/* ───────── 화면 그리기 ───────── */
const listEl = $('#list');
function visibleNotes() {
  const q = query.trim().toLowerCase();
  const arr = live().filter(n => filter === 'trash' ? n.deleted : !n.deleted)
    .filter(n => filter === 'all' || filter === 'trash' || (filter === 'locked' ? n.locked : n.kind === filter))
    .filter(n => !tagFilter || tagsOf(textOf(n)).includes(tagFilter))
    .filter(n => !q || (textOf(n) || '').toLowerCase().includes(q));
  const dueT = n => { const p = parseDue(n.due); return p ? p.date.getTime() : Infinity; };
  return arr.sort((a, b) => {
    if (filter === 'trash') return (b.deletedAt || 0) - (a.deletedAt || 0);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (filter === 'event') return dueT(a) - dueT(b);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function cardHTML(n) {
  const t = textOf(n);
  const k = KINDS[n.kind] || KINDS.memo;
  const sealed = n.locked && t === null;
  const trashView = filter === 'trash';
  const checkable = n.kind === 'todo' || n.kind === 'event';
  const cls = ['card', 'k-' + (KINDS[n.kind] ? n.kind : 'memo')];
  if (n.pinned && !trashView) cls.push('pinned');
  if (n.done) cls.push('done');
  if (selected === n.id) cls.push('sel');
  const lead = checkable && !trashView && !sealed
    ? `<button type="button" class="lead" data-act="done" aria-label="${n.done ? '완료 취소' : '완료'}" title="완료 (Space)"><span class="box">${ic('check')}</span></button>`
    : `<span class="lead" title="${k.label}">${ic(sealed ? 'lock' : k.icon)}</span>`;
  const body = sealed
    ? `<div class="txt secret">비밀 메모 · 눌러서 열기</div>`
    : `<div class="txt">${richText(t || ' ')}</div>`;
  const m = [];
  if (n.due) m.push(`<span class="due ${dueState(n)}">${ic('cal')}${esc(dueLabel(n.due))}</span>`);
  if (n.locked) m.push(`<span class="lk">${ic('lock')}비밀</span>`);
  if (trashView) m.push(`<span>휴지통 · ${Math.max(0, 30 - Math.floor((Date.now() - (n.deletedAt || 0)) / DAY))}일 뒤 사라짐</span>`);
  const thumbs = !sealed && (n.images || []).length ? `<div class="thumbs">${thumbsHTML(n.images)}</div>` : '';
  const acts = trashView
    ? `<div class="acts always"><button type="button" class="btn sm" data-act="restore">${ic('restore')}복구</button><button type="button" class="btn sm danger" data-act="purge">완전 삭제</button></div>`
    : `<div class="acts">
        <button type="button" class="ibtn ${n.pinned ? 'on' : ''}" data-act="pin" title="${n.pinned ? '고정 풀기' : '상단 고정'}" aria-label="고정">${ic('pin')}</button>
        <button type="button" class="ibtn" data-act="${n.locked ? 'unlocknote' : 'locknote'}" title="${n.locked ? '잠금 풀기' : '비밀 메모로 잠그기'}" aria-label="잠금">${ic(n.locked ? 'unlock' : 'lock')}</button>
        <button type="button" class="ibtn" data-act="trash" title="휴지통으로 (Delete)" aria-label="삭제">${ic('trash')}</button>
      </div>`;
  return `<article class="${cls.join(' ')}" data-id="${n.id}">${lead}<div class="body" data-act="${trashView ? '' : 'edit'}">${body}${m.length ? `<div class="meta">${m.join('')}</div>` : ''}${thumbs}</div>${acts}</article>`;
}

function editorCtrlHTML(n) {
  const kinds = Object.entries(KINDS).map(([k, v]) =>
    `<button type="button" class="kind k-${k}" role="radio" aria-checked="${n.kind === k}" data-act="kind" data-kind="${k}">${ic(v.icon)}${v.label}</button>`).join('');
  const [ds, ts] = (n.due || '').split('T');
  const dueRow = n.kind === 'event' ? `<div class="ed-row">
      <label class="field-l">날짜 <input type="date" class="field" data-act="date" value="${esc(ds || '')}"></label>
      <label class="field-l">시간 <input type="time" class="field" data-act="time" value="${esc(ts || '')}"></label>
      ${n.due ? `<button type="button" class="btn sm ghost" data-act="cal">${ic('bell')}캘린더에 추가</button>` : '<span class="hint">날짜를 고르면 다가오는 일정에 나옵니다</span>'}
    </div>` : '';
  const thumbs = (n.images || []).length ? `<div class="thumbs">${thumbsHTML(n.images, true)}</div>` : '';
  return `<div class="ed-row">${kinds}</div>${dueRow}${thumbs}
    <div class="ed-row">
      <button type="button" class="ibtn" data-act="addimg" title="사진 첨부" aria-label="사진 첨부">${ic('image')}</button>
      <button type="button" class="ibtn ${n.pinned ? 'on' : ''}" data-act="pin" title="${n.pinned ? '고정 풀기' : '상단 고정'}" aria-pressed="${!!n.pinned}" aria-label="고정">${ic('pin')}</button>
      <button type="button" class="ibtn" data-act="${n.locked ? 'unlocknote' : 'locknote'}" title="${n.locked ? '잠금 풀기' : '비밀 메모로 잠그기'}" aria-pressed="${!!n.locked}" aria-label="잠금">${ic(n.locked ? 'lock' : 'unlock')}</button>
      <button type="button" class="ibtn" data-act="trash" title="휴지통으로" aria-label="삭제">${ic('trash')}</button>
      <span class="grow"></span>
      <span class="ed-tip">Esc 닫기 · 자동 저장</span>
      <button type="button" class="btn primary sm" data-act="close">완료</button>
    </div>`;
}
function buildEditor(n) {
  const el = document.createElement('article');
  el.className = 'card editing k-' + n.kind;
  el.dataset.id = n.id;
  el.innerHTML = `<textarea class="ed" rows="2" aria-label="메모 내용"></textarea><div class="ed-ctrl"></div>`;
  el.querySelector('textarea').value = textOf(n) || '';
  updateEditor(el, n);
  return el;
}
function updateEditor(el, n) {
  el.className = 'card editing k-' + n.kind + (n.pinned ? ' pinned' : '');
  const ctrl = el.querySelector('.ed-ctrl');
  if (ctrl.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const html = editorCtrlHTML(n);
  if (ctrl._html !== html) { ctrl.innerHTML = html; ctrl._html = html; }
}
function fromHTML(h) { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; }

function emptyHTML() {
  if (filter === 'trash') return `<div class="empty"><b>휴지통이 비어 있어요</b>지운 메모는 여기서 30일 동안 기다립니다.</div>`;
  if (query || tagFilter) return `<div class="empty"><b>찾는 메모가 없어요</b>다른 말로 찾아보거나 태그를 풀어보세요.</div>`;
  if (filter === 'locked') return `<div class="empty"><b>비밀 메모가 없어요</b>입력칸 옆 자물쇠를 켜고 적으면 암호화되어 저장됩니다.</div>`;
  return `<div class="empty"><b>칠판이 깨끗해요</b>위 칸에 한 줄 적고 Enter 를 누르세요.</div>`;
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; renderNow(); });
}
function renderNow() {
  const vs = visibleNotes();
  if (editing && !vs.some(n => n.id === editing)) editing = null;
  if (selected && !vs.some(n => n.id === selected)) selected = null;

  // 메모 목록: 편집 중 카드는 그대로 두고 나머지만 다시 그림 (한글 입력이 끊기지 않게)
  const old = new Map();
  for (const c of listEl.children) if (c.dataset.id) old.set(c.dataset.id, c);
  const nodes = vs.map(n => {
    let node = old.get(n.id);
    if (n.id === editing) {
      if (node && node.classList.contains('editing')) updateEditor(node, n); else node = buildEditor(n);
    } else {
      const html = cardHTML(n);
      if (!node || node.classList.contains('editing') || node._html !== html) { node = fromHTML(html); node._html = html; }
    }
    return node;
  });
  if (!nodes.length) nodes.push(fromHTML(emptyHTML()));
  const keep = new Set(nodes);
  for (const c of [...listEl.children]) if (!keep.has(c)) c.remove();
  let cur = listEl.firstChild;
  for (const node of nodes) {
    if (node === cur) cur = cur.nextSibling;
    else listEl.insertBefore(node, cur);
  }
  const ed = editing && listEl.querySelector('.card.editing textarea');
  if (ed) autoGrow(ed);

  renderFilters(); renderTags(); renderUpcoming(); renderStats();
}

function renderFilters() {
  const ns = live().filter(n => !n.deleted);
  const count = f => f === 'all' ? ns.length : f === 'locked' ? ns.filter(n => n.locked).length
    : f === 'trash' ? live().filter(n => n.deleted).length : ns.filter(n => n.kind === f).length;
  const items = [['all', '전체', 'all'], ['todo', '할일', 'check'], ['idea', '아이디어', 'bulb'], ['event', '일정', 'cal'],
    ['memo', '메모', 'note'], ['locked', '비밀', 'lock'], ['trash', '휴지통', 'trash']];
  const html = items.map(([f, label, icon]) => {
    const n = count(f);
    if ((f === 'locked' || f === 'trash') && !n && filter !== f) return '';
    return `<button type="button" class="fbtn" data-f="${f}" aria-pressed="${filter === f}">${ic(icon)}${label}<span class="n">${n}</span></button>`;
  }).join('');
  const el = $('#filters'); if (el._html !== html) { el.innerHTML = html; el._html = html; }
}
function renderTags() {
  const cnt = {};
  for (const n of live()) if (!n.deleted) for (const t of tagsOf(textOf(n))) cnt[t] = (cnt[t] || 0) + 1;
  if (tagFilter && !cnt[tagFilter]) cnt[tagFilter] = 0;
  const html = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a.localeCompare(b)).slice(0, 30)
    .map(t => `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="${tagFilter === t}">#${esc(t)} ${cnt[t]}</button>`).join('');
  const el = $('#tagbar'); if (el._html !== html) { el.innerHTML = html; el._html = html; }
}
function upcomingList() {
  const now = Date.now();
  return live().filter(n => !n.deleted && !n.done && n.due)
    .map(n => ({ n, t: parseDue(n.due) })).filter(x => x.t && x.t.date.getTime() - now < 14 * DAY)
    .sort((a, b) => a.t.date - b.t.date).slice(0, 8).map(x => x.n);
}
function renderUpcoming() {
  const ups = upcomingList();
  const rows = ups.map(n => {
    const t = textOf(n);
    return `<button type="button" class="up-row ${dueState(n)}" data-open="${n.id}"><span class="when">${esc(dueLabel(n.due))}</span><span class="what">${t === null ? '비밀 일정' : esc(firstLine(t))}</span></button>`;
  }).join('');
  const html = rows || `<div class="up-empty">앞으로 2주 안의 일정이 없어요.<br>위에서 <b>일정</b>을 골라 날짜와 함께 적어보세요.</div>`;
  for (const id of ['#upcoming', '#upMobile']) { const el = $(id); if (el._html !== html) { el.innerHTML = html; el._html = html; } }
  $('#upMobileWrap').hidden = !ups.length || filter === 'trash';
}
function renderStats() {
  const ns = live().filter(n => !n.deleted);
  const todo = ns.filter(n => n.kind === 'todo' && !n.done).length;
  const today = ns.filter(n => n.due && !n.done && dueState(n) !== '' && dueState(n) !== 'past').length;
  const html = `<div><b>${todo}</b><span>남은 할일</span></div><div><b>${today}</b><span>임박·지난 일정</span></div><div><b>${ns.length}</b><span>전체 메모</span></div>`;
  const el = $('#stats'); if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 420) + 'px'; }

/* ───────── 편집 ───────── */
async function openEditor(id) {
  const n = notes[id]; if (!n || n.deleted) return;
  if (n.locked && !plain.has(id)) {
    if (!await ensureKey()) return;
    await decryptAll();
    if (!plain.has(id)) { toast('이 메모는 다른 비밀번호로 잠겨 있습니다'); return; }
  }
  if (editing && editing !== id) closeEditor(true);
  editing = id; selected = id;
  renderNow();
  const ta = listEl.querySelector('.card.editing textarea');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); autoGrow(ta); ta.closest('.card').scrollIntoView({ block: 'nearest' }); }
}
function closeEditor(quiet) {
  if (!editing) return;
  const id = editing; editing = null;
  if (pendingEnc.has(id)) flushEnc(id);
  const n = notes[id];
  if (n && !n.deleted && !(textOf(n) || '').trim() && !(n.images || []).length) purge(id);
  if (!quiet) render();
}

/* ───────── 빠른 입력 ───────── */
function renderQuickKinds() {
  $('#qKinds').innerHTML = Object.entries(KINDS).map(([k, v]) =>
    `<button type="button" class="kind k-${k}" role="radio" aria-checked="${qKind === k}" data-kind="${k}">${ic(v.icon)}${v.label}</button>`).join('');
  $('#qExtra').hidden = qKind !== 'event';
  const ph = { todo: '할 일을 적고 Enter', idea: '떠오른 생각을 적고 Enter', event: '일정 내용을 적고 날짜를 고르세요', memo: '무엇이든 적고 Enter' };
  $('#qText').placeholder = qLocked ? '비밀 메모 · 암호화되어 저장됩니다' : ph[qKind];
}
function renderQuickThumbs() {
  const el = $('#qThumbs');
  el.innerHTML = qImages.map(id => `<span class="thumb-w"><img class="thumb" src="${imgCache.get(id) || ''}" alt="첨부할 사진"><button type="button" class="thumb-x" data-qrm="${id}" aria-label="사진 빼기">${ic('x')}</button></span>`).join('');
}
function focusQuick() { if (editing) closeEditor(); const t = $('#qText'); t.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
async function quickAdd() {
  const ta = $('#qText');
  const text = ta.value.trim();
  if (!text && !qImages.length) { ta.focus(); return; }
  let due = null;
  if (qKind === 'event') {
    const d = $('#qDate').value;
    if (!d) { toast('일정 날짜를 골라주세요'); $('#qDate').focus(); return; }
    const t = $('#qTime').value;
    due = t ? `${d}T${t}` : d;
  }
  if (qLocked && !await ensureKey('비밀 메모를 적으려면')) return;
  const n = newNoteObj({ kind: qKind, due, images: [...qImages] });
  if (qLocked) {
    n.locked = true; n.enc = await enc(key, text); plain.set(n.id, text);
    await encryptImages(n.images);
  } else n.text = text;
  notes[n.id] = n;
  qImages = []; ta.value = ''; autoGrow(ta); $('#qTime').value = '';
  renderQuickThumbs();
  if (filter !== 'all' && filter !== n.kind) { filter = 'all'; LS.set(K.filter, filter); }
  selected = n.id;
  saveNotes(); render();
  toast(`${KINDS[n.kind].label}${n.locked ? '(비밀)' : ''}을 적었습니다`);
  if (due && !parseDue(due).allDay) maybeAskNotify();
}

/* ───────── 일정 알림·캘린더 ───────── */
function maybeAskNotify() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  Notification.requestPermission().then(p => { if (p === 'granted') toast('일정 시간이 되면 알려드릴게요'); });
}
function checkReminders() {
  const now = Date.now();
  for (const n of live()) {
    if (!n.due || n.done || n.deleted) continue;
    const p = parseDue(n.due); if (!p) continue;
    let at, until;
    if (p.allDay) { const d = new Date(p.date); d.setHours(9, 0, 0, 0); at = d.getTime(); until = p.date.getTime(); }
    else { at = p.date.getTime() - (settings.remindMin || 0) * 60000; until = p.date.getTime() + 3600000; }
    if (now >= at && now <= until && notified[n.id] !== n.due) {
      notified[n.id] = n.due; LS.set(K.notified, notified);
      notify(n);
    }
  }
}
async function notify(n) {
  const t = textOf(n);
  const title = t === null ? '비밀 일정' : firstLine(t);
  const when = dueLabel(n.due);
  toast(`알림 · ${title} (${when})`, '보기', () => openEditor(n.id), 10000);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      const opt = { body: `${title}\n${when}`, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: n.id };
      if (reg) await reg.showNotification('오박사의 메모장', opt); else new Notification('오박사의 메모장', opt);
    } catch {}
  }
}
function calTimes(n) {
  const p = parseDue(n.due);
  const D = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const DT = d => `${D(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  if (p.allDay) { const e = new Date(p.date); e.setDate(e.getDate() + 1); return { allDay: true, s: D(p.date), e: D(e) }; }
  return { allDay: false, s: DT(p.date), e: DT(new Date(p.date.getTime() + 3600000)) };
}
function icsFor(n) {
  const t = textOf(n) || '일정';
  const c = calTimes(n);
  const x = s => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//obaksa//memo//KO', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${n.id}@obaksa-memo`, `DTSTAMP:${stamp}`,
    c.allDay ? `DTSTART;VALUE=DATE:${c.s}` : `DTSTART:${c.s}`, c.allDay ? `DTEND;VALUE=DATE:${c.e}` : `DTEND:${c.e}`,
    `SUMMARY:${x(firstLine(t))}`, `DESCRIPTION:${x(t)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:오박사의 메모장', `TRIGGER:-PT${settings.remindMin || 10}M`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function calendarMenu(id) {
  const n = notes[id]; if (!n || !n.due) return;
  const t = textOf(n);
  if (t === null) return toast('비밀 일정은 먼저 열어주세요');
  const c = calTimes(n);
  const g = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(firstLine(t))}&details=${encodeURIComponent(t)}&dates=${c.s}/${c.e}`;
  openModal(`<h2>캘린더에 넣기</h2>
    <p>앱을 꺼둬도 알림이 울리게 하려면 폰이나 구글 캘린더에 넣어두세요. <b>${esc(dueLabel(n.due))}</b> · ${esc(firstLine(t))}</p>
    ${n.locked ? '<p class="warn">비밀 메모입니다. 캘린더에 넣으면 그 내용은 암호화되지 않습니다.</p>' : ''}
    <div class="row"><a class="btn primary" href="${esc(g)}" target="_blank" rel="noopener">구글 캘린더에 추가</a>
    <button type="button" class="btn" id="icsBtn">일정 파일(.ics) 받기</button><span class="grow"></span><button type="button" class="btn ghost" data-close>닫기</button></div>`,
    el => { el.querySelector('#icsBtn').onclick = () => { download(`일정-${c.s.slice(0, 8)}.ics`, icsFor(n), 'text/calendar'); toast('파일을 열면 캘린더에 추가됩니다'); closeModal(); }; });
}

/* ───────── 모달·토스트 ───────── */
const modal = $('#modal'), sheet = $('#sheet');
let modalClose = null;
function openModal(html, mount, onClose) {
  if (modalClose) closeModal();
  sheet.innerHTML = html; modal.hidden = false;
  modalClose = onClose || null;
  sheet.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  if (mount) mount(sheet);
  const f = sheet.querySelector('[autofocus]') || sheet.querySelector('input, button');
  if (f) setTimeout(() => f.focus(), 30);
}
function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true; sheet.innerHTML = '';
  const c = modalClose; modalClose = null; if (c) c();
}
modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });

let toastT;
function toast(msg, actLabel, act, ms = 3200) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actLabel ? `<button type="button">${esc(actLabel)}</button>` : ''}`;
  if (actLabel) el.querySelector('button').onclick = () => { el.classList.remove('show'); act(); };
  el.classList.add('show'); clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), ms);
}

/* 비밀번호 */
function askSetup() {
  return new Promise(resolve => {
    let done = false;
    openModal(`<h2>비밀번호 만들기</h2>
      <p>잠근 메모는 이 비밀번호로 암호화됩니다. 비밀번호는 어디에도 저장되지 않아서 <b>잊으면 잠근 메모를 되살릴 수 없습니다.</b> 모든 기기에서 같은 비밀번호를 씁니다.</p>
      <form class="form" id="pwf">
        <label>비밀번호 (8자 이상)<input class="field" type="password" id="pw1" autocomplete="new-password" autofocus></label>
        <label>한 번 더<input class="field" type="password" id="pw2" autocomplete="new-password"></label>
        <div class="msg err" id="pwm"></div>
        <div class="row"><span class="grow"></span><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">만들기</button></div>
      </form>`, el => {
      el.querySelector('#pwf').onsubmit = async e => {
        e.preventDefault();
        const a = el.querySelector('#pw1').value, b = el.querySelector('#pw2').value, m = el.querySelector('#pwm');
        if (a.length < 8) { m.textContent = '8자 이상으로 정해주세요'; return; }
        if (a !== b) { m.textContent = '두 비밀번호가 다릅니다'; return; }
        m.textContent = '만드는 중…';
        const { k, v } = await newVault(a);
        vault = v; LS.set(K.vault, vault); key = k; touchLock();
        meta.dirty = true; saveMeta(); scheduleSync();
        done = true; closeModal(); toast('비밀번호를 만들었습니다'); resolve(true);
      };
    }, () => { if (!done) resolve(false); });
  });
}
function askUnlock(purpose) {
  return new Promise(resolve => {
    let done = false;
    openModal(`<h2>비밀번호 입력</h2>
      <p>${esc(purpose)} 비밀번호를 넣어주세요. ${settings.autoLockMin || 5}분 동안 쓰지 않으면 다시 잠깁니다.</p>
      <form class="form" id="pwf">
        <label>비밀번호<input class="field" type="password" id="pw1" autocomplete="current-password" autofocus></label>
        <div class="msg err" id="pwm"></div>
        <div class="row"><span class="grow"></span><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">열기</button></div>
      </form>`, el => {
      el.querySelector('#pwf').onsubmit = async e => {
        e.preventDefault();
        const m = el.querySelector('#pwm'); m.textContent = '확인 중…';
        const k = await tryKey(el.querySelector('#pw1').value);
        if (!k) { m.textContent = '비밀번호가 맞지 않습니다'; el.querySelector('#pw1').select(); return; }
        key = k; await decryptAll(); touchLock();
        done = true; closeModal(); render(); resolve(true);
      };
    }, () => { if (!done) resolve(false); });
  });
}
function askChangePassword() {
  openModal(`<h2>비밀번호 바꾸기</h2>
    <p>모든 비밀 메모를 새 비밀번호로 다시 잠급니다. 다른 기기에서는 동기화 후 새 비밀번호로 열면 됩니다.</p>
    <form class="form" id="pwf">
      <label>지금 비밀번호<input class="field" type="password" id="pw0" autocomplete="current-password" autofocus></label>
      <div class="two"><label>새 비밀번호<input class="field" type="password" id="pw1" autocomplete="new-password"></label>
      <label>한 번 더<input class="field" type="password" id="pw2" autocomplete="new-password"></label></div>
      <div class="msg err" id="pwm"></div>
      <div class="row"><span class="grow"></span><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">바꾸기</button></div>
    </form>`, el => {
    el.querySelector('#pwf').onsubmit = async e => {
      e.preventDefault();
      const m = el.querySelector('#pwm');
      const a = el.querySelector('#pw1').value, b = el.querySelector('#pw2').value;
      if (a.length < 8) { m.textContent = '새 비밀번호는 8자 이상으로 정해주세요'; return; }
      if (a !== b) { m.textContent = '새 비밀번호 두 개가 다릅니다'; return; }
      m.textContent = '확인 중…';
      const oldK = await tryKey(el.querySelector('#pw0').value);
      if (!oldK) { m.textContent = '지금 비밀번호가 맞지 않습니다'; return; }
      m.textContent = '다시 잠그는 중…';
      const { k, v } = await newVault(a);
      for (const n of Object.values(notes)) {
        if (!n.locked || !n.enc) continue;
        let t; try { t = await dec(oldK, n.enc); } catch { continue; }
        n.enc = await enc(k, t); plain.set(n.id, t); touch(n);
        for (const iid of n.images || []) {
          const rec = await idb.get(iid);
          if (rec && rec.enc) { try { await idb.put({ id: iid, mime: rec.mime, enc: await enc(k, await dec(oldK, rec.enc)), createdAt: rec.createdAt }); uploaded.delete(iid); } catch {} }
        }
      }
      LS.set(K.uploaded, [...uploaded]);
      vault = v; LS.set(K.vault, vault); key = k; touchLock();
      saveNotes(); closeModal(); render(); toast('비밀번호를 바꿨습니다');
    };
  });
}

/* ───────── GitHub 동기화 ───────── */
const gh = () => { const g = settings.gh; return g && g.token && g.owner && g.repo ? g : null; };
async function ghFetch(path, opt = {}) {
  const g = gh();
  let url = `https://api.github.com/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}${path}`;
  if (!opt.method && g.branch) url += (url.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(g.branch);
  const body = opt.body ? Object.assign({}, opt.body, g.branch ? { branch: g.branch } : {}) : undefined;
  return fetch(url, {
    method: opt.method || 'GET', cache: 'no-store',
    headers: Object.assign({ Authorization: `Bearer ${g.token}`, Accept: opt.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
}
async function ghErr(r) {
  const map = { 401: '토큰이 맞지 않거나 기간이 끝났습니다. 설정에서 새 토큰을 넣어주세요.', 403: '토큰에 이 저장소 쓰기 권한이 없습니다 (Contents 읽기·쓰기 필요).', 404: '저장소를 찾을 수 없습니다. 아이디와 저장소 이름을 확인해주세요.' };
  let extra = ''; try { extra = (await r.json()).message || ''; } catch {}
  return new Error(map[r.status] || `GitHub 오류 ${r.status} ${extra}`);
}
const utf8b64 = s => b64(te.encode(s));
const b64utf8 = s => td.decode(unb64(s));
async function ghReadNotes() {
  const r = await ghFetch('/contents/notes.json');
  if (r.status === 404) {
    const repo = await ghFetch('');           // 저장소 자체가 없는지 확인
    if (!repo.ok) throw await ghErr(repo);
    return { sha: null, data: null };
  }
  if (!r.ok) throw await ghErr(r);
  const j = await r.json();
  let txt;
  if (j.content && j.encoding === 'base64') txt = b64utf8(j.content);
  else {
    const r2 = await ghFetch('/contents/notes.json', { accept: 'application/vnd.github.raw+json' });
    if (!r2.ok) throw await ghErr(r2);
    txt = await r2.text();
  }
  let data = null; try { data = JSON.parse(txt); } catch { throw new Error('저장소의 notes.json 파일이 손상되었습니다'); }
  return { sha: j.sha, data };
}
function mergeRemote(data) {
  let localNewer = false, changed = false;
  if (!data) return { localNewer: Object.keys(notes).length > 0 || !!vault, changed };
  const rmap = {};
  for (const rn of data.notes || []) if (rn && rn.id) rmap[rn.id] = rn;
  for (const id in rmap) {
    const r = rmap[id], l = notes[id];
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) {
      if (id === editing && l && !r.purged) { localNewer = true; continue; }  // 지금 고치는 메모는 내 것이 이김
      notes[id] = r; plain.delete(id); changed = true;
      if (r.purged && l) for (const iid of l.images || []) { imgCache.delete(iid); idb.del(iid).catch(() => {}); }
    } else if ((l.updatedAt || 0) > (r.updatedAt || 0)) localNewer = true;
  }
  for (const id in notes) if (!rmap[id]) localNewer = true;
  const rv = data.vault || null;
  if (rv && (!vault || (rv.changedAt || 0) > (vault.changedAt || 0))) {
    if (vault && vault.salt !== rv.salt) { key = null; plain.clear(); toast('다른 기기에서 비밀번호가 바뀌었습니다. 새 비밀번호로 열어주세요.'); }
    vault = rv; LS.set(K.vault, vault); changed = true;
  } else if (vault && (!rv || (vault.changedAt || 0) > (rv.changedAt || 0))) localNewer = true;
  if (changed) { LS.set(K.notes, notes); if (key) decryptAll().then(render); render(); }
  return { localNewer, changed };
}
function serialize() {
  return { app: 'obaksa-memo', format: 1, savedAt: new Date().toISOString(), vault, notes: Object.values(notes) };
}
async function ghPutFile(path, text, message) {
  let sha;
  for (let i = 0; i < 2; i++) {
    const r = await ghFetch('/contents/' + path, { method: 'PUT', body: Object.assign({ message, content: utf8b64(text) }, sha ? { sha } : {}) });
    if (r.ok) return;
    if ((r.status === 422 || r.status === 409) && i === 0) {
      const g = await ghFetch('/contents/' + path);
      if (g.ok) { sha = (await g.json()).sha; continue; }
    }
    throw await ghErr(r);
  }
}
async function ghGetImage(id) {
  const r = await ghFetch(`/contents/images/${id}.json`, { accept: 'application/vnd.github.raw+json' });
  if (!r.ok) return null;
  const j = JSON.parse(await r.text());
  const rec = { id, mime: j.mime || 'image/jpeg', createdAt: j.createdAt || Date.now() };
  if (j.enc) rec.enc = j.enc; else if (j.data) rec.data = j.data; else return null;
  return rec;
}
async function syncImages() {
  const refs = new Set();
  for (const n of live()) (n.images || []).forEach(i => refs.add(i));
  for (const id of refs) {
    if (uploaded.has(id)) continue;
    const rec = await idb.get(id); if (!rec) continue;
    const payload = JSON.stringify({ id, mime: rec.mime, createdAt: rec.createdAt, data: rec.data || null, enc: rec.enc || null });
    await ghPutFile(`images/${id}.json`, payload, `사진 저장 ${id}`);
    uploaded.add(id); LS.set(K.uploaded, [...uploaded]);
  }
  for (const id of [...imgDel]) {
    if (refs.has(id)) { imgDel.delete(id); continue; }
    const g = await ghFetch(`/contents/images/${id}.json`);
    if (g.ok) {
      const sha = (await g.json()).sha;
      const d = await ghFetch(`/contents/images/${id}.json`, { method: 'DELETE', body: { message: `사진 삭제 ${id}`, sha } });
      if (!d.ok && d.status !== 404) throw await ghErr(d);
    } else if (g.status !== 404) throw await ghErr(g);
    imgDel.delete(id);
  }
  LS.set(K.imgdel, [...imgDel]);
}

let syncing = false, syncAgain = false, syncTimer = null;
function scheduleSync(ms = 5000) {
  if (!gh()) { setStatus(); return; }
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms);
}
async function syncNow() {
  clearTimeout(syncTimer);
  if (!gh()) { setStatus(); return; }
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  syncing = true; setStatus('syncing');
  try {
    for (const id of [...pendingEnc.keys()]) await flushEnc(id);
    let pushed = false;
    for (let attempt = 0; attempt < 3 && !pushed; attempt++) {
      const remote = await ghReadNotes();
      const { localNewer } = mergeRemote(remote.data);
      if (!meta.dirty && !localNewer && remote.sha) { pushed = true; break; }
      const seq = editSeq;
      const body = Object.assign({ message: `메모 동기화 ${new Date().toLocaleString('ko-KR')}`, content: utf8b64(JSON.stringify(serialize())) }, remote.sha ? { sha: remote.sha } : {});
      const r = await ghFetch('/contents/notes.json', { method: 'PUT', body });
      if (r.status === 409 || r.status === 422) continue;   // 다른 기기가 먼저 저장함 → 다시 받아서 합치기
      if (!r.ok) throw await ghErr(r);
      if (seq === editSeq) meta.dirty = false;
      pushed = true;
    }
    if (!pushed) throw new Error('다른 기기와 동시에 저장하느라 실패했습니다. 잠시 뒤 다시 시도합니다.');
    await syncImages();
    meta.lastSync = Date.now(); saveMeta();
    setStatus('ok');
  } catch (e) {
    setStatus(navigator.onLine ? 'error' : 'offline', e.message);
    if (navigator.onLine) scheduleSync(60000);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(800); }
  }
}
function hm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
let lastStatus = { s: 'local', msg: '' };
function setStatus(s, msg) {
  if (!gh()) s = 'local';
  else if (!s) s = lastStatus.s === 'local' ? (meta.lastSync ? 'ok' : 'syncing') : lastStatus.s;
  lastStatus = { s, msg: msg || '' };
  const btn = $('#syncBtn');
  btn.dataset.s = s;
  const text = {
    local: '이 기기에만 저장', syncing: '동기화 중…',
    ok: `동기화됨 ${meta.lastSync ? hm(meta.lastSync) : ''}${meta.dirty ? ' · 대기' : ''}`,
    offline: '오프라인 · 이 기기에 저장됨', error: '동기화 안 됨 · 눌러서 확인'
  }[s];
  $('#syncTxt').textContent = text;
  btn.title = s === 'error' ? msg : s === 'local' ? 'GitHub 동기화 설정하기' : '지금 동기화 (Ctrl+S)';
}

/* ───────── 설정 ───────── */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
function openSettings(section) {
  const g = settings.gh || {};
  const theme = settings.theme;
  openModal(`<h2>설정</h2>
    <h3>테마</h3>
    <div class="seg" id="segTheme"><button type="button" data-t="chalk" aria-pressed="${theme === 'chalk'}">칠판</button><button type="button" data-t="glass" aria-pressed="${theme === 'glass'}">글라스</button></div>

    <h3 id="secSync">GitHub 동기화</h3>
    <p>메모를 내 <b>비공개 저장소</b>에 보관해서 집 PC, 회사 PC, 폰이 같은 메모를 봅니다. 각 기기에서 한 번씩 아래를 채우면 됩니다.</p>
    <ol class="steps">
      <li>GitHub에서 <b>비공개(Private)</b> 저장소를 만듭니다. 예: <b>obaksa-memo-data</b></li>
      <li>GitHub 설정 → Developer settings → <b>Fine-grained tokens</b> → 새 토큰. 저장소는 방금 만든 것 하나만, 권한은 <b>Contents: Read and write</b></li>
      <li>아래에 아이디, 저장소 이름, 토큰을 넣고 <b>연결</b>을 누릅니다.</li>
    </ol>
    <form class="form" id="ghf">
      <div class="two">
        <label>GitHub 아이디<input class="field" id="ghOwner" value="${esc(g.owner || '')}" autocomplete="off" spellcheck="false" placeholder="예: ojungmin212-dotcom"></label>
        <label>저장소 이름<input class="field" id="ghRepo" value="${esc(g.repo || '')}" autocomplete="off" spellcheck="false" placeholder="obaksa-memo-data"></label>
      </div>
      <label>토큰 (이 기기에만 저장됩니다)<input class="field" id="ghToken" type="password" value="${esc(g.token || '')}" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
      <label>브랜치 (비워두면 기본 브랜치)<input class="field" id="ghBranch" value="${esc(g.branch || '')}" autocomplete="off" spellcheck="false"></label>
      <div class="msg" id="ghMsg"></div>
      <div class="row">
        <button class="btn primary">연결</button>
        ${gh() ? '<button type="button" class="btn" id="ghNow">지금 동기화</button><button type="button" class="btn ghost" id="ghOff">연결 끊기</button>' : ''}
      </div>
    </form>

    <h3>비밀 메모</h3>
    <p>${vault ? (key ? '지금 열려 있습니다.' : '잠겨 있습니다.') : '아직 비밀번호가 없습니다. 메모를 처음 잠글 때 만들어도 됩니다.'}</p>
    <div class="row">
      ${vault ? (key ? '<button type="button" class="btn" id="lockNowBtn">지금 잠그기</button>' : '<button type="button" class="btn" id="unlockBtn">열기</button>')
        + '<button type="button" class="btn ghost" id="chPwBtn">비밀번호 바꾸기</button>' : '<button type="button" class="btn" id="mkPwBtn">비밀번호 만들기</button>'}
      <label class="field-l">자동 잠금 <select class="field" id="autoLock">${[1, 3, 5, 10, 30].map(m => `<option value="${m}" ${settings.autoLockMin === m ? 'selected' : ''}>${m}분</option>`).join('')}</select></label>
    </div>

    <h3>일정 알림</h3>
    <div class="row">
      <label class="field-l">미리 알림 <select class="field" id="remind">${[0, 5, 10, 30, 60].map(m => `<option value="${m}" ${settings.remindMin === m ? 'selected' : ''}>${m ? m + '분 전' : '정각'}</option>`).join('')}</select></label>
      <button type="button" class="btn ghost" id="notifBtn">${'Notification' in window && Notification.permission === 'granted' ? '알림 켜짐' : '알림 허용하기'}</button>
    </div>
    <p>앱이 열려 있을 때 알립니다. 꺼져 있어도 울리게 하려면 일정의 <b>캘린더에 추가</b>를 쓰세요.</p>

    <h3>홈 화면 아이콘</h3>
    <div class="row">${installEvt ? '<button type="button" class="btn" id="installBtn">앱으로 설치</button>' : ''}</div>
    <p>안드로이드·PC 크롬: 주소창 오른쪽 설치 아이콘 또는 메뉴 → <b>앱 설치</b>. 아이폰 사파리: 공유 버튼 → <b>홈 화면에 추가</b>.</p>

    <h3>백업</h3>
    <div class="row"><button type="button" class="btn" id="expBtn">백업 파일 받기</button><button type="button" class="btn" id="impBtn">백업 파일 가져오기</button><input type="file" id="impFile" accept="application/json,.json" hidden></div>
    <p>비밀 메모는 백업 파일 안에서도 암호화된 채로 들어갑니다.</p>
    <div class="row"><span class="grow"></span><button type="button" class="btn primary" data-close>닫기</button></div>`,
  el => {
    el.querySelectorAll('#segTheme button').forEach(b => b.onclick = () => { setTheme(b.dataset.t); el.querySelectorAll('#segTheme button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
    const msg = el.querySelector('#ghMsg');
    el.querySelector('#ghf').onsubmit = async e => {
      e.preventDefault();
      const ng = { owner: el.querySelector('#ghOwner').value.trim(), repo: el.querySelector('#ghRepo').value.trim(),
        token: el.querySelector('#ghToken').value.trim(), branch: el.querySelector('#ghBranch').value.trim() };
      if (!ng.owner || !ng.repo || !ng.token) { msg.className = 'msg err'; msg.textContent = '아이디, 저장소 이름, 토큰을 모두 넣어주세요'; return; }
      const prev = settings.gh; settings.gh = ng;
      msg.className = 'msg'; msg.textContent = '확인 중…';
      try {
        const r = await ghFetch('');
        if (!r.ok) throw await ghErr(r);
        const j = await r.json();
        if (j.permissions && !j.permissions.push) throw new Error('이 토큰으로는 저장소에 쓸 수 없습니다 (Contents 읽기·쓰기 권한 필요)');
        saveSettings();
        msg.className = j.private ? 'msg ok' : 'msg err';
        msg.textContent = j.private ? '연결했습니다. 동기화를 시작합니다.' : '연결은 됐지만 공개 저장소입니다! 메모가 누구에게나 보입니다. 비공개로 바꿔주세요.';
        meta.dirty = true; saveMeta(); syncNow();
      } catch (err) {
        settings.gh = prev; msg.className = 'msg err'; msg.textContent = err.message || '연결하지 못했습니다';
      }
    };
    const now = el.querySelector('#ghNow'); if (now) now.onclick = () => { syncNow(); msg.className = 'msg'; msg.textContent = '동기화합니다'; };
    const off = el.querySelector('#ghOff'); if (off) off.onclick = () => { settings.gh = null; saveSettings(); setStatus(); closeModal(); toast('동기화 연결을 끊었습니다. 메모는 이 기기에 그대로 있습니다.'); };
    const b1 = el.querySelector('#lockNowBtn'); if (b1) b1.onclick = () => { lockNow(); closeModal(); toast('비밀 메모를 잠갔습니다'); };
    const b2 = el.querySelector('#unlockBtn'); if (b2) b2.onclick = () => { closeModal(); ensureKey(); };
    const b3 = el.querySelector('#chPwBtn'); if (b3) b3.onclick = () => askChangePassword();
    const b4 = el.querySelector('#mkPwBtn'); if (b4) b4.onclick = () => askSetup();
    el.querySelector('#autoLock').onchange = e => { settings.autoLockMin = +e.target.value; saveSettings(); touchLock(); };
    el.querySelector('#remind').onchange = e => { settings.remindMin = +e.target.value; saveSettings(); };
    el.querySelector('#notifBtn').onclick = e => {
      if (!('Notification' in window)) return toast('이 브라우저는 알림을 지원하지 않습니다');
      Notification.requestPermission().then(p => { e.target.textContent = p === 'granted' ? '알림 켜짐' : '알림이 막혀 있습니다 (브라우저 설정에서 허용)'; });
    };
    const ib = el.querySelector('#installBtn'); if (ib) ib.onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; ib.remove(); };
    el.querySelector('#expBtn').onclick = exportBackup;
    el.querySelector('#impBtn').onclick = () => el.querySelector('#impFile').click();
    el.querySelector('#impFile').onchange = e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; };
    if (section === 'sync') setTimeout(() => el.querySelector('#secSync').scrollIntoView({ block: 'start' }), 50);
  });
}
function setTheme(t) {
  settings.theme = t; saveSettings();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'glass' ? '#cbbfc2' : '#2c4034';
}
async function exportBackup() {
  const images = [];
  try { for (const r of await idb.all()) images.push(r); } catch {}
  const d = new Date();
  download(`오박사메모-백업-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`,
    JSON.stringify(Object.assign(serialize(), { images })), 'application/json');
  toast('백업 파일을 저장했습니다');
}
async function importBackup(file) {
  let d; try { d = JSON.parse(await file.text()); } catch { return toast('백업 파일이 아닙니다'); }
  if (!d || !Array.isArray(d.notes)) return toast('백업 파일이 아닙니다');
  if (d.vault && vault && d.vault.salt !== vault.salt) toast('다른 비밀번호로 잠긴 비밀 메모는 열리지 않을 수 있습니다');
  if (d.vault && !vault) { vault = d.vault; LS.set(K.vault, vault); }
  let c = 0;
  for (const n of d.notes) {
    if (!n || !n.id) continue;
    const l = notes[n.id];
    if (!l || (n.updatedAt || 0) > (l.updatedAt || 0)) { notes[n.id] = n; plain.delete(n.id); c++; }
  }
  for (const r of d.images || []) { if (r && r.id) { try { if (!await idb.get(r.id)) await idb.put(r); } catch {} } }
  saveNotes(); if (key) await decryptAll(); render(); closeModal();
  toast(`메모 ${c}개를 가져왔습니다`);
}

function showHelp() {
  const rows = [
    ['<kbd>Ctrl</kbd>+<kbd>N</kbd> · <kbd>Alt</kbd>+<kbd>N</kbd>', '새 메모 (브라우저 탭에서는 Alt+N)'],
    ['<kbd>Enter</kbd>', '입력칸에서 메모 저장 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈'],
    ['<kbd>Ctrl</kbd>+<kbd>F</kbd>', '찾기'],
    ['<kbd>Ctrl</kbd>+<kbd>S</kbd>', '저장하고 바로 동기화'],
    ['<kbd>↑</kbd> <kbd>↓</kbd>', '메모 고르기'],
    ['<kbd>F2</kbd> · <kbd>Enter</kbd>', '고른 메모 고치기'],
    ['<kbd>Space</kbd>', '할일·일정 완료 체크'],
    ['<kbd>Delete</kbd>', '고른 메모 휴지통으로'],
    ['<kbd>Ctrl</kbd>+<kbd>Z</kbd>', '방금 지운 메모 되살리기 (글을 고치는 중이면 글자 되돌리기)'],
    ['<kbd>Ctrl</kbd>+<kbd>;</kbd>', '오늘 날짜 넣기 (엑셀과 같음)'],
    ['<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>;</kbd>', '지금 시각 넣기 (엑셀과 같음)'],
    ['<kbd>Ctrl</kbd>+<kbd>V</kbd>', '사진 붙여넣기'],
    ['<kbd>Ctrl</kbd>+<kbd>Enter</kbd> · <kbd>Esc</kbd>', '고치기 끝내기'],
    ['<kbd>F1</kbd>', '이 도움말']
  ];
  openModal(`<h2>단축키</h2><table class="keys">${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>
    <div class="row"><span class="grow"></span><button type="button" class="btn primary" data-close>닫기</button></div>`);
}

/* ───────── 이벤트 ───────── */
$('#themeBtn').innerHTML = ic('theme');
$('#helpBtn').innerHTML = ic('keys');
$('#setBtn').innerHTML = ic('gear');
$('#qImg').innerHTML = ic('image');
$('#qLock').innerHTML = ic('lock');
document.querySelector('.searchbox .sicon').innerHTML = ic('search');

$('#themeBtn').onclick = () => { setTheme(settings.theme === 'glass' ? 'chalk' : 'glass'); toast(settings.theme === 'glass' ? '글라스 테마' : '칠판 테마'); };
$('#helpBtn').onclick = showHelp;
$('#setBtn').onclick = () => openSettings();
$('#syncBtn').onclick = () => {
  if (!gh()) return openSettings('sync');
  if (lastStatus.s === 'error') toast(lastStatus.msg || '동기화 오류', '설정', () => openSettings('sync'), 6000);
  syncNow();
};

$('#qKinds').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  qKind = b.dataset.kind; settings.kind = qKind; saveSettings(); renderQuickKinds();
  if (qKind === 'event' && !$('#qDate').value) { const d = new Date(); $('#qDate').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  $('#qText').focus();
});
$('#qText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(e.ctrlKey || e.metaKey)) { e.preventDefault(); quickAdd(); }
});
$('#qText').addEventListener('input', e => autoGrow(e.target));
$('#qAdd').onclick = quickAdd;
$('#qImg').onclick = () => { fileTarget = null; $('#fileIn').click(); };
$('#qLock').onclick = async () => {
  if (!qLocked && !await ensureKey('비밀 메모를 적으려면')) return;
  qLocked = !qLocked; $('#qLock').setAttribute('aria-pressed', qLocked); renderQuickKinds(); $('#qText').focus();
};
$('#qThumbs').addEventListener('click', async e => {
  const b = e.target.closest('[data-qrm]'); if (!b) return;
  const id = b.dataset.qrm; qImages = qImages.filter(x => x !== id); imgCache.delete(id);
  try { await idb.del(id); } catch {}
  renderQuickThumbs();
});
let fileTarget = null;
$('#fileIn').addEventListener('change', e => { addFiles(e.target.files, fileTarget); e.target.value = ''; });

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  if (editing) closeEditor(true);
  filter = b.dataset.f; LS.set(K.filter, filter); render();
});
$('#tagbar').addEventListener('click', e => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  tagFilter = tagFilter === b.dataset.tag ? null : b.dataset.tag; render();
});
$('#search').addEventListener('input', e => { query = e.target.value; render(); });
for (const id of ['#upcoming', '#upMobile']) $(id).addEventListener('click', e => {
  const b = e.target.closest('[data-open]'); if (!b) return;
  if (filter === 'trash' || (filter !== 'all' && filter !== notes[b.dataset.open].kind)) { filter = 'all'; LS.set(K.filter, filter); }
  tagFilter = null; query = ''; $('#search').value = '';
  openEditor(b.dataset.open);
});

listEl.addEventListener('click', async e => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card'); if (!card) return;
  const id = card.dataset.id;
  const actEl = e.target.closest('[data-act]');
  const act = actEl && actEl.dataset.act;
  const n = notes[id]; if (!n) return;
  selected = id;
  switch (act) {
    case 'done': patch(id, { done: !n.done }); break;
    case 'edit': if (!card.classList.contains('editing')) openEditor(id); break;
    case 'pin': patch(id, { pinned: !n.pinned }); toast(n.pinned ? '맨 위에 고정했습니다' : '고정을 풀었습니다'); break;
    case 'locknote': await lockNote(id); break;
    case 'unlocknote': await unlockNote(id); break;
    case 'trash': trash(id); break;
    case 'restore': Object.assign(n, { deleted: false, deletedAt: null }); touch(n); saveNotes(); render(); toast('복구했습니다'); break;
    case 'purge':
      openModal(`<h2>완전히 지울까요?</h2><p>이 메모와 사진이 모든 기기에서 사라지고 되살릴 수 없습니다.</p>
        <div class="row"><span class="grow"></span><button type="button" class="btn ghost" data-close>취소</button><button type="button" class="btn danger" id="yes">완전히 지우기</button></div>`,
        el => { el.querySelector('#yes').onclick = () => { closeModal(); purge(id); toast('완전히 지웠습니다'); }; });
      break;
    case 'kind': {
      const k = actEl.dataset.kind; const p = { kind: k };
      if (k === 'event' && !n.due) { const d = new Date(); p.due = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
      patch(id, p); break;
    }
    case 'addimg': fileTarget = id; $('#fileIn').click(); break;
    case 'rmimg': removeImage(id, actEl.dataset.img); break;
    case 'view': {
      const src = imgCache.get(actEl.dataset.img); if (!src) break;
      openModal(`<div class="lightbox"><img src="${src}" alt="첨부 사진"></div><div class="row"><span class="grow"></span><button type="button" class="btn primary" data-close>닫기</button></div>`);
      break;
    }
    case 'cal': calendarMenu(id); break;
    case 'close': closeEditor(); break;
    default: if (!card.classList.contains('editing')) render();
  }
});
listEl.addEventListener('input', e => {
  if (!e.target.matches('textarea.ed')) return;
  const id = e.target.closest('.card').dataset.id;
  setText(id, e.target.value); autoGrow(e.target);
  clearTimeout(listEl._t); listEl._t = setTimeout(() => { renderTags(); renderUpcoming(); renderStats(); renderFilters(); }, 500);
});
listEl.addEventListener('change', e => {
  const a = e.target.dataset.act; if (a !== 'date' && a !== 'time') return;
  const card = e.target.closest('.card'); const id = card.dataset.id;
  const d = card.querySelector('[data-act="date"]').value, t = card.querySelector('[data-act="time"]').value;
  patch(id, { due: d ? (t ? `${d}T${t}` : d) : null });
  if (d && t) maybeAskNotify();
});

/* 붙여넣기·끌어다 놓기 */
document.addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addFiles(files, editing);
});
let dragDepth = 0;
document.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropzone').hidden = false; } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  dragDepth = 0; $('#dropzone').hidden = true;
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const card = e.target.closest && e.target.closest('.card');
  addFiles(e.dataTransfer.files, card ? card.dataset.id : editing);
});

/* 단축키 (엑셀·윈도우 기준) */
function insertAtCursor(el, text) {
  const s = el.selectionStart, en = el.selectionEnd;
  if (s > 0 && !/\s/.test(el.value[s - 1])) text = ' ' + text;   // 태그에 붙지 않게
  el.setRangeText(text, s, en, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function moveSel(dir) {
  const ids = [...listEl.querySelectorAll('.card')].map(c => c.dataset.id);
  if (!ids.length) return;
  let i = ids.indexOf(selected);
  i = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + dir));
  selected = ids[i]; renderNow();
  const c = listEl.querySelector(`.card[data-id="${selected}"]`); if (c) c.scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  const t = e.target;
  const inField = t.matches && t.matches('input, textarea, select, [contenteditable="true"]');
  if (key) touchLock();
  if (k === 'F1') { e.preventDefault(); showHelp(); return; }
  if (!modal.hidden) { if (k === 'Escape') { e.preventDefault(); closeModal(); } return; }
  if ((mod && !e.shiftKey && (lower === 'n' || e.code === 'KeyN')) || (e.altKey && e.code === 'KeyN')) { e.preventDefault(); focusQuick(); return; }
  if (mod && (lower === 'f' || e.code === 'KeyF')) { e.preventDefault(); if (editing) closeEditor(); $('#search').focus(); $('#search').select(); return; }
  if (mod && (lower === 's' || e.code === 'KeyS')) {
    e.preventDefault();
    for (const id of [...pendingEnc.keys()]) flushEnc(id);
    if (gh()) syncNow(); else toast('이 기기에 저장되어 있습니다');
    return;
  }
  if (mod && e.code === 'Semicolon' && inField && t.setRangeText) {
    e.preventDefault();
    const d = new Date();
    insertAtCursor(t, e.shiftKey ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    return;
  }
  if (mod && k === 'Enter' && editing) { e.preventDefault(); closeEditor(); return; }
  if (k === 'Escape') {
    if (editing) { e.preventDefault(); const id = editing; closeEditor(); selected = id; render(); }
    else if (inField) { t.blur(); if (t.id === 'search' && t.value) { t.value = ''; query = ''; render(); } }
    else if (tagFilter) { tagFilter = null; render(); }
    return;
  }
  if (inField) return;
  if (t.closest && t.closest('button, a')) return;
  if (mod && (lower === 'z' || e.code === 'KeyZ')) { e.preventDefault(); undoDelete(); return; }
  if (mod || e.altKey) return;
  if (k === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (k === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if ((k === 'Enter' || k === 'F2') && selected) { e.preventDefault(); openEditor(selected); }
  else if (k === 'Delete' && selected && filter !== 'trash') { e.preventDefault(); trash(selected); }
  else if (k === ' ' && selected) {
    const n = notes[selected];
    if (n && (n.kind === 'todo' || n.kind === 'event') && !n.deleted) { e.preventDefault(); patch(selected, { done: !n.done }); }
  }
});
document.addEventListener('pointerdown', () => { if (key) touchLock(); }, { passive: true });

/* 편집 칸 밖을 누르면 편집 끝내기 */
document.addEventListener('pointerdown', e => {
  if (!editing || !modal.hidden) return;
  if (e.target.closest('.card.editing') || e.target.closest('.modal') || e.target.closest('.toast')) return;
  if (e.target.closest('.card')) return;  // 다른 카드를 누르면 그 카드가 열림
  closeEditor();
});

/* ───────── 시작 ───────── */
function seed() {
  if (meta.seeded) return;
  meta.seeded = true; saveMeta();
  if (Object.keys(notes).length) return;
  const T = 1793302000000;
  const base = { done: false, due: null, deleted: false, deletedAt: null, images: [], locked: false, enc: null, createdAt: T, updatedAt: T };
  notes['welcome-1'] = Object.assign({}, base, { id: 'welcome-1', kind: 'memo', pinned: true, createdAt: T + 3,
    text: '오박사의 메모장 사용법 #안내\n위 칸에 한 줄 적고 Enter. 할일·아이디어·일정·메모 중 골라 적어요. 사진은 Ctrl+V 로 붙여넣기. 단축키는 F1' });
  notes['welcome-2'] = Object.assign({}, base, { id: 'welcome-2', kind: 'todo', pinned: false, createdAt: T + 2,
    text: '설정에서 GitHub 동기화 연결하기 #설정' });
  notes['welcome-3'] = Object.assign({}, base, { id: 'welcome-3', kind: 'idea', pinned: false, createdAt: T + 1,
    text: '비밀번호·계좌 같은 건 자물쇠를 켜고 적으면 암호화돼요 #보안' });
  LS.set(K.notes, notes);
}

seed();
cleanup();
renderQuickKinds();
render();
setStatus();
setTheme(settings.theme);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (gh()) syncNow();
if (new URLSearchParams(location.search).has('new')) setTimeout(focusQuick, 100);
checkReminders();
setInterval(checkReminders, 30000);
setInterval(() => { if (gh() && document.visibilityState === 'visible') syncNow(); }, 180000);
setInterval(() => renderUpcoming(), 60000);
window.addEventListener('online', () => { setStatus(); syncNow(); });
window.addEventListener('offline', () => setStatus('offline'));
document.addEventListener('visibilitychange', () => {
  if (!gh()) return;
  if (document.visibilityState === 'visible' && Date.now() - meta.lastSync > 30000) syncNow();
  if (document.visibilityState === 'hidden' && meta.dirty) syncNow();
});

// 테스트·점검용 (개발자 도구에서만 씀)
window.__obm = { get notes() { return notes; }, syncNow, mergeRemote, settings: () => settings, img: { cache: imgCache, load: loadImg, idb } };
})();
