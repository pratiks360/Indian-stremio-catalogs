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
const { pickFileIdx, parseTorrent } = require('./bencode');
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

/**
 * Sidecar state key. A season pack is one infoHash with many files — keying
 * the sidecar on infoHash alone meant playing episode 2 after episode 1 was
 * already mounted overwrote episode 1's entire entry (status flipped back
 * to 'local'), silently dropping it from the "VPS/Drive Downloaded" catalog
 * even though the file was still sitting on the mount. Same composite the
 * mount filename already uses (mountFilename in localseed_util.js), so a
 * state key is always a literal prefix of its file's name on disk — that's
 * what sweepEviction()'s startsWith matching below relies on.
 */
function stateKey(infoHash, fileIdx) {
  return `${String(infoHash).toLowerCase()}.${fileIdx}`;
}

/**
 * @param {string} infoHash
 * @param {number} fileIdx which file within the torrent — required, not
 *   optional. A season pack is one infoHash with many files; matching on
 *   infoHash alone made a mount hit for ANY episode of a show serve
 *   whichever episode happened to be mounted first, regardless of which
 *   one was actually requested (found live: browsing to episode 5 silently
 *   played episode 1's bytes).
 * @returns {string|null} absolute path on the mount if this exact file was already downloaded
 */
function findOnMount(infoHash, fileIdx) {
  const dir = mountDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `${String(infoHash).toLowerCase()}.${fileIdx}.`;
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

/**
 * Torrents currently downloading/seeding in the WebTorrent client, for the
 * /activity "downloading now" view. `seeders` is the tracker-reported count
 * captured once at search time (state sidecar) — not live; `peers` is
 * WebTorrent's own live connected-peer count, which is a different number
 * (connected peers, not tracker-scraped seeders) and shown alongside it
 * rather than in place of it.
 */
function listActive() {
  const meta = state.load(STATE_PATH);
  return getClient().torrents.map(t => {
    // State is keyed `${infoHash}.${fileIdx}` (see stateKey) — a torrent
    // object alone doesn't carry which file was requested, so match by
    // infoHash prefix and take the most recently touched entry for it.
    const prefix = `${t.infoHash.toLowerCase()}.`;
    const entries = Object.entries(meta).filter(([k]) => k.startsWith(prefix));
    entries.sort((a, b) => (b[1].lastPlayed || 0) - (a[1].lastPlayed || 0));
    const m = entries.length ? entries[0][1] : {};
    return {
      infoHash: t.infoHash,
      title: m.releaseTitle || t.name || '(unnamed)',
      progressPct: Math.round((t.progress || 0) * 100),
      downloadedBytes: t.downloaded || 0,
      totalBytes: t.length || 0,
      downloadSpeedBps: t.downloadSpeed || 0,
      peers: t.numPeers || 0,
      seeders: m.seeders != null ? m.seeders : null
    };
  });
}

/**
 * Files currently sitting on the Google Drive mount (fully downloaded,
 * moved off local disk) — for the /activity "on disk/drive" view. Distinct
 * from listActive(): those are still downloading on local disk, these are
 * done and living on Drive.
 */
function listMounted() {
  const dir = mountDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const meta = state.load(STATE_PATH);
  return entries.map(name => {
    const full = path.join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(full).size;
    } catch { /* raced with eviction — skip size, still list the entry */ }

    const infoHash = Object.keys(meta).find(h => name.toLowerCase().startsWith(String(h).toLowerCase()));
    const m = infoHash ? meta[infoHash] : {};
    return {
      file: name,
      sizeBytes,
      releaseTitle: m.releaseTitle || null,
      lastPlayed: m.lastPlayed || null
    };
  });
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
  const { infoHash, trackers, title, guid, downloadUrl, seeders } = release;

  // Resolve which file within the torrent is actually wanted BEFORE
  // touching the mount or the WebTorrent client. This requires the
  // torrent's file list, which is available straight from the cached
  // .torrent file (no WebTorrent/network needed) — the same buffer
  // addTorrent() would fetch anyway, so it's passed through to avoid a
  // second read.
  const torrentBuf = await fetchTorrentBuffer({ guid, downloadUrl });
  if (!torrentBuf) {
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'rejected', success: false, errorMsg: 'could not obtain .torrent file' });
    res.status(502).type('text/plain').send('Local seedbox error: could not obtain .torrent file');
    return;
  }
  const parsed = parseTorrent(torrentBuf);
  const wantedIdx = pickFileIdx(parsed.files, season, episode);

  // 1. Already on the mount from a previous download of THIS SPECIFIC
  //    file — serve it directly, no torrent, no re-download. Scoped to
  //    wantedIdx, not just infoHash: a season pack is one infoHash with
  //    many files, and a mount hit for the wrong episode would silently
  //    serve the wrong content (see findOnMount's doc comment).
  const mounted = findOnMount(infoHash, wantedIdx);
  if (mounted) {
    state.touch(STATE_PATH, stateKey(infoHash, wantedIdx), { lastPlayed: Date.now() });
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
    torrent = await addTorrent(torrentBuf);
    // NOTE: a season pack downloads every episode, not just the one
    // requested — WebTorrent selects every file by default, and an attempt
    // to deselect all files then select() only the wanted one (tried live)
    // did not actually restrict the download. Not fixed here; tracked as a
    // known limitation. Playback and the mount-move both still work
    // correctly regardless (wantedIdx is resolved up front, above, from
    // the .torrent file itself, independent of WebTorrent's own file
    // selection state) — the cost is wasted bandwidth/disk on unwatched
    // episodes and a longer wait before the file reaches the Drive mount.
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'download-start', success: true });

    torrent.once('done', () => {
      moveToMount(torrent, infoHash, title, wantedIdx).catch(err => {
        activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'move-to-mount', success: false, errorMsg: err.message });
      });
    });
  }

  await waitForFileSelectable(torrent);
  const file = torrent.files[wantedIdx];

  state.touch(STATE_PATH, stateKey(infoHash, wantedIdx), {
    lastPlayed: Date.now(), status: 'local', releaseTitle: title,
    seeders: seeders != null ? seeders : null
  });
  streamTorrentFile(req, res, file);
}

/**
 * Adds a torrent to the WebTorrent client using its real .torrent file
 * bytes, not a bare magnet URI. These are private trackers with DHT/PEX
 * disabled (see stream.js's file header) — a magnet has no way to fetch
 * the info dict without them, and would hang forever waiting for metadata
 * that can never arrive. The .torrent file already embeds the full info
 * dict (infoHash, trackers, files), so handing WebTorrent that buffer
 * skips metadata exchange entirely and needs nothing else as input.
 * @param {Buffer} buf raw .torrent file bytes, already fetched by the caller
 */
async function addTorrent(buf) {
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

/**
 * Move a completed download onto the mount. Safe: the file is done,
 * nothing reads it mid-write.
 * @param {number} wantedIdx which file to move — passed explicitly by the
 *   caller (resolved once, up front, in streamRelease) rather than read
 *   off a `torrent._wantedIdx` property set later in an async flow, which
 *   could race against a fast-completing 'done' event.
 */
async function moveToMount(torrent, infoHash, title, wantedIdx) {
  if (!mountReady()) {
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'move-to-mount', success: false, errorMsg: 'mount not available' });
    return;
  }

  const wanted = torrent.files[wantedIdx];
  const srcPath = path.join(config.LOCALSEED.LOCAL_DIR, wanted.path);
  const destDir = mountDir();
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, mountFilename(infoHash, wanted.path, wantedIdx));

  const t0 = Date.now();
  await fs.promises.copyFile(srcPath, destPath);
  await fs.promises.unlink(srcPath);

  state.touch(STATE_PATH, stateKey(infoHash, wantedIdx), { size: wanted.length, lastPlayed: Date.now(), status: 'mounted', releaseTitle: title });
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
  encodePayload, decodePayload, listActive, listMounted
};
