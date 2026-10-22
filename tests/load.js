import fs from 'node:fs';
import { parseFile, describeTracks } from '../js/mp4.js';
import { buildSamples } from '../js/samples.js';
import { analyzeVideo } from '../js/gop.js';

export async function load(path) {
  const buf = new Uint8Array(fs.readFileSync(path));
  const file = { size: buf.length };
  const readBytes = async (o, n) => buf.subarray(o, Math.min(buf.length, o + n));
  const { root, ctx } = await parseFile(file, readBytes);
  const tracks = describeTracks(root, ctx);
  for (const t of tracks) t.samples = buildSamples(t, root, ctx);
  return { buf, root, ctx, tracks, readBytes };
}
export async function video(path) {
  const L = await load(path);
  const v = L.tracks.find(t => t.type === 'video');
  v.analysis = await analyzeVideo(v.samples, v.config, L.readBytes);
  return { ...L, v };
}
export function tree(n, d = 0, out = []) {
  for (const c of n.children || []) { out.push('  '.repeat(d) + c.type + ' ' + c.size + (c.summary ? '  [' + c.summary + ']' : '') + (c.error ? ' ERR ' + c.error : '')); tree(c, d + 1, out); }
  return out;
}
