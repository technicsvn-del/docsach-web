// Đọc Sách – web app đọc PDF như sách, lật giấy và giả lập màn hình e-ink.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const VENDOR = new URL('./vendor/pdfjs/', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: VENDOR + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: VENDOR + 'standard_fonts/',
  wasmUrl: VENDOR + 'wasm/',
  iccUrl: VENDOR + 'iccs/',
  isEvalSupported: false,
};

const $ = (id) => document.getElementById(id);

// ================= Cài đặt =================

const MODES = {
  ink: { title: 'Mực (e-ink)', paper: '#E9E7E0', ink: '#1F1F1F' },
  paper: { title: 'Giấy', paper: '#F5EEDC', ink: '#33291F' },
  original: { title: 'Gốc', paper: '#FFFFFF', ink: '#000000' },
  night: { title: 'Đêm', paper: '#131313', ink: '#CCC7BA' },
};
const TURNS = { curl: 'Lật giấy', slide: 'Trượt', instant: 'Tức thì (e-ink)' };
const DEFAULTS = {
  mode: 'ink', turn: 'curl', contrast: 1.15, levels: 16, dither: true, texture: true,
  crop: 0, twoUp: true, flash: false, flashEvery: 6, ghosting: true, keepAwake: true,
};
let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem('docsach-settings') || '{}')); } catch (e) {}
const saveSettings = () => localStorage.setItem('docsach-settings', JSON.stringify(S));

const paperColor = () => MODES[S.mode].paper;
const inkColor = () => MODES[S.mode].ink;
const styleKey = () => [S.mode, Math.round(S.contrast * 100), S.levels, S.dither, S.texture, Math.round(S.crop * 1000)].join('-');
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function applyTheme() {
  const root = document.documentElement.style;
  root.setProperty('--paper', paperColor());
  root.setProperty('--ink', inkColor());
  const [r, g, b] = rgb(inkColor());
  root.setProperty('--line', `rgba(${r},${g},${b},.3)`);
  document.querySelector('meta[name=theme-color]').content = paperColor();
  document.body.classList.toggle('gray', S.mode === 'ink' || S.mode === 'night');
  document.documentElement.style.colorScheme = S.mode === 'night' ? 'dark' : 'light';
}

// ================= Lưu trữ (IndexedDB) =================

const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('docsach', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  get(store, key) { return this.run(store, 'readonly', (s) => s.get(key)); },
  all(store) { return this.run(store, 'readonly', (s) => s.getAll()); },
  put(store, val, key) { return this.run(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))); },
  del(store, key) { return this.run(store, 'readwrite', (s) => s.delete(key)); },
};

// ================= Tiện ích giao diện =================

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function openSheet(title, body) {
  $('sheetTitle').textContent = title;
  const b = $('sheetBody');
  b.replaceChildren(body);
  b.scrollTop = 0;
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; }
$('sheetClose').onclick = closeSheet;
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

// ================= Tủ sách =================

let books = [];

async function loadLibrary() {
  books = await DB.all('books');
  books.sort((a, b) => Math.max(b.lastOpened, b.added) - Math.max(a.lastOpened, a.added));
  renderGrid();
}

function renderGrid() {
  const q = $('search').value.trim().toLowerCase();
  const list = books.filter((b) => !q || b.title.toLowerCase().includes(q));
  $('empty').hidden = books.length > 0;
  $('search').hidden = books.length === 0;
  const grid = $('grid');
  grid.replaceChildren(...list.map((b) => {
    const pct = b.pageCount > 1 ? Math.round((b.lastPage / (b.pageCount - 1)) * 100) : 0;
    const cover = el('div', { class: 'cover' });
    if (b.cover) cover.style.backgroundImage = `url(${b.cover})`;
    else cover.textContent = b.locked ? '🔒' : '📖';
    const pages = b.pageCount ? ` · ${b.pageCount} trang` : '';
    const card = el('div', { class: 'card', onclick: () => openBook(b.id) },
      cover,
      el('div', { class: 'title', text: b.title }),
      el('div', { class: 'prog' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'info', text: (b.lastOpened ? `${pct}%` : 'Mới') + pages }),
      el('button', { class: 'more icon', text: '⋯', onclick: (e) => { e.stopPropagation(); bookMenu(b); } }));
    return card;
  }));
}

function bookMenu(b) {
  const body = el('div', {},
    el('button', { class: 'list-item', text: 'Đọc tiếp', onclick: () => { closeSheet(); openBook(b.id); } }),
    el('button', { class: 'list-item', text: 'Đọc từ đầu', onclick: async () => { closeSheet(); b.lastPage = 0; await DB.put('books', b); openBook(b.id); } }),
    el('button', { class: 'list-item danger', text: 'Xoá khỏi máy', onclick: async () => {
      if (!confirm(`Xoá "${b.title}" khỏi máy?`)) return;
      await DB.del('files', b.id);
      await DB.del('books', b.id);
      closeSheet();
      loadLibrary();
    } }));
  openSheet(b.title, body);
}

async function makeCover(doc) {
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 300 / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  await page.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise;
  const url = c.toDataURL('image/jpeg', 0.8);
  c.width = c.height = 0;
  return url;
}

async function importFiles(files) {
  if (!files.length) return;
  toast('Đang thêm sách…', 60000);
  let ok = 0, fail = 0;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const book = {
        id, title: f.name.replace(/\.pdf$/i, ''), added: Date.now(), lastOpened: 0,
        lastPage: 0, pageCount: 0, bookmarks: [], cover: null, locked: false,
      };
      try {
        const t = pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) });
        try {
          const doc = await t.promise;
          book.pageCount = doc.numPages;
          try { book.cover = await makeCover(doc); } catch (e) {}
        } finally {
          t.destroy();
        }
      } catch (e) {
        if (e && e.name === 'PasswordException') book.locked = true;
        else throw e;
      }
      await DB.put('files', buf, id);
      await DB.put('books', book);
      ok++;
    } catch (e) {
      console.error(e);
      fail++;
    }
  }
  await loadLibrary();
  toast(fail ? `Đã thêm ${ok} sách, ${fail} file lỗi (không phải PDF hoặc bị hỏng).` : `Đã thêm ${ok} sách.`);
}

$('filePick').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  importFiles(files);
});
$('search').addEventListener('input', renderGrid);
$('btnSettings').onclick = () => showSettings();

// ================= Bộ lọc e-ink =================

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
let TEX = null;
function texture() {
  if (!TEX) {
    TEX = new Uint16Array(128 * 128);
    let s = 7;
    for (let i = 0; i < TEX.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      TEX[i] = 241 + ((s >> 16) % 16);
    }
  }
  return TEX;
}

function inkFilter(cx, w, h) {
  if (S.mode === 'original') return;
  const img = cx.getImageData(0, 0, w, h);
  const d = img.data;
  const con = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) con[i] = Math.round((i - 128) * S.contrast + 128);
  const t = S.texture && S.mode !== 'night' ? texture() : null;
  const P = rgb(paperColor()), K = rgb(inkColor());

  if (S.mode === 'ink' || S.mode === 'night') {
    const L = S.mode === 'ink' ? Math.max(2, Math.min(256, S.levels)) : 256;
    const cr = new Uint8Array(L), cg = new Uint8Array(L), cb = new Uint8Array(L);
    for (let k = 0; k < L; k++) {
      const f = k / (L - 1);
      cr[k] = Math.round(K[0] + (P[0] - K[0]) * f);
      cg[k] = Math.round(K[1] + (P[1] - K[1]) * f);
      cb[k] = Math.round(K[2] + (P[2] - K[2]) * f);
    }
    const dith = S.mode === 'ink' && S.dither && L < 256;
    const dOff = new Int16Array(64);
    if (dith) for (let i = 0; i < 64; i++) dOff[i] = Math.round((BAYER[i] / 64 - 0.5) * (255 / (L - 1)));
    for (let y = 0; y < h; y++) {
      const by = (y & 7) * 8, ty = (y & 127) * 128;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        let v = con[(d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8];
        if (dith) { v += dOff[by + (x & 7)]; v = v < 0 ? 0 : v > 255 ? 255 : v; }
        const k = ((v * (L - 1) + 127) / 255) | 0;
        if (t) {
          const f = t[ty + (x & 127)];
          d[o] = (cr[k] * f) >> 8; d[o + 1] = (cg[k] * f) >> 8; d[o + 2] = (cb[k] * f) >> 8;
        } else {
          d[o] = cr[k]; d[o + 1] = cg[k]; d[o + 2] = cb[k];
        }
        d[o + 3] = 255;
      }
    }
  } else { // giấy
    for (let y = 0; y < h; y++) {
      const ty = (y & 127) * 128;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        let r = (con[d[o]] * P[0]) / 255, g = (con[d[o + 1]] * P[1]) / 255, b = (con[d[o + 2]] * P[2]) / 255;
        if (t) { const f = t[ty + (x & 127)] / 256; r *= f; g *= f; b *= f; }
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
  }
  cx.putImageData(img, 0, 0);
}

// ================= Màn hình đọc =================

const R = {
  book: null, pdf: null, pageCount: 0, current: 0, twoUp: false,
  canvas: $('pageCanvas'), ctx: null, W: 0, H: 0, dpr: 1, left: 0,
  cache: new Map(), pending: new Set(), failed: new Set(), chain: Promise.resolve(), gen: 0,
  turning: false, dragging: false, aIdx: 0, bIdx: 0, p: 0, dy: 0, cy: 0, startP: 0, anim: null,
  down: null, moved: false, samples: [],
  flashStart: -1, turns: 0, ghostIdx: -1, ghostStart: 0,
  outline: null, wakeLock: null,
};
R.ctx = R.canvas.getContext('2d');

const step = () => (R.twoUp ? 2 : 1);
const limit = () => (R.twoUp ? Math.ceil(R.pageCount / 2) * 2 : R.pageCount);
const slotW = () => (R.twoUp ? Math.floor(R.W / 2) : R.W);
function firstIndex(p) {
  p = Math.max(0, Math.min(p, R.pageCount - 1));
  return R.twoUp ? p - (p % 2) : p;
}

function layout() {
  const rect = R.canvas.getBoundingClientRect();
  R.dpr = Math.min(window.devicePixelRatio || 1, 2);
  R.left = rect.left;
  R.W = Math.round(rect.width * R.dpr);
  R.H = Math.round(rect.height * R.dpr);
  R.canvas.width = R.W;
  R.canvas.height = R.H;
  R.twoUp = S.twoUp && rect.width > rect.height;
  R.current = firstIndex(R.current);
  cancelTurn();
  dirty();
  prefetch();
}

// ---------- Vẽ trang PDF (có hàng đợi + bộ nhớ đệm) ----------

const pageAlign = (i) => (R.twoUp ? (i % 2 === 0 ? 'r' : 'l') : 'c');
const pageKey = (i) => `${i}|${slotW()}x${R.H}|${pageAlign(i)}|${styleKey()}`;

function getBmp(i) {
  if (!R.pdf || i < 0 || i >= R.pageCount || R.W < 10) return null;
  const key = pageKey(i);
  const c = R.cache.get(key);
  if (c) {
    R.cache.delete(key);
    R.cache.set(key, c);
    return c;
  }
  if (!R.pending.has(key) && !R.failed.has(key)) {
    R.pending.add(key);
    const w = slotW(), h = R.H, gen = R.gen, align = pageAlign(i);
    R.chain = R.chain.then(() => (gen === R.gen ? renderPage(i, w, h, align) : null)).then((cv) => {
      R.pending.delete(key);
      if (!cv || gen !== R.gen) return;
      R.cache.set(key, cv);
      while (R.cache.size > 8) {
        const [k0, c0] = R.cache.entries().next().value;
        R.cache.delete(k0);
        c0.width = c0.height = 0;
      }
      dirty();
    }).catch((e) => {
      console.error(e);
      R.pending.delete(key);
      R.failed.add(key);
    });
  }
  return null;
}

async function renderPage(i, w, h, align) {
  const page = await R.pdf.getPage(i + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const m = S.crop;
  const vw = vp1.width * (1 - 2 * m), vh = vp1.height * (1 - 2 * m);
  const sc = Math.min(w / vw, h / vh);
  const bw = Math.max(1, Math.round(vw * sc)), bh = Math.max(1, Math.round(vh * sc));
  const c = document.createElement('canvas');
  c.width = bw;
  c.height = bh;
  const vp = page.getViewport({ scale: sc });
  await page.render({
    canvas: c, viewport: vp, background: '#ffffff',
    transform: [1, 0, 0, 1, -vp1.width * m * sc, -vp1.height * m * sc],
  }).promise;
  // Ghép trang vào ô nền trắng rồi lọc cả ô, để lề quanh trang cùng màu và vân giấy
  const slot = document.createElement('canvas');
  slot.width = w;
  slot.height = h;
  const sx = slot.getContext('2d', { willReadFrequently: true });
  sx.fillStyle = '#ffffff';
  sx.fillRect(0, 0, w, h);
  const ox = align === 'r' ? w - bw : align === 'l' ? 0 : Math.floor((w - bw) / 2); // 2 trang: sát gáy sách
  sx.drawImage(c, ox, Math.floor((h - bh) / 2));
  c.width = c.height = 0;
  inkFilter(sx, w, h);
  page.cleanup();
  return slot;
}

function clearCache() {
  R.gen++;
  for (const c of R.cache.values()) c.width = c.height = 0;
  R.cache.clear();
  R.pending.clear();
  R.failed.clear();
}

function prefetch() {
  if (!R.pdf) return;
  const s = step();
  for (let k = 0; k < s; k++) getBmp(R.current + k);
  for (let k = 0; k < s; k++) { getBmp(R.current + s + k); getBmp(R.current - s + k); }
}

// ---------- Vẽ khung hình ----------

let needsDraw = false;
function dirty() {
  if (!needsDraw) { needsDraw = true; requestAnimationFrame(frame); }
}
function frame() { needsDraw = false; draw(); }

function drawPage(ctx, i, x) {
  const b = getBmp(i);
  if (b) ctx.drawImage(b, x, 0);
}
function drawSpread(ctx, first, dx) {
  drawPage(ctx, first, dx);
  if (R.twoUp) drawPage(ctx, first + 1, dx + slotW());
}
function drawSpine(ctx) {
  if (!R.twoUp || S.turn !== 'curl') return;
  const mid = slotW(), w = 22 * R.dpr, a = S.mode === 'night' ? 0.33 : 0.15;
  let g = ctx.createLinearGradient(mid - w, 0, mid, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`);
  ctx.fillStyle = g; ctx.fillRect(mid - w, 0, w, R.H);
  g = ctx.createLinearGradient(mid, 0, mid + w, 0);
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(mid, 0, w, R.H);
}

function draw() {
  const ctx = R.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = paperColor();
  ctx.fillRect(0, 0, R.W, R.H);
  if (!R.pdf) return;

  if (R.turning && S.turn === 'slide') {
    drawSpread(ctx, R.aIdx, -R.p * R.W);
    drawSpread(ctx, R.bIdx, (1 - R.p) * R.W);
  } else if (R.turning && S.turn === 'curl') {
    drawCurl(ctx);
  } else {
    drawSpread(ctx, R.current, 0);
    drawSpine(ctx);
  }

  const now = performance.now();
  if (R.ghostIdx >= 0) {
    const t = (now - R.ghostStart) / 900;
    if (t >= 1) R.ghostIdx = -1;
    else {
      ctx.globalAlpha = 0.11 * (1 - t);
      drawSpread(ctx, R.ghostIdx, 0);
      ctx.globalAlpha = 1;
      dirty();
    }
  }
  if (R.flashStart >= 0) {
    const e = now - R.flashStart;
    if (e < 90) { ctx.fillStyle = inkColor(); ctx.fillRect(0, 0, R.W, R.H); }
    else if (e < 150) { ctx.fillStyle = paperColor(); ctx.fillRect(0, 0, R.W, R.H); }
    else if (e < 270) {
      ctx.globalAlpha = 1 - (e - 150) / 120;
      ctx.fillStyle = paperColor(); ctx.fillRect(0, 0, R.W, R.H);
      ctx.globalAlpha = 1;
    } else R.flashStart = -1;
    if (R.flashStart >= 0) dirty();
  }
}

/** Cắt đa giác (mảng x,y phẳng) bằng nửa mặt phẳng (P-M)·n >= 0 hoặc <= 0. */
function clipPoly(pts, mx, my, nx, ny, positive) {
  const s = positive ? 1 : -1, out = [], n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const px = pts[2 * i], py = pts[2 * i + 1];
    const j = (i + 1) % n, qx = pts[2 * j], qy = pts[2 * j + 1];
    const fp = s * ((px - mx) * nx + (py - my) * ny), fq = s * ((qx - mx) * nx + (qy - my) * ny);
    if (fp >= 0) out.push(px, py);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push(px + (qx - px) * t, py + (qy - py) * t);
    }
  }
  return out;
}
function polyPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
}

function drawCurl(ctx) {
  const W = R.W, H = R.H, pw = slotW(), px0 = R.twoUp ? pw : 0, cx = px0 + pw, cy = R.cy, dpr = R.dpr;
  let tx = cx - R.p * 2 * pw, ty = cy + R.dy;
  // gáy sách cố định: góc trang không xa gáy hơn bề rộng trang
  const sx = tx - px0, sy = ty - cy, dist = Math.hypot(sx, sy);
  if (dist > pw) { tx = px0 + (sx / dist) * pw; ty = cy + (sy / dist) * pw; }

  const aFront = R.twoUp ? R.aIdx + 1 : R.aIdx, bFront = R.twoUp ? R.bIdx + 1 : R.bIdx;
  if (R.twoUp) drawPage(ctx, R.aIdx, 0);

  const dx = tx - cx, dyv = ty - cy, len = Math.hypot(dx, dyv);
  if (len < 1) { drawPage(ctx, aFront, px0); drawSpine(ctx); return; }
  const nx = dx / len, ny = dyv / len, mx = (cx + tx) / 2, my = (cy + ty) / 2;
  const rect = [px0, 0, px0 + pw, 0, px0 + pw, H, px0, H];
  const keep = clipPoly(rect, mx, my, nx, ny, true);
  const lift = clipPoly(rect, mx, my, nx, ny, false);

  // 1. phần trang hiện tại chưa bị lật
  if (keep.length >= 6) {
    ctx.save(); polyPath(ctx, keep); ctx.clip();
    drawPage(ctx, aFront, px0);
    ctx.restore();
  }
  drawSpine(ctx);
  if (lift.length < 6) return;

  // 2. trang sau lộ ra dưới góc lật, bóng đổ dọc nếp gấp
  const sw = Math.min(len * 0.5, 48 * dpr);
  ctx.save(); polyPath(ctx, lift); ctx.clip();
  ctx.fillStyle = paperColor(); ctx.fillRect(0, 0, W, H);
  drawPage(ctx, bFront, px0);
  let g = ctx.createLinearGradient(mx, my, mx - nx * sw, my - ny * sw);
  g.addColorStop(0, 'rgba(0,0,0,0.42)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 3. mặt sau tờ giấy = phản chiếu phần bị lật qua nếp gấp
  const k = mx * nx + my * ny;
  const A = 1 - 2 * nx * nx, B = -2 * nx * ny, E = 1 - 2 * ny * ny, C = 2 * k * nx, F = 2 * k * ny;
  const flap = [];
  for (let i = 0; i < lift.length; i += 2) {
    const x = lift[i], y = lift[i + 1];
    flap.push(A * x + B * y + C, B * x + E * y + F);
  }
  ctx.save();
  ctx.translate(-3 * dpr * nx, -3 * dpr * ny);
  polyPath(ctx, flap); ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fill();
  ctx.restore();

  ctx.save(); polyPath(ctx, flap); ctx.clip();
  ctx.fillStyle = paperColor(); ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.transform(A, B, B, E, C, F);
  if (R.twoUp) {
    ctx.transform(-1, 0, 0, 1, 2 * px0, 0); // mặt sau trang phải = trang trái của khung sau
    drawPage(ctx, R.bIdx, 0);
  } else {
    ctx.globalAlpha = 0.12; // giấy mỏng: thấy mờ chữ mặt trước
    drawPage(ctx, aFront, px0);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  const half = len / 2;
  g = ctx.createLinearGradient(mx, my, mx + nx * half, my + ny * half);
  g.addColorStop(0, 'rgba(0,0,0,0.28)'); g.addColorStop(0.35, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.08)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();

  ctx.save(); polyPath(ctx, flap);
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.2 * dpr; ctx.stroke();
  ctx.restore();
}

// ---------- Lật trang ----------

function startDrag(forward, x, y) {
  if (forward) {
    if (R.current + step() >= limit()) return;
    R.aIdx = R.current; R.bIdx = R.current + step(); R.startP = 0;
  } else {
    if (R.current - step() < 0) return;
    R.aIdx = R.current - step(); R.bIdx = R.current; R.startP = 1;
  }
  R.down = { x, y };
  R.cy = y > R.H / 2 ? R.H : 0;
  R.dy = 0;
  R.p = R.startP;
  R.turning = true;
  R.dragging = true;
}

function animate(p0, target, dy0, arc, onEnd) {
  const dur = 140 + 420 * Math.abs(target - p0);
  const t0 = performance.now();
  const a = { done: false, finish: null };
  const tick = (now) => {
    if (a.done) return;
    const f = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - f, 2.8);
    R.p = p0 + (target - p0) * e;
    R.dy = dy0 * (1 - e) + arc * Math.sin(Math.PI * e);
    draw();
    if (f < 1) requestAnimationFrame(tick);
    else a.finish();
  };
  a.finish = () => { if (a.done) return; a.done = true; R.anim = null; onEnd(); };
  R.anim = a;
  requestAnimationFrame(tick);
}

function finishTurn(toB, arc) {
  R.dragging = false;
  animate(R.p, toB ? 1 : 0, R.dy, arc, () => {
    R.turning = false;
    const now = toB ? R.bIdx : R.aIdx;
    const changed = now !== R.current;
    R.current = now;
    if (changed) pageChanged();
    dirty();
  });
}

function cancelTurn() {
  if (R.anim) { R.anim.done = true; R.anim = null; }
  R.turning = false;
  R.dragging = false;
}

function autoTurn(forward) {
  if (R.turning || !R.pdf) return;
  const target = forward ? R.current + step() : R.current - step();
  if (target < 0 || target >= limit()) return;
  if (S.turn === 'instant') { jumpTo(target); return; }
  if (forward) { R.aIdx = R.current; R.bIdx = target; R.p = 0; }
  else { R.aIdx = target; R.bIdx = R.current; R.p = 1; }
  R.cy = R.H;
  R.dy = 0;
  R.turning = true;
  finishTurn(forward, S.turn === 'curl' ? -0.12 * R.H : 0);
}

function jumpTo(first) {
  if (S.turn === 'instant' && S.ghosting) { R.ghostIdx = R.current; R.ghostStart = performance.now(); }
  R.current = first;
  pageChanged();
  dirty();
}

function goTo(page) {
  const idx = firstIndex(page);
  if (idx === R.current) return;
  cancelTurn();
  if (Math.abs(idx - R.current) === step() && S.turn !== 'instant') autoTurn(idx > R.current);
  else jumpTo(idx);
}

function pageChanged() {
  R.turns++;
  if (S.flash && R.turns % Math.max(1, S.flashEvery) === 0) R.flashStart = performance.now();
  updateBars();
  prefetch();
  const b = R.book;
  b.lastPage = R.current;
  b.pageCount = R.pageCount;
  DB.put('books', b).catch(() => {});
}

// ---------- Cảm ứng ----------

const cv = R.canvas;
const pos = (e) => [(e.clientX - R.left) * R.dpr, e.clientY * R.dpr];

cv.addEventListener('pointerdown', (e) => {
  if (!R.pdf) return;
  cv.setPointerCapture(e.pointerId);
  if (R.anim) R.anim.finish();
  const [x, y] = pos(e);
  R.down = { x, y };
  R.moved = false;
  R.dragging = false;
  R.samples = [[x, performance.now()]];
});

cv.addEventListener('pointermove', (e) => {
  if (!R.down) return;
  const [x, y] = pos(e);
  R.samples.push([x, performance.now()]);
  if (R.samples.length > 6) R.samples.shift();
  const slop = 10 * R.dpr;
  if (!R.moved && Math.abs(x - R.down.x) > slop) {
    R.moved = true;
    if (S.turn !== 'instant') startDrag(x < R.down.x, x, y);
  }
  if (R.dragging) {
    const range = S.turn === 'curl' ? slotW() * 1.2 : R.W;
    R.p = Math.max(0, Math.min(1, R.startP + (R.down.x - x) / range));
    if (S.turn === 'curl') R.dy = y - R.down.y;
    dirty();
  }
});

function pointerEnd(e) {
  if (!R.down) return;
  const [x] = pos(e);
  const s0 = R.samples[0], s1 = R.samples[R.samples.length - 1];
  const vx = s1 && s0 && s1[1] > s0[1] ? ((s1[0] - s0[0]) / (s1[1] - s0[1])) * 1000 / R.dpr : 0;
  const down = R.down;
  R.down = null;
  if (R.dragging) {
    const toB = Math.abs(vx) > 500 ? vx < 0 : R.p > 0.5;
    finishTurn(toB, 0);
  } else if (!R.moved && e.type === 'pointerup') {
    const f = x / R.W;
    if (f < 0.3) autoTurn(false);
    else if (f > 0.7) autoTurn(true);
    else toggleChrome();
  } else if (Math.abs(x - down.x) > 30 * R.dpr) {
    autoTurn(x < down.x);
  }
}
cv.addEventListener('pointerup', pointerEnd);
cv.addEventListener('pointercancel', pointerEnd);
cv.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
  if ($('reader').hidden || !$('sheet').hidden) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); autoTurn(true); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); autoTurn(false); }
  else if (e.key === 'Escape') closeReader();
});

// ---------- Thanh công cụ ----------

function toggleChrome(show) {
  const r = $('reader');
  r.classList.toggle('chrome', show === undefined ? !r.classList.contains('chrome') : show);
}

function updateBars() {
  const n = R.pageCount, p = R.current;
  $('slider').max = Math.max(0, n - 1);
  $('slider').value = p;
  setPageInfo(p);
  $('btnMark').textContent = R.book.bookmarks.includes(p) ? '★' : '☆';
}
function setPageInfo(p) {
  const n = R.pageCount;
  const pct = n > 1 ? Math.round((p / (n - 1)) * 100) : 100;
  $('pageInfo').textContent = `Trang ${+p + 1} / ${n}  ·  ${pct}%`;
}

$('slider').addEventListener('input', (e) => setPageInfo(e.target.value));
$('slider').addEventListener('change', (e) => goTo(+e.target.value));
$('btnBack').onclick = () => closeReader();
$('btnAa').onclick = () => showSettings();
$('btnMark').onclick = () => {
  const b = R.book, p = R.current, i = b.bookmarks.indexOf(p);
  if (i >= 0) b.bookmarks.splice(i, 1);
  else { b.bookmarks.push(p); b.bookmarks.sort((x, y) => x - y); }
  DB.put('books', b);
  updateBars();
  toast(i >= 0 ? 'Đã bỏ đánh dấu' : 'Đã đánh dấu trang', 1200);
};
$('btnToc').onclick = () => showToc(0);

async function loadOutline() {
  if (R.outline) return R.outline;
  const out = [];
  try {
    const items = await R.pdf.getOutline();
    const walk = async (list, depth) => {
      for (const it of list || []) {
        let page = -1;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await R.pdf.getDestination(dest);
          if (Array.isArray(dest)) {
            const ref = dest[0];
            page = typeof ref === 'number' ? ref : await R.pdf.getPageIndex(ref);
          }
        } catch (e) {}
        out.push({ title: it.title, page, depth });
        await walk(it.items, depth + 1);
      }
    };
    await walk(items, 0);
  } catch (e) {}
  R.outline = out;
  return out;
}

async function showToc(tab) {
  const body = el('div');
  const seg = el('div', { class: 'seg' },
    el('button', { class: tab === 0 ? 'on' : '', text: 'Mục lục', onclick: () => showToc(0) }),
    el('button', { class: tab === 1 ? 'on' : '', text: 'Đánh dấu', onclick: () => showToc(1) }));
  body.append(seg);
  if (tab === 0) {
    const items = await loadOutline();
    if (!items.length) body.append(el('p', { class: 'hint', text: 'Sách này không có mục lục.' }));
    for (const it of items) {
      body.append(el('button', {
        class: 'list-item', style: `padding-left:${it.depth * 16}px`,
        onclick: () => { if (it.page >= 0) { closeSheet(); goTo(it.page); } },
      }, el('span', { text: it.title }), el('span', { class: 'pg', text: it.page >= 0 ? it.page + 1 : '' })));
    }
  } else {
    const marks = R.book.bookmarks;
    if (!marks.length) body.append(el('p', { class: 'hint', text: 'Chưa đánh dấu trang nào. Bấm ☆ khi đang đọc để đánh dấu.' }));
    for (const p of marks) {
      body.append(el('button', { class: 'list-item', onclick: () => { closeSheet(); goTo(p); } },
        el('span', { text: `★  Trang ${p + 1}` })));
    }
  }
  openSheet(R.book.title, body);
}

// ---------- Mở / đóng sách ----------

async function requestWake() {
  if (!S.keepAwake || !('wakeLock' in navigator) || $('reader').hidden) return;
  try { R.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWake() {
  if (R.wakeLock) { R.wakeLock.release().catch(() => {}); R.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });

async function openBook(id) {
  const book = await DB.get('books', id);
  const buf = await DB.get('files', id);
  if (!book || !buf) { toast('Không tìm thấy file sách.'); loadLibrary(); return; }

  document.body.classList.add('reading');
  $('library').hidden = true;
  $('reader').hidden = false;
  $('reader').classList.remove('chrome');
  $('loading').hidden = false;
  $('bookTitle').textContent = book.title;
  history.pushState({ reader: true }, '');

  const task = pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf) });
  task.onPassword = (update, reason) => {
    const again = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = prompt(again ? 'Sai mật khẩu, nhập lại:' : 'Sách có mật khẩu. Nhập mật khẩu:');
    if (pw === null) task.destroy();
    else update(pw);
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    $('loading').hidden = true;
    if (!(e && e.name === 'AbortException')) toast('Không mở được sách này.');
    closeReader();
    return;
  }

  clearCache();
  R.book = book;
  R.pdf = pdf;
  R.task = task;
  R.pageCount = pdf.numPages;
  R.outline = null;
  R.current = Math.max(0, Math.min(book.lastPage || 0, R.pageCount - 1));
  R.turns = 0;
  R.ghostIdx = -1;
  R.flashStart = -1;
  book.lastOpened = Date.now();
  if (!book.pageCount || book.locked) {
    book.pageCount = R.pageCount;
    if (!book.cover) { try { book.cover = await makeCover(pdf); } catch (e) {} }
  }
  DB.put('books', book).catch(() => {});
  $('loading').hidden = true;
  layout();
  updateBars();
  requestWake();
}

function closeReader(fromPop) {
  if ($('reader').hidden) return;
  cancelTurn();
  clearCache();
  if (R.task) { R.task.destroy(); R.task = null; }
  R.pdf = null;
  releaseWake();
  closeSheet();
  $('reader').hidden = true;
  $('library').hidden = false;
  document.body.classList.remove('reading');
  if (!fromPop && history.state && history.state.reader) history.back();
  loadLibrary();
}
window.addEventListener('popstate', () => closeReader(true));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (R.pdf) layout(); }, 120);
});

// ================= Cài đặt (giao diện) =================

function settingsChanged(needsRerender) {
  saveSettings();
  applyTheme();
  if (R.pdf) {
    if (needsRerender) clearCache();
    layout();
    requestWake();
  } else {
    renderGrid();
  }
}

function showSettings() {
  const body = el('div');
  const seg = (options, value, onPick) => {
    const box = el('div', { class: 'seg' });
    for (const [v, label] of options) {
      box.append(el('button', {
        class: v === value ? 'on' : '', text: label,
        onclick: () => { onPick(v); showSettings(); },
      }));
    }
    return box;
  };
  const check = (label, key, rerender) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!S[key];
    c.onchange = () => { S[key] = c.checked; settingsChanged(rerender); };
    return el('label', { class: 'row' }, el('span', { text: label }), c);
  };
  const slider = (label, min, max, stepv, get, set) => {
    const lab = el('div', { class: 'label', text: label(get()) });
    const r = el('input', { type: 'range', min, max, step: stepv });
    r.value = get();
    r.oninput = () => (lab.textContent = label(+r.value));
    r.onchange = () => { set(+r.value); settingsChanged(true); };
    return el('div', {}, lab, r);
  };

  body.append(el('div', { class: 'group-title', text: 'Màn hình' }));
  body.append(seg(Object.entries(MODES).map(([k, m]) => [k, m.title]), S.mode, (v) => { S.mode = v; settingsChanged(true); }));
  if (S.mode !== 'original') {
    body.append(slider((v) => `Độ tương phản: ${(+v).toFixed(2)}`, 0.8, 1.8, 0.05, () => S.contrast, (v) => (S.contrast = v)));
  }
  if (S.mode === 'ink') {
    body.append(el('div', { class: 'label', text: 'Số mức xám' }));
    body.append(seg([[4, '4 mức'], [16, '16 (Carta)'], [256, 'Mịn']], S.levels, (v) => { S.levels = v; settingsChanged(true); }));
    body.append(check('Hạt mịn (dither)', 'dither', true));
  }
  if (S.mode === 'ink' || S.mode === 'paper') body.append(check('Vân giấy', 'texture', true));
  body.append(slider((v) => `Cắt lề trang: ${Math.round(v * 100)}%`, 0, 0.15, 0.01, () => S.crop, (v) => (S.crop = v)));

  body.append(el('div', { class: 'group-title', text: 'Lật trang' }));
  body.append(seg(Object.entries(TURNS), S.turn, (v) => { S.turn = v; settingsChanged(false); }));
  if (S.turn === 'curl') body.append(check('Hai trang khi xoay ngang', 'twoUp', false));
  body.append(check('Chớp làm tươi (như e-ink)', 'flash', false));
  if (S.flash) {
    body.append(el('div', { class: 'label', text: 'Chớp sau mỗi' }));
    body.append(seg([[1, '1 trang'], [3, '3 trang'], [6, '6 trang']], S.flashEvery, (v) => { S.flashEvery = v; settingsChanged(false); }));
  }
  if (S.turn === 'instant') body.append(check('Bóng mờ trang cũ', 'ghosting', false));

  body.append(el('div', { class: 'group-title', text: 'Khác' }));
  body.append(check('Giữ màn hình luôn sáng khi đọc', 'keepAwake', false));
  body.append(el('p', { class: 'hint', text: 'Chạm mép trái/phải để lật, kéo góc trang hoặc vuốt. Chạm giữa trang để hiện thanh công cụ.' }));

  const keepScroll = $('sheet').hidden ? 0 : $('sheetBody').scrollTop;
  openSheet('Cài đặt đọc', body);
  $('sheetBody').scrollTop = keepScroll;
}

// ================= Khởi động =================

async function init() {
  applyTheme();
  try {
    await DB.open();
  } catch (e) {
    toast('Trình duyệt không cho lưu dữ liệu (chế độ riêng tư?).', 6000);
    return;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('installHint').hidden = !!standalone;
  await loadLibrary();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// cho trang thử nghiệm
window.__docsach = { R, S, importFiles, openBook, goTo, autoTurn, layout, draw, startDrag, settingsChanged };

init();
