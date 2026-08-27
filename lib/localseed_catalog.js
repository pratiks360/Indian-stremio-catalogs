'use strict';

/**
 * "VPS/Drive Downloaded": titles already downloaded via the local-seed
 * feature and moved onto the Google Drive mount, so they can be browsed
 * and replayed without re-searching. Structurally mirrors debrid_catalog.js
 * — same TMDB-resolution reuse, same cache-then-map-to-metas shape.
 *
 * Only status:'mounted' sidecar entries are listed (not still-downloading
 * ones — those aren't yet reliably instant-replayable), and an entry that
 * gets evicted (sweepEviction() in lib/localseed.js removes it from the
 * sidecar) simply stops appearing on the next read — no separate
 * eviction-tracking needed here.
 */

const path = require('path');
const config = require('../config');
const cache = require('../cache');
const tmdb = require('../tmdb');
const localseedState = require('./localseed_state');
const localseed = require('./localseed');
const { cleanReleaseName, looksLikeSeries, extractYear } = require('../debrid_catalog');

// lib/localseed_catalog.js lives in lib/, but data/ is at the repo root —
// same '..' walk lib/localseed.js's own STATE_PATH already uses.
const STATE_PATH = path.join(__dirname, '..', 'data', 'localseed_meta.json');

async function build() {
  if (!localseed.isEnabled()) return { items: [], at: Date.now() };

  const mounted = localseedState.list(STATE_PATH).filter(e => e.status === 'mounted');

  const items = [];
  for (const entry of mounted) {
    const raw = entry.releaseTitle || '';
    const title = cleanReleaseName(raw);
    if (!title) continue;

    const type = looksLikeSeries(raw) ? 'series' : 'movie';

    let resolved;
    try {
      resolved = await tmdb.resolve({ title, type, year: extractYear(raw) });
    } catch (err) {
      console.warn(`[localseed-catalog] TMDB resolve failed for "${title}": ${err.message}`);
      continue;
    }
    if (!resolved || !resolved.imdb_id) {
      console.log(`[localseed-catalog] unresolved: "${raw.slice(0, 60)}" -> "${title}"`);
      continue;
    }

    items.push({
      ...resolved,
      type,
      lastPlayed: entry.lastPlayed || 0,
      releaseTitle: raw
    });
  }

  console.log(`[localseed-catalog] ${items.length}/${mounted.length} mounted downloads resolved`);
  return { items, at: Date.now() };
}

/** @returns {Promise<{metas:Array, origin:string}>} */
async function getCatalog(type) {
  if (!localseed.isEnabled()) return { metas: [], origin: 'unconfigured' };

  const payload = await cache.get('catalog:localseed', config.TTL.rdTorrents, build);

  const metas = payload.items
    .filter(it => !type || it.type === type)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, config.MAX_ITEMS)
    .map(toMeta);

  return { metas, origin: 'localseed' };
}

function toMeta(item) {
  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: `Downloaded on your VPS, ready to play instantly from Google Drive.\n\n${item.releaseTitle}`,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

module.exports = { getCatalog, build };
