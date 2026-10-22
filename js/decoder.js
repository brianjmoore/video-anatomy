// Decode individual frames for display. Uses WebCodecs when available
// (decode from the previous keyframe), else falls back to seeking a <video>.

const PIXEL_BUDGET = 40e6; // total cached pixels

export class FrameDecoder {
  constructor(track, T, readBytes, file) {
    this.track = track; this.T = T; this.readBytes = readBytes; this.file = file;
    this.cache = new Map(); // sample index -> ImageBitmap
    this.queue = Promise.resolve();
    this.mode = null;
  }

  async init() {
    const cfg = this.track.config;
    const sps = cfg && cfg.sps && cfg.sps[0];
    if (typeof VideoDecoder !== 'undefined' && cfg && cfg.codecString && sps) {
      this.config = {
        codec: cfg.codecString, description: cfg.raw,
        codedWidth: sps.codedWidth, codedHeight: sps.codedHeight, optimizeForLatency: true,
      };
      try {
        const sup = await VideoDecoder.isConfigSupported(this.config);
        if (sup.supported) { this.mode = 'webcodecs'; return this.mode; }
      } catch { /* fall through */ }
    }
    this.mode = 'video';
    return this.mode;
  }

  get frameBudget() {
    const sps = this.track.config.sps[0];
    return Math.max(8, Math.min(120, Math.floor(PIXEL_BUDGET / (sps.codedWidth * sps.codedHeight))));
  }

  // Returns an ImageBitmap (or canvas) for decode-order sample i.
  get(i) {
    if (this.cache.has(i)) { const b = this.cache.get(i); this.cache.delete(i); this.cache.set(i, b); return Promise.resolve(b); }
    const p = this.queue.then(() => this.cache.get(i) || (this.mode === 'webcodecs' ? this.decodeRange(i) : this.seekVideo(i)));
    this.queue = p.catch(() => {});
    return p;
  }

  remember(i, bmp) {
    this.cache.set(i, bmp);
    while (this.cache.size > this.frameBudget) {
      const k = this.cache.keys().next().value;
      const b = this.cache.get(k); if (b && b.close) b.close();
      this.cache.delete(k);
    }
  }

  async decodeRange(target) {
    const T = this.T;
    let key = target; while (key > 0 && !T.sync[key]) key--;
    let nextKey = target + 1; while (nextKey < T.n && !T.sync[nextKey]) nextKey++;
    // decode a little past the target so stepping forward is fast
    const ahead = Math.min(nextKey - 1, target + Math.max(4, Math.floor(this.frameBudget / 3)));
    const outputs = [];
    let err = null;
    const dec = new VideoDecoder({
      output: f => outputs.push(f),
      error: e => { err = e; },
    });
    dec.configure(this.config);
    const pending = [];
    for (let j = key; j <= ahead; j++) {
      const data = await this.readBytes(T.offset[j], T.size[j]);
      dec.decode(new EncodedVideoChunk({ type: j === key ? 'key' : 'delta', timestamp: j, data }));
      // keep the decode queue from growing without bound
      if (dec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
      // convert outputs as they arrive to free decoder surfaces
      while (outputs.length) pending.push(this.store(outputs.shift(), target, ahead, key));
    }
    await dec.flush().catch(e => { err = err || e; });
    while (outputs.length) pending.push(this.store(outputs.shift(), target, ahead, key));
    await Promise.all(pending);
    dec.close();
    if (!this.cache.has(target)) throw err || new Error('Decoder produced no picture for this frame');
    return this.cache.get(target);
  }

  async store(frame, target, ahead, key) {
    const i = frame.timestamp;
    // keep frames near the target (the rest of the GOP is needed only as references)
    const keep = i >= target - Math.floor(this.frameBudget / 2) || i === key;
    try { if (keep) this.remember(i, await createImageBitmap(frame)); }
    finally { frame.close(); }
  }

  async seekVideo(i) {
    if (!this.video) {
      this.video = document.createElement('video');
      this.video.muted = true; this.video.playsInline = true; this.video.preload = 'auto';
      this.video.src = URL.createObjectURL(this.file);
      await new Promise((res, rej) => { this.video.onloadeddata = res; this.video.onerror = () => rej(new Error('This browser cannot play this video')); });
    }
    const v = this.video;
    const T = this.T;
    // aim for the middle of the frame's display interval
    const r = T.presRank[i];
    const nextIdx = r + 1 < T.n ? T.presOrder[r + 1] : -1;
    const dur = nextIdx >= 0 ? T.pts[nextIdx] - T.pts[i] : 0.02;
    const t = Math.max(0, T.pts[i] + dur / 2);
    await new Promise(res => { v.onseeked = res; v.currentTime = t; });
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    this.remember(i, c);
    return c;
  }

  close() {
    for (const b of this.cache.values()) if (b && b.close) b.close();
    this.cache.clear();
    if (this.video) { URL.revokeObjectURL(this.video.src); this.video = null; }
  }
}
