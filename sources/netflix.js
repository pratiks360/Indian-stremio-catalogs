'use strict';

/**
 * Netflix India — official Top 10.
 *
 * We do NOT scrape netflix.com. Netflix publishes the per-country Top 10 as a
 * downloadable TSV on Tudum. It is country-keyed, so being outside India does
 * not matter: no geo workaround needed for this source.
 *
 *   https://www.netflix.com/tudum/top10/india
 *   https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv
 *
 * Columns:
 *   country_name  country_iso2  week  category  weekly_rank
 *   show_title  season_title  cumulative_weeks_in_top_10
 *
 * category is "Films" or "TV". show_title is already free of season suffixes
 * (season_title carries those), so it feeds TMDB search cleanly.
 *
 * Netflix refreshes this weekly (Tuesdays). The file is ~35 MB, so it is
 * fetched behind the cache, never per-request.
 */

const TSV_URL = 'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';
const COUNTRY = 'India';

const COL = {
  country_name: 0,
  country_iso2: 1,
  week: 2,
  category: 3,
  weekly_rank: 4,
  show_title: 5,
  season_title: 6,
  cumulative_weeks_in_top_10: 7
};

const RETRIES = 4;

// The 35 MB download resets mid-stream fairly often (observed ECONNRESET on
// roughly half of attempts). Retry with backoff before giving up to the
// Discover fallback.
async function fetchTsv() {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(TSV_URL, {
        headers: {
          accept: 'text/tab-separated-values,text/plain,*/*',
          'accept-language': 'en-IN,en;q=0.9',
          'user-agent': 'stremio-india-ott/0.1 (+catalog metadata only)'
        }
      });
      if (!res.ok) throw new Error(`Tudum TSV ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (text.length < 1000) throw new Error(`Tudum TSV suspiciously short (${text.length} bytes)`);
      return text;
    } catch (err) {
      lastErr = err.cause ? new Error(`${err.message}: ${err.cause.message}`) : err;
      console.warn(`[netflix] TSV fetch attempt ${attempt}/${RETRIES} failed: ${lastErr.message}`);
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr;
}

// Netflix dates the season_title of weekly live programming, e.g.
// "WWE SmackDown: August 14, 2026" or "Raw: August 10, 2026". These have no
// meaningful IMDb title-level mapping and fuzzy-match badly ("Raw" once
// resolved to an unrelated 1993 film), so they are excluded at the source.
const LIVE_EVENT_SEASON = /:\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s*$/i;

function isLiveEvent(cols) {
  const season = cols[COL.season_title] || '';
  if (season === 'N/A') return false;
  if (!LIVE_EVENT_SEASON.test(season)) return false;
  console.log(`[netflix] skipping live/weekly event: ${cols[COL.show_title]} (${season})`);
  return true;
}

/**
 * @returns {Promise<Array<{title:string, type:'movie'|'series', rank:number, week:string, weeksInTop10:number}>>}
 */
async function getTrending() {
  const text = await fetchTsv();
  const lines = text.split(/\r?\n/);

  // Header sanity check — if Netflix reshapes the file, fail loudly rather
  // than silently emitting garbage.
  const header = (lines[0] || '').split('\t');
  if (header[COL.country_name] !== 'country_name' || header[COL.show_title] !== 'show_title') {
    throw new Error(`Tudum TSV header changed: ${lines[0]}`);
  }

  const rows = [];
  let latestWeek = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split('\t');
    if (c[COL.country_name] !== COUNTRY) continue;
    rows.push(c);
    if (c[COL.week] > latestWeek) latestWeek = c[COL.week]; // ISO dates sort lexically
  }

  if (!rows.length) throw new Error(`no ${COUNTRY} rows in Tudum TSV`);

  const items = rows
    .filter(c => c[COL.week] === latestWeek)
    .filter(c => !isLiveEvent(c))
    .map(c => ({
      title: c[COL.show_title].trim(),
      type: c[COL.category] === 'TV' ? 'series' : 'movie',
      rank: Number(c[COL.weekly_rank]),
      week: c[COL.week],
      weeksInTop10: Number(c[COL.cumulative_weeks_in_top_10]) || 0
    }))
    .filter(it => it.title && Number.isFinite(it.rank))
    .sort((a, b) => a.rank - b.rank);

  console.log(`[netflix] week ${latestWeek}: ${items.filter(i => i.type === 'movie').length} films, ${items.filter(i => i.type === 'series').length} tv`);
  return items;
}

module.exports = { getTrending, TSV_URL, COUNTRY };
