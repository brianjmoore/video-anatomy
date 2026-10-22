// AAC: AudioSpecificConfig and the start of raw_data_block() for AAC-LC frames.
import { Bits, Syn } from './bits.js';

export const AOT = {
  1: 'AAC Main', 2: 'AAC LC (Low Complexity)', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'SBR (HE-AAC)', 6: 'AAC Scalable',
  17: 'ER AAC LC', 19: 'ER AAC LTP', 20: 'ER AAC Scalable', 22: 'ER BSAC', 23: 'ER AAC LD', 29: 'PS (HE-AAC v2)',
  32: 'MPEG-1 Layer 1', 33: 'MPEG-1 Layer 2', 34: 'MPEG-1 Layer 3', 39: 'ER AAC ELD', 42: 'USAC (xHE-AAC)',
};
export const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const CHANNELS = { 0: 'defined in PCE', 1: 'mono (C)', 2: 'stereo (L R)', 3: 'C L R', 4: 'C L R Cs', 5: 'C L R Ls Rs', 6: '5.1 (C L R Ls Rs LFE)', 7: '7.1' };
// Number of scalefactor bands for long windows / short windows, by sample rate index
const NUM_SWB_LONG = [41, 41, 47, 49, 49, 51, 47, 47, 43, 43, 43, 40, 40];
const NUM_SWB_SHORT = [12, 12, 12, 14, 14, 14, 15, 15, 15, 15, 15, 15, 15];
export const WINDOW_SEQ = ['ONLY_LONG_SEQUENCE', 'LONG_START_SEQUENCE', 'EIGHT_SHORT_SEQUENCE', 'LONG_STOP_SEQUENCE'];
const ELEMENTS = ['SCE (single channel)', 'CPE (channel pair)', 'CCE (coupling)', 'LFE (low-frequency)', 'DSE (data stream)', 'PCE (program config)', 'FIL (fill)', 'END'];
const CODEBOOKS = { 0: 'ZERO_HCB (all zero)', 11: 'ESC_HCB', 13: 'NOISE_HCB', 14: 'INTENSITY_HCB2', 15: 'INTENSITY_HCB' };

export function parseAsc(bytes, fileOffset) {
  const r = new Bits(bytes, fileOffset);
  const s = new Syn(r);
  const c = {};
  const aot = (name) => {
    let v = s.u(name, 5, x => `${x} (${AOT[x] || '?'})`);
    if (v === 31) v = 32 + s.u(name + 'Ext', 6, x => `${x} (${AOT[32 + x] || '?'})`);
    return v;
  };
  const freq = (name) => {
    const i = s.u(name, 4, x => x === 15 ? '15 (explicit)' : `${x} (${SAMPLE_RATES[x]} Hz)`);
    return i === 15 ? s.u('samplingFrequency', 24) : SAMPLE_RATES[i];
  };
  try {
    s.group('AudioSpecificConfig', () => {
      c.aot = aot('audioObjectType');
      c.sampleRate = freq('samplingFrequencyIndex');
      c.freqIndex = SAMPLE_RATES.indexOf(c.sampleRate);
      c.channelConfig = s.u('channelConfiguration', 4, x => `${x} (${CHANNELS[x] || '?'})`);
      if (c.aot === 5 || c.aot === 29) {
        c.sbr = true; c.ps = c.aot === 29;
        c.outRate = freq('extensionSamplingFrequencyIndex');
        c.aot = aot('audioObjectType');
      }
      if ([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].includes(c.aot)) {
        s.group('GASpecificConfig', () => {
          c.frameLength = s.f('frameLengthFlag', v => v ? '1 (960 samples per frame)' : '0 (1024 samples per frame)') ? 960 : 1024;
          if (s.f('dependsOnCoreCoder')) s.u('coreCoderDelay', 14);
          s.f('extensionFlag');
          if (c.channelConfig === 0) s.calc('program_config_element', 'not decoded');
        });
      }
      if (!c.sbr && r.left >= 16 && r.peek(11) === 0x2b7) {
        s.u('syncExtensionType', 11, v => '0x' + v.toString(16));
        const ext = aot('extensionAudioObjectType');
        if (ext === 5) {
          c.sbr = s.f('sbrPresentFlag');
          if (c.sbr) {
            c.outRate = freq('extensionSamplingFrequencyIndex');
            if (r.left >= 12 && r.peek(11) === 0x548) { s.u('syncExtensionType', 11); c.ps = s.f('psPresentFlag'); }
          }
        }
      }
    });
  } catch (e) { s.error(e); }
  c.fields = s.root;
  c.frameLength ||= 1024;
  c.name = (c.ps ? 'HE-AAC v2 (' : c.sbr ? 'HE-AAC (' : '') + (AOT[c.aot] || 'AOT ' + c.aot) + (c.sbr ? ' + SBR' : '') + (c.ps ? ' + PS)' : c.sbr ? ')' : '');
  return c;
}

function icsInfo(s, cfg) {
  const info = {};
  s.group('ics_info', () => {
    s.f('ics_reserved_bit');
    info.seq = s.u('window_sequence', 2, v => `${v} (${WINDOW_SEQ[v]})`);
    s.note(['One long 2048-sample window: good frequency resolution for steady sounds',
      'Transition from a long window into short windows', 'Eight short 256-sample windows: good time resolution for sharp attacks (transients)',
      'Transition from short windows back to long'][info.seq]);
    info.shape = s.f('window_shape', v => v ? '1 (Kaiser-Bessel derived)' : '0 (sine)');
    if (info.seq === 2) {
      info.max_sfb = s.u('max_sfb', 4);
      info.grouping = s.u('scale_factor_grouping', 7, v => v.toString(2).padStart(7, '0'));
      info.groups = [1];
      for (let i = 6; i >= 0; i--) { if ((info.grouping >> i) & 1) info.groups[info.groups.length - 1]++; else info.groups.push(1); }
      s.calc('→ window groups', info.groups.join(' + '), null, 'Consecutive short windows that share scale factors');
      info.num_swb = NUM_SWB_SHORT[cfg.freqIndex];
    } else {
      info.max_sfb = s.u('max_sfb', 6);
      info.num_swb = NUM_SWB_LONG[cfg.freqIndex];
      info.groups = [1];
      if (s.f('predictor_data_present')) s.calc('predictor data', 'not decoded');
    }
    s.note(`Only the lowest ${info.max_sfb} of ${info.num_swb} scalefactor bands carry data; everything above is silent. This sets the audio bandwidth`);
  });
  return info;
}

function sectionData(s, info) {
  const sects = [];
  s.group('section_data', () => {
    const bits = info.seq === 2 ? 3 : 5, esc = (1 << bits) - 1;
    for (let g = 0; g < info.groups.length; g++) {
      let k = 0;
      while (k < info.max_sfb) {
        const cb = s.r.u(4);
        let len = 0, inc;
        while ((inc = s.r.u(bits)) === esc) len += inc;
        len += inc;
        sects.push({ g, cb, start: k, end: k + len });
        k += len;
        if (len === 0 || sects.length > 200) throw new Error('bad section data');
      }
    }
    s.calc('sections', sects.map(x => `bands ${x.start}–${x.end - 1}: ${CODEBOOKS[x.cb] || 'codebook ' + x.cb}`).join('\n'));
  });
  return sects;
}

// Parse the start of a raw AAC-LC frame: the first element and its first channel stream.
export function parseAacFrame(bytes, fileOffset, cfg) {
  const r = new Bits(bytes, fileOffset);
  const s = new Syn(r);
  const out = { fields: s.root };
  try {
    s.group('raw_data_block (start)', () => {
      const id = s.u('id_syn_ele', 3, v => `${v} (${ELEMENTS[v]})`);
      out.element = ELEMENTS[id].split(' ')[0];
      if (id === 0 || id === 1 || id === 3) {
        s.u('element_instance_tag', 4);
        let common = 0;
        if (id === 1) {
          common = s.f('common_window', v => v ? '1 (both channels share window settings)' : '0');
          if (common) {
            out.ics = icsInfo(s, cfg);
            const ms = s.u('ms_mask_present', 2, v => `${v} (${['no M/S', 'M/S per band', 'M/S all bands', 'reserved'][v]})`);
            if (ms === 1) {
              let n = 0; for (const _ of out.ics.groups) for (let b = 0; b < out.ics.max_sfb; b++) n++;
              s.calc('ms_used[]', `${n} bits`); r.skip(n);
            }
            out.ms = ms;
          }
        }
        s.group('individual_channel_stream (first channel)', () => {
          out.global_gain = s.u('global_gain', 8);
          s.note('Starting point for the scale factors: overall loudness/precision of this channel');
          if (!common) out.ics = icsInfo(s, cfg);
          out.sections = sectionData(s, out.ics);
          s.calc('scale_factor_data, spectral_data, …', 'Huffman-coded (not decoded)');
        });
      }
    });
  } catch (e) { s.error(e); out.error = e.message; }
  return out;
}

// Build a 7-byte ADTS header so raw AAC frames can be decoded by decodeAudioData.
export function adtsHeader(cfg, frameLen) {
  const len = frameLen + 7;
  const prof = Math.max(0, Math.min(3, cfg.aot - 1));
  const fi = cfg.freqIndex >= 0 ? cfg.freqIndex : 4;
  const ch = cfg.channelConfig || 2;
  return new Uint8Array([
    0xff, 0xf1, (prof << 6) | (fi << 2) | (ch >> 2), ((ch & 3) << 6) | (len >> 11),
    (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc,
  ]);
}
