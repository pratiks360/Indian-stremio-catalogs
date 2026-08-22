'use strict';

/**
 * Run one platform's scraper (and optionally the full hydrate pipeline)
 * and print what came back. Exists so we can drive tests over ssh without
 * fighting shell quoting.
 *
 *   node scripts/test-source.js zee5
 *   node scripts/test-source.js zee5 --full
 */

const platformId = process.argv[2];
const full = process.argv.includes('--full');

if (!platformId) {
  console.error('usage: node scripts/test-source.js <platform> [--full]');
  process.exit(1);
}

(async () => {
  try {
    if (full) {
      const { build } = require('../catalog');
      const payload = await build(platformId);
      console.log(`\n=== ${platformId} | origin: ${payload.origin} | items: ${payload.items.length} ===`);
      for (const type of ['movie', 'series']) {
        const rows = payload.items.filter(i => i.type === type);
        console.log(`\n-- ${type} (${rows.length}) --`);
        console.table(rows.slice(0, 15).map(i => ({
          rank: i.rank, name: i.name, lang: i.language, year: i.year, imdb: i.imdb_id
        })));
      }
    } else {
      const source = require(`../sources/${platformId}`);
      const items = await source.getTrending();
      console.log(`\n=== ${platformId} raw ranking: ${items.length} items ===`);
      console.table(items.slice(0, 25).map(i => ({
        rank: i.rank,
        type: i.type,
        title: i.title,
        year: i.year,
        langs: (i.languages || []).join(','),
        rail: (i.rail || '').slice(0, 28)
      })));
    }
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  }
})();
