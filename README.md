<p align="center">
  <h1 align="center">🎬 Indian Stremio Catalogs</h1>
  <p align="center">
    <strong>Self-hosted Stremio addon: trending Indian OTT catalogs, AI-powered search, and torrent/debrid streaming — all on your own server.</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
    <img src="https://img.shields.io/badge/Stremio-Addon-7b5bf5?style=for-the-badge" alt="Stremio Addon">
    <img src="https://img.shields.io/badge/API-TMDB-01d277?style=for-the-badge" alt="TMDB">
    <img src="https://img.shields.io/github/last-commit/pratiks360/Indian-stremio-catalogs?style=for-the-badge&label=Last+Commit" alt="Last Commit">
  </p>
</p>

---

## 📋 Table of Contents

- [What Is This?](#-what-is-this)
- [Features](#-features)
- [Catalog Sources](#-catalog-sources)
- [Quick Start](#-quick-start)
- [How It Works](#-how-it-works)
- [Environment Reference](#️-environment-reference)
- [Streaming (Prowlarr + Real-Debrid + Local Seed)](#-streaming-prowlarr--real-debrid--local-seed)
- [Geo Requirement](#-geo-requirement)
- [Deployment](#-deployment)
- [Development](#-development)
- [Tech Stack](#️-tech-stack)
- [Security Notes](#-security-notes)
- [Troubleshooting](#-troubleshooting)
- [Attribution](#-attribution)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ What Is This?

**Indian Stremio Catalogs** is a self-hosted [Stremio](https://www.stremio.com/) addon that surfaces trending and latest titles from five major Indian OTT platforms, restricted to English, Hindi, and Marathi content — plus optional AI-powered free-text search and an integrated torrent/debrid stream resource for playback.

At its core it started as **catalog-only** (no stream handler, no playback URLs, no DRM): every title is emitted with its IMDb id so Cinemeta and your existing stream addons resolve playback. The stream resource, AI search, and local seedbox pieces below are optional layers on top, each independently enable-able.

---

## 🎯 Features

| Feature | Description |
|---|---|
| 📈 **Trending Catalogs** | Movies + series from 5 Indian OTT platforms, refreshed every 24h |
| 🌐 **Language Filter** | Only English / Hindi / Marathi, checked against TMDB `original_language` |
| 🪄 **TMDB Hydration** | Resolves scraped titles to IMDb ids, posters, and metadata — never invents rankings |
| 🔎 **AI Search & Recommend** | Free-text search via OpenRouter, with a variant filtered to titles actually on your 5 tracked platforms |
| 🎥 **Stream Resource** | Torrent releases via Prowlarr, resolved to Stremio streams (P2P or Real-Debrid) |
| ⚡ **Real-Debrid Cached Catalog** | Shows what's already instantly playable in your RD account |
| 🌱 **Local Seedbox** | Optional VPS-side WebTorrent download + Google Drive offload for releases RD can't touch |
| 📝 **Run Log & Activity Log** | Web dashboards tracking catalog refresh history and request-level debug activity |
| 💾 **Stale-While-Revalidate Cache** | 24h per-platform cache, warmed at boot; a failed refresh keeps last-good data |

---

## 📺 Catalog Sources

| Platform | Ranking source | Notes |
|---|---|---|
| **Netflix India** | Official Netflix Top 10 (Tudum TSV) | Country-keyed file, works from any IP |
| **ZEE5 India** | Homepage rails, server-rendered `__NEXT_DATA__` | Needs an Indian IP + full browser headers |
| **Amazon Prime Video India** | TMDB Discover (JustWatch data) | Amazon publishes no ranking feed |
| **JioHotstar India** | TMDB Discover (JustWatch data) | Scraper blocked by Akamai |
| **SonyLIV India** | TMDB Discover (JustWatch data) | Scraper blocked by Akamai |

Each platform contributes two catalogs (movies + series). With AI search/recommend and the Real-Debrid cached catalog enabled, the manifest advertises more on top of the base ten.

---

## 🚀 Quick Start

**Prerequisites:** Node.js 18+ (uses built-in `fetch`), a [TMDB](https://www.themoviedb.org/) v3 API key.

```bash
git clone https://github.com/pratiks360/Indian-stremio-catalogs.git
cd Indian-stremio-catalogs
npm install
cp .env.example .env    # then add your TMDB v3 API key
npm start
```

Manifest is served at `http://127.0.0.1:7000/manifest.json` — add that URL in Stremio's addon search bar.

---

## 🧩 How It Works

```
┌──────────────┐   ordered titles  ┌──────────────┐   imdb_id, poster,  ┌──────────────┐
│  Platform    │  ───────────────► │  TMDB         │  ─────────────────► │  Stremio     │
│  Ranking     │                   │  Hydration    │   language, year    │  Meta (tt…)  │
└──────────────┘                   └──────────────┘                     └──────────────┘
```

Scrapers only ever produce an **ordered list of titles**; TMDB is a hydration layer that resolves `title (+year)` to an IMDb id and artwork, and supplies `original_language` for the language filter — it never invents the ranking for a platform with a working scraper.

Notable behaviour:

- **Language filter** — `en` / `hi` / `mr` only, checked against TMDB `original_language`. Platforms that publish audio-track data (ZEE5) can override this, so a Tamil original with a Hindi dub is kept.
- **Provider tiebreak** — when a title is ambiguous (several films share a name), TMDB `watch/providers` decides which one is actually on that platform.
- **Live events dropped** — Netflix dates the `season_title` of weekly programming (e.g. `WWE SmackDown: August 14, 2026`); these have no title-level IMDb mapping and are skipped.
- **Caching** — 24h per platform, warmed at boot, stale-while-revalidate. A failed refresh keeps the last good data; upstream is never hit per-request.

---

## ⚙️ Environment Reference

Set these in `.env` (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `TMDB_API_KEY` | ✅ | TMDB **v3** API key (short key, not the v4 bearer token) |
| `OPENROUTER_API_KEY` | ❌ | Powers the AI Search catalog — leave blank to run without it |
| `OPENROUTER_MODEL` | ❌ | Model id from [openrouter.ai/models](https://openrouter.ai/models); defaults to OpenRouter's free-model router |
| `PROWLARR_URL` | ❌ | Prowlarr instance URL — powers the stream resource |
| `PROWLARR_API_KEY` | ❌ | Leave blank to run catalog-only, with no stream handler |
| `REALDEBRID_TOKEN` | ❌ | Enables the "Debrid Cached" catalog and RD as a stream option |
| `PUBLIC_ORIGIN` | ❌ | Public origin Stremio uses to reach RD resolve links (only needed with `REALDEBRID_TOKEN`) |
| `GDRIVE_MOUNT_PATH` | ❌ | Path where the Google Drive rclone mount lives — enables the local seedbox stream option |
| `HOST` | ❌ | Bind host, default `127.0.0.1` |
| `PORT` | ❌ | Bind port, default `7000` |

Deeper tuning (allowed languages, cache TTLs, watch-provider ids, concurrency) lives in [`config.js`](config.js).

---

## 🎥 Streaming (Prowlarr + Real-Debrid + Local Seed)

The stream resource is entirely optional and layered on top of the catalog:

1. **Prowlarr** resolves torrent releases for a title (`PROWLARR_API_KEY` required)
2. Each release is offered **peer-to-peer** by default — Stremio's built-in torrent engine streams it, announcing to the tracker from the user's own IP and passkey
3. **Real-Debrid** is offered *only* for releases whose torrent carries no passkey — sending a passkey-bearing torrent to RD would have RD's servers announce to a private tracker as the user, which is a bannable offence on most private trackers. With only private indexers configured, this path stays dark by design until a public indexer is added
4. For passkey-protected releases where the playing device's own P2P fails (some smart TVs / streaming boxes), the **local seedbox** downloads via WebTorrent on your own VPS instead — a legitimate seedbox pattern, since the tracker still sees the user's own passkey from one consistent IP — then moves the finished file onto a Google Drive mount so local disk only ever holds what's actively downloading

The **"Prowlarr — Debrid Cached"** catalog reads live from your Real-Debrid account (not a local log) so it stays accurate if something is deleted or added outside the addon.

---

## 🌍 Geo Requirement

ZEE5 resolves country from the request IP and returns nothing from outside India — there's no country override parameter, so that scraper needs to run on an Indian host. Netflix's TSV and all TMDB calls are region-keyed by parameter and work from anywhere.

ZEE5 also returns a `403` Akamai "Access Denied" to a bare user-agent and a `200` to a full Chrome header set from the same IP — see [`lib/http.js`](lib/http.js).

---

## 🚢 Deployment

[`deploy/stremio-india-ott.service`](deploy/stremio-india-ott.service) is a systemd unit for running this as a persistent service. Run a **single** instance — the cache is in-process, so a second worker means a second set of upstream scrapes.

Stremio Web requires HTTPS; the desktop and Android apps will load a plain `http://host:7000/manifest.json`.

For the local seedbox feature, see [`deploy/rclone-setup.md`](deploy/rclone-setup.md) for mounting Google Drive via rclone.

---

## 🛠️ Development

```bash
node scripts/test-source.js netflix          # raw ranking from one scraper
node scripts/test-source.js zee5 --full      # ranking + TMDB hydration
node scripts/dump-catalogs.js                # every catalog as Stremio sees it
bash scripts/probe.sh                        # endpoint reachability per platform
```

Run-history and activity dashboards are served from the addon itself once running (see [`runlog_html.js`](runlog_html.js) / [`activity_html.js`](activity_html.js)).

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Server** | Node.js, Express |
| **Addon SDK** | `stremio-addon-sdk` |
| **Metadata** | TMDB API |
| **AI Search** | OpenRouter |
| **Torrent Indexing** | Prowlarr |
| **Debrid** | Real-Debrid |
| **P2P / Seedbox** | WebTorrent |
| **Scraping** | Playwright (headless browser rendering for JS-heavy sources) |

---

## 🔒 Security Notes

- All API keys and tokens live in `.env` (never commit this file) — copy `.env.example` and fill in your own
- Real-Debrid is only ever offered for torrents with no tracker passkey, by design — see [Streaming](#-streaming-prowlarr--real-debrid--local-seed) above for why
- The local seedbox path is entirely optional and self-disables if `GDRIVE_MOUNT_PATH` doesn't exist
- Run a single addon instance; the cache and run logs are in-process/on-disk, not designed for multi-instance deployment

---

## 🐛 Troubleshooting

**Q: ZEE5 catalog is empty or errors out.**
A: ZEE5 requires an Indian IP address and full browser-style headers. Confirm your host is geo-located in India — see [Geo Requirement](#-geo-requirement).

**Q: AI Search catalog isn't showing up / errors.**
A: `OPENROUTER_API_KEY` is unset. AI search is optional — leave it blank to run without it, or add a key from [openrouter.ai/keys](https://openrouter.ai/keys).

**Q: No stream options appear for a title.**
A: The stream resource requires `PROWLARR_API_KEY`. Without it, the addon runs catalog-only by design, and playback is left to whatever other stream addons you already have installed.

**Q: Real-Debrid never shows up as a stream option.**
A: RD is only offered for torrents without a tracker passkey. If every configured indexer is private, this is expected — it activates automatically the moment a public indexer is added.

---

## 🙏 Attribution

Metadata from [TMDB](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB. Where a catalog falls back to TMDB Discover, the underlying availability data is powered by [JustWatch](https://www.justwatch.com/). Netflix rankings come from [Netflix Tudum](https://www.netflix.com/tudum/top10).

---

## 🤝 Contributing

This project is primarily for personal use, but PRs and issues are welcome! Feel free to open an issue to suggest features or report bugs.

---

## 📄 License

This project is open source under the [MIT License](LICENSE).

---

<p align="center">
  <sub>Built with ❤️ for anyone tired of hunting five different apps to see what's trending in India.</sub>
</p>
