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
const activityLog = require('./activity-log');

/**
 * Scene naming is "Title.YEAR.quality.source.codec-GROUP" (or the same with
 * spaces/underscores). The year is therefore the most reliable end-of-title
 * marker there is — far more so than trying to enumerate every quality tag
 * that might follow. Cut there when a year exists; fall back to the first
 * recognised metadata token when it does not.
 */
const NOISE = new RegExp(
  '\\b(' +
    '\\d{3,4}p|4k|uhd|' +
    's\\d{1,2}(e\\d{1,3})?|season|seasons|complete|' +
    'web[- ]?dl|webrip|web|bluray|blu[- ]?ray|bdrip|brrip|hdrip|hdtv|dvdrip|dvd9|dvd5|' +
    'remux|untouched|ntsc|pal|cam|hdcam|' +
    'x26[45]|h[- ]?26[45]|hevc|avc|xvid|divx|mpeg2|' +
    'ddp?\\d?|dts([- ]?hd)?|aac|ac3|eac3|atmos|truehd|flac|' +
    'hdr10?\\+?|dolby|dv|sdr|hybrid|repack|proper|extended|uncensored|' +
    'multi|dual[- ]?audio|esub|msub|' +
    '\\d+[- ]?film|collection|trilogy|duology|' +
    // Language/source words that trail a title once the year is gone.
    'hindi|english|tamil|telugu|marathi|bengali|punjabi|malayalam|kannada|' +
    'netflix|prime|hotstar|sonyliv|zee5|amzn|nf|hmax|dsnp' +
  ')\\b',
  'i'
);

// Underscores are word characters, so a naive \bseason never matches
// "..._Season_1_...". Everything below therefore runs on a separated form
// where . _ and - between words have become spaces.
function separatorsToSpaces(name) {
  let s = String(name).replace(/\.(mkv|mp4|avi|m4v|ts)$/i, '');

  // Release sites prepend their domain: "www.1TamilBlasters.garden - Title".
  // Done BEFORE dots become spaces so a real dotted domain is required —
  // matching bare TLD words after separator-flattening ate the title of
  // "Welcome to the Jungle" via the "to" in it.
  s = s.replace(/^\s*(?:www\.)?[\w-]+\.[a-z]{2,10}\s*-\s*/i, '');

  s = s.replace(/[._]+/g, ' ');

  // "S01Complete" glues the season marker to the next word, hiding it from
  // every \b-anchored pattern below.
  s = s.replace(/\b(s\d{1,2})(complete|comp)\b/gi, '$1 $2');

  return s.replace(/\s+/g, ' ').trim();
}

function cleanReleaseName(name) {
  let s = separatorsToSpaces(name);

  // Unwrap a bracketed year before brackets are discarded — "(2026)" is the
  // end-of-title marker, and dropping it first loses the best cut point.
  s = s.replace(/[[({]\s*((?:19|20)\d{2})(?:\s*-\s*(?:19|20)\d{2})?\s*[\])}]/g, ' $1 ');
  s = s.replace(/[[({].*?[\])}]/g, ' ');

  // Cut at the release year; otherwise at the first metadata token.
  const year = /\b(19\d{2}|20\d{2})\b/.exec(s);
  if (year && year.index > 0) {
    s = s.slice(0, year.index);
  }
  const noise = NOISE.exec(s);
  if (noise && noise.index > 0) s = s.slice(0, noise.index);

  // Trim before the trailing-word strips, or their `$` anchors never match.
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[-–—:~,]+$/, '').trim();
  // "Game of Thrones The Complete Seasons" cuts at "Complete", leaving a
  // stranded article that would break the TMDB lookup.
  s = s.replace(/\s+(the|a|an|of|and|in|on)$/i, '').trim();
  return s.replace(/[-–—:~,]+$/, '').trim();
}

/** Release year, if the name carries one. */
function extractYear(name) {
  const m = /\b(19\d{2}|20\d{2})\b/.exec(separatorsToSpaces(name));
  return m ? Number(m[1]) : null;
}

/** A season/episode marker means it is a series, whatever TMDB thinks. */
function looksLikeSeries(name) {
  const s = separatorsToSpaces(name);
  return /\bs\d{1,2}(e\d{1,3})?\b|\bseasons?\b|\bcomplete\b|\bepisodes?\b/i.test(s);
}

async function build() {
  if (!config.REALDEBRID_TOKEN) return { items: [], at: Date.now() };
  const t0 = Date.now();

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
  activityLog.catalogRefresh({ platform: 'realdebrid', itemsAdded: items.length, duration_ms: Date.now() - t0 });
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

module.exports = { getCatalog, build, cleanReleaseName, looksLikeSeries, extractYear };
