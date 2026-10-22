// Small DOM helpers + field tree renderer + hex view, shared by all views.
import { FIELD_DOCS, KIND_DOCS } from './docs.js';
import { hexFmt } from './bits.js';

export function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  // In key/value grids every cell must be its own element to be a grid item.
  const kv = el.classList.contains('kv');
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    const node = k instanceof Node ? k : document.createTextNode(String(k));
    if (kv) { const cell = document.createElement('span'); cell.append(node); el.append(cell); } else el.append(node);
  }
  return el;
}

export const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastT;
export function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

export function fmtValue(f) {
  if (f.fmt) { try { return String(f.fmt(f.v)); } catch { /* fall through */ } }
  const v = f.v;
  if (v instanceof Uint8Array) return hexFmt(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  return v == null ? '' : String(v);
}

const docKey = n => n.replace(/\[.*?\]/g, '').replace(/ \(.*\)$/, '').trim();
export const fieldDoc = f => FIELD_DOCS[f.name] || FIELD_DOCS[docKey(f.name)] || '';

// File byte range of a field given its Bits source.
export function fieldRange(f, src) {
  if (!src || f.l === 0 && f.kind !== 'table') return null;
  const s = f.s, e = f.s + Math.max(f.l, 1) - 1;
  return { start: src.fileOffset(s >> 3), end: src.fileOffset(e >> 3) + 1, bitStart: s, bitLen: f.l, src };
}

function bitString(src, s, l) {
  let out = '';
  for (let i = 0; i < l; i++) { const p = s + i; out += (src.b[p >> 3] >> (7 - (p & 7))) & 1; }
  return out;
}

// Explanation panel for one field (bits, coding, doc).
function explain(f, src) {
  const box = h('div.fexp');
  const doc = fieldDoc(f);
  if (doc) box.append(h('div', null, doc));
  if (f.note) box.append(h('div.dim', { style: { marginTop: '4px' } }, f.note));
  if (f.kind === 'derived') box.append(h('div.dim.small', { style: { marginTop: '4px' } }, 'Derived: computed from other fields rather than stored in the file.'));
  if (src && f.l > 0 && f.kind !== 'group' && f.kind !== 'table') {
    const off = src.fileOffset(f.s >> 3);
    box.append(h('div.small.dim', { style: { marginTop: '6px' } },
      `${f.kind || ''} · ${f.l} bit${f.l > 1 ? 's' : ''} at file offset ${off.toLocaleString()} (0x${off.toString(16)})` + ((f.s & 7) || (f.l & 7) ? `, bit ${f.s & 7}` : '')));
    if (f.l <= 96 && src.b && src.b.length) {
      // show the bytes that contain the field, highlighting the field's bits
      const b0 = f.s >> 3, b1 = (f.s + f.l - 1) >> 3;
      const view = h('div.bitsview');
      const bits = bitString(src, b0 * 8, (b1 - b0 + 1) * 8);
      const rel = f.s - b0 * 8;
      let lz = 0;
      if (f.kind === 'ue(v)' || f.kind === 'se(v)') { while (bits[rel + lz] === '0') lz++; }
      for (let i = 0; i < bits.length; i++) {
        if (i && i % 8 === 0) view.append(h('span.sep', null, ' '));
        const inField = i >= rel && i < rel + f.l;
        const cls = !inField ? '' : (i < rel + lz ? 'lz' : 'on');
        view.append(h(cls ? 'span.' + cls : 'span', null, bits[i]));
      }
      box.append(view);
      const fb = bits.slice(rel, rel + f.l);
      if (f.kind === 'ue(v)' || f.kind === 'se(v)') {
        const suffix = fb.slice(lz + 1);
        const k = 2 ** lz - 1 + (suffix ? parseInt(suffix, 2) : 0);
        box.append(h('div.small', null,
          `${lz} leading zero${lz === 1 ? '' : 's'} (red), a 1, then ${lz} bit${lz === 1 ? '' : 's'} “${suffix}” → 2^${lz} − 1 + ${suffix ? parseInt(suffix, 2) : 0} = ${k}` +
          (f.kind === 'se(v)' ? ` → signed mapping gives ${f.v}` : '')));
      } else if (f.l > 1 && f.l <= 53 && typeof f.v === 'number' && Number.isInteger(f.v)) {
        box.append(h('div.small', null, `binary ${fb} = ${parseInt(fb, 2)}${f.l % 4 === 0 ? ` = 0x${parseInt(fb, 2).toString(16).toUpperCase()}` : ''}`));
      }
    }
    const kd = KIND_DOCS[f.kind];
    if (kd) box.append(h('div.small.dim', { style: { marginTop: '4px' } }, kd(f)));
  }
  return box;
}

// Render a syntax tree. opts: { onSelect(field, range), expandDepth }
export function renderFields(el, fields, src, opts = {}, depth = 0) {
  const expandDepth = opts.expandDepth ?? 1;
  for (const f of fields) {
    const fsrc = f.src || src;
    if (f.kind === 'group') {
      const row = h('div.f.grp', { style: { '--d': depth } }, h('span.fn', null, '▾ ' + f.name), h('span.fv', null, f.l ? `${Math.ceil(f.l / 8)} bytes` : ''));
      const kids = h('div');
      const open = depth < expandDepth || f.children.length <= 6;
      if (!open) { kids.hidden = true; row.firstChild.textContent = '▸ ' + f.name; }
      let rendered = false;
      const render = () => { if (!rendered) { renderFields(kids, f.children, fsrc, opts, depth + 1); rendered = true; } };
      if (open) render();
      row.addEventListener('click', () => {
        render();
        kids.hidden = !kids.hidden;
        row.firstChild.textContent = (kids.hidden ? '▸ ' : '▾ ') + f.name;
        opts.onSelect && opts.onSelect(f, fieldRange(f, src), row);
      });
      el.append(row, kids);
      continue;
    }
    if (f.kind === 'table') { el.append(renderTable(f, src, opts, depth)); continue; }
    const cls = 'div.f' + (f.kind === 'derived' ? '.derived' : '') + (f.kind === 'error' ? '.error' : '');
    const row = h(cls, { style: { '--d': depth } }, h('span.fn', null, f.name.replace(/_/g, '_\u200b')), h('span.fv', null, fmtValue(f)));
    if (f.note && f.kind === 'derived') row.append(h('span.note', null, f.note));
    let exp = null;
    row.addEventListener('click', () => {
      const wasOpen = exp && exp.isConnected;
      el.querySelectorAll('.fexp').forEach(e => e.remove());
      document.querySelectorAll('.f.sel').forEach(e => e.classList.remove('sel'));
      if (!wasOpen) { exp = explain(f, src); exp.style.setProperty('--d', depth); row.after(exp); row.classList.add('sel'); }
      opts.onSelect && opts.onSelect(f, fieldRange(f, src), row);
    });
    el.append(row);
  }
  return el;
}

function renderTable(f, src, opts, depth) {
  const t = f.table;
  const wrap = h('div', { style: { '--d': depth } });
  wrap.append(h('div.f.grp', { style: { '--d': depth } }, h('span.fn', null, f.name.replace(/_/g, '_\u200b')), h('span.fv', null, `${t.rowCount.toLocaleString()} rows`)));
  if (!t.rowCount) return wrap;
  const tw = h('div.tblwrap');
  const tbl = h('table.tbl');
  tbl.append(h('tr', null, h('th', null, '#'), t.cols.map(c => h('th', null, c))));
  let shown = 0;
  const more = h('button.chip', { style: { margin: '4px 8px' } });
  const add = (n) => {
    const end = Math.min(t.rowCount, shown + n);
    const frag = document.createDocumentFragment();
    for (let i = shown; i < end; i++) {
      const r = t.row(i);
      const tr = h('tr', null, h('td', null, i + 1), r.map(v => h('td', null, Number.isInteger(v) ? v.toLocaleString() : v)));
      tr.addEventListener('click', () => {
        tbl.querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel')); tr.classList.add('sel');
        if (f.rowBits && src) {
          const s = f.s + i * f.rowBits;
          opts.onSelect && opts.onSelect({ ...f, name: `${f.name}[${i}]` }, { start: src.fileOffset(s >> 3), end: src.fileOffset((s + f.rowBits - 1) >> 3) + 1, src }, tr);
        }
      });
      frag.append(tr);
    }
    tbl.append(frag);
    shown = end;
    more.textContent = shown < t.rowCount ? `Show more (${(t.rowCount - shown).toLocaleString()} left)` : '';
    more.hidden = shown >= t.rowCount;
  };
  more.addEventListener('click', () => add(500));
  add(100);
  tw.append(tbl);
  wrap.append(tw, more);
  return wrap;
}

// ---------------------------------------------------------------------------
// Hex view. opts: { start, end (file range to show), hl: {start,end}, hdrEnd, epb: [offsets] }
export async function renderHex(el, readBytes, opts) {
  const cols = el.clientWidth && el.clientWidth < 560 ? 8 : 16;
  const MAXB = 2048;
  let a = opts.start, b = opts.end;
  if (opts.hl && (opts.hl.start >= a + MAXB || b - a > MAXB)) {
    a = Math.max(opts.start, Math.floor((opts.hl.start - 256) / cols) * cols);
  }
  a = Math.max(opts.start, a);
  const len = Math.min(b - a, MAXB);
  const bytes = await readBytes(a, len);
  el.innerHTML = '';
  const hl = opts.hl, epb = new Set(opts.epb || []);
  const base = Math.floor(a / cols) * cols;
  const frag = document.createDocumentFragment();
  let firstHl = null;
  for (let row = base; row < a + bytes.length; row += cols) {
    const hb = h('span.hb'), ha = h('span.ha');
    for (let c = 0; c < cols; c++) {
      const o = row + c, i = o - a;
      if (i < 0 || i >= bytes.length) { hb.append(h('span', null, '  ')); ha.append(h('span', null, ' ')); continue; }
      const v = bytes[i];
      let cls = '';
      if (hl && o >= hl.start && o < hl.end) cls = 'h';
      else if (opts.hdrEnd && o < opts.hdrEnd) cls = 'hdr';
      if (epb.has(o)) cls += ' epb';
      const sb = h('span', cls ? { class: cls.trim() } : null, v.toString(16).padStart(2, '0'));
      const sa = h('span', cls === 'h' ? { class: 'h' } : null, v >= 32 && v < 127 ? String.fromCharCode(v) : '·');
      hb.append(sb); ha.append(sa);
      if (cls === 'h' && !firstHl) firstHl = sb;
    }
    frag.append(h('div.hr', null, h('span.ho', null, row.toString(16).padStart(8, '0')), hb, ha));
  }
  el.append(frag);
  if (b - a > MAXB) el.append(h('div.dim.small', { style: { padding: '4px 0' } }, `Showing ${MAXB.toLocaleString()} of ${(b - opts.start).toLocaleString()} bytes from offset 0x${a.toString(16)}. Select a field to jump to it.`));
  return firstHl;
}
