# Translating Astra

Astra's translations live in `src/shared/i18n/locales`. English is the source catalog and the
fallback whenever another locale does not yet define a key.

Astra does not use a hosted translation platform. Everything a translator needs ships in this
repository, and the tool they work in is a single HTML file that runs offline with no account, no
server and no network access.

## Translating inside Astra (best option if you can run the app)

```
ASTRA_TRANSLATE=ja npm run dev
```

Hold <kbd>⌘</kbd> (<kbd>Ctrl</kbd> off macOS) and click any string. The studio panel shows its
key, the sentence it belongs to, what fills each placeholder, any note from the maintainers, and a
box to type the translation. Without the modifier the app behaves completely normally, so you
navigate to a string the same way a user would. <kbd>Esc</kbd> clears the selection.

Drag the panel by its header to move it; it stays where you put it. It deliberately floats rather
than docking, because resizing the app would change the wrapping and truncation you are trying to
judge.

**Sweep** outlines every untranslated string on the current screen and counts them, so you can
work through a view systematically instead of guessing what you have missed.

**Open…** force-opens dialogs that are otherwise hard to reach. Surfaces opt in with one line in
the component that owns their state:

```tsx
useTranslationSurface('Playlists ▸ Create dialog', () => setIsCreatePlaylistModalOpen(true))
```

The hook does nothing outside studio mode. Add one wherever a modal, wizard or transient cue holds
copy that a translator would otherwise have to reproduce by hand.

**What you type lands in the real UI immediately.** That is the point: no length budget or
context note tells you as much as watching your own wording sit in the actual button, at the
actual width, in the actual sentence. If it overflows, you see it overflow.

Work saves to the browser store as you go. **Export** writes `astra-<locale>.json` — the same
bundle the offline workbench produces, so a maintainer imports it the same way. Drafts are stored
under the same key as the workbench, so you can move between the two tools freely.

`ASTRA_I18N_INSPECT=1` gives the same panel read-only, for answering "which key is this?" without
translating anything.

Both are development tools; the context they display is never included in a packaged build.

## Translating in a browser (no toolchain needed)

You need one file and a web browser. Nothing else — no Node, no git, no editor.

1. Ask a maintainer for the workbench file for your language, or build it yourself with
   `npm run i18n:workbench -- --locale=<code>` (see below).
2. Open `astra-translate-<code>.html` in any browser. It works from a `file://` URL and never
   contacts the network.
3. Translate. Each string shows where it appears, what kind of control it is, the strings it sits
   next to, what each `{{placeholder}}` gets filled with, and any note from the maintainers.
   Problems are flagged as you type using the exact rules CI enforces, so anything the workbench
   accepts will pass review.
4. Your work saves in the browser automatically. **Export** downloads
   `astra-<code>.json`; **Import** loads it back, on this machine or another.
5. Send that one JSON file to a maintainer, or open a pull request yourself with
   `npm run i18n:import -- astra-<code>.json --apply`.

Partial translations are welcome. Anything you leave blank renders in English.

### What the workbench is telling you

| Signal | Meaning |
| --- | --- |
| Role badge (`button`, `tooltip`, `screen-reader`, `body`, `keywords`, …) | What kind of control the text sits in. `screen-reader` text is only ever read aloud, so length does not matter. `keywords` is a search-term list, not visible copy. |
| `fits ~N chars` | Advisory width budget. Going over is a warning, never an error — but check it fits if you can. |
| **Appears next to** | The other strings rendered beside this one. This is usually what tells you whether "Play" is a verb on a button or a column heading. |
| **Placeholders** | `{{name}}` must appear in your translation exactly as written. You may move it. You may not rename, drop, or invent one. |
| **needs review** / "the English changed" | The source text was rewritten after this string was translated. Re-check the wording. |

## For maintainers

```
npm run i18n:workbench -- --locale=de      # build the offline workbench
npm run i18n:import -- astra-de.json       # dry run: validate a returned bundle
npm run i18n:import -- astra-de.json --apply
npm run i18n:context                       # regenerate translator context
npm run i18n:check                         # everything CI runs
```

Import writes `locales/<code>/*.json` plus `src/shared/i18n/translation-state/<code>.json`, then
prints the manifest entry to add. A locale only becomes selectable once it is in
`manifest.json` with a canonical BCP 47 code and its native display name.

### Context sidecars

`src/shared/i18n/context/<namespace>.json` carries the translator-facing context for every message:
element role, screen, neighbouring strings, source locations, and what fills each placeholder.
All of it is derived from the code by `npm run i18n:context` and regenerated on every run.

Two fields are yours, and are preserved across regeneration:

- **`note`** — anything a machine cannot infer. "Verb, not a noun." "This is a file-type filter in
  the OS dialog." Notes are the highest-value thing in the whole file; add one whenever a string
  could reasonably be read two ways.
- **`placeholders.<name>.example`** — a realistic sample value.

These files are never bundled into the app. `npm run i18n:check` fails if they are stale or if a
message lands on a screen that `scripts/i18n/lib/screens.mjs` does not name, which is what keeps a
new component from quietly shipping context-free strings.

### Finding where a string lives

```
ASTRA_DEV_LOCALE=en-KEY npm run dev
```

Every label renders as its own catalog key, turning the UI into a key-to-screen map. Use it when
writing `screens.mjs` entries or answering "where does this one appear?". `ASTRA_DEV_LOCALE=en-XA`
is the other development locale: it expands and accents every message so you can see which
layouts break under a longer language. Both apply to the main window, mini-player and popouts,
and both are ignored outside development.

### Renaming a key

Rename it in the English catalog and in the source that references it, then record the move in
`locales/renames.json` and run `npm run i18n:migrate -- --apply`:

```json
[{ "from": "common:auto.old.key", "to": "common:navigation.newKey", "note": "gave it a real name" }]
```

That moves every locale's translation to the new key and carries its recorded source text with it.
Without it, each translation is orphaned and silently falls back to English. The ledger is
hand-written on purpose — guessing renames by text similarity risks pairing two unrelated strings
and shipping a confidently wrong translation.

### Why translations go stale

Keys are literals in both the source and the catalogs, so editing English copy edits a catalog
*value* and leaves the key untouched. Every translation stays attached, still structurally
perfect, now translated from English that no longer exists.
`src/shared/i18n/translation-state/<locale>.json` records the English each translation was made
from, so `npm run i18n:validate` can report exactly which ones drifted and the workbench can show
the translator what changed.

## Review

Check the main window, mini-player, lyrics and analyzer popouts, native file dialogs,
keyboard-only labels, and the minimum supported window size. Include screenshots for any
translation that noticeably changes layout.

## Not covered yet

The phone remote, the Parallax receiver's web UI, generated share images, installer copy, and
right-to-left layouts are outside the current localization scope. Roughly 111 user-facing strings
in `src/main` also reach the UI over IPC without passing through either extractor.
