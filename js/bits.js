// Bit-level reading plus a "syntax recorder" that remembers where every
// parsed field lives, so the UI can show values, docs and highlight bytes.

export class Overrun extends Error {
  constructor() { super('Ran past the end of the data'); }
}

// Reads bits MSB-first from a Uint8Array. `pos` is in bits.
// `base` is the file offset of bytes[0]; `map` (optional) maps each byte index
// to a file offset, used when emulation-prevention bytes were removed.
export class Bits {
  constructor(bytes, base = 0, map = null) {
    this.b = bytes; this.pos = 0; this.base = base; this.map = map;
    this.end = bytes.length * 8;
  }
  get left() { return this.end - this.pos; }
  get bytePos() { return this.pos >> 3; }
  aligned() { return (this.pos & 7) === 0; }
  fileOffset(byteIdx) {
    if (this.map) return byteIdx < this.map.length ? this.map[byteIdx] : this.map[this.map.length - 1] + 1;
    return this.base + byteIdx;
  }
  u(n) {
    if (n === 0) return 0;
    if (this.pos + n > this.end) { this.pos = this.end; throw new Overrun(); }
    let v = 0;
    // fast path for byte-aligned whole bytes
    while (n >= 8 && (this.pos & 7) === 0) { v = v * 256 + this.b[this.pos >> 3]; this.pos += 8; n -= 8; }
    while (n-- > 0) { v = v * 2 + ((this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1); this.pos++; }
    return v;
  }
  bit() {
    if (this.pos >= this.end) throw new Overrun();
    const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return v;
  }
  peek(n) { const p = this.pos; try { return this.u(n); } finally { this.pos = p; } }
  skip(n) { if (this.pos + n > this.end) { this.pos = this.end; throw new Overrun(); } this.pos += n; }
  s(n) { const v = this.u(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  ue() {
    let z = 0;
    while (this.bit() === 0) { if (++z > 31) throw new Error('Invalid Exp-Golomb code'); }
    return 2 ** z - 1 + this.u(z);
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
  te(max) { return max > 1 ? this.ue() : 1 - this.bit(); }
  alignTo() { this.pos = (this.pos + 7) & ~7; }
  bytes(n) {
    if (!this.aligned()) { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = this.u(8); return out; }
    if (this.pos + n * 8 > this.end) throw new Overrun();
    const out = this.b.subarray(this.pos >> 3, (this.pos >> 3) + n); this.pos += n * 8; return out;
  }
  // H.264/HEVC more_rbsp_data(): is there anything before the rbsp_stop_one_bit?
  moreRbsp() {
    if (this.pos >= this.end) return false;
    let last = this.b.length - 1;
    while (last >= 0 && this.b[last] === 0) last--;
    if (last < 0) return false;
    const byte = this.b[last];
    let tz = 0; while (((byte >> tz) & 1) === 0) tz++;
    const stopBit = last * 8 + (7 - tz);
    return this.pos < stopBit;
  }
}

// Remove emulation prevention bytes (00 00 03 -> 00 00). Returns the RBSP and a
// map from RBSP byte index to file offset.
export function unescapeRbsp(bytes, fileOffset) {
  const out = new Uint8Array(bytes.length);
  const map = new Float64Array(bytes.length);
  let o = 0, zeros = 0, removed = [];
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    if (zeros >= 2 && v === 3) { zeros = 0; removed.push(fileOffset + i); continue; }
    zeros = v === 0 ? zeros + 1 : 0;
    map[o] = fileOffset + i; out[o++] = v;
  }
  return { rbsp: out.subarray(0, o), map: map.subarray(0, o), removed };
}

// ---------------------------------------------------------------------------
// Syntax recorder. Fields: {name, v, s (start bit), l (bit length), fmt, kind,
// children, note, doc, table}. Positions are relative to the Bits buffer, and
// `src` on the root lets the UI map them to file offsets.

export class Syn {
  constructor(bits) {
    this.r = bits;
    this.root = [];
    this.stack = [this.root];
  }
  get cur() { return this.stack[this.stack.length - 1]; }
  push(f) { this.cur.push(f); return f; }
  rec(name, kind, fn, fmt) {
    const s = this.r.pos;
    const v = fn();
    this.push({ name, v, s, l: this.r.pos - s, kind, fmt });
    return v;
  }
  u(name, n, fmt) { return this.rec(name, 'u' + n, () => this.r.u(n), fmt); }
  s(name, n, fmt) { return this.rec(name, 'i' + n, () => this.r.s(n), fmt); }
  f(name, fmt) { return this.rec(name, 'u1', () => this.r.bit(), fmt); }
  ue(name, fmt) { return this.rec(name, 'ue(v)', () => this.r.ue(), fmt); }
  se(name, fmt) { return this.rec(name, 'se(v)', () => this.r.se(), fmt); }
  // u(64) as a Number (precise up to 2^53, plenty for file sizes / durations)
  u64(name, fmt) { return this.rec(name, 'u64', () => this.r.u(32) * 4294967296 + this.r.u(32), fmt); }
  fourcc(name, fmt) { return this.rec(name, 'fourcc', () => fourccStr(this.r.bytes(4)), fmt); }
  bytes(name, n, fmt) { return this.rec(name, 'bytes', () => this.r.bytes(n), fmt || hexFmt); }
  str(name, n) {
    return this.rec(name, 'string', () => new TextDecoder().decode(this.r.bytes(n)).replace(/\0+$/, ''), v => JSON.stringify(v));
  }
  cstr(name, maxBytes) {
    return this.rec(name, 'string', () => {
      const out = [];
      while (this.r.left >= 8 && (maxBytes === undefined || out.length < maxBytes)) { const c = this.r.u(8); if (!c) break; out.push(c); }
      return new TextDecoder().decode(new Uint8Array(out));
    }, v => JSON.stringify(v));
  }
  fixed(name, n, frac, fmt) {
    return this.rec(name, `fixed ${n - frac}.${frac}`, () => this.r.s(n) / 2 ** frac, fmt || (v => +v.toFixed(4) + ''));
  }
  ufixed(name, n, frac, fmt) {
    return this.rec(name, `ufixed ${n - frac}.${frac}`, () => this.r.u(n) / 2 ** frac, fmt || (v => +v.toFixed(4) + ''));
  }
  // A container for nested fields. fn(this) runs inside the group.
  group(name, fn, extra) {
    const g = { name, s: this.r.pos, l: 0, children: [], kind: 'group', ...extra };
    this.push(g);
    this.stack.push(g.children);
    let ret;
    try { ret = fn(this, g); }
    finally { this.stack.pop(); g.l = this.r.pos - g.s; }
    return ret;
  }
  // Derived value (computed, not stored in the bitstream).
  calc(name, v, fmt, note) { return this.push({ name, v, s: this.r.pos, l: 0, kind: 'derived', fmt, note }); }
  note(text) { const c = this.cur; if (c.length) c[c.length - 1].note = text; }
  last() { const c = this.cur; return c[c.length - 1]; }
  table(name, cols, rowCount, row, extra) {
    return this.push({ name, s: this.r.pos, l: 0, kind: 'table', table: { cols, rowCount, row }, ...extra });
  }
  error(e) {
    this.push({ name: e instanceof Overrun ? 'truncated' : 'parse error', v: e.message || String(e), s: this.r.pos, l: 0, kind: 'error' });
  }
}

export function fourccStr(b) {
  let s = '';
  for (let i = 0; i < 4; i++) s += b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : (b[i] === 0xa9 ? '©' : '.');
  return s;
}

export const hexFmt = v => {
  const n = Math.min(v.length, 48);
  let s = '';
  for (let i = 0; i < n; i++) s += v[i].toString(16).padStart(2, '0') + (i % 4 === 3 ? ' ' : '');
  return s.trim() + (v.length > n ? ` … (${v.length} bytes)` : '');
};

export const hex = (v, w = 2) => '0x' + v.toString(16).toUpperCase().padStart(w, '0');

// Look up a field (depth-first) by name in a syntax tree.
export function findField(fields, name) {
  for (const f of fields) {
    if (f.name === name) return f;
    if (f.children) { const r = findField(f.children, name); if (r) return r; }
  }
  return null;
}
