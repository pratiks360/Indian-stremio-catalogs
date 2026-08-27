'use strict';

/**
 * Centralized activity/debug logger — line-delimited JSON in data/activity.log.
 *
 * Never throws: every public method is wrapped so a logging failure (disk
 * full, permission error) cannot take down the real request being served.
 * See docs/superpowers/specs/2026-08-26-activity-log-design.md.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'data', 'activity.log');
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS_PER_TAB = 100;

function appendLine(obj) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.appendFileSync(STORE_PATH, JSON.stringify(obj) + '\n');
  } catch (err) {
    console.warn(`[activity] write failed: ${err.message}`);
  }
}

function record(type, fields) {
  try {
    appendLine({ type, timestamp: new Date().toISOString(), ...fields });
  } catch (err) {
    console.warn(`[activity] record failed: ${err.message}`);
  }
}

function streamSearch({ imdbId, title, searchType, prowlarrQuery, releaseCount, releases, success }) {
  record('stream_search', { imdbId, title, searchType, prowlarrQuery, releaseCount, releases, success });
}

function userClick({ imdbId, releaseTitle, indexer, infoHash, deliveryPath }) {
  record('user_click', { imdbId, releaseTitle, indexer, infoHash, deliveryPath });
}

function torrentFetch({ releaseTitle, indexer, success, errorMsg, duration_ms }) {
  record('torrent_fetch', { releaseTitle, indexer, success, errorMsg, duration_ms });
}

function catalogRefresh({ platform, itemsAdded, duration_ms }) {
  record('catalog_refresh', { platform, itemsAdded, duration_ms });
}

function rdAction({ action, torrentHash, success, status, duration_ms }) {
  record('rd_action', { action, torrentHash, success, status, duration_ms });
}

function localSeed({ infoHash, releaseTitle, phase, success, errorMsg, duration_ms }) {
  record('local_seed', { infoHash, releaseTitle, phase, success, errorMsg, duration_ms });
}

/**
 * @returns {{stream_search:Array, user_click:Array, torrent_fetch:Array, catalog_refresh:Array, rd_action:Array, local_seed:Array}}
 * Latest MAX_ROWS_PER_TAB per type, newest first. Malformed lines skipped.
 */
function readAll() {
  const buckets = {
    stream_search: [], user_click: [], torrent_fetch: [], catalog_refresh: [], rd_action: [], local_seed: []
  };

  let text;
  try {
    text = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    return buckets;
  }

  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const bucket = buckets[entry.type];
    if (!bucket || bucket.length >= MAX_ROWS_PER_TAB) continue;
    bucket.push(entry);
  }

  return buckets;
}

/** Drop entries older than 7 days. Best-effort: leaves the file untouched on failure. */
function rotate() {
  try {
    const text = fs.readFileSync(STORE_PATH, 'utf8');
    const cutoff = Date.now() - RETENTION_MS;
    const kept = text.split('\n').filter(Boolean).filter(line => {
      try {
        const entry = JSON.parse(line);
        return new Date(entry.timestamp).getTime() >= cutoff;
      } catch {
        return false;
      }
    });
    fs.writeFileSync(STORE_PATH, kept.length ? kept.join('\n') + '\n' : '');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[activity] rotate failed: ${err.message}`);
  }
}

module.exports = { streamSearch, userClick, torrentFetch, catalogRefresh, rdAction, localSeed, readAll, rotate };
