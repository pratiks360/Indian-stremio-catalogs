'use strict';

/**
 * Real-Debrid client.
 *
 * IMPORTANT — /torrents/instantAvailability is GONE. It now answers
 * {"error":"disabled_endpoint","error_code":37} with HTTP 403 for every hash
 * (verified live). There is therefore NO way to ask RD "is this cached?"
 * before committing to it. Every other debrid integration that pre-filters
 * results by cache status was written against that dead endpoint; do not try
 * to reinstate it.
 *
 * What replaces it, in order of cost:
 *   1. listTorrents() — the user's OWN account. If the infoHash is already
 *      there with status "downloaded", playback is instant. This is the only
 *      reliable cache signal left, and it is what makes repeat plays and the
 *      "Debrid Cached" catalog work.
 *   2. addTorrent() + poll — commits the torrent, then waits briefly. If RD
 *      had it server-side it flips to "downloaded" almost at once; otherwise
 *      it is genuinely downloading and will not be playable this request.
 */

const config = require('../config');

const BASE = 'https://api.real-debrid.com/rest/1.0';

function authHeaders(extra) {
  if (!config.REALDEBRID_TOKEN) throw new Error('REALDEBRID_TOKEN is not set');
  return { authorization: `Bearer ${config.REALDEBRID_TOKEN}`, ...extra };
}

async function rd(path, { method = 'GET', body, headers, timeoutMs = 20000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: authHeaders(headers),
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const detail = (json && (json.error || json.message)) || text.slice(0, 160);
    const err = new Error(`RD ${method} ${path} -> ${res.status}: ${detail}`);
    err.status = res.status;
    err.rdError = json && json.error;
    throw err;
  }
  return json;
}

/** @returns {Promise<Array>} the account's torrents, newest first */
async function listTorrents(limit = 100) {
  return (await rd(`/torrents?limit=${limit}`)) || [];
}

/**
 * Upload a .torrent file. Used instead of addMagnet because every configured
 * indexer serves torrent files rather than magnet links.
 * @returns {Promise<string>} RD torrent id
 */
async function addTorrentFile(buf) {
  const out = await rd('/torrents/addTorrent', {
    method: 'PUT',
    body: buf,
    headers: { 'content-type': 'application/x-bittorrent' },
    timeoutMs: 30000
  });
  return out.id;
}

/**
 * A torrent sits in "waiting_files_selection" until files are chosen; nothing
 * downloads and no links appear before this.
 */
async function selectFiles(id, fileIds = 'all') {
  const body = new URLSearchParams({ files: String(fileIds) });
  await rd(`/torrents/selectFiles/${id}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
}

async function torrentInfo(id) {
  return rd(`/torrents/info/${id}`);
}

async function deleteTorrent(id) {
  return rd(`/torrents/${id}`, { method: 'DELETE' });
}

/** Turn an RD-hosted link into a directly playable URL. */
async function unrestrict(link) {
  const body = new URLSearchParams({ link });
  const out = await rd('/unrestrict/link', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  return out.download;
}

/**
 * Wait for a torrent to become playable.
 *
 * A torrent RD already holds server-side flips to "downloaded" within a
 * second or two. One that is genuinely fetching will not finish inside any
 * timeout Stremio is prepared to wait through, so this gives up quickly and
 * lets the caller report back rather than hanging the player. The download
 * keeps running in RD either way and shows up in the Debrid Cached catalog
 * once it lands.
 *
 * @returns {Promise<object|null>} torrent info once downloaded, else null
 */
async function waitForDownloaded(id, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let delay = 500;

  while (Date.now() < deadline) {
    const info = await torrentInfo(id);
    if (info.status === 'downloaded') return info;
    if (['error', 'magnet_error', 'virus', 'dead'].includes(info.status)) {
      throw new Error(`RD torrent status: ${info.status}`);
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }
  return null;
}

/** Find an already-present torrent by infoHash (RD reports it uppercase-ish). */
function findByHash(torrents, infoHash) {
  const want = String(infoHash).toLowerCase();
  return torrents.find(t => String(t.hash || '').toLowerCase() === want) || null;
}

module.exports = {
  listTorrents,
  addTorrentFile,
  selectFiles,
  torrentInfo,
  deleteTorrent,
  unrestrict,
  waitForDownloaded,
  findByHash
};
