// Learn tab: short illustrated explainers that link into the loaded file.
import { h } from './ui.js';

const svg = (w, hgt, body) => `<svg viewBox="0 0 ${w} ${hgt}" width="100%" style="max-width:${w}px;display:block" font-family="-apple-system,sans-serif" font-size="12">${body}</svg>`;
const box = (x, y, w, hh, label, fill, sub = '') => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="6" fill="${fill}" stroke="#000" stroke-opacity=".3"/><text x="${x + 8}" y="${y + 17}" fill="#111" font-weight="600" font-family="ui-monospace,monospace">${label}</text>${sub ? `<text x="${x + 8}" y="${y + 32}" fill="#222" font-size="11">${sub}</text>` : ''}`;

const FIG_BOXES = svg(560, 250, `
${box(5, 5, 550, 40, 'ftyp', '#a8e6a1', 'brands: what spec this file follows')}
${box(5, 52, 550, 150, 'moov', '#c9a0ff', 'the index: tracks, timing, codec setup, sample tables')}
${box(20, 90, 250, 105, 'trak (video)', '#d9bfff')}
${box(30, 118, 230, 70, 'mdia › minf › stbl', '#ffd479', 'stsd stts ctts stss stsc stsz stco')}
${box(290, 90, 255, 105, 'trak (audio)', '#d9bfff')}
${box(300, 118, 235, 70, 'mdia › minf › stbl', '#ffd479', 'stsd (mp4a/esds) stts stsc stsz stco')}
${box(5, 208, 550, 37, 'mdat', '#ff9b85', 'V V V A A V V V A A …  (raw frames and audio packets, interleaved)')}`);

const FIG_GOP = (() => {
  const disp = ['I', 'b', 'B', 'b', 'P', 'b', 'B', 'b', 'P'];
  const col = { I: '#ff6b5a', P: '#4f9dff', B: '#46c98b', b: '#9fe0bf' };
  const dec = [0, 4, 2, 1, 3, 8, 6, 5, 7];
  let s = '';
  disp.forEach((t, k) => { s += `<rect x="${20 + k * 58}" y="30" width="48" height="36" rx="5" fill="${col[t]}"/><text x="${44 + k * 58}" y="54" text-anchor="middle" font-weight="700">${t}${k}</text>`; });
  dec.forEach((d, k) => { const t = disp[d]; s += `<rect x="${20 + k * 58}" y="150" width="48" height="36" rx="5" fill="${col[t]}"/><text x="${44 + k * 58}" y="174" text-anchor="middle" font-weight="700">${t}${d}</text>`; s += `<line x1="${44 + d * 58}" y1="66" x2="${44 + k * 58}" y2="150" stroke="#fff" stroke-opacity=".35"/>`; });
  s += `<text x="20" y="20" fill="#9aa1ae">Display order (what you see)</text><text x="20" y="205" fill="#9aa1ae">Decode order (how it is stored and decoded)</text>`;
  return svg(560, 215, s);
})();

const FIG_REFS = (() => {
  const disp = ['I', 'b', 'B', 'b', 'P'];
  const col = { I: '#ff6b5a', P: '#4f9dff', B: '#46c98b', b: '#9fe0bf' };
  let s = '';
  disp.forEach((t, k) => { s += `<rect x="${20 + k * 110}" y="70" width="70" height="44" rx="6" fill="${col[t]}"/><text x="${55 + k * 110}" y="97" text-anchor="middle" font-weight="700">${t}${k}</text>`; });
  const arc = (a, b, color, up) => {
    const x1 = 55 + a * 110, x2 = 55 + b * 110, y = up ? 70 : 114, dy = up ? -50 : 50;
    return `<path d="M${x1} ${y} Q ${(x1 + x2) / 2} ${y + dy} ${x2} ${y}" fill="none" stroke="${color}" stroke-width="2" marker-end="url(#ah${color.slice(1)})"/>`;
  };
  s = `<defs>${['4f9dff', 'ffa94d'].map(c => `<marker id="ah${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#${c}"/></marker>`).join('')}</defs>` + s;
  s += arc(4, 0, '#4f9dff', true) + arc(2, 0, '#4f9dff', false) + arc(2, 4, '#ffa94d', false) + arc(1, 0, '#4f9dff', true) + arc(1, 2, '#ffa94d', true) + arc(3, 2, '#4f9dff', true) + arc(3, 4, '#ffa94d', true);
  s += `<text x="20" y="180" fill="#9aa1ae">Arrows point from a frame to the pictures it predicts from. Blue = list 0 (past), orange = list 1 (future).</text>`;
  return svg(560, 190, s);
})();

const FIG_MB = (() => {
  let s = '';
  const shapes = [['16×16', [[0, 0, 4, 4]]], ['16×8', [[0, 0, 4, 2], [0, 2, 4, 2]]], ['8×16', [[0, 0, 2, 4], [2, 0, 2, 4]]], ['8×8 (each may split further)', [[0, 0, 2, 2], [2, 0, 2, 2], [0, 2, 2, 2], [2, 2, 1, 1], [3, 2, 1, 1], [2, 3, 1, 1], [3, 3, 1, 1]]]];
  shapes.forEach(([name, parts], k) => {
    const ox = 10 + k * 140;
    for (const [x, y, w, hh] of parts) s += `<rect x="${ox + x * 22}" y="${20 + y * 22}" width="${w * 22}" height="${hh * 22}" fill="#4f9dff" fill-opacity=".35" stroke="#7fc1ff"/>`;
    s += `<text x="${ox}" y="${120}" fill="#c8ccd5">${name}</text>`;
  });
  return svg(560, 130, s);
})();

const FIG_RESIDUAL = svg(560, 120, `
<rect x="10" y="20" width="80" height="80" fill="#6b7a8f"/><text x="10" y="14" fill="#9aa1ae">actual block</text>
<text x="100" y="65" fill="#c8ccd5" font-size="20">−</text>
<rect x="120" y="20" width="80" height="80" fill="#64748a"/><text x="120" y="14" fill="#9aa1ae">prediction</text>
<text x="210" y="65" fill="#c8ccd5" font-size="20">=</text>
<rect x="230" y="20" width="80" height="80" fill="#1f232c" stroke="#444"/><text x="230" y="14" fill="#9aa1ae">residual (small)</text>
<text x="320" y="65" fill="#c8ccd5" font-size="20">→</text>
<g font-family="ui-monospace,monospace" font-size="11" fill="#ffd479"><text x="345" y="38">12 −3  1  0</text><text x="345" y="56"> 2  0  0  0</text><text x="345" y="74"> 0  0  0  0</text><text x="345" y="92"> 0  0  0  0</text></g>
<text x="345" y="14" fill="#9aa1ae">transform + quantize</text>
<text x="450" y="65" fill="#c8ccd5" font-size="20">→</text><text x="475" y="60" fill="#c8ccd5">entropy</text><text x="475" y="76" fill="#c8ccd5">coding</text>`);

export class LearnView {
  constructor(app) { this.app = app; this.el = document.getElementById('learnView'); }

  render() {
    const app = this.app;
    const has = !!app.file;
    const v = app.tracks && app.tracks.some(t => t.type === 'video');
    const a = app.tracks && app.tracks.some(t => t.type === 'audio');
    const vcodec = (app.tracks || []).find(t => t.type === 'video');
    const isH264 = vcodec && vcodec.config && vcodec.config.codec === 'h264';
    const btn = (label, fn, ok = has) => ok ? h('button.chip.try', { onclick: fn }, label + ' →') : null;
    const sections = [
      ['container', 'Container vs. codec', [
        h('p', null, 'A video file is two things layered together. The ', h('b', null, 'container'), ' (MP4, MOV, MKV…) is the filing system: it says how many tracks there are, how long they last, and where each frame’s bytes live. The ', h('b', null, 'codecs'), ' (H.264, HEVC, AAC…) define what those bytes mean: how a picture or a slice of sound was compressed.'),
        h('p', null, 'This is why the same H.264 video can be in an .mp4, a .mov or an .mkv, and why a player can say “unsupported codec” for a file it can open fine.'),
      ]],
      ['boxes', 'Boxes (atoms)', [
        h('p', null, 'MP4 and MOV files are built from ', h('b', null, 'boxes'), ' (Apple calls them atoms). Every box starts with 8 bytes: a 4-byte size and a 4-byte type like ', h('code', null, 'moov'), '. Some boxes contain other boxes, which gives a tree. A reader that doesn’t understand a box can skip it using its size, which is how the format stays extensible.'),
        h('figure', { html: FIG_BOXES }),
        h('p', null, 'Many boxes are “full boxes” with an extra version byte and 24 flag bits. Version 1 usually means 64-bit timestamps.'),
        btn('Explore the box tree', () => app.show('structure')),
      ]],
      ['samples', 'How a player finds a frame', [
        h('p', null, 'The media data in ', h('code', null, 'mdat'), ' is just a blob: frames and audio packets back to back, with no markers between them. To find frame N the player uses the sample tables in ', h('code', null, 'stbl'), ':'),
        h('ol', null,
          h('li', null, h('code', null, 'stts'), ' gives each sample’s duration, and therefore its decode time.'),
          h('li', null, h('code', null, 'stsc'), ' says how many samples are grouped into each chunk (a run of consecutive samples).'),
          h('li', null, h('code', null, 'stco'), ' / ', h('code', null, 'co64'), ' gives the file offset of each chunk.'),
          h('li', null, h('code', null, 'stsz'), ' gives each sample’s size, so you add up the sizes of earlier samples in the chunk.'),
          h('li', null, h('code', null, 'stss'), ' lists keyframes for seeking, and ', h('code', null, 'ctts'), ' shifts display times when frames are reordered.')),
        h('p', null, 'These tables are run-length coded so a two-hour movie’s index stays small. Fragmented MP4 (used for streaming) instead puts a small ', h('code', null, 'moof'), ' before each piece of media, with a ', h('code', null, 'trun'), ' listing those samples.'),
        btn('See the walkthrough for a real frame', () => app.show('video'), has && v),
      ]],
      ['time', 'Timescales, DTS, PTS and edit lists', [
        h('p', null, 'Timestamps are integers counted in a ', h('b', null, 'timescale'), ' (ticks per second) chosen per track. 29.97 fps video often uses 30000 ticks/s with frames lasting 1001 ticks. Integer ticks avoid rounding drift.'),
        h('p', null, 'Each sample has a ', h('b', null, 'decode timestamp (DTS)'), ' and a ', h('b', null, 'presentation timestamp (PTS)'), '. They differ when B-frames are stored out of order: a frame needed as a reference is stored (and decoded) before frames that are shown earlier.'),
        h('p', null, 'An ', h('b', null, 'edit list'), ' (', h('code', null, 'elst'), ') maps media time to movie time. Encoders use it to skip AAC priming samples or the start-up delay that B-frame reordering adds, so playback starts exactly at the first real frame.'),
      ]],
      ['frames', 'I, P and B frames', [
        h('p', null, h('span.ftype.I', null, 'I'), ' frames are coded on their own, like a JPEG. ', h('span.ftype.P', null, 'P'), ' frames are coded as differences from earlier pictures: each block says “copy the block from over there, shifted by this motion vector, then add this correction”. ', h('span.ftype.B', null, 'B'), ' frames may also predict from a later picture, or average two predictions. That’s great for objects that become uncovered and for noise.'),
        h('p', null, 'B-frames need their future reference decoded first, so the file stores frames in ', h('b', null, 'decode order'), ', which differs from ', h('b', null, 'display order'), ':'),
        h('figure', { html: FIG_GOP }),
        h('p', null, 'Frames that nothing references (lowercase ', h('span.ftype.b', null, 'b'), ') are disposable: a player under load can skip them without damaging anything else.'),
        btn('See your file’s frame order', () => app.show('video'), has && v),
      ]],
      ['gop', 'GOPs, keyframes and seeking', [
        h('p', null, 'A ', h('b', null, 'group of pictures'), ' (GOP) runs from one keyframe to the next. To show any frame, a decoder must start at the previous keyframe and decode everything in between that the target depends on. That’s why seeking snaps to keyframes, and why long GOPs compress better but seek slower.'),
        h('p', null, 'H.264’s strongest keyframe is the ', h('b', null, 'IDR'), ' (Instantaneous Decoder Refresh): it empties the reference memory, so nothing after it can refer to anything before it. An “open GOP” I-frame (or HEVC CRA) allows some later B-frames to still reference the previous GOP.'),
      ]],
      ['refs', 'Reference pictures and POC', [
        h('figure', { html: FIG_REFS }),
        h('p', null, 'The decoder keeps a small memory of decoded pictures (the ', h('b', null, 'decoded picture buffer'), '). Each P/B slice builds ', h('b', null, 'reference lists'), ': list 0 (mostly past pictures) and list 1 (mostly future). Each block then says which entry it predicts from with a ', h('code', null, 'ref_idx'), '.'),
        h('p', null, 'Display order comes from the ', h('b', null, 'Picture Order Count'), ' (POC) in each slice header. H.264 drops old references with a sliding window unless the encoder sends explicit memory-management commands. HEVC instead lists the exact set of pictures to keep in every slice (the Reference Picture Set), which is more robust to lost frames.'),
        btn('Inspect a frame’s references', () => app.show('video'), has && v),
      ]],
      ['nal', 'NAL units, parameter sets and Exp-Golomb codes', [
        h('p', null, 'H.264 and HEVC bitstreams are a sequence of ', h('b', null, 'NAL units'), ' (Network Abstraction Layer). Each starts with a small header saying what it contains: a slice of picture data, an SEI message, or a parameter set. The ', h('b', null, 'SPS'), ' (sequence parameter set) holds picture size, profile and frame-numbering rules. The ', h('b', null, 'PPS'), ' (picture parameter set) holds entropy-coder and quantizer defaults. In MP4 these live in the ', h('code', null, 'avcC'), '/', h('code', null, 'hvcC'), ' box, and each sample is a list of length-prefixed NAL units.'),
        h('p', null, 'Header fields are mostly ', h('b', null, 'Exp-Golomb'), ' coded: small numbers get short codes. Try it:'),
        egWidget(),
        h('p', null, 'If the payload ever contains the bytes 00 00 0x (x ≤ 3), the encoder inserts an ', h('b', null, 'emulation prevention'), ' byte 03 so the data can’t be confused with a start code. Tap a NAL unit in the Video tab to see them highlighted.'),
      ]],
      ['mb', 'Macroblocks: prediction + residual', [
        h('p', null, 'H.264 cuts each picture into 16×16 ', h('b', null, 'macroblocks'), '. For each one the encoder picks a prediction:'),
        h('ul', null,
          h('li', null, h('b', null, 'Intra'), ': extrapolate from the already-decoded pixels above and to the left in one of up to nine directions, for the whole block (16×16) or for 4×4 / 8×8 pieces.'),
          h('li', null, h('b', null, 'Inter'), ': copy from a reference picture at a motion vector with quarter-pixel precision. The macroblock can be split so different parts move differently:'),
          h('li', null, h('b', null, 'Skip'), ': no data at all. Use the predicted motion vector and add nothing. In still areas most blocks are skipped, which costs almost zero bits.')),
        h('figure', { html: FIG_MB }),
        h('p', null, 'Motion vectors themselves are predicted from neighbours (the median of left, top and top-right), and only the difference (', h('code', null, 'mvd'), ') is coded. ', h('b', null, 'Direct'), ' mode in B-frames goes further and infers the motion entirely.'),
        h('p', null, 'What the prediction gets wrong is the ', h('b', null, 'residual'), '. It’s transformed (a DCT-like 4×4 or 8×8 integer transform), divided by a step size set by the ', h('b', null, 'quantization parameter'), ' (QP; +6 doubles the step), and mostly rounds to zero. Throwing away precision here is where the actual loss happens.'),
        h('figure', { html: FIG_RESIDUAL }),
        btn('Explore macroblocks in your file', () => app.show('video'), has && isH264),
      ]],
      ['entropy', 'Entropy coding: CAVLC and CABAC', [
        h('p', null, 'Finally every syntax element (macroblock types, motion vector differences, coefficients) is losslessly compressed. ', h('b', null, 'CAVLC'), ' uses variable-length code tables that adapt to context: for example, the table for a block’s coefficient count depends on how many coefficients its neighbours had.'),
        h('p', null, h('b', null, 'CABAC'), ' turns each element into binary decisions and codes them with an ', h('b', null, 'arithmetic coder'), ' using ~1,000 adaptive probability models chosen by context (“was the block to the left skipped?”). It can spend a fraction of a bit on a very likely decision, saving roughly 10–15% over CAVLC. HEVC uses only CABAC.'),
        h('p', null, 'The macroblock inspector shows how many bits each block cost. Try the “Bits” overlay: detailed, moving areas light up, while flat or static areas cost almost nothing.'),
      ]],
      ['hevc', 'What HEVC changes', [
        h('p', null, 'HEVC (H.265) replaces fixed macroblocks with ', h('b', null, 'Coding Tree Units'), ' up to 64×64 that split recursively into coding units, prediction units and transform units of many sizes. It adds 35 intra directions, merge mode (copy a neighbour’s motion), larger transforms, a second in-loop filter (SAO) and parallelism tools (tiles, wavefronts). Typically it needs about half the bitrate of H.264 for the same quality.'),
      ]],
      ['audio', 'How AAC audio works', [
        h('p', null, 'AAC splits audio into frames of 1024 samples (about 21 ms at 48 kHz). Each frame is transformed with an ', h('b', null, 'MDCT'), ' into 1024 frequency coefficients, using a 2048-sample window that overlaps half of the previous frame. The overlaps cancel, so there are no clicks at frame edges.'),
        h('p', null, 'The coefficients are grouped into about 49 ', h('b', null, 'scalefactor bands'), ', narrow at low frequencies and wide at high ones, like the ear’s critical bands. A psychoacoustic model decides how coarsely each band can be quantized before the noise becomes audible. High bands are often dropped entirely, which sets the bandwidth.'),
        h('p', null, 'For sudden sounds the encoder switches to ', h('b', null, 'eight short windows'), ' so quantization noise can’t spread before the attack (“pre-echo”). Stereo pairs can be coded as Mid/Side when the channels are similar. HE-AAC adds SBR, which rebuilds the high frequencies from a few hints.'),
        btn('See your file’s audio frames', () => app.show('audio'), has && a),
      ]],
    ];
    this.el.innerHTML = '';
    const wrap = h('div.learn');
    wrap.append(h('h1', { style: { fontSize: '22px', margin: '18px 0 4px' } }, 'How video files work'),
      h('p.dim', null, has ? 'Buttons jump to the matching part of the file you opened.' : 'Open a file (or the demo) and the buttons below will jump to the matching part of it.'),
      h('div.toc.card', null, sections.map(([id, title]) => h('a', { href: '#learn/' + id, onclick: e => { e.preventDefault(); document.getElementById(id).scrollIntoView({ behavior: 'smooth' }); } }, title))));
    for (const [id, title, body] of sections) wrap.append(h('h2', { id }, title), ...body);
    wrap.append(h('p.small.dim', { style: { marginTop: '30px' } }, 'Demo clip: Big Buck Bunny © Blender Foundation, CC BY 3.0.'));
    this.el.append(wrap);
  }
}

function egWidget() {
  const out = h('div.small', { style: { marginTop: '6px' } });
  const inp = h('input', { type: 'number', min: 0, max: 100000, value: 9 });
  const upd = () => {
    const v = Math.max(0, Math.min(100000, parseInt(inp.value) || 0));
    const bits = (v + 1).toString(2), z = bits.length - 1;
    out.innerHTML = '';
    out.append(h('div.bitsview', { style: { fontSize: '18px' } }, h('span.lz', null, '0'.repeat(z)), h('span.on', null, bits)),
      h('div', null, `${z} leading zero${z === 1 ? '' : 's'}, then ${v} + 1 = ${v + 1} in binary (${bits}). Total ${2 * z + 1} bits.`),
      h('div.dim', null, `Signed values (se) map 0, 1, −1, 2, −2… onto 0, 1, 2, 3, 4…, so ${v} as se(v) means ${v % 2 ? (v + 1) / 2 : -(v / 2)}.`));
  };
  inp.addEventListener('input', upd);
  upd();
  return h('div.card.egwidget', null, h('label', null, 'Value: ', inp), out);
}
