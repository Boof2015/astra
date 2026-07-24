# Astra listening import format

Astra can import listening history gathered outside the app — a Last.fm export, another
player's database, a spreadsheet. Astra does not ship converters; this document is the
contract so you can write one.

Import it from **Settings → Info → Imported Listening Data → Import Listening Data**.

## Guarantees

- **Merged, never replacing.** Imported plays add to what Astra already recorded. Nothing you
  listened to in Astra is overwritten or lowered.
- **Removable.** Every import is tagged with its `source`, and Settings offers a per-source
  Remove that deletes exactly what that import contributed.
- **Idempotent.** Import the same file twice and nothing changes, as long as your `playKey`
  values are stable between runs.

## File shape

```json
{
  "kind": "astra-listening-import",
  "formatVersion": 1,
  "source": "lastfm",
  "generator": "my-converter 1.0",
  "generatedAt": "2026-07-24T12:00:00.000Z",

  "tracks":    [["Song Title", "Artist", "Album", "Album Artist"]],
  "plays":     [[0, 12, 1750000000000]],
  "events":    [[0, "play-1", 1750000000000, 1750000180000, 180, true]]
}
```

`tracks` is a dictionary; every other list refers to it by array index. `plays` and `events`
are optional individually, but the file must contain at least one of them.

### Row shapes

| List | Tuple | Notes |
|---|---|---|
| `tracks` | `[title, artist, album, albumArtist]` | `albumArtist` may be `""`. A row with no title can never match. |
| `plays` | `[trackIndex, playCount, lastPlayedAt]` | Total plays for that track. `lastPlayedAt` may be `null`. |
| `events` | `[trackIndex, playKey, startedAt, endedAt, listenedSeconds, countsAsPlay]` | One individual listen. `endedAt` may be `null`. |

**All timestamps are epoch milliseconds.**

Ratings and favorites are intentionally outside this format. They can move between Astra
installs through Settings Transfer, but an external listening import contains only data that
can later be removed cleanly by `source`.

## Five things that will bite you

**1. Milliseconds, not seconds.** Last.fm's `uts` is in seconds — multiply by 1000. Astra
rejects implausible timestamps rather than silently filing everything under January 1970, so
a whole file in seconds fails with a message naming this exact mistake.

**2. `events` is what produces listening time.** Every time-based figure on the Stats page —
total listening time, the activity chart, active days, per-artist and per-album time — is
computed from `events`. Supply only `plays` and you get play counts with zero listening time.

**3. `playKey` must be stable across runs.** It is how re-importing merges instead of
duplicating. Derive it from the data (`"lastfm-1750000000"`), never from a random value or a
loop counter that could shift. It only needs to be unique within your file — Astra namespaces
it internally so it cannot collide with a listen Astra recorded itself.

**4. Do not let listens overlap.** One person cannot play two things at once, so overlapping
events are evidence that your durations are guesses that ran too long. Astra sums them anyway
and listening time reads high. If you are estimating duration, cap each listen at the gap
until the next one:

```js
listenedSeconds = Math.min(assumedDuration, nextStartedAt - startedAt)
```

Astra warns when it sees overlaps, but it will still import the file.

**5. `countsAsPlay: false` records time without a play.** Use it for partial listens you know
did not finish. `true` marks it as a play on the Stats page.

## Matching

Astra matches your rows against the local library on normalized title, then artist, then
album, falling back to title+artist and then title alone. Ambiguous matches are skipped.

Tracks not in the library **still import** — they appear on the Stats page with their title,
artist and album, without artwork, and are not clickable. A partial library is not a problem.

## What you cannot set

The format deliberately excludes internal identities and library state:

- **Which install a play belongs to.** Everything is attributed to `import:<source>`, so a
  file cannot claim to be an Astra install and overwrite its counts.
- **Session keys.** Namespaced with the same prefix, so a file cannot collide with local data.
- **File paths.** External data has no meaningful local paths; matching is metadata-only.
- **Ratings and favorites.** Those are library state rather than listening history and remain
  exclusive to Astra-to-Astra Settings Transfer.

## `source`

Lowercase letters, digits and hyphens, up to 32 characters. It names the **service**, not your
tool — `lastfm`, not `steves-converter`. It becomes the label in Settings and the key the
import is removed by, so two tools importing Last.fm data should both use `lastfm`.

Put your tool's name in `generator` instead; it is shown alongside the source and in errors.

## Versioning

`formatVersion` is checked exactly. If Astra reads a different version it refuses the file and
names both numbers. A major version bump may break existing converters — pin the version you
built against and re-check after Astra upgrades.

## Before you run it on a real library

Back up `library.db` from Astra's user data folder. Import is designed to be reversible via
per-source removal, but a backup costs nothing and the conversion is your code, not Astra's.

## Example

[`examples/lastfm-to-astra.mjs`](examples/lastfm-to-astra.mjs) is a worked converter for
Last.fm scrobbles. It is a reference for this document rather than a supported tool — adapt it
rather than depending on it. No package install is required.

```sh
node docs/examples/lastfm-to-astra.mjs docs/examples/lastfm-scrobbles.sample.json out.json
```

It demonstrates the two judgement calls a converter has to make: converting Last.fm's seconds
to milliseconds with a plausibility check, and capping each listen at the gap to the next
scrobble so estimated durations cannot overlap.
