'use strict';

/**
 * Probe ZEE5 category/listing pages for a rail that's an actual
 * trending/most-watched chart rather than the homepage's promotional
 * carousel. Uses Node's fetch — curl gets Akamai-fingerprint-blocked (403)
 * on these paths even with an identical header set, confirmed live.
 */

const { browserHeaders, fetchWithRetry, extractNextData } = require('../lib/http');

const URLS = [
  'https://www.zee5.com/movies',
  'https://www.zee5.com/web-series',
  'https://www.zee5.com/tv-shows',
  'https://www.zee5.com/trending',
  'https://www.zee5.com/movies/language/hindi',
  'https://www.zee5.com/web-series/language/hindi'
];

(async () => {
  for (const url of URLS) {
    console.log(`\n=== ${url} ===`);
    try {
      const html = await fetchWithRetry(
        url,
        { headers: browserHeaders({ referer: 'https://www.zee5.com/' }) },
        { label: 'zee5-probe', retries: 2, minBytes: 1000 }
      );
      console.log('  size:', html.length);

      let data;
      try {
        data = extractNextData(html);
      } catch (e) {
        console.log('  no __NEXT_DATA__:', e.message);
        continue;
      }

      const pp = (data.props || {}).pageProps || {};
      console.log('  pageProps keys:', Object.keys(pp));

      const cd = pp.collectionData;
      if (cd && Array.isArray(cd.rails)) {
        console.log(`  collectionData id=${cd.id} rails=${cd.rails.length}`);
        for (const r of cd.rails.slice(0, 15)) {
          const n = (r.contents || []).length;
          console.log(
            `    - ${(r.title || '').slice(0, 50).padEnd(50)} items=${n} ` +
            `sortType=${r.sortType} url=${r.url}`
          );
        }
      } else {
        for (const [k, v] of Object.entries(pp)) {
          if (v && typeof v === 'object' && ('rails' in v || 'contents' in v)) {
            console.log(`  candidate key "${k}":`, Object.keys(v).slice(0, 10));
          }
        }
      }
    } catch (err) {
      console.log('  fetch failed:', err.message);
    }
  }
})();
