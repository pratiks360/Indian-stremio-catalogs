'use strict';

/**
 * ZEE5 India — homepage rails.
 *
 * The rails are server-rendered into the Next.js payload; there is no XHR to
 * capture. Path:
 *
 *   __NEXT_DATA__ .props.pageProps.collectionData.rails[].contents[]
 *
 * Two things make this source better than a bare ranking:
 *   - `languages` is on every item, so the en/hi/mr gate runs at the source
 *     rather than waiting on TMDB's original_language.
 *   - `releaseDate` gives TMDB a real year to match against, which is what
 *     Netflix's feed cannot provide.
 *
 * GEO: ZEE5 resolves country from the request IP. From outside India the same
 * URL returns `collectionData: null` with `context.properties.country` set to
 * the caller's country. There is no override parameter — this module only
 * works from an Indian IP.
 *
 * BOT: a bare user-agent gets a 403 Akamai "Access Denied". The full Chrome
 * header set in lib/http.js gets a 200. See that file.
 */

const { browserHeaders, fetchWithRetry, extractNextData } = require('../lib/http');
const config = require('../config');

const HOME_URL = 'https://www.zee5.com/';

// assetSubType -> Stremio type. Anything not listed is not a watchable title
// (external_link is a cross-promo card, video/trailer are clips).
const TYPE_BY_SUBTYPE = {
  movie: 'movie',
  tvshow: 'series',
  original: 'series'
};

// "Upcoming on Zee 5" is unreleased content — no streams exist for it yet, so
// it would render as a dead poster in Stremio.
const SKIP_RAIL = /upcoming|trailer|teaser|coming soon/i;

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function allowedByLanguage(languages) {
  if (!Array.isArray(languages) || !languages.length) return false;
  // Multi-language releases count if ANY track is one we allow: a title listed
  // as hi,ta,te,pa is a Hindi release too.
  return languages.some(l => config.ALLOWED_LANGUAGES.includes(String(l).toLowerCase()));
}

/**
 * @returns {Promise<Array<{title:string, type:'movie'|'series', rank:number, year?:number, languages:string[], rail:string}>>}
 */
async function getTrending() {
  const html = await fetchWithRetry(
    HOME_URL,
    { headers: browserHeaders() },
    { label: 'zee5', retries: 3, minBytes: 50000 }
  );

  const data = extractNextData(html);

  const country =
    (((data.props || {}).context || {}).properties || {}).country ||
    ((((data.props || {}).initialServerSideState || {}).usersLocationData) || {}).country_code;

  const collection = ((data.props || {}).pageProps || {}).collectionData;
  if (!collection || !Array.isArray(collection.rails)) {
    throw new Error(
      `no collectionData (country=${country || 'unknown'}) — ZEE5 needs an Indian IP`
    );
  }
  if (country && country !== 'IN') {
    console.warn(`[zee5] served country=${country}, expected IN — rails may not be the India catalog`);
  }

  const seen = new Set();
  const items = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const rail of collection.rails) {
    const railTitle = rail.title || rail.originalTitle || '';
    if (SKIP_RAIL.test(railTitle)) {
      console.log(`[zee5] skipping rail "${railTitle}"`);
      continue;
    }

    for (const it of rail.contents || []) {
      const type = TYPE_BY_SUBTYPE[it.assetSubType];
      if (!type) continue;
      if (!allowedByLanguage(it.languages)) continue;

      const title = String(it.title || '').trim();
      if (!title) continue;

      // Unreleased titles have no streams to resolve against.
      if (it.releaseDate && it.releaseDate > today) continue;

      // The same title appears across several rails; first occurrence wins,
      // which keeps the higher-placed rail's position.
      const key = `${type}:${normalizeTitle(title)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        title,
        type,
        rank: items.length + 1,
        year: it.releaseDate ? Number(String(it.releaseDate).slice(0, 4)) : undefined,
        languages: it.languages || [],
        // Dub signal for the resolver: ZEE5 lists every audio track it carries,
        // so a Tamil original with a Hindi dub shows up here as 'hi'.
        audioLanguages: [...new Set([...(it.audioLanguages || []), ...(it.languages || [])])],
        rail: railTitle
      });
    }
  }

  if (!items.length) throw new Error('rails parsed but no eligible titles found');

  console.log(
    `[zee5] ${items.length} titles from ${collection.rails.length} rails ` +
    `(${items.filter(i => i.type === 'movie').length} movies, ${items.filter(i => i.type === 'series').length} series)`
  );
  return items;
}

module.exports = { getTrending, HOME_URL };
