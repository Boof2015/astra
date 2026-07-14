#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("ASTRA_API_URL", "http://127.0.0.1:38401").rstrip("/")
TOKEN = os.environ.get("ASTRA_API_TOKEN")


def request(method, path, body=None):
    headers = {"Authorization": f"Bearer {TOKEN}"}
    encoded = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        encoded = json.dumps(body).encode("utf-8")
    try:
        with urllib.request.urlopen(
            urllib.request.Request(BASE_URL + path, data=encoded, headers=headers, method=method)
        ) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"API request failed: {error.code} {detail}") from error


if not TOKEN:
    raise SystemExit("Set ASTRA_API_TOKEN to the bearer token shown in Astra settings.")
if len(sys.argv) < 3:
    raise SystemExit("Usage: playlist-generator.py <playlist name> <query> [query ...]")

playlist_name, *queries = sys.argv[1:]
track_refs = []
for query in queries[:100]:
    encoded_query = urllib.parse.quote(query, safe="")
    result = request("GET", f"/v2/search?q={encoded_query}&types=track&limit=1")
    if result.get("results"):
        track_refs.append(result["results"][0]["ref"])
    else:
        print(f"No match: {query}", file=sys.stderr)

if not track_refs:
    raise SystemExit("None of the queries matched a track.")

playlist = request("POST", "/v2/playlists", {"name": playlist_name})
request("POST", f"/v2/playlists/{urllib.parse.quote(playlist['ref'], safe='')}/items", {
    "trackRefs": track_refs
})
print(f"Created {playlist['title']} with {len(track_refs)} tracks.")
