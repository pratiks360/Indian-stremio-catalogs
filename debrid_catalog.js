'use strict';

/**
 * "Prowlarr — Debrid Cached": what is actually sitting in the user's
 * Real-Debrid account, ready to play instantly.
 *
 * Read straight from RD rather than from a local log, so it stays truthful
 * if a download is deleted in RD's own UI or was added from somewhere other
 * than this addon.
 *
 * Release names are scene-formatted ("Perfect.Family.S01E01.Kidhar.Hai.Chot
 * .2160p.SL.WEB-DL...") and have to be reduced to a plain title before TMDB
 * can resolve them to an IMDb id.
 */

const config = require('./config');
const cache = require('./cache');
const tmdb = require('./tmdb');
const rd = require('./lib/realdebrid');

// Everything from the first quality/source/season marker onward is release
// metadata, not part of the title.
const NOISE = new RegExp(
  '[._ ]\\(?(' +
    '\\d{3,4}p|4k|2160|1080|720|480|' +
    's\\d{1,2}(e\\d{1,3})?|season[._ ]?\\d+|' +
    'web[-._ ]?dl|webrip|bluray|bdrip|brrip|hdrip|hdtv|dvdrip|remux|cam|hdcam|' +
    'x26[45]|h[._ ]?26[45]|hevc|avc|xvid|divx|' +
    'ddp?[._ ]?\\d|dts|aac|ac3|atmos|truehd|eac3|' +
    'hdr10?\\+?|dolby|dv|sdr|' +
    'multi|dual[._ ]?audio|hindi|english|esub|msub' +
  ')\\b.*$',
  'i'
);

function cleanReleaseName(name) {
  let s = String(name).replace(/\.(mkv|mp4|avi|m4v|ts)$/i, '');
  s = s.replace(NOISE, '');
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(/[[({].*?[\])}]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Trailing 4-digit year, if the release carries one. */
function extractYear(name) {
  const m = /\b(19\d{2}|20\d{2})\b/.exec(String(name));
  return m ? Number(m[1]) : null;
}

/** A season/episode marker means it is a series, whatever TMDB thinks. */
function looksLikeSeries(name) {
  return /\bs\d{1,2}(e\d{1,3})?\b|\bseason[._ ]?\d+\b|\bcomplete\b/i.test(String(name));
}

async function build() {
  if (!config.REALDEBRID_TOKEN) return { items: [], at: Date.now() };

  const torrents = await rd.listTorrents(100);
  const downloaded = torrents.filter(t => t.status === 'downloaded');

  const seen = new Set();
  const items = [];

  for (const t of downloaded) {
    const raw = t.filename || t.original_filename || '';
    const title = cleanReleaseName(raw);
    if (!title) continue;

    const type = looksLikeSeries(raw) ? 'series' : 'movie';
    const dedupe = `${type}:${title.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    let resolved;
    try {
      resolved = await tmdb.resolve({ title, type, year: extractYear(raw) });
    } catch (err) {
      console.warn(`[debrid] TMDB resolve failed for "${title}": ${err.message}`);
      continue;
    }
    if (!resolved || !resolved.imdb_id) {
      console.log(`[debrid] unresolved: "${raw.slice(0, 60)}" -> "${title}"`);
      continue;
    }

    items.push({
      ...resolved,
      type,
      addedAt: t.added || null,
      releaseName: raw
    });
  }

  console.log(`[debrid] ${items.length}/${downloaded.length} downloaded torrents resolved`);
  return { items, at: Date.now() };
}

/** @returns {Promise<{metas:Array, origin:string}>} */
async function getCatalog(type) {
  if (!config.REALDEBRID_TOKEN) return { metas: [], origin: 'unconfigured' };

  const payload = await cache.get('catalog:debrid', config.TTL.rdTorrents, build);

  const metas = payload.items
    .filter(it => !type || it.type === type)
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
    .slice(0, config.MAX_ITEMS)
    .map(toMeta);

  return { metas, origin: 'realdebrid' };
}

function toMeta(item) {
  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: `Cached in Real-Debrid — plays instantly.\n\n${item.releaseName}`,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

module.exports = { getCatalog, build, cleanReleaseName };
