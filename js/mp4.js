// ISO Base Media File Format (MP4 / MOV / M4A / 3GP / fMP4) box parser.
import { Bits, Syn, fourccStr, hexFmt } from './bits.js';
import * as H264 from './h264.js';
import * as HEVC from './hevc.js';
import { parseAsc } from './aac.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta', 'mvex', 'moof', 'traf', 'mfra',
  'tref', 'sinf', 'schi', 'iprp', 'ipco', 'gmhd', 'tapt', 'rinf', 'strk', 'strd', 'ilst', 'wave', 'meco', 'clip', 'matt', 'imap',
  'edts', 'tapt', 'iinf.child']);
const MAX_INLINE = 64 * 1024 * 1024;

const LANG = v => v === 0x7fff || v === 0 ? 'und' : String.fromCharCode(((v >> 10) & 31) + 0x60, ((v >> 5) & 31) + 0x60, (v & 31) + 0x60);
const MAC_EPOCH = Date.UTC(1904, 0, 1);
const dateFmt = v => v ? new Date(MAC_EPOCH + v * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '0 (not set)';
const flagsFmt = names => v => {
  const on = Object.entries(names).filter(([b]) => v & +b).map(([, n]) => n);
  return '0x' + v.toString(16).padStart(6, '0') + (on.length ? ` (${on.join(', ')})` : '');
};
const durFmt = (ts) => v => ts ? `${v} (${fmtTime(v / ts)})` : `${v}`;
export const fmtTime = t => {
  if (!isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return (m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : `${s.toFixed(3)} s`);
};
const HANDLERS = { vide: 'video', soun: 'audio', hint: 'hint', meta: 'metadata', text: 'text', sbtl: 'subtitles', subt: 'subtitles', tmcd: 'timecode', clcp: 'closed captions', mdir: 'iTunes metadata', mdta: 'QuickTime metadata keys' };
const BRANDS = { isom: 'ISO base media', iso2: 'ISO v2', iso4: 'ISO v4', iso5: 'ISO v5 (fragments)', iso6: 'ISO v6', mp41: 'MP4 v1', mp42: 'MP4 v2', avc1: 'AVC', 'qt  ': 'QuickTime', M4A: 'iTunes audio', 'M4A ': 'iTunes audio', 'M4V ': 'iTunes video', M4VP: 'iTunes video', dash: 'MPEG-DASH', msdh: 'DASH media segment', cmfc: 'CMAF', heic: 'HEIF image', mif1: 'HEIF image', '3gp4': '3GPP', '3gp5': '3GPP', hvc1: 'HEVC', av01: 'AV1' };

// Parse a whole file: returns { boxes: [...] }
export async function parseFile(file, readBytes) {
  const root = { type: 'file', start: 0, size: file.size, children: [], isRoot: true };
  const ctx = { tracks: [], file, qt: false };
  let off = 0, n = 0;
  while (off + 8 <= file.size && n++ < 100000) {
    const h = await readBytes(off, 16);
    const hdr = readHeader(h, 0, file.size - off);
    if (!hdr) { root.children.push({ type: '????', start: off, size: file.size - off, hdr: 0, error: 'Not a valid box header – the rest of the file is unparsed', children: [] }); break; }
    const node = { type: hdr.type, start: off, size: hdr.size, hdr: hdr.hdr, children: [], parent: root };
    if (hdr.type === 'mdat' || hdr.size > MAX_INLINE) ctx.hasMdat = true;
    if (hdr.type !== 'mdat' && hdr.size <= MAX_INLINE) {
      const buf = await readBytes(off, hdr.size);
      parseBoxBody(node, buf, 0, ctx);
    } else if (hdr.type === 'mdat') {
      node.fields = [{ name: 'data', v: `${(hdr.size - hdr.hdr).toLocaleString()} bytes of media samples`, s: 0, l: 0, kind: 'derived', note: 'Frames and audio packets live here. The sample tables in moov (or trun in moof) say where each one starts.' }];
    } else {
      node.fields = [{ name: 'data', v: 'box too large to load', s: 0, l: 0, kind: 'derived' }];
    }
    if (!node.src) node.src = new Bits(new Uint8Array(0), off + hdr.hdr);
    root.children.push(node);
    if (hdr.size < 8) break;
    off += hdr.size;
  }
  ctx.root = root;
  return { root, ctx };
}

export function readHeader(buf, p, maxSize, strict = true) {
  if (p + 8 > buf.length) return null;
  let size = ((buf[p] << 24) >>> 0) + (buf[p + 1] << 16) + (buf[p + 2] << 8) + buf[p + 3];
  const tb = buf.subarray(p + 4, p + 8);
  if (strict) for (const c of tb) if (c < 32 && c !== 0) return null;
  const type = fourccStr(tb);
  let hdr = 8;
  if (size === 1) {
    if (p + 16 > buf.length) return null;
    size = (((buf[p + 8] << 24) >>> 0) + (buf[p + 9] << 16) + (buf[p + 10] << 8) + buf[p + 11]) * 4294967296 +
      (((buf[p + 12] << 24) >>> 0) + (buf[p + 13] << 16) + (buf[p + 14] << 8) + buf[p + 15]);
    hdr = 16;
  } else if (size === 0) size = maxSize;
  if (size < hdr || size > maxSize + 0) { if (size > maxSize) size = maxSize; if (size < hdr) return null; }
  if (type === 'uuid') hdr += 16;
  return { size, type, hdr };
}

// Parse `node` whose bytes start at buf[p]. node.start is its file offset.
function parseBoxBody(node, buf, p, ctx) {
  const end = p + node.size;
  const payload = buf.subarray(p + node.hdr, Math.min(end, buf.length));
  const bits = new Bits(payload, node.start + node.hdr);
  const s = new Syn(bits);
  node.fieldsBase = node.start + node.hdr;
  node.fields = s.root;
  node.src = bits;
  let childOff = null;
  const dec = DECODERS[node.type];
  try {
    if (node.type === 'uuid') node.uuid = hexFmt(buf.subarray(p + 8, p + 24));
    if (dec) childOff = dec(s, node, ctx);
    else if (CONTAINERS.has(node.type)) childOff = 0;
    else if (node.parent && node.parent.type === 'ilst') childOff = 0;
    else if (payload.length) s.bytes('payload', Math.min(payload.length, 4096), hexFmt);
  } catch (e) { s.error(e); }
  if (childOff != null) parseChildren(node, buf, p + node.hdr + childOff, end, ctx);
}

function parseChildren(node, buf, p, end, ctx) {
  let guard = 0;
  while (p + 8 <= end && guard++ < 100000) {
    const fileOff = node.start + (p - (end - node.size));
    const hdr = readHeader(buf, p, end - p, node.type !== 'ilst');
    if (!hdr) {
      // QuickTime allows a 4-byte zero terminator at the end of some containers
      if (end - p >= 4 && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 0 && end - p < 8) break;
      node.children.push({ type: '????', start: fileOff, size: end - p, hdr: 0, children: [], parent: node, error: 'Unparseable data inside this box' });
      break;
    }
    const child = { type: hdr.type, start: fileOff, size: hdr.size, hdr: hdr.hdr, children: [], parent: node };
    node.children.push(child);
    parseBoxBody(child, buf, p, ctx);
    p += hdr.size;
  }
}

function fullbox(s, flagNames) {
  const version = s.u('version', 8);
  const flags = s.u('flags', 24, flagNames ? flagsFmt(flagNames) : (v => '0x' + v.toString(16).padStart(6, '0')));
  return { version, flags };
}

function matrix(s) {
  s.group('matrix', () => {
    const m = [];
    for (let i = 0; i < 9; i++) m.push(i % 3 === 2 ? s.r.s(32) / 2 ** 30 : s.r.s(32) / 65536);
    let rot = Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI);
    if (rot < 0) rot += 360;
    s.calc('values', `[${m.slice(0, 3).map(x => +x.toFixed(3)).join(' ')}] [${m.slice(3, 6).map(x => +x.toFixed(3)).join(' ')}] [${m.slice(6).map(x => +x.toFixed(3)).join(' ')}]`);
    s.calc('→ rotation', rot + '°', null, 'Phones record sensor-native video and use this matrix to tell players how to rotate it');
  });
}

// Find a descendant by path, e.g. find(trak, 'mdia/minf/stbl/stsd')
export function find(node, path) {
  let cur = node;
  for (const t of path.split('/')) {
    if (!cur || !cur.children) return null;
    cur = cur.children.find(c => c.type === t);
  }
  return cur || null;
}
export const findAll = (node, type) => node.children ? node.children.filter(c => c.type === type) : [];

// Generic "large table" helper: reads n rows into typed arrays and records a table field.
function readTable(s, name, n, cols, readers) {
  const arrays = cols.map(() => new Float64Array(n));
  const start = s.r.pos;
  const rowBits = [];
  for (let i = 0; i < n; i++) for (let c = 0; c < cols.length; c++) arrays[c][i] = readers[c]();
  void rowBits;
  const rowLen = n ? (s.r.pos - start) / n : 0;
  s.table(name, cols, n, i => cols.map((_, c) => arrays[c][i]), { s: start, l: s.r.pos - start, rowBits: rowLen });
  return arrays;
}

const sampleFlagsFmt = v => {
  const dep = (v >> 24) & 3, nonSync = (v >> 16) & 1;
  return '0x' + v.toString(16).padStart(8, '0') + ` (${nonSync ? 'non-sync' : 'sync'}${dep === 2 ? ', depends on no other sample (I)' : dep === 1 ? ', depends on others' : ''})`;
};

// ---------------------------------------------------------------------------
const DECODERS = {
  ftyp(s, node) {
    const b = s.fourcc('major_brand', v => BRANDS[v] ? `${v} (${BRANDS[v]})` : v);
    s.u('minor_version', 32);
    const list = [];
    s.group('compatible_brands', () => { while (s.r.left >= 32) list.push(s.fourcc('brand', v => BRANDS[v] ? `${v} (${BRANDS[v]})` : v)); });
    node.summary = [b, ...list].join(' ');
    return null;
  },
  styp(s, node) { return DECODERS.ftyp(s, node); },
  free() { return null }, skip() { return null }, wide() { return null },
  mvhd(s, node, ctx) {
    const { version } = fullbox(s);
    const w = version === 1 ? 'u64' : 'u';
    s[w]('creation_time', ...(w === 'u' ? [32, dateFmt] : [dateFmt]));
    s[w]('modification_time', ...(w === 'u' ? [32, dateFmt] : [dateFmt]));
    const ts = s.u('timescale', 32, v => `${v} units per second`);
    ctx.movieTimescale = ts;
    const d = version === 1 ? s.u64('duration', durFmt(ts)) : s.u('duration', 32, durFmt(ts));
    s.fixed('rate', 32, 16); s.fixed('volume', 16, 8);
    s.bytes('reserved', 10);
    matrix(s);
    s.bytes('pre_defined', 24);
    s.u('next_track_ID', 32);
    node.summary = fmtTime(d / ts);
    return null;
  },
  tkhd(s, node, ctx) {
    const { version } = fullbox(s, { 1: 'enabled', 2: 'in movie', 4: 'in preview', 8: 'aspect ratio' });
    if (version === 1) { s.u64('creation_time', dateFmt); s.u64('modification_time', dateFmt); }
    else { s.u('creation_time', 32, dateFmt); s.u('modification_time', 32, dateFmt); }
    const id = s.u('track_ID', 32);
    s.u('reserved', 32);
    if (version === 1) s.u64('duration', durFmt(ctx.movieTimescale)); else s.u('duration', 32, durFmt(ctx.movieTimescale));
    s.bytes('reserved', 8);
    s.s('layer', 16); s.s('alternate_group', 16); s.fixed('volume', 16, 8); s.u('reserved', 16);
    matrix(s);
    const w = s.ufixed('width', 32, 16), h = s.ufixed('height', 32, 16);
    node.summary = `track ${id}` + (w ? `, ${w}×${h}` : '');
    return null;
  },
  mdhd(s, node, ctx) {
    const { version } = fullbox(s);
    if (version === 1) { s.u64('creation_time', dateFmt); s.u64('modification_time', dateFmt); }
    else { s.u('creation_time', 32, dateFmt); s.u('modification_time', 32, dateFmt); }
    const ts = s.u('timescale', 32, v => `${v} units per second`);
    s.note('All sample timestamps in this track are counted in these units');
    const d = version === 1 ? s.u64('duration', durFmt(ts)) : s.u('duration', 32, durFmt(ts));
    s.u('language', 16, v => `${LANG(v & 0x7fff)}`);
    s.u('pre_defined', 16);
    ctx.curTrack && (ctx.curTrack.timescale = ts, ctx.curTrack.duration = d);
    node.summary = `${ts} Hz, ${fmtTime(d / ts)}`;
    return null;
  },
  hdlr(s, node, ctx) {
    fullbox(s);
    s.fourcc('pre_defined', v => v === 'mhlr' ? 'mhlr (QuickTime media handler)' : v === 'dhlr' ? 'dhlr (QuickTime data handler)' : JSON.stringify(v));
    const t = s.fourcc('handler_type', v => HANDLERS[v] ? `${v} (${HANDLERS[v]})` : v);
    s.bytes('reserved', 12);
    if (s.r.left >= 8) {
      // ISO: null-terminated UTF-8. QuickTime: Pascal string (length byte first).
      const first = s.r.peek(8);
      if (first && first === (s.r.left >> 3) - 1) { s.u('name_length', 8); s.str('name', first); }
      else s.cstr('name');
    }
    if (node.parent && node.parent.type === 'mdia' && ctx.curTrack) ctx.curTrack.handler = t;
    node.summary = HANDLERS[t] || t;
    return null;
  },
  trak(s, node, ctx) {
    ctx.curTrack = { node, id: 0, handler: null };
    ctx.tracks.push(ctx.curTrack);
    return 0;
  },
  vmhd(s) { fullbox(s); s.u('graphicsmode', 16); s.u('opcolor', 48, v => v.toString(16)); return null; },
  smhd(s) { fullbox(s); s.fixed('balance', 16, 8); s.u('reserved', 16); return null; },
  nmhd(s) { fullbox(s); return null; },
  dref(s) { fullbox(s); s.u('entry_count', 32); return s.r.pos >> 3; },
  'url '(s) { fullbox(s, { 1: 'media is in this file' }); if (s.r.left >= 8) s.cstr('location'); return null; },
  'alis'(s) { fullbox(s, { 1: 'media is in this file' }); return null; },
  stsd(s, node, ctx) {
    fullbox(s);
    s.u('entry_count', 32);
    s.note('One sample description per codec configuration; most tracks have exactly one');
    return s.r.pos >> 3;
  },
  // ---- sample tables
  stts(s, node, ctx) {
    fullbox(s);
    const n = s.u('entry_count', 32);
    const [count, delta] = readTable(s, 'entries', n, ['sample_count', 'sample_delta'], [() => s.r.u(32), () => s.r.u(32)]);
    node.data = { count, delta };
    const total = count.reduce((a, b) => a + b, 0);
    node.summary = `${total} samples` + (n === 1 ? `, all ${delta[0]} long` : `, ${n} runs`);
    s.calc('→ total samples', total);
    return null;
  },
  ctts(s, node) {
    const { version } = fullbox(s);
    const n = s.u('entry_count', 32);
    const [count, off] = readTable(s, 'entries', n, ['sample_count', 'sample_offset'], [() => s.r.u(32), () => version ? s.r.s(32) : s.r.u(32)]);
    node.data = { count, off };
    s.note('Composition offsets: how much later than its decode time each frame is displayed. Needed whenever B-frames reorder pictures');
    return null;
  },
  cslg(s) {
    const { version } = fullbox(s);
    const f = version ? (n) => s.u64(n) : (n) => s.s(n, 32);
    f('compositionToDTSShift'); f('leastDecodeToDisplayDelta'); f('greatestDecodeToDisplayDelta'); f('compositionStartTime'); f('compositionEndTime');
    return null;
  },
  stss(s, node) {
    fullbox(s);
    const n = s.u('entry_count', 32);
    const [num] = readTable(s, 'sync samples', n, ['sample_number'], [() => s.r.u(32)]);
    node.data = { num };
    node.summary = `${n} keyframes`;
    return null;
  },
  stps(s, node) { return DECODERS.stss(s, node); },
  sdtp(s, node, ctx) {
    fullbox(s);
    const n = s.r.left >> 3;
    const fmt = (v) => ['?', 'yes', 'no', '?'][v];
    const [lead, dep, depd, red] = readTable(s, 'entries', n, ['is_leading', 'depends_on', 'is_depended_on', 'has_redundancy'],
      [() => s.r.u(2), () => s.r.u(2), () => s.r.u(2), () => s.r.u(2)]);
    void lead; void red; void fmt;
    node.data = { dep, depd };
    s.note('depends_on 2 = intra frame; is_depended_on 2 = nothing references this frame (safe to drop)');
    return null;
  },
  stsc(s, node) {
    fullbox(s);
    const n = s.u('entry_count', 32);
    const [first, per, desc] = readTable(s, 'entries', n, ['first_chunk', 'samples_per_chunk', 'sample_description_index'],
      [() => s.r.u(32), () => s.r.u(32), () => s.r.u(32)]);
    node.data = { first, per, desc };
    s.note('Run-length table: starting at first_chunk, every chunk holds samples_per_chunk samples (until the next entry)');
    return null;
  },
  stsz(s, node) {
    fullbox(s);
    const fixed = s.u('sample_size', 32, v => v ? `${v} (every sample is this size)` : '0 (sizes listed below)');
    const n = s.u('sample_count', 32);
    if (fixed) node.data = { fixed, n };
    else { const [size] = readTable(s, 'sizes', n, ['entry_size'], [() => s.r.u(32)]); node.data = { size, n }; }
    node.summary = `${n} samples`;
    return null;
  },
  stz2(s, node) {
    fullbox(s); s.u('reserved', 24);
    const fs = s.u('field_size', 8), n = s.u('sample_count', 32);
    const [size] = readTable(s, 'sizes', n, ['entry_size'], [() => s.r.u(fs)]);
    node.data = { size, n };
    return null;
  },
  stco(s, node) {
    fullbox(s);
    const n = s.u('entry_count', 32);
    const [off] = readTable(s, 'chunk offsets', n, ['chunk_offset'], [() => s.r.u(32)]);
    node.data = { off };
    node.summary = `${n} chunks`;
    s.note('Absolute file position of each chunk (a run of consecutive samples in mdat)');
    return null;
  },
  co64(s, node) {
    fullbox(s);
    const n = s.u('entry_count', 32);
    const [off] = readTable(s, 'chunk offsets', n, ['chunk_offset'], [() => s.r.u(32) * 4294967296 + s.r.u(32)]);
    node.data = { off };
    node.summary = `${n} chunks`;
    return null;
  },
  sgpd(s) {
    const { version } = fullbox(s);
    const t = s.fourcc('grouping_type');
    let dl = 0; if (version === 1) dl = s.u('default_length', 32);
    if (version >= 2) s.u('default_sample_description_index', 32);
    const n = s.u('entry_count', 32);
    for (let i = 0; i < n && s.r.left > 0; i++) {
      let len = dl; if (version === 1 && !dl) len = s.u('description_length', 32);
      if (t === 'roll' || t === 'prol') s.s(`roll_distance[${i}]`, 16);
      else if (len) s.bytes(`entry[${i}]`, len);
      else break;
    }
    return null;
  },
  sbgp(s) {
    const { version } = fullbox(s);
    s.fourcc('grouping_type'); if (version === 1) s.u('grouping_type_parameter', 32);
    const n = s.u('entry_count', 32);
    readTable(s, 'entries', n, ['sample_count', 'group_description_index'], [() => s.r.u(32), () => s.r.u(32)]);
    return null;
  },
  elst(s, node) {
    const { version } = fullbox(s);
    const n = s.u('entry_count', 32);
    const list = [];
    for (let i = 0; i < n; i++) {
      s.group(`edit ${i}`, () => {
        const e = {};
        e.dur = version ? s.u64('segment_duration') : s.u('segment_duration', 32);
        e.mt = version ? s.r.s(32) * 4294967296 + s.r.u(32) : s.s('media_time', 32, v => v === -1 ? '-1 (empty edit: a gap)' : v);
        if (version) s.calc('media_time', e.mt);
        e.rate = s.fixed('media_rate', 32, 16);
        list.push(e);
      });
    }
    node.data = { list };
    s.note('Edit lists map the track timeline onto the movie timeline. A media_time > 0 skips the start of the media, e.g. AAC encoder delay or B-frame reorder delay');
    return null;
  },
  // ---- sample entries
  avc1: visualEntry, avc3: visualEntry, hvc1: visualEntry, hev1: visualEntry, mp4v: visualEntry, av01: visualEntry,
  vp09: visualEntry, vp08: visualEntry, encv: visualEntry, dvh1: visualEntry, dvhe: visualEntry, jpeg: visualEntry, apcn: visualEntry,
  apch: visualEntry, apcs: visualEntry, apco: visualEntry, ap4h: visualEntry, mjpa: visualEntry, 'raw ': visualEntry, s263: visualEntry,
  mp4a: audioEntry, enca: audioEntry, 'ac-3': audioEntry, 'ec-3': audioEntry, Opus: audioEntry, fLaC: audioEntry, '.mp3': audioEntry,
  alac: audioEntry, lpcm: audioEntry, sowt: audioEntry, twos: audioEntry, ulaw: audioEntry, alaw: audioEntry, samr: audioEntry, 'ipcm': audioEntry,
  tmcd(s, node, ctx) {
    if (node.parent && node.parent.type === 'tref') return trefType(s);
    s.bytes('reserved', 6); s.u('data_reference_index', 16); s.u('reserved', 32); s.u('flags', 32); s.u('timescale', 32); s.u('frame_duration', 32); s.u('number_of_frames', 8); s.u('reserved', 8); return s.r.pos >> 3; },
  avcC(s, node, ctx) {
    const tr = ctx.curTrack;
    s.u('configurationVersion', 8);
    s.u('AVCProfileIndication', 8, v => `${v} (${H264.profileName(v)})`);
    s.u('profile_compatibility', 8, v => '0x' + v.toString(16));
    s.u('AVCLevelIndication', 8, v => `${v} (Level ${v / 10})`);
    s.u('reserved', 6);
    const ls = s.u('lengthSizeMinusOne', 2, v => `${v} (NAL units in samples are prefixed by a ${v + 1}-byte length)`) + 1;
    const state = { sps: {}, pps: {} };
    const cfg = { lengthSize: ls, sps: [], pps: [], state, codec: 'h264', raw: s.r.b };
    s.u('reserved', 3);
    const ns = s.u('numOfSequenceParameterSets', 5);
    for (let i = 0; i < ns; i++) {
      const len = s.u('sequenceParameterSetLength', 16);
      const start = s.r.pos >> 3;
      const nal = H264.parseNal(s.r.b.subarray(start, start + len), s.r.fileOffset(start), state);
      s.push({ name: `sequenceParameterSetNALUnit (SPS)`, s: s.r.pos, l: len * 8, kind: 'group', children: nal.fields, src: nal.bits });
      s.r.skip(len * 8);
      cfg.sps.push(nal.sps);
    }
    const np = s.u('numOfPictureParameterSets', 8);
    for (let i = 0; i < np; i++) {
      const len = s.u('pictureParameterSetLength', 16);
      const start = s.r.pos >> 3;
      const nal = H264.parseNal(s.r.b.subarray(start, start + len), s.r.fileOffset(start), state);
      s.push({ name: `pictureParameterSetNALUnit (PPS)`, s: s.r.pos, l: len * 8, kind: 'group', children: nal.fields, src: nal.bits });
      s.r.skip(len * 8);
      cfg.pps.push(nal.pps);
    }
    if (s.r.left >= 32) s.bytes('extensions (chroma format, bit depth, SPS-ext)', s.r.left >> 3);
    if (cfg.sps[0]) cfg.codecString = H264.codecString(cfg.sps[0]);
    if (tr) tr.codecConfig = cfg;
    node.summary = cfg.codecString;
    return null;
  },
  hvcC(s, node, ctx) {
    const tr = ctx.curTrack;
    s.u('configurationVersion', 8);
    s.u('general_profile_space', 2); s.f('general_tier_flag');
    s.u('general_profile_idc', 5, v => `${v} (${HEVC.profileName(v)})`);
    s.u('general_profile_compatibility_flags', 32, v => '0x' + v.toString(16));
    s.bytes('general_constraint_indicator_flags', 6);
    s.u('general_level_idc', 8, v => `${v} (Level ${v / 30})`);
    s.u('reserved', 4); s.u('min_spatial_segmentation_idc', 12);
    s.u('reserved', 6); s.u('parallelismType', 2);
    s.u('reserved', 6); s.u('chromaFormat', 2);
    s.u('reserved', 5); s.u('bitDepthLumaMinus8', 3);
    s.u('reserved', 5); s.u('bitDepthChromaMinus8', 3);
    s.u('avgFrameRate', 16); s.u('constantFrameRate', 2); s.u('numTemporalLayers', 3); s.f('temporalIdNested');
    const ls = s.u('lengthSizeMinusOne', 2, v => `${v} (${v + 1}-byte NAL length prefix)`) + 1;
    const state = { sps: {}, pps: {}, vps: {} };
    const cfg = { lengthSize: ls, sps: [], pps: [], state, codec: 'hevc', raw: s.r.b };
    const na = s.u('numOfArrays', 8);
    for (let a = 0; a < na; a++) {
      s.group(`array ${a}`, () => {
        s.f('array_completeness'); s.f('reserved');
        s.u('NAL_unit_type', 6, v => `${v} (${HEVC.nalName(v)})`);
        const nn = s.u('numNalus', 16);
        for (let i = 0; i < nn; i++) {
          const len = s.u('nalUnitLength', 16);
          const start = s.r.pos >> 3;
          const nal = HEVC.parseNal(s.r.b.subarray(start, start + len), s.r.fileOffset(start), state);
          s.push({ name: `nalUnit (${HEVC.nalName(nal.type)})`, s: s.r.pos, l: len * 8, kind: 'group', children: nal.fields, src: nal.bits });
          s.r.skip(len * 8);
          if (nal.sps) cfg.sps.push(nal.sps);
          if (nal.pps) cfg.pps.push(nal.pps);
        }
      });
    }
    if (cfg.sps[0]) cfg.codecString = HEVC.codecString(cfg.sps[0]);
    if (tr) tr.codecConfig = cfg;
    node.summary = cfg.codecString;
    return null;
  },
  esds(s, node, ctx) {
    fullbox(s);
    parseDescriptors(s, ctx, node);
    return null;
  },
  pasp(s, node) { const h = s.u('hSpacing', 32), v = s.u('vSpacing', 32); node.summary = `${h}:${v}`; s.note('Pixel aspect ratio: 1:1 means square pixels'); return null; },
  clap(s) { for (const n of ['cleanApertureWidthN', 'cleanApertureWidthD', 'cleanApertureHeightN', 'cleanApertureHeightD', 'horizOffN', 'horizOffD', 'vertOffN', 'vertOffD']) s.u(n, 32); return null; },
  colr(s, node) {
    const t = s.fourcc('colour_type', v => ({ nclx: 'nclx (coded ISO/IEC 23001-8 values)', nclc: 'nclc (QuickTime)', prof: 'prof (ICC profile)', rICC: 'rICC (restricted ICC)' }[v] || v));
    if (t === 'nclx' || t === 'nclc') {
      const p = s.u('colour_primaries', 16, v => `${v} (${H264.COLOUR_PRIMARIES[v] || '?'})`);
      s.u('transfer_characteristics', 16, v => `${v} (${H264.TRANSFER[v] || '?'})`);
      s.u('matrix_coefficients', 16, v => `${v} (${H264.MATRIX[v] || '?'})`);
      if (t === 'nclx') s.f('full_range_flag');
      node.summary = H264.COLOUR_PRIMARIES[p] || '';
    } else if (s.r.left) s.bytes('ICC_profile', s.r.left >> 3);
    return null;
  },
  btrt(s) { s.u('bufferSizeDB', 32); s.u('maxBitrate', 32, v => `${(v / 1000).toFixed(0)} kbit/s`); s.u('avgBitrate', 32, v => `${(v / 1000).toFixed(0)} kbit/s`); return null; },
  fiel(s) { s.u('fields', 8, v => v === 1 ? '1 (progressive)' : `${v} (interlaced)`); s.u('detail', 8); return null; },
  gama(s) { s.ufixed('gamma', 32, 16); return null; },
  dOps(s) {
    s.u('Version', 8); s.u('OutputChannelCount', 8); s.u('PreSkip', 16, v => `${v} samples (decoder delay)`); s.u('InputSampleRate', 32);
    s.s('OutputGain', 16); s.u('ChannelMappingFamily', 8); return null;
  },
  dac3(s) {
    s.u('fscod', 2, v => `${v} (${[48000, 44100, 32000][v] || '?'} Hz)`); s.u('bsid', 5); s.u('bsmod', 3);
    s.u('acmod', 3, v => `${v} (${['1+1', '1/0', '2/0', '3/0', '2/1', '3/1', '2/2', '3/2'][v]})`); s.f('lfeon');
    s.u('bit_rate_code', 5); s.u('reserved', 5); return null;
  },
  dfLa(s) { fullbox(s); s.bytes('metadata blocks', s.r.left >> 3); return null; },
  chan(s) { fullbox(s); s.u('mChannelLayoutTag', 32, v => '0x' + v.toString(16)); s.u('mChannelBitmap', 32); s.u('mNumberChannelDescriptions', 32); return null; },
  // ---- fragments
  mehd(s) { const { version } = fullbox(s); version ? s.u64('fragment_duration') : s.u('fragment_duration', 32); return null; },
  trex(s, node, ctx) {
    fullbox(s);
    const t = { id: s.u('track_ID', 32), desc: s.u('default_sample_description_index', 32), dur: s.u('default_sample_duration', 32), size: s.u('default_sample_size', 32), flags: s.u('default_sample_flags', 32, sampleFlagsFmt) };
    (ctx.trex ||= {})[t.id] = t;
    return null;
  },
  mfhd(s, node) { fullbox(s); const n = s.u('sequence_number', 32); node.summary = `#${n}`; return null; },
  moof(s, node, ctx) { ctx.curMoof = node; return 0; },
  traf(s, node, ctx) { ctx.curTraf = node.data = { moof: ctx.curMoof }; return 0; },
  tfhd(s, node, ctx) {
    const { flags } = fullbox(s, { 1: 'base-data-offset', 2: 'sample-description-index', 8: 'default-duration', 0x10: 'default-size', 0x20: 'default-flags', 0x10000: 'duration-is-empty', 0x20000: 'default-base-is-moof' });
    const t = { flags, id: s.u('track_ID', 32) };
    if (flags & 1) t.base = s.u64('base_data_offset');
    if (flags & 2) t.desc = s.u('sample_description_index', 32);
    if (flags & 8) t.dur = s.u('default_sample_duration', 32);
    if (flags & 0x10) t.size = s.u('default_sample_size', 32);
    if (flags & 0x20) t.sflags = s.u('default_sample_flags', 32, sampleFlagsFmt);
    node.data = t; node.summary = `track ${t.id}`;
    return null;
  },
  tfdt(s, node) { const { version } = fullbox(s); node.data = { t: version ? s.u64('baseMediaDecodeTime') : s.u('baseMediaDecodeTime', 32) }; return null; },
  trun(s, node) {
    const { version, flags } = fullbox(s, { 1: 'data-offset', 4: 'first-sample-flags', 0x100: 'duration', 0x200: 'size', 0x400: 'flags', 0x800: 'composition-offset' });
    const n = s.u('sample_count', 32);
    const d = { n, boxFlags: flags };
    if (flags & 1) d.dataOffset = s.s('data_offset', 32, v => `${v} (relative to the moof start, unless base_data_offset is set)`);
    if (flags & 4) d.firstFlags = s.u('first_sample_flags', 32, sampleFlagsFmt);
    const cols = [], rd = [];
    if (flags & 0x100) { cols.push('duration'); rd.push(() => s.r.u(32)); }
    if (flags & 0x200) { cols.push('size'); rd.push(() => s.r.u(32)); }
    if (flags & 0x400) { cols.push('flags'); rd.push(() => s.r.u(32)); }
    if (flags & 0x800) { cols.push('composition_offset'); rd.push(() => version ? s.r.s(32) : s.r.u(32)); }
    const arrs = cols.length ? readTable(s, 'samples', n, cols, rd) : [];
    cols.forEach((c, i) => d[c] = arrs[i]);
    node.data = d; node.summary = `${n} samples`;
    return null;
  },
  sidx(s, node) {
    const { version } = fullbox(s);
    s.u('reference_ID', 32); const ts = s.u('timescale', 32);
    if (version) { s.u64('earliest_presentation_time', durFmt(ts)); s.u64('first_offset'); }
    else { s.u('earliest_presentation_time', 32, durFmt(ts)); s.u('first_offset', 32); }
    s.u('reserved', 16);
    const n = s.u('reference_count', 16);
    readTable(s, 'references', n, ['reference_type', 'referenced_size', 'subsegment_duration', 'starts_with_SAP', 'SAP_type', 'SAP_delta_time'],
      [() => s.r.u(1), () => s.r.u(31), () => s.r.u(32), () => s.r.u(1), () => s.r.u(3), () => s.r.u(28)]);
    s.note('Segment index: lets a streaming player jump to the right byte range for a given time');
    node.summary = `${n} subsegments`;
    return null;
  },
  tfra(s) {
    const { version } = fullbox(s); s.u('track_ID', 32); s.u('reserved', 26);
    const lt = s.u('length_size_of_traf_num', 2) + 1, lr = s.u('length_size_of_trun_num', 2) + 1, ls = s.u('length_size_of_sample_num', 2) + 1;
    const n = s.u('number_of_entry', 32);
    readTable(s, 'entries', n, ['time', 'moof_offset', 'traf_number', 'trun_number', 'sample_number'],
      [() => version ? s.r.u(32) * 4294967296 + s.r.u(32) : s.r.u(32), () => version ? s.r.u(32) * 4294967296 + s.r.u(32) : s.r.u(32), () => s.r.u(lt * 8), () => s.r.u(lr * 8), () => s.r.u(ls * 8)]);
    return null;
  },
  mfro(s) { fullbox(s); s.u('size', 32); return null; },
  // ---- metadata
  meta(s, node) {
    // ISO meta is a FullBox; QuickTime meta is a plain container.
    const next = s.r.left >= 64 ? fourccStr(s.r.b.subarray(4, 8)) : '';
    if (next === 'hdlr' || next === 'keys' || next === 'ilst') return 0;
    fullbox(s);
    return 4;
  },
  keys(s, node) {
    fullbox(s);
    const n = s.u('entry_count', 32);
    const keys = [];
    for (let i = 0; i < n; i++) {
      const sz = s.r.u(32); s.r.u(32);
      keys.push(s.str(`key[${i + 1}]`, sz - 8));
    }
    node.data = { keys };
    return null;
  },
  data(s, node) {
    const t = s.u('type_indicator', 32, v => `${v} (${{ 0: 'binary', 1: 'UTF-8', 2: 'UTF-16', 13: 'JPEG', 14: 'PNG', 21: 'integer', 22: 'unsigned', 23: 'float32' }[v & 0xffffff] ?? 'other'})`);
    s.u('locale', 32);
    const n = s.r.left >> 3;
    if ((t & 0xffffff) === 1) node.summary = s.str('value', n);
    else if ((t & 0xffffff) === 21 && n <= 4 && n > 0) node.summary = String(s.s('value', n * 8));
    else if (((t & 0xffffff) === 22 || (t & 0xffffff) === 0) && n <= 4 && n > 0) node.summary = String(s.u('value', n * 8));
    else s.bytes('value', n);
    if (node.parent && node.summary && !node.parent.summary) node.parent.summary = node.summary;
    return null;
  },
  '©xyz'(s, node) { const n = s.u('length', 16); s.u('language', 16); node.summary = s.str('location (ISO 6709)', n); return null; },
  chpl(s) { fullbox(s); s.u('reserved', 32); const n = s.u('chapter_count', 8); for (let i = 0; i < n; i++) s.group(`chapter ${i}`, () => { s.u64('start (100ns)'); const l = s.u('title_length', 8); s.str('title', l); }); return null; },
  pssh(s) {
    const { version } = fullbox(s);
    s.bytes('SystemID', 16, v => {
      const h = [...v].map(b => b.toString(16).padStart(2, '0')).join('');
      return h + ({ edef8ba979d64acea3c827dcd51d21ed: ' (Widevine)', '9a04f07998404286ab92e65be0885f95': ' (PlayReady)', '94ce86fb07ff4f43adb893d2fa968ca2': ' (FairPlay)', '1077efecc0b24d02ace33c1e52e2fb4b': ' (W3C Common)' }[h] || '');
    });
    if (version > 0) { const k = s.u('KID_count', 32); for (let i = 0; i < k; i++) s.bytes('KID', 16); }
    const n = s.u('DataSize', 32); if (n) s.bytes('Data', n);
    s.note('DRM: information the license system needs to decrypt this content');
    return null;
  },
  frma(s, node) { node.summary = s.fourcc('data_format'); return null; },
  schm(s) { fullbox(s); s.fourcc('scheme_type', v => ({ cenc: 'cenc (AES-CTR)', cbcs: 'cbcs (AES-CBC pattern)' }[v] || v)); s.u('scheme_version', 32, v => '0x' + v.toString(16)); return null; },
  tenc(s) { const { version } = fullbox(s); s.u('reserved', 8); if (version) { s.u('default_crypt_byte_block', 4); s.u('default_skip_byte_block', 4); } else s.u('reserved', 8); s.u('default_isProtected', 8); s.u('default_Per_Sample_IV_Size', 8); s.bytes('default_KID', 16); return null; },
  // tref children: lists of track IDs
  chap: trefType, hint: trefType, cdsc: trefType, sync: trefType, vdep: trefType, tmcd_ref: trefType, font: trefType, subt: trefType, fall: trefType, folw: trefType, scpt: trefType, vplx: trefType,
  // Apple
  load(s) { s.u('preload_start_time', 32); s.u('preload_duration', 32); s.u('preload_flags', 32); s.u('default_hints', 32); return null; },
  tapt() { return 0; },
  clef(s) { fullbox(s); s.ufixed('width', 32, 16); s.ufixed('height', 32, 16); return null; },
  prof(s) { fullbox(s); s.ufixed('width', 32, 16); s.ufixed('height', 32, 16); return null; },
  enof(s) { fullbox(s); s.ufixed('width', 32, 16); s.ufixed('height', 32, 16); return null; },
  // iTunes item atoms are containers handled in parseBoxBody (parent ilst)
};

function trefType(s) {
  const ids = [];
  while (s.r.left >= 32) ids.push(s.u('track_ID', 32));
  return null;
}

function visualEntry(s, node, ctx) {
  s.bytes('reserved', 6);
  s.u('data_reference_index', 16);
  s.u('pre_defined / version', 16); s.u('reserved / revision', 16);
  s.fourcc('vendor', v => v === 'appl' ? 'appl (Apple)' : JSON.stringify(v));
  s.u('temporal_quality', 32); s.u('spatial_quality', 32);
  const w = s.u('width', 16), h = s.u('height', 16);
  s.ufixed('horizresolution', 32, 16, v => v + ' dpi'); s.ufixed('vertresolution', 32, 16, v => v + ' dpi');
  s.u('reserved (data size)', 32);
  s.u('frame_count', 16, v => `${v} (frames per sample)`);
  const len = s.r.peek(8);
  s.u('compressorname length', 8);
  s.str('compressorname', 31);
  void len;
  s.u('depth', 16, v => v === 0x18 ? '0x0018 (24-bit colour)' : '0x' + v.toString(16));
  s.s('pre_defined', 16);
  const tr = ctx.curTrack;
  if (tr && !tr.sampleEntry) tr.sampleEntry = { type: node.type, width: w, height: h, node };
  node.summary = `${w}×${h}`;
  return s.r.pos >> 3;
}

function audioEntry(s, node, ctx) {
  s.bytes('reserved', 6);
  s.u('data_reference_index', 16);
  const ver = s.u('version (QuickTime) / reserved', 16);
  s.u('revision_level', 16); s.u('vendor', 32);
  const ch = s.u('channelcount', 16);
  const bits = s.u('samplesize', 16, v => v + ' bits');
  s.s('compression_id', 16); s.u('packet_size', 16);
  const sr = s.ufixed('samplerate', 32, 16, v => v + ' Hz');
  if (ver === 1) { s.u('samples_per_packet', 32); s.u('bytes_per_packet', 32); s.u('bytes_per_frame', 32); s.u('bytes_per_sample', 32); }
  else if (ver === 2) { s.u('sizeOfStructOnly', 32); s.calc('audioSampleRate', 'f64'); s.r.skip(64); s.u('numAudioChannels', 32); s.u('always7F000000', 32); s.u('constBitsPerChannel', 32); s.u('formatSpecificFlags', 32); s.u('constBytesPerAudioPacket', 32); s.u('constLPCMFramesPerAudioPacket', 32); }
  const tr = ctx.curTrack;
  if (tr && !tr.sampleEntry) tr.sampleEntry = { type: node.type, channels: ch, sampleRate: sr, bits, node };
  node.summary = `${ch} ch, ${sr} Hz`;
  return s.r.pos >> 3;
}

const OTI = { 0x20: 'MPEG-4 Visual', 0x21: 'H.264', 0x23: 'HEVC', 0x40: 'MPEG-4 Audio (AAC)', 0x66: 'MPEG-2 AAC Main', 0x67: 'MPEG-2 AAC LC', 0x69: 'MPEG-2 Audio (MP3)', 0x6b: 'MPEG-1 Audio (MP3)', 0x6c: 'JPEG', 0xa5: 'AC-3', 0xa6: 'E-AC-3', 0xad: 'Opus', 0xdd: 'Vorbis' };
const TAGS = { 3: 'ES_Descriptor', 4: 'DecoderConfigDescriptor', 5: 'DecoderSpecificInfo', 6: 'SLConfigDescriptor' };

function parseDescriptors(s, ctx, node, endBit = s.r.end, depth = 0) {
  while (s.r.pos + 16 <= endBit && depth < 6) {
    const tag = s.r.peek(8);
    s.group(TAGS[tag] || `descriptor tag ${tag}`, () => {
      s.u('tag', 8, v => `${v} (${TAGS[v] || '?'})`);
      let size = 0, b, n = 0;
      const st = s.r.pos;
      do { b = s.r.u(8); size = (size << 7) | (b & 0x7f); } while (b & 0x80 && ++n < 4);
      s.push({ name: 'size', v: size, s: st, l: s.r.pos - st, kind: 'varint', note: '7 bits per byte; high bit means “more bytes follow”' });
      const end = Math.min(s.r.pos + size * 8, endBit);
      if (tag === 3) {
        s.u('ES_ID', 16);
        const dep = s.f('streamDependenceFlag'), url = s.f('URL_Flag'), ocr = s.f('OCRstreamFlag');
        s.u('streamPriority', 5);
        if (dep) s.u('dependsOn_ES_ID', 16);
        if (url) { const l = s.u('URLlength', 8); s.str('URLstring', l); }
        if (ocr) s.u('OCR_ES_Id', 16);
        parseDescriptors(s, ctx, node, end, depth + 1);
      } else if (tag === 4) {
        const oti = s.u('objectTypeIndication', 8, v => `0x${v.toString(16)} (${OTI[v] || '?'})`);
        s.u('streamType', 6, v => `${v} (${{ 4: 'visual', 5: 'audio' }[v] || '?'})`); s.f('upStream'); s.f('reserved');
        s.u('bufferSizeDB', 24); s.u('maxBitrate', 32, v => `${(v / 1000).toFixed(0)} kbit/s`); s.u('avgBitrate', 32, v => `${(v / 1000).toFixed(0)} kbit/s`);
        if (ctx.curTrack) ctx.curTrack.oti = oti;
        parseDescriptors(s, ctx, node, end, depth + 1);
      } else if (tag === 5) {
        const start = s.r.pos >> 3;
        const bytes = s.r.b.subarray(start, start + size);
        if (ctx.curTrack && (ctx.curTrack.oti === 0x40 || ctx.curTrack.oti === 0x67 || ctx.curTrack.oti === 0x66)) {
          const asc = parseAsc(bytes, s.r.fileOffset(start));
          s.push({ name: 'AudioSpecificConfig', s: s.r.pos, l: size * 8, kind: 'group', children: asc.fields, src: new Bits(bytes, s.r.fileOffset(start)) });
          ctx.curTrack.codecConfig = { codec: 'aac', asc, raw: bytes.slice() };
          node.summary = asc.name;
        } else s.bytes('decoder specific info', size);
      } else if (tag === 6) {
        s.u('predefined', 8, v => v === 2 ? '2 (MP4 default)' : v);
      }
      s.r.pos = end;
    });
  }
}

// ---------------------------------------------------------------------------
// Tracks: collect what the UI needs

export function describeTracks(root, ctx) {
  const tracks = [];
  for (const t of ctx.tracks) {
    const trak = t.node;
    const tkhd = find(trak, 'tkhd');
    const id = tkhd ? tkhd.fields.find(f => f.name === 'track_ID').v : 0;
    const se = t.sampleEntry;
    tracks.push({
      id, trak, handler: t.handler, timescale: t.timescale, duration: t.duration,
      type: t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : 'other',
      codec: se ? se.type : '?', entry: se, config: t.codecConfig,
    });
  }
  return tracks;
}
