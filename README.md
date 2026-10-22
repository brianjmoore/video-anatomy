# Video Anatomy

A mobile-friendly web app for looking inside video files: every MP4/MOV box
decoded field by field, how frames are stored, ordered and reference each other,
what each H.264 macroblock does, and how AAC audio frames are built. Each view
explains what you're looking at, and the Learn tab ties the concepts together.

Everything runs in the browser. Files are read locally and never uploaded.
Plain ES modules, no libraries, no build step.

## Run

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Open `http://localhost:8000/`, or `http://<your-computer's-IP>:8000/` on a phone
on the same Wi-Fi. Tap **Load demo file** or open your own video. `?demo` in the
URL loads the demo straight away.

## What's in it

**Structure.** The full box tree (moov, trak, stbl, moof/trun, metadata…) with a
plain-language description of each box. Every field is decoded with its type
and exact bit position; tapping one explains it and highlights its bytes in the
hex view. Exp-Golomb fields show the leading-zero breakdown. SPS/PPS/VPS inside
avcC/hvcC and the AudioSpecificConfig inside esds are decoded too.

**Video.**
- Summary: codec, profile/level, entropy coder, GOP length, frame type counts
  and the GOP pattern.
- Frame strip: decode order (as stored) above display order (as shown), with
  lines showing the reordering. Selecting a frame draws arcs to its reference
  pictures (list 0 / list 1) and to the frames that reference it.
- Frame inspector: the decoded picture (WebCodecs, decoding from the previous
  keyframe), DTS/PTS/POC/QP, the reference lists and decoder memory, a
  step-by-step "how a player finds this frame" through stts → stsc → stco →
  stsz, and every NAL unit with its syntax and hex (emulation-prevention bytes
  are marked).
- Macroblocks (H.264): the slice data is entropy-decoded (CABAC and CAVLC) to
  get each macroblock's type, partitions, reference indices, motion vectors
  (including inferred skip/direct motion), QP, coded block pattern and bit
  cost. Overlays show block types, motion, bits and QP. Tapping a macroblock
  shows its syntax elements in bitstream order and its quantized coefficients.
- HEVC: VPS/SPS/PPS, slice headers, reference picture sets and the CTU grid
  (no CTU-level decoding).

**Audio (AAC).** AudioSpecificConfig, a per-frame strip coloured by MDCT window
type (long / short / transition), bandwidth from max_sfb, the window shape and
section codebooks for each frame, plus the decoded waveform, a per-frame
spectrum and playback.

**Learn.** Short illustrated explainers: containers, boxes, sample tables,
timestamps and edit lists, I/P/B frames, GOPs, references and POC, NAL units and
Exp-Golomb (with a live encoder), macroblocks, CAVLC/CABAC, HEVC and AAC. The
buttons in each section jump into the file you have open.

## Accuracy

`npm test` compares sample offsets, sizes, keyframes and frame types with
ffprobe. `node tests/mb.js` compares every macroblock's type, partition shape
and QP with `ffmpeg -debug mb_type+qp`. `node tests/mv.js` compares every motion
vector with FFmpeg's exported vectors (`tools/extract_mvs`, built from
FFmpeg's `doc/examples/extract_mvs.c`). All three need FFmpeg installed.

The 11 H.264 test files in `tests/media` cover CABAC, CAVLC, B-pyramids,
spatial and temporal direct, multiple slices, weighted prediction, 8×8
transforms, 10-bit, monochrome, fragmented MP4 and Apple's VideoToolbox
encoder. They match FFmpeg exactly on 235,100 macroblocks and 366,746 motion
vectors. The first 15 s of Big Buck Bunny also match (331,200 MBs).

`js/h264tables.js` (CABAC context tables, CAVLC codes) is generated from FFmpeg's
sources by `tools/gen_tables.py`. The values are the tables from the H.264 spec.

## Limitations

- Containers: MP4 family only (MP4, MOV, M4V, M4A, 3GP, fragmented MP4). MKV,
  WebM, MPEG-TS, MP3 and WAV are detected but not parsed.
- Macroblock decoding: H.264 progressive 4:2:0 / 4:0:0 only (no interlaced
  field/MBAFF, 4:2:2 or 4:4:4). HEVC stops at slice headers.
- AAC syntax stops after the first channel's section data (scale factors and
  spectral data are Huffman-coded and not decoded).
- Long files: frame analysis covers the first 5,000 video frames and 20,000
  audio frames; audio decoding covers the first 10 minutes.
- The picture view needs WebCodecs support for the codec (Chrome, Edge,
  Safari 16.4+). Otherwise it falls back to seeking a `<video>` element.

Demo clip: Big Buck Bunny © Blender Foundation, CC BY 3.0.
