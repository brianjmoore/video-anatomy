// Structure tab: box tree + detail pane (fields, layout bar, hex).
import { h, fmtBytes, renderFields, renderHex, fieldRange } from './ui.js';
import { BOX_DOCS, boxName } from './docs.js';

const CAT = {
  container: 'moov trak mdia minf stbl dinf edts udta mvex moof traf mfra tref sinf schi meta ilst wave gmhd tapt',
  table: 'stts ctts stss stsc stsz stz2 stco co64 sdtp trun tfhd tfdt elst sbgp sgpd sidx tfra cslg stps trex',
  codec: 'stsd avc1 avc3 hvc1 hev1 av01 vp09 mp4a mp4v avcC hvcC esds pasp colr btrt dOps Opus ac-3 ec-3 dac3 fLaC alac clap fiel',
  media: 'mdat',
  meta: 'data keys hdlr ftyp styp',
};
const catOf = t => { for (const [k, v] of Object.entries(CAT)) if (v.split(' ').includes(t)) return k; return t.startsWith('©') ? 'meta' : ''; };
const CAT_COLOR = { container: '#c9a0ff', table: '#ffd479', codec: '#7fdbff', media: '#ff9b85', meta: '#a8e6a1', '': '#9aa1ae' };

export class StructureView {
  constructor(app) {
    this.app = app;
    this.treeEl = document.getElementById('tree');
    this.detailEl = document.getElementById('detail');
    this.split = document.getElementById('structSplit');
    this.rows = new Map();
    this.open = new Set();
  }

  load(root) {
    this.root = root;
    this.open = new Set();
    // expand moov and its tracks by default
    const walk = (n, d) => { if (d < 2 || ['trak', 'mdia', 'minf', 'stbl', 'stsd'].includes(n.type)) this.open.add(n); for (const c of n.children || []) walk(c, d + 1); };
    for (const c of root.children) walk(c, 0);
    this.renderTree();
    const first = root.children.find(c => c.type === 'moov') || root.children[0];
    if (first) this.select(first, { noScroll: true, noShow: true });
  }

  renderTree() {
    this.treeEl.innerHTML = '';
    this.rows.clear();
    const frag = document.createDocumentFragment();
    const add = (n, d) => {
      const has = n.children && n.children.length;
      const row = h('div.node' + (n.error ? '.err' : ''), { style: { '--d': d } },
        h('span.tw', null, has ? (this.open.has(n) ? '▾' : '▸') : ''),
        h('span.ty.c-' + (catOf(n.type) || 'x'), null, n.type),
        h('span.nm', null, boxName(n.type)),
        h('span.sm', null, n.summary || n.error || ''),
        h('span.sz', null, fmtBytes(n.size)));
      row.addEventListener('click', (e) => {
        if (has && (e.target.classList.contains('tw') || this.sel === n)) { this.toggle(n); return; }
        this.select(n);
      });
      this.rows.set(n, row);
      frag.append(row);
      if (has && this.open.has(n)) {
        const kids = n.children;
        const max = 300;
        for (let i = 0; i < Math.min(kids.length, max); i++) add(kids[i], d + 1);
        if (kids.length > max) frag.append(h('div.node.dim', { style: { '--d': d + 1 } }, `… ${kids.length - max} more ${kids[max].type} boxes`));
      }
    };
    for (const c of this.root.children) add(c, 0);
    this.treeEl.append(frag);
    if (this.sel && this.rows.get(this.sel)) this.rows.get(this.sel).classList.add('sel');
  }

  toggle(n) { if (this.open.has(n)) this.open.delete(n); else this.open.add(n); this.renderTree(); }

  // Select a box (optionally reveal it in the tree).
  select(n, { noScroll, noShow } = {}) {
    this.sel = n;
    for (let p = n.parent; p && !p.isRoot; p = p.parent) this.open.add(p);
    this.renderTree();
    const row = this.rows.get(n);
    if (row && !noScroll) row.scrollIntoView({ block: 'nearest' });
    this.renderDetail(n);
    if (!noShow) this.split.classList.add('show-detail');
  }

  findByPath(path) {
    let cur = this.root;
    for (const t of path.split('/')) { cur = cur && cur.children.find(c => c.type === t); }
    return cur;
  }

  renderDetail(n) {
    const app = this.app;
    const d = this.detailEl;
    d.innerHTML = '';
    d.parentElement.scrollTop = 0;
    const doc = BOX_DOCS[n.type];
    const crumbs = [];
    for (let p = n; p && !p.isRoot; p = p.parent) crumbs.unshift(p);
    const head = h('div.dhead', null,
      h('button.back-btn.chip', { onclick: () => this.split.classList.remove('show-detail'), style: { marginBottom: '6px' } }, '← Boxes'),
      h('h2', null, h('code', null, n.type), h('span', null, doc ? doc[0] : 'Unknown box')),
      h('div.crumbs', null, crumbs.map((c, i) => [i ? ' › ' : '', h('a', { href: '#', onclick: e => { e.preventDefault(); this.select(c); } }, c.type)])));
    d.append(head);
    if (doc && doc[1]) d.append(h('div.doc', null, doc[1]));
    else if (!doc) d.append(h('div.doc.dim', null, 'This box type isn’t in the built-in glossary. Its raw bytes are shown below.'));
    if (n.error) d.append(h('div.doc', { style: { color: 'var(--I)' } }, n.error));

    d.append(h('div.card', null, h('div.kv', null,
      'Offset', `${n.start.toLocaleString()} (0x${n.start.toString(16)})`,
      'Size', `${n.size.toLocaleString()} bytes (${fmtBytes(n.size)})`,
      'Header', `${n.hdr} bytes: 4-byte size + 4-byte type${n.hdr >= 16 ? (n.hdr === 16 || n.hdr === 32 ? ' + 8-byte large size' : '') : ''}${n.type === 'uuid' ? ' + 16-byte UUID' : ''}`,
      n.children.length ? 'Children' : null, n.children.length ? `${n.children.length} box${n.children.length > 1 ? 'es' : ''}` : null)));

    // layout bar: header, own fields, children
    if (n.size > 0) {
      const bar = h('div.lbar');
      const total = n.size;
      const seg = (len, color, label, onclick, title) => {
        if (len <= 0) return;
        bar.append(h('div', { style: { flex: `${Math.max(len / total, 0.015)} 0 0`, background: color }, onclick, title: title || label }, len / total > 0.08 ? label : ''));
      };
      seg(n.hdr, '#6d5a99', 'header', null, `header (${n.hdr} B)`);
      const childStart = n.children.length ? n.children[0].start : n.start + n.size;
      seg(childStart - n.start - n.hdr, '#5c6577', 'fields', null, `fields (${childStart - n.start - n.hdr} B)`);
      for (const c of n.children) seg(c.size, CAT_COLOR[catOf(c.type)], c.type, () => this.select(c), `${c.type} (${fmtBytes(c.size)})`);
      d.append(h('div.layout', null, bar, h('div.dim.small', { style: { marginTop: '3px' } }, n.children.length ? 'Tap a segment to open that child box.' : '')));
    }

    // context actions
    const acts = h('div.row', { style: { margin: '0 12px' } });
    const tr = app.trackForBox(n);
    if (n.type === 'mdat' && app.tracks.some(t => t.type === 'video')) acts.append(h('button.chip', { onclick: () => app.show('video') }, 'See the frames stored here →'));
    if (tr && tr.type === 'video' && ['stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'avcC', 'hvcC', 'trun'].includes(n.type)) acts.append(h('button.chip', { onclick: () => app.show('video', { track: tr }) }, 'See this track’s frames →'));
    if (tr && tr.type === 'audio' && ['stts', 'stsz', 'esds', 'mp4a', 'stco', 'stsc'].includes(n.type)) acts.append(h('button.chip', { onclick: () => app.show('audio', { track: tr }) }, 'See this track’s audio frames →'));
    if (acts.childNodes.length) d.append(acts);

    // fields
    const hexEl = h('div.hex');
    let hl = null;
    const updateHex = async (range) => {
      hl = range;
      const target = await renderHex(hexEl, app.readBytes, { start: n.start, end: n.start + n.size, hdrEnd: n.start + n.hdr, hl: range });
      if (target && range) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    if (n.fields && n.fields.length) {
      const fc = h('div.card', null, h('h3', null, 'Fields'), h('div.dim.small', { style: { marginBottom: '6px' } }, 'Tap a field for an explanation, its exact bits, and to highlight it in the hex below.'));
      const fl = h('div.fields');
      renderFields(fl, n.fields, n.src, { onSelect: (f, range) => updateHex(range), expandDepth: 2 });
      fc.append(fl);
      d.append(fc);
    }
    d.append(h('div.card', null, h('h3', null, 'Bytes'), hexEl));
    updateHex(hl);
  }
}
void fieldRange;
