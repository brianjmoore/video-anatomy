// Per-frame analysis of a video track: slice types, POC, reference lists.
import * as H264 from './h264.js';
import * as HEVC from './hevc.js';

const HEAD_BYTES = 4096;

// Reads samples in coalesced ranges. Calls onProgress(done, total).
export async function analyzeVideo(T, cfg, readBytes, { limit = Infinity, onProgress } = {}) {
  const n = Math.min(T.n, limit);
  const frames = new Array(n);
  const state = cloneState(cfg.state);
  const isHevc = cfg.codec === 'hevc';
  let i = 0;
  while (i < n) {
    // coalesce reads of nearby samples (up to ~2 MB)
    const start = T.offset[i];
    let j = i, end = start + Math.min(T.size[i], HEAD_BYTES);
    while (j + 1 < n && T.offset[j + 1] >= start && T.offset[j + 1] + Math.min(T.size[j + 1], HEAD_BYTES) - start < 2e6 && T.offset[j + 1] - end < 256e3) {
      j++; end = Math.max(end, T.offset[j] + Math.min(T.size[j], HEAD_BYTES));
    }
    const buf = await readBytes(start, end - start);
    for (let k = i; k <= j; k++) {
      const o = T.offset[k] - start;
      const len = Math.min(T.size[k], HEAD_BYTES);
      frames[k] = parseFrameHead(buf.subarray(o, o + len), T.offset[k], T.size[k], cfg, state, isHevc);
      frames[k].i = k;
    }
    i = j + 1;
    onProgress && onProgress(i, n);
    await new Promise(r => setTimeout(r, 0));
  }
  if (isHevc) hevcRefs(frames); else h264Refs(frames);
  return { frames, n, complete: n === T.n };
}

function cloneState(s) { return { sps: { ...s.sps }, pps: { ...s.pps }, vps: { ...(s.vps || {}) } }; }

export function parseFrameHead(bytes, fileOff, fullSize, cfg, state, isHevc) {
  const nals = H264.splitLengthPrefixed(bytes, cfg.lengthSize);
  const f = { nals: [], slices: 0, size: fullSize, partial: bytes.length < fullSize };
  for (const nr of nals) {
    const b = bytes.subarray(nr.off, nr.off + nr.len);
    if (!b.length) continue;
    if (isHevc) {
      const t = (b[0] >> 1) & 63;
      f.nals.push(t);
      if (t >= 32 && t <= 34) HEVC.parseNal(b, fileOff + nr.off, state);
      else if (t < 32 && !f.slice) {
        const nal = HEVC.parseNal(b, fileOff + nr.off, state);
        if (nal.slice) { f.slice = nal.slice; f.nalType = t; f.tid = nal.tid; }
        f.slices++;
      } else if (t < 32) f.slices++;
    } else {
      const t = b[0] & 31;
      f.nals.push(t);
      if (t === 7 || t === 8) H264.parseNal(b, fileOff + nr.off, state);
      else if ((t === 1 || t === 5)) {
        if (!f.slice) {
          const nal = H264.parseNal(b, fileOff + nr.off, state, { withSliceData: false });
          if (nal.slice) { f.slice = nal.slice; f.nalType = t; f.ref = nal.ref; }
        }
        f.slices++;
      }
    }
  }
  if (f.slice) {
    f.type = f.slice.type;
    f.qp = f.slice.qp;
  } else f.type = '?';
  return f;
}

// ---------------------------------------------------------------------------
// H.264: POC + DPB/reference marking + initial ref lists (frames only)

function h264Refs(frames) {
  let prevRefPocMsb = 0, prevRefPocLsb = 0, prevFrameNumOffset = 0, prevFrameNum = 0, prevMmco5 = false;
  let dpb = []; // {i, frameNum, poc, long, ltIdx}
  let maxLtIdx = -1;
  for (const f of frames) {
    const h = f.slice;
    if (!h || !h.sps) continue;
    const sps = h.sps;
    f.isRef = h.nal_ref_idc !== 0; f.idr = h.idr;
    f.frameNum = h.frame_num;
    if (h.field_pic_flag) { f.field = true; f.refNote = 'interlaced field pictures: reference analysis not supported'; }
    const MaxFrameNum = 2 ** sps.log2_max_frame_num;
    // ---- POC
    let poc;
    if (sps.poc_type === 0) {
      if (h.idr) { prevRefPocMsb = 0; prevRefPocLsb = 0; }
      const max = 2 ** sps.log2_max_poc_lsb, lsb = h.pic_order_cnt_lsb;
      let msb;
      if (lsb < prevRefPocLsb && prevRefPocLsb - lsb >= max / 2) msb = prevRefPocMsb + max;
      else if (lsb > prevRefPocLsb && lsb - prevRefPocLsb > max / 2) msb = prevRefPocMsb - max;
      else msb = prevRefPocMsb;
      const top = msb + lsb, bot = top + h.delta_pic_order_cnt_bottom;
      poc = Math.min(top, bot);
      f.pocMsb = msb;
      if (f.isRef) { prevRefPocMsb = msb; prevRefPocLsb = lsb; }
    } else {
      const fno = h.idr ? 0 : (prevFrameNum > h.frame_num ? prevFrameNumOffset + MaxFrameNum : prevFrameNumOffset);
      if (sps.poc_type === 2) {
        poc = h.idr ? 0 : f.isRef ? 2 * (fno + h.frame_num) : 2 * (fno + h.frame_num) - 1;
      } else {
        const cyc = sps.offset_for_ref_frame.length;
        let abs = cyc ? fno + h.frame_num : 0;
        if (!f.isRef && abs > 0) abs--;
        let exp = 0;
        if (abs > 0) {
          const cnt = Math.floor((abs - 1) / cyc), inCyc = (abs - 1) % cyc;
          const sum = sps.offset_for_ref_frame.reduce((a, b) => a + b, 0);
          exp = cnt * sum; for (let k = 0; k <= inCyc; k++) exp += sps.offset_for_ref_frame[k];
        }
        if (!f.isRef) exp += sps.offset_for_non_ref_pic;
        const top = exp + h.delta_pic_order_cnt[0];
        const bot = top + sps.offset_for_top_to_bottom_field + h.delta_pic_order_cnt[1];
        poc = Math.min(top, bot);
      }
      prevFrameNumOffset = prevMmco5 ? 0 : fno;
      prevFrameNum = h.frame_num;
    }
    f.poc = poc;
    if (f.field) continue;

    // ---- reference lists (before marking the current picture)
    if (h.idr) { dpb = []; }
    const cur = h.frame_num;
    for (const p of dpb) { p.picNum = p.long ? p.ltIdx : (p.frameNum > cur ? p.frameNum - MaxFrameNum : p.frameNum); }
    const st = dpb.filter(p => !p.long), lt = dpb.filter(p => p.long).sort((a, b) => a.ltIdx - b.ltIdx);
    f.dpb = dpb.map(p => ({ i: p.i, poc: p.poc, long: p.long, picNum: p.picNum }));
    let L0 = [], L1 = [];
    if (h.type === 'P' || h.type === 'SP') {
      L0 = [...st.sort((a, b) => b.picNum - a.picNum), ...lt];
    } else if (h.type === 'B') {
      const before = st.filter(p => p.poc < poc).sort((a, b) => b.poc - a.poc);
      const after = st.filter(p => p.poc > poc).sort((a, b) => a.poc - b.poc);
      L0 = [...before, ...after, ...lt];
      L1 = [...after, ...before, ...lt];
      if (L1.length > 1 && L1.every((p, k) => p === L0[k])) [L1[0], L1[1]] = [L1[1], L1[0]];
    }
    // modifications
    const applyMods = (L, mods, len) => {
      let pred = cur, idx = 0;
      for (const m of mods) {
        let pic;
        if (m.idc < 2) {
          let nw = m.idc === 0 ? pred - m.v : pred + m.v;
          if (nw < 0) nw += MaxFrameNum; if (nw >= MaxFrameNum) nw -= MaxFrameNum;
          pred = nw;
          const pn = nw > cur ? nw - MaxFrameNum : nw;
          pic = st.find(p => p.picNum === pn);
        } else pic = lt.find(p => p.ltIdx === m.v);
        if (!pic) continue;
        L = [...L.slice(0, idx), pic, ...L.slice(idx).filter(p => p !== pic)];
        idx++;
      }
      return L.slice(0, len);
    };
    L0 = applyMods(L0, h.mods[0], h.num_ref_idx_l0_active);
    L1 = applyMods(L1, h.mods[1], h.num_ref_idx_l1_active);
    f.refs = [L0.map(p => p.i), L1.map(p => p.i)];

    // ---- marking
    prevMmco5 = false;
    if (f.isRef) {
      let curLong = false, curLtIdx = 0;
      if (h.idr) {
        if (h.long_term_reference_flag) { curLong = true; maxLtIdx = 0; } else maxLtIdx = -1;
      } else if (h.mmco) {
        for (const m of h.mmco) {
          if (m.op === 1) { const pn = cur - m.diff; dpb = dpb.filter(p => p.long || p.picNum !== pn); }
          else if (m.op === 2) dpb = dpb.filter(p => !p.long || p.ltIdx !== m.ltpn);
          else if (m.op === 3) {
            const pn = cur - m.diff;
            dpb = dpb.filter(p => !p.long || p.ltIdx !== m.ltfi);
            const p = dpb.find(q => !q.long && q.picNum === pn); if (p) { p.long = true; p.ltIdx = m.ltfi; }
          } else if (m.op === 4) { maxLtIdx = m.max - 1; dpb = dpb.filter(p => !p.long || p.ltIdx <= maxLtIdx); }
          else if (m.op === 5) { dpb = []; maxLtIdx = -1; prevMmco5 = true; }
          else if (m.op === 6) { dpb = dpb.filter(p => !p.long || p.ltIdx !== m.ltfi); curLong = true; curLtIdx = m.ltfi; }
        }
      } else {
        const stNow = dpb.filter(p => !p.long);
        if (dpb.length >= Math.max(1, sps.max_num_ref_frames) && stNow.length) {
          const victim = stNow.reduce((a, b) => (a.picNum < b.picNum ? a : b));
          dpb = dpb.filter(p => p !== victim);
          f.evicted = victim.i;
        }
      }
      dpb.push({ i: f.i, frameNum: prevMmco5 ? 0 : h.frame_num, poc: prevMmco5 ? 0 : poc, long: curLong, ltIdx: curLtIdx });
      if (prevMmco5) { prevRefPocMsb = 0; prevRefPocLsb = 0; prevFrameNum = 0; }
    }
  }
}

// ---------------------------------------------------------------------------
// HEVC: POC + RPS-based reference lists

function hevcRefs(frames) {
  let prevTid0Poc = 0, firstPic = true;
  let pocToIdx = new Map();
  for (const f of frames) {
    const h = f.slice;
    if (!h || !h.sps) continue;
    const t = f.nalType;
    f.isRef = !(t <= 14 && t % 2 === 0);
    f.idr = HEVC.isIdr(t);
    f.irap = HEVC.isIrap(t);
    const sps = h.sps, max = 2 ** sps.log2_max_poc_lsb;
    let msb;
    const noRaslOutput = f.idr || (t >= 16 && t <= 18) || firstPic;
    if (f.irap && noRaslOutput) msb = 0;
    else {
      const pl = ((prevTid0Poc % max) + max) % max, pm = prevTid0Poc - pl;
      if (h.poc_lsb < pl && pl - h.poc_lsb >= max / 2) msb = pm + max;
      else if (h.poc_lsb > pl && h.poc_lsb - pl > max / 2) msb = pm - max;
      else msb = pm;
    }
    const poc = msb + h.poc_lsb;
    f.poc = poc;
    firstPic = false;
    if (f.tid === 0 && !(t >= 6 && t <= 9) && f.isRef) prevTid0Poc = poc;
    if (f.irap && noRaslOutput) pocToIdx = new Map();

    const rps = h.rps;
    const before = [], after = [], lt = [];
    rps.s0.forEach((d, k) => { if (rps.u0[k]) before.push(poc + d); });
    rps.s1.forEach((d, k) => { if (rps.u1[k]) after.push(poc + d); });
    for (const e of h.lt) {
      if (!e.used) continue;
      let p = e.lsb;
      if (e.msb != null) p = poc - e.msb * max - (poc & (max - 1)) + e.lsb;
      lt.push(p);
    }
    f.rpsPocs = { before, after, lt, keep: [...rps.s0.filter((_, k) => !rps.u0[k]), ...rps.s1.filter((_, k) => !rps.u1[k])].map(d => poc + d) };
    const lookup = p => {
      if (pocToIdx.has(p)) return pocToIdx.get(p);
      // long-term matched by LSBs only
      for (const [q, idx] of pocToIdx) if ((((q % max) + max) % max) === p) return idx;
      return -1;
    };
    const build = (first, second) => {
      const tmp = [...first, ...second, ...lt].map(lookup);
      return tmp;
    };
    const total = before.length + after.length + lt.length;
    const mk = (base, n, entries) => {
      if (!total || !n) return [];
      const out = [];
      if (entries) for (let k = 0; k < n; k++) out.push(base[entries[k]]);
      else for (let k = 0; k < n; k++) out.push(base[k % base.length]);
      return out;
    };
    const L0base = build(before, after), L1base = build(after, before);
    f.refs = [mk(L0base, h.num_ref_idx_l0_active, h.list_entry[0]), h.type === 'B' ? mk(L1base, h.num_ref_idx_l1_active, h.list_entry[1]) : []];
    f.refs = f.refs.map(L => L.filter(x => x >= 0));
    pocToIdx.set(poc, f.i);
  }
}

// Short pattern string like "IBBPBBP" in display order for a GOP summary.
export function gopSummary(T, A) {
  const frames = A.frames;
  const keyIdx = [];
  for (let k = 0; k < A.n; k++) if (T.sync[k]) keyIdx.push(k);
  const gopLens = keyIdx.slice(1).map((k, j) => k - keyIdx[j]);
  const counts = { I: 0, P: 0, B: 0 };
  let refB = 0;
  for (const f of frames) { if (f && counts[f.type] !== undefined) counts[f.type]++; if (f && f.type === 'B' && f.isRef) refB++; }
  // first GOP in display order
  const g0 = keyIdx[0] ?? 0, g1 = keyIdx[1] ?? Math.min(A.n, g0 + 60);
  const idx = []; for (let k = g0; k < g1 && k < A.n; k++) idx.push(k);
  idx.sort((a, b) => T.pts[a] - T.pts[b]);
  const pat = idx.slice(0, 40).map(k => frames[k] ? (frames[k].type === 'B' && !frames[k].isRef ? 'b' : frames[k].type[0]) : '?').join('');
  return { counts, refB, keyframes: keyIdx.length, avgGop: gopLens.length ? gopLens.reduce((a, b) => a + b, 0) / gopLens.length : A.n, pattern: pat + (g1 - g0 > 40 ? '…' : '') };
}
