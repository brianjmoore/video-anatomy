// H.264 macroblock layer parser (CABAC + CAVLC). Decodes the entropy-coded
// slice data far enough to recover every macroblock's type, partitions,
// reference indices, motion vectors, QP, coded block pattern, residual
// coefficients and bit cost. It does not reconstruct pixels.
import { Bits, Overrun } from './bits.js';
import * as TB from './h264tables.js';

const ZZ4 = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const ZZ8 = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
// 4x4 block index (spec order) -> x,y in 4x4 units
const BX = [], BY = [];
for (let b = 0; b < 16; b++) { BX[b] = ((b >> 2) & 1) * 2 + (b & 1); BY[b] = (b >> 3) * 2 + ((b >> 1) & 1); }
const INTRA_4x4_NAMES = ['vertical ↓', 'horizontal →', 'DC (flat)', 'diagonal ↙', 'diagonal ↘', 'vertical-right', 'horizontal-down', 'vertical-left', 'horizontal-up'];
const I16_MODES = ['vertical', 'horizontal', 'DC', 'plane'];
const CHROMA_MODES = ['DC', 'horizontal', 'vertical', 'plane'];

// mb kinds
const K_I4 = 1, K_I8 = 2, K_I16 = 3, K_PCM = 4, K_P = 5, K_B = 6, K_PSKIP = 7, K_BSKIP = 8, K_BDIRECT = 9;
const isIntraK = k => k >= K_I4 && k <= K_PCM;

// Partition tables in 4x4 units: [x, y, w, h]
const P16x16 = [[0, 0, 4, 4]], P16x8 = [[0, 0, 4, 2], [0, 2, 4, 2]], P8x16 = [[0, 0, 2, 4], [2, 0, 2, 4]];
const P_TYPES = [
  { name: 'P_L0_16x16', parts: P16x16, pred: ['L0'] }, { name: 'P_L0_L0_16x8', parts: P16x8, pred: ['L0', 'L0'] },
  { name: 'P_L0_L0_8x16', parts: P8x16, pred: ['L0', 'L0'] }, { name: 'P_8x8', sub: true }, { name: 'P_8x8ref0', sub: true, ref0: true },
];
const B_TYPES = [{ name: 'B_Direct_16x16', direct: true }, { name: 'B_L0_16x16', parts: P16x16, pred: ['L0'] },
  { name: 'B_L1_16x16', parts: P16x16, pred: ['L1'] }, { name: 'B_Bi_16x16', parts: P16x16, pred: ['Bi'] }];
{
  const pairs = [['L0', 'L0'], ['L1', 'L1'], ['L0', 'L1'], ['L1', 'L0'], ['L0', 'Bi'], ['L1', 'Bi'], ['Bi', 'L0'], ['Bi', 'L1'], ['Bi', 'Bi']];
  for (let t = 4; t <= 21; t++) {
    const k = t - 4, pr = pairs[k >> 1], shape = k & 1 ? '8x16' : '16x8';
    B_TYPES[t] = { name: `B_${pr[0]}_${pr[1]}_${shape}`, parts: k & 1 ? P8x16 : P16x8, pred: pr };
  }
  B_TYPES[22] = { name: 'B_8x8', sub: true };
}
const P_SUB = [
  { name: 'P_L0_8x8', parts: [[0, 0, 2, 2]], pred: 'L0' }, { name: 'P_L0_8x4', parts: [[0, 0, 2, 1], [0, 1, 2, 1]], pred: 'L0' },
  { name: 'P_L0_4x8', parts: [[0, 0, 1, 2], [1, 0, 1, 2]], pred: 'L0' }, { name: 'P_L0_4x4', parts: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]], pred: 'L0' },
];
const S88 = [[0, 0, 2, 2]], S84 = [[0, 0, 2, 1], [0, 1, 2, 1]], S48 = [[0, 0, 1, 2], [1, 0, 1, 2]], S44 = [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]];
const B_SUB = [
  { name: 'B_Direct_8x8', direct: true }, { name: 'B_L0_8x8', parts: S88, pred: 'L0' }, { name: 'B_L1_8x8', parts: S88, pred: 'L1' },
  { name: 'B_Bi_8x8', parts: S88, pred: 'Bi' }, { name: 'B_L0_8x4', parts: S84, pred: 'L0' }, { name: 'B_L0_4x8', parts: S48, pred: 'L0' },
  { name: 'B_L1_8x4', parts: S84, pred: 'L1' }, { name: 'B_L1_4x8', parts: S48, pred: 'L1' }, { name: 'B_Bi_8x4', parts: S84, pred: 'Bi' },
  { name: 'B_Bi_4x8', parts: S48, pred: 'Bi' }, { name: 'B_L0_4x4', parts: S44, pred: 'L0' }, { name: 'B_L1_4x4', parts: S44, pred: 'L1' },
  { name: 'B_Bi_4x4', parts: S44, pred: 'Bi' },
];
const usesL = (pred, l) => pred === 'Bi' || pred === (l ? 'L1' : 'L0');

// ---------------------------------------------------------------------------
// VLC tables for CAVLC

function buildVlc(lens, codes, startVal = 0) {
  const m = new Map();
  for (let i = 0; i < lens.length; i++) if (lens[i]) m.set(lens[i] * 65536 + codes[i], i + startVal);
  return m;
}
const CT_VLC = [0, 1, 2, 3].map(t => buildVlc(TB.COEFF_TOKEN_LEN[t], TB.COEFF_TOKEN_BITS[t]));
const CT_DC_VLC = buildVlc(TB.CHROMA_DC_COEFF_TOKEN_LEN, TB.CHROMA_DC_COEFF_TOKEN_BITS);
const TZ_VLC = TB.TOTAL_ZEROS_LEN.map((l, i) => buildVlc(l, TB.TOTAL_ZEROS_BITS[i]));
const TZ_DC_VLC = TB.CHROMA_DC_TOTAL_ZEROS_LEN.map((l, i) => buildVlc(l, TB.CHROMA_DC_TOTAL_ZEROS_BITS[i]));
const RUN_VLC = TB.RUN_LEN.map((l, i) => buildVlc(l, TB.RUN_BITS[i]));

function readVlc(r, map) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = code * 2 + r.bit();
    const v = map.get(len * 65536 + code);
    if (v !== undefined) return v;
  }
  throw new Error('invalid VLC code');
}

// ---------------------------------------------------------------------------
// CABAC arithmetic decoding engine (9.3.1.2, 9.3.3.2)

class Cabac {
  constructor(r) { this.r = r; this.st = new Uint8Array(1024); this.mps = new Uint8Array(1024); this.start(); }
  bitIn() { return this.r.pos < this.r.end ? this.r.bit() : 0; }
  start() { this.range = 510; this.offset = 0; for (let i = 0; i < 9; i++) this.offset = (this.offset << 1) | this.bitIn(); }
  initContexts(isI, idc, qp) {
    const tab = isI ? TB.CTX_INIT_I : TB.CTX_INIT_PB[idc];
    const q = Math.max(0, Math.min(51, qp));
    for (let i = 0; i < 1024; i++) {
      const m = tab[2 * i], n = tab[2 * i + 1];
      const pre = Math.max(1, Math.min(126, ((m * q) >> 4) + n));
      if (pre <= 63) { this.st[i] = 63 - pre; this.mps[i] = 0; } else { this.st[i] = pre - 64; this.mps[i] = 1; }
    }
  }
  d(ctx) {
    const s = this.st[ctx];
    const lps = TB.RANGE_LPS[s * 4 + ((this.range >> 6) & 3)];
    this.range -= lps;
    let bin;
    if (this.offset >= this.range) {
      bin = 1 - this.mps[ctx];
      this.offset -= this.range; this.range = lps;
      if (s === 0) this.mps[ctx] = 1 - this.mps[ctx];
      this.st[ctx] = TB.TRANS_LPS[s];
    } else {
      bin = this.mps[ctx];
      if (s < 62) this.st[ctx] = s + 1;
    }
    while (this.range < 256) { this.range <<= 1; this.offset = (this.offset << 1) | this.bitIn(); }
    return bin;
  }
  bypass() {
    this.offset = (this.offset << 1) | this.bitIn();
    if (this.offset >= this.range) { this.offset -= this.range; return 1; }
    return 0;
  }
  term() {
    this.range -= 2;
    if (this.offset >= this.range) return 1;
    while (this.range < 256) { this.range <<= 1; this.offset = (this.offset << 1) | this.bitIn(); }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Per-picture storage

class Pic {
  constructor(mbW, mbH) {
    const n = mbW * mbH;
    this.mbW = mbW; this.mbH = mbH; this.n = n;
    this.slice = new Int16Array(n).fill(-1);
    this.kind = new Uint8Array(n);
    this.cbp = new Uint8Array(n);       // luma bits 0-3, chroma << 4
    this.dc = new Uint8Array(n);        // CABAC coded_block_flag of DC blocks: 1 luma, 2 Cb, 4 Cr
    this.t8 = new Uint8Array(n);
    this.cpm = new Uint8Array(n);       // intra chroma pred mode
    this.qp = new Int8Array(n);
    this.nz = new Uint8Array(n * 16);   // luma total coeff per 4x4
    this.nzc = new Uint8Array(n * 8);   // chroma AC total coeff: [Cb 0..3, Cr 0..3]
    this.mv = new Int16Array(n * 16 * 4);
    this.ref = new Int8Array(n * 16 * 2).fill(-1);
    this.mvd = new Uint8Array(n * 16 * 4);
    this.noRefCtx = new Uint8Array(n * 16); // skip/direct/intra blocks don't count for ref_idx context
    this.imode = new Int8Array(n * 16).fill(-1);
  }
}

// ---------------------------------------------------------------------------

export async function parseSliceData(slices, state, frames, picIdx, opts = {}) {
  const first = slices[0].nal.slice;
  const sps = first.sps;
  if (!sps.frame_mbs_only_flag) throw new Error('interlaced (field/MBAFF) streams are not supported by the macroblock parser');
  if (sps.ChromaArrayType === 2 || sps.ChromaArrayType === 3) throw new Error('only 4:2:0 and monochrome are supported by the macroblock parser');
  const mbW = sps.width_mbs, mbH = sps.height_mbs;
  const pic = new Pic(mbW, mbH);
  const out = { mbW, mbH, mbs: new Array(mbW * mbH), counts: {}, decoded: 0, sliceStarts: [], entropy: first.pps.entropy_coding_mode_flag ? 'CABAC' : 'CAVLC', pic };
  const f = frames[picIdx];
  out.refs = f && f.refs ? f.refs : [[], []];
  // co-located picture for B direct prediction
  let col = null;
  if (first.type === 'B' && opts.getMotion && out.refs[1].length) {
    try { col = await opts.getMotion(out.refs[1][0]); } catch (e) { out.colError = e.message; }
  }
  let sliceNum = 0;
  for (const sl of slices) {
    const h = sl.nal.slice;
    if (!h || !h.pps) continue;
    out.sliceStarts.push(h.first_mb_in_slice);
    try {
      decodeSlice(sl, h, pic, out, sliceNum++, { frames, picIdx, col, trace: opts.traceAddr });
    } catch (e) {
      out.error = e instanceof Overrun ? 'ran out of data' : (e.message || String(e));
      break;
    }
  }
  for (const m of out.mbs) if (m) out.counts[m.cat] = (out.counts[m.cat] || 0) + 1;
  return out;
}

function decodeSlice(sl, h, pic, out, sliceNum, env) {
  const nal = sl.nal;
  const r = new Bits(nal.bits.b, nal.bits.base, nal.bits.map);
  r.pos = nal.sliceDataBit;
  const sps = h.sps, pps = h.pps;
  const cabac = !!pps.entropy_coding_mode_flag;
  const S = {
    r, h, sps, pps, pic, out, env, sliceNum, cabac,
    sliceType: h.type === 'SP' ? 'P' : h.type === 'SI' ? 'I' : h.type,
    qp: h.qp, prevQpDeltaNZ: 0, bitDepthY: sps.bit_depth_luma, bitDepthC: sps.bit_depth_chroma,
    qpBdOffset: 6 * (sps.bit_depth_luma - 8), chroma: sps.ChromaArrayType !== 0,
  };
  if (cabac) {
    r.alignTo();
    S.c = new Cabac(r);
    S.c.initContexts(S.sliceType === 'I', h.cabac_init_idc || 0, h.qp);
  }
  let addr = h.first_mb_in_slice;
  const total = pic.n;
  let more = true, prevSkipped = false;
  while (more && addr < total) {
    if (S.sliceType !== 'I') {
      if (!cabac) {
        const start = r.pos;
        const run = r.ue();
        prevSkipped = run > 0;
        for (let k = 0; k < run && addr < total; k++) {
          skipMb(S, addr, k === 0 ? r.pos - start : 0);
          addr++;
        }
        if (run > 0) { more = r.moreRbsp(); if (!more || addr >= total) break; }
      } else {
        const start = posOf(S);
        pic.slice[addr] = sliceNum;
        const skip = S.c.d((S.sliceType === 'B' ? 24 : 11) + skipCtx(S, addr));
        if (skip) {
          skipMb(S, addr, posOf(S) - start, true);
          prevSkipped = true;
          more = !S.c.term();
          addr++;
          continue;
        }
        prevSkipped = false;
      }
    }
    macroblock(S, addr);
    if (!cabac) more = r.moreRbsp();
    else more = !S.c.term();
    addr++;
  }
  void prevSkipped;
}

// Bit position in the slice data (for CABAC this includes the decoder's 9-bit look-ahead,
// a constant offset that cancels out when measuring per-macroblock cost).
const posOf = S => S.r.pos;

// ---------------------------------------------------------------------------
// Neighbour helpers

// Neighbouring 4x4 luma block at (cx, cy) (4x4 units relative to current MB, may be -1 or 4).
// Returns block index (mb*16 + y*4 + x) or -1 if unavailable.
function nbBlk(S, addr, cx, cy) {
  const pic = S.pic, W = pic.mbW;
  const mbx = addr % W, mby = (addr / W) | 0;
  const dx = cx < 0 ? -1 : cx > 3 ? 1 : 0, dy = cy < 0 ? -1 : 0;
  const nx = mbx + dx, ny = mby + dy;
  if (nx < 0 || nx >= W || ny < 0) return -1;
  const a = ny * W + nx;
  if (pic.slice[a] !== S.sliceNum) return -1;
  if (a > addr) return -1;
  return a * 16 + ((cy + 4) & 3) * 4 + ((cx + 4) & 3);
}
function nbMb(S, addr, dx, dy) {
  const pic = S.pic, W = pic.mbW;
  const mbx = addr % W + dx, mby = ((addr / W) | 0) + dy;
  if (mbx < 0 || mbx >= W || mby < 0) return -1;
  const a = mby * W + mbx;
  return pic.slice[a] === S.sliceNum && a < addr ? a : -1;
}

function skipCtx(S, addr) {
  let c = 0;
  const A = nbMb(S, addr, -1, 0), B = nbMb(S, addr, 0, -1);
  if (A >= 0 && S.pic.kind[A] !== K_PSKIP && S.pic.kind[A] !== K_BSKIP) c++;
  if (B >= 0 && S.pic.kind[B] !== K_PSKIP && S.pic.kind[B] !== K_BSKIP) c++;
  return c;
}

// ---------------------------------------------------------------------------
// Skipped macroblocks

function skipMb(S, addr, bits, isCabacSkip) {
  const pic = S.pic;
  pic.slice[addr] = S.sliceNum;
  resetMb(pic, addr);
  pic.qp[addr] = S.qp;
  S.prevQpDeltaNZ = 0;
  const m = newMbInfo(S, addr);
  m.bits = bits;
  if (S.sliceType === 'P') {
    pic.kind[addr] = K_PSKIP;
    const mv = pSkipMv(S, addr);
    setMotion(pic, addr, 0, 0, 4, 4, 0, 0, mv);
    for (let b = 0; b < 16; b++) pic.noRefCtx[addr * 16 + b] = 1;
    Object.assign(m, { cat: 'skip', name: 'P_Skip', desc: 'Skipped: no data coded. Copies a 16×16 block from the closest reference frame, using the predicted motion vector.' });
    m.parts = [{ x: 0, y: 0, w: 16, h: 16, pred: 'L0', ref: [0, -1], mv: [mv, null], inferred: true }];
  } else {
    pic.kind[addr] = K_BSKIP;
    for (let b = 0; b < 16; b++) pic.noRefCtx[addr * 16 + b] = 1;
    const parts = directMb(S, addr, [0, 1, 2, 3]);
    Object.assign(m, { cat: 'skip', name: 'B_Skip', desc: 'Skipped: no data coded. Motion is inferred (“direct” prediction) and there is no residual.' });
    m.parts = parts;
  }
  m.qp = S.qp;
  S.out.mbs[addr] = m; S.out.decoded++;
  void isCabacSkip;
}

function resetMb(pic, addr) {
  pic.nz.fill(0, addr * 16, addr * 16 + 16);
  pic.nzc.fill(0, addr * 8, addr * 8 + 8);
  pic.mv.fill(0, addr * 64, addr * 64 + 64);
  pic.ref.fill(-1, addr * 32, addr * 32 + 32);
  pic.mvd.fill(0, addr * 64, addr * 64 + 64);
  pic.noRefCtx.fill(0, addr * 16, addr * 16 + 16);
  pic.imode.fill(-1, addr * 16, addr * 16 + 16);
  pic.cbp[addr] = 0; pic.dc[addr] = 0; pic.t8[addr] = 0; pic.cpm[addr] = 0;
}

function newMbInfo(S, addr) {
  const W = S.pic.mbW;
  return { addr, x: addr % W, y: (addr / W) | 0, slice: S.sliceNum };
}

// Fill motion for a rectangle of 4x4 blocks in list l.
function setMotion(pic, addr, x, y, w, h, l, ref, mv) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const b = addr * 16 + j * 4 + i;
    pic.ref[b * 2 + l] = ref;
    pic.mv[b * 4 + l * 2] = mv ? mv[0] : 0; pic.mv[b * 4 + l * 2 + 1] = mv ? mv[1] : 0;
  }
}

// ---------------------------------------------------------------------------
// Motion vector prediction (8.4.1.3)

// Neighbour motion info. `mask` marks blocks of the current MB already decoded.
function mvInfo(S, addr, cx, cy, l, mask) {
  const pic = S.pic;
  if (cx >= 0 && cx < 4 && cy >= 0 && cy < 4) {
    if (!(mask & (1 << (cy * 4 + cx)))) return { avail: false, ref: -1, mv: [0, 0] };
    const b = addr * 16 + cy * 4 + cx;
    return { avail: true, ref: pic.ref[b * 2 + l], mv: [pic.mv[b * 4 + l * 2], pic.mv[b * 4 + l * 2 + 1]] };
  }
  const b = nbBlk(S, addr, cx, cy);
  if (b < 0) return { avail: false, ref: -1, mv: [0, 0] };
  const a = (b / 16) | 0;
  if (isIntraK(pic.kind[a])) return { avail: true, ref: -1, mv: [0, 0] };
  return { avail: true, ref: pic.ref[b * 2 + l], mv: [pic.mv[b * 4 + l * 2], pic.mv[b * 4 + l * 2 + 1]] };
}

function neighbours(S, addr, x, y, w, l, mask) {
  const A = mvInfo(S, addr, x - 1, y, l, mask);
  const B = mvInfo(S, addr, x, y - 1, l, mask);
  let C = mvInfo(S, addr, x + w, y - 1, l, mask);
  if (!C.avail) C = mvInfo(S, addr, x - 1, y - 1, l, mask);
  return [A, B, C];
}

const median = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

function mvp(S, addr, x, y, w, h, l, refIdx, mask) {
  let [A, B, C] = neighbours(S, addr, x, y, w, l, mask);
  if (w === 4 && h === 2) {
    if (y === 0 && B.ref === refIdx) return B.mv;
    if (y === 2 && A.ref === refIdx) return A.mv;
  } else if (w === 2 && h === 4) {
    if (x === 0 && A.ref === refIdx) return A.mv;
    if (x === 2 && C.ref === refIdx) return C.mv;
  }
  if (!B.avail && !C.avail && A.avail) { B = A; C = A; }
  const match = [A, B, C].filter(n => n.ref === refIdx);
  if (match.length === 1) return match[0].mv;
  return [median(A.mv[0], B.mv[0], C.mv[0]), median(A.mv[1], B.mv[1], C.mv[1])];
}

function pSkipMv(S, addr) {
  const A = mvInfo(S, addr, -1, 0, 0, 0), B = mvInfo(S, addr, 0, -1, 0, 0);
  if (!A.avail || !B.avail) return [0, 0];
  if (A.ref === 0 && A.mv[0] === 0 && A.mv[1] === 0) return [0, 0];
  if (B.ref === 0 && B.mv[0] === 0 && B.mv[1] === 0) return [0, 0];
  return mvp(S, addr, 0, 0, 4, 4, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Direct prediction for B_Skip / B_Direct_16x16 / B_Direct_8x8 (8.4.1.2)

const minPos = (x, y) => (x >= 0 && y >= 0 ? Math.min(x, y) : Math.max(x, y));

function colocated(S, addr, bx, by) {
  const col = S.env.col;
  if (!col) return null;
  if (S.sps.direct_8x8_inference_flag) { bx = bx < 2 ? 0 : 3; by = by < 2 ? 0 : 3; }
  const b = addr * 16 + by * 4 + bx;
  if (isIntraK(col.kind[addr])) return { mv: [0, 0], ref: -1, list: 0 };
  const r0 = col.ref[b * 2];
  if (r0 >= 0) return { mv: [col.mv[b * 4], col.mv[b * 4 + 1]], ref: r0, list: 0 };
  return { mv: [col.mv[b * 4 + 2], col.mv[b * 4 + 3]], ref: col.ref[b * 2 + 1], list: 1 };
}

// Derive direct motion for the given 8x8 quadrants; returns display partitions.
function directMb(S, addr, quads) {
  const pic = S.pic, h = S.h;
  const parts = [];
  const refs = S.out.refs, frames = S.env.frames;
  if (h.direct_spatial_mv_pred_flag) {
    if (!S.spatial || S.spatial.addr !== addr) {
      const ref = [0, 0], mv = [[0, 0], [0, 0]];
      for (let l = 0; l < 2; l++) {
        const [A, B, C] = neighbours(S, addr, 0, 0, 4, l, 0);
        ref[l] = minPos(A.ref, minPos(B.ref, C.ref));
      }
      let zero = false;
      if (ref[0] < 0 && ref[1] < 0) { ref[0] = ref[1] = 0; zero = true; }
      for (let l = 0; l < 2; l++) if (!zero && ref[l] >= 0) mv[l] = mvp(S, addr, 0, 0, 4, 4, l, ref[l], 0);
      S.spatial = { addr, ref, mv, zero };
    }
    const { ref, mv, zero } = S.spatial;
    for (const q of quads) {
      const qx = (q & 1) * 2, qy = (q >> 1) * 2;
      const pm = [null, null];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const bx = qx + i, by = qy + j;
        const c = colocated(S, addr, bx, by);
        const l1short = true;
        const colZero = c && l1short && c.ref === 0 && Math.abs(c.mv[0]) <= 1 && Math.abs(c.mv[1]) <= 1;
        for (let l = 0; l < 2; l++) {
          if (ref[l] < 0) { setMotion(pic, addr, bx, by, 1, 1, l, -1, null); continue; }
          const v = zero || (ref[l] === 0 && colZero) ? [0, 0] : mv[l];
          setMotion(pic, addr, bx, by, 1, 1, l, ref[l], v);
          if (i === 0 && j === 0) pm[l] = v;
        }
      }
      parts.push({ x: qx * 4, y: qy * 4, w: 8, h: 8, pred: 'direct', ref: [ref[0] >= 0 ? ref[0] : -1, ref[1] >= 0 ? ref[1] : -1], mv: pm, inferred: true, spatial: true });
    }
  } else {
    // temporal direct
    const cur = frames[S.env.picIdx];
    for (const q of quads) {
      const qx = (q & 1) * 2, qy = (q >> 1) * 2;
      const pm = [null, null]; let r0 = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const bx = qx + i, by = qy + j;
        const c = colocated(S, addr, bx, by) || { mv: [0, 0], ref: -1, list: 0 };
        let refIdxL0 = 0;
        if (c.ref >= 0 && S.env.col) {
          const target = S.env.col.refs[c.list] ? S.env.col.refs[c.list][c.ref] : undefined;
          const k = refs[0].indexOf(target);
          refIdxL0 = k >= 0 ? k : 0;
        }
        const pic0 = frames[refs[0][refIdxL0]], pic1 = frames[refs[1][0]];
        let mvL0, mvL1;
        const clip = (a, b, v) => Math.max(a, Math.min(b, v));
        if (!pic0 || !pic1 || !cur) { mvL0 = c.mv; mvL1 = [0, 0]; }
        else {
          const tb = clip(-128, 127, cur.poc - pic0.poc), td = clip(-128, 127, pic1.poc - pic0.poc);
          if (td === 0) { mvL0 = c.mv; mvL1 = [0, 0]; }
          else {
            const tx = Math.trunc((16384 + Math.abs(Math.trunc(td / 2))) / td);
            const dsf = clip(-1024, 1023, (tb * tx + 32) >> 6);
            mvL0 = [(dsf * c.mv[0] + 128) >> 8, (dsf * c.mv[1] + 128) >> 8];
            mvL1 = [mvL0[0] - c.mv[0], mvL0[1] - c.mv[1]];
          }
        }
        setMotion(pic, addr, bx, by, 1, 1, 0, refIdxL0, mvL0);
        setMotion(pic, addr, bx, by, 1, 1, 1, 0, mvL1);
        if (i === 0 && j === 0) { pm[0] = mvL0; pm[1] = mvL1; r0 = refIdxL0; }
      }
      parts.push({ x: qx * 4, y: qy * 4, w: 8, h: 8, pred: 'direct', ref: [r0, 0], mv: pm, inferred: true });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Macroblock layer

function macroblock(S, addr) {
  const pic = S.pic, r = S.r, cabac = S.cabac;
  const startBits = posOf(S);
  pic.slice[addr] = S.sliceNum;
  resetMb(pic, addr);
  const m = newMbInfo(S, addr);
  const tr = S.env.trace === addr ? (m.syntax = []) : null;
  const T = (name, v) => { if (tr) tr.push(`${name} = ${v}`); return v; };
  const st = S.sliceType;
  // --- mb_type
  let kind, info = null, i16 = -1;
  let mbType;
  if (cabac) mbType = cabacMbType(S, addr);
  else {
    mbType = r.ue();
    if (st === 'P') mbType = mbType < 5 ? { p: mbType } : { i: mbType - 5 };
    else if (st === 'B') mbType = mbType < 23 ? { b: mbType } : { i: mbType - 23 };
    else mbType = { i: mbType };
  }
  if (mbType.i !== undefined) {
    const t = mbType.i;
    if (t === 0) kind = K_I4;
    else if (t === 25) kind = K_PCM;
    else { kind = K_I16; i16 = t; }
    T('mb_type', t === 0 ? 'I_NxN' : t === 25 ? 'I_PCM' : `I_16x16_${(t - 1) % 4}_${((t - 1) >> 2) % 3}_${t >= 13 ? 1 : 0}`);
  } else if (mbType.p !== undefined) { kind = K_P; info = P_TYPES[mbType.p]; T('mb_type', info.name); }
  else { info = B_TYPES[mbType.b]; kind = info.direct ? K_BDIRECT : K_B; T('mb_type', info.name); }
  pic.kind[addr] = kind;

  // --- I_PCM
  if (kind === K_PCM) {
    if (cabac) { /* the arithmetic decoder has consumed exactly the bits up to here */ }
    r.alignTo();
    const n = 256 * S.bitDepthY + (S.chroma ? 2 * 64 * S.bitDepthC : 0);
    r.skip(n);
    if (cabac) S.c.start();
    pic.nz.fill(16, addr * 16, addr * 16 + 16); pic.nzc.fill(16, addr * 8, addr * 8 + 8);
    pic.cbp[addr] = 0x2f; pic.dc[addr] = 7;
    pic.qp[addr] = 0;
    S.prevQpDeltaNZ = 0;
    for (let b = 0; b < 16; b++) pic.noRefCtx[addr * 16 + b] = 1;
    Object.assign(m, { cat: 'intra', name: 'I_PCM', desc: 'Raw, uncompressed samples. Encoders only use this when compression would make the block bigger.', qp: 0, bits: posOf(S) - startBits });
    S.out.mbs[addr] = m; S.out.decoded++;
    return;
  }

  let t8 = 0, cbp = 0;
  const parts = [];
  if (isIntraK(kind)) {
    for (let b = 0; b < 16; b++) pic.noRefCtx[addr * 16 + b] = 1;
    if (kind === K_I4) {
      if (S.pps.transform_8x8_mode_flag) {
        t8 = cabac ? S.c.d(399 + t8Ctx(S, addr)) : r.bit();
        T('transform_size_8x8_flag', t8);
        if (t8) kind = pic.kind[addr] = K_I8;
      }
      const modes = [];
      if (kind === K_I4) {
        for (let b = 0; b < 16; b++) {
          const mode = intraMode(S, addr, BX[b], BY[b], tr, `[${b}]`);
          pic.imode[addr * 16 + BY[b] * 4 + BX[b]] = mode;
          modes.push(mode);
        }
        m.intraParts = 4;
      } else {
        for (let q = 0; q < 4; q++) {
          const qx = (q & 1) * 2, qy = (q >> 1) * 2;
          const mode = intraMode(S, addr, qx, qy, tr, `8x8[${q}]`);
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) pic.imode[addr * 16 + (qy + j) * 4 + qx + i] = mode;
          modes.push(mode);
        }
        m.intraParts = 8;
      }
      m.intraModes = modes.map((x, k) => `${k}: ${INTRA_4x4_NAMES[x]}`).join(', ');
    } else {
      const t = i16;
      cbp = ((t >= 13) ? 15 : 0) | ((((t - 1) >> 2) % 3) << 4);
      m.intraModes = `16×16 ${I16_MODES[(t - 1) % 4]}`;
    }
    if (S.chroma) {
      const cm = cabac ? cabacChromaMode(S, addr) : r.ue();
      pic.cpm[addr] = cm;
      T('intra_chroma_pred_mode', `${cm} (${CHROMA_MODES[cm]})`);
      m.intraModes += `; chroma ${CHROMA_MODES[cm]}`;
    }
  } else if (kind === K_BDIRECT) {
    for (let b = 0; b < 16; b++) pic.noRefCtx[addr * 16 + b] = 1;
  } else if (info.sub) {
    // ---- sub_mb_pred
    const subs = [];
    for (let q = 0; q < 4; q++) {
      let st2;
      if (cabac) st2 = st === 'P' ? cabacPSub(S) : cabacBSub(S);
      else st2 = r.ue();
      subs.push(st === 'P' ? P_SUB[st2] : B_SUB[st2]);
      T(`sub_mb_type[${q}]`, subs[q].name);
    }
    const refIdx = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let q = 0; q < 4; q++) if (subs[q].direct) {
      const qx = (q & 1) * 2, qy = (q >> 1) * 2;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) pic.noRefCtx[addr * 16 + (qy + j) * 4 + qx + i] = 1;
    }
    for (let l = 0; l < 2; l++) {
      const nAct = l ? S.h.num_ref_idx_l1_active : S.h.num_ref_idx_l0_active;
      for (let q = 0; q < 4; q++) {
        const sb = subs[q];
        if (sb.direct || !usesL(sb.pred, l)) { refIdx[l][q] = -1; continue; }
        const qx = (q & 1) * 2, qy = (q >> 1) * 2;
        if (nAct > 1 && !info.ref0) refIdx[l][q] = T(`ref_idx_l${l}[${q}]`, readRefIdx(S, addr, qx, qy, l, nAct));
        // store for context of later partitions
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) pic.ref[(addr * 16 + (qy + j) * 4 + qx + i) * 2 + l] = refIdx[l][q];
      }
    }
    const mvds = [[], []];
    for (let l = 0; l < 2; l++) for (let q = 0; q < 4; q++) {
      const sb = subs[q];
      mvds[l][q] = [];
      if (sb.direct || !usesL(sb.pred, l)) continue;
      const qx = (q & 1) * 2, qy = (q >> 1) * 2;
      for (const p of sb.parts) {
        const d = readMvd(S, addr, qx + p[0], qy + p[1], p[2], p[3], l);
        T(`mvd_l${l}[${q}]`, `(${d[0]}, ${d[1]})`);
        mvds[l][q].push(d);
      }
    }
    // MV derivation in partition order
    let mask = 0;
    let spatialParts = null;
    for (let q = 0; q < 4; q++) {
      const sb = subs[q], qx = (q & 1) * 2, qy = (q >> 1) * 2;
      if (sb.direct) {
        const dp = directMb(S, addr, [q]);
        parts.push(...dp);
        spatialParts = dp;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) mask |= 1 << ((qy + j) * 4 + qx + i);
        continue;
      }
      sb.parts.forEach((p, k) => {
        const px = qx + p[0], py = qy + p[1];
        const part = { x: px * 4, y: py * 4, w: p[2] * 4, h: p[3] * 4, pred: sb.pred, ref: [-1, -1], mv: [null, null], mvd: [null, null] };
        for (let l = 0; l < 2; l++) {
          if (!usesL(sb.pred, l)) { setMotion(pic, addr, px, py, p[2], p[3], l, -1, null); continue; }
          const ri = refIdx[l][q];
          const pred = mvp(S, addr, px, py, p[2], p[3], l, ri, mask);
          const d = mvds[l][q][k];
          const mv = [pred[0] + d[0], pred[1] + d[1]];
          setMotion(pic, addr, px, py, p[2], p[3], l, ri, mv);
          part.ref[l] = ri; part.mv[l] = mv; part.mvd[l] = d;
        }
        for (let j = 0; j < p[3]; j++) for (let i = 0; i < p[2]; i++) mask |= 1 << ((py + j) * 4 + px + i);
        parts.push(part);
      });
    }
    void spatialParts;
    m.subs = subs.map(s => s.name);
    S.noSub8x8 = subs.every(s => (s.direct ? S.sps.direct_8x8_inference_flag : s.parts.length === 1));
  } else {
    // ---- mb_pred (inter, not 8x8)
    const n = info.parts.length;
    const refIdx = [[0, 0], [0, 0]];
    for (let l = 0; l < 2; l++) {
      const nAct = l ? S.h.num_ref_idx_l1_active : S.h.num_ref_idx_l0_active;
      for (let k = 0; k < n; k++) {
        const p = info.parts[k];
        if (!usesL(info.pred[k], l)) { refIdx[l][k] = -1; continue; }
        if (nAct > 1) refIdx[l][k] = T(`ref_idx_l${l}[${k}]`, readRefIdx(S, addr, p[0], p[1], l, nAct));
        for (let j = 0; j < p[3]; j++) for (let i = 0; i < p[2]; i++) pic.ref[(addr * 16 + (p[1] + j) * 4 + p[0] + i) * 2 + l] = refIdx[l][k];
      }
    }
    const mvds = [[], []];
    for (let l = 0; l < 2; l++) for (let k = 0; k < n; k++) {
      if (!usesL(info.pred[k], l)) continue;
      const p = info.parts[k];
      mvds[l][k] = readMvd(S, addr, p[0], p[1], p[2], p[3], l);
      T(`mvd_l${l}[${k}]`, `(${mvds[l][k][0]}, ${mvds[l][k][1]})`);
    }
    let mask = 0;
    for (let k = 0; k < n; k++) {
      const p = info.parts[k];
      const part = { x: p[0] * 4, y: p[1] * 4, w: p[2] * 4, h: p[3] * 4, pred: info.pred[k], ref: [-1, -1], mv: [null, null], mvd: [null, null] };
      for (let l = 0; l < 2; l++) {
        if (!usesL(info.pred[k], l)) { setMotion(pic, addr, p[0], p[1], p[2], p[3], l, -1, null); continue; }
        const pred = mvp(S, addr, p[0], p[1], p[2], p[3], l, refIdx[l][k], mask);
        const d = mvds[l][k];
        const mv = [pred[0] + d[0], pred[1] + d[1]];
        setMotion(pic, addr, p[0], p[1], p[2], p[3], l, refIdx[l][k], mv);
        part.ref[l] = refIdx[l][k]; part.mv[l] = mv; part.mvd[l] = d;
      }
      for (let j = 0; j < p[3]; j++) for (let i = 0; i < p[2]; i++) mask |= 1 << ((p[1] + j) * 4 + p[0] + i);
      parts.push(part);
    }
  }
  if (kind === K_BDIRECT) parts.push(...directMb(S, addr, [0, 1, 2, 3]));

  // --- coded_block_pattern
  if (kind !== K_I16) {
    if (cabac) cbp = cabacCbp(S, addr);
    else {
      const code = r.ue();
      const intra = kind === K_I4 || kind === K_I8;
      cbp = S.chroma ? (intra ? TB.GOLOMB_TO_INTRA4X4_CBP : TB.GOLOMB_TO_INTER_CBP)[code] : (intra ? TB.GOLOMB_TO_INTRA4X4_CBP_GRAY : TB.GOLOMB_TO_INTER_CBP_GRAY)[code];
      if (cbp === undefined) throw new Error('invalid coded_block_pattern');
    }
    T('coded_block_pattern', cbp);
    pic.cbp[addr] = cbp;
    const noSub = info && info.sub ? S.noSub8x8 : true;
    if ((cbp & 15) && S.pps.transform_8x8_mode_flag && kind !== K_I4 && kind !== K_I8 && noSub &&
      (kind !== K_BDIRECT || S.sps.direct_8x8_inference_flag)) {
      t8 = cabac ? S.c.d(399 + t8Ctx(S, addr)) : r.bit();
      T('transform_size_8x8_flag', t8);
    }
  }
  pic.cbp[addr] = cbp;
  pic.t8[addr] = t8;

  // --- residual
  let qpDelta = 0;
  if ((cbp & 15) || (cbp >> 4) || kind === K_I16) {
    qpDelta = cabac ? cabacQpDelta(S) : r.se();
    T('mb_qp_delta', qpDelta);
    S.qp = ((S.qp + qpDelta + 52 + 2 * S.qpBdOffset) % (52 + S.qpBdOffset)) - S.qpBdOffset;
    S.prevQpDeltaNZ = qpDelta !== 0 ? 1 : 0;
    S.tr = tr;
    residual(S, addr, kind, cbp, t8, tr ? (m.blocks = []) : null);
    S.tr = null;
  } else S.prevQpDeltaNZ = 0;
  pic.qp[addr] = S.qp;

  // --- summary for display
  const intra = isIntraK(kind);
  const nm = kind === K_I4 ? 'I_4x4' : kind === K_I8 ? 'I_8x8' : kind === K_I16 ? 'I_16x16' : info.name;
  const desc = {
    [K_I4]: 'Intra: predicted from already-decoded pixels above and to the left, in sixteen 4×4 blocks, each with its own direction.',
    [K_I8]: 'Intra: predicted from neighbouring pixels in four 8×8 blocks.',
    [K_I16]: 'Intra: the whole 16×16 block is predicted from neighbouring pixels in one direction. Used for smooth areas.',
    [K_BDIRECT]: 'Direct: motion is inferred from neighbours and the co-located block; only the residual is coded.',
  }[kind] || (info.sub ? 'Split into four 8×8 sub-blocks, each with its own sub-type and motion.' :
    `Inter: ${parts.length} partition${parts.length > 1 ? 's' : ''}, each copying a block from a reference picture at the given motion vector.`);
  Object.assign(m, {
    cat: intra ? 'intra' : kind === K_BDIRECT ? 'direct' : st, name: nm, desc, parts: intra ? null : parts,
    qp: S.qp, qpDelta, cbp, t8x8: t8, bits: posOf(S) - startBits, bitPos: startBits,
  });
  S.out.mbs[addr] = m; S.out.decoded++;
}

// ---------------------------------------------------------------------------
// CABAC syntax elements

function cabacMbType(S, addr) {
  const c = S.c, pic = S.pic;
  if (S.sliceType === 'I') {
    let ctx = 0;
    const A = nbMb(S, addr, -1, 0), B = nbMb(S, addr, 0, -1);
    if (A >= 0 && pic.kind[A] !== K_I4 && pic.kind[A] !== K_I8) ctx++;
    if (B >= 0 && pic.kind[B] !== K_I4 && pic.kind[B] !== K_I8) ctx++;
    return { i: cabacIntraType(S, 3, ctx, true) };
  }
  if (S.sliceType === 'P') {
    if (c.d(14) === 0) {
      if (c.d(15) === 0) return { p: 3 * c.d(16) };
      return { p: 2 - c.d(17) };
    }
    return { i: cabacIntraType(S, 17, 0, false) };
  }
  // B
  let ctx = 0;
  const A = nbMb(S, addr, -1, 0), B = nbMb(S, addr, 0, -1);
  if (A >= 0 && pic.kind[A] !== K_BSKIP && pic.kind[A] !== K_BDIRECT) ctx++;
  if (B >= 0 && pic.kind[B] !== K_BSKIP && pic.kind[B] !== K_BDIRECT) ctx++;
  if (!c.d(27 + ctx)) return { b: 0 };
  if (!c.d(27 + 3)) return { b: 1 + c.d(27 + 5) };
  let bits = c.d(27 + 4) << 3;
  bits |= c.d(27 + 5) << 2; bits |= c.d(27 + 5) << 1; bits |= c.d(27 + 5);
  if (bits < 8) return { b: bits + 3 };
  if (bits === 13) return { i: cabacIntraType(S, 32, 0, false) };
  if (bits === 14) return { b: 11 };
  if (bits === 15) return { b: 22 };
  bits = (bits << 1) | c.d(27 + 5);
  return { b: bits - 4 };
}

function cabacIntraType(S, base, ctx, intraSlice) {
  const c = S.c;
  if (intraSlice) { if (!c.d(base + ctx)) return 0; base += 2; }
  else if (!c.d(base)) return 0;
  if (c.term()) return 25;
  let t = 1;
  t += 12 * c.d(base + 1);
  if (c.d(base + 2)) t += 4 + 4 * c.d(base + 2 + (intraSlice ? 1 : 0));
  t += 2 * c.d(base + 3 + (intraSlice ? 1 : 0));
  t += c.d(base + 3 + (intraSlice ? 2 : 0));
  return t;
}

function cabacPSub(S) {
  const c = S.c;
  if (c.d(21)) return 0;
  if (!c.d(22)) return 1;
  return c.d(23) ? 2 : 3;
}
function cabacBSub(S) {
  const c = S.c;
  if (!c.d(36)) return 0;
  if (!c.d(37)) return 1 + c.d(39);
  let t = 3;
  if (c.d(38)) { if (c.d(39)) return 11 + c.d(39); t += 4; }
  t += 2 * c.d(39);
  t += c.d(39);
  return t;
}

function t8Ctx(S, addr) {
  let n = 0;
  const A = nbMb(S, addr, -1, 0), B = nbMb(S, addr, 0, -1);
  if (A >= 0 && S.pic.t8[A]) n++;
  if (B >= 0 && S.pic.t8[B]) n++;
  return n;
}

function cabacChromaMode(S, addr) {
  const c = S.c, pic = S.pic;
  let ctx = 0;
  const A = nbMb(S, addr, -1, 0), B = nbMb(S, addr, 0, -1);
  if (A >= 0 && pic.cpm[A] !== 0) ctx++;
  if (B >= 0 && pic.cpm[B] !== 0) ctx++;
  if (!c.d(64 + ctx)) return 0;
  if (!c.d(67)) return 1;
  return c.d(67) ? 3 : 2;
}

function cabacCbp(S, addr) {
  const c = S.c, pic = S.pic;
  const A = nbMb(S, addr, -1, 0), B = nbMb(S, addr, 0, -1);
  // unavailable neighbours behave as if all luma bits are set and chroma is 0
  const cbpOf = a => a < 0 ? 0x0f : (pic.kind[a] === K_PCM ? 0x2f : pic.cbp[a]);
  const ca = cbpOf(A), cb = cbpOf(B);
  let cbp = 0;
  cbp |= c.d(73 + (!(ca & 2) ? 1 : 0) + 2 * (!(cb & 4) ? 1 : 0));
  cbp |= c.d(73 + (!(cbp & 1) ? 1 : 0) + 2 * (!(cb & 8) ? 1 : 0)) << 1;
  cbp |= c.d(73 + (!(ca & 8) ? 1 : 0) + 2 * (!(cbp & 1) ? 1 : 0)) << 2;
  cbp |= c.d(73 + (!(cbp & 4) ? 1 : 0) + 2 * (!(cbp & 2) ? 1 : 0)) << 3;
  if (S.chroma) {
    const ka = (ca >> 4) & 3, kb = (cb >> 4) & 3;
    let ctx = (ka > 0 ? 1 : 0) + (kb > 0 ? 2 : 0);
    if (c.d(77 + ctx)) {
      ctx = 4 + (ka === 2 ? 1 : 0) + (kb === 2 ? 2 : 0);
      cbp |= (1 + c.d(77 + ctx)) << 4;
    }
  }
  return cbp;
}

function cabacQpDelta(S) {
  const c = S.c;
  let ctx = S.prevQpDeltaNZ ? 1 : 0, k = 0;
  while (c.d(60 + ctx)) {
    ctx = k === 0 ? 2 : 3;
    if (++k > 102) throw new Error('mb_qp_delta overflow');
  }
  return k & 1 ? (k + 1) >> 1 : -(k >> 1);
}

function intraMode(S, addr, bx, by, tr, label) {
  const pic = S.pic, r = S.r;
  // predicted mode from neighbours A (left) and B (above)
  const modeOf = (cx, cy) => {
    let b;
    if (cx >= 0 && cy >= 0) b = addr * 16 + cy * 4 + cx;
    else { b = nbBlk(S, addr, cx, cy); if (b < 0) return -1; }
    const a = (b / 16) | 0;
    const k = pic.kind[a];
    if (!isIntraK(k)) return S.pps.constrained_intra_pred_flag ? -1 : 2;
    if (k !== K_I4 && k !== K_I8) return 2;
    return pic.imode[b];
  };
  const mA = modeOf(bx - 1, by), mB = modeOf(bx, by - 1);
  const pred = mA < 0 || mB < 0 ? 2 : Math.min(mA, mB);
  let prev, rem = 0;
  if (S.cabac) {
    prev = S.c.d(68);
    if (!prev) { rem = S.c.d(69); rem |= S.c.d(69) << 1; rem |= S.c.d(69) << 2; }
  } else {
    prev = r.bit();
    if (!prev) rem = r.u(3);
  }
  const mode = prev ? pred : rem < pred ? rem : rem + 1;
  if (tr) tr.push(`intra pred mode ${label}: ${prev ? `prev flag = 1 (use predicted ${pred})` : `rem = ${rem}`} → ${mode} ${INTRA_4x4_NAMES[mode]}`);
  return mode;
}

function readRefIdx(S, addr, x, y, l, nAct) {
  if (!S.cabac) {
    return nAct === 2 ? 1 - S.r.bit() : S.r.ue();
  }
  const pic = S.pic;
  const cond = (cx, cy) => {
    let b;
    if (cx >= 0 && cy >= 0) b = addr * 16 + cy * 4 + cx;
    else { b = nbBlk(S, addr, cx, cy); if (b < 0) return 0; }
    if (pic.noRefCtx[b]) return 0;
    return pic.ref[b * 2 + l] > 0 ? 1 : 0;
  };
  let ctx = cond(x - 1, y) + 2 * cond(x, y - 1);
  let ref = 0;
  while (S.c.d(54 + ctx)) {
    ref++;
    ctx = ref === 1 ? 4 : 5;
    if (ref > 32) throw new Error('ref_idx overflow');
  }
  return ref;
}

function readMvd(S, addr, x, y, w, h, l) {
  const pic = S.pic;
  let d;
  if (!S.cabac) d = [S.r.se(), S.r.se()];
  else {
    const absAt = (cx, cy, comp) => {
      let b;
      if (cx >= 0 && cy >= 0) b = addr * 16 + cy * 4 + cx;
      else { b = nbBlk(S, addr, cx, cy); if (b < 0) return 0; }
      return pic.mvd[b * 4 + l * 2 + comp];
    };
    d = [0, 1].map(comp => {
      const sum = absAt(x - 1, y, comp) + absAt(x, y - 1, comp);
      const base = comp ? 47 : 40;
      const c = S.c;
      if (!c.d(base + (sum < 3 ? 0 : sum <= 32 ? 1 : 2))) return 0;
      let v = 1, ctx = base + 3;
      while (v < 9 && c.d(ctx)) { if (v < 4) ctx++; v++; }
      if (v >= 9) {
        let k = 3;
        while (c.bypass()) { v += 1 << k; k++; if (k > 24) throw new Error('mvd overflow'); }
        while (k--) v += c.bypass() << k;
      }
      return c.bypass() ? -v : v;
    });
  }
  const ax = Math.min(Math.abs(d[0]), 70), ay = Math.min(Math.abs(d[1]), 70);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const b = addr * 16 + j * 4 + i;
    pic.mvd[b * 4 + l * 2] = ax; pic.mvd[b * 4 + l * 2 + 1] = ay;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Residual

function residual(S, addr, kind, cbp, t8, blocks) {
  const pic = S.pic;
  const intra = isIntraK(kind);
  const rec = (label, coeffs, scan, start, n) => {
    if (!blocks) return;
    const raster = new Int32Array(scan.length);
    for (let k = 0; k < n; k++) raster[scan[start + k]] = coeffs[k];
    blocks.push({ label, raster, size: scan.length === 64 ? 8 : 4, count: coeffs.filter(Boolean).length });
  };
  // luma
  if (kind === K_I16) {
    const co = block(S, addr, 0, 0, 0, 16, intra, 'lumaDC');
    rec('Luma DC (16 DC terms of the 4×4 blocks)', co, ZZ4, 0, 16);
  }
  for (let q = 0; q < 4; q++) {
    if (!(cbp & (1 << q))) continue;
    if (t8 && S.cabac) {
      const co = block(S, addr, q, 0, 5, 64, intra, 'luma8x8');
      const n = co.filter(Boolean).length;
      const qx = (q & 1) * 2, qy = (q >> 1) * 2;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) pic.nz[addr * 16 + (qy + j) * 4 + qx + i] = n;
      rec(`Luma 8×8 block ${q}`, co, ZZ8, 0, 64);
    } else if (t8) {
      // CAVLC 8x8: four interleaved 4x4 blocks
      const all = new Int32Array(64);
      for (let i4 = 0; i4 < 4; i4++) {
        const b = q * 4 + i4;
        const co = block(S, addr, b, 0, 2, 16, intra, 'luma4x4');
        for (let k = 0; k < 16; k++) all[4 * k + i4] = co[k];
      }
      rec(`Luma 8×8 block ${q}`, all, ZZ8, 0, 64);
    } else {
      for (let i4 = 0; i4 < 4; i4++) {
        const b = q * 4 + i4;
        if (kind === K_I16) { const co = block(S, addr, b, 1, 1, 15, intra, 'lumaAC'); rec(`Luma AC block ${b}`, [0, ...co], ZZ4, 0, 16); }
        else { const co = block(S, addr, b, 0, 2, 16, intra, 'luma4x4'); rec(`Luma 4×4 block ${b}`, co, ZZ4, 0, 16); }
      }
    }
  }
  if (!S.chroma) return;
  const cc = cbp >> 4;
  if (cc & 3) for (let c = 0; c < 2; c++) {
    const co = block(S, addr, c, 0, 3, 4, intra, 'chromaDC');
    if (blocks) blocks.push({ label: `${c ? 'Cr' : 'Cb'} DC (2×2)`, raster: Int32Array.from(co), size: 2, count: co.filter(Boolean).length });
  }
  if (cc & 2) for (let c = 0; c < 2; c++) for (let b = 0; b < 4; b++) {
    const co = block(S, addr, c * 4 + b, 1, 4, 15, intra, 'chromaAC');
    rec(`${c ? 'Cr' : 'Cb'} AC block ${b}`, [0, ...co], ZZ4, 0, 16);
  }
}

// Decode one residual block. `idx` is the 4x4 luma block (spec order), 8x8 index,
// chroma component (DC) or chroma block c*4+b (AC). Returns coefficient levels in scan order.
function block(S, addr, idx, startIdx, cat, maxNum, intra, kind) {
  const pic = S.pic;
  let bx = 0, by = 0, comp = 0;
  if (kind === 'luma4x4' || kind === 'lumaAC') { bx = BX[idx]; by = BY[idx]; }
  if (kind === 'chromaAC') { comp = idx >> 2; bx = idx & 1; by = (idx >> 1) & 1; }
  if (kind === 'chromaDC') comp = idx;
  let coeffs;
  const p0 = S.r.pos;
  if (S.cabac) coeffs = cabacBlock(S, addr, cat, maxNum, kind, bx, by, comp, intra);
  else coeffs = cavlcBlock(S, addr, maxNum, kind, bx, by, comp, intra);
  const n = coeffs.reduce((a, v) => a + (v ? 1 : 0), 0);
  if (S.tr) {
    const where = kind === 'chromaDC' ? (comp ? 'Cr' : 'Cb') : kind === 'chromaAC' ? `${comp ? 'Cr' : 'Cb'}[${by * 2 + bx}]` : kind === 'lumaDC' ? '' : `[${idx}]`;
    S.tr.push(`residual ${kind}${where}: ${n} non-zero coefficient${n === 1 ? '' : 's'}` +
      (coeffs.nC !== undefined ? ` (coeff_token with nC=${coeffs.nC}: TotalCoeff=${coeffs.total}, TrailingOnes=${coeffs.t1})` : '') + `, ${S.r.pos - p0} bits`);
  }
  if (kind === 'luma4x4' || kind === 'lumaAC') pic.nz[addr * 16 + by * 4 + bx] = S.cabac ? n : coeffs.total;
  else if (kind === 'chromaAC') pic.nzc[addr * 8 + comp * 4 + by * 2 + bx] = S.cabac ? n : coeffs.total;
  else if (kind === 'lumaDC' && n) pic.dc[addr] |= 1;
  else if (kind === 'chromaDC' && n) pic.dc[addr] |= 2 << comp;
  return coeffs;
}

// Total-coeff / coded-block-flag of a neighbouring luma or chroma 4x4 block.
// Returns -1 if unavailable.
function nbCoeff(S, addr, kind, bx, by, comp, dx, dy) {
  const pic = S.pic;
  const chroma = kind === 'chromaAC';
  const size = chroma ? 2 : 4;
  let cx = bx + dx, cy = by + dy, a = addr;
  if (cx < 0 || cy < 0) {
    a = nbMb(S, addr, cx < 0 ? -1 : 0, cy < 0 ? -1 : 0);
    if (a < 0) return -1;
    cx = (cx + size) % size; cy = (cy + size) % size;
  }
  const k = pic.kind[a];
  if (k === K_PCM) return 16;
  if (k === K_PSKIP || k === K_BSKIP) return 0;
  if (chroma) return pic.nzc[a * 8 + comp * 4 + cy * 2 + cx];
  return pic.nz[a * 16 + cy * 4 + cx];
}

function cabacBlock(S, addr, cat, maxNum, kind, bx, by, comp, intra) {
  const c = S.c, pic = S.pic;
  // coded_block_flag (not coded for 8x8 luma blocks in 4:2:0)
  if (cat !== 5) {
    let ctxA, ctxB;
    if (kind === 'lumaDC' || kind === 'chromaDC') {
      const bit = kind === 'lumaDC' ? 1 : 2 << comp;
      const f = (a) => a < 0 ? (intra ? 1 : 0) : pic.kind[a] === K_PCM ? 1 : (pic.dc[a] & bit ? 1 : 0);
      ctxA = f(nbMb(S, addr, -1, 0)); ctxB = f(nbMb(S, addr, 0, -1));
    } else {
      const f = (v) => v < 0 ? (intra ? 1 : 0) : v > 0 ? 1 : 0;
      ctxA = f(nbCoeff(S, addr, kind, bx, by, comp, -1, 0));
      ctxB = f(nbCoeff(S, addr, kind, bx, by, comp, 0, -1));
    }
    const base = [85, 89, 93, 97, 101][cat];
    if (!c.d(base + ctxA + 2 * ctxB)) return new Int32Array(maxNum);
  }
  const sigBase = [105, 120, 134, 149, 152, 402][cat];
  const lastBase = [166, 181, 195, 210, 213, 417][cat];
  const absBase = [227, 237, 247, 257, 266, 426][cat];
  const sig = new Uint8Array(maxNum);
  let numCoeff = maxNum;
  for (let i = 0; i < maxNum - 1; i++) {
    const inc = cat === 5 ? TB.SIG_8x8_FRAME[i] : cat === 3 ? Math.min(i, 2) : i;
    if (c.d(sigBase + inc)) {
      sig[i] = 1;
      const linc = cat === 5 ? TB.LAST_8x8[i] : cat === 3 ? Math.min(i, 2) : i;
      if (c.d(lastBase + linc)) { numCoeff = i + 1; break; }
    }
  }
  if (numCoeff === maxNum) sig[maxNum - 1] = 1;
  const coeffs = new Int32Array(maxNum);
  let eq1 = 0, gt1 = 0;
  for (let i = numCoeff - 1; i >= 0; i--) {
    if (!sig[i]) continue;
    let abs;
    const inc0 = gt1 ? 0 : Math.min(4, 1 + eq1);
    if (!c.d(absBase + inc0)) abs = 1;
    else {
      const inc = 5 + Math.min(4 - (cat === 3 ? 1 : 0), gt1);
      abs = 2;
      while (abs < 15 && c.d(absBase + inc)) abs++;
      if (abs >= 15) {
        // Exp-Golomb (k=0) suffix in bypass mode
        let k = 0;
        while (c.bypass()) { if (++k > 30) throw new Error('coeff overflow'); }
        let v = 0;
        for (let j = 0; j < k; j++) v = v * 2 + c.bypass();
        abs = 15 + (2 ** k - 1) + v;
      }
    }
    if (abs === 1) eq1++; else gt1++;
    coeffs[i] = c.bypass() ? -abs : abs;
  }
  return coeffs;
}

function cavlcBlock(S, addr, maxNum, kind, bx, by, comp, intra) {
  const r = S.r;
  let nC;
  if (kind === 'chromaDC') nC = -1;
  else {
    const nA = nbCoeff(S, addr, kind === 'lumaDC' ? 'luma4x4' : kind, bx, by, comp, -1, 0);
    const nB = nbCoeff(S, addr, kind === 'lumaDC' ? 'luma4x4' : kind, bx, by, comp, 0, -1);
    nC = nA >= 0 && nB >= 0 ? (nA + nB + 1) >> 1 : nA >= 0 ? nA : nB >= 0 ? nB : 0;
  }
  void intra;
  const tok = readVlc(r, nC < 0 ? CT_DC_VLC : CT_VLC[nC < 2 ? 0 : nC < 4 ? 1 : nC < 8 ? 2 : 3]);
  const total = tok >> 2, t1 = tok & 3;
  const coeffs = new Int32Array(maxNum);
  coeffs.total = total; coeffs.t1 = t1; coeffs.nC = nC;
  if (!total) return coeffs;
  const level = [];
  let suffixLength = total > 10 && t1 < 3 ? 1 : 0;
  for (let i = 0; i < total; i++) {
    if (i < t1) { level.push(r.bit() ? -1 : 1); continue; }
    let prefix = 0;
    while (!r.bit()) { if (++prefix > 32) throw new Error('bad level_prefix'); }
    let levelCode = Math.min(15, prefix) << suffixLength;
    if (suffixLength > 0 || prefix >= 14) {
      const size = prefix === 14 && suffixLength === 0 ? 4 : prefix >= 15 ? prefix - 3 : suffixLength;
      if (size > 0) levelCode += r.u(size);
    }
    if (prefix >= 15 && suffixLength === 0) levelCode += 15;
    if (prefix >= 16) levelCode += (1 << (prefix - 3)) - 4096;
    if (i === t1 && t1 < 3) levelCode += 2;
    const lv = levelCode % 2 === 0 ? (levelCode + 2) >> 1 : (-levelCode - 1) >> 1;
    level.push(lv);
    if (suffixLength === 0) suffixLength = 1;
    if (Math.abs(lv) > (3 << (suffixLength - 1)) && suffixLength < 6) suffixLength++;
  }
  let zerosLeft = 0;
  if (total < maxNum) zerosLeft = readVlc(r, maxNum === 4 ? TZ_DC_VLC[total - 1] : TZ_VLC[total - 1]);
  const run = [];
  for (let i = 0; i < total - 1; i++) {
    let rb = 0;
    if (zerosLeft > 0) rb = readVlc(r, RUN_VLC[Math.min(zerosLeft, 7) - 1]);
    run.push(rb); zerosLeft -= rb;
  }
  run.push(zerosLeft);
  let pos = -1;
  for (let i = total - 1; i >= 0; i--) { pos += run[i] + 1; if (pos < maxNum) coeffs[pos] = level[i]; }
  return coeffs;
}

// Motion field summary for use as a co-located picture.
export function motionOf(result, refs) {
  const p = result.pic;
  return { kind: p.kind, mv: p.mv, ref: p.ref, refs };
}
