# Resolve album regressions

`resolveAlbums.ts` contains metadata extracted from 42 tester-provided files
with the installed `music-metadata` parser. The projection follows the library
scanner, including normalized structured artist credits, null fields, and the
MD5 plus extension identity of the selected embedded cover. IDs use portable
album directories and the original filenames. No audio or image bytes are stored.

- **Carti Leaks:** 18 tracks numbered 1–18, all with Album Artist Playboi Carti
  and the same embedded cover. Years: 2013 (1), 2015 (1), 2016 (5), 2018 (1),
  2019 (2), missing (8). Resolve v6 split these into 14 + 3 + 1 tracks.
  The M4A declares its cover as JPEG while the other files declare PNG;
  the bytes match, but the scanner's cache identities have different suffixes.
  That distinction is preserved in the fixture.
- **Scarlet 2 CLAUDE:** 24 tracks, with disc 1 numbered 1–14/14 and disc 2
  numbered 1–10/10. All have disc total 2, year 2024, Album Artist Doja Cat,
  and the same embedded cover. Resolve v6 split these into 14 + 10 tracks.

Expected: one album per collection, preserving every track and its original
metadata. Tests use this fixture without depending on the original music files.

`resolveMultiDiscAlbums.ts` uses the same metadata projection for a second batch
of 66 files. Each album has matching Album Artist, year, and embedded artwork,
with disc total 2 and complete numbering within each disc:

| Album | Album Artist | Year | Disc 1 | Disc 2 | Expected album size |
| --- | --- | --- | --- | --- | --- |
| 2014 Forest Hills Drive | J. Cole | 2024 | 13 | 8 | 21 |
| The E•N•D | Black Eyed Peas | 2009 | 15 | 10 | 25 |
| Foundling | David Gray | 2010 | 11 | 9 | 20 |

Replaying the actual files through Resolve v6 reproduced all three disc splits.
Version 7 groups each release correctly without further algorithm changes.
The combined corpus contains 108 tracks belonging to five albums.
