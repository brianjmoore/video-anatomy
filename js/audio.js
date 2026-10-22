// Audio tab: track summary, frame strip (sizes + window types), waveform, frame inspector.
import { h, fmtBytes, renderFields, toast } from './ui.js';
import { parseAacFrame, adtsHeader, WINDOW_SEQ, SAMPLE_RATES } from './aac.js';
import { fmtTime } from './mp4.js';

const LIMIT = 20000;
const WIN_COLORS = ['#4f9dff', '#ffbf3c', '#ff6b5a', '#46c98b'];
const WIN_SHORT = ['long', 'long→short', '8 short', 'short→long'];
// Scalefactor band offsets (long windows, 1024 bins) for 44.1/48 kHz, and short windows (128 bins)
const SWB_LONG_48 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024];
const SWB_SHORT_48 = [0, 4, 8, 12, 16, 20, 28, 36, 44, 56, 68, 80, 96, 112, 128];

export class AudioView {
  constructor(app) { this.app = app; this.el = document.getElementById('audioView'); }

  reset() {
    this.stop();
    this.track = null; this.pcm = null; this.frames = null; this.el.innerHTML = '';
  }

  async open(track) {
    const tracks = this.app.tracks.filter(t => t.type === 'audio');
    if (!tracks.length) { this.el.innerHTML = '<div class="empty">This file has no audio track.</div>'; return; }
    track = track || this.track || tracks[0];
    if (this.track === track && this.el.childNodes.length) return;
    this.reset();
    this.track = track;
    const T = track.samples, cfg = track.config;
    const isAac = cfg && cfg.codec === 'aac';
    this.asc = isAac ? cfg.asc : null;
    this.el.append(h('div.vwrap', null,
      tracks.length > 1 ? h('div.pills', null, tracks.map(t => h('button.chip' + (t === track ? '.on' : ''), { onclick: () => { this.track = null; this.open(t); } }, `Track ${t.id} (${t.codec})`))) : null,
      this.summaryEl = h('div'),
      this.progEl = h('div.progress', null, h('div')),
      this.overviewEl = h('div.card'),
      this.inspEl = h('div')));
    this.renderSummary();
    if (!T.n) return;
    if (isAac) await this.scanFrames();
    this.progEl.hidden = true;
    this.renderSummary();
    this.renderOverview();
    this.select(Math.min(T.n - 1, Math.floor(T.n / 3)));
  }

  async scanFrames() {
    const T = this.track.samples, n = Math.min(T.n, LIMIT);
    const frames = new Array(n);
    const bar = this.progEl.firstChild;
    let i = 0;
    while (i < n) {
      const start = T.offset[i];
      let j = i, end = start + Math.min(T.size[i], 64);
      while (j + 1 < n && T.offset[j + 1] >= start && T.offset[j + 1] + 64 - start < 1e6 && T.offset[j + 1] - end < 64e3) { j++; end = Math.max(end, T.offset[j] + Math.min(T.size[j], 64)); }
      const buf = await this.app.readBytes(start, end - start);
      for (let k = i; k <= j; k++) {
        const o = T.offset[k] - start;
        const f = parseAacFrame(buf.subarray(o, o + Math.min(T.size[k], 64)), T.offset[k], this.asc);
        frames[k] = { seq: f.ics ? f.ics.seq : -1, max_sfb: f.ics ? f.ics.max_sfb : 0, el: f.element, gain: f.global_gain };
      }
      i = j + 1;
      bar.style.width = (100 * i / n) + '%';
      if (i % 2000 < (j - i + 2)) await new Promise(r => setTimeout(r, 0));
    }
    this.frames = frames;
  }

  renderSummary() {
    const t = this.track, T = t.samples, a = this.asc, se = t.entry || {};
    const dur = T.n ? T.endTime / T.ts : 0;
    const kv = [];
    kv.push('Codec', a ? a.name : `${t.codec}${t.oti ? '' : ''}`);
    if (a) {
      kv.push('Sample rate', `${a.sampleRate} Hz${a.outRate ? ` core, ${a.outRate} Hz output (SBR doubles it)` : ''}`);
      kv.push('Channels', `${a.channelConfig} (from AudioSpecificConfig; the mp4a box says ${se.channels})`);
      kv.push('Frame length', `${a.frameLength} samples = ${(a.frameLength / a.sampleRate * 1000).toFixed(2)} ms per AAC frame`);
    } else if (se.sampleRate) kv.push('Sample rate / channels', `${se.sampleRate} Hz, ${se.channels} ch`);
    kv.push('Frames', `${T.n.toLocaleString()} over ${fmtTime(dur)}`);
    if (dur) kv.push('Bitrate', `${(T.totalBytes * 8 / dur / 1000).toFixed(1)} kbit/s avg, ${fmtBytes(T.totalBytes)} total`);
    if (T.editShift) kv.push('Encoder delay', `${T.editShift} samples are skipped at the start via the edit list (elst). AAC encoders add this “priming” because each frame’s transform overlaps the previous one`);
    if (this.frames) {
      const c = [0, 0, 0, 0]; let maxSfb = 0;
      for (const f of this.frames) if (f && f.seq >= 0) { c[f.seq]++; if (f.seq !== 2) maxSfb = Math.max(maxSfb, f.max_sfb); }
      const sum = c.reduce((x, y) => x + y, 0) || 1;
      kv.push('Window types', h('span', null, c.map((n, k) => n ? h('span', { style: { marginRight: '10px' } }, h('span.sw', { style: { background: WIN_COLORS[k] } }), `${WIN_SHORT[k]} ${(100 * n / sum).toFixed(1)}%`) : null)));
      const bw = this.bandwidth(maxSfb, false);
      if (bw) kv.push('Bandwidth', `≈ ${(bw / 1000).toFixed(1)} kHz (max ${maxSfb} long-window bands). The encoder discards everything above this to save bits`);
    }
    this.summaryEl.innerHTML = '';
    const card = h('div.card', null, h('h3', null, `Audio track ${t.id}`), h('div.kv', null, kv));
    if (a) {
      const fl = h('div.fields', { style: { marginTop: '8px' } });
      renderFields(fl, a.fields, null, { expandDepth: 2 });
      card.append(h('details', null, h('summary.small.dim', { style: { cursor: 'pointer', marginTop: '8px' } }, 'AudioSpecificConfig: the decoder setup bytes from the esds box'), fl,
        h('button.chip', { onclick: () => this.app.showBox(t, 'esds'), style: { marginTop: '6px' } }, 'Open esds box →')));
    } else card.append(h('div.dim.small', { style: { marginTop: '8px' } }, 'Frame-level syntax is decoded for AAC. Other codecs show container information only.'));
    this.summaryEl.append(card);
  }

  bandwidth(maxSfb, short) {
    const a = this.asc;
    if (!a || (a.sampleRate !== 44100 && a.sampleRate !== 48000)) return 0;
    const tab = short ? SWB_SHORT_48 : SWB_LONG_48;
    const bins = short ? 128 : 1024;
    return tab[Math.min(maxSfb, tab.length - 1)] / bins * (a.sampleRate / 2);
  }

  renderOverview() {
    const el = this.overviewEl, T = this.track.samples;
    el.innerHTML = '';
    el.append(h('h3', null, 'Frames'),
      h('div.dim.small', { style: { marginBottom: '6px' } }, this.frames ? 'Each column is an AAC frame: height = bytes, colour = window type. Tap to inspect one.' : 'Each column is one audio packet; height = bytes.'));
    this.strip = h('canvas.wave', { style: { height: '90px' } });
    this.wave = h('canvas.wave', { style: { marginTop: '6px' } });
    el.append(this.strip, this.wave);
    this.waveNote = h('div.dim.small', { style: { marginTop: '4px' } });
    el.append(this.waveNote);
    const row = h('div.toolbar');
    this.decodeBtn = h('button', { onclick: () => this.decode() }, 'Decode audio to show the waveform');
    row.append(this.decodeBtn);
    el.append(row);
    if (this.frames) el.append(h('div.legend', { style: { margin: '2px 0' } }, WIN_SHORT.map((w, k) => h('span', null, h('span.sw', { style: { background: WIN_COLORS[k] } }), w))));
    const click = (e) => {
      const r = e.target.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const k = Math.floor(this.viewStart + x * (this.viewEnd - this.viewStart));
      this.select(Math.max(0, Math.min(T.n - 1, k)));
    };
    this.strip.addEventListener('click', click);
    this.wave.addEventListener('click', click);
    this.viewStart = 0; this.viewEnd = T.n;
    this.zoomRow = h('div.toolbar', null,
      h('button.chip', { onclick: () => this.zoom(1 / 4) }, 'Zoom in'), h('button.chip', { onclick: () => this.zoom(4) }, 'Zoom out'),
      h('button.chip', { onclick: () => { this.viewStart = 0; this.viewEnd = T.n; this.drawStrip(); } }, 'All'));
    el.insertBefore(this.zoomRow, this.strip);
    new ResizeObserver(() => this.drawStrip()).observe(this.strip);
  }

  zoom(f) {
    const T = this.track.samples;
    const c = this.sel ?? (this.viewStart + this.viewEnd) / 2;
    const span = Math.max(16, Math.min(T.n, (this.viewEnd - this.viewStart) * f));
    this.viewStart = Math.max(0, Math.floor(c - span / 2));
    this.viewEnd = Math.min(T.n, this.viewStart + Math.ceil(span));
    this.drawStrip();
  }

  drawStrip() {
    const T = this.track.samples;
    for (const cv of [this.strip, this.wave]) {
      const dpr = devicePixelRatio || 1;
      cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    }
    const c = this.strip.getContext('2d'), W = this.strip.width, H = this.strip.height;
    c.clearRect(0, 0, W, H);
    const a = this.viewStart, b = this.viewEnd, span = b - a;
    let max = 1; for (let k = a; k < b; k++) max = Math.max(max, T.size[k]);
    const per = W / span;
    for (let px = 0; px < W; px++) {
      // aggregate frames under this pixel column
      const k0 = Math.floor(a + px / per), k1 = Math.max(k0 + 1, Math.floor(a + (px + 1) / per));
      let sz = 0, seq = 0;
      for (let k = k0; k < k1 && k < b; k++) { if (T.size[k] > sz) sz = T.size[k]; const f = this.frames && this.frames[k]; if (f && f.seq > seq) seq = f.seq; }
      const hh = (sz / max) * (H - 4);
      c.fillStyle = this.frames ? WIN_COLORS[seq] || '#777' : '#4f9dff';
      c.fillRect(px, H - hh, per > 3 ? Math.max(1, per - 1) : 1, hh);
      if (per > 3) px += Math.floor(per) - 1;
    }
    if (this.sel != null && this.sel >= a && this.sel < b) {
      c.strokeStyle = '#fff'; c.lineWidth = 2 * (devicePixelRatio || 1);
      const x = (this.sel - a) * per;
      c.strokeRect(x, 1, Math.max(per, 3), H - 2);
    }
    this.drawWave();
  }

  drawWave() {
    const cv = this.wave, c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    const T = this.track.samples;
    if (!this.pcm) {
      c.fillStyle = '#6c7381'; c.font = `${12 * (devicePixelRatio || 1)}px sans-serif`;
      c.fillText('Waveform appears after decoding', 10, H / 2);
      return;
    }
    const { data, rate } = this.pcm;
    const ts = T.ts;
    const t0 = T.dts[this.viewStart] / ts, t1 = (this.viewEnd < T.n ? T.dts[this.viewEnd] : T.endTime) / ts;
    const s0 = Math.floor(t0 * rate), s1 = Math.min(data.length, Math.floor(t1 * rate));
    const per = (s1 - s0) / W;
    c.strokeStyle = '#46c98b'; c.beginPath();
    for (let x = 0; x < W; x++) {
      let lo = 1, hi = -1;
      const a = Math.floor(s0 + x * per), b = Math.max(a + 1, Math.floor(s0 + (x + 1) * per));
      for (let k = a; k < b && k < data.length; k += Math.max(1, Math.floor((b - a) / 64))) { const v = data[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi < lo) continue;
      c.moveTo(x + .5, H / 2 - hi * H / 2); c.lineTo(x + .5, H / 2 - lo * H / 2 + 1);
    }
    c.stroke();
    if (this.sel != null) {
      const fs = T.dts[this.sel] / ts, fe = (this.sel + 1 < T.n ? T.dts[this.sel + 1] : T.endTime) / ts;
      const x0 = (fs - t0) / (t1 - t0) * W, x1 = (fe - t0) / (t1 - t0) * W;
      c.fillStyle = 'rgba(255,191,60,.25)'; c.fillRect(x0, 0, Math.max(2, x1 - x0), H);
    }
  }

  // Decode the track to PCM: AAC → ADTS stream → decodeAudioData; other codecs → whole file.
  async decode() {
    const T = this.track.samples;
    this.decodeBtn.disabled = true; this.decodeBtn.textContent = 'Decoding…';
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx ||= new AC();
      let buf;
      if (this.asc) {
        const n = Math.min(T.n, Math.ceil(600 * this.asc.sampleRate / this.asc.frameLength)); // up to 10 minutes
        let total = 0; for (let k = 0; k < n; k++) total += T.size[k] + 7;
        const out = new Uint8Array(total);
        let o = 0;
        for (let k = 0; k < n; k++) {
          const f = await this.app.readBytes(T.offset[k], T.size[k]);
          out.set(adtsHeader(this.asc, T.size[k]), o); out.set(f, o + 7); o += T.size[k] + 7;
        }
        buf = out.buffer;
        if (n < T.n) toast('Decoded the first 10 minutes');
      } else {
        if (this.app.file.size > 300e6) throw new Error('file too large to decode whole');
        buf = await this.app.file.arrayBuffer();
      }
      const ab = await new Promise((res, rej) => this.ctx.decodeAudioData(buf, res, rej));
      // mix to mono for display
      const data = new Float32Array(ab.length);
      for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let k = 0; k < d.length; k++) data[k] += d[k] / ab.numberOfChannels; }
      this.pcm = { data, rate: ab.sampleRate, buffer: ab };
      this.decodeBtn.remove();
      this.waveNote.textContent = `Decoded ${fmtTime(ab.duration)} at ${ab.sampleRate} Hz with the browser’s decoder. The highlighted span is the selected frame.`;
      this.drawStrip();
      if (this.sel != null) this.select(this.sel);
    } catch (e) {
      this.decodeBtn.disabled = false; this.decodeBtn.textContent = 'Decode audio';
      toast('This browser could not decode the audio: ' + (e.message || e));
    }
  }

  stop() { if (this.src) { try { this.src.stop(); } catch { /* already stopped */ } this.src = null; } }

  play(t0, dur) {
    if (!this.pcm) return;
    this.stop();
    this.ctx.resume();
    const s = this.ctx.createBufferSource();
    s.buffer = this.pcm.buffer; s.connect(this.ctx.destination);
    s.start(0, Math.max(0, t0), dur);
    this.src = s;
  }

  async select(k) {
    const T = this.track.samples;
    this.sel = k;
    if (k < this.viewStart || k >= this.viewEnd) { const span = this.viewEnd - this.viewStart; this.viewStart = Math.max(0, k - Math.floor(span / 2)); this.viewEnd = Math.min(T.n, this.viewStart + span); }
    this.drawStrip();
    const el = this.inspEl;
    el.innerHTML = '';
    const ts = T.ts;
    const t0 = T.dts[k] / ts, t1 = (k + 1 < T.n ? T.dts[k + 1] : T.endTime) / ts;
    const nav = h('div.toolbar', { style: { margin: '10px 12px 0' } },
      h('button', { onclick: () => this.select(Math.max(0, k - 1)) }, '◀'), h('button', { onclick: () => this.select(Math.min(T.n - 1, k + 1)) }, '▶'),
      h('strong', null, `Frame ${k + 1} of ${T.n.toLocaleString()}`), h('span.dim', null, `${fmtTime(t0)}–${fmtTime(t1)}`),
      h('span.spacer'),
      this.pcm ? h('button.chip', { onclick: () => this.play(t0 - 0.4, 0.8 + (t1 - t0)) }, '▶ Play around this frame') : null);
    el.append(nav);
    const grid = h('div.inspector'); el.append(grid);
    const left = h('div'), right = h('div'); grid.append(left, right);
    const kv = ['Size', `${T.size[k]} bytes = ${(T.size[k] * 8 / (t1 - t0) / 1000).toFixed(0)} kbit/s for this frame`, 'Offset', `${T.offset[k].toLocaleString()} (0x${T.offset[k].toString(16)})`,
      'Duration', `${((t1 - t0) * 1000).toFixed(2)} ms (${T.dts[k + 1] - T.dts[k] || ''} samples)`];
    left.append(h('div.card', null, h('h3', null, 'This frame'), h('div.kv', null, kv)));
    if (!this.asc) return;
    const bytes = await this.app.readBytes(T.offset[k], T.size[k]);
    if (this.sel !== k) return;
    const f = parseAacFrame(bytes, T.offset[k], this.asc);
    // window diagram
    if (f.ics) {
      const wc = h('div.card', null, h('h3', null, 'Transform window'));
      const cv = h('canvas.winshape');
      wc.append(cv, h('div.small.dim', null, f.ics.seq === 2
        ? 'Eight short windows (256 samples each, overlapping). The encoder switched to these because the sound changes abruptly here, like a drum hit. Long windows would smear the attack into the silence before it (“pre-echo”).'
        : f.ics.seq === 0 ? 'One long window covering 2048 samples (this frame’s 1024 new samples overlapped with the previous frame’s). Long windows give fine frequency resolution for steady sounds.'
          : 'A transition window that bridges a long window and short windows so their overlaps still cancel out.'));
      left.append(wc);
      requestAnimationFrame(() => drawWindow(cv, f.ics.seq, f.ics.shape));
      // bands
      const bc = h('div.card', null, h('h3', null, 'Frequency bands'));
      const bw = this.bandwidth(f.ics.max_sfb, f.ics.seq === 2);
      bc.append(h('div.small', null, `${f.ics.max_sfb} of ${f.ics.num_swb} scalefactor bands carry data` + (bw ? `, up to ≈ ${(bw / 1000).toFixed(1)} kHz` : '') + '.'));
      if (f.sections) {
        const bar = h('div', { style: { display: 'flex', height: '18px', borderRadius: '4px', overflow: 'hidden', margin: '6px 0', border: '1px solid var(--line)' } });
        const g0 = f.sections.filter(s => s.g === 0);
        for (const s of g0) {
          const col = s.cb === 0 ? '#2b303b' : s.cb >= 13 ? '#c9a0ff' : `hsl(${200 - s.cb * 15},70%,${45 + s.cb * 2}%)`;
          bar.append(h('div', { style: { flex: `${s.end - s.start} 0 0`, background: col, fontSize: '10px', color: '#000', textAlign: 'center' }, title: `bands ${s.start}–${s.end - 1}: codebook ${s.cb}` }, s.end - s.start > 2 ? s.cb : ''));
        }
        if (f.ics.num_swb > f.ics.max_sfb) bar.append(h('div', { style: { flex: `${f.ics.num_swb - f.ics.max_sfb} 0 0`, background: 'repeating-linear-gradient(45deg,#15171c,#15171c 4px,#1f232c 4px,#1f232c 8px)' }, title: 'not coded' }));
        bc.append(bar, h('div.small.dim', null, 'Low frequencies on the left. Numbers are the Huffman codebooks chosen for each run of bands: 0 = all zero (silent), 1–2 for tiny values, up to 11 for large ones. Hatched bands above max_sfb aren’t coded at all.'));
      }
      left.append(bc);
    }
    // PCM + spectrum
    if (this.pcm) {
      const pc = h('div.card', null, h('h3', null, 'Decoded samples & spectrum'));
      const cv1 = h('canvas.wave', { style: { height: '90px' } }), cv2 = h('canvas.wave', { style: { height: '120px', marginTop: '6px' } });
      pc.append(cv1, cv2, h('div.small.dim', null, 'Top: the decoded samples of this frame. Bottom: their frequency spectrum (log scale). Compare with the bandwidth above: AAC simply doesn’t code frequencies the encoder deemed inaudible or too expensive.'));
      left.append(pc);
      requestAnimationFrame(() => this.drawFramePcm(cv1, cv2, t0, t1));
    }
    // syntax
    const sc = h('div.card', null, h('h3', null, 'Syntax (start of raw_data_block)'));
    const fl = h('div.fields');
    renderFields(fl, f.fields, null, { expandDepth: 3 });
    sc.append(h('div.small.dim', { style: { marginBottom: '6px' } }, 'AAC frames are a sequence of syntax elements: a channel pair (CPE) for stereo, single channels (SCE), fill data. Each channel stream starts with a gain, window info and how frequency bands are grouped for Huffman coding.'), fl);
    right.append(sc);
  }

  drawFramePcm(cv1, cv2, t0, t1) {
    const { data, rate } = this.pcm;
    for (const cv of [cv1, cv2]) { const d = devicePixelRatio || 1; cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d; }
    const s0 = Math.floor(t0 * rate), s1 = Math.min(data.length, Math.floor(t1 * rate));
    const c = cv1.getContext('2d'), W = cv1.width, H = cv1.height;
    c.strokeStyle = '#46c98b'; c.lineWidth = 1.5; c.beginPath();
    for (let x = 0; x < W; x++) { const v = data[s0 + Math.floor(x / W * (s1 - s0))] || 0; const y = H / 2 - v * H / 2; x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    // spectrum of 2048 samples centred on the frame
    const N = 2048, mid = (s0 + s1) >> 1;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (N - 1)); re[k] = (data[mid - N / 2 + k] || 0) * w; }
    fft(re, im);
    const c2 = cv2.getContext('2d'), W2 = cv2.width, H2 = cv2.height;
    c2.fillStyle = '#4f9dff';
    const mag = k => 20 * Math.log10(Math.hypot(re[k], im[k]) / (N / 4) + 1e-9);
    for (let x = 0; x < W2; x++) {
      const k0 = Math.floor(x / W2 * N / 2), k1 = Math.max(k0 + 1, Math.floor((x + 1) / W2 * N / 2));
      let m = -200; for (let k = k0; k < k1; k++) m = Math.max(m, mag(k));
      const hh = Math.max(0, (m + 100) / 100) * H2;
      c2.fillRect(x, H2 - hh, 1, hh);
    }
    c2.fillStyle = '#9aa1ae'; c2.font = `${11 * (devicePixelRatio || 1)}px sans-serif`;
    for (const f of [1000, 5000, 10000, 15000, 20000]) {
      if (f > rate / 2) break;
      const x = f / (rate / 2) * W2; c2.fillRect(x, H2 - 6, 1, 6); c2.fillText(`${f / 1000}k`, x + 2, H2 - 8);
    }
  }
}

function drawWindow(cv, seq, shape) {
  const d = devicePixelRatio || 1;
  cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d;
  const c = cv.getContext('2d'), W = cv.width, H = cv.height;
  const N = 2048, X = n => n / N * W, Y = v => H - 8 * d - v * (H - 16 * d);
  const sine = (n, len) => Math.sin(Math.PI * (n + 0.5) / len);
  const win = n => {
    if (seq === 0) return sine(n, 2048);
    if (seq === 1) return n < 1024 ? sine(n, 2048) : n < 1472 ? 1 : n < 1600 ? sine(n - 1472 + 128, 256) : 0;
    if (seq === 3) return n < 448 ? 0 : n < 576 ? sine(n - 448, 256) : n < 1024 ? 1 : sine(n, 2048);
    return 0;
  };
  c.strokeStyle = '#2b303b'; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke();
  c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(X(1024), 0, X(1024), H);
  c.lineWidth = 2 * d;
  if (seq === 2) {
    for (let w = 0; w < 8; w++) {
      c.strokeStyle = WIN_COLORS[2]; c.beginPath();
      for (let n = 0; n < 256; n++) { const x = X(448 + w * 128 + n), y = Y(sine(n, 256)); n ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke();
    }
  } else {
    c.strokeStyle = WIN_COLORS[seq]; c.beginPath();
    for (let n = 0; n < N; n += 4) { const x = X(n), y = Y(win(n)); n ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
  }
  c.fillStyle = '#9aa1ae'; c.font = `${11 * d}px sans-serif`;
  c.fillText('previous frame’s samples', 6 * d, 14 * d); c.fillText('this frame’s new samples', X(1024) + 6 * d, 14 * d);
  void shape;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi; re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
void WINDOW_SEQ; void SAMPLE_RATES;
