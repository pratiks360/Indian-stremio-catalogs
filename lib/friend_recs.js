'use strict';

/**
 * "Friend Recommendations" catalog source. /activity has a textarea where
 * titles/IMDb ids pasted in get resolved once (at add-time, not per catalog
 * request) and stored here; friend_catalog.js just reads the store straight
 * through, same cheap shape as debrid_catalog.js/localseed_catalog.js's
 * output but with no TTL — nothing to re-check, a manually curated list only
 * changes when someone pastes more.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const tmdb = require('../tmdb');

const STORE_PATH = path.join(__dirname, '..', 'data', 'friend_recs.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function save(items) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(items));
}

function list() {
  return load();
}

function remove(imdbId, type) {
  const items = load().filter(it => !(it.imdb_id === imdbId && it.type === type));
  save(items);
}

function toItem(hit, type, imdbId) {
  const date = hit.release_date || hit.first_air_date || '';
  return {
    imdb_id: imdbId,
    type,
    name: hit.title || hit.name || imdbId,
    poster: hit.poster_path ? config.TMDB_IMAGE_BASE + hit.poster_path : undefined,
    year: date ? Number(date.slice(0, 4)) : null,
    addedAt: Date.now()
  };
}

/** A bare "tt1234567" line — exact lookup, no fuzzy matching needed. */
async function resolveByImdbId(imdbId) {
  const found = await tmdb.tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const movie = (found.movie_results || [])[0];
  const tv = (found.tv_results || [])[0];
  if (movie) return toItem(movie, 'movie', imdbId);
  if (tv) return toItem(tv, 'series', imdbId);
  return null;
}

/**
 * A free-text title line — /search/multi so the caller doesn't have to say
 * movie or series, then one more call for the imdb_id TMDB itself doesn't
 * return inline.
 */
async function resolveByTitle(title) {
  const data = await tmdb.tmdbGet('/search/multi', { query: title });
  const hit = (data.results || []).find(r => r.media_type === 'movie' || r.media_type === 'tv');
  if (!hit) return null;

  const type = hit.media_type === 'tv' ? 'series' : 'movie';
  const ext = await tmdb.tmdbGet(`/${hit.media_type}/${hit.id}/external_ids`);
  if (!ext.imdb_id) return null;

  return toItem(hit, type, ext.imdb_id);
}

const IMDB_ID_RE = /^tt\d{6,9}$/i;
// Pulls the id out of a pasted IMDb URL, any of its common shapes:
// imdb.com/title/tt1234567, /title/tt1234567/, ?ref_= query junk after it,
// with or without www./https://.
const IMDB_URL_RE = /imdb\.com\/title\/(tt\d{6,9})/i;

/** "tt1234567", a bare id already lowercase/trimmed, or null if not one. */
function extractImdbId(line) {
  if (IMDB_ID_RE.test(line)) return line.toLowerCase();
  const m = IMDB_URL_RE.exec(line);
  return m ? m[1].toLowerCase() : null;
}

/**
 * @param {string} rawText textarea contents — one title or IMDb id per line
 * @returns {Promise<{added:Array, skipped:Array<{line:string, reason:string}>}>}
 */
async function addLines(rawText) {
  const lines = [...new Set(
    String(rawText || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
  )];

  const items = load();
  const existing = new Set(items.map(it => `${it.type}:${it.imdb_id}`));
  const added = [];
  const skipped = [];

  for (const line of lines) {
    try {
      const imdbId = extractImdbId(line);
      const resolved = imdbId
        ? await resolveByImdbId(imdbId)
        : await resolveByTitle(line);

      if (!resolved) {
        skipped.push({ line, reason: 'no TMDB match' });
        continue;
      }
      const key = `${resolved.type}:${resolved.imdb_id}`;
      if (existing.has(key)) {
        skipped.push({ line, reason: `already on the list (${resolved.name})` });
        continue;
      }
      existing.add(key);
      items.push(resolved);
      added.push(resolved);
    } catch (err) {
      skipped.push({ line, reason: err.message });
    }
  }

  if (added.length) save(items);
  return { added, skipped };
}

module.exports = { list, remove, addLines };
