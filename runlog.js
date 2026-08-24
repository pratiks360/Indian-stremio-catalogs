'use strict';

/**
 * Daily run log: for each catalog key, diffs the freshly-built item set
 * against the previous snapshot and records only the titles newly added.
 * `record()` is called from catalog.js's build functions, which only run on
 * a real refresh (cache TTL expiry) — not per HTTP request — so at the
 * current 24h TTL this is naturally one entry per catalog per day.
 *
 * First-ever run for a catalog key has no previous snapshot, so everything
 * in it logs as "added" — that's correct (delta from nothing), just noisy
 * once, on day one.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'data', 'runlog.json');
const MAX_LOG_ENTRIES = 500;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { snapshots: {}, log: [] };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state));
}

/**
 * @param {string} catalogKey stable id, e.g. `platform:netflix` or `lang:marathi-latest`
 * @param {Array} items hydrated items just built (must carry imdb_id/name/type/year)
 */
function record(catalogKey, items) {
  const state = load();
  const prevIds = new Set(state.snapshots[catalogKey] || []);
  const currIds = items.map(it => it.imdb_id).filter(Boolean);

  const added = items.filter(it => it.imdb_id && !prevIds.has(it.imdb_id));

  state.snapshots[catalogKey] = currIds;

  if (added.length) {
    state.log.unshift({
      at: new Date().toISOString(),
      catalog: catalogKey,
      added: added.map(it => ({ id: it.imdb_id, name: it.name, type: it.type, year: it.year }))
    });
    state.log = state.log.slice(0, MAX_LOG_ENTRIES);
  }

  save(state);
}

/** @param {number} [limit] most recent N entries; omit for everything kept */
function getLog(limit) {
  const state = load();
  return limit ? state.log.slice(0, limit) : state.log;
}

module.exports = { record, getLog };
