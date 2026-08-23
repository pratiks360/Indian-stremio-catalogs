'use strict';

/**
 * ZEE5 India — real Top 10 charts.
 *
 * Rails are server-rendered into the Next.js payload; there is no XHR to
 * capture. Path:
 *
 *   __NEXT_DATA__ .props.pageProps.collectionData.rails[].contents[]
 *
 * The homepage's own rails are a promotional carousel — reshuffles between
 * requests, mixes in 2007-2019 back-catalog filler alongside new releases.
 * ZEE5 tags its rails internally, though, and a genuine chart rail carries
 * "top10" in `rail.tags`:
 *
 *   /movies      -> rail tagged ["movies","top10"] ("Popular in Your Language")
 *   /web-series  -> rail tagged ["top10"]           ("Top 10 Web Series")
 *
 * That is what this scrapes — the site's own labeled charts, not a rail
 * picked by title text (title strings are localized/renamed; the tag isn't).
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
 * BOT: a bare user-agent gets a 403 Akamai "Access Denied" on every path.
 * The full Chrome header set in lib/http.js gets a 200 — except through curl,
 * which gets 403 even with identical headers (TLS/JA3 fingerprinting, not
 * header content). Node's fetch is not fingerprinted the same way; confirmed
 * live. Don't "fix" a future 403 here by copying curl commands verbatim.
 */

const { browserHeaders, fetchWithRetry, extractNextData } = require('../lib/http');
const config = require('../config');

const CHART_PAGES = [
  { url: 'https://www.zee5.com/movies', type: 'movie' },
  { url: 'https://www.zee5.com/web-series', type: 'series' }
];

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function allowedByLanguage(languages) {
  if (!Array.isArray(languages) || !languages.length) return false;
  // Multi-language releases count if ANY track is one we allow: a title listed
  // as hi,ta,te,pa is a Hindi release too.
  return languages.some(l => config.ALLOWED_LANGUAGES.includes(String(l).toLowerCase()));
}

/** Pick the rail ZEE5 itself marks as a Top 10 chart, not one matched by title. */
function findChartRail(rails) {
  const tagged = (rails || []).filter(r => Array.isArray(r.tags) && r.tags.includes('top10'));
  if (!tagged.length) return null;
  // Prefer the rail with the most items when more than one is tagged (e.g.
  // /movies carries both "Popular in Your Language" and "Top Rented Movies").
  return tagged.sort((a, b) => (b.contents || []).length - (a.contents || []).length)[0];
}

async function fetchChartPage(url, type) {
  const html = await fetchWithRetry(
    url,
    { headers: browserHeaders({ referer: 'https://www.zee5.com/' }) },
    { label: `zee5-${type}`, retries: 3, minBytes: 50000 }
  );

  const data = extractNextData(html);
  const country =
    (((data.props || {}).context || {}).properties || {}).country ||
    ((((data.props || {}).initialServerSideState || {}).usersLocationData) || {}).country_code;

  const collection = ((data.props || {}).pageProps || {}).collectionData;
  if (!collection || !Array.isArray(collection.rails)) {
    throw new Error(`no collectionData for ${url} (country=${country || 'unknown'}) — ZEE5 needs an Indian IP`);
  }
  if (country && country !== 'IN') {
    console.warn(`[zee5] ${url} served country=${country}, expected IN`);
  }

  const rail = findChartRail(collection.rails);
  if (!rail) {
    throw new Error(`no rail tagged "top10" found on ${url}`);
  }
  console.log(`[zee5] ${type} chart: "${rail.title}" (tags: ${rail.tags.join(',')}, ${(rail.contents || []).length} items)`);
  return rail.contents || [];
}

/**
 * @returns {Promise<Array<{title:string, type:'movie'|'series', rank:number, year?:number, languages:string[], rail:string}>>}
 */
async function getTrending() {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const items = [];

  for (const { url, type } of CHART_PAGES) {
    const contents = await fetchChartPage(url, type);
    let rank = 0;

    for (const it of contents) {
      if (!allowedByLanguage(it.languages)) continue;

      const title = String(it.title || '').trim();
      if (!title) continue;

      // Unreleased titles have no streams to resolve against.
      if (it.releaseDate && it.releaseDate > today) continue;

      const key = `${type}:${normalizeTitle(title)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rank += 1;
      items.push({
        title,
        type,
        rank,
        year: it.releaseDate ? Number(String(it.releaseDate).slice(0, 4)) : undefined,
        languages: it.languages || [],
        // Dub signal for the resolver: ZEE5 lists every audio track it carries,
        // so a Tamil original with a Hindi dub shows up here as 'hi'.
        audioLanguages: [...new Set([...(it.audioLanguages || []), ...(it.languages || [])])]
      });
    }
  }

  if (!items.length) throw new Error('chart rails parsed but no eligible titles found');

  console.log(
    `[zee5] ${items.length} titles total ` +
    `(${items.filter(i => i.type === 'movie').length} movies, ${items.filter(i => i.type === 'series').length} series)`
  );
  return items;
}

module.exports = { getTrending, CHART_PAGES };
