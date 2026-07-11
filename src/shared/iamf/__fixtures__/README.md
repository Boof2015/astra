# IAMF test fixtures

Conformance vectors from the AOM libiamf repository
(https://github.com/AOMediaCodec/libiamf, `tests/` directory, tag v1.1.0),
licensed under BSD-3-Clause-Clear (see `third_party/libiamf/LICENSE` and the
IAMF decoder section of `THIRD_PARTY_LICENSES.md`).

- `test_000020.iamf` — standalone IA sequence, stereo Opus substream, 0.5 s.
- `test_000020_s.mp4` — the same sequence in a standalone (non-fragmented) MP4.
- `test_000020_f.mp4` — the same sequence in a fragmented MP4 (moof/mdat).
- `test_000020_rendered_id_42_sub_mix_0_layout_0.wav` — libiamf's reference
  render of the stereo mix presentation (16-bit 48 kHz stereo), used to check
  frame counts and channel content in `iamfWasmDriver.test.ts`.

A larger 7.1.4 vector (`test_000050.iamf` + its `layout_3` reference render)
is deliberately NOT committed (26 MB); `iamfWasmDriver.test.ts` runs a deep
per-channel compare against it only when `IAMF_VECTORS_DIR` points at a local
checkout of the libiamf `tests/` directory.
