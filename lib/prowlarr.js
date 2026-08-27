'use strict';

/**
 * Prowlarr search — the release source for the stream handler.
 *
 * Prowlarr aggregates the user's configured indexers behind one API, so this
 * addon never talks to a tracker directly and never holds tracker
 * credentials; Prowlarr's own API key is the only secret here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { parseTorrent } = require('./bencode');

// A .torrent file is immutable — its infoHash is a hash of its own contents,
// so a given release's file can never legitimately change. Prowlarr
// serializes downloads server-side (~2-8s each, and parallelism does not
// help), which makes that fetch the dominant cost of a stream request.
// Caching the files on disk means a title is slow once, ever: reopening it,
// or playing the next episode out of an already-fetched season pack, needs
// no tracker round trip at all.
const TORRENT_DIR = path.join(__dirname, '..', 'data', 'torrents');

/**
 * Keyed on `guid`, NOT `downloadUrl`. Prowlarr re-encrypts the `link=` blob
 * in downloadUrl on every search, so the same release yields a different URL
 * each time — using it as the key silently never hit, and every request
 * re-fetched. guid is the tracker's own stable identifier for the release.
 * Hashed rather than stored raw: on some trackers the guid embeds a passkey.
 */
function cachePath(release) {
  const key = release.guid || release.downloadUrl;
  return path.join(TORRENT_DIR, crypto.createHash('sha1').update(String(key)).digest('hex') + '.torrent');
}

// Torrent files are small (~30KB) but the cache only ever grows, and this
// runs on a 1GB box. Drop the least recently used ones past a generous cap.
const MAX_CACHED_TORRENTS = 4000;
let writesSincePrune = 0;

function pruneCache() {
  if (++writesSincePrune < 200) return; // amortise: this stats every file
  writesSincePrune = 0;

  let entries;
  try {
    entries = fs.readdirSync(TORRENT_DIR)
      .filter(f => f.endsWith('.torrent'))
      .map(f => {
        const full = path.join(TORRENT_DIR, f);
        return { full, atime: fs.statSync(full).atimeMs };
      });
  } catch {
    return;
  }
  if (entries.length <= MAX_CACHED_TORRENTS) return;

  entries.sort((a, b) => a.atime - b.atime);
  const drop = entries.slice(0, entries.length - MAX_CACHED_TORRENTS);
  for (const e of drop) {
    try { fs.unlinkSync(e.full); } catch { /* already gone */ }
  }
  console.log(`[prowlarr] pruned ${drop.length} cached torrents`);
}

function apiUrl(path, params = {}) {
  const url = new URL(config.PROWLARR_URL.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

async function prowlarrGet(path, params) {
  if (!config.PROWLARR_API_KEY) throw new Error('PROWLARR_API_KEY is not set');
  const res = await fetch(apiUrl(path, params), {
    headers: { 'X-Api-Key': config.PROWLARR_API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(config.PROWLARR_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`prowlarr ${path} -> ${res.status}`);
  return res.json();
}

// Newznab-style category roots: 2000 = Movies, 5000 = TV.
const CATEGORY = { movie: 2000, series: 5000 };

// Indexers tagged "slow-skip" in Prowlarr (e.g. Internet Archive ~16s avg,
// The Pirate Bay ~7s avg — both measured live, both dwarfing the other
// indexers' sub-1.3s average) are excluded from every search by id, so one
// slow/unreliable indexer can't hold up the whole request. Resolved once
// and cached — an extra Prowlarr round trip per search isn't worth it for
// a list that only changes when someone edits tags in the UI.
// Prowlarr's search API takes an include-list (indexerIds), not an
// exclude-list, so "skip these" is implemented as "search everything else".
const SKIP_TAG_NAME = 'slow-skip';
const SEARCH_IDS_TTL_MS = 60 * 60 * 1000;
let searchIdsCache = { ids: null, at: 0 };

async function getSearchIndexerIds() {
  if (searchIdsCache.ids && Date.now() - searchIdsCache.at < SEARCH_IDS_TTL_MS) return searchIdsCache.ids;
  try {
    const [tags, indexers] = await Promise.all([
      prowlarrGet('/api/v1/tag'),
      prowlarrGet('/api/v1/indexer')
    ]);
    const tag = (tags || []).find(t => t.label === SKIP_TAG_NAME);
    const skipIds = new Set(tag ? indexers.filter(i => (i.tags || []).includes(tag.id)).map(i => i.id) : []);
    const ids = indexers.filter(i => i.enable && !skipIds.has(i.id)).map(i => i.id);
    searchIdsCache = { ids, at: Date.now() };
    return ids;
  } catch (err) {
    console.warn(`[prowlarr] could not resolve "${SKIP_TAG_NAME}" tag: ${err.message}`);
    return searchIdsCache.ids || [];
  }
}

/**
 * Build the query string to send to the trackers.
 *
 * Release names are scene-formatted ("Playground.(2026).S05E27.1080p.WEB-DL
 * ...") but trackers index them well enough that a plain title matches for
 * films. For episodes the bare title returns the whole show (every season,
 * every episode), so the SxxExx token is required to narrow it — and a
 * separate season-pack query is worth running too, since one S05 pack often
 * covers the episode being asked for.
 *
 * @returns {string[]} queries to run, most specific first
 */
function buildQueries(title, type, season, episode) {
  const clean = title.replace(/[:''`""]/g, '').replace(/\s+/g, ' ').trim();
  if (type !== 'series' || season == null || episode == null) return [clean];

  const pad = n => String(n).padStart(2, '0');
  return [
    `${clean} S${pad(season)}E${pad(episode)}`, // the episode itself
    `${clean} S${pad(season)}`                  // season packs that contain it
  ];
}

function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this release actually belong to the title we asked for?
 *
 * Trackers match loosely — a search for "Perfect Family" comes back with
 * "Perfect.Crown.S01E08" among the results (confirmed live). Handing those
 * to Stremio would offer the wrong show's episodes on a title page, so the
 * release name has to contain the requested title as a contiguous phrase.
 */
function matchesTitle(releaseTitle, title) {
  return normalizeName(releaseTitle).includes(normalizeName(title));
}

/**
 * For series, confirm the release covers the episode being requested.
 * A release naming a specific episode must name THIS one; a season-only
 * release (a pack) must name this season. Anything with no marker at all is
 * not usable for an episode request.
 */
function matchesEpisode(releaseTitle, season, episode) {
  if (season == null || episode == null) return true;

  const ep = /\bs(\d{1,2})[. _]?e(\d{1,3})\b/i.exec(releaseTitle);
  if (ep) return Number(ep[1]) === season && Number(ep[2]) === episode;

  const se = /\bs(\d{1,2})\b|\bseason[. _]?(\d{1,2})\b/i.exec(releaseTitle);
  if (se) return Number(se[1] || se[2]) === season;

  return false;
}

/**
 * @returns {Promise<Array>} raw Prowlarr release records
 */
async function search(title, type, season, episode) {
  const queries = buildQueries(title, type, season, episode);
  const seen = new Set();
  const out = [];
  let rejected = 0;

  const indexerIds = await getSearchIndexerIds();

  // Episode + season-pack queries are independent; running them in sequence
  // doubled series search time (8.2s vs 4.1s measured) for no reason.
  const batches = await Promise.all(queries.map(async query => {
    try {
      return await prowlarrGet('/api/v1/search', {
        query,
        categories: CATEGORY[type] || CATEGORY.movie,
        type: 'search',
        limit: config.PROWLARR_LIMIT,
        indexerIds
      });
    } catch (err) {
      console.warn(`[prowlarr] "${query}" failed: ${err.message}`);
      return [];
    }
  }));

  for (const results of batches) {
    for (const r of results || []) {
      const key = r.guid || r.downloadUrl || r.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      if (!matchesTitle(r.title, title) || !matchesEpisode(r.title, season, episode)) {
        rejected++;
        continue;
      }
      out.push(r);
    }
  }

  if (rejected) console.log(`[prowlarr] "${title}": ${out.length} kept, ${rejected} off-title/off-episode`);
  return out;
}

/**
 * Fetch and parse the actual .torrent behind a release.
 *
 * Every configured indexer is private and hands out torrent files rather
 * than magnets, so infoHash / file index / tracker list / passkey presence
 * all have to be read from the file. Downloads go through Prowlarr's own
 * proxy endpoint, so tracker credentials stay inside Prowlarr.
 *
 * @returns {Promise<object|null>} parsed torrent, or null if unusable
 */
async function fetchTorrent(release) {
  if (!release.downloadUrl) return null;

  const file = cachePath(release);
  try {
    return parseTorrent(fs.readFileSync(file));
  } catch { /* not cached yet, or unreadable — fetch it */ }

  try {
    const res = await fetch(release.downloadUrl, {
      signal: AbortSignal.timeout(config.PROWLARR_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] !== 0x64) throw new Error('not a bencoded torrent'); // 'd'

    const parsed = parseTorrent(buf); // parse before caching, so bad files are not stored
    try {
      fs.mkdirSync(TORRENT_DIR, { recursive: true });
      fs.writeFileSync(file, buf);
      pruneCache();
    } catch (err) {
      console.warn(`[prowlarr] could not cache torrent: ${err.message}`);
    }
    return parsed;
  } catch (err) {
    console.warn(`[prowlarr] torrent fetch failed for "${release.title}": ${err.message}`);
    return null;
  }
}

module.exports = { search, fetchTorrent, buildQueries, matchesTitle, matchesEpisode, cachePath };
