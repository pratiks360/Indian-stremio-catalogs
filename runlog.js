'use strict';

/**
 * Run log with different strategies per catalog type:
 * - Trending: delta-only (snapshot per refresh, log only new titles each day)
 * - Movies/Shows: accumulated forever (never remove, only append new ones)
 * - Marathi Latest: accumulated forever
 *
 * `record()` is called from catalog.js's build functions (24h TTL refreshes).
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'data', 'runlog.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {
      accumulated: {}, // catalogKey -> Set of imdb_ids (for movies/shows/marathi)
      trending: {},    // catalogKey -> Set of imdb_ids (for trending, previous snapshot)
      log: []          // historical entries
    };
  }
}

function save(state) {
  // Convert Sets back to arrays for JSON
  const out = {
    accumulated: {},
    trending: {},
    log: state.log
  };
  for (const [k, v] of Object.entries(state.accumulated)) {
    out.accumulated[k] = Array.from(v);
  }
  for (const [k, v] of Object.entries(state.trending)) {
    out.trending[k] = Array.from(v);
  }
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(out));
}

function load_and_hydrate() {
  const data = load();
  // Hydrate Sets
  const state = { ...data, accumulated: {}, trending: {} };
  for (const [k, v] of Object.entries(data.accumulated || {})) {
    state.accumulated[k] = new Set(v);
  }
  for (const [k, v] of Object.entries(data.trending || {})) {
    state.trending[k] = new Set(v);
  }
  return state;
}

/**
 * @param {string} catalogKey e.g. `platform:netflix`, `lang:marathi-latest`
 * @param {Array} items hydrated items just built (must carry imdb_id/name/type/year)
 * @param {boolean} isTrending true for trending, false for movie/series/marathi
 *
 * Never throws — this is a logging side-feature, not part of the catalog
 * pipeline. A bug here must not take down real catalog serving (it did once:
 * an uncaught error in this function bubbled up through build() and emptied
 * jiohotstar/sonyliv/marathi-latest until fixed).
 */
function record(catalogKey, items, isTrending = false) {
  try {
    recordUnsafe(catalogKey, items, isTrending);
  } catch (err) {
    console.error(`[runlog] record failed for "${catalogKey}": ${err.message}`);
  }
}

function recordUnsafe(catalogKey, items, isTrending) {
  const state = load_and_hydrate();
  const currIds = items.map(it => it.imdb_id).filter(Boolean);

  if (isTrending) {
    // Trending: delta only (compare against previous snapshot)
    const prevIds = state.trending[catalogKey] || new Set();
    const added = items.filter(it => it.imdb_id && !prevIds.has(it.imdb_id));
    state.trending[catalogKey] = new Set(currIds);

    if (added.length) {
      state.log.unshift({
        at: new Date().toISOString(),
        catalog: catalogKey,
        type: 'trending',
        added: added.map(it => ({ id: it.imdb_id, name: it.name, type: it.type, year: it.year }))
      });
    }
  } else {
    // Movies/Shows/Marathi: accumulate forever
    const prevIds = state.accumulated[catalogKey] || new Set();
    const added = items.filter(it => it.imdb_id && !prevIds.has(it.imdb_id));
    state.accumulated[catalogKey] = prevIds;
    for (const id of currIds) state.accumulated[catalogKey].add(id);

    if (added.length) {
      state.log.unshift({
        at: new Date().toISOString(),
        catalog: catalogKey,
        type: 'accumulated',
        added: added.map(it => ({ id: it.imdb_id, name: it.name, type: it.type, year: it.year }))
      });
    }
  }

  state.log = state.log.slice(0, 500);
  save(state);
}

/** @param {number} [limit] most recent N entries; omit for everything kept */
function getLog(limit) {
  const state = load();
  return limit ? state.log.slice(0, limit) : state.log;
}

module.exports = { record, getLog, load_and_hydrate };
