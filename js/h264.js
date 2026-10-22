// H.264 / AVC bitstream syntax: NAL units, SPS, PPS, SEI, slice headers.
import { Bits, Syn, unescapeRbsp, hexFmt } from './bits.js';

export const NAL_TYPES = {
  0: 'Unspecified', 1: 'Coded slice (non-IDR)', 2: 'Slice data partition A', 3: 'Slice data partition B',
  4: 'Slice data partition C', 5: 'Coded slice (IDR)', 6: 'SEI', 7: 'SPS (sequence parameter set)',
  8: 'PPS (picture parameter set)', 9: 'Access unit delimiter', 10: 'End of sequence', 11: 'End of stream',
  12: 'Filler data', 13: 'SPS extension', 14: 'Prefix NAL', 15: 'Subset SPS', 19: 'Auxiliary slice',
  20: 'Slice extension (SVC/MVC)',
};
export const NAL_SHORT = { 1: 'slice', 5: 'IDR slice', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD', 10: 'EOS', 11: 'EOB', 12: 'filler' };

export const SLICE_TYPES = ['P', 'B', 'I', 'SP', 'SI'];
const PROFILES = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2',
  244: 'High 4:4:4 Predictive', 44: 'CAVLC 4:4:4 Intra', 83: 'Scalable Baseline', 86: 'Scalable High',
  118: 'Multiview High', 128: 'Stereo High', 138: 'Multiview Depth High',
};
const CHROMA_FORMATS = ['4:0:0 (monochrome)', '4:2:0', '4:2:2', '4:4:4'];
const ASPECT = [null, '1:1', '12:11', '10:11', '16:11', '40:33', '24:11', '20:11', '32:11', '80:33', '18:11', '15:11', '64:33', '160:99', '4:3', '3:2', '2:1'];
const SEI_TYPES = {
  0: 'buffering_period', 1: 'pic_timing', 2: 'pan_scan_rect', 3: 'filler_payload', 4: 'user_data_registered_itu_t_t35',
  5: 'user_data_unregistered', 6: 'recovery_point', 7: 'dec_ref_pic_marking_repetition', 45: 'frame_packing_arrangement',
  47: 'display_orientation', 137: 'mastering_display_colour_volume', 144: 'content_light_level_info',
  147: 'alternative_transfer_characteristics',
};
export const COLOUR_PRIMARIES = { 1: 'BT.709', 2: 'unspecified', 4: 'BT.470M', 5: 'BT.470BG', 6: 'SMPTE 170M', 7: 'SMPTE 240M', 8: 'film', 9: 'BT.2020', 10: 'SMPTE ST 428', 11: 'DCI-P3', 12: 'Display P3' };
export const TRANSFER = { 1: 'BT.709', 2: 'unspecified', 4: 'gamma 2.2', 5: 'gamma 2.8', 6: 'SMPTE 170M', 7: 'SMPTE 240M', 8: 'linear', 13: 'sRGB', 14: 'BT.2020 10-bit', 15: 'BT.2020 12-bit', 16: 'PQ (HDR10)', 18: 'HLG' };
export const MATRIX = { 0: 'identity (RGB)', 1: 'BT.709', 2: 'unspecified', 5: 'BT.470BG', 6: 'SMPTE 170M', 7: 'SMPTE 240M', 9: 'BT.2020 NCL', 10: 'BT.2020 CL' };
const enumFmt = (m) => v => (m[v] !== undefined ? `${v} (${m[v]})` : `${v}`);
const flag = v => (v ? '1 (yes)' : '0 (no)');

export const profileName = p => PROFILES[p] || `profile ${p}`;

export function nalHeader(s) {
  s.f('forbidden_zero_bit');
  const ref = s.u('nal_ref_idc', 2, v => `${v}${v ? ' (used for reference)' : ' (not a reference)'}`);
  const type = s.u('nal_unit_type', 5, v => `${v} (${NAL_TYPES[v] || 'reserved'})`);
  return { ref, type };
}

// Parse one NAL unit. `bytes` is the escaped payload (starts with the header byte).
// state: { sps: {}, pps: {} } is updated with any parameter sets found.
export function parseNal(bytes, fileOffset, state, opts = {}) {
  const { rbsp, map, removed } = unescapeRbsp(bytes, fileOffset);
  const r = new Bits(rbsp, fileOffset, map);
  const s = new Syn(r);
  const out = { fields: s.root, bits: r, type: bytes[0] & 31, ref: (bytes[0] >> 5) & 3, size: bytes.length, epb: removed, fileOffset };
  try {
    s.group('nal_unit_header', () => nalHeader(s));
    switch (out.type) {
      case 7: out.sps = parseSps(s); state.sps[out.sps.id] = out.sps; break;
      case 8: out.pps = parsePps(s, state); if (out.pps) state.pps[out.pps.id] = out.pps; break;
      case 6: parseSei(s); break;
      case 9: s.u('primary_pic_type', 3, v => `${v} (${['I', 'I,P', 'I,P,B', 'SI', 'SI,SP', 'I,SI', 'I,SI,P,SP', 'I,SI,P,SP,B'][v]})`); break;
      case 1: case 5:
        out.slice = parseSliceHeader(s, out, state);
        out.sliceDataBit = r.pos;
        if (out.slice && opts.withSliceData !== false) {
          s.calc('slice_data()', `${((r.end - r.pos) / 8).toFixed(0)} bytes of entropy-coded macroblocks`, null,
            'Everything after the slice header is the compressed macroblock data. Open the Macroblocks view to decode it.');
        }
        break;
      default: break;
    }
  } catch (e) { s.error(e); out.error = e.message; }
  return out;
}

// ---------------------------------------------------------------------------
// SPS

function scalingList(s, size, name) {
  return s.group(name, () => {
    let last = 8, next = 8;
    const list = [];
    for (let j = 0; j < size; j++) {
      if (next !== 0) {
        const d = s.r.se(); // recorded compactly below
        next = (last + d + 256) % 256;
        if (j === 0 && next === 0) { s.calc('useDefaultScalingMatrixFlag', 1); return 'default'; }
      }
      list[j] = next === 0 ? last : next;
      last = list[j];
    }
    s.calc('values (zigzag order)', list.join(' '));
    return list;
  });
}

export function parseSps(s) {
  const sps = {};
  s.group('seq_parameter_set_rbsp', () => {
    sps.profile_idc = s.u('profile_idc', 8, v => `${v} (${profileName(v)})`);
    for (let i = 0; i < 6; i++) sps['cs' + i] = s.f(`constraint_set${i}_flag`);
    s.u('reserved_zero_2bits', 2);
    sps.level_idc = s.u('level_idc', 8, v => `${v} (Level ${v / 10})`);
    sps.id = s.ue('seq_parameter_set_id');
    sps.chroma_format_idc = 1;
    sps.bit_depth_luma = 8; sps.bit_depth_chroma = 8;
    sps.separate_colour_plane_flag = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(sps.profile_idc)) {
      sps.chroma_format_idc = s.ue('chroma_format_idc', v => `${v} (${CHROMA_FORMATS[v]})`);
      if (sps.chroma_format_idc === 3) sps.separate_colour_plane_flag = s.f('separate_colour_plane_flag');
      sps.bit_depth_luma = 8 + s.ue('bit_depth_luma_minus8');
      sps.bit_depth_chroma = 8 + s.ue('bit_depth_chroma_minus8');
      sps.qpprime_y_zero_transform_bypass_flag = s.f('qpprime_y_zero_transform_bypass_flag');
      sps.seq_scaling_matrix_present_flag = s.f('seq_scaling_matrix_present_flag');
      if (sps.seq_scaling_matrix_present_flag) {
        sps.scaling = [];
        for (let i = 0; i < (sps.chroma_format_idc !== 3 ? 8 : 12); i++) {
          if (s.f(`seq_scaling_list_present_flag[${i}]`)) sps.scaling[i] = scalingList(s, i < 6 ? 16 : 64, `scaling_list[${i}]`);
        }
      }
    }
    sps.ChromaArrayType = sps.separate_colour_plane_flag ? 0 : sps.chroma_format_idc;
    sps.log2_max_frame_num = 4 + s.ue('log2_max_frame_num_minus4');
    s.note(`frame_num uses ${sps.log2_max_frame_num} bits, so it counts 0…${2 ** sps.log2_max_frame_num - 1} then wraps`);
    sps.poc_type = s.ue('pic_order_cnt_type');
    if (sps.poc_type === 0) {
      sps.log2_max_poc_lsb = 4 + s.ue('log2_max_pic_order_cnt_lsb_minus4');
    } else if (sps.poc_type === 1) {
      sps.delta_pic_order_always_zero_flag = s.f('delta_pic_order_always_zero_flag');
      sps.offset_for_non_ref_pic = s.se('offset_for_non_ref_pic');
      sps.offset_for_top_to_bottom_field = s.se('offset_for_top_to_bottom_field');
      const n = s.ue('num_ref_frames_in_pic_order_cnt_cycle');
      sps.offset_for_ref_frame = [];
      for (let i = 0; i < n; i++) sps.offset_for_ref_frame.push(s.se(`offset_for_ref_frame[${i}]`));
    }
    sps.max_num_ref_frames = s.ue('max_num_ref_frames');
    s.f('gaps_in_frame_num_value_allowed_flag');
    sps.width_mbs = 1 + s.ue('pic_width_in_mbs_minus1');
    s.note(`${sps.width_mbs} macroblocks × 16 = ${sps.width_mbs * 16} pixels wide`);
    sps.height_map_units = 1 + s.ue('pic_height_in_map_units_minus1');
    sps.frame_mbs_only_flag = s.f('frame_mbs_only_flag', v => v ? '1 (progressive frames only)' : '0 (may contain interlaced fields)');
    if (!sps.frame_mbs_only_flag) sps.mb_adaptive_frame_field_flag = s.f('mb_adaptive_frame_field_flag');
    sps.height_mbs = (2 - sps.frame_mbs_only_flag) * sps.height_map_units;
    sps.direct_8x8_inference_flag = s.f('direct_8x8_inference_flag');
    let crop = [0, 0, 0, 0];
    if (s.f('frame_cropping_flag')) {
      crop = [s.ue('frame_crop_left_offset'), s.ue('frame_crop_right_offset'), s.ue('frame_crop_top_offset'), s.ue('frame_crop_bottom_offset')];
    }
    const subW = sps.ChromaArrayType === 1 || sps.ChromaArrayType === 2 ? 2 : 1;
    const subH = sps.ChromaArrayType === 1 ? 2 : 1;
    const cropUnitX = sps.ChromaArrayType === 0 ? 1 : subW;
    const cropUnitY = (sps.ChromaArrayType === 0 ? 1 : subH) * (2 - sps.frame_mbs_only_flag);
    sps.codedWidth = sps.width_mbs * 16; sps.codedHeight = sps.height_mbs * 16;
    sps.crop = { left: crop[0] * cropUnitX, right: crop[1] * cropUnitX, top: crop[2] * cropUnitY, bottom: crop[3] * cropUnitY };
    sps.width = sps.codedWidth - sps.crop.left - sps.crop.right;
    sps.height = sps.codedHeight - sps.crop.top - sps.crop.bottom;
    s.calc('→ coded size', `${sps.codedWidth}×${sps.codedHeight} (${sps.width_mbs}×${sps.height_mbs} macroblocks)`);
    s.calc('→ display size after cropping', `${sps.width}×${sps.height}`);
    if (s.f('vui_parameters_present_flag')) sps.vui = vui(s);
  });
  return sps;
}

function hrd(s, name) {
  s.group(name, () => {
    const cnt = s.ue('cpb_cnt_minus1') + 1;
    const brs = s.u('bit_rate_scale', 4); const css = s.u('cpb_size_scale', 4);
    for (let i = 0; i < cnt; i++) {
      s.group(`SchedSelIdx ${i}`, () => {
        const br = s.ue('bit_rate_value_minus1') + 1; s.note(`${((br * 2 ** (6 + brs)) / 1000).toFixed(0)} kbit/s`);
        const cs = s.ue('cpb_size_value_minus1') + 1; s.note(`${((cs * 2 ** (4 + css)) / 1000).toFixed(0)} kbit buffer`);
        s.f('cbr_flag');
      });
    }
    s.u('initial_cpb_removal_delay_length_minus1', 5); s.u('cpb_removal_delay_length_minus1', 5);
    s.u('dpb_output_delay_length_minus1', 5); s.u('time_offset_length', 5);
  });
}

function vui(s) {
  const v = {};
  s.group('vui_parameters', () => {
    if (s.f('aspect_ratio_info_present_flag')) {
      const idc = s.u('aspect_ratio_idc', 8, x => `${x}${ASPECT[x] ? ` (SAR ${ASPECT[x]})` : x === 255 ? ' (Extended_SAR)' : ''}`);
      if (idc === 255) { v.sar = [s.u('sar_width', 16), s.u('sar_height', 16)]; }
      else if (ASPECT[idc]) v.sar = ASPECT[idc].split(':').map(Number);
    }
    if (s.f('overscan_info_present_flag')) s.f('overscan_appropriate_flag');
    if (s.f('video_signal_type_present_flag')) {
      s.u('video_format', 3, enumFmt({ 0: 'component', 1: 'PAL', 2: 'NTSC', 3: 'SECAM', 4: 'MAC', 5: 'unspecified' }));
      v.full_range = s.f('video_full_range_flag', x => x ? '1 (full range 0–255)' : '0 (limited/TV range 16–235)');
      if (s.f('colour_description_present_flag')) {
        v.primaries = s.u('colour_primaries', 8, enumFmt(COLOUR_PRIMARIES));
        v.transfer = s.u('transfer_characteristics', 8, enumFmt(TRANSFER));
        v.matrix = s.u('matrix_coefficients', 8, enumFmt(MATRIX));
      }
    }
    if (s.f('chroma_loc_info_present_flag')) { s.ue('chroma_sample_loc_type_top_field'); s.ue('chroma_sample_loc_type_bottom_field'); }
    if (s.f('timing_info_present_flag')) {
      v.num_units_in_tick = s.u('num_units_in_tick', 32);
      v.time_scale = s.u('time_scale', 32);
      s.calc('→ max field/frame rate', `${(v.time_scale / (2 * v.num_units_in_tick)).toFixed(3)} fps`, null, 'time_scale ÷ (2 × num_units_in_tick): one tick is a field period');
      s.f('fixed_frame_rate_flag');
    }
    const nal = s.f('nal_hrd_parameters_present_flag'); if (nal) hrd(s, 'nal_hrd_parameters');
    const vcl = s.f('vcl_hrd_parameters_present_flag'); if (vcl) hrd(s, 'vcl_hrd_parameters');
    if (nal || vcl) s.f('low_delay_hrd_flag');
    s.f('pic_struct_present_flag');
    if (s.f('bitstream_restriction_flag')) {
      s.f('motion_vectors_over_pic_boundaries_flag');
      s.ue('max_bytes_per_pic_denom'); s.ue('max_bits_per_mb_denom');
      s.ue('log2_max_mv_length_horizontal'); s.ue('log2_max_mv_length_vertical');
      v.max_num_reorder_frames = s.ue('max_num_reorder_frames');
      s.note('How many frames can arrive before a frame that is displayed earlier: the B-frame reorder depth');
      v.max_dec_frame_buffering = s.ue('max_dec_frame_buffering');
    }
  });
  return v;
}

// ---------------------------------------------------------------------------
// PPS

export function parsePps(s, state) {
  const p = {};
  s.group('pic_parameter_set_rbsp', () => {
    p.id = s.ue('pic_parameter_set_id');
    p.sps_id = s.ue('seq_parameter_set_id');
    const sps = state.sps[p.sps_id];
    p.entropy_coding_mode_flag = s.f('entropy_coding_mode_flag', v => v ? '1 (CABAC: arithmetic coding)' : '0 (CAVLC: variable-length codes)');
    p.bottom_field_pic_order_in_frame_present_flag = s.f('bottom_field_pic_order_in_frame_present_flag');
    p.num_slice_groups = s.ue('num_slice_groups_minus1') + 1;
    if (p.num_slice_groups > 1) {
      p.slice_group_map_type = s.ue('slice_group_map_type');
      const t = p.slice_group_map_type;
      if (t === 0) for (let i = 0; i < p.num_slice_groups; i++) s.ue(`run_length_minus1[${i}]`);
      else if (t === 2) for (let i = 0; i < p.num_slice_groups - 1; i++) { s.ue(`top_left[${i}]`); s.ue(`bottom_right[${i}]`); }
      else if (t >= 3 && t <= 5) { s.f('slice_group_change_direction_flag'); p.slice_group_change_rate = s.ue('slice_group_change_rate_minus1') + 1; }
      else if (t === 6) {
        const n = s.ue('pic_size_in_map_units_minus1') + 1;
        const bits = Math.ceil(Math.log2(p.num_slice_groups));
        for (let i = 0; i < n; i++) s.r.u(bits);
      }
    }
    p.num_ref_idx_l0_default = s.ue('num_ref_idx_l0_default_active_minus1') + 1;
    p.num_ref_idx_l1_default = s.ue('num_ref_idx_l1_default_active_minus1') + 1;
    p.weighted_pred_flag = s.f('weighted_pred_flag');
    p.weighted_bipred_idc = s.u('weighted_bipred_idc', 2, enumFmt({ 0: 'default', 1: 'explicit', 2: 'implicit' }));
    p.pic_init_qp = 26 + s.se('pic_init_qp_minus26');
    s.note(`Starting quantizer (QP ${p.pic_init_qp}) for slices; each slice adjusts it with slice_qp_delta`);
    s.se('pic_init_qs_minus26');
    p.chroma_qp_index_offset = s.se('chroma_qp_index_offset');
    p.deblocking_filter_control_present_flag = s.f('deblocking_filter_control_present_flag');
    p.constrained_intra_pred_flag = s.f('constrained_intra_pred_flag');
    p.redundant_pic_cnt_present_flag = s.f('redundant_pic_cnt_present_flag');
    p.transform_8x8_mode_flag = 0;
    p.second_chroma_qp_index_offset = p.chroma_qp_index_offset;
    if (s.r.moreRbsp()) {
      p.transform_8x8_mode_flag = s.f('transform_8x8_mode_flag', v => v ? '1 (8×8 transforms allowed, High profile)' : '0');
      if (s.f('pic_scaling_matrix_present_flag')) {
        const n = 6 + ((sps ? sps.chroma_format_idc : 1) !== 3 ? 2 : 6) * p.transform_8x8_mode_flag;
        for (let i = 0; i < n; i++) if (s.f(`pic_scaling_list_present_flag[${i}]`)) scalingList(s, i < 6 ? 16 : 64, `scaling_list[${i}]`);
      }
      p.second_chroma_qp_index_offset = s.se('second_chroma_qp_index_offset');
    }
  });
  return p;
}

// ---------------------------------------------------------------------------
// SEI

function parseSei(s) {
  let i = 0;
  while (s.r.moreRbsp() && i++ < 64) {
    let type = 0, size = 0, b;
    const start = s.r.pos;
    while ((b = s.r.u(8)) === 255) type += 255; type += b;
    while ((b = s.r.u(8)) === 255) size += 255; size += b;
    s.group(`sei_message: ${SEI_TYPES[type] || 'payload type ' + type}`, () => {
      s.calc('payloadType', type, enumFmt(SEI_TYPES)); s.calc('payloadSize', size, v => v + ' bytes');
      const end = s.r.pos + size * 8;
      try {
        if (type === 5) {
          s.bytes('uuid_iso_iec_11578', 16);
          const txt = s.str('user_data_payload_byte', size - 16);
          if (/x264|x265/.test(txt)) s.note('Encoders often store their name and every setting here – this is the full x264/x265 command line');
        } else if (type === 6) {
          s.ue('recovery_frame_cnt'); s.f('exact_match_flag'); s.f('broken_link_flag'); s.u('changing_slice_group_idc', 2);
        } else if (type === 4) {
          const cc = s.u('itu_t_t35_country_code', 8, v => v === 0xb5 ? '181 (USA)' : v);
          if (cc === 0xb5) {
            const prov = s.u('itu_t_t35_provider_code', 16, v => v === 0x31 ? '0x31 (ATSC)' : v);
            if (prov === 0x31 && size >= 8) {
              const uid = s.fourcc('user_identifier');
              if (uid === 'GA94') s.note('ATSC A/53 closed captions (CEA-608/708) live here');
            }
          }
          s.bytes('payload', Math.max(0, (end - s.r.pos) >> 3));
        } else if (type === 137) {
          for (let c = 0; c < 3; c++) { s.u(`display_primaries_x[${c}]`, 16, v => (v * 0.00002).toFixed(4)); s.u(`display_primaries_y[${c}]`, 16, v => (v * 0.00002).toFixed(4)); }
          s.u('white_point_x', 16, v => (v * 0.00002).toFixed(4)); s.u('white_point_y', 16, v => (v * 0.00002).toFixed(4));
          s.u('max_display_mastering_luminance', 32, v => (v / 10000) + ' cd/m²'); s.u('min_display_mastering_luminance', 32, v => (v / 10000) + ' cd/m²');
        } else if (type === 144) {
          s.u('max_content_light_level', 16, v => v + ' cd/m²'); s.u('max_pic_average_light_level', 16, v => v + ' cd/m²');
        } else if (size) {
          s.bytes('payload', size);
        }
      } catch (e) { s.error(e); }
      s.r.pos = Math.min(end, s.r.end);
    }, { s: start });
  }
}

// ---------------------------------------------------------------------------
// Slice header

export function parseSliceHeader(s, nal, state) {
  const h = { nal_ref_idc: nal.ref, idr: nal.type === 5 };
  return s.group('slice_header', () => {
    h.first_mb_in_slice = s.ue('first_mb_in_slice');
    h.slice_type_raw = s.ue('slice_type', v => `${v} (${SLICE_TYPES[v % 5]}${v >= 5 ? ', all slices in picture same type' : ''})`);
    h.slice_type = h.slice_type_raw % 5;
    h.type = SLICE_TYPES[h.slice_type];
    h.pps_id = s.ue('pic_parameter_set_id');
    const pps = state.pps[h.pps_id];
    if (!pps) { s.calc('error', `PPS ${h.pps_id} not found`); return null; }
    const sps = state.sps[pps.sps_id];
    if (!sps) { s.calc('error', `SPS ${pps.sps_id} not found`); return null; }
    h.pps = pps; h.sps = sps;
    if (sps.separate_colour_plane_flag) s.u('colour_plane_id', 2);
    h.frame_num = s.u('frame_num', sps.log2_max_frame_num);
    s.note('Counts reference pictures in decode order; used to identify reference frames');
    h.field_pic_flag = 0; h.bottom_field_flag = 0;
    if (!sps.frame_mbs_only_flag) {
      h.field_pic_flag = s.f('field_pic_flag');
      if (h.field_pic_flag) h.bottom_field_flag = s.f('bottom_field_flag');
    }
    h.MbaffFrameFlag = sps.mb_adaptive_frame_field_flag && !h.field_pic_flag ? 1 : 0;
    if (h.idr) h.idr_pic_id = s.ue('idr_pic_id');
    h.delta_pic_order_cnt_bottom = 0; h.delta_pic_order_cnt = [0, 0];
    if (sps.poc_type === 0) {
      h.pic_order_cnt_lsb = s.u('pic_order_cnt_lsb', sps.log2_max_poc_lsb);
      s.note('Low bits of the Picture Order Count: tells the decoder where this picture goes in display order');
      if (pps.bottom_field_pic_order_in_frame_present_flag && !h.field_pic_flag) h.delta_pic_order_cnt_bottom = s.se('delta_pic_order_cnt_bottom');
    }
    if (sps.poc_type === 1 && !sps.delta_pic_order_always_zero_flag) {
      h.delta_pic_order_cnt[0] = s.se('delta_pic_order_cnt[0]');
      if (pps.bottom_field_pic_order_in_frame_present_flag && !h.field_pic_flag) h.delta_pic_order_cnt[1] = s.se('delta_pic_order_cnt[1]');
    }
    if (pps.redundant_pic_cnt_present_flag) s.ue('redundant_pic_cnt');
    if (h.type === 'B') h.direct_spatial_mv_pred_flag = s.f('direct_spatial_mv_pred_flag', v => v ? '1 (spatial direct)' : '0 (temporal direct)');
    h.num_ref_idx_l0_active = pps.num_ref_idx_l0_default;
    h.num_ref_idx_l1_active = pps.num_ref_idx_l1_default;
    if (h.type === 'P' || h.type === 'SP' || h.type === 'B') {
      if (s.f('num_ref_idx_active_override_flag')) {
        h.num_ref_idx_l0_active = s.ue('num_ref_idx_l0_active_minus1') + 1;
        if (h.type === 'B') h.num_ref_idx_l1_active = s.ue('num_ref_idx_l1_active_minus1') + 1;
      }
    }
    if (h.type === 'I' || h.type === 'SI') { h.num_ref_idx_l0_active = 0; h.num_ref_idx_l1_active = 0; }
    if (h.type === 'P' || h.type === 'SP') h.num_ref_idx_l1_active = 0;
    h.mods = [[], []];
    if (h.type !== 'I' && h.type !== 'SI') {
      s.group('ref_pic_list_modification', () => {
        for (let l = 0; l < (h.type === 'B' ? 2 : 1); l++) {
          if (s.f(`ref_pic_list_modification_flag_l${l}`)) {
            let idc, n = 0;
            do {
              idc = s.ue('modification_of_pic_nums_idc', v => `${v} (${['subtract from picNum', 'add to picNum', 'long-term pic', 'end'][v] || '?'})`);
              if (idc === 0 || idc === 1) h.mods[l].push({ idc, v: s.ue('abs_diff_pic_num_minus1') + 1 });
              else if (idc === 2) h.mods[l].push({ idc, v: s.ue('long_term_pic_num') });
            } while (idc !== 3 && ++n < 64);
          }
        }
      });
    }
    if ((pps.weighted_pred_flag && (h.type === 'P' || h.type === 'SP')) || (pps.weighted_bipred_idc === 1 && h.type === 'B')) {
      h.pwt = predWeightTable(s, h, sps);
    }
    if (nal.ref) {
      s.group('dec_ref_pic_marking', () => {
        if (h.idr) {
          s.f('no_output_of_prior_pics_flag');
          h.long_term_reference_flag = s.f('long_term_reference_flag');
        } else if (s.f('adaptive_ref_pic_marking_mode_flag', v => v ? '1 (explicit commands follow)' : '0 (sliding window)')) {
          h.mmco = [];
          let op, n = 0;
          do {
            op = s.ue('memory_management_control_operation', v => `${v} (${['end', 'unmark short-term', 'unmark long-term', 'short→long-term', 'set max long-term idx', 'unmark all', 'current→long-term'][v] || '?'})`);
            const m = { op };
            if (op === 1 || op === 3) m.diff = s.ue('difference_of_pic_nums_minus1') + 1;
            if (op === 2) m.ltpn = s.ue('long_term_pic_num');
            if (op === 3 || op === 6) m.ltfi = s.ue('long_term_frame_idx');
            if (op === 4) m.max = s.ue('max_long_term_frame_idx_plus1');
            if (op) h.mmco.push(m);
          } while (op !== 0 && ++n < 64);
        }
      });
    }
    if (pps.entropy_coding_mode_flag && h.type !== 'I' && h.type !== 'SI') h.cabac_init_idc = s.ue('cabac_init_idc');
    h.slice_qp_delta = s.se('slice_qp_delta');
    h.qp = pps.pic_init_qp + h.slice_qp_delta;
    s.note(`Slice QP = ${pps.pic_init_qp} + ${h.slice_qp_delta} = ${h.qp}. Higher QP = coarser quantization = fewer bits`);
    if (h.type === 'SP' || h.type === 'SI') { if (h.type === 'SP') s.f('sp_for_switch_flag'); s.se('slice_qs_delta'); }
    h.disable_deblocking_filter_idc = 0; h.alpha = 0; h.beta = 0;
    if (pps.deblocking_filter_control_present_flag) {
      h.disable_deblocking_filter_idc = s.ue('disable_deblocking_filter_idc', enumFmt({ 0: 'filter on', 1: 'filter off', 2: 'on, but not across slice edges' }));
      if (h.disable_deblocking_filter_idc !== 1) { h.alpha = s.se('slice_alpha_c0_offset_div2'); h.beta = s.se('slice_beta_offset_div2'); }
    }
    if (pps.num_slice_groups > 1 && pps.slice_group_map_type >= 3 && pps.slice_group_map_type <= 5) {
      const pics = sps.width_mbs * sps.height_map_units;
      s.u('slice_group_change_cycle', Math.ceil(Math.log2(pics / pps.slice_group_change_rate + 1)));
    }
    return h;
  });
}

function predWeightTable(s, h, sps) {
  const t = { l: [[], []] };
  s.group('pred_weight_table', () => {
    t.luma_log2 = s.ue('luma_log2_weight_denom');
    if (sps.ChromaArrayType) t.chroma_log2 = s.ue('chroma_log2_weight_denom');
    for (let l = 0; l < (h.type === 'B' ? 2 : 1); l++) {
      const n = l ? h.num_ref_idx_l1_active : h.num_ref_idx_l0_active;
      for (let i = 0; i < n; i++) {
        const e = {};
        if (s.f(`luma_weight_l${l}_flag[${i}]`)) { e.lw = s.se(`luma_weight_l${l}[${i}]`); e.lo = s.se(`luma_offset_l${l}[${i}]`); }
        if (sps.ChromaArrayType && s.f(`chroma_weight_l${l}_flag[${i}]`)) {
          for (let j = 0; j < 2; j++) { s.se(`chroma_weight_l${l}[${i}][${j}]`); s.se(`chroma_offset_l${l}[${i}][${j}]`); }
        }
        t.l[l].push(e);
      }
    }
  });
  return t;
}

// ---------------------------------------------------------------------------
// Helpers for MP4 (length-prefixed) access units

// Split a length-prefixed sample into NAL byte ranges.
export function splitLengthPrefixed(bytes, lengthSize) {
  const out = [];
  let p = 0;
  while (p + lengthSize <= bytes.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + bytes[p + i];
    p += lengthSize;
    if (len === 0) continue;
    out.push({ off: p, len: Math.min(len, bytes.length - p), truncated: p + len > bytes.length, prefixOff: p - lengthSize });
    p += len;
  }
  return out;
}

// Split an Annex B byte stream (00 00 01 start codes).
export function splitAnnexB(bytes) {
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((st, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : bytes.length;
    while (end > st && bytes[end - 1] === 0) end--;
    return { off: st, len: end - st, prefixOff: st - 3 };
  });
}

export function codecString(sps) {
  const h = v => v.toString(16).padStart(2, '0');
  const cs = (sps.cs0 << 7) | (sps.cs1 << 6) | (sps.cs2 << 5) | (sps.cs3 << 4) | (sps.cs4 << 3) | (sps.cs5 << 2);
  return `avc1.${h(sps.profile_idc)}${h(cs)}${h(sps.level_idc)}`;
}

export { hexFmt };
