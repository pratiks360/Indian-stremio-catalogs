'use strict';
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dotenv dependency). KEY=VALUE, # comments, no quotes needed.
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();

const config = {
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
  TMDB_BASE: 'https://api.themoviedb.org/3',
  TMDB_IMAGE_BASE: 'https://image.tmdb.org/t/p/w500',

  // Everything India. We are geo-outside India, so force region on every call.
  REGION: 'IN',
  LANGUAGE: 'en-US',

  // Only English / Hindi / Marathi content is surfaced. Checked against TMDB
  // original_language (ISO 639-1). Anything else (ta, te, ml, kn, bn, ...) is
  // dropped from the ranking even if the platform charts it.
  ALLOWED_LANGUAGES: ['en', 'hi', 'mr'],

  PORT: Number(process.env.PORT || 7000),
  HOST: process.env.HOST || '127.0.0.1',

  // Cache TTLs (ms). Never refresh per-request.
  // All platforms refresh once every 24h. Netflix's Tudum feed only changes
  // weekly, and the others move slowly enough that a daily pull is plenty —
  // it also keeps us well clear of any rate limiting.
  TTL: {
    netflix: 24 * 60 * 60 * 1000,
    primevideo: 24 * 60 * 60 * 1000,
    zee5: 24 * 60 * 60 * 1000,
    jiohotstar: 24 * 60 * 60 * 1000,
    sonyliv: 24 * 60 * 60 * 1000,
    // Title -> IMDb resolution barely changes. Hold it a long time.
    tmdbResolve: 7 * 24 * 60 * 60 * 1000
  },

  // TMDB is a HYDRATION source only: name -> imdb_id, poster, language.
  // It must never invent the ranking. When a platform scraper fails we serve
  // an empty catalog and log loudly, rather than substituting TMDB Discover
  // results that were never on that platform's chart.
  ALLOW_DISCOVER_FALLBACK: false,

  // TMDB Discover watch-provider ids (watch_region=IN). Used for the
  // availability tiebreak on ambiguous titles, and only as a title source if
  // ALLOW_DISCOVER_FALLBACK is explicitly turned on.
  WATCH_PROVIDERS: {
    netflix: 8,
    primevideo: 119, // Amazon Prime Video (subscription). 9 = Amazon Video (rent/buy) — not us.
    // Verified against /watch/providers/{movie,tv}?watch_region=IN
    zee5: 232,        // "Zee5"
    jiohotstar: 2336, // "JioHotstar" (post JioCinema/Hotstar merger)
    sonyliv: 237      // "Sony Liv"
  },

  // How far back the Discover fallback looks. Keeps "trending" meaning
  // recent rather than all-time-popular catalog filler.
  DISCOVER_WINDOW_MONTHS: 18,

  MAX_ITEMS: 30,
  TMDB_CONCURRENCY: 2
};

if (!config.TMDB_API_KEY) {
  console.warn('[config] TMDB_API_KEY missing. Copy .env.example to .env and fill it in.');
}

module.exports = config;
