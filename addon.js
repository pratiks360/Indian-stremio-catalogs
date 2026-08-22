'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const config = require('./config');
const cache = require('./cache');
const { PLATFORMS, getCatalog, warmAll } = require('./catalog');

const ADDON_ID = 'community.india.ott.catalogs';

/**
 * A Stremio catalog entry is single-type, so each platform contributes two
 * entries (movie + series) rather than one dual-type catalog.
 * Catalog id format: iott-<platform>-<type>
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
}

const manifest = {
  id: ADDON_ID,
  version: '0.1.0',
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
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs,
  behaviorHints: { configurable: false, configurationRequired: false }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const match = /^iott-(.+)-(movie|series)$/.exec(id);
  if (!match) {
    console.warn(`[catalog] unknown catalog id: ${id}`);
    return { metas: [] };
  }
  const [, platformId, catalogType] = match;
  if (catalogType !== type) return { metas: [] };

  try {
    const { metas, origin } = await getCatalog(platformId, type);
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
