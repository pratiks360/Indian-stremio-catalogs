'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const config = require('./config');
const cache = require('./cache');
const { PLATFORMS, LANGUAGE_CATALOGS, getCatalog, getTrendingCatalog, getLanguageCatalog, warmAll, refreshAll } = require('./catalog');
const search = require('./search');
const runlog = require('./runlog');
const { renderRunLogPage } = require('./runlog_html');
const stream = require('./stream');
const debridCatalog = require('./debrid_catalog');
const activityLog = require('./activity-log');
const { renderActivityPage } = require('./activity_html');
const localseed = require('./lib/localseed');
const localseedCatalog = require('./lib/localseed_catalog');
const friendRecs = require('./lib/friend_recs');
const friendCatalog = require('./friend_catalog');

const ADDON_ID = 'community.india.ott.catalogs';

// A standard Stremio catalog is scoped to one type by the request URL
// (/catalog/movie/... or /catalog/series/...), so a real mixed row is not
// possible under type 'movie' or 'series'. This custom type gets its own
// Discover tab; each returned meta still carries its own real type
// (movie/series), which is all Stremio needs downstream.
const TRENDING_TYPE = 'iott_trending';

/**
 * A Stremio catalog entry is single-type, so each platform contributes two
 * typed entries (movie + series) plus one merged "Trending" entry under the
 * custom type above.
 * Catalog id format: iott-<platform>-<type>, trending row: iott-<platform>-trending
 */
// Only advertise a catalog we can actually fill. A platform with no ranking
// source would serve an empty row in Stremio, which looks broken; better to
// not list it until its scraper exists.
const servable = Object.values(PLATFORMS).filter(p => p.source || p.allowDiscover || config.ALLOW_DISCOVER_FALLBACK);
const unservable = Object.values(PLATFORMS).filter(p => !servable.includes(p));
if (unservable.length) {
  console.warn(`[manifest] not advertised (no ranking source yet): ${unservable.map(p => p.id).join(', ')}`);
}

const catalogs = [];
for (const p of servable) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: `iott-${p.id}-${type}`,
      name: `${p.name} — Top ${type === 'movie' ? 'Movies' : 'Shows'}`,
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
  catalogs.push({
    type: TRENDING_TYPE,
    id: `iott-${p.id}-trending`,
    name: `${p.name} — Trending`,
    extra: [{ name: 'skip', isRequired: false }]
  });
}

// Language-scoped "latest releases" rows — not tied to any single platform.
// Same merged movie+series treatment as the per-platform Trending rows.
for (const cfg of Object.values(LANGUAGE_CATALOGS)) {
  catalogs.push({
    type: TRENDING_TYPE,
    id: `iott-lang-${cfg.id}`,
    name: cfg.name,
    extra: [{ name: 'skip', isRequired: false }]
  });
}

// AI Search: free-text search across any movie/series, not scoped to the 5
// tracked platforms. AI Recommend: same query pipeline, filtered to titles
// actually on a tracked platform. Two catalogs, not a toggle on one, so
// "look anything up" and "what can I actually watch" stay visibly distinct
// in Stremio's catalog list rather than depending on query phrasing.
// One entry per real type (Stremio's search box queries both) sharing the
// same id — see search.js.
if (config.OPENROUTER_API_KEY) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: 'iott-ai-search',
      name: 'AI Search',
      extra: [{ name: 'search', isRequired: true }],
      isSearch: true
    });
    catalogs.push({
      type,
      id: 'iott-ai-recommend',
      name: 'AI Recommend (My Platforms)',
      extra: [{ name: 'search', isRequired: true }],
      isSearch: true
    });
  }
} else {
  console.warn('[manifest] AI Search / AI Recommend not advertised — OPENROUTER_API_KEY is not set');
}

// What is already sitting in Real-Debrid, ready to play instantly.
if (config.REALDEBRID_TOKEN) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: 'iott-debrid-cached',
      name: 'Prowlarr — Debrid Cached',
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
} else {
  console.warn('[manifest] Debrid Cached catalog not advertised — REALDEBRID_TOKEN is not set');
}

// What is already downloaded to the VPS and moved onto the Google Drive
// mount, ready to replay instantly without re-searching.
if (localseed.isEnabled()) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: 'iott-localseed',
      name: 'VPS/Drive Downloaded',
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
} else {
  console.warn('[manifest] VPS/Drive Downloaded catalog not advertised — no Google Drive mount configured');
}

// Manually curated list — titles/IMDb ids pasted into /activity's textarea
// (POST /admin/friend-recs). Always advertised: TMDB_API_KEY is already a
// hard requirement for the rest of this addon, nothing extra to gate on.
for (const type of ['movie', 'series']) {
  catalogs.push({
    type,
    id: 'iott-friend',
    name: 'Friend Recommendations',
    extra: [{ name: 'skip', isRequired: false }]
  });
}

// Streams come from Prowlarr. Without it this stays a catalog-only addon,
// exactly as before, and playback is left to whatever else is installed.
const STREAMING = Boolean(config.PROWLARR_API_KEY);
if (!STREAMING) {
  console.warn('[manifest] stream resource not advertised — PROWLARR_API_KEY is not set');
}

const ADDON_VERSION = '0.3.2';

const manifest = {
  id: ADDON_ID,
  version: ADDON_VERSION,
  name: `Desi StreamHouse v${ADDON_VERSION}`,
  description:
    'Trending and top-ranked titles from Indian OTT platforms (India region), ' +
    'limited to English, Hindi and Marathi content. ' +
    'Titles are served as IMDb ids, so Cinemeta fills in the details. ' +
    'Netflix rankings come from the official Netflix Top 10 (Tudum). ' +
    'Metadata from TMDB. When a platform ranking is unavailable, availability data ' +
    'falls back to TMDB Discover, powered by JustWatch.' +
    (STREAMING
      ? ' Streams are sourced from your own Prowlarr indexers and played ' +
        'peer-to-peer, or via Real-Debrid where the release allows it.'
      : ''),
  logo: 'https://raw.githubusercontent.com/Stremio/stremio-art/master/original/stremio_symbol.png',
  resources: STREAMING ? ['catalog', 'stream'] : ['catalog'],
  types: ['movie', 'series', TRENDING_TYPE],
  idPrefixes: ['tt'],
  catalogs,
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
    searchable: Boolean(config.OPENROUTER_API_KEY)
  }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (id === 'iott-ai-search' || id === 'iott-ai-recommend') {
    const query = extra && extra.search;
    if (!query) return { metas: [] };
    const label = id === 'iott-ai-recommend' ? 'recommend' : 'search';
    try {
      const { metas } = await (id === 'iott-ai-recommend'
        ? search.recommend(query, type)
        : search.search(query, type));
      console.log(`[${label}] "${query}" (${type}) -> ${metas.length} metas`);
      // Free-text results aren't on a refresh schedule — don't let Stremio
      // cache a query's answer past this addon's own 6h search cache.
      return { metas, cacheMaxAge: 0 };
    } catch (err) {
      console.error(`[${label}] "${query}" failed: ${err.message}`);
      return { metas: [] };
    }
  }

  if (id === 'iott-debrid-cached') {
    try {
      const { metas, origin } = await debridCatalog.getCatalog(type);
      console.log(`[catalog] debrid-cached (${type}) -> ${metas.length} metas`);
      return { metas, cacheMaxAge: 300, staleRevalidate: 600, origin };
    } catch (err) {
      console.error(`[catalog] debrid-cached failed: ${err.message}`);
      return { metas: [] };
    }
  }

  if (id === 'iott-localseed') {
    try {
      const { metas, origin } = await localseedCatalog.getCatalog(type);
      console.log(`[catalog] localseed (${type}) -> ${metas.length} metas`);
      return { metas, cacheMaxAge: 300, staleRevalidate: 600, origin };
    } catch (err) {
      console.error(`[catalog] localseed failed: ${err.message}`);
      return { metas: [] };
    }
  }

  if (id === 'iott-friend') {
    try {
      const { metas, origin } = await friendCatalog.getCatalog(type);
      console.log(`[catalog] friend-recs (${type}) -> ${metas.length} metas`);
      return { metas, cacheMaxAge: 300, staleRevalidate: 600, origin };
    } catch (err) {
      console.error(`[catalog] friend-recs failed: ${err.message}`);
      return { metas: [] };
    }
  }

  const langMatch = /^iott-lang-(.+)$/.exec(id);
  const trendingMatch = /^iott-(.+)-trending$/.exec(id);
  const typedMatch = /^iott-(.+)-(movie|series)$/.exec(id);

  let platformId, fetcher;
  if (langMatch && type === TRENDING_TYPE) {
    fetcher = () => getLanguageCatalog(langMatch[1]);
  } else if (trendingMatch && type === TRENDING_TYPE) {
    platformId = trendingMatch[1];
    fetcher = () => getTrendingCatalog(platformId);
  } else if (typedMatch && typedMatch[2] === type) {
    platformId = typedMatch[1];
    fetcher = () => getCatalog(platformId, type);
  } else {
    console.warn(`[catalog] unknown catalog id/type: ${id} / ${type}`);
    return { metas: [] };
  }

  try {
    const { metas, origin } = await fetcher();
    const skip = Number(extra && extra.skip) || 0;
    const page = skip ? metas.slice(skip) : metas;
    console.log(`[catalog] ${id} -> ${page.length} metas (origin: ${origin}, skip: ${skip})`);
    // Rankings are small and refresh on a fixed schedule; let Stremio cache them.
    return { metas: page, cacheMaxAge: 3600, staleRevalidate: 7200 };
  } catch (err) {
    console.error(`[catalog] ${id} failed: ${err.message}`);
    return { metas: [] };
  }
});

// Public origin used to build RD resolve links. Stremio must be able to
// reach these, so it cannot be the loopback address the server binds to.
const PUBLIC_ORIGIN =
  process.env.PUBLIC_ORIGIN ||
  `http://${config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST}:${config.PORT}`;

if (STREAMING) {
  builder.defineStreamHandler(async ({ type, id }) => {
    try {
      const { streams } = await stream.getStreams(type, id, PUBLIC_ORIGIN);
      console.log(`[stream] ${type} ${id} -> ${streams.length} streams`);
      // Seeder counts and RD state both move; do not let Stremio pin these.
      return { streams, cacheMaxAge: 0 };
    } catch (err) {
      console.error(`[stream] ${type} ${id} failed: ${err.message}`);
      return { streams: [] };
    }
  });
}

async function main() {
  console.log(`[boot] region=${config.REGION} platforms=${Object.keys(PLATFORMS).join(',')}`);
  await warmAll();
  console.log('[boot] cache state:', JSON.stringify(cache.stats(), null, 2));

  // Not stremio-addon-sdk's serveHTTP() — it builds its own express app with
  // no hook to add routes. Mounting the SDK's router on our own app instead
  // keeps the addon protocol untouched while adding /runlog.json below.
  const app = express();
  app.use(getRouter(builder.getInterface()));
  app.get('/', (_, res) => res.redirect('/manifest.json'));

  // Publishes only the delta (newly added titles) per catalog refresh, not
  // a full re-dump — see runlog.js. ?limit=N caps entry count.
  app.get('/runlog.json', (req, res) => {
    const limit = Number(req.query.limit) || undefined;
    res.json(runlog.getLog(limit));
  });

  app.get('/runlog', (req, res) => {
    const limit = Number(req.query.limit) || undefined;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderRunLogPage(runlog.getLog(limit)));
  });

  app.get('/activity', (_, res) => {
    const localseedInfo = localseed.isEnabled()
      ? { enabled: true, active: localseed.listActive(), mounted: localseed.listMounted(), capBytes: config.LOCALSEED.DRIVE_CAP_BYTES }
      : { enabled: false };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderActivityPage(activityLog.readAll(), localseedInfo, friendRecs.list()));
  });

  // Manual catalog refresh from the /activity page's button. No auth on this
  // box (same as every other route here) — rate-limited to one run at a
  // time so repeated clicks can't pile up concurrent TMDB/scraper passes.
  let refreshInFlight = false;
  app.post('/admin/refresh-catalogs', async (_, res) => {
    if (refreshInFlight) {
      return res.status(429).json({ error: 'a refresh is already running' });
    }
    refreshInFlight = true;
    try {
      await refreshAll();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      refreshInFlight = false;
    }
  });

  // Titles/IMDb ids pasted into /activity's "Friend Recommendations"
  // textarea — one per line. express.text() only on this route: no JSON
  // body parser is wired up anywhere else in this addon, and this needs
  // nothing more than the raw textarea contents.
  app.post('/admin/friend-recs', express.text({ limit: '256kb' }), async (req, res) => {
    try {
      const result = await friendRecs.addLines(req.body);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/friend-recs/delete', (req, res) => {
    const { imdb_id, type } = req.query;
    if (!imdb_id || !type) return res.status(400).json({ error: 'imdb_id and type required' });
    friendRecs.remove(imdb_id, type);
    res.json({ ok: true });
  });

  // Delete one local-seed file from the /activity "Files" tab. location is
  // 'vps' (still-downloading torrent — cancelled + wiped) or 'gdrive'
  // (mounted file — unlinked through the rclone mount, which deletes the
  // real Drive file). Query string, not a JSON body — no body parser is
  // wired up elsewhere in this addon and this needs nothing more.
  app.post('/admin/delete-file', async (req, res) => {
    const { location, id } = req.query;
    if (!localseed.isEnabled()) return res.status(404).json({ error: 'local-seed not enabled' });
    if (location !== 'vps' && location !== 'gdrive') {
      return res.status(400).json({ error: 'location must be "vps" or "gdrive"' });
    }
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const found = location === 'vps'
        ? await localseed.deleteActive(id)
        : localseed.deleteMounted(id);
      activityLog.localSeed({ infoHash: location === 'vps' ? id : undefined, releaseTitle: id, phase: `delete-${location}`, success: true });
      res.json({ ok: true, found });
    } catch (err) {
      activityLog.localSeed({ releaseTitle: id, phase: `delete-${location}`, success: false, errorMsg: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Real-Debrid links can only be resolved at play time: the torrent may
  // need to be added first, and RD's instantAvailability endpoint that used
  // to answer this up front is gone (see lib/realdebrid.js).
  if (config.REALDEBRID_TOKEN) {
    app.get('/rd/resolve/:payload', async (req, res) => {
      try {
        const result = await stream.resolveDebridLink(req.params.payload);
        if (result.url) return res.redirect(302, result.url);

        // Still downloading. Stremio shows this as a failed stream, which is
        // honest — it is not playable yet — while RD keeps working on it.
        res.status(503).type('text/plain').send(result.message);
      } catch (err) {
        console.error(`[rd] resolve failed: ${err.message}`);
        res.status(502).type('text/plain').send(`Real-Debrid error: ${err.message}`);
      }
    });
  }

  // Local-seed: this addon downloads/seeds the torrent on its own VPS for
  // releases RD can't take (passkey-bearing). Self-disables when the Drive
  // mount is not present — see lib/localseed.js.
  if (localseed.isEnabled()) {
    app.get('/local/resolve/:payload', async (req, res) => {
      try {
        await stream.resolveLocalSeed(req, res, req.params.payload);
      } catch (err) {
        console.error(`[localseed] resolve failed: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).type('text/plain').send(`Local seedbox error: ${err.message}`);
        }
      }
    });
  }

  app.listen(config.PORT);
  console.log(`[boot] manifest: http://${config.HOST}:${config.PORT}/manifest.json`);
  console.log(`[boot] run log: http://${config.HOST}:${config.PORT}/runlog (html) / /runlog.json`);
  console.log(`[boot] activity log: http://${config.HOST}:${config.PORT}/activity`);
  console.log(`[boot] local-seed: ${localseed.isEnabled() ? 'enabled (' + config.LOCALSEED.MOUNT_PATH + ')' : 'disabled (no mount)'}`);
  console.log(`[boot] install in Stremio via: stremio://${config.HOST}:${config.PORT}/manifest.json`);

  // Refresh was previously demand-driven only (cache.get()'s stale-while-
  // revalidate kicks in only when a request lands after TTL expiry) — a
  // catalog nobody queried after 24h just stayed stale indefinitely. This is
  // the actual daily trigger, independent of traffic.
  const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    console.log('[refresh] daily rebuild starting');
    refreshAll()
      .then(() => console.log('[refresh] daily rebuild done'))
      .catch(err => console.error('[refresh] daily rebuild failed:', err.message));
  }, REFRESH_INTERVAL_MS);

  // 7-day rolling retention on the activity log — same cadence as the
  // catalog refresh above, plus once at boot so a long-running process
  // doesn't wait a full day before its first trim.
  activityLog.rotate();
  setInterval(() => activityLog.rotate(), REFRESH_INTERVAL_MS);

  // Same daily cadence: keep the Google Drive mount under its usage cap.
  if (localseed.isEnabled()) {
    localseed.sweepEviction().catch(err => console.error('[localseed] eviction sweep failed:', err.message));
    setInterval(() => {
      localseed.sweepEviction().catch(err => console.error('[localseed] eviction sweep failed:', err.message));
    }, REFRESH_INTERVAL_MS);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[boot] fatal:', err);
    process.exit(1);
  });
}

module.exports = { manifest, builder };
