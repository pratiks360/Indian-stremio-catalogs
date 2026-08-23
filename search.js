'use strict';

/**
 * Free-text AI search and recommendations, two catalogs sharing one pipeline.
 *
 * Pipeline, modeled on itcon-pty-au/stremio-ai-search:
 *   query -> OpenRouter (plain "type|name|year" lines, not JSON)
 *         -> parse
 *         -> tmdb.resolveMany (title/year/language scoring, imdb_id lookup)
 *
 * search()    — general lookup, unfiltered by platform availability (user's
 *               call). A hit might not be on any of the 5 tracked platforms.
 * recommend() — same pipeline, then filtered to only titles actually on one
 *               of the 5 tracked platforms (checked via
 *               tmdb.getWatchProviderIds), tagged with which one(s).
 *
 * Both respect the addon-wide language restriction (en/hi/mr) via the same
 * tmdb.resolve() gate every other source goes through.
 */

const config = require('./config');
const cache = require('./cache');
const tmdb = require('./tmdb');
const openrouter = require('./lib/openrouter');
const { PLATFORMS } = require('./catalog');

const NUM_RESULTS = 20;

function normalizeQuery(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildPrompt(query) {
  return [
    `You are a movie and TV series search expert. Analyze this query: "${query}"`,
    '',
    `Return up to ${NUM_RESULTS} movies and TV series that best match the query.`,
    'If the query looks like a specific title, that exact title MUST appear first.',
    '',
    'RESPONSE FORMAT: respond with ONLY the following, one per line, no commentary:',
    '[type]|[name]|[year]',
    '',
    'Example:',
    'movie|Jawan|2023',
    'series|Sacred Games|2018',
    '',
    'RULES:',
    '- Use | as the separator, exactly 3 fields per line.',
    '- type is exactly "movie" or "series".',
    '- year is the 4-digit release year.',
    '- Titles: clean, official titles only — no "(film)", no extra descriptions.',
    '- Only include content originally in English, Hindi, or Marathi — this addon does not serve other languages.',
    '- Only official, released movies and TV series. No games, books, fan content.'
  ].join('\n');
}

/**
 * "movie|Jawan|2023" and the looser "movie|Jawan (2023)" both parsed, same
 * tolerance as the reference implementation — models don't always follow the
 * 3-field format exactly.
 */
function parseLine(line) {
  const parts = line.split('|');
  let type, name, year;

  if (parts.length === 3) {
    [type, name, year] = parts.map(s => s.trim());
  } else if (parts.length === 2) {
    type = parts[0].trim();
    const rest = parts[1].trim();
    const paren = rest.match(/\((\d{4})\)\s*$/);
    if (paren) {
      year = paren[1];
      name = rest.slice(0, rest.lastIndexOf('(')).trim();
    } else {
      const bare = rest.match(/\b(19\d{2}|20\d{2})\b/);
      if (!bare) return null;
      year = bare[0];
      name = rest.replace(bare[0], '').trim();
    }
  } else {
    return null;
  }

  type = type.toLowerCase();
  if (type !== 'movie' && type !== 'series') return null;
  const yearNum = parseInt(year, 10);
  if (!name || !Number.isFinite(yearNum)) return null;

  return { title: name, type, year: yearNum };
}

function parseResponse(text) {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('[type]') && !/^type\|name\|year$/i.test(l));

  const items = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const key = `${parsed.type}:${parsed.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...parsed, rank: items.length + 1 });
  }
  return items;
}

async function runSearch(query) {
  const prompt = buildPrompt(query);

  // openrouter/free picks a random free model per call. A bad draw (wrong
  // format, or a reasoning model that ate its budget without answering) is
  // not proof the query has no answer — a second draw is often clean, so
  // reroll once before giving up.
  const MAX_DRAWS = 3;
  let items = [];
  let lastRaw = '';
  for (let draw = 1; draw <= MAX_DRAWS && !items.length; draw++) {
    lastRaw = await openrouter.generateText(prompt);
    items = parseResponse(lastRaw);
    if (!items.length && draw < MAX_DRAWS) {
      console.warn(`[search] draw ${draw} unparseable for "${query}", retrying with a fresh model draw`);
    }
  }

  if (!items.length) {
    // Thrown, not returned: cache.js only caches a producer that resolves,
    // so this keeps the failure from being remembered as a 6h-long "no
    // results" for a query the AI can plainly answer on another draw.
    throw new Error(`AI returned no parseable results after ${MAX_DRAWS} draws (raw: ${JSON.stringify(lastRaw.slice(0, 200))})`);
  }

  // No providerId — this is a general search, not scoped to one platform.
  const resolved = await tmdb.resolveMany(items);
  console.log(`[search] "${query}": ${items.length} AI candidates -> ${resolved.length} resolved`);

  if (!resolved.length) {
    throw new Error(`AI candidates found but none resolved to an imdb_id (${items.length} candidates)`);
  }

  return resolved;
}

function toMeta(item, prefix) {
  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: [prefix, item.description].filter(Boolean).join('\n\n') || undefined,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

/**
 * @param {string} query
 * @param {'movie'|'series'} type
 * @returns {Promise<{metas: Array}>}
 */
async function search(query, type) {
  const q = normalizeQuery(query);
  if (!q) return { metas: [] };

  const results = await cache.get(`search:${q}`, config.TTL.aiSearch, () => runSearch(q));
  const metas = results.filter(it => it.type === type).map(it => toMeta(it));
  return { metas };
}

/**
 * Same AI pipeline as search(), but only titles actually available on one of
 * the 5 tracked platforms make it through. Where search() answers "what is
 * this", recommend() answers "what can I actually watch on my platforms".
 *
 * Checked via tmdb.getWatchProviderIds — one cached TMDB call per title,
 * matched locally against every platform's provider id.
 */
async function runRecommend(query) {
  const resolved = await runSearch(query);

  const tagged = await Promise.all(
    resolved.map(async item => {
      const ids = await tmdb.getWatchProviderIds(item.type, item.tmdb_id);
      const platforms = Object.values(PLATFORMS)
        .filter(p => ids.includes(Number(p.providerId)))
        .map(p => p.name);
      return { ...item, platforms };
    })
  );

  const onPlatform = tagged.filter(it => it.platforms.length > 0);
  console.log(`[recommend] "${query}": ${resolved.length} candidates -> ${onPlatform.length} on a tracked platform`);

  if (!onPlatform.length) {
    // Same reasoning as runSearch: don't let a filtered-to-nothing result
    // freeze the cache for 6h when a re-ask might land on titles that ARE
    // on one of the platforms.
    throw new Error(`AI found ${resolved.length} candidates but none are on a tracked platform`);
  }

  return onPlatform;
}

/**
 * @param {string} query
 * @param {'movie'|'series'} type
 * @returns {Promise<{metas: Array}>}
 */
async function recommend(query, type) {
  const q = normalizeQuery(query);
  if (!q) return { metas: [] };

  const results = await cache.get(`recommend:${q}`, config.TTL.aiSearch, () => runRecommend(q));
  const metas = results
    .filter(it => it.type === type)
    .map(it => toMeta(it, `Available on: ${it.platforms.join(', ')}`));

  return { metas };
}

module.exports = { search, recommend, buildPrompt, parseResponse, NUM_RESULTS };
