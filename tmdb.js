'use strict';

const config = require('./config');
const cache = require('./cache');

const { TMDB_BASE, TMDB_IMAGE_BASE, TMDB_API_KEY, REGION, LANGUAGE, ALLOWED_LANGUAGES } = config;

function isAllowedLanguage(lang) {
  return ALLOWED_LANGUAGES.includes(String(lang || '').toLowerCase());
}

/* ------------------------------------------------------------------ */
/* low-level                                                           */
/* ------------------------------------------------------------------ */

async function tmdbGet(path, params = {}) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not set');
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', LANGUAGE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  // Network-level failures ("fetch failed" / ECONNRESET) are common enough
  // from a cloud host under concurrency that a single attempt loses titles.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 2);
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }
      if (!res.ok) {
        throw new Error(`TMDB ${res.status} ${res.statusText} for ${path}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err.cause ? new Error(`${err.message}: ${err.cause.message}`) : err;
      if (attempt < 3) await sleep(attempt * 800);
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ */
/* title matching                                                      */
/* ------------------------------------------------------------------ */

// OTT titles carry season suffixes and punctuation TMDB does not have.
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "Panchayat: Season 3" -> "Panchayat"
function stripSeason(title) {
  return String(title || '')
    .replace(/[:\-–]\s*(season|series|part|volume|vol\.?|chapter|book)\s*\d+.*$/i, '')
    .replace(/\s*\(\s*(season|part)\s*\d+\s*\)\s*$/i, '')
    .replace(/\s*[:\-–]\s*(limited series|the final season)\s*$/i, '')
    .trim();
}

// How much of the longer string the shorter one covers. Guards against
// "Peddi" scoring as a prefix match for "Peddinti Alludu".
function lengthRatio(a, b) {
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : min / max;
}

function nameScore(name, target) {
  if (name === target) return 100;

  const ratio = lengthRatio(name, target);
  // Subtitle drift ("Ikka" vs "Ikka: The Ace") is real; unrelated words that
  // merely share an opening substring are not.
  if ((name.startsWith(target) || target.startsWith(name)) && ratio >= 0.6) return 55;
  if ((name.includes(target) || target.includes(name)) && ratio >= 0.75) return 35;

  // Whole-word prefix: every word of the shorter name matches the start of the
  // longer one. Length-independent, so a long subtitle cannot defeat it, but
  // it still requires the full short title to be present as a word sequence.
  const shorter = name.length <= target.length ? name : target;
  const longer = name.length <= target.length ? target : name;
  const shortWords = shorter.split(' ').filter(Boolean);
  const longWords = longer.split(' ').filter(Boolean);
  if (shortWords.length >= 2 && shortWords.every((w, i) => longWords[i] === w)) return 50;

  return 0;
}

function scoreCandidate(candidate, wanted, wantedYear) {
  const names = [candidate.title, candidate.name, candidate.original_title, candidate.original_name]
    .filter(Boolean)
    .map(normalize);
  const target = normalize(wanted);

  let score = Math.max(0, ...names.map(n => nameScore(n, target)));

  const date = candidate.release_date || candidate.first_air_date || '';
  const year = date ? Number(date.slice(0, 4)) : null;

  if (wantedYear && year) {
    const diff = Math.abs(year - wantedYear);
    if (diff === 0) score += 25;
    else if (diff === 1) score += 12;
    else score -= diff * 3;
  } else if (year) {
    // No year from the platform (Tudum gives none). Anything charting on an
    // OTT Top 10 is overwhelmingly recent, so bias hard toward new releases —
    // this is what stops a 1993 namesake beating the current title.
    // Continuous, not bucketed, so two same-titled films a few years apart
    // are actually separated instead of tying.
    const age = new Date().getFullYear() - year;
    score += Math.max(-40, Math.min(30, 30 - age * 3.5));
  }

  // popularity as a weak tiebreak only
  score += Math.min(Number(candidate.popularity || 0), 200) / 100;
  return score;
}

/* ------------------------------------------------------------------ */
/* resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve a scraped ranking entry to an IMDb-anchored Stremio meta.
 *
 * @param {{title:string, type:'movie'|'series', year?:number}} item
 * @returns {Promise<null|{imdb_id:string,tmdb_id:number,type:string,name:string,poster:string|null,description:string,year:number|null}>}
 */
async function resolve(item, providerId) {
  const type = item.type === 'series' ? 'series' : 'movie';
  const cleanTitle = stripSeason(item.title);

  // A platform that tells us the title has a Hindi/English/Marathi audio track
  // has settled the language question already — a Tamil film with a Hindi dub
  // is watchable for this user, and TMDB's original_language would wrongly
  // exclude it. TMDB itself carries no dub data at all (spoken_languages lists
  // only the original), so the source is the sole signal for this.
  const dubbed = Array.isArray(item.audioLanguages) &&
    item.audioLanguages.some(l => config.ALLOWED_LANGUAGES.includes(String(l).toLowerCase()));

  const key = `tmdb:${type}:${normalize(cleanTitle)}:${item.year || ''}:${providerId || ''}:${dubbed ? 'dub' : ''}`;
  return cache.get(key, config.TTL.tmdbResolve, () =>
    resolveUncached(cleanTitle, type, item.year, providerId, dubbed));
}

const MIN_SCORE = 45;
const MAX_CANDIDATES = 4;

/**
 * Progressively shorter forms of a title to search for.
 *
 * Platforms carry marketing subtitles TMDB does not share. Netflix lists
 * "Operation Safed Sagar: The Highest Air Force Mission", which returns zero
 * results; TMDB has the same show as "Operation Safed Sagar: The Untold Story
 * of the Kargil War". Searching the head alone finds it.
 */
function queryVariants(title) {
  const variants = [title];
  for (const sep of [':', ' - ', ' – ']) {
    const idx = title.indexOf(sep);
    // Require a meaningful head so we never degrade to a one-word query.
    if (idx > 8) {
      const head = title.slice(0, idx).trim();
      if (head && !variants.includes(head)) variants.push(head);
    }
  }
  return variants;
}

async function resolveUncached(title, type, year, providerId, dubbed) {
  const endpoint = type === 'series' ? '/search/tv' : '/search/movie';
  const yearParam = type === 'series' ? 'first_air_date_year' : 'year';

  let results = [];
  let matchedQuery = title;

  // Try each title form, with year then without, until something comes back.
  outer:
  for (const variant of queryVariants(title)) {
    for (const withYear of year ? [true, false] : [false]) {
      const data = await tmdbGet(endpoint, {
        query: variant,
        region: REGION,            // India-biased results
        include_adult: 'false',
        [yearParam]: withYear ? year : undefined
      });
      if ((data.results || []).length) {
        results = data.results;
        matchedQuery = variant;
        if (variant !== title) {
          console.log(`[tmdb] title trimmed for search: "${title}" -> "${variant}"`);
        }
        break outer;
      }
    }
  }

  if (!results.length) {
    console.warn(`[tmdb] no match: "${title}" (${type})`);
    return null;
  }

  // Score against whatever form actually produced results, otherwise a trimmed
  // query's candidates get judged against a subtitle they never had.
  title = matchedQuery;

  // Language gate applied BEFORE scoring, so a same-titled English/Hindi/Marathi
  // entry wins over a higher-scoring one in an excluded language rather than
  // the whole title being thrown away.
  // `dubbed` means the platform listed an allowed audio track, so the
  // original_language gate is bypassed for this title.
  const eligible = dubbed ? results : results.filter(c => isAllowedLanguage(c.original_language));
  if (!eligible.length) {
    const langs = [...new Set(results.map(c => c.original_language))].join(',');
    console.log(`[tmdb] language-excluded: "${title}" (${type}, original_language: ${langs})`);
    return null;
  }
  if (dubbed && !results.some(c => isAllowedLanguage(c.original_language))) {
    console.log(`[tmdb] kept via dub: "${title}" (${type}) — platform lists an allowed audio track`);
  }

  const ranked = eligible
    .map(c => ({ c, score: scoreCandidate(c, title, year) }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0].score < MIN_SCORE) {
    console.warn(`[tmdb] weak match rejected: "${title}" -> "${ranked[0].c.title || ranked[0].c.name}" (score ${ranked[0].score.toFixed(1)})`);
    return null;
  }

  const viable = ranked.filter(r => r.score >= MIN_SCORE).slice(0, MAX_CANDIDATES);
  let chosen = viable[0];

  // Ambiguous title (same name, different years) -> let actual availability on
  // the platform decide, rather than trusting the recency heuristic.
  if (providerId && viable.length > 1) {
    for (const cand of viable) {
      if (await availableOn(type, cand.c.id, providerId)) {
        if (cand !== viable[0]) {
          console.log(`[tmdb] provider tiebreak: "${title}" -> "${cand.c.title || cand.c.name}" (${(cand.c.release_date || cand.c.first_air_date || '').slice(0, 4)}) is the one on provider ${providerId}`);
        }
        chosen = cand;
        break;
      }
    }
  }

  const c = chosen.c;
  const imdb_id = await externalImdbId(type, c.id);
  if (!imdb_id) {
    console.warn(`[tmdb] no imdb_id for "${title}" (tmdb ${type} ${c.id})`);
    return null;
  }

  const date = c.release_date || c.first_air_date || '';
  return {
    imdb_id,
    tmdb_id: c.id,
    type,
    name: c.title || c.name || title,
    poster: c.poster_path ? TMDB_IMAGE_BASE + c.poster_path : null,
    description: c.overview || '',
    year: date ? Number(date.slice(0, 4)) : null,
    language: c.original_language
  };
}

/**
 * Is this TMDB title streaming on the given provider in India?
 *
 * This is the tiebreak that title+year alone cannot give us. Netflix's Top 10
 * feed carries no year, so "Extinction" matches several films equally well —
 * but only one of them is actually on Netflix IN.
 */
async function availableOn(type, tmdbId, providerId) {
  const path = type === 'series' ? `/tv/${tmdbId}/watch/providers` : `/movie/${tmdbId}/watch/providers`;
  try {
    const data = await tmdbGet(path);
    const india = (data.results || {})[REGION];
    if (!india) return false;
    const offers = [...(india.flatrate || []), ...(india.free || []), ...(india.ads || [])];
    return offers.some(o => Number(o.provider_id) === Number(providerId));
  } catch (err) {
    console.warn(`[tmdb] watch/providers failed for ${type} ${tmdbId}: ${err.message}`);
    return false;
  }
}

async function externalImdbId(type, tmdbId) {
  const path = type === 'series' ? `/tv/${tmdbId}/external_ids` : `/movie/${tmdbId}/external_ids`;
  try {
    const data = await tmdbGet(path);
    return data.imdb_id || null;
  } catch (err) {
    console.warn(`[tmdb] external_ids failed for ${type} ${tmdbId}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a whole ranking, preserving rank order, with bounded concurrency.
 * Entries that cannot be anchored to an IMDb id are dropped (they would render
 * in Stremio but no stream addon could resolve them).
 *
 * @param {Array<{title:string,type:string,rank:number,year?:number}>} items
 */
async function resolveMany(items, providerId) {
  const out = new Array(items.length).fill(null);
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        const meta = await resolve(items[i], providerId);
        if (meta) out[i] = { ...meta, rank: items[i].rank };
      } catch (err) {
        // Network failure, not "no such title" — worth another go.
        failed.push(i);
        console.warn(`[tmdb] resolve error for "${items[i].title}": ${err.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(config.TMDB_CONCURRENCY, items.length) }, worker)
  );

  // Second pass, strictly serial. A title lost to a transient connection reset
  // would otherwise stay missing from the catalog for the whole TTL, which is
  // how a 6-title Netflix list silently became a 4-title one.
  if (failed.length) {
    console.log(`[tmdb] retrying ${failed.length} failed title(s) serially`);
    for (const i of failed) {
      try {
        const meta = await resolve(items[i], providerId);
        if (meta) out[i] = { ...meta, rank: items[i].rank };
      } catch (err) {
        console.warn(`[tmdb] retry failed for "${items[i].title}": ${err.message}`);
      }
    }
  }

  const resolved = out.filter(Boolean);
  const dropped = items.length - resolved.length;
  if (dropped) console.warn(`[tmdb] dropped ${dropped}/${items.length} unresolvable titles`);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* fallback: TMDB Discover by watch provider (JustWatch data)          */
/* ------------------------------------------------------------------ */

/**
 * Used only when a platform scraper fails. Data powered by JustWatch —
 * attribution lives in the addon manifest description.
 */
async function discoverByProvider(providerId, type, limit = config.MAX_ITEMS) {
  const endpoint = type === 'series' ? '/discover/tv' : '/discover/movie';

  // Recent window only. Without it, "popular on Prime" returns the all-time
  // catalog (Inception, The Dark Knight) rather than what is trending now.
  const since = new Date();
  since.setMonth(since.getMonth() - config.DISCOVER_WINDOW_MONTHS);
  const sinceStr = since.toISOString().slice(0, 10);
  const dateGte = type === 'series' ? 'first_air_date.gte' : 'primary_release_date.gte';

  // TMDB's with_original_language takes a single value, so query once per
  // allowed language.
  const perLanguage = await Promise.all(
    ALLOWED_LANGUAGES.map(lang =>
      tmdbGet(endpoint, {
        with_watch_providers: providerId,
        watch_region: REGION,
        with_original_language: lang,
        [dateGte]: sinceStr,
        sort_by: 'popularity.desc',
        include_adult: 'false',
        page: 1
      }).catch(err => {
        console.warn(`[tmdb] discover ${type}/${lang} failed: ${err.message}`);
        return { results: [] };
      })
    )
  );

  // Round-robin across languages instead of one global popularity sort —
  // English out-populars Hindi/Marathi everywhere, and a straight sort would
  // push regional titles off the end of the list entirely.
  const queues = perLanguage.map(d =>
    (d.results || [])
      .filter(c => isAllowedLanguage(c.original_language))
      .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))
  );

  const results = [];
  for (let i = 0; results.length < limit; i++) {
    const before = results.length;
    for (const q of queues) {
      if (q[i]) results.push(q[i]);
      if (results.length >= limit) break;
    }
    if (results.length === before) break; // every queue exhausted
  }

  // Rank is assigned AFTER the IMDb check, not before — these are synthetic
  // positions, so a dropped title should close the gap rather than leave one.
  const out = [];
  for (const c of results) {
    const imdb_id = await externalImdbId(type, c.id);
    if (!imdb_id) continue;
    const rank = out.length + 1;
    const date = c.release_date || c.first_air_date || '';
    out.push({
      imdb_id,
      tmdb_id: c.id,
      type,
      rank,
      name: c.title || c.name,
      poster: c.poster_path ? TMDB_IMAGE_BASE + c.poster_path : null,
      description: c.overview || '',
      year: date ? Number(date.slice(0, 4)) : null,
      language: c.original_language
    });
  }
  return out;
}

module.exports = {
  tmdbGet,
  resolve,
  resolveMany,
  discoverByProvider,
  externalImdbId,
  stripSeason,
  normalize,
  isAllowedLanguage,
  availableOn
};
