'use strict';

/**
 * Platform registry + the scrape -> hydrate -> fallback pipeline.
 *
 * One cache entry per platform holds the fully hydrated ranking for BOTH
 * types; the catalog handler just filters it. That keeps the number of
 * upstream calls tied to the platform count, not to the catalog count.
 */

const config = require('./config');
const cache = require('./cache');
const tmdb = require('./tmdb');

const PLATFORMS = {
  netflix: {
    id: 'netflix',
    name: 'Netflix India',
    source: require('./sources/netflix'),
    providerId: config.WATCH_PROVIDERS.netflix,
    ttl: config.TTL.netflix
  },

  // The three platforms below have no usable scraper: Amazon publishes no
  // chart at all, and SonyLIV/JioHotstar are still behind Akamai. They are
  // explicitly opted in to TMDB Discover (JustWatch data) as their title
  // source. Netflix and ZEE5 deliberately do NOT get this — if their scrapers
  // break we want an empty catalog and a loud log, not substituted data.
  primevideo: {
    id: 'primevideo',
    name: 'Amazon Prime Video India',
    source: null,
    allowDiscover: true,
    providerId: config.WATCH_PROVIDERS.primevideo,
    ttl: config.TTL.primevideo
  },

  // The three below are Discover-only for now — same deal as Prime, but for a
  // different reason: their rankings exist, we just have not captured the
  // endpoints yet. Each gets a `source` module in sources/ as it is captured;
  // nothing else here has to change when that happens.
  zee5: {
    id: 'zee5',
    name: 'ZEE5 India',
    source: require('./sources/zee5'),
    providerId: config.WATCH_PROVIDERS.zee5,
    ttl: config.TTL.zee5
  },

  jiohotstar: {
    id: 'jiohotstar',
    name: 'JioHotstar India',
    source: null,
    allowDiscover: true,
    providerId: config.WATCH_PROVIDERS.jiohotstar,
    ttl: config.TTL.jiohotstar
  },

  sonyliv: {
    id: 'sonyliv',
    name: 'SonyLIV India',
    source: null,
    allowDiscover: true,
    providerId: config.WATCH_PROVIDERS.sonyliv,
    ttl: config.TTL.sonyliv
  }
};

/**
 * Hydrated payload for one platform.
 * @returns {Promise<{items:Array, origin:'scrape'|'discover', at:number}>}
 */
async function build(platformId) {
  const platform = PLATFORMS[platformId];
  if (!platform) throw new Error(`unknown platform: ${platformId}`);

  // 1. ranking
  let ranking = null;
  try {
    if (!platform.source) throw new Error('no ranking source (Discover-only platform)');
    ranking = await platform.source.getTrending();
    if (!ranking || !ranking.length) throw new Error('scraper returned no items');
  } catch (err) {
    console.log(`[${platformId}] no ranking (${err.message}) -> TMDB Discover`);
    ranking = null;
  }

  // 2a. happy path: hydrate the real ranking against TMDB
  if (ranking) {
    const items = await tmdb.resolveMany(ranking.slice(0, config.MAX_ITEMS * 2), platform.providerId);
    if (items.length) return { items, origin: 'scrape', at: Date.now() };
    console.error(`[${platformId}] nothing resolved from ranking -> TMDB Discover fallback`);
  }

  // 2b. No ranking. TMDB Discover is NOT a substitute for a real chart — it
  // would put titles in the catalog that never charted on this platform. Off
  // unless explicitly enabled.
  if (!platform.allowDiscover && !config.ALLOW_DISCOVER_FALLBACK) {
    console.error(`[${platformId}] no ranking available -> empty catalog (Discover fallback disabled)`);
    return { items: [], origin: 'unavailable', at: Date.now() };
  }

  const [movies, series] = await Promise.all([
    tmdb.discoverByProvider(platform.providerId, 'movie'),
    tmdb.discoverByProvider(platform.providerId, 'series')
  ]);
  return { items: [...movies, ...series], origin: 'discover', at: Date.now() };
}

/**
 * @param {string} platformId
 * @param {'movie'|'series'} type
 * @returns {Promise<{metas:Array, origin:string}>}
 */
async function getCatalog(platformId, type) {
  const platform = PLATFORMS[platformId];
  if (!platform) return { metas: [], origin: 'none' };

  const payload = await cache.get(`catalog:${platformId}`, platform.ttl, () => build(platformId));

  const metas = payload.items
    .filter(it => it.type === type)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, config.MAX_ITEMS)
    .map(it => toMeta(it, platform, payload.origin));

  return { metas, origin: payload.origin };
}

/**
 * Movies and series merged into one row. Stremio scopes a normal catalog by
 * type in the URL, so a mixed row needs a custom catalog type
 * (`iott_trending`) — Stremio renders it as its own Discover tab, and each
 * meta still carries its real type (movie/series), which is all Stremio
 * needs for the info page and stream lookup downstream.
 *
 * Ordering: platform rank ascending. For a real weekly chart (Netflix, ZEE5)
 * rank is a single sequence already, so this is a genuine combined order. For
 * Discover-fallback platforms movie and series ranks come from two separate
 * TMDB queries (popularity within each type), so a merged sort here
 * interleaves them by that per-type position rather than a true cross-type
 * ranking — the best ordering available without a shared popularity signal.
 *
 * @param {string} platformId
 * @returns {Promise<{metas:Array, origin:string}>}
 */
async function getTrendingCatalog(platformId) {
  const platform = PLATFORMS[platformId];
  if (!platform) return { metas: [], origin: 'none' };

  const payload = await cache.get(`catalog:${platformId}`, platform.ttl, () => build(platformId));

  const metas = [...payload.items]
    .sort((a, b) => a.rank - b.rank || (a.type === b.type ? 0 : a.type === 'movie' ? -1 : 1))
    .slice(0, config.MAX_ITEMS)
    .map(it => toMeta(it, platform, payload.origin));

  return { metas, origin: payload.origin };
}

/**
 * IMDb id as the meta id — Cinemeta fills in the details and every installed
 * stream addon resolves against it.
 */
function toMeta(item, platform, origin) {
  const parts = [`#${item.rank} on ${platform.name}`];
  if (origin === 'discover') parts.push('(popularity via JustWatch/TMDB)');
  if (item.description) parts.push('\n\n' + item.description);

  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: parts.join(' ').trim(),
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

/**
 * Language-scoped "latest releases" catalog — not tied to any one of the 5
 * tracked platforms. TMDB Discover, filtered to titles actually streamable
 * somewhere in India (JustWatch-backed watch/monetization data), sorted by
 * release date rather than popularity. Movies and series merged into one row
 * under the same custom trending type used elsewhere in this addon.
 */
const LANGUAGE_CATALOGS = {
  'marathi-latest': { id: 'marathi-latest', name: 'Marathi — Latest Releases', language: 'mr' }
};

async function buildLanguageCatalog(catalogId) {
  const cfg = LANGUAGE_CATALOGS[catalogId];
  if (!cfg) throw new Error(`unknown language catalog: ${catalogId}`);

  const [movies, series] = await Promise.all([
    tmdb.discoverLatestByLanguage(cfg.language, 'movie'),
    tmdb.discoverLatestByLanguage(cfg.language, 'series')
  ]);
  return { items: [...movies, ...series], origin: 'discover', at: Date.now() };
}

/**
 * @param {string} catalogId key into LANGUAGE_CATALOGS
 * @returns {Promise<{metas:Array, origin:string}>}
 */
async function getLanguageCatalog(catalogId) {
  const cfg = LANGUAGE_CATALOGS[catalogId];
  if (!cfg) return { metas: [], origin: 'none' };

  const payload = await cache.get(
    `langcatalog:${catalogId}`,
    config.TTL.zee5, // same 24h cadence as everything else
    () => buildLanguageCatalog(catalogId)
  );

  // Sort by actual release date across the merged movie+series list — rank
  // from discoverLatestByLanguage is per-type only, release date is the real
  // cross-type ordering for a "latest" row.
  const metas = [...payload.items]
    .sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')))
    .slice(0, config.MAX_ITEMS)
    .map(it => toLanguageMeta(it, cfg));

  return { metas, origin: payload.origin };
}

function toLanguageMeta(item, cfg) {
  const parts = [`New in ${cfg.name.split(' — ')[0]} (via JustWatch/TMDB)`];
  if (item.description) parts.push('\n\n' + item.description);

  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: parts.join(' ').trim(),
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

/** Fetch every registered platform once at boot so first render is instant. */
async function warmAll() {
  // Sequential, not parallel. Warming five platforms at once put ~150
  // concurrent TMDB lookups on the wire from a single cloud host, which
  // produced connection resets and silently short catalogs that then sat in
  // cache for the full TTL. Boot is slower this way; the data is complete.
  for (const p of Object.values(PLATFORMS)) {
    await cache.warm(`catalog:${p.id}`, p.ttl, () => build(p.id));
  }
  for (const id of Object.keys(LANGUAGE_CATALOGS)) {
    await cache.warm(`langcatalog:${id}`, config.TTL.zee5, () => buildLanguageCatalog(id));
  }
}

module.exports = {
  PLATFORMS,
  LANGUAGE_CATALOGS,
  getCatalog,
  getTrendingCatalog,
  getLanguageCatalog,
  build,
  warmAll
};
