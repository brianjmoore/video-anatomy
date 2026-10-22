#!/usr/bin/env python3
"""Generate js/h264tables.js from FFmpeg sources (the values are the ITU-T H.264 spec tables).
Usage: python3 tools/gen_tables.py /path/to/ffmpeg/libavcodec"""
import re, sys, os
src_dir = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ff'
out_path = os.path.join(os.path.dirname(__file__), '..', 'js', 'h264tables.js')

def block(src, decl):
    i = src.index(decl)
    j = src.index('{', i)
    depth = 0
    for k in range(j, len(src)):
        if src[k] == '{': depth += 1
        elif src[k] == '}':
            depth -= 1
            if depth == 0: break
    body = src[j:k + 1]
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    return re.sub(r'//[^\n]*', '', body)

def flat(src, decl):
    return [int(x) for x in re.findall(r'-?\d+', block(src, decl))]

def rows(src, decl):
    b = block(src, decl)[1:-1]
    return [[int(x) for x in re.findall(r'-?\d+', r)] for r in re.findall(r'\{([^{}]*)\}', b)]

cab = open(f'{src_dir}/h264_cabac.c').read()
cc = open(f'{src_dir}/cabac.c').read()
cav = open(f'{src_dir}/h264_cavlc.c').read()
dat = open(f'{src_dir}/h264data.c').read()

I = flat(cab, 'cabac_context_init_I[1024][2]')
PB = flat(cab, 'cabac_context_init_PB[3][1024][2]')
T = flat(cc, 'ff_h264_cabac_tables)[')
assert len(I) == 2048 and len(PB) == 6144 and len(T) == 1343
lps = T[512:1024]
range_lps = [lps[q * 128 + st * 2] & 255 for st in range(64) for q in range(4)]
mlps = T[1024:1280]
trans_lps = [mlps[127 - st * 2] >> 1 for st in range(64)]
last8 = T[1280:]
sig8 = flat(cab, 'significant_coeff_flag_offset_8x8[2][63]')[:63]

J = lambda a: ','.join(map(str, a))
JR = lambda rs: '[' + ','.join('[' + J(r) + ']' for r in rs) + ']'
o = ['// H.264 spec tables (CABAC context init, LPS ranges, CAVLC codes), extracted from FFmpeg',
     '// sources by tools/gen_tables.py. Do not edit by hand.']
o.append(f'export const CTX_INIT_I = new Int8Array([{J(I)}]);')
o.append(f'const PB = [{J(PB)}];')
o.append('export const CTX_INIT_PB = [0, 1, 2].map(k => new Int8Array(PB.slice(k * 2048, k * 2048 + 2048)));')
o.append(f'export const RANGE_LPS = new Uint8Array([{J(range_lps)}]); // [pStateIdx * 4 + qCodIRangeIdx]')
o.append(f'export const TRANS_LPS = new Uint8Array([{J(trans_lps)}]);')
o.append(f'export const SIG_8x8_FRAME = new Uint8Array([{J(sig8)}]);')
o.append(f'export const LAST_8x8 = new Uint8Array([{J(last8)}]);')
for name in ['coeff_token_len', 'coeff_token_bits']:
    rs = rows(cav, f'static const uint8_t {name}[4][4*17]')
    o.append(f'export const {name.upper()} = {JR(rs)}; // [table][totalCoeff*4 + trailingOnes]')
for name in ['chroma_dc_coeff_token_len', 'chroma_dc_coeff_token_bits']:
    o.append(f'export const {name.upper()} = [{J(flat(cav, f"static const uint8_t {name}[4*5]"))}];')
for name, decl in [('total_zeros_len', '[16][16]'), ('total_zeros_bits', '[16][16]'), ('chroma_dc_total_zeros_len', '[3][4]'),
                   ('chroma_dc_total_zeros_bits', '[3][4]'), ('run_len', '[7][16]'), ('run_bits', '[7][16]')]:
    o.append(f'export const {name.upper()} = {JR(rows(cav, f"static const uint8_t {name}{decl}"))};')
for name in ['golomb_to_inter_cbp_gray', 'golomb_to_intra4x4_cbp_gray']:
    o.append(f'export const {name.upper()} = [{J(flat(cav, f"static const uint8_t {name}[16]"))}];')
for name in ['golomb_to_intra4x4_cbp', 'golomb_to_inter_cbp']:
    o.append(f'export const {name.upper()} = [{J(flat(dat, f"const uint8_t ff_h264_{name}[48]"))}];')
open(out_path, 'w').write('\n'.join(o) + '\n')
print('wrote', out_path)
