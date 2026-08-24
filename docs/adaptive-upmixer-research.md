# Adaptive stereo-to-multichannel upmixer research

Adaptive is a synthetic multichannel scene remixer. It does not claim to
recover an original surround master. The physical quad bake-off selected the
adaptive dominant-direction matrix over the other classical candidates. A
second blind A/C level sweep selected the -6 dB rear/front render decisively.
The former live algorithm remains available as `rejected-adaptive-control` so
the research result stays reproducible.

## Selected Adaptive extractor

At sample rate \(f_s\), the transform length is the power of two nearest to
\(0.043 f_s\). Analysis and synthesis use a periodic square-root Hann window
with hop \(N/4\). Since the four overlapping window products sum to two, the
synthesis normalization is \(1/2\). This gives perfect reconstruction before
rendering.

For every frequency bin, exponentially averaged stereo covariance is

\[
R = \begin{bmatrix} P_L & C_{LR} \\ C_{LR}^* & P_R \end{bmatrix},\qquad
P_L=E\{|L|^2\},\quad P_R=E\{|R|^2\},\quad C_{LR}=E\{LR^*\}.
\]

The normalized dominant-eigenvalue separation used as directness is

\[
d = \frac{\sqrt{(P_L-P_R)^2+4|C_{LR}|^2}}{P_L+P_R+\epsilon}.
\]

For extraction, only the non-negative real cross-covariance
\(c=\max(0,\Re\{C_{LR}\})\) participates in the real principal direction
\(w=[w_L,w_R]^T\). The implementation uses a cancellation-safe eigenvector
ratio instead of subtracting nearly equal eigenvalues; this keeps native and
WASM results numerically comparable. The orthogonal deviation and ambient
residual are

\[
q=w_RL-w_LR,\qquad
A=[w_Rq,-w_Lq]^T=(I-ww^T)X.
\]

Dual mono and either hard pan therefore null from the surround extraction.
Primary is the exact complement, \(P=X-A\), so the decomposition reconstructs
the stereo input below -100 dBFS. No direct component is relocated to a rear
speaker.

Positive cross-power phase, stable near-center pan, dominant-eigenvalue
separation, and low spectral flux continuously control 5.x/7.x center
confidence. There is no hard steer threshold. For confidence \(c_f\), center
is \(C=c_f(P_L+P_R)/\sqrt{2}\), and the matching \(C/\sqrt{2}\) contribution is
removed from FL and FR. A conventional -3 dB center fold-down therefore
reconstructs the front image instead of triplicating centered content.

## Selected Adaptive rendering

- Quad keeps FL/FR sample-identical to latency-aligned stereo input and adds
  extracted ambience to SL/SR.
- 5.x uses the same surrounds and the continuously extracted FC stage above.
- 7.x power-normalizes the selected surround component across independently
  decorrelated side and back pairs.
- LFE, height, and unknown roles are always silent.

The selected fixed surround gain is 1.951126 (+5.805707 dB). That is the exact
gain the winning extractor required to reach the chosen -6 dB rear/front level
on the reference track. It is deliberately not a moving level servo: changing
gain from moment to moment would pump and would no longer reproduce the blind
audition. The reference production render measures -5.98 dB rear/front after
the numerically stable eigenvector update.

The surround renderer tapers sub-bass from 40-80 Hz, applies a fourth-order
Butterworth-shaped 7 kHz low-pass magnitude, then uses independent fixed
unit-magnitude phase decorrelation and 12/16 ms left/right offsets. It does not
modulate over time or synthesize a reverberation tail.

## Research-reset candidates

All four candidates keep quad FL/FR equal to the latency-aligned stereo input.
They never steer direct time-frequency fragments into the surrounds. Their
decompositions are complementary, \(P=X-A\), so the primary and ambient stems
reconstruct the input.

- `fixed-difference` is the center-null baseline. With
  \(q=(L-R)/\sqrt{2}\), it uses
  \(A_L=q/\sqrt{2}\) and \(A_R=-q/\sqrt{2}\).
- `dominant-matrix` finds the slowly smoothed, non-negative real principal
  direction \(w=[w_L,w_R]^T\), forms
  \(q=w_RL-w_LR\), and uses the orthogonal residual
  \(A=[w_Rq,-w_Lq]^T=(I-ww^T)X\). Dual mono and either hard pan therefore
  null from the surround extraction.
- `weighted-pca` follows Ibrahim/Allam. For covariance eigenvalues
  \(\lambda_1\geq\lambda_2\),
  \(\omega=1-\lambda_2/\lambda_1\). When \(\omega>0.7\), primary is the
  \(\omega\)-weighted projection onto the complex dominant eigenvector;
  otherwise the bin is classified entirely ambient.
- `geometric-decomposition` follows Paulus/Torcoli equations 23-24. With the
  non-negative real cross-covariance \(c\),
  \(k=\sqrt{(P_L-P_R)^2+4c^2}\),
  \(\lambda_{max}=(P_L+P_R+k)/2\), and
  \[
  A=\lambda_{max}^{-1}
  \begin{bmatrix}P_R&-c\\-c&P_L\end{bmatrix}X.
  \]
- `rejected-adaptive-control` preserves the failed Kraft-style residual and
  scene-expansion render used as the hidden control in the first bake-off.
  `adaptive` now means the selected production profile.
  `coherence-mask` and `panning-model` remain diagnostic legacy baselines and
  are not included in the blind bake-off.

The four reset candidates share a renderer: a smooth sub-bass taper from
40-80 Hz, a fourth-order Butterworth-shaped 7 kHz low-pass magnitude, fixed
unit-magnitude phase decorrelation, and 12/16 ms left/right rear offsets. Quad
fronts contain the original complete stereo channels; FC remains silent during
the quad research gate. Offline rear gain is adjusted once for the whole item,
capped at +12 dB to avoid amplifying mono residual noise.

These are independent formula-level implementations informed by
[Irwan/Aarts](https://research.tue.nl/en/publications/two-to-five-channel-sound-processing/),
[Ibrahim/Allam](https://karimibrahim.com/files/2016-09-01-PAE_PCA.pdf), and
[Paulus/Torcoli](https://arxiv.org/abs/2206.02125). No proprietary decoder code,
bitstream signaling, branding, or undocumented behavior is used.

Primary references:

- V. Pulkki-style cue interpretation and diffuseness context in
  [Faller/Merimaa](https://infoscience.epfl.ch/server/api/core/bitstreams/e236b450-62cd-4fb5-b70b-943f34428d1c/content).
- Frequency-domain primary/ambient decomposition in
  [Avendano/Jot](https://aes.org/publications/journal-online/?num=7_8&vol=52).
- Signal-adaptive stereo upmix decomposition in
  [Kraft/Zölzer](https://openhsu.ub.hsu-hh.de/bitstream/10.24405/14379/1/openHSU_14379.pdf).
- Center extraction and remixing review context in
  [Paulus/Torcoli](https://arxiv.org/abs/2206.02125).

## Offline usage

Single candidate or selected level:

```sh
npm run research:upmix -- music.flac --layout quad \
  --algorithm dominant-matrix --rear-target-db -9 --segment 1:10-1:40
```

Blinded full-track bake-off:

```sh
npm run research:upmix -- music.flac --layout quad \
  --rear-target-db -9 --blind-pack --output-dir /private/tmp/astra-upmix-audition
```

Blinded A/C finalist sweep at -12, -9, and -6 dB rear/front:

```sh
npm run research:upmix -- music.flac --layout quad \
  --blind-level-sweep --output-dir /private/tmp/astra-upmix-level-sweep
```

Blinded center-detail sweep around the selected production profile:

```sh
npm run research:upmix -- music.flac --layout quad \
  --blind-center-sweep --output-dir /private/tmp/astra-upmix-center-sweep
```

The output folder contains `rendered.wav`, `primary.wav`, `ambient.wav`,
`rear-only.wav`, `fold-down.wav`, and `diagnostics.json`. A blind pack contains
randomized A-E quad/rear pairs, blind diagnostics, `score-sheet.md`, and a
separate `answer-key.json`. Diagnostics include reconstruction and front-null
error, rear/front ratio, extracted common-mode leakage, 250 Hz-4 kHz coherence,
rear correlation, integrated LUFS, and true peak. FFmpeg decodes the first
audio stream, so any locally supported FFmpeg input format can be used.
The finalist sweep randomizes the dominant-matrix and geometric-decomposition
extractors across all three target levels, and stores the extractor, prior
bake-off label, target level, and diagnostics only in its answer key.
The center-detail sweep randomizes pure production Adaptive with -24, -21, and
-18 dB common-mode injection. The approved dominant-matrix bed is unchanged;
the additional `(L+R)/2` layer is filtered approximately 300 Hz-7 kHz and
independently decorrelated for each surround. This option is research-only and
the live WASM configuration remains at zero injection until listening approval.
