// Video tab: track summary, GOP strip, frame inspector.
import { h, fmtBytes, renderFields, renderHex, toast } from './ui.js';
import { analyzeVideo, gopSummary } from './gop.js';
import { explainSample } from './samples.js';
import { fmtTime } from './mp4.js';
import * as H264 from './h264.js';
import * as HEVC from './hevc.js';
import { FrameDecoder } from './decoder.js';
import { MbView } from './mbview.js';
import { parseSliceData, motionOf } from './h264mb.js';

const COLORS = { I: '#ff6b5a', P: '#4f9dff', B: '#46c98b', b: '#9fe0bf', '?': '#777' };
const ANALYZE_LIMIT = 5000;
export const frameLetter = f => !f ? '?' : f.type === 'B' && !f.isRef ? 'b' : (f.type || '?')[0] === 'S' ? 'P' : (f.type || '?')[0];

export class VideoView {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('videoView');
    this.stepMode = 'display';
  }

  reset() { if (this.dec) this.dec.close(); this.dec = null; this.track = null; this.el.innerHTML = ''; this.motion = new Map(); }

  // Motion field of decode-order frame idx (needed as the co-located picture for B-frame direct prediction).
  getMotion(idx) {
    if (this.motion.has(idx)) return this.motion.get(idx);
    const p = (async () => {
      const T = this.track.samples, cfg = this.track.config;
      const { slices, state } = await this.readSlices(idx);
      const res = await parseSliceData(slices, state, this.A.frames, idx, { getMotion: j => this.getMotion(j) });
      return motionOf(res, this.A.frames[idx].refs || [[], []]);
    })();
    this.rememberMotion(idx, p);
    return p;
  }
  rememberMotion(idx, p) {
    this.motion.set(idx, p);
    while (this.motion.size > 12) this.motion.delete(this.motion.keys().next().value);
  }
  async readSlices(idx) {
    const T = this.track.samples, cfg = this.track.config;
    const bytes = await this.app.readBytes(T.offset[idx], T.size[idx]);
    const state = { sps: { ...cfg.state.sps }, pps: { ...cfg.state.pps } };
    const slices = [];
    for (const nr of H264.splitLengthPrefixed(bytes, cfg.lengthSize)) {
      const nal = H264.parseNal(bytes.subarray(nr.off, nr.off + nr.len), T.offset[idx] + nr.off, state);
      if (nal.slice) slices.push({ nal });
    }
    return { slices, state };
  }

  async open(track) {
    const app = this.app;
    const tracks = app.tracks.filter(t => t.type === 'video');
    if (!tracks.length) { this.el.innerHTML = '<div class="empty">This file has no video track.</div>'; return; }
    track = track || this.track || tracks[0];
    if (this.track === track && this.el.childNodes.length) return;
    this.reset();
    this.track = track;
    const T = track.samples;
    const cfg = track.config;
    this.el.append(h('div.vwrap', null,
      tracks.length > 1 ? h('div.pills', null, tracks.map(t => h('button.chip' + (t === track ? '.on' : ''), { onclick: () => { this.track = null; this.open(t); } }, `Track ${t.id} (${t.codec})`))) : null,
      this.summaryEl = h('div'),
      this.progEl = h('div.progress', null, h('div')),
      this.stripHost = h('div'),
      this.inspEl = h('div')));
    this.renderSummary(null);
    if (!T.n) { this.inspEl.append(h('div.empty', null, 'This track has no samples.')); return; }
    if (!cfg || !(cfg.codec === 'h264' || cfg.codec === 'hevc')) {
      this.A = { frames: Array.from({ length: T.n }, (_, i) => ({ i, type: T.sync[i] ? 'I' : '?', size: T.size[i] })), n: T.n, complete: true, unsupported: true };
    } else {
      const limit = T.n > ANALYZE_LIMIT ? ANALYZE_LIMIT : Infinity;
      const bar = this.progEl.firstChild;
      const t0 = performance.now();
      this.A = await analyzeVideo(T, cfg, app.readBytes, { limit, onProgress: (d, n) => { bar.style.width = (100 * d / n) + '%'; } });
      this.analysisMs = performance.now() - t0;
      if (this.track !== track) return;
      if (!this.A.complete) {
        // fill in container-only info for frames we didn't parse
        for (let i = this.A.n; i < T.n; i++) this.A.frames[i] = { i, type: T.sync[i] ? 'I' : '?', size: T.size[i], unparsed: true };
        this.A.n = T.n;
      }
    }
    this.progEl.hidden = true;
    this.computeReverseRefs();
    this.renderSummary(this.A);
    this.strip = new GopStrip(this.stripHost, T, this.A, i => this.select(i));
    this.dec = new FrameDecoder(track, T, app.readBytes, app.file);
    this.decMode = cfg && cfg.sps ? await this.dec.init().catch(() => 'none') : 'none';
    this.select(0);
  }

  computeReverseRefs() {
    for (const f of this.A.frames) if (f) f.usedBy = [];
    for (const f of this.A.frames) {
      if (!f || !f.refs) continue;
      const seen = new Set([...f.refs[0], ...f.refs[1]]);
      for (const r of seen) if (this.A.frames[r]) this.A.frames[r].usedBy.push(f.i);
    }
  }

  renderSummary(A) {
    const t = this.track, T = t.samples, cfg = t.config;
    const sps = cfg && cfg.sps && cfg.sps[0];
    const dur = T.n ? (T.endTime / T.ts) : 0;
    const fps = T.n > 1 ? (T.n / dur) : 0;
    const kv = [];
    kv.push('Codec', cfg ? `${cfg.codec === 'hevc' ? 'H.265 / HEVC' : cfg.codec === 'h264' ? 'H.264 / AVC' : t.codec} (${cfg.codecString || t.codec})` : t.codec);
    if (sps && cfg.codec === 'h264') kv.push('Profile / level', `${H264.profileName(sps.profile_idc)} @ ${sps.level_idc / 10}`, 'Entropy coding', cfg.pps[0] ? (cfg.pps[0].entropy_coding_mode_flag ? 'CABAC (arithmetic)' : 'CAVLC (variable-length codes)') : '?');
    if (sps && cfg.codec === 'hevc') kv.push('Profile / level', `${HEVC.profileName(sps.ptl.profile_idc)} @ ${sps.ptl.level_idc / 30}`, 'CTU size', `${1 << sps.log2_ctb}×${1 << sps.log2_ctb}`);
    if (sps) kv.push('Picture', `${sps.width}×${sps.height}` + (sps.codedWidth !== sps.width || sps.codedHeight !== sps.height ? ` (coded as ${sps.codedWidth}×${sps.codedHeight})` : '') + `, ${sps.bit_depth_luma}-bit`);
    else if (t.entry) kv.push('Picture', `${t.entry.width}×${t.entry.height}`);
    kv.push('Frames', `${T.n.toLocaleString()} over ${fmtTime(dur)} (${fps.toFixed(2)} fps avg)`);
    kv.push('Bitrate', `${((T.totalBytes * 8) / dur / 1000).toFixed(0)} kbit/s, ${fmtBytes(T.totalBytes)} total`);
    kv.push('Storage', T.fragmented ? 'fragmented (moof/trun)' : `${T.tables.stco ? T.tables.stco.off.length : 0} chunks (stco)`);
    if (A && !A.unsupported) {
      const g = gopSummary(T, A);
      kv.push('Keyframes', `${g.keyframes} (avg GOP ${g.avgGop.toFixed(1)} frames = ${(g.avgGop / (fps || 1)).toFixed(2)} s)`);
      kv.push('Frame types', `${g.counts.I} I · ${g.counts.P} P · ${g.counts.B} B${g.refB ? ` (${g.refB} used as references)` : ''}` + (A.complete ? '' : ` (first ${ANALYZE_LIMIT.toLocaleString()} frames)`));
      const pat = h('span.pattern');
      for (const c of g.pattern) pat.append(h('span.' + (c === '…' ? 'x' : c), null, c));
      kv.push('First GOP (display order)', pat);
    } else if (A && A.unsupported) kv.push('Note', 'Frame-level analysis supports H.264 and HEVC. Showing container information only.');
    this.summaryEl.innerHTML = '';
    this.summaryEl.append(h('div.card', null, h('h3', null, `Video track ${t.id}`), h('div.kv', null, kv)));
  }

  // Select frame (decode-order index)
  async select(i) {
    const T = this.track.samples, A = this.A;
    if (i < 0 || i >= T.n) return;
    this.sel = i;
    this.strip.setSelected(i);
    const f = A.frames[i];
    const el = this.inspEl;
    el.innerHTML = '';
    const L = frameLetter(f);
    // navigation
    const prev = () => this.step(-1), next = () => this.step(1);
    const nav = h('div.toolbar', { style: { margin: '10px 12px 0' } },
      h('button', { onclick: prev }, '◀'), h('button', { onclick: next }, '▶'),
      h('span', null, h('span.ftype.' + L, null, L), ` Frame ${T.presRank[i] + 1} on screen · stored ${i + 1} of ${T.n}`),
      h('span.spacer'),
      h('span.dim.small', null, 'Step in'),
      h('button.chip' + (this.stepMode === 'display' ? '.on' : ''), { onclick: e => { this.stepMode = 'display'; this.select(i); } }, 'display order'),
      h('button.chip' + (this.stepMode === 'decode' ? '.on' : ''), { onclick: e => { this.stepMode = 'decode'; this.select(i); } }, 'decode order'));
    el.append(nav);
    const grid = h('div.inspector');
    el.append(grid);
    const left = h('div'), right = h('div');
    grid.append(left, right);

    // picture
    const picCard = h('div.card', null, h('h3', null, 'Picture'));
    left.append(picCard);
    this.mbView = new MbView(picCard, this, i);
    this.mbView.load();

    // facts
    const kv = [];
    const typeDesc = { I: 'I-frame (intra): coded on its own, like a still image', P: 'P-frame (predicted): built from earlier reference pictures plus corrections', B: 'B-frame (bi-predictive): can blend predictions from earlier and later pictures', b: 'Non-reference B-frame: nothing else depends on it, so a player can drop it' };
    kv.push('Type', h('span', null, h('span.ftype.' + L, null, L), ' ', typeDesc[L] || 'Unknown (codec not analysed)'));
    if (f.nalType != null) kv.push('NAL type', this.track.config.codec === 'hevc' ? `${HEVC.nalName(f.nalType)}` : `${f.nalType} (${H264.NAL_TYPES[f.nalType]})`);
    if (T.sync[i]) kv.push('Keyframe', 'Yes: listed as a sync sample, so decoding can start here');
    kv.push('Size', `${T.size[i].toLocaleString()} bytes (${(T.size[i] / (T.totalBytes / T.n) * 100).toFixed(0)}% of average)`);
    const sps = this.track.config && this.track.config.sps && this.track.config.sps[0];
    if (sps) kv.push('Bits per pixel', (T.size[i] * 8 / (sps.width * sps.height)).toFixed(3));
    kv.push('Decode time (DTS)', `${T.dts[i]} ticks = ${fmtTime(T.dts[i] / T.ts)}`);
    kv.push('Display time (PTS)', `${fmtTime(T.pts[i])}` + (T.cto[i] ? ` (composition offset +${T.cto[i]} ticks)` : ''));
    if (f.poc != null) kv.push('Picture order count', `${f.poc}` + (f.frameNum != null ? ` · frame_num ${f.frameNum}` : ''));
    if (f.qp != null) kv.push('Slice QP', `${f.qp}${f.slices > 1 ? ` (first of ${f.slices} slices)` : ''}`);
    if (f.partial && f.slices <= 1) kv.push('Slices', '1+ (only the start of the frame was scanned)'); else if (f.slices) kv.push('Slices', f.slices);
    const chip = (r, cls) => h('span.refchip.' + cls, { onclick: () => this.select(r), title: `Decode #${r + 1}` }, `${frameLetter(A.frames[r])} ${T.presRank[r] + 1}`);
    if (f.refs) {
      if (f.refs[0].length) kv.push('References (list 0)', h('span', null, f.refs[0].map(r => chip(r, 'l0'))));
      if (f.refs[1].length) kv.push('References (list 1)', h('span', null, f.refs[1].map(r => chip(r, 'l1'))));
    }
    if (f.usedBy && f.usedBy.length) kv.push('Referenced by', h('span', null, f.usedBy.slice(0, 30).map(r => chip(r, 'x')), f.usedBy.length > 30 ? ` +${f.usedBy.length - 30}` : ''));
    else if (f.refs) kv.push('Referenced by', f.isRef ? 'nothing yet (kept in memory for later frames)' : 'nothing: a disposable frame');
    if (f.refNote) kv.push('Note', f.refNote);
    const factsCard = h('div.card', null, h('h3', null, 'This frame'), h('div.kv', null, kv));
    if (f.refs) factsCard.append(h('div.dim.small', { style: { marginTop: '8px' } },
      'Numbers are display positions. The reference lists show the pictures this frame may predict from. ',
      this.track.config.codec === 'hevc' ? 'HEVC lists them explicitly in the slice header (the reference picture set).' : 'H.264 builds them from the decoder’s memory of previous reference frames (sliding window plus any reordering commands).',
      ' Which blocks actually use which reference is decided per macroblock.'));
    if (f.dpb) factsCard.append(h('div.small', { style: { marginTop: '6px' } }, h('span.dim', null, 'Decoder memory before this frame: '), f.dpb.length ? f.dpb.map(p => chip(p.i, p.long ? 'l1' : 'x')) : 'empty (just after an IDR)'));
    right.append(factsCard);

    // how it was found
    const steps = explainSample(T, i);
    const sc = h('div.card', null, h('h3', null, 'How a player finds this frame'));
    const ol = h('ol.steps');
    for (const s of steps) {
      ol.append(h('li', null, h('a', { href: '#', onclick: e => { e.preventDefault(); this.app.showBox(this.track, s.box); } }, h('code', null, s.box)), ' ', s.text));
    }
    sc.append(ol);
    right.append(sc);

    // NAL units
    const nc = h('div.card', null, h('h3', null, 'Inside the sample: NAL units'));
    right.append(nc);
    this.renderNals(nc, i);
  }

  step(d) {
    const T = this.track.samples;
    if (this.stepMode === 'decode') return this.select(Math.max(0, Math.min(T.n - 1, this.sel + d)));
    const r = Math.max(0, Math.min(T.n - 1, T.presRank[this.sel] + d));
    this.select(T.presOrder[r]);
  }

  async renderNals(card, i) {
    const T = this.track.samples, cfg = this.track.config;
    if (!cfg || !cfg.lengthSize) { card.append(h('div.dim', null, 'NAL parsing is available for H.264 and HEVC.')); return; }
    const size = T.size[i];
    const cap = Math.min(size, 8 << 20);
    const bytes = await this.app.readBytes(T.offset[i], cap);
    if (this.sel !== i) return;
    const isHevc = cfg.codec === 'hevc';
    const nals = H264.splitLengthPrefixed(bytes, cfg.lengthSize);
    card.append(h('div.dim.small', { style: { marginBottom: '6px' } },
      `In MP4 each sample is a list of NAL units (Network Abstraction Layer), each preceded by a ${cfg.lengthSize}-byte length. `,
      'Parameter sets carry settings, SEI carries extra info, and slices carry the actual picture data.'));
    const state = { sps: { ...cfg.state.sps }, pps: { ...cfg.state.pps } };
    this.sliceNals = [];
    for (const nr of nals) {
      const b = bytes.subarray(nr.off, nr.off + nr.len);
      const fileOff = T.offset[i] + nr.off;
      const nal = isHevc ? HEVC.parseNal(b, fileOff, state) : H264.parseNal(b, fileOff, state);
      if (nal.slice) this.sliceNals.push({ nal, bytes: b, fileOff });
      const name = isHevc ? HEVC.nalName(nal.type) : (H264.NAL_SHORT[nal.type] || `type ${nal.type}`);
      const sumTxt = nal.slice ? `${nal.slice.type} slice` + (nal.slice.qp != null ? `, QP ${nal.slice.qp}` : '') : '';
      const det = h('details.nal', null, h('summary', null, h('strong', null, name), h('span', null, sumTxt), h('span.dim', null, `${nr.len.toLocaleString()} B`)));
      let built = false;
      det.addEventListener('toggle', () => {
        if (!det.open || built) return;
        built = true;
        const hexEl = h('div.hex');
        const fl = h('div.fields');
        const show = (range) => renderHex(hexEl, this.app.readBytes, { start: T.offset[i] + nr.prefixOff, end: fileOff + nr.len, hdrEnd: fileOff, hl: range, epb: nal.epb })
          .then(t => t && t.scrollIntoView({ block: 'nearest' }));
        renderFields(fl, nal.fields, nal.bits, { onSelect: (f, r) => show(r), expandDepth: 2 });
        det.append(h('div', { style: { padding: '6px 4px' } },
          nal.epb.length ? h('div.dim.small', { style: { padding: '0 8px 6px' } }, `${nal.epb.length} emulation-prevention byte${nal.epb.length > 1 ? 's' : ''} (struck through in red in the hex): an 03 is inserted whenever the data would contain 00 00 00/01/02/03, so it can never be mistaken for a start code.`) : null,
          fl, hexEl));
        show(null);
      });
      card.append(det);
    }
    if (size > cap) card.append(h('div.dim.small', null, `Only the first ${fmtBytes(cap)} of this ${fmtBytes(size)} sample were read.`));
    if (this.mbView) this.mbView.slicesReady(this.sliceNals, state);
  }
}

// ---------------------------------------------------------------------------
// GOP strip: decode order (top) vs display order (bottom), reorder lines, reference arcs.

class GopStrip {
  constructor(host, T, A, onSelect) {
    this.T = T; this.A = A; this.onSelect = onSelect;
    this.cellW = T.n > 2000 ? 4 : T.n > 300 ? 8 : 14;
    host.innerHTML = '';
    const tools = h('div.toolbar', { style: { margin: '8px 12px 4px' } },
      h('strong', { style: { fontSize: '13px' } }, 'Frames'),
      h('span.dim.small', null, 'Bar height = frame size. Tap a frame.'),
      h('span.spacer'),
      h('button.chip', { onclick: () => this.zoom(1 / 1.6) }, '−'), h('button.chip', { onclick: () => this.zoom(1.6) }, '+'));
    this.scroll = h('div.gopscroll');
    this.canvas = h('canvas');
    this.inner = h('div');
    this.inner.append(this.canvas);
    this.scroll.append(this.inner);
    host.append(tools, h('div.gopstrip', null, this.scroll),
      h('div.legend', null,
        ['I', 'P', 'B', 'b'].map(k => h('span', null, h('span.sw', { style: { background: COLORS[k] } }), { I: 'I (intra)', P: 'P', B: 'B (reference)', b: 'b (non-reference)' }[k])),
        h('span', null, h('span.sw', { style: { background: '#4f9dff', height: '3px' } }), 'list 0 refs'),
        h('span', null, h('span.sw', { style: { background: '#ffa94d', height: '3px' } }), 'list 1 refs'),
        h('span', null, '▼ keyframe')));
    this.H = 250;
    // max size for scaling (98th percentile so one huge I-frame doesn't flatten everything)
    const sizes = Array.from(T.size).sort((a, b) => a - b);
    this.maxSize = sizes[Math.floor(sizes.length * 0.98)] || 1;
    this.scroll.addEventListener('scroll', () => this.draw(), { passive: true });
    this.canvas.addEventListener('click', e => this.click(e));
    new ResizeObserver(() => this.layout()).observe(this.scroll);
    this.layout();
  }
  zoom(f) {
    const centerFrame = (this.scroll.scrollLeft + this.scroll.clientWidth / 2) / this.cellW;
    this.cellW = Math.max(1.5, Math.min(40, this.cellW * f));
    this.layout();
    this.scroll.scrollLeft = centerFrame * this.cellW - this.scroll.clientWidth / 2;
  }
  layout() {
    const w = this.scroll.clientWidth || 300;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr; this.canvas.height = this.H * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = this.H + 'px';
    this.inner.style.width = Math.max(w, this.T.n * this.cellW + 20) + 'px';
    this.inner.style.height = this.H + 'px';
    this.draw();
  }
  setSelected(i) {
    this.sel = i;
    const T = this.T, x0 = i * this.cellW, x1 = T.presRank[i] * this.cellW;
    const sl = this.scroll.scrollLeft, w = this.scroll.clientWidth;
    if (Math.min(x0, x1) < sl + 20 || Math.max(x0, x1) > sl + w - 20) this.scroll.scrollLeft = (x0 + x1) / 2 - w / 2;
    this.draw();
  }
  click(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left + this.scroll.scrollLeft, y = e.clientY - r.top;
    const k = Math.floor((x - 10) / this.cellW);
    if (k < 0 || k >= this.T.n) return;
    this.onSelect(y < 92 ? k : this.T.presOrder[k]);
  }
  draw() {
    const T = this.T, A = this.A, c = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / dpr, sl = this.scroll.scrollLeft, cw = this.cellW;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, this.H);
    const yDec = 72, yDisp = 116, barH = 50;
    const first = Math.max(0, Math.floor((sl - 10) / cw) - 40), last = Math.min(T.n - 1, Math.ceil((sl + W) / cw) + 40);
    const X = k => 10 + k * cw - sl;
    const gap = cw >= 5 ? 1 : 0;
    const col = f => COLORS[frameLetter(f)];
    // labels
    c.font = '11px -apple-system, sans-serif'; c.fillStyle = '#6c7381';
    c.fillText('DECODE ORDER: how frames are stored ▲', 10, 12);
    c.fillText('▼ DISPLAY ORDER: how frames are shown', 10, yDisp + barH + 14);
    // reorder lines
    c.lineWidth = 1;
    for (let i = first; i <= last; i++) {
      const xa = X(i) + cw / 2, xb = X(T.presRank[i]) + cw / 2;
      if (xa === xb && cw < 3) continue;
      c.strokeStyle = xa === xb ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.18)';
      c.beginPath(); c.moveTo(xa, yDec); c.lineTo(xb, yDisp); c.stroke();
    }
    // bars
    for (let i = first; i <= last; i++) {
      const f = A.frames[i];
      const hgt = Math.max(2, Math.min(1, Math.sqrt(T.size[i] / this.maxSize)) * barH);
      c.fillStyle = col(f);
      c.fillRect(X(i) + gap, yDec - hgt, cw - gap * 2 || 1, hgt);
      if (T.sync[i] && cw >= 3) { c.fillStyle = '#ffbf3c'; c.fillText('▼', X(i) + cw / 2 - 4, yDec - hgt - 2); }
    }
    const fr = Math.max(0, Math.floor((sl - 10) / cw)), lr = Math.min(T.n - 1, Math.ceil((sl + W) / cw));
    for (let r = fr; r <= lr; r++) {
      const i = T.presOrder[r], f = A.frames[i];
      const hgt = Math.max(2, Math.min(1, Math.sqrt(T.size[i] / this.maxSize)) * barH);
      c.fillStyle = col(f);
      c.fillRect(X(r) + gap, yDisp, cw - gap * 2 || 1, hgt);
    }
    // selection
    if (this.sel != null) {
      const i = this.sel, f = A.frames[i];
      const xa = X(i) + cw / 2, xb = X(T.presRank[i]) + cw / 2;
      c.strokeStyle = '#fff'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(xa, yDec); c.lineTo(xb, yDisp); c.stroke();
      c.strokeRect(X(i), yDec - barH - 2, cw, barH + 2);
      c.strokeRect(X(T.presRank[i]), yDisp, cw, barH + 2);
      // reference arcs under the display row
      const yb = yDisp + barH + 20;
      const arc = (from, to, color, dash) => {
        const x1 = X(T.presRank[from]) + cw / 2, x2 = X(T.presRank[to]) + cw / 2;
        const depth = Math.min(60, 12 + Math.abs(x2 - x1) * 0.25);
        c.strokeStyle = color; c.lineWidth = 1.6; c.setLineDash(dash || []);
        c.beginPath(); c.moveTo(x1, yb); c.quadraticCurveTo((x1 + x2) / 2, yb + depth * 1.6, x2, yb); c.stroke();
        c.setLineDash([]);
        c.fillStyle = color; c.beginPath(); c.moveTo(x2, yb - 1); c.lineTo(x2 - 4, yb + 7); c.lineTo(x2 + 4, yb + 7); c.fill();
      };
      if (f && f.refs) {
        const l0 = new Set(f.refs[0]), l1 = new Set(f.refs[1]);
        for (const r of l0) arc(i, r, '#4f9dff');
        for (const r of l1) if (!l0.has(r)) arc(i, r, '#ffa94d');
        if (f.usedBy) for (const u of f.usedBy.slice(0, 40)) arc(u, i, 'rgba(255,255,255,.35)', [3, 3]);
      }
    }
  }
}
