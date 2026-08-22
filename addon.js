'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const config = require('./config');
const cache = require('./cache');
const { PLATFORMS, getCatalog, getTrendingCatalog, warmAll } = require('./catalog');
const search = require('./search');

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

// AI Search: free-text search across any movie/series, not scoped to the 5
// tracked platforms. One entry per real type (Stremio's search box queries
// both) sharing the same id — see search.js.
if (config.OPENROUTER_API_KEY) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: 'iott-ai-search',
      name: 'AI Search',
      extra: [{ name: 'search', isRequired: true }],
      isSearch: true
    });
  }
} else {
  console.warn('[manifest] AI Search catalog not advertised — OPENROUTER_API_KEY is not set');
}

const manifest = {
  id: ADDON_ID,
  version: '0.1.2',
  name: 'India OTT Charts',
  description:
    'Trending and top-ranked titles from Indian OTT platforms (India region), ' +
    'limited to English, Hindi and Marathi content. ' +
    'Catalog metadata only — no streams: each title is served as an IMDb id so Cinemeta ' +
    'fills in the details and your installed stream addons handle playback. ' +
    'Netflix rankings come from the official Netflix Top 10 (Tudum). ' +
    'Metadata from TMDB. When a platform ranking is unavailable, availability data ' +
    'falls back to TMDB Discover, powered by JustWatch.',
  logo: 'https://raw.githubusercontent.com/Stremio/stremio-art/master/original/stremio_symbol.png',
  resources: ['catalog'],
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
  if (id === 'iott-ai-search') {
    const query = extra && extra.search;
    if (!query) return { metas: [] };
    try {
      const { metas } = await search.search(query, type);
      console.log(`[search] "${query}" (${type}) -> ${metas.length} metas`);
      // Free-text results aren't on a refresh schedule — don't let Stremio
      // cache a query's answer past this addon's own 6h search cache.
      return { metas, cacheMaxAge: 0 };
    } catch (err) {
      console.error(`[search] "${query}" failed: ${err.message}`);
      return { metas: [] };
    }
  }

  const trendingMatch = /^iott-(.+)-trending$/.exec(id);
  const typedMatch = /^iott-(.+)-(movie|series)$/.exec(id);

  let platformId, fetcher;
  if (trendingMatch && type === TRENDING_TYPE) {
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

async function main() {
  console.log(`[boot] region=${config.REGION} platforms=${Object.keys(PLATFORMS).join(',')}`);
  await warmAll();
  console.log('[boot] cache state:', JSON.stringify(cache.stats(), null, 2));

  serveHTTP(builder.getInterface(), { port: config.PORT });
  console.log(`[boot] manifest: http://${config.HOST}:${config.PORT}/manifest.json`);
  console.log(`[boot] install in Stremio via: stremio://${config.HOST}:${config.PORT}/manifest.json`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[boot] fatal:', err);
    process.exit(1);
  });
}

module.exports = { manifest, builder };
