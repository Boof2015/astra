# Translating Astra

Astra's desktop translations live in `src/shared/i18n/locales`. English is the source catalog and
the fallback whenever another locale does not yet define a key. The phone remote, generated share
images, installer copy, and right-to-left layouts are not part of the first localization release.

## Add a locale

1. Add an entry to `manifest.json` using a canonical BCP 47 locale code and the language's native
   display name. Only `ltr` locales are formally supported in this release.
2. Create `locales/<code>/` and copy whichever English namespace files you want to translate:
   `common`, `settings`, `library`, `playback`, `integrations`, and `errors`.
3. Translate values only. Keep JSON keys, product names, interpolation placeholders such as
   `{{count}}`, and technical protocol names unchanged.
4. Run `npm run i18n:validate`, `npm run typecheck`, and `npm test` before opening a pull request.

Partial translations are welcome. Missing keys automatically render in English, while obsolete
keys are reported but do not block a contribution. The validator rejects malformed catalogs and
translations that lose or rename interpolation variables.

## Review and screenshots

Use `?locale=en-XA` in development to enable Astra's expanded pseudo-locale. Check the main window,
mini-player, lyrics and analyzer popouts, native file dialogs, keyboard-only labels, and the minimum
supported window size. Include screenshots for any translation that noticeably changes layout.

