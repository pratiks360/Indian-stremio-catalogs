'use strict';

/**
 * VPS-local torrent download/seed + Google Drive mount archive.
 *
 * Offered only for releases RD already skips (hasPasskey — see stream.js).
 * The tracker sees the user's own passkey announcing from this one VPS, the
 * same as any legitimate seedbox — unlike RD, which is a third party and
 * therefore excluded from passkey releases entirely (see .env.example).
 *
 * Downloads always land on local disk first: BitTorrent writes pieces out
 * of order as they arrive from peers, and an rclone mount cannot perform
 * that kind of random-access write against Drive without falling back to
 * caching the whole file locally anyway. Once a download is complete (no
 * longer being written), the file is moved onto the mount — a safe
 * operation, since nothing is reading a file on the mount while it is still
 * being written. See docs/superpowers/specs/2026-08-27-local-seed-design.md.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { pickFileIdx } = require('./bencode');
const prowlarr = require('./prowlarr');
const {
  encodePayload, decodePayload, mountFilename, shouldAdmit, selectEvictionTargets
} = require('./localseed_util');
const state = require('./localseed_state');
const activityLog = require('../activity-log');

const STATE_PATH = path.join(__dirname, '..', 'data', 'localseed_meta.json');

let client = null;
function getClient() {
  if (!client) {
    // Loaded lazily so a box that never enables this feature never even
    // requires the webtorrent package to resolve correctly.
    const WebTorrent = require('webtorrent');
    client = new WebTorrent();
  }
  return client;
}

/** Mount path existing on disk is the sole enable/disable switch — same
 * pattern config.REALDEBRID_TOKEN uses for the RD path. */
function mountReady() {
  try {
    return fs.statSync(config.LOCALSEED.MOUNT_PATH).isDirectory();
  } catch {
    return false;
  }
}

function isEnabled() {
  return mountReady();
}

function mountDir() {
  return path.join(config.LOCALSEED.MOUNT_PATH, config.LOCALSEED.MOUNT_SUBDIR);
}

/** @returns {string|null} absolute path on the mount if this infoHash was already downloaded */
function findOnMount(infoHash) {
  const dir = mountDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = String(infoHash).toLowerCase();
  const hit = entries.find(f => f.toLowerCase().startsWith(prefix));
  return hit ? path.join(dir, hit) : null;
}

function activeCount() {
  return getClient().torrents.length;
}

/** Currently downloading/seeding torrent for this infoHash, if any. */
function findActiveTorrent(infoHash) {
  const want = String(infoHash).toLowerCase();
  return getClient().torrents.find(t => t.infoHash.toLowerCase() === want) || null;
}

function freeBytesOnLocalDisk() {
  try {
    const stats = fs.statfsSync(config.LOCALSEED.LOCAL_DIR);
    return stats.bavail * stats.bsize;
  } catch {
    // LOCAL_DIR may not exist yet on first run — check its parent instead.
    const stats = fs.statfsSync(path.dirname(config.LOCALSEED.LOCAL_DIR));
    return stats.bavail * stats.bsize;
  }
}

/**
 * Serve a release over HTTP, starting/reusing a local WebTorrent download or
 * serving straight off the mount if this infoHash was already downloaded.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{infoHash:string, trackers:string[], title:string}} release
 * @param {number|null} season
 * @param {number|null} episode
 */
async function streamRelease(req, res, release, season, episode) {
  const { infoHash, trackers, title, guid, downloadUrl } = release;

  // 1. Already on the mount from a previous download — serve it directly,
  //    no torrent, no re-download.
  const mounted = findOnMount(infoHash);
  if (mounted) {
    state.touch(STATE_PATH, infoHash, { lastPlayed: Date.now() });
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'serve-from-mount', success: true });
    return serveFileRange(req, res, mounted);
  }

  // 2. Already downloading — reuse it.
  let torrent = findActiveTorrent(infoHash);

  // 3. Neither: admission check, then start a fresh download.
  if (!torrent) {
    const admission = shouldAdmit(
      { activeCount: activeCount(), rssBytes: process.memoryUsage().rss, freeBytes: freeBytesOnLocalDisk() },
      {
        maxConcurrent: config.LOCALSEED.MAX_CONCURRENT,
        rssCeilingBytes: config.LOCALSEED.RSS_CEILING_BYTES,
        minFreeBytes: config.LOCALSEED.MIN_FREE_BYTES
      }
    );
    if (!admission.allow) {
      activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'rejected', success: false, errorMsg: admission.reason });
      res.status(503).type('text/plain').send(`Local seedbox busy: ${admission.reason}`);
      return;
    }

    fs.mkdirSync(config.LOCALSEED.LOCAL_DIR, { recursive: true });
    torrent = await addTorrent({ infoHash, trackers, guid, downloadUrl });
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'download-start', success: true });

    torrent.once('done', () => {
      moveToMount(torrent, infoHash, title).catch(err => {
        activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'move-to-mount', success: false, errorMsg: err.message });
      });
    });
  }

  await waitForFileSelectable(torrent);
  const fileIdx = pickFileIdx(torrent.files.map((f, idx) => ({ idx, length: f.length, path: f.path })), season, episode);
  const file = torrent.files[fileIdx];

  state.touch(STATE_PATH, infoHash, { lastPlayed: Date.now(), status: 'local' });
  streamTorrentFile(req, res, file);
}

/**
 * Adds a torrent to the WebTorrent client using its real .torrent file
 * bytes, not a bare magnet URI. These are private trackers with DHT/PEX
 * disabled (see stream.js's file header) — a magnet has no way to fetch
 * the info dict without them, and would hang forever waiting for metadata
 * that can never arrive. The .torrent file already embeds the full info
 * dict, so handing WebTorrent that buffer skips metadata exchange
 * entirely.
 */
async function addTorrent({ infoHash, trackers, guid, downloadUrl }) {
  const buf = await fetchTorrentBuffer({ guid, downloadUrl });
  if (!buf) throw new Error(`could not obtain .torrent file for ${infoHash}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('WebTorrent add() timed out')); }
    }, 15000);

    getClient().add(buf, { path: config.LOCALSEED.LOCAL_DIR }, torrent => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(torrent);
    });
  });
}

/** Read the .torrent file from Prowlarr's existing disk cache (already
 * fetched during the search that produced this release); re-fetch over
 * HTTP only if the cache entry is somehow gone. */
async function fetchTorrentBuffer({ guid, downloadUrl }) {
  const cachePath = prowlarr.cachePath({ guid, downloadUrl });
  try {
    return fs.readFileSync(cachePath);
  } catch { /* not cached — fetch it */ }

  if (!downloadUrl) return null;
  try {
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(config.PROWLARR_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function waitForFileSelectable(torrent) {
  if (torrent.files && torrent.files.length) return Promise.resolve();
  return new Promise(resolve => torrent.once('ready', resolve));
}

/** Pipe a byte range of a WebTorrent file into the HTTP response — WebTorrent blocks the stream on pieces not yet downloaded, which naturally paces playback to download progress. */
function streamTorrentFile(req, res, file) {
  const range = req.headers.range;
  const total = file.length;
  let start = 0, end = total - 1;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : total - 1;
    }
  }

  res.status(range ? 206 : 200);
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4'
  });
  // Express's res.set stringifies an `undefined` value as the literal text
  // "undefined" rather than omitting the header — only set Content-Range at
  // all when this is actually a partial response.
  if (range) res.set('Content-Range', `bytes ${start}-${end}/${total}`);

  const stream = file.createReadStream({ start, end });
  stream.pipe(res);
  stream.on('error', () => res.end());
}

/** Serve a fully-local (mount or completed local) file by plain fs range read. */
function serveFileRange(req, res, absPath) {
  const stat = fs.statSync(absPath);
  const range = req.headers.range;
  let start = 0, end = stat.size - 1;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : stat.size - 1;
    }
  }

  res.status(range ? 206 : 200);
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4'
  });
  if (range) res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);

  const stream = fs.createReadStream(absPath, { start, end });
  stream.pipe(res);
  stream.on('error', () => res.end());
}

/** Move a completed download onto the mount. Safe: the file is done, nothing reads it mid-write. */
async function moveToMount(torrent, infoHash, title) {
  if (!mountReady()) {
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'move-to-mount', success: false, errorMsg: 'mount not available' });
    return;
  }

  const largest = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
  const srcPath = path.join(config.LOCALSEED.LOCAL_DIR, largest.path);
  const destDir = mountDir();
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, mountFilename(infoHash, largest.path));

  const t0 = Date.now();
  await fs.promises.copyFile(srcPath, destPath);
  await fs.promises.unlink(srcPath);

  state.touch(STATE_PATH, infoHash, { size: largest.length, lastPlayed: Date.now(), status: 'mounted' });
  activityLog.localSeed({
    infoHash, releaseTitle: title, phase: 'move-to-mount', success: true, duration_ms: Date.now() - t0
  });

  // Stop seeding this torrent's local copy now that it lives on the mount —
  // config.LOCALSEED.SEED_WINDOW_MS still governs how long WebTorrent keeps
  // announcing/uploading before it is removed from the client entirely.
  setTimeout(() => {
    getClient().remove(torrent.infoHash, () => {});
  }, config.LOCALSEED.SEED_WINDOW_MS);
}

/** Daily sweep: evict oldest-played files on the mount once usage exceeds the cap. Called from addon.js on the same interval as the catalog refresh. */
async function sweepEviction() {
  if (!mountReady()) return;

  const dir = mountDir();
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }

  const meta = state.load(STATE_PATH);
  const files = [];
  let usedBytes = 0;
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = await fs.promises.stat(full);
    } catch {
      continue;
    }
    const infoHash = Object.keys(meta).find(h => name.toLowerCase().startsWith(h.toLowerCase()));
    const lastPlayed = infoHash && meta[infoHash] ? meta[infoHash].lastPlayed : st.mtimeMs;
    files.push({ path: full, size: st.size, lastPlayed, infoHash });
    usedBytes += st.size;
  }

  const targets = selectEvictionTargets(files, usedBytes, config.LOCALSEED.DRIVE_CAP_BYTES);
  for (const target of targets) {
    try {
      await fs.promises.unlink(target.path);
      if (target.infoHash) state.remove(STATE_PATH, target.infoHash);
      activityLog.localSeed({ infoHash: target.infoHash, phase: 'evict', success: true });
    } catch (err) {
      activityLog.localSeed({ infoHash: target.infoHash, phase: 'evict', success: false, errorMsg: err.message });
    }
  }
}

module.exports = {
  isEnabled, mountReady, findOnMount, streamRelease, sweepEviction,
  encodePayload, decodePayload
};
