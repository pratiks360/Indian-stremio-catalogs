# Indian Stremio Catalogs

A Stremio **catalog** addon surfacing trending / latest titles from Indian OTT
platforms, restricted to English, Hindi and Marathi content.

Catalog metadata only — **no stream handler, no playback URLs, no DRM**. Every
title is emitted with its **IMDb id** (`tt…`) as the meta id, so Cinemeta fills
in the details and whatever stream addons you already have installed resolve
playback against it.

## Platforms

| Platform | Ranking source | Notes |
|---|---|---|
| Netflix India | Official Netflix Top 10 (Tudum TSV) | Country-keyed file, works from any IP |
| ZEE5 India | Homepage rails, server-rendered into `__NEXT_DATA__` | Needs an Indian IP + full browser headers |
| Amazon Prime Video India | TMDB Discover (JustWatch data) | Amazon publishes no ranking feed |
| JioHotstar India | TMDB Discover (JustWatch data) | Scraper blocked by Akamai |
| SonyLIV India | TMDB Discover (JustWatch data) | Scraper blocked by Akamai |

Each platform contributes two catalogs (movies + series), so the manifest
advertises ten.

## How it works

```
platform ranking  ──►  TMDB hydration  ──►  Stremio meta
(ordered titles)       (imdb_id, poster,     (id = tt…)
                        language, year)
```

Scrapers only ever produce an **ordered list of titles**. TMDB is a hydration
layer — it resolves `title (+year)` to an IMDb id and artwork, and supplies the
`original_language` used by the language filter. It never invents the ranking
for a platform that has a working scraper.

Notable behaviour:

- **Language filter** — `en` / `hi` / `mr` only, checked against TMDB
  `original_language`. Platforms that publish audio-track data (ZEE5) can
  override this, so a Tamil original with a Hindi dub is kept.
- **Provider tiebreak** — when a title is ambiguous (several films share a
  name), TMDB `watch/providers` decides which one is actually on that platform.
- **Live events dropped** — Netflix dates the `season_title` of weekly
  programming (`WWE SmackDown: August 14, 2026`); these have no title-level
  IMDb mapping and are skipped.
- **Caching** — 24h per platform, warmed at boot, stale-while-revalidate. A
  failed refresh keeps the last good data. Upstream is never hit per-request.

## Setup

Requires Node 18+ (uses built-in `fetch`).

```bash
npm install
cp .env.example .env    # then add your TMDB v3 API key
npm start
```

Manifest is served at `http://127.0.0.1:7000/manifest.json`.

### Environment

| Variable | Purpose |
|---|---|
| `TMDB_API_KEY` | TMDB **v3** API key (the short key, not the v4 bearer token) |
| `HOST` | Bind host, default `127.0.0.1` |
| `PORT` | Bind port, default `7000` |

Tuning lives in [`config.js`](config.js): allowed languages, cache TTLs,
watch-provider ids, request concurrency.

## Geo requirement

ZEE5 resolves country from the request IP and returns `collectionData: null`
from outside India — there is no country override parameter. That scraper needs
to run on an Indian host. Netflix's TSV and all TMDB calls are region-keyed by
parameter and work from anywhere.

ZEE5 also returns a `403` Akamai "Access Denied" to a bare user-agent and a
`200` to the full Chrome header set from the same IP; see [`lib/http.js`](lib/http.js).

## Deployment

[`deploy/stremio-india-ott.service`](deploy/stremio-india-ott.service) is a
systemd unit. Run a **single** instance — the cache is in-process, so a second
worker means a second set of upstream scrapes.

Stremio Web requires HTTPS; the desktop and Android apps will load a plain
`http://host:7000/manifest.json`.

## Development

```bash
node scripts/test-source.js netflix          # raw ranking from one scraper
node scripts/test-source.js zee5 --full      # ranking + TMDB hydration
node scripts/dump-catalogs.js                # every catalog as Stremio sees it
bash scripts/probe.sh                        # endpoint reachability per platform
```

## Attribution

Metadata from [TMDB](https://www.themoviedb.org/). This product uses the TMDB
API but is not endorsed or certified by TMDB. Where a catalog falls back to
TMDB Discover, the underlying availability data is powered by
[JustWatch](https://www.justwatch.com/). Netflix rankings come from
[Netflix Tudum](https://www.netflix.com/tudum/top10).
