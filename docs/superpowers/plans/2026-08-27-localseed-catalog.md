# VPS/Drive Downloaded Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "VPS/Drive Downloaded" Stremio catalog listing titles already downloaded and moved onto the local-seed Google Drive mount, so a user can browse straight to a replay without re-searching.

**Architecture:** Extend `localseed_state.js`'s sidecar entries with a `releaseTitle` field (set when a download completes). New `lib/localseed_catalog.js`, structurally identical to the existing `debrid_catalog.js`, reads only `status: 'mounted'` sidecar entries, resolves each to TMDB/IMDb by reusing `debrid_catalog.js`'s existing title-cleaning exports, and returns Stremio metas. Two new catalog entries wired into `addon.js` exactly like `iott-debrid-cached` already is.

**Tech Stack:** Node.js (existing modules only — no new dependencies).

## Global Constraints

- Only `status: 'mounted'` entries appear — a title still downloading (`status: 'local'`) is excluded, per the spec.
- Catalog is not advertised at all when `localseed.isEnabled()` is false (no Drive mount configured) — same gating pattern `REALDEBRID_TOKEN` already uses.
- Evicted titles disappear automatically — no new eviction-tracking code; this task relies entirely on `sweepEviction()`'s existing `state.remove()` call.
- No playback-completion auto-delete — explicitly declined in the spec; out of scope for this plan.
- Reuse `debrid_catalog.js`'s exported `cleanReleaseName`, `looksLikeSeries`, `extractYear` rather than duplicating that logic.
- Cache TTL: reuse `config.TTL.rdTorrents` (5 minutes), matching `debrid_catalog.js`'s own cadence.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/localseed_state.js` (modify) | No signature change — `touch()` already accepts arbitrary fields; callers now pass `releaseTitle` too |
| `lib/localseed.js` (modify) | `moveToMount()` and the local-download `state.touch()` call now include `releaseTitle` |
| `lib/localseed_catalog.js` (new) | Reads mounted sidecar entries, resolves to TMDB/IMDb, returns `{metas, origin}` |
| `addon.js` (modify) | New `iott-localseed-movie` / `iott-localseed-series` catalog entries + handler routing |

---

### Task 1: Carry `releaseTitle` into the sidecar

**Files:**
- Modify: `lib/localseed.js`

**Interfaces:**
- Consumes: `state.touch(storePath, infoHash, fields)` (existing, from `lib/localseed_state.js` — already accepts arbitrary fields, no change needed there)
- Produces: sidecar entries now carry `releaseTitle` — consumed by Task 2's `lib/localseed_catalog.js`

- [ ] **Step 1: Add `releaseTitle` to both existing `state.touch()` calls**

In `lib/localseed.js`, find this line inside `streamRelease()` (after `waitForFileSelectable`):

```js
  state.touch(STATE_PATH, infoHash, { lastPlayed: Date.now(), status: 'local' });
```

Replace with:

```js
  state.touch(STATE_PATH, infoHash, { lastPlayed: Date.now(), status: 'local', releaseTitle: title });
```

Then find this line inside `moveToMount()`:

```js
  state.touch(STATE_PATH, infoHash, { size: largest.length, lastPlayed: Date.now(), status: 'mounted' });
```

Replace with:

```js
  state.touch(STATE_PATH, infoHash, { size: largest.length, lastPlayed: Date.now(), status: 'mounted', releaseTitle: title });
```

- [ ] **Step 2: Verify with a smoke test against a temp sidecar path**

```bash
node -e "
const path = require('path');
const os = require('os');
const state = require('./lib/localseed_state');
const tmp = path.join(os.tmpdir(), 'localseed_catalog_smoke_' + Date.now() + '.json');
state.touch(tmp, 'HASH1', { lastPlayed: Date.now(), status: 'mounted', releaseTitle: 'Musafir Cafe S01 1080p WEBRip' });
const rows = state.list(tmp);
console.log(rows[0].releaseTitle === 'Musafir Cafe S01 1080p WEBRip' && rows[0].status === 'mounted' ? 'PASS' : 'FAIL');
require('fs').unlinkSync(tmp);
"
```

Expected: `PASS`.

- [ ] **Step 3: Syntax check and commit**

```bash
node -c lib/localseed.js && echo OK
git add lib/localseed.js
git commit -m "Carry releaseTitle into local-seed sidecar entries"
```

---

### Task 2: `lib/localseed_catalog.js`

**Files:**
- Create: `lib/localseed_catalog.js`

**Interfaces:**
- Consumes:
  - `localseed_state.list(storePath)` (existing) → `Array<{infoHash, size, lastPlayed, status, releaseTitle}>`
  - `localseed.mountReady()`, `localseed.isEnabled()` (existing, from `lib/localseed.js`)
  - `cleanReleaseName`, `looksLikeSeries`, `extractYear` (existing, exported from `debrid_catalog.js`)
  - `tmdb.resolve({title, type, year})` (existing, from `tmdb.js` — same call `debrid_catalog.js` already makes)
  - `cache.get(key, ttlMs, producer)` (existing, from `cache.js`)
  - `config.TTL.rdTorrents`, `config.MAX_ITEMS` (existing, from `config.js`)
- Produces:
  - `getCatalog(type) -> Promise<{metas:Array, origin:string}>` — consumed by Task 3's `addon.js` wiring

- [ ] **Step 1: Write the implementation**

Create `lib/localseed_catalog.js`:

```js
'use strict';

/**
 * "VPS/Drive Downloaded": titles already downloaded via the local-seed
 * feature and moved onto the Google Drive mount, so they can be browsed
 * and replayed without re-searching. Structurally mirrors debrid_catalog.js
 * — same TMDB-resolution reuse, same cache-then-map-to-metas shape.
 *
 * Only status:'mounted' sidecar entries are listed (not still-downloading
 * ones — those aren't yet reliably instant-replayable), and an entry that
 * gets evicted (sweepEviction() in lib/localseed.js removes it from the
 * sidecar) simply stops appearing on the next read — no separate
 * eviction-tracking needed here.
 */

const path = require('path');
const config = require('../config');
const cache = require('../cache');
const tmdb = require('../tmdb');
const localseedState = require('./localseed_state');
const localseed = require('./localseed');
const { cleanReleaseName, looksLikeSeries, extractYear } = require('../debrid_catalog');

// lib/localseed_catalog.js lives in lib/, but data/ is at the repo root —
// same '..' walk lib/localseed.js's own STATE_PATH already uses.
const STATE_PATH = path.join(__dirname, '..', 'data', 'localseed_meta.json');

async function build() {
  if (!localseed.isEnabled()) return { items: [], at: Date.now() };

  const mounted = localseedState.list(STATE_PATH).filter(e => e.status === 'mounted');

  const items = [];
  for (const entry of mounted) {
    const raw = entry.releaseTitle || '';
    const title = cleanReleaseName(raw);
    if (!title) continue;

    const type = looksLikeSeries(raw) ? 'series' : 'movie';

    let resolved;
    try {
      resolved = await tmdb.resolve({ title, type, year: extractYear(raw) });
    } catch (err) {
      console.warn(`[localseed-catalog] TMDB resolve failed for "${title}": ${err.message}`);
      continue;
    }
    if (!resolved || !resolved.imdb_id) {
      console.log(`[localseed-catalog] unresolved: "${raw.slice(0, 60)}" -> "${title}"`);
      continue;
    }

    items.push({
      ...resolved,
      type,
      lastPlayed: entry.lastPlayed || 0,
      releaseTitle: raw
    });
  }

  console.log(`[localseed-catalog] ${items.length}/${mounted.length} mounted downloads resolved`);
  return { items, at: Date.now() };
}

/** @returns {Promise<{metas:Array, origin:string}>} */
async function getCatalog(type) {
  if (!localseed.isEnabled()) return { metas: [], origin: 'unconfigured' };

  const payload = await cache.get('catalog:localseed', config.TTL.rdTorrents, build);

  const metas = payload.items
    .filter(it => !type || it.type === type)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, config.MAX_ITEMS)
    .map(toMeta);

  return { metas, origin: 'localseed' };
}

function toMeta(item) {
  return {
    id: item.imdb_id,
    type: item.type,
    name: item.name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: `Downloaded on your VPS, ready to play instantly from Google Drive.\n\n${item.releaseTitle}`,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

module.exports = { getCatalog, build };
```

- [ ] **Step 2: Verify without a real mount (graceful empty result)**

```bash
node -e "
const c = require('./lib/localseed_catalog');
c.getCatalog('movie').then(r => {
  console.log(JSON.stringify(r));
  console.log(r.origin === 'unconfigured' && r.metas.length === 0 ? 'PASS: empty when disabled' : 'FAIL');
});
"
```

Expected: `PASS: empty when disabled` (no `/mnt/gdrive` on a dev machine, so `localseed.isEnabled()` is false).

- [ ] **Step 3: Verify resolution logic against a fake sidecar (mount presence simulated)**

This step only applies on a machine where `/mnt/gdrive` exists (i.e. the VPS) — skip on a dev machine without a mount. On the VPS, after Task 1 is deployed and at least one real title has completed a download (`status: 'mounted'` in `data/localseed_meta.json`):

```bash
node -e "
require('./lib/localseed_catalog').getCatalog('series').then(r => {
  console.log('metas:', r.metas.length, 'origin:', r.origin);
  if (r.metas.length) console.log(JSON.stringify(r.metas[0], null, 2));
});
"
```

Expected: at least one meta with a valid `id` (starts with `tt`), `name`, and `description` mentioning "Downloaded on your VPS".

- [ ] **Step 4: Syntax check and commit**

```bash
node -c lib/localseed_catalog.js && echo OK
git add lib/localseed_catalog.js
git commit -m "Add VPS/Drive Downloaded catalog module"
```

---

### Task 3: Wire the catalog into `addon.js`

**Files:**
- Modify: `addon.js`

**Interfaces:**
- Consumes: `localseedCatalog.getCatalog(type)` (Task 2), `localseed.isEnabled()` (existing)

- [ ] **Step 1: Import the module**

In `addon.js`, after `const localseed = require('./lib/localseed');`, add:

```js
const localseedCatalog = require('./lib/localseed_catalog');
```

- [ ] **Step 2: Add the manifest catalog entries**

Find this block (the existing Debrid Cached manifest entry):

```js
// What is already sitting in Real-Debrid, ready to play instantly.
if (config.REALDEBRID_TOKEN) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: 'iott-debrid-cached',
      name: 'Prowlarr — Debrid Cached',
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
} else {
  console.warn('[manifest] Debrid Cached catalog not advertised — REALDEBRID_TOKEN is not set');
}
```

Add immediately after it:

```js
// What is already downloaded to the VPS and moved onto the Google Drive
// mount, ready to replay instantly without re-searching.
if (localseed.isEnabled()) {
  for (const type of ['movie', 'series']) {
    catalogs.push({
      type,
      id: 'iott-localseed',
      name: 'VPS/Drive Downloaded',
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
} else {
  console.warn('[manifest] VPS/Drive Downloaded catalog not advertised — no Google Drive mount configured');
}
```

- [ ] **Step 3: Add the catalog handler routing**

Find this block inside `builder.defineCatalogHandler(...)`:

```js
  if (id === 'iott-debrid-cached') {
    try {
      const { metas, origin } = await debridCatalog.getCatalog(type);
      console.log(`[catalog] debrid-cached (${type}) -> ${metas.length} metas`);
      return { metas, cacheMaxAge: 300, staleRevalidate: 600, origin };
    } catch (err) {
      console.error(`[catalog] debrid-cached failed: ${err.message}`);
      return { metas: [] };
    }
  }
```

Add immediately after it:

```js
  if (id === 'iott-localseed') {
    try {
      const { metas, origin } = await localseedCatalog.getCatalog(type);
      console.log(`[catalog] localseed (${type}) -> ${metas.length} metas`);
      return { metas, cacheMaxAge: 300, staleRevalidate: 600, origin };
    } catch (err) {
      console.error(`[catalog] localseed failed: ${err.message}`);
      return { metas: [] };
    }
  }
```

- [ ] **Step 4: Verify syntax and manifest shape**

```bash
node -c addon.js && echo OK
node -e "
const { manifest } = require('./addon');
const ids = manifest.catalogs.map(c => c.id);
console.log(ids.includes('iott-localseed') ? 'localseed catalog present' : 'localseed catalog absent (expected on dev machine without /mnt/gdrive)');
"
```

Expected: `OK`, then either line depending on whether this machine has `/mnt/gdrive` — absent is correct on a dev machine, present is correct on the VPS.

- [ ] **Step 5: Commit**

```bash
git add addon.js
git commit -m "Wire VPS/Drive Downloaded catalog into addon.js"
```

---

### Task 4: Deploy and verify on the VPS

**Files:** none (operational task)

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Pull and restart on the VPS**

```bash
ssh -i oci.key ubuntu@129.154.250.79 "cd /home/ubuntu/stremio-india-ott && git pull origin main && sudo systemctl restart stremio-india-ott"
```

- [ ] **Step 3: Verify the catalog is advertised**

```bash
ssh -i oci.key ubuntu@129.154.250.79 "sleep 100 && curl -s http://127.0.0.1:7000/manifest.json | grep -o 'iott-localseed'"
```

Expected: `iott-localseed` printed (may appear twice, once per type).

- [ ] **Step 4: Verify it lists the title already downloaded during the prior local-seed test**

```bash
ssh -i oci.key ubuntu@129.154.250.79 "curl -s 'http://127.0.0.1:7000/catalog/series/iott-localseed.json' | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.metas.length, j.metas.map(m=>m.name));})\""
```

Expected: at least 1 meta, one of them named something resembling "Musafir Cafe" (the title downloaded during the prior local-seed smoke test) — confirms the whole pipeline end to end: sidecar → title resolution → catalog → manifest.
