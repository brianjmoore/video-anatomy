// Picture view with macroblock overlays (grid, types, bits, motion vectors, QP).
import { h } from './ui.js';
import { parseSliceData, motionOf } from './h264mb.js';

const CAT_COLORS = {
  intra: [255, 90, 70], skip: [140, 140, 140], P: [70, 150, 255], B: [190, 110, 255], L0: [70, 150, 255], L1: [255, 160, 60], Bi: [190, 110, 255], direct: [70, 210, 140],
};
const OVERLAYS = [
  ['grid', 'Grid'], ['types', 'Block types'], ['mvs', 'Motion'], ['bits', 'Bits'], ['qp', 'QP'],
];

export class MbView {
  constructor(card, vv, i) {
    this.card = card; this.vv = vv; this.i = i;
    this.track = vv.track;
    this.cfg = this.track.config;
    this.sps = this.cfg && this.cfg.sps && this.cfg.sps[0];
    this.isHevc = this.cfg && this.cfg.codec === 'hevc';
    this.blk = this.isHevc ? (1 << this.sps.log2_ctb) : 16;
    this.zoom = vv.picZoom || 'fit';
    this.on = vv.overlays || (vv.overlays = new Set(['grid']));
    this.status = h('div.dim.small');
    this.toolbar = h('div.toolbar');
    this.wrap = h('div.picwrap');
    this.pic = h('canvas');
    this.ovl = h('canvas.ovl');
    this.wrap.append(this.pic, this.ovl);
    this.legend = h('div.legend', { style: { margin: '6px 0' } });
    this.info = h('div.mbinfo');
    card.append(this.toolbar, this.wrap, this.legend, this.status, this.info);
    this.buildToolbar();
    this.wrap.addEventListener('click', e => this.tap(e));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.wrap);
  }

  buildToolbar() {
    const tb = this.toolbar;
    tb.innerHTML = '';
    for (const z of ['fit', 1, 2, 4]) {
      tb.append(h('button.chip' + (this.zoom === z ? '.on' : ''), { onclick: () => { this.zoom = this.vv.picZoom = z; this.buildToolbar(); this.layout(); } }, z === 'fit' ? 'Fit' : z + '×'));
    }
    tb.append(h('span.sep'));
    for (const [k, label] of OVERLAYS) {
      const needsMb = k !== 'grid';
      const dis = needsMb && !this.mb;
      tb.append(h('button.chip' + (this.on.has(k) && !dis ? '.on' : ''), {
        disabled: dis, title: dis ? (this.isHevc ? 'Block-level decoding is available for H.264 only' : 'Waiting for macroblock analysis') : '',
        onclick: () => { if (this.on.has(k)) this.on.delete(k); else { if (['types', 'bits', 'qp'].includes(k)) ['types', 'bits', 'qp'].forEach(x => this.on.delete(x)); this.on.add(k); } this.buildToolbar(); this.drawOverlay(); },
      }, label));
    }
  }

  async load() {
    const i = this.i;
    if (!this.vv.dec || this.vv.decMode === 'none') { this.status.textContent = 'This browser can’t decode this codec, so the picture isn’t shown. Block analysis still works for H.264.'; this.placeholder(); return; }
    this.status.textContent = this.vv.decMode === 'webcodecs' ? 'Decoding (from the previous keyframe)…' : 'Seeking…';
    try {
      const t0 = performance.now();
      const bmp = await this.vv.dec.get(i);
      if (this.vv.sel !== i) return;
      this.bmp = bmp;
      this.pic.width = bmp.width; this.pic.height = bmp.height;
      this.pic.getContext('2d').drawImage(bmp, 0, 0);
      const ms = performance.now() - t0;
      this.status.textContent = this.vv.decMode === 'webcodecs'
        ? `Decoded with WebCodecs${ms > 30 ? ` in ${ms.toFixed(0)} ms` : ' (cached)'}. To show a P or B frame, the decoder must first decode the keyframe and every frame it depends on.`
        : 'Shown by seeking a <video> element (WebCodecs isn’t available for this codec here).';
      this.layout();
    } catch (e) {
      this.status.textContent = 'Could not decode this frame: ' + (e.message || e);
      this.placeholder();
    }
  }

  placeholder() {
    if (!this.sps) return;
    this.pic.width = this.sps.width; this.pic.height = this.sps.height;
    const c = this.pic.getContext('2d'); c.fillStyle = '#15171c'; c.fillRect(0, 0, this.pic.width, this.pic.height);
    this.layout();
  }

  // Called by VideoView once slice NAL units for this frame are parsed.
  async slicesReady(slices, state) {
    this.slices = slices; this.state = state;
    if (this.isHevc || !this.sps) {
      this.legend.innerHTML = '';
      if (this.isHevc) this.legend.append(h('span', null, `Grid shows ${this.blk}×${this.blk} Coding Tree Units (CTUs). Each CTU is recursively split into coding units as small as ${1 << this.sps.log2_min_cb}×${1 << this.sps.log2_min_cb}. Block-level decoding is implemented for H.264 only.`));
      return;
    }
    if (!slices.length) return;
    this.status2 = h('div.dim.small', null, 'Parsing macroblocks…');
    this.info.append(this.status2);
    const t0 = performance.now();
    try {
      this.mb = await parseSliceData(slices, state, this.vv.A.frames, this.i, { getMotion: j => this.vv.getMotion(j) });
      this.mb.ms = performance.now() - t0;
      this.vv.rememberMotion(this.i, Promise.resolve(motionOf(this.mb, this.vv.A.frames[this.i].refs || [[], []])));
    } catch (e) {
      this.mb = null;
      this.info.innerHTML = '';
      this.info.append(h('div.small', { style: { color: 'var(--I)' } }, 'Macroblock analysis unavailable: ' + e.message));
      return;
    }
    if (this.vv.sel !== this.i) return;
    if (this.on.size === 1 && this.on.has('grid') && !this.vv.overlaysTouched) { this.on.add('types'); this.vv.overlaysTouched = true; }
    this.buildToolbar();
    this.drawOverlay();
    this.showSummary();
  }

  showSummary() {
    const mb = this.mb;
    if (!mb) return;
    const c = mb.counts;
    const tot = mb.mbW * mb.mbH;
    const pct = n => (100 * n / tot).toFixed(0) + '%';
    this.info.innerHTML = '';
    const rows = [];
    for (const [k, label] of [['intra', 'intra'], ['P', 'inter (P)'], ['B', 'inter (B)'], ['direct', 'direct'], ['skip', 'skipped']]) if (c[k]) rows.push(`${pct(c[k])} ${label}`);
    this.info.append(h('div.small', { style: { margin: '6px 0' } },
      h('strong', null, `${tot.toLocaleString()} macroblocks: `), rows.join(' · '),
      mb.error ? h('div', { style: { color: 'var(--I)' } }, `Stopped at macroblock ${mb.decoded}: ${mb.error}`) : null,
      h('div.dim', null, `Parsed ${mb.decoded.toLocaleString()} macroblocks with ${mb.entropy} in ${mb.ms.toFixed(0)} ms. Tap the picture to inspect one.`)));
  }

  layout() {
    const W = this.pic.width, H = this.pic.height;
    if (!W) return;
    const avail = this.wrap.clientWidth || 300;
    const scale = this.zoom === 'fit' ? avail / W : this.zoom;
    this.scale = scale;
    this.pic.style.width = W * scale + 'px'; this.pic.style.height = H * scale + 'px';
    const dpr = window.devicePixelRatio || 1;
    const ow = Math.min(W * scale, 8192 / dpr), oh = Math.min(H * scale, 8192 / dpr);
    this.ovl.width = ow * dpr; this.ovl.height = oh * dpr;
    this.ovl.style.width = ow + 'px'; this.ovl.style.height = oh + 'px';
    this.drawOverlay();
  }

  drawOverlay() {
    const c = this.ovl.getContext('2d');
    const dpr = window.devicePixelRatio || 1, s = this.scale || 1;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.ovl.width, this.ovl.height);
    if (!this.sps) return;
    const B = this.blk, cropL = (this.sps.crop && this.sps.crop.left) || 0, cropT = (this.sps.crop && this.sps.crop.top) || 0;
    const mbW = Math.ceil(this.sps.codedWidth / B), mbH = Math.ceil(this.sps.codedHeight / B);
    const X = x => (x * B - cropL) * s, Y = y => (y * B - cropT) * s;
    const mb = this.mb;
    this.legend.innerHTML = '';
    const leg = (color, text) => this.legend.append(h('span', null, h('span.sw', { style: { background: color } }), text));
    if (mb && (this.on.has('types') || this.on.has('bits') || this.on.has('qp'))) {
      let maxBits = 1, minQ = 99, maxQ = 0;
      for (const m of mb.mbs) if (m) { maxBits = Math.max(maxBits, m.bits); minQ = Math.min(minQ, m.qp); maxQ = Math.max(maxQ, m.qp); }
      for (const m of mb.mbs) {
        if (!m) continue;
        let rgba;
        if (this.on.has('types')) {
          const k = m.cat === 'P' || m.cat === 'B' ? (m.parts && m.parts[0] ? m.parts[0].pred : m.cat) : m.cat;
          const col = CAT_COLORS[k] || CAT_COLORS.B;
          rgba = m.cat === 'skip' ? null : `rgba(${col[0]},${col[1]},${col[2]},0.42)`;
          if (m.cat === 'B' && m.parts) {
            // colour each partition by its prediction direction
            for (const p of m.parts) {
              const pc = CAT_COLORS[p.pred] || CAT_COLORS.B;
              c.fillStyle = `rgba(${pc[0]},${pc[1]},${pc[2]},0.42)`;
              c.fillRect(X(m.x) + p.x * s, Y(m.y) + p.y * s, p.w * s, p.h * s);
            }
            rgba = null;
          }
        } else if (this.on.has('bits')) {
          const t = Math.log1p(m.bits) / Math.log1p(maxBits);
          rgba = heat(t, 0.6);
        } else {
          const t = maxQ > minQ ? (m.qp - minQ) / (maxQ - minQ) : 0.5;
          rgba = heat(1 - t, 0.5);
        }
        if (rgba) { c.fillStyle = rgba; c.fillRect(X(m.x), Y(m.y), B * s, B * s); }
        // partition outlines
        if (this.on.has('types') && m.parts && m.parts.length > 1 && s * B >= 12) {
          c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1;
          for (const p of m.parts) c.strokeRect(X(m.x) + p.x * s + .5, Y(m.y) + p.y * s + .5, p.w * s - 1, p.h * s - 1);
        }
        if (this.on.has('types') && m.intraParts && s * B >= 24) {
          c.strokeStyle = 'rgba(255,255,255,.4)'; c.lineWidth = 1;
          const n = m.intraParts;
          for (let k = 1; k < 16 / n; k++) {
            c.beginPath(); c.moveTo(X(m.x) + k * n * s, Y(m.y)); c.lineTo(X(m.x) + k * n * s, Y(m.y) + 16 * s);
            c.moveTo(X(m.x), Y(m.y) + k * n * s); c.lineTo(X(m.x) + 16 * s, Y(m.y) + k * n * s); c.stroke();
          }
        }
        if (this.on.has('qp') && s * B >= 22) {
          c.fillStyle = '#fff'; c.font = `${Math.min(12, s * B / 2.2)}px ui-monospace, monospace`; c.textAlign = 'center';
          c.fillText(m.qp, X(m.x) + B * s / 2, Y(m.y) + B * s / 2 + 4);
        }
      }
      if (this.on.has('types')) {
        leg('rgba(255,90,70,.8)', 'intra'); leg('rgba(70,150,255,.8)', 'from list 0 (usually past)'); leg('rgba(255,160,60,.8)', 'from list 1 (usually future)');
        leg('rgba(190,110,255,.8)', 'bi-predicted (average of two)'); leg('rgba(70,210,140,.8)', 'direct (motion inferred)'); leg('rgba(140,140,140,.6)', 'skip (copied, no data)');
      } else if (this.on.has('bits')) { leg(heat(0, 1), 'few bits'); leg(heat(1, 1), `many bits (max ${maxBits})`); }
      else { leg(heat(1, 1), `low QP ${minQ} (fine)`); leg(heat(0, 1), `high QP ${maxQ} (coarse)`); }
    }
    if (this.on.has('grid')) {
      c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 1;
      c.beginPath();
      for (let x = 0; x <= mbW; x++) { const px = Math.round(X(x)) + .5; c.moveTo(px, 0); c.lineTo(px, Y(mbH)); }
      for (let y = 0; y <= mbH; y++) { const py = Math.round(Y(y)) + .5; c.moveTo(0, py); c.lineTo(X(mbW), py); }
      c.stroke();
      if (mb && mb.sliceStarts.length > 1) {
        c.strokeStyle = '#ffbf3c'; c.lineWidth = 2;
        for (const a of mb.sliceStarts.slice(1)) { const x = a % mbW, y = Math.floor(a / mbW); c.beginPath(); c.moveTo(X(x), Y(y)); c.lineTo(X(x), Y(y + 1)); c.lineTo(X(mbW), Y(y + 1)); c.moveTo(X(0), Y(y + 1)); c.stroke(); }
      }
      if (!mb && !this.isHevc) this.legend.append(h('span', null, 'Grid = 16×16 macroblocks, the units H.264 predicts and codes.'));
    }
    if (mb && this.on.has('mvs')) {
      c.lineWidth = 1.2;
      for (const m of mb.mbs) {
        if (!m || !m.parts) continue;
        for (const p of m.parts) {
          for (let l = 0; l < 2; l++) {
            const mv = p.mv && p.mv[l];
            if (!mv) continue;
            const cx = X(m.x) + (p.x + p.w / 2) * s, cy = Y(m.y) + (p.y + p.h / 2) * s;
            const dx = mv[0] / 4 * s, dy = mv[1] / 4 * s;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue; // static blocks: nothing to draw
            arrow(c, cx, cy, cx + dx, cy + dy, l ? '#ffa94d' : '#7fc1ff');
          }
        }
      }
      leg('#7fc1ff', 'motion vector, list 0'); leg('#ffa94d', 'list 1');
      this.legend.append(h('span.dim', null, 'Arrows point to where each block’s content is taken from in the reference picture.'));
    }
    if (this.selMb) {
      const [x, y] = this.selMb;
      c.strokeStyle = '#ffbf3c'; c.lineWidth = 2; c.strokeRect(X(x) + 1, Y(y) + 1, B * s - 2, B * s - 2);
    }
  }

  tap(e) {
    if (!this.sps || !this.scale) return;
    const r = this.pic.getBoundingClientRect();
    const px = (e.clientX - r.left) / this.scale + ((this.sps.crop && this.sps.crop.left) || 0);
    const py = (e.clientY - r.top) / this.scale + ((this.sps.crop && this.sps.crop.top) || 0);
    const x = Math.floor(px / this.blk), y = Math.floor(py / this.blk);
    this.selMb = [x, y];
    this.drawOverlay();
    this.showMb(x, y);
  }

  async showMb(x, y) {
    const mbW0 = Math.ceil(this.sps.codedWidth / this.blk);
    const a0 = y * mbW0 + x;
    if (this.mb && this.mb.mbs[a0] && !this.mb.mbs[a0].syntax && this.slices) {
      // re-parse with a syntax trace for just this macroblock
      try {
        const t = await parseSliceData(this.slices, this.state, this.vv.A.frames, this.i, { getMotion: j => this.vv.getMotion(j), traceAddr: a0 });
        if (t.mbs[a0]) { this.mb.mbs[a0].syntax = t.mbs[a0].syntax || []; this.mb.mbs[a0].blocks = t.mbs[a0].blocks || []; }
      } catch { /* ignore */ }
      if (!this.selMb || this.selMb[0] !== x || this.selMb[1] !== y) return;
    }
    this.info.innerHTML = '';
    this.showSummary();
    const unit = this.isHevc ? 'CTU' : 'Macroblock';
    const mbW = Math.ceil(this.sps.codedWidth / this.blk);
    const addr = y * mbW + x;
    const card = h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '6px' } });
    card.append(h('div', null, h('strong', null, `${unit} ${addr}`), h('span.dim', null, ` at column ${x}, row ${y} (pixels ${x * this.blk}–${x * this.blk + this.blk - 1}, ${y * this.blk}–${y * this.blk + this.blk - 1})`)));
    // zoomed crop of the block
    if (this.bmp) {
      const zc = h('canvas', { style: { width: '128px', height: '128px', imageRendering: 'pixelated', border: '1px solid var(--line)', borderRadius: '4px', float: 'right', marginLeft: '8px' } });
      zc.width = this.blk; zc.height = this.blk;
      zc.getContext('2d').drawImage(this.bmp, x * this.blk - ((this.sps.crop && this.sps.crop.left) || 0), y * this.blk - ((this.sps.crop && this.sps.crop.top) || 0), this.blk, this.blk, 0, 0, this.blk, this.blk);
      card.append(zc);
    }
    const m = this.mb && this.mb.mbs[addr];
    if (m) {
      const kv = [];
      kv.push('Type', h('span', null, h('code', null, m.name), ' ', m.desc));
      if (m.parts && m.parts.length) {
        const list = h('div');
        // identical direct/skip partitions read better as one 16x16 entry
        const same = m.parts.length > 1 && m.parts.every(p => JSON.stringify([p.ref, p.mv]) === JSON.stringify([m.parts[0].ref, m.parts[0].mv]));
        const shown = same ? [{ ...m.parts[0], x: 0, y: 0, w: 16, h: 16 }] : m.parts;
        for (const p of shown) {
          const refs = [0, 1].filter(l => p.mv && p.mv[l]).map(l => {
            const ri = p.ref[l];
            const list = this.vv.A.frames[this.i].refs;
            const target = list && list[l] ? list[l][ri] : null;
            const T = this.track.samples;
            return `L${l}[${ri}]${target != null ? ` = frame ${T.presRank[target] + 1}` : ''} mv (${(p.mv[l][0] / 4).toFixed(2)}, ${(p.mv[l][1] / 4).toFixed(2)}) px` + (p.mvd && p.mvd[l] ? `, coded as mvd (${p.mvd[l][0]}, ${p.mvd[l][1]})/4` : p.inferred ? ' (inferred)' : '');
          });
          list.append(h('div.small', null, `${p.w}×${p.h} at (${p.x},${p.y}): `, refs.join('; ') || p.pred));
        }
        kv.push('Partitions', list);
      }
      if (m.intraModes) kv.push('Intra modes', h('span.small', null, m.intraModes));
      kv.push('QP', `${m.qp}${m.qpDelta ? ` (mb_qp_delta ${m.qpDelta > 0 ? '+' : ''}${m.qpDelta})` : ''}`);
      if (m.cbp != null) kv.push('Coded block pattern', `${m.cbp} ${cbpText(m.cbp)}`);
      if (m.t8x8) kv.push('Transform', '8×8');
      kv.push('Bits', m.bits ? `${m.bits} bits (${(m.bits / 8).toFixed(1)} bytes) of slice data` : 'under 1 bit: just a skip flag (CABAC can code a very likely decision in a fraction of a bit)');
      card.append(h('div.kv.small', { style: { marginTop: '6px' } }, kv));
      if (m.syntax && m.syntax.length) {
        card.append(h('div.dim.small', { style: { marginTop: '8px', clear: 'both' } }, `How this macroblock was coded (${this.mb.entropy}), in bitstream order:`));
        card.append(h('pre.small.mono', { style: { whiteSpace: 'pre-wrap', margin: '4px 0', color: '#c8ccd5', fontSize: '11.5px' } }, m.syntax.join('\n')));
      }
      if (m.blocks && m.blocks.some(b => b.count)) {
        card.append(h('div.dim.small', { style: { marginTop: '8px' } },
          'Quantized transform coefficients (the residual). Top-left is the average (DC); further right/down are finer horizontal/vertical detail. Most are zero, which is why they compress so well.'));
        const wrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' } });
        for (const b of m.blocks) {
          if (!b.count) continue;
          const n = b.size;
          const t = h('table.tbl', { style: { width: 'auto', fontSize: n === 8 ? '9.5px' : '11px' } });
          for (let r = 0; r < n; r++) t.append(h('tr', null, Array.from({ length: n }, (_, c) => {
            const v = b.raster[r * n + c];
            return h('td', { style: { padding: '1px 4px', color: v ? (v > 0 ? '#ffd479' : '#7fc1ff') : '#444', textAlign: 'center' } }, v);
          })));
          wrap.append(h('div', null, h('div.small.dim', null, b.label), t));
        }
        card.append(wrap);
      }
    } else if (!this.isHevc && this.mb) {
      card.append(h('div.dim', null, 'Not decoded (outside the analysed slices).'));
    }
    this.info.append(card);
  }
}

function cbpText(cbp) {
  const l = cbp & 15, c = cbp >> 4;
  const ls = [0, 1, 2, 3].filter(k => (l >> k) & 1);
  return `(${ls.length ? `luma 8×8 blocks ${ls.join(',')} have residual` : 'no luma residual'}; ${['no chroma residual', 'chroma DC only', 'chroma DC+AC'][c]})`;
}

function heat(t, a) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[30, 40, 140], [40, 170, 200], [250, 220, 60], [255, 70, 40]];
  const x = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
  const c = stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

function arrow(c, x1, y1, x2, y2, color) {
  c.strokeStyle = color; c.fillStyle = color;
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  const a = Math.atan2(y2 - y1, x2 - x1), L = 4;
  c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - L * Math.cos(a - .5), y2 - L * Math.sin(a - .5)); c.lineTo(x2 - L * Math.cos(a + .5), y2 - L * Math.sin(a + .5)); c.fill();
}
