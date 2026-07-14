# Astra Companion API v2

The Companion API lets small tools, hardware controllers, dashboards, and automations work with a running Astra desktop app. It is deliberately bounded: clients can observe and control playback, search for named library items, act on opaque references, edit the upcoming queue, set favorites, and maintain local normal playlists. It is not a replacement Astra client and cannot browse the whole catalog or retrieve audio files.

The API is disabled by default. Existing `/v1` integrations continue to work unchanged.

## Enable loopback access

In Astra, open **Settings → Integrations → Local API** and enable the API. The bearer token shown there works only on `127.0.0.1`. Observation is granted when the API is enabled; playback control, library search, and library writes each have a separate switch and are off until enabled.

```sh
export ASTRA_API_URL=http://127.0.0.1:38401
export ASTRA_API_TOKEN='token copied from Astra settings'
curl -H "Authorization: Bearer $ASTRA_API_TOKEN" "$ASTRA_API_URL/v2/capabilities"
```

LAN clients use Astra's pinned-HTTPS pairing flow. A client requests companion scopes and the person at Astra approves a subset for that device. Each paired credential can be revoked, expires after inactivity, and follows the existing rotation policy. There is no copyable LAN master token.

## Scopes

| Scope | Access |
| --- | --- |
| `observe` | Capabilities, playback, queue, artwork, and playback/queue events |
| `playback-control` | Playback actions, play/enqueue intents, and upcoming-queue edits |
| `library-search` | Bounded search, open intents, and favorite/playlist event topics |
| `library-write` | Explicit favorite state and locally owned normal playlist changes |

Use `GET /v2/capabilities` after connecting. It reports the transport, actual granted scopes, feature flags, and current limits instead of requiring clients to guess.

## References and privacy

Search and playback responses use signed opaque `AstraRef` strings for tracks, albums, artists, and playlists. Treat a reference as an indivisible value: do not parse it, construct it, or persist it as a permanent library identifier. A valid reference may later return `404` if its target was deleted.

Public responses do not include filesystem paths, source IDs, credentials, raw artwork hashes, or audio streams. Artwork URLs return bounded thumbnails only. Search requires a non-empty query, defaults to 20 results, caps at 50, and has no pagination or empty-query catalog mode.

## Conventions

- Send `Authorization: Bearer <token>` on every endpoint except `GET /v2/openapi.json`.
- JSON errors are always shaped as `{ "error": { "code": "...", "message": "..." } }`.
- Timestamps are Unix epoch milliseconds. Playback positions and media durations are seconds.
- Renderer-executed playback, intent, and queue commands return `202 Accepted`. A `202` means Astra accepted the command, not that playback has already changed.
- If Astra's renderer is not ready, renderer-executed commands return `503 renderer_unavailable`.
- State-setting actions (`set-volume`, `set-muted`, `set-shuffle`, and `set-repeat`) and favorite writes explicitly set state and are safe to retry.
- JSON request bodies are capped at 64 KiB. Playlist additions accept 1–100 track references per request.
- CORS preflight is supported without cookies or credentialed CORS. Credentials still belong in the bearer header.
- Rate limits are per credential. At most eight v2 event streams may be connected at once.

## Events

`GET /v2/events` is a server-sent event stream. It accepts comma-separated `topics=playback,queue,favorite,playlist`. The `favorite` and `playlist` topics require `library-search`; unavailable topics are omitted from the stream.

Discrete playback and library changes are sent immediately. Position-only playback updates default to once per second. Set `positionIntervalMs` to an integer from 250 through 5000 to choose another interval.

```text
event: playback
data: {"state":"playing","positionSeconds":12.4,...}
```

## Examples

The examples use only the standard runtimes—no package install is required.

```sh
node docs/api/examples/observe.mjs
node docs/api/examples/search-to-play.mjs "Blue in Green"
node docs/api/examples/queue.mjs "Boards of Canada"
python3 docs/api/examples/playlist-generator.py "Morning Mix" "Nujabes" "Tycho" "Bonobo"
```

- [Observe playback with SSE](examples/observe.mjs)
- [Search and play a result](examples/search-to-play.mjs)
- [Search and enqueue results](examples/queue.mjs)
- [Generate a normal playlist](examples/playlist-generator.py)
- [OpenAPI 3.1 contract](openapi-v2.json)

The served contract is available without authentication at `GET /v2/openapi.json`.

## Deliberate omissions

v2 does not expose pageable library browsing, collection contents, filesystem paths, audio streaming, metadata editing, scans or folders, remote-source administration, settings, DSP/EQ, visualizer samples, lyrics, playlist deletion, or dynamic-playlist rules. Library writes are limited to favorites and locally owned normal playlists; mirrored and dynamic playlists reject edits.
