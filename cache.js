'use strict';

/**
 * In-memory TTL cache with single-flight refresh.
 *
 * Rules this enforces:
 *  - A catalog request NEVER triggers a blocking upstream fetch if we already
 *    hold a value. Stale data is served while a refresh runs in the background.
 *  - Concurrent misses for the same key collapse into one upstream call.
 *  - A failed refresh keeps the last good value (with its lastError recorded)
 *    instead of blowing away the cache.
 */

const store = new Map(); // key -> { value, fetchedAt, ttl, inflight, lastError }

function now() { return Date.now(); }

/**
 * @param {string} key
 * @param {number} ttl  milliseconds
 * @param {() => Promise<any>} producer
 * @returns {Promise<any>}
 */
async function get(key, ttl, producer) {
  let entry = store.get(key);

  if (!entry) {
    entry = { value: undefined, fetchedAt: 0, ttl, inflight: null, lastError: null };
    store.set(key, entry);
  }
  entry.ttl = ttl;

  const fresh = entry.value !== undefined && (now() - entry.fetchedAt) < entry.ttl;
  if (fresh) return entry.value;

  // Stale but usable: kick off a background refresh, serve what we have.
  if (entry.value !== undefined) {
    if (!entry.inflight) {
      entry.inflight = refresh(key, entry, producer).catch(() => {});
    }
    return entry.value;
  }

  // Cold: must wait, but only one caller actually fetches.
  if (!entry.inflight) {
    entry.inflight = refresh(key, entry, producer);
  }
  return entry.inflight;
}

async function refresh(key, entry, producer) {
  try {
    const value = await producer();
    entry.value = value;
    entry.fetchedAt = now();
    entry.lastError = null;
    console.log(`[cache] refreshed "${key}" (${Array.isArray(value) ? value.length + ' items' : 'ok'})`);
    return value;
  } catch (err) {
    entry.lastError = err;
    console.error(`[cache] refresh failed for "${key}": ${err.message}`);
    if (entry.value !== undefined) return entry.value; // keep last good
    throw err;
  } finally {
    entry.inflight = null;
  }
}

/** Prime a key at boot so the first user request is instant. */
async function warm(key, ttl, producer) {
  try {
    await get(key, ttl, producer);
  } catch (err) {
    console.error(`[cache] warm failed for "${key}": ${err.message}`);
  }
}

function peek(key) {
  const e = store.get(key);
  if (!e) return null;
  return {
    hasValue: e.value !== undefined,
    ageMs: e.fetchedAt ? now() - e.fetchedAt : null,
    ttlMs: e.ttl,
    lastError: e.lastError ? e.lastError.message : null
  };
}

function stats() {
  const out = {};
  for (const key of store.keys()) out[key] = peek(key);
  return out;
}

function clear(key) {
  if (key) store.delete(key);
  else store.clear();
}

module.exports = { get, warm, peek, stats, clear };
