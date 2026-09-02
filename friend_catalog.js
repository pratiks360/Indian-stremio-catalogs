'use strict';

/**
 * "Friend Recommendations": titles pasted into /activity's textarea (see
 * lib/friend_recs.js), already TMDB-resolved at add-time — no cache/TTL
 * needed here, this just reads the store and maps to metas.
 */

const config = require('./config');
const friendRecs = require('./lib/friend_recs');

function toMeta(item) {
  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: 'Recommended by a friend.',
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

/** @returns {Promise<{metas:Array, origin:string}>} */
async function getCatalog(type) {
  const items = friendRecs.list()
    .filter(it => it.type === type)
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, config.MAX_ITEMS)
    .map(toMeta);

  return { metas: items, origin: 'friend-recs' };
}

module.exports = { getCatalog };
