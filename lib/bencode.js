'use strict';

/**
 * Minimal bencode reader for .torrent files.
 *
 * Needed because none of the configured Prowlarr indexers expose magnet
 * links or infoHash via the API (all private trackers — verified live: every
 * one returns infoHash:null, magnetUrl:null, downloadUrl only). The infoHash,
 * the file list and — critically — whether the announce URL carries a
 * personal passkey can only be read out of the torrent file itself.
 */

/**
 * @returns {[any, number]} decoded value and the index just past it
 */
function decode(buf, p = 0) {
  const c = buf[p];

  if (c === 0x64) { // 'd'
    p++;
    const out = {};
    while (buf[p] !== 0x65) { // 'e'
      const [k, kp] = decode(buf, p);
      const [v, vp] = decode(buf, kp);
      out[k.toString('latin1')] = v;
      p = vp;
    }
    return [out, p + 1];
  }

  if (c === 0x6c) { // 'l'
    p++;
    const out = [];
    while (buf[p] !== 0x65) {
      const [v, vp] = decode(buf, p);
      out.push(v);
      p = vp;
    }
    return [out, p + 1];
  }

  if (c === 0x69) { // 'i'
    const e = buf.indexOf(0x65, p);
    return [Number(buf.slice(p + 1, e).toString()), e + 1];
  }

  const colon = buf.indexOf(0x3a, p); // ':'
  const len = Number(buf.slice(p, colon).toString());
  const start = colon + 1;
  return [buf.slice(start, start + len), start + len];
}

/**
 * Byte range of the raw `info` dictionary — the infoHash is sha1 over these
 * exact bytes, so it has to come from the original buffer rather than from a
 * re-encode of the parsed value (key order and integer formatting would not
 * survive a round trip).
 */
function infoDictRange(buf) {
  const marker = Buffer.from('4:infod');
  const at = buf.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length - 1; // point at the 'd'
  return [start, skip(buf, start)];
}

/** Index just past the value starting at p. */
function skip(buf, p) {
  const c = buf[p];
  if (c === 0x64 || c === 0x6c) { // 'd' | 'l'
    p++;
    while (buf[p] !== 0x65) p = skip(buf, p);
    return p + 1;
  }
  if (c === 0x69) return buf.indexOf(0x65, p) + 1; // 'i'
  const colon = buf.indexOf(0x3a, p);
  return colon + 1 + Number(buf.slice(p, colon).toString());
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|mov|wmv|flv|webm|mpg|mpeg)$/i;

/**
 * @param {Buffer} buf raw .torrent contents
 * @returns {{infoHash:string, name:string, private:boolean, files:Array, fileIdx:number, totalBytes:number, trackers:string[], hasPasskey:boolean}}
 */
function parseTorrent(buf) {
  const [meta] = decode(buf);
  const info = meta.info || {};

  const range = infoDictRange(buf);
  if (!range) throw new Error('no info dict in torrent');
  const infoHash = require('crypto')
    .createHash('sha1')
    .update(buf.slice(range[0], range[1]))
    .digest('hex');

  const name = (info.name || Buffer.alloc(0)).toString('utf8');

  // Build the file list. Single-file torrents have no `files` key; the whole
  // torrent IS the file, at index 0.
  let files;
  if (Array.isArray(info.files)) {
    files = info.files.map((f, idx) => ({
      idx,
      length: f.length,
      path: (f.path || []).map(seg => seg.toString('utf8')).join('/')
    }));
  } else {
    files = [{ idx: 0, length: info.length || 0, path: name }];
  }

  const fileIdx = pickFileIdx(files);

  const trackers = [];
  if (meta.announce) trackers.push(meta.announce.toString('utf8'));
  for (const tier of meta['announce-list'] || []) {
    for (const u of tier) {
      const s = u.toString('utf8');
      if (!trackers.includes(s)) trackers.push(s);
    }
  }

  return {
    infoHash,
    name,
    private: info.private === 1,
    files,
    fileIdx,
    totalBytes: files.reduce((n, f) => n + (f.length || 0), 0),
    trackers,
    hasPasskey: trackers.some(containsPasskey)
  };
}

/**
 * Which file in the torrent should play.
 *
 * Season packs make this more than "the biggest file": a request for S01E01
 * against an 8-episode pack must select episode 1's file, not whichever
 * episode happens to be largest. Only when no episode is asked for (a film,
 * or a pack opened without an episode context) does size decide.
 *
 * @param {Array} files from parseTorrent
 * @param {number|null} season
 * @param {number|null} episode
 */
function pickFileIdx(files, season = null, episode = null) {
  const videos = files.filter(f => VIDEO_EXT.test(f.path));
  const pool = videos.length ? videos : files;

  if (season != null && episode != null) {
    const want = new RegExp(
      `\\bs0*${season}[. _]?e0*${episode}\\b|\\b${season}x0*${episode}\\b`,
      'i'
    );
    const hit = pool.find(f => want.test(f.path));
    if (hit) return hit.idx;
    // No per-episode file: either a single-episode release, or a pack whose
    // naming this does not recognise. Largest video is the best guess left.
  }

  return pool.reduce((best, f) => (f.length > best.length ? f : best), pool[0]).idx;
}

/**
 * Does this announce URL embed a personal, account-identifying secret?
 *
 * This is the safety gate for Real-Debrid. Handing RD a torrent whose
 * announce carries the user's passkey means RD's servers announce to a
 * private tracker AS that user, from RD's IPs — on most private trackers
 * that is passkey sharing and a bannable offence. Anything matching here is
 * therefore never sent to RD, only streamed peer-to-peer by the user's own
 * client (which announces from their own IP, as normal).
 *
 * Deliberately broad: a false positive costs one release the RD path, a
 * false negative can cost a tracker account.
 */
function containsPasskey(url) {
  // ?passkey= / &authkey= / &torrent_pass= / &apikey= ... style
  if (/[?&](passkey|authkey|torrent_pass|apikey|api_key|secret|pid|uid)=/i.test(url)) return true;
  // /<32-hex>/announce, /a/<token>/announce, /announce/<token> style
  if (/\/[A-Za-z0-9_-]{16,}(?=\/|$)/.test(url.replace(/^https?:\/\/[^/]+/, ''))) return true;
  return false;
}

module.exports = { decode, parseTorrent, containsPasskey, pickFileIdx };
