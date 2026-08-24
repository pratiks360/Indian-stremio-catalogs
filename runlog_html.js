'use strict';

/** Server-rendered HTML view of the run log — no client JS, no build step. */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRunLogPage(entries) {
  const rows = entries.map(entry => {
    const items = entry.added
      .map(it => `<li><a href="https://www.imdb.com/title/${esc(it.id)}/" target="_blank" rel="noopener">${esc(it.name)}</a> <span class="meta">${esc(it.type)}${it.year ? ' · ' + esc(it.year) : ''}</span></li>`)
      .join('');
    return `
      <section class="entry">
        <h2><span class="catalog">${esc(entry.catalog)}</span><time>${esc(entry.at)}</time></h2>
        <p class="count">${entry.added.length} added</p>
        <ul>${items}</ul>
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>India OTT Charts — Run Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .sub { color: #888; margin-top: -0.5rem; }
  .entry { border: 1px solid rgba(128,128,128,0.3); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .entry h2 { font-size: 1rem; margin: 0 0 0.25rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
  .catalog { font-weight: 600; }
  time { color: #888; font-weight: normal; font-size: 0.85rem; }
  .count { color: #888; font-size: 0.85rem; margin: 0 0 0.5rem; }
  ul { margin: 0; padding-left: 1.2rem; }
  li { margin: 0.15rem 0; }
  .meta { color: #888; font-size: 0.85rem; }
  a { color: inherit; }
  .empty { color: #888; }
</style>
</head>
<body>
  <h1>India OTT Charts — Run Log</h1>
  <p class="sub">Delta only — newly added titles per catalog refresh, newest first.</p>
  ${entries.length ? rows : '<p class="empty">No runs logged yet.</p>'}
</body>
</html>`;
}

module.exports = { renderRunLogPage };
