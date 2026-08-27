'use strict';

/**
 * Pure helpers for the local-seed feature — no I/O, no WebTorrent, no fs.
 * Kept separate from lib/localseed.js so admission control and eviction
 * selection can be exercised without a real torrent client or filesystem.
 */

/**
 * Payload for /local/resolve/:payload — same base64url-JSON shape family as
 * the RD payload built in stream.js's toDebridStream(). Deliberately a
 * plain passthrough (not a fixed destructure) so callers can carry whatever
 * fields the resolve step needs — infoHash/trackers/title always, plus
 * season/episode when the release is a season pack and the right file
 * within it must be picked at resolve time (pickFileIdx needs them; they
 * can't be recovered from the resolve request itself, Stremio's play
 * request carries no season/episode query param).
 */
function encodePayload(fields) {
  return Buffer.from(JSON.stringify(fields)).toString('base64url');
}

function decodePayload(payloadB64) {
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
}

/**
 * Filename used both in the local download dir and on the mount, keyed by
 * infoHash so a replay can find a previously-completed download by hash
 * alone, independent of release-name variations across searches.
 */
function mountFilename(infoHash, originalPath) {
  const match = /\.[a-z0-9]+$/i.exec(String(originalPath || ''));
  const ext = match ? match[0] : '.mkv';
  return `${String(infoHash).toLowerCase()}${ext}`;
}

/**
 * Admission control for starting a new local-seed download.
 * @param {{activeCount:number, rssBytes:number, freeBytes:number}} state
 * @param {{maxConcurrent:number, rssCeilingBytes:number, minFreeBytes:number}} limits
 * @returns {{allow:boolean, reason?:string}}
 */
function shouldAdmit(state, limits) {
  if (state.activeCount >= limits.maxConcurrent) {
    return { allow: false, reason: `${limits.maxConcurrent} local-seed downloads already active` };
  }
  if (state.rssBytes >= limits.rssCeilingBytes) {
    return { allow: false, reason: 'server memory near ceiling' };
  }
  if (state.freeBytes < limits.minFreeBytes) {
    return { allow: false, reason: 'local disk below reserved floor' };
  }
  return { allow: true };
}

/**
 * Given files with size + lastPlayed (ms epoch), pick which to delete
 * (oldest-played first) to bring total usage back under capBytes.
 * @param {Array<{path:string, size:number, lastPlayed:number}>} files
 * @param {number} usedBytes current total usage
 * @param {number} capBytes
 * @returns {Array<{path:string, size:number, lastPlayed:number}>} deletion targets, oldest-played first
 */
function selectEvictionTargets(files, usedBytes, capBytes) {
  if (usedBytes <= capBytes) return [];
  const sorted = [...files].sort((a, b) => a.lastPlayed - b.lastPlayed);
  const targets = [];
  let freed = 0;
  for (const f of sorted) {
    if (usedBytes - freed <= capBytes) break;
    targets.push(f);
    freed += f.size;
  }
  return targets;
}

module.exports = { encodePayload, decodePayload, mountFilename, shouldAdmit, selectEvictionTargets };
