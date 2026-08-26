'use strict';

/** Server-rendered HTML view of the run log, organized by catalog (platform/type). */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRunLogPage(entries) {
  // Group by catalog key, newest entry per key
  const byKey = new Map();
  for (const entry of entries) {
    if (!byKey.has(entry.catalog)) {
      byKey.set(entry.catalog, entry);
    }
  }

  // Organize by platform name
  const platformNames = {
    'platform:netflix': 'Netflix India',
    'platform:primevideo': 'Amazon Prime Video India',
    'platform:zee5': 'ZEE5 India',
    'platform:jiohotstar': 'JioHotstar India',
    'platform:sonyliv': 'SonyLIV India'
  };

  const catalogSections = [];

  // 5 platforms, each with movie/series/trending
  for (const [key, name] of Object.entries(platformNames)) {
    const platform = key.split(':')[1];
    const platformSection = [];

    for (const type of ['movie', 'series', 'trending']) {
      const catalogKey = `${key}-${type}`;
      const entry = byKey.get(catalogKey);
      if (!entry) continue;

      const typeLabel = type === 'movie' ? 'Top Movies' : type === 'series' ? 'Top Shows' : 'Trending';
      const strategyLabel = type === 'trending' ? ' (Daily Delta)' : ' (Accumulated)';
      const items = entry.added
        .map(it => `<li><a href="https://www.imdb.com/title/${esc(it.id)}/" target="_blank" rel="noopener">${esc(it.name)}</a> <span class="meta">${esc(it.type)}${it.year ? ' · ' + esc(it.year) : ''}</span></li>`)
        .join('');

      platformSection.push(`
        <div class="subcat">
          <h3>${typeLabel}${strategyLabel}</h3>
          <p class="count">${entry.added.length} new</p>
          <time>${entry.at}</time>
          <ul>${items || '<li class="none">None</li>'}</ul>
        </div>`);
    }

    if (platformSection.length) {
      catalogSections.push(`
        <section class="platform">
          <h2>${name}</h2>
          ${platformSection.join('')}
        </section>`);
    }
  }

  // Marathi Latest Releases
  const marathiMovie = byKey.get('lang:marathi-latest-movie');
  const marathiSeries = byKey.get('lang:marathi-latest-series');
  if (marathiMovie || marathiSeries) {
    const subs = [];
    if (marathiMovie) {
      const items = marathiMovie.added
        .map(it => `<li><a href="https://www.imdb.com/title/${esc(it.id)}/" target="_blank" rel="noopener">${esc(it.name)}</a> <span class="meta">${esc(it.type)}${it.year ? ' · ' + esc(it.year) : ''}</span></li>`)
        .join('');
      subs.push(`
        <div class="subcat">
          <h3>Movies (Accumulated)</h3>
          <p class="count">${marathiMovie.added.length} new</p>
          <time>${marathiMovie.at}</time>
          <ul>${items}</ul>
        </div>`);
    }
    if (marathiSeries) {
      const items = marathiSeries.added
        .map(it => `<li><a href="https://www.imdb.com/title/${esc(it.id)}/" target="_blank" rel="noopener">${esc(it.name)}</a> <span class="meta">${esc(it.type)}${it.year ? ' · ' + esc(it.year) : ''}</span></li>`)
        .join('');
      subs.push(`
        <div class="subcat">
          <h3>Series (Accumulated)</h3>
          <p class="count">${marathiSeries.added.length} new</p>
          <time>${marathiSeries.at}</time>
          <ul>${items}</ul>
        </div>`);
    }
    catalogSections.push(`
      <section class="platform">
        <h2>Marathi — Latest Releases</h2>
        ${subs.join('')}
      </section>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>India OTT Charts — Run Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .sub { color: #888; margin-top: -0.5rem; margin-bottom: 2rem; }
  .platform { margin: 2rem 0; }
  .platform h2 { font-size: 1.1rem; margin: 0 0 1rem; border-bottom: 2px solid rgba(128,128,128,0.2); padding-bottom: 0.5rem; }
  .subcat { margin-left: 1.5rem; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(128,128,128,0.1); }
  .subcat h3 { font-size: 0.95rem; margin: 0 0 0.25rem; }
  .count { color: #888; font-size: 0.85rem; margin: 0.25rem 0; }
  time { color: #888; font-size: 0.8rem; }
  ul { margin: 0.5rem 0 0; padding-left: 1.2rem; }
  li { margin: 0.1rem 0; font-size: 0.95rem; }
  li.none { color: #888; }
  .meta { color: #888; font-size: 0.8rem; }
  a { color: inherit; }
  .empty { color: #888; }
</style>
</head>
<body>
  <h1>India OTT Charts — Run Log</h1>
  <p class="sub">Latest additions from each catalog. Movies/Shows/Marathi accumulate; Trending refreshes daily.</p>
  ${catalogSections.length ? catalogSections.join('') : '<p class="empty">No runs logged yet.</p>'}
</body>
</html>`;
}

module.exports = { renderRunLogPage };
