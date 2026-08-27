# "VPS/Drive Downloaded" Catalog — Design Spec

Date: 2026-08-27

## Purpose

Titles downloaded via the local-seed feature
(`docs/superpowers/specs/2026-08-27-local-seed-design.md`) and moved onto
the Google Drive mount currently require re-searching the same title in
Stremio to replay them — the addon has no browsable list of what's already
downloaded. This adds a catalog, mirroring the existing "Prowlarr — Debrid
Cached" pattern (`debrid_catalog.js`), so a user can browse straight to a
previously-downloaded title without remembering to search for it again.

## Design

- **Sidecar extension**: `lib/localseed_state.js`'s per-infoHash entries
  gain a `releaseTitle` field (currently only `size`/`lastPlayed`/`status`
  are stored) — needed to resolve a title to TMDB/IMDb for the catalog.
  `lib/localseed.js`'s `moveToMount()` sets it when a download completes.
- **New module `lib/localseed_catalog.js`**, structurally identical to
  `debrid_catalog.js`: reads only sidecar entries with `status: 'mounted'`
  (i.e. actually available on the Drive mount, not still downloading —
  matches the "only available files shown" requirement literally), resolves
  each to TMDB/IMDb by reusing `debrid_catalog.js`'s existing
  `cleanReleaseName`/`looksLikeSeries`/`extractYear` exports rather than
  duplicating that regex logic.
- **New catalog** in `addon.js`: "VPS/Drive Downloaded", same movie/series
  dual-type pattern the other catalogs use (`iott-localseed-movie` /
  `iott-localseed-series`), only advertised when
  `config.REALDEBRID_TOKEN`-style gating applies here to
  `localseed.isEnabled()` — i.e. it does not appear at all when the Drive
  mount is not configured.
- **Eviction/stripping is already solved**: `sweepEviction()` in
  `lib/localseed.js` already calls `state.remove()` on the sidecar entry
  when a file is deleted from the mount for exceeding the Drive cap. Since
  this catalog reads the sidecar fresh on each request, an evicted title
  simply stops appearing — no new eviction-tracking code needed.
- **In-progress downloads are excluded**: only `status: 'mounted'` entries
  are listed. A title still downloading (`status: 'local'`) is not yet
  reliably instant-replayable (it still goes through the WebTorrent path,
  not a direct file serve), so it stays out of this catalog until it
  completes.
- **Playback requires no new code**: clicking a catalog item routes through
  Stremio's normal flow — the existing stream handler does a fresh Prowlarr
  search, finds the same release (same infoHash, deterministic), offers
  `Local`, and since `findOnMount()` already hits, it serves instantly from
  the mount via the existing local-seed resolve path. The catalog is purely
  a browsing convenience, not a new playback mechanism.
- **Explicitly out of scope** (considered and declined): automatically
  deleting a file once playback reaches its end. Stremio provides no
  playback-completion signal to addons; the only available proxy (tracking
  the highest HTTP byte range requested and inferring "watched" near 100%)
  was evaluated and declined in favor of the existing LRU/cap-based
  eviction alone, to avoid seek-to-end false positives and added tracking
  complexity.

## Data Flow

1. `lib/localseed.js`'s `moveToMount()` now stores `releaseTitle` in the
   sidecar alongside the existing `size`/`lastPlayed`/`status: 'mounted'`.
2. `lib/localseed_catalog.js`'s `getCatalog(type)`:
   - Reads all `status: 'mounted'` sidecar entries via
     `localseed_state.list()`.
   - For each, cleans the release title and resolves it to TMDB/IMDb
     (same `tmdb.resolve()` call `debrid_catalog.js` already makes),
     skipping unresolvable entries with a `console.log`, matching
     `debrid_catalog.js`'s existing behavior.
   - Caches the resolved list briefly (`cache.get()`, reusing
     `config.TTL.rdTorrents` — 5 minutes — the same cadence
     `debrid_catalog.js` uses for its own RD-account-derived catalog).
   - Filters/sorts/maps to Stremio metas exactly as `debrid_catalog.js`
     does, capped at `config.MAX_ITEMS`.
3. `addon.js`'s catalog handler routes `iott-localseed-movie` /
   `iott-localseed-series` to this new module the same way it already
   routes `iott-debrid-cached`.

## Error Handling

- A sidecar entry whose title fails to resolve to TMDB/IMDb is skipped and
  logged, not shown with broken metadata — identical to
  `debrid_catalog.js`'s existing behavior for unresolvable RD titles.
- If the Drive mount becomes unavailable between a catalog read and a
  playback attempt, the existing local-seed error handling (from the prior
  spec) already covers it — this catalog does not need its own fallback
  logic beyond what `lib/localseed.js` already provides.
