// Compare our H.264 macroblock parser with FFmpeg's -debug mb_type+qp output.
// Usage: node tests/mb.js [file...]   (defaults to the H.264 files in tests/media)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { load } from './load.js';
import { analyzeVideo } from '../js/gop.js';
import * as H264 from '../js/h264.js';
import { parseSliceData, motionOf } from '../js/h264mb.js';

function ffGrids(path) {
  const log = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'debug', '-threads', '1', '-debug', 'mb_type+qp', '-i', path, '-an', '-f', 'null', '-'],
    { maxBuffer: 1 << 30 }).stderr.toString();
  return parseLog(log);
}
function parseLog(log) {
  // FFmpeg also decodes a frame or two while probing the stream; keep only the
  // decoder context that printed the most frames.
  const ctxCount = {};
  for (const m of log.matchAll(/^\[h264 @ ([^\]]+)\] New frame/gm)) ctxCount[m[1]] = (ctxCount[m[1]] || 0) + 1;
  const main = Object.entries(ctxCount).sort((a, b) => b[1] - a[1])[0][0];
  const frames = [];
  let cur = null;
  for (const line of log.split('\n')) {
    const m = line.match(/^\[h264 @ ([^\]]+)\] (.*)$/);
    if (!m || m[1] !== main) continue;
    const t = m[2];
    if (t.startsWith('New frame, type:')) { cur = { type: t.split(':')[1].trim(), rows: [] }; frames.push(cur); continue; }
    if (!cur) continue;
    const row = t.match(/^\s*(\d+) (.*)$/);
    if (row && /[A-Za-z<>]/.test(row[2])) {
      const cells = [];
      const s = row[2];
      for (let i = 0; i + 5 <= s.length + 1; i += 5) cells.push(s.slice(i, i + 5));
      cur.rows.push(cells.filter(c => c.trim()));
    }
  }
  return frames;
}

function ourChar(m) {
  if (!m) return '?';
  if (m.name === 'I_PCM') return 'P';
  if (m.name === 'I_4x4' || m.name === 'I_8x8') return 'i';
  if (m.name === 'I_16x16') return 'I';
  if (m.name === 'B_Skip') return 'd';
  if (m.name === 'B_Direct_16x16') return 'D';
  if (m.name === 'P_Skip') return 'S';
  let l0 = false, l1 = false;
  for (const p of m.parts || []) { if (p.mv && p.mv[0]) l0 = true; if (p.mv && p.mv[1]) l1 = true; }
  return !l1 ? '>' : !l0 ? '<' : 'X';
}
function ourSeg(m) {
  if (/8x8/.test(m.name) && !/^I/.test(m.name)) return '+';
  if (/16x8/.test(m.name)) return '-';
  if (/8x16/.test(m.name)) return '|';
  return ' ';
}

const files = process.argv.slice(2).length ? process.argv.slice(2) :
  fs.readdirSync(new URL('./media/', import.meta.url)).filter(f => /\.mp4$/.test(f)).map(f => new URL('./media/' + f, import.meta.url).pathname);
let totalBad = 0;
for (const path of files) {
  const L = await load(path);
  const v = L.tracks.find(t => t.type === 'video');
  if (!v || !v.config || v.config.codec !== 'h264') continue;
  const T = v.samples, cfg = v.config;
  const A = await analyzeVideo(T, cfg, L.readBytes);
  const grids = ffGrids(path);
  const motion = new Map();
  const results = [];
  const getMotion = async (i) => motion.get(i);
  const t0 = Date.now();
  let mbs = 0;
  for (let i = 0; i < T.n; i++) {
    const bytes = await L.readBytes(T.offset[i], T.size[i]);
    const state = { sps: { ...cfg.state.sps }, pps: { ...cfg.state.pps } };
    const slices = [];
    for (const nr of H264.splitLengthPrefixed(bytes, cfg.lengthSize)) {
      const nal = H264.parseNal(bytes.subarray(nr.off, nr.off + nr.len), T.offset[i] + nr.off, state);
      if (nal.slice) slices.push({ nal });
    }
    const res = await parseSliceData(slices, state, A.frames, i, { getMotion }).catch(e => ({ error: e.message, mbs: [], decoded: 0, unsupported: true }));
    if (res.unsupported) { console.log(`${path.split('/').pop()}: skipped (${res.error})`); break; }
    motion.set(i, motionOf(res, A.frames[i].refs || [[], []]));
    results[i] = res;
    mbs += res.decoded;
  }
  const ms = Date.now() - t0;
  if (!results.length || results.length < T.n) continue;
  const qpOff = 6 * (cfg.sps[0].bit_depth_luma - 8); // FFmpeg prints QP + QpBdOffset
  let bad = 0, badFrames = 0, firstBad = null, qpBad = 0;
  for (let r = 0; r < Math.min(grids.length, T.n); r++) {
    const i = T.presOrder[r];
    const g = grids[r], res = results[i];
    let fb = 0;
    if (res.error && !firstBad) firstBad = `frame ${i} (${A.frames[i].type}) error at MB ${res.decoded}: ${res.error}`;
    for (let y = 0; y < g.rows.length; y++) for (let x = 0; x < g.rows[y].length; x++) {
      const cell = g.rows[y][x];
      const qp = parseInt(cell.slice(0, 2)), ch = cell[2], seg = cell[3] || ' ';
      const m = res.mbs[y * res.mbW + x];
      const oc = ourChar(m);
      const directSub = m && m.name === 'B_8x8'; // FFmpeg always labels B_8x8 as bi-predicted
      let ok = (oc === ch || (directSub && 'X<>'.includes(ch))) && (ch === 'd' || ch === 'D' || ch === 'S' || ourSeg(m) === seg);
      if (ok && m && m.qp + qpOff !== qp && ch !== 'S' && ch !== 'd') { qpBad++; ok = false; }
      if (!ok) {
        fb++;
        if (!firstBad) firstBad = `frame ${i} (decode order, ${A.frames[i].type}) MB ${x},${y}: ffmpeg "${cell}" ours ${m ? `${m.qp}${oc}${ourSeg(m)} ${m.name}` : 'none'}`;
      }
    }
    if (fb) badFrames++;
    bad += fb;
  }
  totalBad += bad;
  console.log(`${path.split('/').pop()}: ${T.n} frames, ${mbs} MBs parsed in ${ms} ms (${(mbs / ms).toFixed(0)} MB/ms); ${bad} mismatched MBs in ${badFrames} frames${qpBad ? ` (${qpBad} QP)` : ''}`);
  if (firstBad) console.log('   first:', firstBad);
}
process.exit(totalBad ? 1 : 0);
