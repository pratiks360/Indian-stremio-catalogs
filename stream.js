'use strict';

/**
 * Stream resource: Prowlarr releases -> playable Stremio streams.
 *
 * Two delivery paths, and which one a release is allowed to use is decided
 * by the torrent file itself, not by configuration:
 *
 *   Direct P2P  — always offered. Stremio's built-in torrent engine streams
 *                 it on the user's own device. Their client announces to the
 *                 tracker from their own IP with their own passkey, which is
 *                 ordinary use, and it seeds while playing.
 *
 *   Real-Debrid — offered ONLY when the torrent carries no passkey. Sending
 *                 a passkey-bearing torrent to RD would have RD's servers
 *                 announce to a private tracker as the user; on most private
 *                 trackers that is a bannable offence. Every indexer
 *                 currently configured is private, so in practice this path
 *                 stays dark until a public indexer is added — at which
 *                 point it lights up on its own, with nothing to configure.
 */

const config = require('./config');
const cache = require('./cache');
const tmdb = require('./tmdb');
const prowlarr = require('./lib/prowlarr');
const { pickFileIdx } = require('./lib/bencode');
const rd = require('./lib/realdebrid');
const activityLog = require('./activity-log');
const localseed = require('./lib/localseed');

/**
 * Stremio addresses an episode as `tt1234567:5:27`.
 * @returns {{imdbId:string, season:number|null, episode:number|null}}
 */
function parseStreamId(id) {
  const [imdbId, season, episode] = String(id).split(':');
  return {
    imdbId,
    season: season != null ? Number(season) : null,
    episode: episode != null ? Number(episode) : null
  };
}

/** IMDb id -> title/year, so Prowlarr can be queried by name. */
async function titleForImdbId(imdbId, type) {
  return cache.get(`imdbtitle:${imdbId}`, config.TTL.tmdbResolve, async () => {
    const found = await tmdb.tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const hit = type === 'series'
      ? (found.tv_results || [])[0]
      : (found.movie_results || [])[0];
    if (!hit) throw new Error(`no TMDB match for ${imdbId}`);
    const date = hit.release_date || hit.first_air_date || '';
    return { title: hit.title || hit.name, year: date ? Number(date.slice(0, 4)) : null };
  });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

/** Pull quality/format markers out of a scene release name for the UI line. */
function qualityTags(name) {
  const tags = [];
  const res = /\b(2160p|1080p|720p|480p|4k)\b/i.exec(name);
  if (res) tags.push(res[1].toUpperCase());
  const src = /\b(WEB[- .]?DL|WEBRip|BluRay|BDRip|HDRip|HDTV|DVDRip|REMUX)\b/i.exec(name);
  if (src) tags.push(src[1].replace(/[. ]/g, '-'));
  if (/\bHDR10\+?\b|\bDV\b|\bDolby[. ]Vision\b/i.test(name)) tags.push('HDR');
  if (/\bAtmos\b/i.test(name)) tags.push('Atmos');
  return tags;
}

/**
 * Fetch and parse the torrents behind a set of releases.
 *
 * Every release needs its .torrent file — none of the indexers expose a
 * magnet, and infoHash / fileIdx / passkey status all live inside the file.
 * Prowlarr serializes these downloads server-side (measured: 6 fetches take
 * ~10.5s sequentially, ~12s fully parallel), so running them concurrently
 * gains nothing and only the count matters. Hence: seeder-sort first, fetch
 * a small number, and top the list up in the background afterwards.
 *
 * @param {Array} out array to append into — the same array stays in cache,
 *   so the background pass extends what a later request sees.
 */
async function hydrateInto(out, ranked, from, to) {
  for (let i = from; i < Math.min(to, ranked.length); i++) {
    const release = ranked[i];
    const t0 = Date.now();
    let torrent;
    try {
      torrent = await prowlarr.fetchTorrent(release);
      activityLog.torrentFetch({
        releaseTitle: release.title, indexer: release.indexer,
        success: Boolean(torrent), duration_ms: Date.now() - t0
      });
    } catch (err) {
      activityLog.torrentFetch({
        releaseTitle: release.title, indexer: release.indexer,
        success: false, errorMsg: err.message, duration_ms: Date.now() - t0
      });
      continue;
    }
    if (torrent) out.push({ release, torrent });
  }
  out.sort((a, b) => (b.release.seeders || 0) - (a.release.seeders || 0));
  return out;
}

async function hydrateReleases(releases) {
  const ranked = [...releases].sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  const out = [];

  // No background top-up here. It was tried and removed: Prowlarr serializes
  // torrent downloads globally, so a background pass for one title sits in
  // the same queue as the next title the user actually opens — it turned a
  // 23s hydrate into a 49s one. Whatever is not fetched now is simply not
  // offered; the disk cache in lib/prowlarr.js is what makes repeats cheap.
  await hydrateInto(out, ranked, 0, config.STREAM_MAX_RELEASES);
  return out;
}

/**
 * The direct path: hand Stremio the infoHash and let its own engine do the
 * work. `sources` must carry the tracker announce URLs because these
 * torrents set private=1, which disables DHT and PEX — the tracker is the
 * only way to find peers.
 */
function toDirectStream({ release, torrent }, season, episode) {
  const tags = qualityTags(release.title);
  // A season pack contains every episode; point Stremio at the one asked for.
  const fileIdx = pickFileIdx(torrent.files, season, episode);
  const detail = [
    tags.join(' '),
    fmtSize(torrent.totalBytes),
    `${release.seeders != null ? release.seeders : '?'} seeds`,
    release.indexer
  ].filter(Boolean).join(' · ');

  return {
    name: 'P2P',
    title: `${release.title}\n${detail}`,
    infoHash: torrent.infoHash,
    fileIdx,
    sources: torrent.trackers.map(t => `tracker:${t}`),
    behaviorHints: { bingeGroup: `prowlarr-p2p-${tags.join('-') || 'sd'}` }
  };
}

/**
 * The RD path points back at this addon rather than at RD directly: the
 * playable URL cannot be known until the torrent has been added and has
 * finished, so resolution is deferred until the user actually presses play.
 */
function toDebridStream({ release, torrent }, baseUrl, cachedHint) {
  const tags = qualityTags(release.title);
  const detail = [
    tags.join(' '),
    fmtSize(torrent.totalBytes),
    `${release.seeders != null ? release.seeders : '?'} seeds`,
    release.indexer
  ].filter(Boolean).join(' · ');

  const payload = Buffer.from(JSON.stringify({
    u: release.downloadUrl,
    h: torrent.infoHash,
    t: release.title
  })).toString('base64url');

  return {
    name: cachedHint ? 'RD+' : 'RD',
    title: `${cachedHint ? '[in your RD] ' : ''}${release.title}\n${detail}`,
    url: `${baseUrl}/rd/resolve/${payload}`,
    behaviorHints: { bingeGroup: `prowlarr-rd-${tags.join('-') || 'sd'}`, notWebReady: false }
  };
}

/**
 * The local-seed path: this addon downloads/seeds the torrent on its own
 * VPS. Only offered for releases RD already excludes (hasPasskey) — see
 * lib/localseed.js's header comment for why that is safe here but not for
 * a third-party service like RD.
 */
function toLocalSeedStream({ release, torrent }, season, episode) {
  const tags = qualityTags(release.title);
  const detail = [
    tags.join(' '),
    fmtSize(torrent.totalBytes),
    `${release.seeders != null ? release.seeders : '?'} seeds`,
    release.indexer
  ].filter(Boolean).join(' · ');

  // season/episode ride along in the payload — pickFileIdx needs them to
  // select the right file out of a season-pack torrent at resolve time,
  // and Stremio's play request carries no season/episode query param of
  // its own to recover them from otherwise.
  const payload = localseed.encodePayload({
    infoHash: torrent.infoHash,
    trackers: torrent.trackers,
    title: release.title,
    season,
    episode
  });

  return {
    name: 'Local',
    title: `${release.title}\n${detail}`,
    _payload: payload,
    behaviorHints: { bingeGroup: `prowlarr-local-${tags.join('-') || 'sd'}`, notWebReady: false }
  };
}

/**
 * @param {'movie'|'series'} type
 * @param {string} id  e.g. tt1234567 or tt1234567:5:27
 * @param {string} baseUrl public origin of this addon, for RD resolve links
 */
async function getStreams(type, id, baseUrl) {
  const { imdbId, season, episode } = parseStreamId(id);
  if (!/^tt\d+$/.test(imdbId)) return { streams: [] };

  const { title, year } = await titleForImdbId(imdbId, type);

  const key = `prowlarr:${type}:${imdbId}:${season ?? ''}:${episode ?? ''}`;

  // Which releases are already in the user's RD account — the only cache
  // signal left now that instantAvailability is gone, and what makes a
  // second play of the same release instant. Independent of the Prowlarr
  // work, so it runs alongside it rather than adding to the critical path.
  const rdHashesP = config.REALDEBRID_TOKEN
    ? cache.get('rd:torrents', config.TTL.rdTorrents, () => rd.listTorrents())
        .then(ts => new Set(
          ts.filter(t => t.status === 'downloaded').map(t => String(t.hash || '').toLowerCase())
        ))
        .catch(err => {
          console.warn(`[stream] RD torrent list unavailable: ${err.message}`);
          return new Set();
        })
    : Promise.resolve(new Set());

  const [hydrated, rdHashes] = await Promise.all([
    cache.get(key, config.TTL.prowlarrSearch, async () => {
      const tSearch = Date.now();
      const releases = await prowlarr.search(title, type, season, episode);
      const searchMs = Date.now() - tSearch;

      const tHydrate = Date.now();
      const out = await hydrateReleases(releases);
      console.log(
        `[stream] ${title}${season != null ? ` S${season}E${episode}` : ''}: ` +
        `${releases.length} releases, search ${searchMs}ms, ` +
        `hydrate ${Date.now() - tHydrate}ms -> ${out.length} playable`
      );
      activityLog.streamSearch({
        imdbId, title, searchType: type,
        prowlarrQuery: title + (season != null ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''),
        releaseCount: releases.length,
        releases: releases.slice(0, 10).map(r => r.title),
        success: out.length > 0
      });
      return out;
    }),
    rdHashesP
  ]);

  if (!hydrated.length) return { streams: [] };

  const streams = [];
  let rdEligible = 0;

  for (const item of hydrated) {
    // Direct is always available and always listed first: it is the option
    // that cannot get a tracker account banned.
    streams.push(toDirectStream(item, season, episode));

    if (item.torrent.hasPasskey) {
      if (localseed.isEnabled()) {
        const local = toLocalSeedStream(item, season, episode);
        local.url = `${baseUrl}/local/resolve/${local._payload}`;
        delete local._payload;
        streams.push(local);
      }
      continue; // never sent to RD — see file header
    }
    if (!config.REALDEBRID_TOKEN) continue;
    rdEligible++;
    streams.push(toDebridStream(item, baseUrl, rdHashes.has(item.torrent.infoHash.toLowerCase())));
  }

  if (config.REALDEBRID_TOKEN && rdEligible === 0) {
    console.log('[stream] no RD-eligible releases (all carry tracker passkeys) — P2P only');
  }

  // Cached-in-RD first, then by seeders: both orderings put "starts playing
  // soonest" at the top.
  streams.sort((a, b) => {
    const aC = a.title.startsWith('[in your RD]') ? 0 : 1;
    const bC = b.title.startsWith('[in your RD]') ? 0 : 1;
    return aC - bC;
  });

  if (config.PREFETCH_NEXT_EPISODE && type === 'series' && season != null && episode != null) {
    prefetchNextEpisode(title, season, episode).catch(() => {});
  }

  return { streams };
}

/**
 * Warm the next episode into RD while the current one plays.
 *
 * Fire-and-forget and deliberately narrow: one episode ahead, RD-eligible
 * releases only, and it does nothing at all if the next episode is already
 * in the account. Never blocks or affects the response being served.
 */
async function prefetchNextEpisode(title, season, episode) {
  if (!config.REALDEBRID_TOKEN) return;
  const next = episode + 1;

  try {
    const releases = await prowlarr.search(title, 'series', season, next);
    if (!releases.length) return;

    const ranked = [...releases].sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    const torrents = await rd.listTorrents();

    for (const release of ranked.slice(0, 3)) {
      const torrent = await prowlarr.fetchTorrent(release);
      if (!torrent || torrent.hasPasskey) continue;
      if (rd.findByHash(torrents, torrent.infoHash)) return; // already there

      const buf = await fetchTorrentBuffer(release.downloadUrl);
      if (!buf) return;
      const rdId = await rd.addTorrentFile(buf);
      await rd.selectFiles(rdId);
      console.log(`[prefetch] queued S${season}E${next}: ${release.title}`);
      return;
    }
  } catch (err) {
    console.warn(`[prefetch] S${season}E${next} failed: ${err.message}`);
  }
}

async function fetchTorrentBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(config.PROWLARR_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Resolve an RD stream link at play time.
 *
 * Order matters: check the account first (free, instant when it hits), and
 * only commit a new torrent if it is genuinely absent. With
 * instantAvailability dead this is the only way to distinguish "RD already
 * has it" from "RD must fetch it".
 *
 * @returns {Promise<{url:string}|{pending:true, message:string}>}
 */
async function resolveDebridLink(payloadB64) {
  const { u: downloadUrl, h: infoHash, t: releaseTitle } =
    JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  // This handler only runs when Stremio hits the RD play URL, i.e. the user
  // actually pressed play on an RD stream — the only click signal the server
  // ever sees (a P2P click never reaches this addon at all; Stremio's own
  // torrent engine handles it entirely client-side).
  activityLog.userClick({ releaseTitle, infoHash, deliveryPath: 'rd' });

  let torrents = await rd.listTorrents();
  let entry = rd.findByHash(torrents, infoHash);

  if (!entry) {
    const t0 = Date.now();
    const buf = await fetchTorrentBuffer(downloadUrl);
    if (!buf) throw new Error('could not fetch torrent from Prowlarr');
    const id = await rd.addTorrentFile(buf);
    await rd.selectFiles(id);
    console.log(`[rd] added "${releaseTitle}" (${id})`);
    activityLog.rdAction({ action: 'add', torrentHash: infoHash, success: true, status: 'queued', duration_ms: Date.now() - t0 });
    entry = { id, status: 'queued' };
  }

  const tWait = Date.now();
  let info = entry.status === 'downloaded'
    ? await rd.torrentInfo(entry.id)
    : await rd.waitForDownloaded(entry.id, config.RD_WAIT_MS);
  activityLog.rdAction({
    action: 'poll', torrentHash: infoHash,
    success: Boolean(info && info.status === 'downloaded'),
    status: info ? info.status : 'timeout', duration_ms: Date.now() - tWait
  });

  if (!info || info.status !== 'downloaded') {
    // Genuinely downloading. Leave it running — it will appear in the
    // Debrid Cached catalog when it lands.
    cache.clear('rd:torrents');
    return {
      pending: true,
      message: 'Real-Debrid is downloading this release. It will appear in "Prowlarr — Debrid Cached" when ready.'
    };
  }

  const links = info.links || [];
  if (!links.length) throw new Error('RD reported downloaded but returned no links');

  // selectFiles('all') keeps every file, so pick the largest — RD orders
  // links to match the selected file order.
  let linkIdx = 0;
  if (Array.isArray(info.files) && info.files.length === links.length) {
    let best = -1;
    info.files.forEach((f, i) => {
      if (f.bytes > best) { best = f.bytes; linkIdx = i; }
    });
  }

  const tResolve = Date.now();
  const url = await rd.unrestrict(links[linkIdx]);
  activityLog.rdAction({ action: 'resolve', torrentHash: infoHash, success: true, status: 'downloaded', duration_ms: Date.now() - tResolve });
  cache.clear('rd:torrents');
  return { url };
}

/**
 * Resolve a local-seed stream at play time — thin adapter between Express's
 * (req, res) and lib/localseed.js's streamRelease(), which owns the whole
 * response lifecycle (it may serve from the mount, an in-progress torrent
 * download, or reject with 503 under admission control). season/episode
 * come from the payload itself (encoded in toLocalSeedStream()), not from
 * the request — Stremio's play request carries no such query param.
 */
async function resolveLocalSeed(req, res, payloadB64) {
  const { infoHash, trackers, title, season, episode } = localseed.decodePayload(payloadB64);
  await localseed.streamRelease(req, res, { infoHash, trackers, title }, season, episode);
}

module.exports = { getStreams, resolveDebridLink, resolveLocalSeed, parseStreamId };
