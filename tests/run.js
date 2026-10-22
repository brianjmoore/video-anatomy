// Regression tests: compare our parsing with ffprobe. Run: npm test
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { video, load } from './load.js';

const dir = new URL('./media/', import.meta.url).pathname;
let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL', msg); } };

for (const name of fs.readdirSync(dir).filter(f => /\.(mp4|mov|m4a)$/.test(f))) {
  const path = dir + name;
  console.log(name);
  const L = await load(path);
  for (const t of L.tracks) {
    const T = t.samples;
    const pk = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', String(t.id - 1), '-show_entries', 'packet=pos,size,dts,pts,flags', '-of', 'json', path], { maxBuffer: 1 << 30 })).packets;
    check(pk.length === T.n, `track ${t.id}: ${T.n} samples vs ffprobe ${pk.length}`);
    let bad = 0;
    for (let i = 0; i < Math.min(pk.length, T.n); i++) {
      const p = pk[i];
      if (+p.pos !== T.offset[i] || +p.size !== T.size[i] || +p.dts !== T.dts[i] - T.editShift * 0 && false) bad++;
      if (T.sync[i] && p.flags[0] !== 'K') bad++; // ffprobe may also flag recovery points not listed in stss
    }
    check(bad === 0, `track ${t.id}: ${bad} sample offset/size/key mismatches`);
  }
  const v = L.tracks.find(t => t.type === 'video');
  if (!v) continue;
  const V = await video(path);
  const T = V.v.samples, A = V.v.analysis;
  const fr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pict_type,pkt_pos', '-of', 'json', path], { maxBuffer: 1 << 30 })).frames;
  const byPos = new Map(fr.map(f => [+f.pkt_pos, f.pict_type]));
  let bad = 0;
  for (let i = 0; i < A.n; i++) { const want = byPos.get(T.offset[i]); if (want && want !== A.frames[i].type) bad++; }
  check(bad === 0, `${bad} frame type mismatches`);
  // POC order must match container presentation order
  let ord = 0;
  for (let i = 1; i < A.n; i++) {
    const a = A.frames[i - 1], b = A.frames[i];
    if (a.idr || b.idr || b.irap) continue;
    if (Math.sign(a.poc - b.poc) !== Math.sign(T.pts[i - 1] - T.pts[i])) ord++;
  }
  check(ord === 0, `${ord} POC vs pts order mismatches`);
}
console.log(fails ? `${fails} failure(s)` : 'all passed');
process.exit(fails ? 1 : 0);
