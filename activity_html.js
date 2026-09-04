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
    cols: ['Time', 'Release', 'Phase', 'Seeded', 'Success', 'Duration (ms)', 'Error'],
    row: e => [
      esc(e.timestamp), esc(e.releaseTitle), esc(e.phase), fmtSeeded(e),
      ok(e.success), esc(e.duration_ms), esc(e.errorMsg)
    ]
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

function fmtBytes(n) {
  if (!n) return '0 MB';
  const gb = n / 1073741824;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(n / 1048576)} MB`;
}

/**
 * "Seeded" cell for local_seed rows: MB uploaded to torrent peers + the
 * share of verified downloaded bytes that was re-seeded (tracker-ratio
 * sense), snapshot at event time by lib/localseed.js's seedSnapshot().
 * '—' when the event carried no live torrent (mount serve after the seed
 * window ended, etc.) or nothing had been downloaded yet (no ratio basis).
 */
function fmtSeeded(e) {
  if (e.uploadedBytes == null && e.downloadedBytes == null) return '—';
  const pct = e.downloadedBytes > 0
    ? (e.ratioPct != null ? `${e.ratioPct}%` : `${Math.round((e.uploadedBytes / e.downloadedBytes) * 100)}%`)
    : '—';
  return `${pct} · ${fmtBytes(e.uploadedBytes)}`;
}

function fmtSpeed(bps) {
  if (!bps) return '0 KB/s';
  const mb = bps / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

function fmtAgo(ms) {
  if (!ms) return '—';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Builds the unified "Files" panel: still-downloading VPS torrents
 * (listActive()) and finished files on the Drive mount (listMounted()) in
 * one table, a Location column telling them apart, and a checkbox + bulk
 * delete button that hits POST /admin/delete-file for each selected row.
 */
function renderFilesPanel(active, mounted, capBytes, isActiveTab) {
  const cols = ['', 'File', 'Location', 'Size', 'Status'];
  const thead = `<tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;

  const activeRows = active.map(t => `<tr>
      <td><input type="checkbox" class="filerow" data-location="vps" data-id="${esc(t.infoHash)}"></td>
      <td>${esc(t.title)}</td>
      <td><span class="loc loc-vps">VPS</span></td>
      <td>${fmtBytes(t.downloadedBytes)} / ${fmtBytes(t.totalBytes)}</td>
      <td>${t.progressPct}% · ${fmtSpeed(t.downloadSpeedBps)} · ${esc(t.peers)}p</td>
    </tr>`);

  const mountedRows = mounted.map(m => `<tr>
      <td><input type="checkbox" class="filerow" data-location="gdrive" data-id="${esc(m.file)}"></td>
      <td>${esc(m.releaseTitle || m.file)}</td>
      <td><span class="loc loc-gdrive">GDrive</span></td>
      <td>${fmtBytes(m.sizeBytes)}</td>
      <td>played ${fmtAgo(m.lastPlayed)}</td>
    </tr>`);

  const rows = [...activeRows, ...mountedRows];
  const tbody = rows.length
    ? rows.join('')
    : `<tr><td class="none" colspan="${cols.length}">No files downloading or on the Drive mount</td></tr>`;

  const totalBytes = mounted.reduce((a, m) => a + (m.sizeBytes || 0), 0);
  const usage = capBytes
    ? ` · ${fmtBytes(totalBytes)} / ${fmtBytes(capBytes)} cap on Drive (${Math.round(totalBytes / capBytes * 100)}%)`
    : ` · ${fmtBytes(totalBytes)} on Drive`;

  return `
    <section class="panel" id="panel-files" ${isActiveTab ? '' : 'hidden'}>
      <p class="count">${active.length} downloading (VPS) · ${mounted.length} on Drive${usage}</p>
      <button class="refreshbtn" id="filesDeleteBtn" disabled>Delete selected</button>
      <div class="tablewrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>
    </section>`;
}

/** Builds the "Friend Recommendations" paste-box section, plus the current list. */
function renderFriendRecsSection(items) {
  const rows = items
    .slice()
    .sort((a, b) => b.addedAt - a.addedAt)
    .map(it => `<li>
        <input type="hidden" class="frid" value="${esc(it.imdb_id)}">
        <input type="hidden" class="frtype" value="${esc(it.type)}">
        ${esc(it.name)} <span class="count">(${esc(it.type)}${it.year ? `, ${esc(it.year)}` : ''})</span>
        <button class="frdel" data-imdb="${esc(it.imdb_id)}" data-type="${esc(it.type)}" title="Remove">&times;</button>
      </li>`)
    .join('');

  return `
    <section class="friendrecs">
      <h2>Friend Recommendations</h2>
      <p class="sub">One title, IMDb id (tt1234567), or IMDb URL per line. Feeds the "Friend Recommendations" catalog.</p>
      <textarea id="friendRecsInput" rows="4" placeholder="Sacred Games&#10;tt1234567&#10;https://www.imdb.com/title/tt7366338/"></textarea>
      <div>
        <button class="refreshbtn" id="friendRecsSubmit">Add to catalog</button>
        <span class="refreshstatus" id="friendRecsStatus"></span>
      </div>
      ${items.length ? `<ul class="frlist">${rows}</ul>` : '<p class="count">Nothing added yet</p>'}
    </section>`;
}

/**
 * @param {object} buckets activityLog.readAll()'s per-type event buckets
 * @param {{enabled:boolean, active:Array, mounted:Array}} [localseedInfo]
 *   Live local-seed state (not log events) — omitted/disabled when the
 *   Drive mount isn't configured on this box.
 * @param {Array} [friendRecsItems] lib/friend_recs.js's list() — omitted defaults to empty.
 */
function renderActivityPage(buckets, localseedInfo, friendRecsItems) {
  const ls = localseedInfo && localseedInfo.enabled ? localseedInfo : null;

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
  }).join('')
    + (ls ? renderFilesPanel(ls.active, ls.mounted, ls.capBytes, false) : '');

  const tabButtons = TABS.map((tab, i) =>
    `<button class="tabbtn${i === 0 ? ' active' : ''}" data-target="panel-${tab.key}">${esc(tab.label)}</button>`
  ).join('')
    + (ls ? `<button class="tabbtn" data-target="panel-files">Files</button>` : '');

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
  .toprow { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 0.5rem; }
  .refreshbtn { background: rgba(128,128,128,0.12); border: 1px solid rgba(128,128,128,0.25); border-radius: 6px; padding: 0.5rem 0.9rem; font-size: 0.85rem; cursor: pointer; color: inherit; }
  .refreshbtn:hover { background: rgba(128,128,128,0.2); }
  .refreshbtn:disabled { opacity: 0.5; cursor: default; }
  .refreshstatus { font-size: 0.8rem; color: #888; margin-top: 0.35rem; }
  #filesDeleteBtn { margin-bottom: 0.6rem; }
  .loc { font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 600; }
  .loc-vps { background: rgba(52,152,219,0.18); color: #3498db; }
  .loc-gdrive { background: rgba(46,158,68,0.18); color: #2e9e44; }
  .friendrecs { border: 1px solid rgba(128,128,128,0.2); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .friendrecs h2 { font-size: 1.05rem; margin: 0 0 0.2rem; }
  .friendrecs textarea { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 0.85rem; padding: 0.5rem; margin: 0.5rem 0; border-radius: 6px; border: 1px solid rgba(128,128,128,0.3); background: transparent; color: inherit; }
  .frlist { list-style: none; padding: 0; margin: 0.75rem 0 0; font-size: 0.85rem; }
  .frlist li { padding: 0.3rem 0; border-bottom: 1px solid rgba(128,128,128,0.1); display: flex; align-items: center; gap: 0.5rem; }
  .frdel { margin-left: auto; background: none; border: none; color: #c0392b; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 0.3rem; }
</style>
</head>
<body>
  <div class="toprow">
    <div>
      <h1>India OTT Charts — Activity Log</h1>
      <p class="sub">Latest 100 events per tab, newest first. 7-day retention.</p>
    </div>
    <div>
      <button class="refreshbtn" id="refreshBtn">↻ Refresh catalogs now</button>
      <p class="refreshstatus" id="refreshStatus"></p>
    </div>
  </div>
  <div class="summary">${summaryCards}</div>
  ${renderFriendRecsSection(friendRecsItems || [])}
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

    document.getElementById('refreshBtn').addEventListener('click', async () => {
      const btn = document.getElementById('refreshBtn');
      const status = document.getElementById('refreshStatus');
      btn.disabled = true;
      status.textContent = 'Refreshing…';
      try {
        const res = await fetch('/admin/refresh-catalogs', { method: 'POST' });
        const body = await res.json();
        status.textContent = res.ok
          ? 'Done — reload the page to see updated catalogs.'
          : 'Failed: ' + (body.error || res.status);
      } catch (err) {
        status.textContent = 'Failed: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    });

    const frSubmit = document.getElementById('friendRecsSubmit');
    if (frSubmit) {
      frSubmit.addEventListener('click', async () => {
        const input = document.getElementById('friendRecsInput');
        const status = document.getElementById('friendRecsStatus');
        const text = input.value.trim();
        if (!text) return;
        frSubmit.disabled = true;
        status.textContent = 'Resolving…';
        try {
          const res = await fetch('/admin/friend-recs', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: text
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || res.status);
          status.textContent = \`Added \${body.added.length}, skipped \${body.skipped.length}.\`;
          if (body.added.length) { input.value = ''; window.location.reload(); }
        } catch (err) {
          status.textContent = 'Failed: ' + err.message;
        } finally {
          frSubmit.disabled = false;
        }
      });
    }

    document.querySelectorAll('.frdel').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await fetch(\`/admin/friend-recs/delete?imdb_id=\${encodeURIComponent(btn.dataset.imdb)}&type=\${encodeURIComponent(btn.dataset.type)}\`, { method: 'POST' });
          window.location.reload();
        } catch { btn.disabled = false; }
      });
    });

    const filesDeleteBtn = document.getElementById('filesDeleteBtn');
    if (filesDeleteBtn) {
      document.querySelectorAll('.filerow').forEach(cb => {
        cb.addEventListener('change', () => {
          filesDeleteBtn.disabled = !document.querySelector('.filerow:checked');
        });
      });
      filesDeleteBtn.addEventListener('click', async () => {
        const checked = [...document.querySelectorAll('.filerow:checked')];
        if (!checked.length) return;
        if (!confirm(\`Delete \${checked.length} file(s)? This cannot be undone.\`)) return;
        filesDeleteBtn.disabled = true;
        filesDeleteBtn.textContent = 'Deleting…';
        for (const cb of checked) {
          const loc = cb.dataset.location, id = cb.dataset.id;
          try {
            await fetch(\`/admin/delete-file?location=\${encodeURIComponent(loc)}&id=\${encodeURIComponent(id)}\`, { method: 'POST' });
          } catch { /* best-effort — reload shows whatever actually happened */ }
        }
        window.location.reload();
      });
    }
  </script>
</body>
</html>`;
}

module.exports = { renderActivityPage };
