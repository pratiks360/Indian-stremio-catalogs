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

function pct(n, d) {
  return d ? Math.round((n / d) * 100) + '%' : '—';
}

function avg(nums) {
  const vals = nums.filter(n => typeof n === 'number' && !Number.isNaN(n));
  if (!vals.length) return '—';
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + 'ms';
}

/**
 * Headline numbers computed from the same (already-capped, latest-first)
 * buckets the tabs render — a quick read on "is this healthy right now"
 * before digging into individual rows.
 */
function computeSummary(buckets) {
  const searches = buckets.stream_search || [];
  const fetches = buckets.torrent_fetch || [];
  const rd = buckets.rd_action || [];
  const local = buckets.local_seed || [];

  const todayCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const isToday = e => {
    const t = Date.parse(e.timestamp);
    return !Number.isNaN(t) && t >= todayCutoff;
  };
  const searchesToday = searches.filter(isToday);

  const failedFetchesByIndexer = {};
  for (const f of fetches) {
    if (f.success) continue;
    const key = f.indexer || 'unknown';
    failedFetchesByIndexer[key] = (failedFetchesByIndexer[key] || 0) + 1;
  }
  let worstIndexer = null;
  for (const [name, count] of Object.entries(failedFetchesByIndexer)) {
    if (!worstIndexer || count > worstIndexer.count) worstIndexer = { name, count };
  }

  return [
    { label: 'Searches (24h)', value: String(searchesToday.length) },
    { label: 'Search success', value: pct(searches.filter(e => e.success).length, searches.length) },
    { label: 'Avg fetch time', value: avg(fetches.map(e => e.duration_ms)) },
    { label: 'Fetch success', value: pct(fetches.filter(e => e.success).length, fetches.length) },
    { label: 'Worst indexer', value: worstIndexer ? `${esc(worstIndexer.name)} (${worstIndexer.count} fail)` : '—' },
    { label: 'RD actions', value: String(rd.length) },
    { label: 'Local-seed events', value: String(local.length) }
  ];
}

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

  const summaryCards = computeSummary(buckets).map(s =>
    `<div class="card"><div class="card-value">${s.value}</div><div class="card-label">${esc(s.label)}</div></div>`
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
  .summary { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .card { background: rgba(128,128,128,0.08); border: 1px solid rgba(128,128,128,0.15); border-radius: 8px; padding: 0.7rem 1rem; min-width: 110px; }
  .card-value { font-size: 1.3rem; font-weight: 700; }
  .card-label { color: #888; font-size: 0.75rem; margin-top: 0.15rem; }
</style>
</head>
<body>
  <h1>India OTT Charts — Activity Log</h1>
  <p class="sub">Latest 100 events per tab, newest first. 7-day retention.</p>
  <div class="summary">${summaryCards}</div>
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
