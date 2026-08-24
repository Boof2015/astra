# Adaptive upmixer listening gate

The physical quad gate selected dominant-matrix extraction and the -6 dB
rear/front profile. Live Adaptive now implements that result. This checklist
remains the regression gate for additional material; ASE 5.1 and 7.1 center and
side/back rendering still require listening validation.

| Material | Listen for | Must pass |
| --- | --- | --- |
| Centered vocal | Stable phantom/extracted center, natural sibilance | No vocal image jumping or audible surround leakage |
| Dense rock | Cohesive front wall, useful room energy, stable lateral placement | No pumping, narrowed guitars, or constant rear hash |
| Live/acoustic | Venue decay and audience separation | Reverb opens the room without adding a synthetic tail |
| Electronic hard-pan | Front-locked edge effects | No attention-grabbing hard-pan or attack spill into surrounds |
| Phase-wide stereo | Tonal integrity and front width | No hollowing, bass cancellation, or unstable steering |
| Mono-compatible mix | Center solidity | Surrounds remain effectively silent |
| Older stereo recording | Conservative steering under noise/limited bandwidth | More coherent than Ambient, never busier merely because noise is decorrelated |

For every selection, record layout, track/time range, Off/Ambient/Adaptive
preference, artifact notes, and whether the issue is a must-fix. The release
gate passes only when Adaptive consistently resembles a coherent authored bed
mix more than Ambient and no row has a must-fix artifact.

The offline companion for suspicious passages is:

```sh
npm run research:upmix -- track.flac --layout quad --rear-target-db -9 --blind-pack
```

Score the randomized quad files with normal front volume before opening the
answer key. Use the rear-only files to diagnose vocal leakage and artifacts,
not to rank spaciousness. Re-run the bake-off before changing the selected
extractor or fixed profile.

When two extractors are effectively tied, compare the previous A and C
finalists at all three levels without exposing either variable:

```sh
npm run research:upmix -- track.flac --layout quad --blind-level-sweep
```

To test a small amount of Ambient-like centered detail without reducing the
selected wide bed:

```sh
npm run research:upmix -- track.flac --layout quad --blind-center-sweep
```
