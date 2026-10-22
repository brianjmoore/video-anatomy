// H.265 / HEVC bitstream syntax: NAL header, VPS, SPS, PPS, slice segment header.
import { Bits, Syn, unescapeRbsp } from './bits.js';
import { COLOUR_PRIMARIES, TRANSFER, MATRIX } from './h264.js';

export const NAL_TYPES = {
  0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R', 6: 'RADL_N', 7: 'RADL_R',
  8: 'RASL_N', 9: 'RASL_R', 16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP', 19: 'IDR_W_RADL', 20: 'IDR_N_LP',
  21: 'CRA_NUT', 32: 'VPS_NUT', 33: 'SPS_NUT', 34: 'PPS_NUT', 35: 'AUD_NUT', 36: 'EOS_NUT', 37: 'EOB_NUT',
  38: 'FD_NUT', 39: 'PREFIX_SEI', 40: 'SUFFIX_SEI',
};
const NAL_DESC = {
  0: 'trailing picture, not used for reference', 1: 'trailing picture, used for reference',
  2: 'temporal sub-layer switch, non-ref', 3: 'temporal sub-layer switch', 4: 'step-wise temporal switch, non-ref', 5: 'step-wise temporal switch',
  6: 'random-access decodable leading, non-ref', 7: 'random-access decodable leading', 8: 'random-access skipped leading, non-ref', 9: 'random-access skipped leading',
  16: 'broken link access', 17: 'broken link access', 18: 'broken link access', 19: 'instantaneous decoder refresh', 20: 'instantaneous decoder refresh',
  21: 'clean random access', 32: 'video parameter set', 33: 'sequence parameter set', 34: 'picture parameter set', 35: 'access unit delimiter',
  39: 'supplemental info (prefix)', 40: 'supplemental info (suffix)',
};
export const nalName = t => NAL_TYPES[t] || (t < 32 ? `RSV_VCL_${t}` : `type ${t}`);
export const NAL_SHORT = t => (NAL_TYPES[t] || `#${t}`).replace('_NUT', '');
export const SLICE_TYPES = ['B', 'P', 'I'];
const PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions', 5: 'High Throughput', 9: 'Screen Content' };
const enumFmt = (m) => v => (m[v] !== undefined ? `${v} (${m[v]})` : `${v}`);
export const profileName = p => PROFILES[p] || `profile ${p}`;

export function parseNal(bytes, fileOffset, state) {
  const { rbsp, map, removed } = unescapeRbsp(bytes, fileOffset);
  const r = new Bits(rbsp, fileOffset, map);
  const s = new Syn(r);
  const type = (bytes[0] >> 1) & 63;
  const out = { fields: s.root, bits: r, type, tid: (bytes[1] & 7) - 1, size: bytes.length, epb: removed, fileOffset };
  try {
    s.group('nal_unit_header', () => {
      s.f('forbidden_zero_bit');
      s.u('nal_unit_type', 6, v => `${v} (${nalName(v)}${NAL_DESC[v] ? ': ' + NAL_DESC[v] : ''})`);
      s.u('nuh_layer_id', 6);
      s.u('nuh_temporal_id_plus1', 3, v => `${v} (temporal layer ${v - 1})`);
    });
    if (type === 32) { out.vps = parseVps(s); }
    else if (type === 33) { out.sps = parseSps(s); state.sps[out.sps.id] = out.sps; }
    else if (type === 34) { out.pps = parsePps(s); state.pps[out.pps.id] = out.pps; }
    else if (type === 35) s.u('pic_type', 3, v => `${v} (${['I', 'P,I', 'B,P,I'][v] || '?'})`);
    else if (type === 39 || type === 40) parseSei(s);
    else if (type < 32) {
      out.slice = parseSliceHeader(s, out, state);
      s.calc('slice_segment_data()', `${((r.end - r.pos) / 8).toFixed(0)} bytes of CABAC-coded coding tree units`);
    }
  } catch (e) { s.error(e); out.error = e.message; }
  return out;
}

function ptl(s, maxSub) {
  const p = {};
  s.group('profile_tier_level', () => {
    p.profile_space = s.u('general_profile_space', 2);
    p.tier = s.f('general_tier_flag', v => v ? '1 (High tier)' : '0 (Main tier)');
    p.profile_idc = s.u('general_profile_idc', 5, v => `${v} (${profileName(v)})`);
    p.compat = s.u('general_profile_compatibility_flags', 32, v => '0x' + v.toString(16).padStart(8, '0'));
    p.constraint = [];
    const cs = s.r.pos;
    s.f('general_progressive_source_flag'); s.f('general_interlaced_source_flag');
    s.f('general_non_packed_constraint_flag'); s.f('general_frame_only_constraint_flag');
    s.r.u(32); s.r.u(11);
    s.calc('general_reserved/constraint bits', '43 bits');
    s.f('general_inbld_flag');
    // keep 6 constraint bytes for the codec string
    const save = s.r.pos; s.r.pos = cs; for (let i = 0; i < 6; i++) p.constraint.push(s.r.u(8)); s.r.pos = save;
    p.level_idc = s.u('general_level_idc', 8, v => `${v} (Level ${v / 30})`);
    const prof = [], lev = [];
    for (let i = 0; i < maxSub; i++) { prof.push(s.f(`sub_layer_profile_present_flag[${i}]`)); lev.push(s.f(`sub_layer_level_present_flag[${i}]`)); }
    if (maxSub > 0) for (let i = maxSub; i < 8; i++) s.u('reserved_zero_2bits', 2);
    for (let i = 0; i < maxSub; i++) {
      if (prof[i]) { s.r.u(32); s.r.u(32); s.r.u(24); s.calc(`sub_layer ${i} profile`, '88 bits'); }
      if (lev[i]) s.u(`sub_layer_level_idc[${i}]`, 8);
    }
  });
  return p;
}

function parseVps(s) {
  const v = {};
  s.group('video_parameter_set_rbsp', () => {
    v.id = s.u('vps_video_parameter_set_id', 4);
    s.f('vps_base_layer_internal_flag'); s.f('vps_base_layer_available_flag');
    s.u('vps_max_layers_minus1', 6);
    const maxSub = s.u('vps_max_sub_layers_minus1', 3);
    s.f('vps_temporal_id_nesting_flag'); s.u('vps_reserved_0xffff_16bits', 16, v => '0x' + v.toString(16));
    v.ptl = ptl(s, maxSub);
    const info = s.f('vps_sub_layer_ordering_info_present_flag');
    for (let i = info ? 0 : maxSub; i <= maxSub; i++) {
      s.ue(`vps_max_dec_pic_buffering_minus1[${i}]`); s.ue(`vps_max_num_reorder_pics[${i}]`); s.ue(`vps_max_latency_increase_plus1[${i}]`);
    }
    const maxLayerId = s.u('vps_max_layer_id', 6);
    const nls = s.ue('vps_num_layer_sets_minus1');
    for (let i = 1; i <= nls; i++) for (let j = 0; j <= maxLayerId; j++) s.r.bit();
    if (s.f('vps_timing_info_present_flag')) {
      const n = s.u('vps_num_units_in_tick', 32), t = s.u('vps_time_scale', 32);
      s.calc('→ frame rate', `${(t / n).toFixed(3)} fps`);
    }
    s.calc('(remaining fields)', 'not decoded');
  });
  return v;
}

function scalingListData(s) {
  s.group('scaling_list_data', () => {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let m = 0; m < 6; m += sizeId === 3 ? 3 : 1) {
        if (!s.r.bit()) { s.r.ue(); continue; }
        const n = Math.min(64, 1 << (4 + (sizeId << 1)));
        if (sizeId > 1) s.r.se();
        for (let i = 0; i < n; i++) s.r.se();
      }
    }
  });
}

// st_ref_pic_set(): returns {s0:[deltaPoc], u0:[used], s1, u1}
function stRps(s, idx, num, sets) {
  return s.group(`st_ref_pic_set(${idx})`, () => {
    let inter = 0;
    if (idx !== 0) inter = s.f('inter_ref_pic_set_prediction_flag', v => v ? '1 (predicted from an earlier set)' : '0');
    const rps = { s0: [], u0: [], s1: [], u1: [] };
    if (inter) {
      let deltaIdx = 1;
      if (idx === num) deltaIdx = s.ue('delta_idx_minus1') + 1;
      const sign = s.f('delta_rps_sign');
      const abs = s.ue('abs_delta_rps_minus1') + 1;
      const deltaRps = (1 - 2 * sign) * abs;
      const R = sets[idx - deltaIdx];
      const nR = R.s0.length + R.s1.length;
      const used = [], useDelta = [];
      for (let j = 0; j <= nR; j++) {
        used[j] = s.r.bit();
        useDelta[j] = used[j] ? 1 : s.r.bit();
      }
      s.calc('used_by_curr_pic_flag / use_delta_flag', used.map((u, j) => `${u}${useDelta[j]}`).join(' '));
      for (let j = R.s1.length - 1; j >= 0; j--) {
        const d = R.s1[j] + deltaRps;
        if (d < 0 && useDelta[R.s0.length + j]) { rps.s0.push(d); rps.u0.push(used[R.s0.length + j]); }
      }
      if (deltaRps < 0 && useDelta[nR]) { rps.s0.push(deltaRps); rps.u0.push(used[nR]); }
      for (let j = 0; j < R.s0.length; j++) {
        const d = R.s0[j] + deltaRps;
        if (d < 0 && useDelta[j]) { rps.s0.push(d); rps.u0.push(used[j]); }
      }
      for (let j = R.s0.length - 1; j >= 0; j--) {
        const d = R.s0[j] + deltaRps;
        if (d > 0 && useDelta[j]) { rps.s1.push(d); rps.u1.push(used[j]); }
      }
      if (deltaRps > 0 && useDelta[nR]) { rps.s1.push(deltaRps); rps.u1.push(used[nR]); }
      for (let j = 0; j < R.s1.length; j++) {
        const d = R.s1[j] + deltaRps;
        if (d > 0 && useDelta[R.s0.length + j]) { rps.s1.push(d); rps.u1.push(used[R.s0.length + j]); }
      }
    } else {
      const nn = s.ue('num_negative_pics'), np = s.ue('num_positive_pics');
      let poc = 0;
      for (let i = 0; i < nn; i++) { poc -= s.ue(`delta_poc_s0_minus1[${i}]`) + 1; rps.s0.push(poc); rps.u0.push(s.f(`used_by_curr_pic_s0_flag[${i}]`)); }
      poc = 0;
      for (let i = 0; i < np; i++) { poc += s.ue(`delta_poc_s1_minus1[${i}]`) + 1; rps.s1.push(poc); rps.u1.push(s.f(`used_by_curr_pic_s1_flag[${i}]`)); }
    }
    const fmt = (d, u) => d.map((x, i) => (x > 0 ? '+' : '') + x + (u[i] ? '' : '*')).join(', ') || '—';
    s.calc('→ earlier pictures (POC delta)', fmt(rps.s0, rps.u0), null, '* = kept in memory but not used by this picture');
    s.calc('→ later pictures (POC delta)', fmt(rps.s1, rps.u1));
    return rps;
  });
}

function parseSps(s) {
  const p = {};
  s.group('seq_parameter_set_rbsp', () => {
    s.u('sps_video_parameter_set_id', 4);
    const maxSub = s.u('sps_max_sub_layers_minus1', 3);
    s.f('sps_temporal_id_nesting_flag');
    p.ptl = ptl(s, maxSub);
    p.id = s.ue('sps_seq_parameter_set_id');
    p.chroma_format_idc = s.ue('chroma_format_idc', enumFmt({ 0: '4:0:0', 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' }));
    p.separate_colour_plane_flag = 0;
    if (p.chroma_format_idc === 3) p.separate_colour_plane_flag = s.f('separate_colour_plane_flag');
    p.ChromaArrayType = p.separate_colour_plane_flag ? 0 : p.chroma_format_idc;
    p.codedWidth = s.ue('pic_width_in_luma_samples');
    p.codedHeight = s.ue('pic_height_in_luma_samples');
    p.width = p.codedWidth; p.height = p.codedHeight;
    if (s.f('conformance_window_flag')) {
      const sw = p.chroma_format_idc === 1 || p.chroma_format_idc === 2 ? 2 : 1, sh = p.chroma_format_idc === 1 ? 2 : 1;
      const l = s.ue('conf_win_left_offset'), r = s.ue('conf_win_right_offset'), t = s.ue('conf_win_top_offset'), b = s.ue('conf_win_bottom_offset');
      p.width -= sw * (l + r); p.height -= sh * (t + b);
      p.crop = { left: sw * l, top: sh * t };
    }
    s.calc('→ display size', `${p.width}×${p.height}`);
    p.bit_depth_luma = 8 + s.ue('bit_depth_luma_minus8');
    p.bit_depth_chroma = 8 + s.ue('bit_depth_chroma_minus8');
    p.log2_max_poc_lsb = 4 + s.ue('log2_max_pic_order_cnt_lsb_minus4');
    const info = s.f('sps_sub_layer_ordering_info_present_flag');
    for (let i = info ? 0 : maxSub; i <= maxSub; i++) {
      p.max_dec_pic_buffering = s.ue(`sps_max_dec_pic_buffering_minus1[${i}]`) + 1;
      p.max_num_reorder = s.ue(`sps_max_num_reorder_pics[${i}]`);
      s.ue(`sps_max_latency_increase_plus1[${i}]`);
    }
    p.log2_min_cb = 3 + s.ue('log2_min_luma_coding_block_size_minus3');
    p.log2_ctb = p.log2_min_cb + s.ue('log2_diff_max_min_luma_coding_block_size');
    s.calc('→ CTU size', `${1 << p.log2_ctb}×${1 << p.log2_ctb}`, null, 'Coding Tree Units are HEVC’s replacement for macroblocks; each is split recursively into coding units');
    s.calc('→ smallest CU', `${1 << p.log2_min_cb}×${1 << p.log2_min_cb}`);
    p.log2_min_tb = 2 + s.ue('log2_min_luma_transform_block_size_minus2');
    p.log2_max_tb = p.log2_min_tb + s.ue('log2_diff_max_min_luma_transform_block_size');
    s.ue('max_transform_hierarchy_depth_inter'); s.ue('max_transform_hierarchy_depth_intra');
    if (s.f('scaling_list_enabled_flag')) { if (s.f('sps_scaling_list_data_present_flag')) scalingListData(s); }
    p.amp = s.f('amp_enabled_flag', v => v ? '1 (asymmetric motion partitions allowed)' : '0');
    p.sao = s.f('sample_adaptive_offset_enabled_flag');
    if (s.f('pcm_enabled_flag')) {
      s.u('pcm_sample_bit_depth_luma_minus1', 4); s.u('pcm_sample_bit_depth_chroma_minus1', 4);
      s.ue('log2_min_pcm_luma_coding_block_size_minus3'); s.ue('log2_diff_max_min_pcm_luma_coding_block_size');
      s.f('pcm_loop_filter_disabled_flag');
    }
    const n = s.ue('num_short_term_ref_pic_sets');
    p.rps = [];
    for (let i = 0; i < n; i++) p.rps.push(stRps(s, i, n, p.rps));
    p.long_term_refs_present = s.f('long_term_ref_pics_present_flag');
    p.lt_sps = [];
    if (p.long_term_refs_present) {
      const k = s.ue('num_long_term_ref_pics_sps');
      for (let i = 0; i < k; i++) p.lt_sps.push({ lsb: s.u(`lt_ref_pic_poc_lsb_sps[${i}]`, p.log2_max_poc_lsb), used: s.f(`used_by_curr_pic_lt_sps_flag[${i}]`) });
    }
    p.temporal_mvp = s.f('sps_temporal_mvp_enabled_flag');
    s.f('strong_intra_smoothing_enabled_flag');
    if (s.f('vui_parameters_present_flag')) {
      s.group('vui_parameters', () => {
        if (s.f('aspect_ratio_info_present_flag')) { if (s.u('aspect_ratio_idc', 8) === 255) { s.u('sar_width', 16); s.u('sar_height', 16); } }
        if (s.f('overscan_info_present_flag')) s.f('overscan_appropriate_flag');
        if (s.f('video_signal_type_present_flag')) {
          s.u('video_format', 3); s.f('video_full_range_flag');
          if (s.f('colour_description_present_flag')) {
            s.u('colour_primaries', 8, enumFmt(COLOUR_PRIMARIES)); s.u('transfer_characteristics', 8, enumFmt(TRANSFER)); s.u('matrix_coeffs', 8, enumFmt(MATRIX));
          }
        }
        if (s.f('chroma_loc_info_present_flag')) { s.ue('chroma_sample_loc_type_top_field'); s.ue('chroma_sample_loc_type_bottom_field'); }
        s.f('neutral_chroma_indication_flag'); s.f('field_seq_flag'); s.f('frame_field_info_present_flag');
        if (s.f('default_display_window_flag')) { s.ue('def_disp_win_left_offset'); s.ue('def_disp_win_right_offset'); s.ue('def_disp_win_top_offset'); s.ue('def_disp_win_bottom_offset'); }
        if (s.f('vui_timing_info_present_flag')) {
          const n = s.u('vui_num_units_in_tick', 32), t = s.u('vui_time_scale', 32);
          s.calc('→ frame rate', `${(t / n).toFixed(3)} fps`);
        }
        s.calc('(remaining VUI fields)', 'not decoded');
      });
    }
  });
  return p;
}

function parsePps(s) {
  const p = {};
  s.group('pic_parameter_set_rbsp', () => {
    p.id = s.ue('pps_pic_parameter_set_id');
    p.sps_id = s.ue('pps_seq_parameter_set_id');
    p.dependent_slice_segments_enabled_flag = s.f('dependent_slice_segments_enabled_flag');
    p.output_flag_present_flag = s.f('output_flag_present_flag');
    p.num_extra_slice_header_bits = s.u('num_extra_slice_header_bits', 3);
    s.f('sign_data_hiding_enabled_flag');
    p.cabac_init_present_flag = s.f('cabac_init_present_flag');
    p.num_ref_idx_l0_default = s.ue('num_ref_idx_l0_default_active_minus1') + 1;
    p.num_ref_idx_l1_default = s.ue('num_ref_idx_l1_default_active_minus1') + 1;
    p.init_qp = 26 + s.se('init_qp_minus26');
    s.f('constrained_intra_pred_flag'); s.f('transform_skip_enabled_flag');
    if (s.f('cu_qp_delta_enabled_flag')) s.ue('diff_cu_qp_delta_depth');
    s.se('pps_cb_qp_offset'); s.se('pps_cr_qp_offset');
    p.slice_chroma_qp_offsets_present_flag = s.f('pps_slice_chroma_qp_offsets_present_flag');
    p.weighted_pred_flag = s.f('weighted_pred_flag');
    p.weighted_bipred_flag = s.f('weighted_bipred_flag');
    s.f('transquant_bypass_enabled_flag');
    p.tiles_enabled_flag = s.f('tiles_enabled_flag');
    p.entropy_coding_sync_enabled_flag = s.f('entropy_coding_sync_enabled_flag', v => v ? '1 (wavefront parallel processing)' : '0');
    if (p.tiles_enabled_flag) {
      const c = s.ue('num_tile_columns_minus1'), r = s.ue('num_tile_rows_minus1');
      if (!s.f('uniform_spacing_flag')) { for (let i = 0; i < c; i++) s.ue(`column_width_minus1[${i}]`); for (let i = 0; i < r; i++) s.ue(`row_height_minus1[${i}]`); }
      s.f('loop_filter_across_tiles_enabled_flag');
    }
    p.loop_filter_across_slices = s.f('pps_loop_filter_across_slices_enabled_flag');
    p.deblocking_override_enabled = 0; p.deblocking_disabled = 0;
    if (s.f('deblocking_filter_control_present_flag')) {
      p.deblocking_override_enabled = s.f('deblocking_filter_override_enabled_flag');
      p.deblocking_disabled = s.f('pps_deblocking_filter_disabled_flag');
      if (!p.deblocking_disabled) { s.se('pps_beta_offset_div2'); s.se('pps_tc_offset_div2'); }
    }
    if (s.f('pps_scaling_list_data_present_flag')) scalingListData(s);
    p.lists_modification_present_flag = s.f('lists_modification_present_flag');
    s.ue('log2_parallel_merge_level_minus2');
    p.slice_header_extension_present = s.f('slice_segment_header_extension_present_flag');
    s.f('pps_extension_present_flag');
  });
  return p;
}

function parseSei(s) {
  let i = 0;
  while (s.r.moreRbsp() && i++ < 64) {
    let type = 0, size = 0, b;
    while ((b = s.r.u(8)) === 255) type += 255; type += b;
    while ((b = s.r.u(8)) === 255) size += 255; size += b;
    const name = { 0: 'buffering_period', 1: 'pic_timing', 4: 'user_data_registered', 5: 'user_data_unregistered', 6: 'recovery_point', 129: 'active_parameter_sets', 132: 'decoded_picture_hash', 137: 'mastering_display_colour_volume', 144: 'content_light_level_info', 147: 'alternative_transfer_characteristics' }[type];
    s.group(`sei_message: ${name || 'payload type ' + type}`, () => {
      const end = s.r.pos + size * 8;
      try {
        if (type === 5) { s.bytes('uuid_iso_iec_11578', 16); s.str('user_data_payload_byte', size - 16); }
        else if (type === 132) {
          const t = s.u('hash_type', 8, enumFmt({ 0: 'MD5', 1: 'CRC', 2: 'checksum' }));
          s.note('A hash of the decoded picture, so a decoder can verify it reconstructed every pixel exactly');
          s.bytes('picture_hash', size - 1);
          void t;
        } else if (size) s.bytes('payload', size);
      } catch (e) { s.error(e); }
      s.r.pos = Math.min(end, s.r.end);
    });
  }
}

export const isIrap = t => t >= 16 && t <= 23;
export const isIdr = t => t === 19 || t === 20;

function parseSliceHeader(s, nal, state) {
  const h = { nal_type: nal.type };
  return s.group('slice_segment_header', () => {
    h.first = s.f('first_slice_segment_in_pic_flag');
    if (isIrap(nal.type)) s.f('no_output_of_prior_pics_flag');
    h.pps_id = s.ue('slice_pic_parameter_set_id');
    const pps = state.pps[h.pps_id];
    if (!pps) { s.calc('error', `PPS ${h.pps_id} not found`); return null; }
    const sps = state.sps[pps.sps_id];
    if (!sps) { s.calc('error', `SPS ${pps.sps_id} not found`); return null; }
    h.pps = pps; h.sps = sps;
    h.dependent = 0;
    if (!h.first) {
      if (pps.dependent_slice_segments_enabled_flag) h.dependent = s.f('dependent_slice_segment_flag');
      const ctb = 1 << sps.log2_ctb;
      const n = Math.ceil(sps.codedWidth / ctb) * Math.ceil(sps.codedHeight / ctb);
      h.address = s.u('slice_segment_address', Math.ceil(Math.log2(n)));
    }
    if (h.dependent) { s.calc('(dependent slice)', 'header fields copied from previous slice segment'); return h; }
    for (let i = 0; i < pps.num_extra_slice_header_bits; i++) s.f(`slice_reserved_flag[${i}]`);
    h.slice_type = s.ue('slice_type', v => `${v} (${SLICE_TYPES[v]})`);
    h.type = SLICE_TYPES[h.slice_type];
    if (pps.output_flag_present_flag) s.f('pic_output_flag');
    if (sps.separate_colour_plane_flag) s.u('colour_plane_id', 2);
    h.rps = { s0: [], u0: [], s1: [], u1: [] }; h.lt = [];
    h.poc_lsb = 0;
    h.temporal_mvp = 0;
    if (!isIdr(nal.type)) {
      h.poc_lsb = s.u('slice_pic_order_cnt_lsb', sps.log2_max_poc_lsb);
      s.note('Low bits of the Picture Order Count, which sets display order');
      const fromSps = s.f('short_term_ref_pic_set_sps_flag', v => v ? '1 (use a set from the SPS)' : '0 (set is coded right here)');
      if (!fromSps) h.rps = stRps(s, sps.rps.length, sps.rps.length, sps.rps);
      else {
        let idx = 0;
        if (sps.rps.length > 1) idx = s.u('short_term_ref_pic_set_idx', Math.ceil(Math.log2(sps.rps.length)));
        h.rps = sps.rps[idx];
        const fmt = (d, u) => d.map((x, i) => (x > 0 ? '+' : '') + x + (u[i] ? '' : '*')).join(', ') || '—';
        s.calc('→ reference set', `before: ${fmt(h.rps.s0, h.rps.u0)}; after: ${fmt(h.rps.s1, h.rps.u1)}`);
      }
      if (sps.long_term_refs_present) {
        let nsps = 0;
        if (sps.lt_sps.length) nsps = s.ue('num_long_term_sps');
        const npics = s.ue('num_long_term_pics');
        for (let i = 0; i < nsps + npics; i++) {
          const e = {};
          if (i < nsps) {
            let idx = 0;
            if (sps.lt_sps.length > 1) idx = s.u(`lt_idx_sps[${i}]`, Math.ceil(Math.log2(sps.lt_sps.length)));
            e.lsb = sps.lt_sps[idx].lsb; e.used = sps.lt_sps[idx].used;
          } else { e.lsb = s.u(`poc_lsb_lt[${i}]`, sps.log2_max_poc_lsb); e.used = s.f(`used_by_curr_pic_lt_flag[${i}]`); }
          if (s.f(`delta_poc_msb_present_flag[${i}]`)) e.msb = s.ue(`delta_poc_msb_cycle_lt[${i}]`);
          h.lt.push(e);
        }
      }
      if (sps.temporal_mvp) h.temporal_mvp = s.f('slice_temporal_mvp_enabled_flag');
    }
    if (sps.sao) { s.f('slice_sao_luma_flag'); if (sps.ChromaArrayType) s.f('slice_sao_chroma_flag'); }
    h.numPicTotalCurr = h.rps.u0.filter(Boolean).length + h.rps.u1.filter(Boolean).length + h.lt.filter(e => e.used).length;
    h.num_ref_idx_l0_active = 0; h.num_ref_idx_l1_active = 0; h.list_entry = [null, null];
    if (h.type !== 'I') {
      h.num_ref_idx_l0_active = pps.num_ref_idx_l0_default;
      h.num_ref_idx_l1_active = h.type === 'B' ? pps.num_ref_idx_l1_default : 0;
      if (s.f('num_ref_idx_active_override_flag')) {
        h.num_ref_idx_l0_active = s.ue('num_ref_idx_l0_active_minus1') + 1;
        if (h.type === 'B') h.num_ref_idx_l1_active = s.ue('num_ref_idx_l1_active_minus1') + 1;
      }
      if (pps.lists_modification_present_flag && h.numPicTotalCurr > 1) {
        const bits = Math.ceil(Math.log2(h.numPicTotalCurr));
        s.group('ref_pic_lists_modification', () => {
          if (s.f('ref_pic_list_modification_flag_l0')) { h.list_entry[0] = []; for (let i = 0; i < h.num_ref_idx_l0_active; i++) h.list_entry[0].push(s.u(`list_entry_l0[${i}]`, bits)); }
          if (h.type === 'B' && s.f('ref_pic_list_modification_flag_l1')) { h.list_entry[1] = []; for (let i = 0; i < h.num_ref_idx_l1_active; i++) h.list_entry[1].push(s.u(`list_entry_l1[${i}]`, bits)); }
        });
      }
      if (h.type === 'B') s.f('mvd_l1_zero_flag');
      if (pps.cabac_init_present_flag) s.f('cabac_init_flag');
      if (h.temporal_mvp) {
        let fromL0 = 1;
        if (h.type === 'B') fromL0 = s.f('collocated_from_l0_flag');
        if ((fromL0 && h.num_ref_idx_l0_active > 1) || (!fromL0 && h.num_ref_idx_l1_active > 1)) s.ue('collocated_ref_idx');
      }
      if ((pps.weighted_pred_flag && h.type === 'P') || (pps.weighted_bipred_flag && h.type === 'B')) {
        s.group('pred_weight_table', () => {
          s.ue('luma_log2_weight_denom');
          if (sps.ChromaArrayType) s.se('delta_chroma_log2_weight_denom');
          for (let l = 0; l < (h.type === 'B' ? 2 : 1); l++) {
            const n = l ? h.num_ref_idx_l1_active : h.num_ref_idx_l0_active;
            const lf = [], cf = [];
            for (let i = 0; i < n; i++) lf.push(s.f(`luma_weight_l${l}_flag[${i}]`));
            if (sps.ChromaArrayType) for (let i = 0; i < n; i++) cf.push(s.f(`chroma_weight_l${l}_flag[${i}]`));
            for (let i = 0; i < n; i++) {
              if (lf[i]) { s.se(`delta_luma_weight_l${l}[${i}]`); s.se(`luma_offset_l${l}[${i}]`); }
              if (cf[i]) for (let j = 0; j < 2; j++) { s.se(`delta_chroma_weight_l${l}[${i}][${j}]`); s.se(`delta_chroma_offset_l${l}[${i}][${j}]`); }
            }
          }
        });
      }
      s.ue('five_minus_max_num_merge_cand', v => `${v} (up to ${5 - v} merge candidates)`);
    }
    h.slice_qp_delta = s.se('slice_qp_delta');
    h.qp = pps.init_qp + h.slice_qp_delta;
    s.note(`Slice QP = ${pps.init_qp} + ${h.slice_qp_delta} = ${h.qp}`);
    return h;
  });
}

export function codecString(sps) {
  const p = sps.ptl;
  let rev = 0; for (let i = 0; i < 32; i++) if ((p.compat >>> i) & 1) rev |= 1 << (31 - i);
  const cons = p.constraint.slice(); while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return `hvc1.${['', 'A', 'B', 'C'][p.profile_space]}${p.profile_idc}.${(rev >>> 0).toString(16).toUpperCase()}.${p.tier ? 'H' : 'L'}${p.level_idc}` +
    cons.map(c => '.' + c.toString(16).toUpperCase()).join('');
}
