'use strict';

/** Server-rendered tabbed HTML view of activity-log.js's buckets. */

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ok(v) {
  return v ? '<span class="yes">&#10003;</span>' : '<span class="no">&#10007;</span>';
}

const TABS = [
  {
    key: 'stream_search',
    label: 'Streams',
    cols: ['Time', 'Title', 'Type', 'Prowlarr Query', '# Results', 'Results', 'Success'],
    row: e => [
      esc(e.timestamp), esc(e.title), esc(e.searchType), esc(e.prowlarrQuery),
      esc(e.releaseCount),
      esc(Array.isArray(e.releases) ? e.releases.join(', ') : ''),
      ok(e.success)
    ]
  },
  {
    key: 'user_click',
    label: 'Clicks',
    cols: ['Time', 'Release', 'Indexer', 'InfoHash', 'Delivery'],
    row: e => [esc(e.timestamp), esc(e.releaseTitle), esc(e.indexer), esc(e.infoHash), esc(e.deliveryPath)]
  },
  {
    key: 'torrent_fetch',
    label: 'Fetches',
    cols: ['Time', 'Release', 'Indexer', 'Success', 'Duration (ms)', 'Error'],
    row: e => [esc(e.timestamp), esc(e.releaseTitle), esc(e.indexer), ok(e.success), esc(e.duration_ms), esc(e.errorMsg)]
  },
  {
    key: 'catalog_refresh',
    label: 'Catalog Refreshes',
    cols: ['Time', 'Platform', 'Items Added', 'Duration (ms)'],
    row: e => [esc(e.timestamp), esc(e.platform), esc(e.itemsAdded), esc(e.duration_ms)]
  },
  {
    key: 'rd_action',
    label: 'RD Actions',
    cols: ['Time', 'Action', 'Torrent Hash', 'Status', 'Success', 'Duration (ms)'],
    row: e => [esc(e.timestamp), esc(e.action), esc(e.torrentHash), esc(e.status), ok(e.success), esc(e.duration_ms)]
  },
  {
    key: 'local_seed',
    label: 'Local Seed',
    cols: ['Time', 'Release', 'Phase', 'Success', 'Duration (ms)', 'Error'],
    row: e => [esc(e.timestamp), esc(e.releaseTitle), esc(e.phase), ok(e.success), esc(e.duration_ms), esc(e.errorMsg)]
  }
];

function renderActivityPage(buckets) {
  const panels = TABS.map((tab, i) => {
    const rows = buckets[tab.key] || [];
    const thead = `<tr>${tab.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
    const tbody = rows.length
      ? rows.map(e => `<tr>${tab.row(e).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="none" colspan="${tab.cols.length}">No events yet</td></tr>`;

    return `
      <section class="panel" id="panel-${tab.key}" ${i === 0 ? '' : 'hidden'}>
        <p class="count">${rows.length} event${rows.length === 1 ? '' : 's'} (latest first)</p>
        <div class="tablewrap">
          <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
        </div>
      </section>`;
  }).join('');

  const tabButtons = TABS.map((tab, i) =>
    `<button class="tabbtn${i === 0 ? ' active' : ''}" data-target="panel-${tab.key}">${esc(tab.label)}</button>`
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>India OTT Charts — Activity Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .sub { color: #888; margin-top: -0.5rem; margin-bottom: 1.5rem; }
  .tabs { display: flex; gap: 0.5rem; flex-wrap: wrap; border-bottom: 2px solid rgba(128,128,128,0.2); margin-bottom: 1rem; }
  .tabbtn { background: none; border: none; padding: 0.6rem 1rem; font-size: 0.95rem; cursor: pointer; color: inherit; opacity: 0.6; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tabbtn.active { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
  .count { color: #888; font-size: 0.85rem; margin: 0 0 0.5rem; }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid rgba(128,128,128,0.15); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  th { color: #888; font-weight: 600; }
  td.none { color: #888; text-align: center; white-space: normal; }
  .yes { color: #2e9e44; }
  .no { color: #c0392b; }
</style>
</head>
<body>
  <h1>India OTT Charts — Activity Log</h1>
  <p class="sub">Latest 100 events per tab, newest first. 7-day retention.</p>
  <div class="tabs">${tabButtons}</div>
  ${panels}
  <script>
    document.querySelectorAll('.tabbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tabbtn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.hidden = true);
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).hidden = false;
      });
    });
  </script>
</body>
</html>`;
}

module.exports = { renderActivityPage };
