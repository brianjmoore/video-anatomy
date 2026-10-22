// Turn a track's sample tables (or movie fragments) into per-sample arrays.
import { find, findAll, fmtTime } from './mp4.js';

export function buildSamples(track, root, ctx) {
  const stbl = find(track.trak, 'mdia/minf/stbl');
  const T = { n: 0, offset: [], size: [], dts: [], cto: [], sync: [], chunk: [], fragmented: false, track };
  const g = t => (stbl && find(stbl, t)) ? find(stbl, t).data : null;
  const stsz = g('stsz') || g('stz2'), stts = g('stts'), ctts = g('ctts'), stss = g('stss'), stsc = g('stsc');
  const stco = g('stco') || g('co64'), sdtp = g('sdtp');
  T.tables = { stsz, stts, ctts, stss, stsc, stco };

  // ---- classic (moov) sample tables
  const n = stsz ? stsz.n : 0;
  if (n && stco && stsc && stts) {
    const offset = new Float64Array(n), size = new Uint32Array(n), dts = new Float64Array(n), cto = new Int32Array(n);
    const sync = new Uint8Array(n), chunk = new Uint32Array(n);
    for (let i = 0; i < n; i++) size[i] = stsz.fixed || stsz.size[i];
    // stts → dts
    let i = 0, t = 0;
    for (let e = 0; e < stts.count.length; e++) for (let k = 0; k < stts.count[e] && i < n; k++) { dts[i++] = t; t += stts.delta[e]; }
    while (i < n) dts[i++] = t;
    T.endTime = t;
    // ctts → composition offset
    if (ctts) { i = 0; for (let e = 0; e < ctts.count.length; e++) for (let k = 0; k < ctts.count[e] && i < n; k++) cto[i++] = ctts.off[e]; }
    // stss → sync (absent = every sample is sync)
    if (stss) for (const s of stss.num) { if (s >= 1 && s <= n) sync[s - 1] = 1; } else sync.fill(1);
    // stsc + stco → offsets
    const nChunks = stco.off.length;
    i = 0;
    for (let e = 0; e < stsc.first.length && i < n; e++) {
      const firstChunk = stsc.first[e] - 1;
      const lastChunk = e + 1 < stsc.first.length ? stsc.first[e + 1] - 1 : nChunks;
      for (let c = firstChunk; c < lastChunk && i < n; c++) {
        let o = stco.off[c];
        for (let k = 0; k < stsc.per[e] && i < n; k++) { offset[i] = o; chunk[i] = c; o += size[i]; i++; }
      }
    }
    Object.assign(T, { n, offset, size, dts, cto, sync, chunk });
    if (sdtp && sdtp.dep.length >= n) T.sdtp = sdtp;
  }

  // ---- movie fragments (moof/traf/trun)
  const moofs = root.children.filter(c => c.type === 'moof');
  if (moofs.length) {
    const trex = (ctx.trex || {})[track.id] || {};
    const list = { offset: [], size: [], dts: [], cto: [], sync: [], chunk: [] };
    let t = T.n ? T.endTime : 0, frag = 0;
    for (const moof of moofs) {
      for (const traf of findAll(moof, 'traf')) {
        const tfhd = find(traf, 'tfhd');
        if (!tfhd || !tfhd.data || tfhd.data.id !== track.id) continue;
        const h = tfhd.data;
        const tfdt = find(traf, 'tfdt');
        if (tfdt && tfdt.data) t = tfdt.data.t;
        let base = h.base != null ? h.base : moof.start;
        let pos = base;
        for (const trun of findAll(traf, 'trun')) {
          const d = trun.data; if (!d) continue;
          if (d.dataOffset != null) pos = base + d.dataOffset;
          for (let k = 0; k < d.n; k++) {
            const dur = d.duration ? d.duration[k] : (h.dur ?? trex.dur ?? 0);
            const sz = d.size ? d.size[k] : (h.size ?? trex.size ?? 0);
            let fl = d.flags ? d.flags[k] : (k === 0 && d.firstFlags != null ? d.firstFlags : (h.sflags ?? trex.flags ?? 0));
            list.offset.push(pos); list.size.push(sz); list.dts.push(t);
            list.cto.push(d.composition_offset ? d.composition_offset[k] : 0);
            list.sync.push(((fl >> 16) & 1) ? 0 : 1); list.chunk.push(frag);
            pos += sz; t += dur;
          }
        }
        frag++;
      }
    }
    if (list.size.length) {
      const m = T.n, add = list.size.length;
      const cat = (a, b, Ty) => { const r = new Ty(m + add); if (m) r.set(a); r.set(b, m); return r; };
      T.offset = cat(T.offset, list.offset, Float64Array); T.size = cat(T.size, list.size, Uint32Array);
      T.dts = cat(T.dts, list.dts, Float64Array); T.cto = cat(T.cto, list.cto, Int32Array);
      T.sync = cat(T.sync, list.sync, Uint8Array); T.chunk = cat(T.chunk, list.chunk, Uint32Array);
      T.n = m + add; T.fragmented = true; T.endTime = t;
    }
  }

  // ---- edit list → presentation shift
  const elst = find(track.trak, 'edts/elst');
  T.editShift = 0; T.emptyLead = 0;
  if (elst && elst.data) {
    for (const e of elst.data.list) {
      if (e.mt === -1) { T.emptyLead += e.dur / (ctx.movieTimescale || 1); continue; }
      T.editShift = e.mt; break;
    }
  }
  const ts = track.timescale || 1;
  T.ts = ts;
  T.pts = new Float64Array(T.n);
  for (let i = 0; i < T.n; i++) T.pts[i] = (T.dts[i] + T.cto[i] - T.editShift) / ts + T.emptyLead;
  // presentation order rank
  const order = Array.from({ length: T.n }, (_, i) => i).sort((a, b) => T.pts[a] - T.pts[b] || a - b);
  T.presOrder = Int32Array.from(order);
  T.presRank = new Int32Array(T.n);
  order.forEach((s, r) => { T.presRank[s] = r; });
  T.totalBytes = 0; for (let i = 0; i < T.n; i++) T.totalBytes += T.size[i];
  return T;
}

// Step-by-step explanation of how a player locates sample i (0-based).
export function explainSample(T, i) {
  const steps = [];
  const ts = T.ts, tb = T.tables;
  const num = i + 1;
  if (T.fragmented && (!tb.stsz || i >= tb.stsz.n)) {
    steps.push({ box: 'moof/traf/trun', text: `This sample comes from movie fragment ${T.chunk[i] + 1}. Each fragment has its own trun box that lists the samples' sizes, durations and flags, and a data_offset that points into the following mdat.` });
    steps.push({ box: 'trun', text: `Offset = ${T.offset[i].toLocaleString()}, size = ${T.size[i].toLocaleString()} bytes, decode time = ${T.dts[i]} (${fmtTime(T.dts[i] / ts)}).` });
    return steps;
  }
  // stts
  if (tb.stts) {
    let acc = 0, t = 0;
    for (let e = 0; e < tb.stts.count.length; e++) {
      const c = tb.stts.count[e], d = tb.stts.delta[e];
      if (i < acc + c) {
        const k = i - acc;
        steps.push({ box: 'stts', text: `Decode time. stts entry ${e} covers samples ${acc + 1}–${acc + c}, each lasting ${d} ticks. Sample ${num} is #${k + 1} in that run, so its decode time = ${t} + ${k} × ${d} = ${t + k * d} ticks (${fmtTime((t + k * d) / ts)} at ${ts} ticks/s).` });
        break;
      }
      acc += c; t += c * d;
    }
  }
  if (tb.ctts) {
    steps.push({ box: 'ctts', text: `Display time. ctts gives sample ${num} a composition offset of ${T.cto[i]} ticks, so it's shown at ${T.dts[i]} + ${T.cto[i]} = ${T.dts[i] + T.cto[i]} ticks.` +
      (T.editShift ? ` The edit list starts the movie ${T.editShift} ticks into the media, so on the timeline it's displayed at ${fmtTime(T.pts[i])}.` : '') });
  }
  if (tb.stsc && tb.stco) {
    // find chunk via stsc
    let i0 = 0;
    for (let e = 0; e < tb.stsc.first.length; e++) {
      const first = tb.stsc.first[e], per = tb.stsc.per[e];
      const last = e + 1 < tb.stsc.first.length ? tb.stsc.first[e + 1] - 1 : tb.stco.off.length;
      const cnt = (last - first + 1) * per;
      if (i < i0 + cnt) {
        const chunkK = Math.floor((i - i0) / per), inChunk = (i - i0) % per;
        const chunkNo = first + chunkK;
        steps.push({ box: 'stsc', text: `Chunk. stsc entry ${e} says chunks ${first}–${last} each hold ${per} sample${per > 1 ? 's' : ''}. Counting samples from that entry, sample ${num} falls in chunk ${chunkNo}, position ${inChunk + 1} within the chunk.` });
        steps.push({ box: tb.stco.off.length && T.offset[i] > 4294967295 ? 'co64' : 'stco', text: `Chunk offset. Entry ${chunkNo} of the chunk offset table: chunk ${chunkNo} starts at byte ${tb.stco.off[chunkNo - 1].toLocaleString()} of the file.` });
        const prev = [];
        let o = tb.stco.off[chunkNo - 1];
        for (let k = i - inChunk; k < i; k++) { prev.push(T.size[k]); o += T.size[k]; }
        steps.push({ box: 'stsz', text: `Sample size and offset. stsz says sample ${num} is ${T.size[i].toLocaleString()} bytes.` +
          (prev.length ? ` It comes after ${prev.length} earlier sample${prev.length > 1 ? 's' : ''} in the same chunk (${prev.slice(0, 6).join(' + ')}${prev.length > 6 ? ' + …' : ''} bytes), so it starts at ${T.offset[i].toLocaleString()}.` : ` It's the first in its chunk, so it starts at ${T.offset[i].toLocaleString()}.`) });
        break;
      }
      i0 += cnt;
    }
  }
  if (tb.stss) steps.push({ box: 'stss', text: T.sync[i] ? `Keyframe. Sample ${num} is listed in stss, so a player can start decoding here (for seeking).` : `Not a keyframe. Sample ${num} isn't in stss, so to show it a player must decode from the previous keyframe.` });
  return steps;
}
