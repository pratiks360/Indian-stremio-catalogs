'use strict';

/**
 * "VPS/Drive Downloaded": titles already downloaded via the local-seed
 * feature and moved onto the Google Drive mount, so they can be browsed
 * and replayed without re-searching. Structurally mirrors debrid_catalog.js
 * — same TMDB-resolution reuse, same cache-then-map-to-metas shape.
 *
 * Lists both status:'mounted' (on the Google Drive mount) and status:'local'
 * (still downloading/seeding on the VPS) sidecar entries — both are already
 * playable via the same /local/resolve/:payload path (lib/localseed.js's
 * streamRelease() serves a 'local' file by streaming pieces as they arrive,
 * the same mechanism the "Downloading Now" activity view relies on). An
 * entry that gets evicted or deleted (lib/localseed.js's sweepEviction(),
 * deleteActive(), deleteMounted()) simply stops appearing on the next read
 * — no separate eviction-tracking needed here. The cache backing this catalog
 * is invalidated by lib/localseed.js itself the moment any of that happens
 * (see invalidateCatalogCache()), so this shows up-to-date without waiting
 * out the TTL below.
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

  const entries = localseedState.list(STATE_PATH).filter(e => e.status === 'mounted' || e.status === 'local');

  const items = [];
  for (const entry of entries) {
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
      releaseTitle: raw,
      status: entry.status
    });
  }

  // One sidecar entry per (infoHash, fileIdx) now (see lib/localseed.js's
  // stateKey) — a season pack with several mounted/local episodes resolves
  // to the same imdb_id+type multiple times. Collapse to one card, keeping
  // whichever episode was played most recently.
  const dedup = new Map();
  for (const item of items) {
    const key = `${item.type}:${item.imdb_id}`;
    const existing = dedup.get(key);
    if (!existing || item.lastPlayed > existing.lastPlayed) dedup.set(key, item);
  }
  const deduped = [...dedup.values()];

  console.log(`[localseed-catalog] ${deduped.length}/${entries.length} local-seed downloads resolved`);
  return { items: deduped, at: Date.now() };
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
    description: item.status === 'mounted'
      ? `Downloaded on your VPS, ready to play instantly from Google Drive.\n\n${item.releaseTitle}`
      : `Still downloading on your VPS — playable now, streams as it comes in.\n\n${item.releaseTitle}`,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

module.exports = { getCatalog, build };
