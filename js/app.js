import { parseFile, describeTracks } from './mp4.js';
import { buildSamples } from './samples.js';
import { StructureView } from './structure.js';
import { VideoView } from './video.js';
import { AudioView } from './audio.js';
import { LearnView } from './learn.js';
import { toast } from './ui.js';

class App {
  constructor() {
    this.tracks = [];
    this.structure = new StructureView(this);
    this.video = new VideoView(this);
    this.audio = new AudioView(this);
    this.learn = new LearnView(this);
    this.readBytes = (off, len) => this.read(off, len);
    for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => this.show(b.dataset.tab));
    document.getElementById('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) this.open(f); e.target.value = ''; });
    document.getElementById('demoBtn').addEventListener('click', () => this.openDemo());
    // drag & drop
    let depth = 0;
    addEventListener('dragenter', e => { e.preventDefault(); if (++depth === 1) document.body.classList.add('dragging'); });
    addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('drop', e => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer.files[0]; if (f) this.open(f);
    });
    addEventListener('keydown', e => {
      if (e.target.closest('input, textarea')) return;
      if (this.tab === 'video' && this.video.A) {
        if (e.key === 'ArrowRight') { this.video.step(1); e.preventDefault(); }
        if (e.key === 'ArrowLeft') { this.video.step(-1); e.preventDefault(); }
      }
    });
    addEventListener('hashchange', () => this.fromHash());
    this.setTabsEnabled(false);
    this.learn.render();
    const q = new URLSearchParams(location.search);
    if (q.get('demo') !== null) this.openDemo();
    else this.fromHash();
  }

  setTabsEnabled(on) {
    for (const b of document.querySelectorAll('#tabs button')) if (b.dataset.tab !== 'learn') b.disabled = !on;
  }

  async read(off, len) {
    if (!this.file || len <= 0) return new Uint8Array(0);
    const key = off + ':' + len;
    const c = this.cache.get(key);
    if (c) return c;
    const buf = new Uint8Array(await this.file.slice(off, off + len).arrayBuffer());
    if (len <= 1 << 20) {
      this.cache.set(key, buf);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    }
    return buf;
  }

  async openDemo() {
    toast('Loading demo…');
    try {
      const r = await fetch('samples/demo.mp4');
      if (!r.ok) throw new Error(r.statusText);
      const blob = await r.blob();
      await this.open(new File([blob], 'demo.mp4 (Big Buck Bunny excerpt)', { type: 'video/mp4' }));
    } catch (e) { toast('Could not load the demo: ' + e.message); }
  }

  async open(file) {
    this.file = file;
    this.cache = new Map();
    document.getElementById('fileName').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
    const head = await this.read(0, 16);
    const type = String.fromCharCode(...head.subarray(4, 8));
    const known = ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'styp', 'sidx', 'moof', 'pnot', 'uuid'];
    if (!known.includes(type)) {
      const sig = String.fromCharCode(...head.subarray(0, 4));
      const what = sig === 'RIFF' ? 'a RIFF file (WAV/AVI)' : sig.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ? 'an MP3 or ADTS audio stream'
        : head[0] === 0x1a && head[1] === 0x45 ? 'a Matroska/WebM file' : head[0] === 0x47 ? 'an MPEG transport stream' : 'not an MP4-family file';
      toast(`This looks like ${what}. Video Anatomy currently reads MP4, MOV and M4A files.`, 5000);
      return;
    }
    let parsed;
    try { parsed = await parseFile(file, this.readBytes); }
    catch (e) { toast('Could not parse this file: ' + e.message, 5000); console.error(e); return; }
    this.root = parsed.root; this.ctx = parsed.ctx;
    this.tracks = describeTracks(this.root, this.ctx);
    for (const t of this.tracks) {
      try { t.samples = buildSamples(t, this.root, this.ctx); }
      catch (e) { console.error(e); t.samples = { n: 0, sync: [], size: [], offset: [], dts: [], pts: [], cto: [], presOrder: [], presRank: [], tables: {}, ts: 1, totalBytes: 0, endTime: 0 }; }
    }
    this.video.reset(); this.audio.reset();
    this.structure.load(this.root);
    this.setTabsEnabled(true);
    document.querySelector('#tabs [data-tab=video]').disabled = !this.tracks.some(t => t.type === 'video');
    document.querySelector('#tabs [data-tab=audio]').disabled = !this.tracks.some(t => t.type === 'audio');
    this.learn.render();
    this.show('structure');
  }

  show(tab, opts = {}) {
    if (tab !== 'learn' && tab !== 'landing' && !this.file) tab = 'landing';
    this.tab = tab;
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === tab);
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    if (tab === 'video') this.video.open(opts.track);
    if (tab === 'audio') this.audio.open(opts.track);
    if (tab === 'learn' && opts.anchor) setTimeout(() => document.getElementById(opts.anchor)?.scrollIntoView({ behavior: 'smooth' }), 50);
    else scrollTo(0, 0);
  }

  fromHash() {
    const h = location.hash.slice(1);
    if (h.startsWith('learn')) this.show('learn', { anchor: h.split('/')[1] });
  }

  trackForBox(n) {
    for (let p = n; p; p = p.parent) if (p.type === 'trak') return this.tracks.find(t => t.trak === p);
    if (n.type === 'traf' || (n.parent && n.parent.type === 'traf')) {
      const traf = n.type === 'traf' ? n : n.parent;
      const tfhd = traf.children.find(c => c.type === 'tfhd');
      return tfhd && tfhd.data ? this.tracks.find(t => t.id === tfhd.data.id) : null;
    }
    return null;
  }

  // Jump to the first box of `type` inside a track (or anywhere).
  showBox(track, type) {
    const search = n => { if (n.type === type) return n; for (const c of n.children || []) { const r = search(c); if (r) return r; } return null; };
    const scope = track && track.trak ? track.trak : this.root;
    let node = search(scope);
    if (!node && type.includes('/')) node = this.structure.findByPath(type);
    if (!node && (type === 'trun' || type === 'moof/traf/trun')) node = search(this.root.children.find(c => c.type === 'moof') || this.root);
    if (!node) { toast(`No ${type} box here`); return; }
    this.show('structure');
    this.structure.select(node);
  }
}

window.app = new App();
