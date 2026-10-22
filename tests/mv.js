// Compare our motion vectors with FFmpeg's (doc/examples/extract_mvs.c, compiled to
// tools/extract_mvs; build: cc extract_mvs.c -I$(brew --prefix ffmpeg)/include -L$(brew --prefix ffmpeg)/lib -lavformat -lavcodec -lavutil).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { load } from './load.js';
import { analyzeVideo } from '../js/gop.js';
import * as H264 from '../js/h264.js';
import { parseSliceData, motionOf } from '../js/h264mb.js';

const tool = new URL('../tools/extract_mvs', import.meta.url).pathname;
if (!fs.existsSync(tool)) { console.log('skip: tools/extract_mvs not built'); process.exit(0); }
const files = process.argv.slice(2).length ? process.argv.slice(2) :
  fs.readdirSync(new URL('./media/', import.meta.url)).filter(f => /\.mp4$/.test(f)).map(f => new URL('./media/' + f, import.meta.url).pathname);
let total = 0;
for (const path of files) {
  const L = await load(path);
  const v = L.tracks.find(t => t.type === 'video');
  if (!v || !v.config || v.config.codec !== 'h264') continue;
  const T = v.samples, cfg = v.config;
  const A = await analyzeVideo(T, cfg, L.readBytes);
  const csv = spawnSync(tool, [path], { maxBuffer: 1 << 30 }).stdout.toString().trim().split('\n').slice(1);
  const motion = new Map(), res = [];
  for (let i = 0; i < T.n; i++) {
    const bytes = await L.readBytes(T.offset[i], T.size[i]);
    const state = { sps: { ...cfg.state.sps }, pps: { ...cfg.state.pps } };
    const slices = [];
    for (const nr of H264.splitLengthPrefixed(bytes, cfg.lengthSize)) {
      const nal = H264.parseNal(bytes.subarray(nr.off, nr.off + nr.len), T.offset[i] + nr.off, state);
      if (nal.slice) slices.push({ nal });
    }
    res[i] = await parseSliceData(slices, state, A.frames, i, { getMotion: async j => motion.get(j) }).catch(e => null);
    if (!res[i]) { console.log(`${path.split('/').pop()}: skipped (unsupported)`); break; }
    motion.set(i, motionOf(res[i], A.frames[i].refs || [[], []]));
  }
  let n = 0, bad = 0, first = null;
  const byKind = {};
  for (const line of csv) {
    const [fn, src, bw, bh, , , dx, dy, , mx, my] = line.split(',').map(s => parseInt(s));
    const i = T.presOrder[fn - 1];
    const r = res[i]; if (!r) continue;
    const l = src > 0 ? 1 : 0;
    const x0 = dx - (bw >> 1), y0 = dy - (bh >> 1);
    const mbx = x0 >> 4, mby = y0 >> 4, bx = (x0 & 15) >> 2, by = (y0 & 15) >> 2;
    const addr = mby * r.mbW + mbx, b = addr * 16 + by * 4 + bx;
    const ox = r.pic.mv[b * 4 + l * 2], oy = r.pic.mv[b * 4 + l * 2 + 1];
    n++;
    const m = r.mbs[addr];
    const k = m ? m.name : '?';
    byKind[k] ||= [0, 0]; byKind[k][0]++;
    if (ox !== mx || oy !== my) {
      bad++; byKind[k][1]++;
      if (!first) first = `frame ${i} (${A.frames[i].type}) MB ${mbx},${mby} ${k} blk ${bx},${by} L${l}: ffmpeg (${mx},${my}) ours (${ox},${oy})`;
    }
  }
  total += bad;
  console.log(`${path.split('/').pop()}: ${n} motion vectors, ${bad} differ`);
  for (const [k, [c, b]] of Object.entries(byKind)) if (b) console.log(`   ${k}: ${b}/${c} differ`);
  if (first) console.log('   first:', first);
}
process.exit(total ? 1 : 0);
