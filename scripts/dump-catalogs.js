'use strict';

/**
 * Boot-free dump of exactly what each advertised catalog hands Stremio.
 * Uses the same code path as the catalog handler.
 */

const { manifest } = require('../addon');
const { getCatalog } = require('../catalog');

(async () => {
  for (const c of manifest.catalogs) {
    const [, platformId, type] = /^iott-(.+)-(movie|series)$/.exec(c.id);
    const { metas, origin } = await getCatalog(platformId, type);
    console.log(`\n### ${c.name}  [${c.id}]  origin=${origin}  count=${metas.length}`);
    for (const m of metas) {
      const rank = (m.description.match(/^#(\d+)/) || [])[1] || '?';
      console.log(
        `  #${String(rank).padEnd(3)} ${m.id.padEnd(12)} ${String(m.releaseInfo || '----').padEnd(5)} ` +
        `${m.name.slice(0, 44).padEnd(45)} poster=${m.poster ? 'y' : 'NO'}`
      );
    }
  }

  console.log('\n--- one full meta object as sent to Stremio ---');
  const first = await getCatalog('netflix', 'movie');
  console.log(JSON.stringify(first.metas[0], null, 2));
  process.exit(0);
})();
