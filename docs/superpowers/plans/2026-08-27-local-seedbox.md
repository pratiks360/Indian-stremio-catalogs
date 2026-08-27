# Local Seedbox (VPS Download + Google Drive Mount) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third stream option, "Local," for Prowlarr releases that carry a tracker passkey (and therefore never get an RD option): download and seed the torrent from the addon's own VPS via WebTorrent, stream it to Stremio while it downloads, then move the finished file onto an rclone-mounted Google Drive path so local disk only ever holds in-flight downloads, not the whole library.

**Architecture:** `lib/localseed_util.js` holds pure, unit-testable logic (payload encode/decode, admission control, eviction selection). `lib/localseed_state.js` persists per-torrent metadata (a JSON sidecar, same pattern as `runlog.js`) so eviction has a reliable last-played timestamp independent of whether the FUSE mount honors atime. `lib/localseed.js` wraps a single `WebTorrent.Client()` and the filesystem move-to-mount step, built on top of the two modules above. `stream.js` and `addon.js` wire it into the existing stream-option and route patterns already used for RD.

**Tech Stack:** Node.js, Express (existing), `webtorrent` (new dependency), `rclone` (VPS system package, not a Node dependency), plain `fs`/`crypto` (no new util libraries).

## Global Constraints

- Local-seed feature is entirely optional: it must self-disable (no "Local" stream option offered, no route errors) when `GDRIVE_MOUNT_PATH` doesn't exist on disk — same pattern `REALDEBRID_TOKEN` already uses to gate the RD path.
- No new test framework — this repo has none (`package.json` has no test script). Pure-logic modules get a plain `assert`-based script under `scripts/`, run with `node scripts/<name>.js`, following the existing convention (e.g. `scripts/sonyliv_proxy_investigation.js`). I/O-heavy code (WebTorrent, real mount) is verified manually against the live VPS, the same way `activity-log.js` was verified in the prior session.
- Concurrency cap: 3 active local-seed torrents (`config.LOCALSEED.MAX_CONCURRENT`).
- Memory ceiling: reject new downloads once `process.memoryUsage().rss` crosses `config.LOCALSEED.RSS_CEILING_BYTES` (300MB default).
- Local disk reserved floor: `config.LOCALSEED.MIN_FREE_BYTES` (5GB default) — reject new downloads below this.
- Seed window after completion: `config.LOCALSEED.SEED_WINDOW_MS` (24h default).
- Drive usage cap: `config.LOCALSEED.DRIVE_CAP_BYTES` (12GB default) — daily eviction sweep keeps the mount under this.
- Never send a passkey-bearing torrent to RD (existing rule, unaffected) — Local is offered exactly where RD is currently skipped (`release.hasPasskey` true, see `stream.js:222`).
- All new event logging goes through the existing `activity-log.js` module (7-day retention, line-delimited JSON) — no new logging mechanism.

---

## File Structure

| File | Responsibility |
|---|---|
| `config.js` (modify) | New `LOCALSEED` config block |
| `package.json` (modify) | Add `webtorrent` dependency |
| `lib/localseed_util.js` (new) | Pure functions: payload encode/decode, mount filename, admission control, eviction selection |
| `scripts/test_localseed_util.js` (new) | Assert-based smoke test for the pure functions above |
| `lib/localseed_state.js` (new) | JSON sidecar (`data/localseed_meta.json`) tracking per-infoHash `{lastPlayed, size, status}` |
| `lib/localseed.js` (new) | WebTorrent client wrapper, stream-to-response, move-to-mount, eviction sweep — built on the two modules above |
| `activity-log.js` (modify) | New `localSeed()` logging method + `local_seed` bucket |
| `activity_html.js` (modify) | New "Local Seed" tab |
| `stream.js` (modify) | New `Local` stream entry for `hasPasskey` releases |
| `addon.js` (modify) | New `/local/resolve/:payload` route, eviction sweep interval, feature-enabled boot log |
| `deploy/rclone-gdrive-mount.service` (new) | systemd unit for the rclone mount |
| `deploy/rclone-setup.md` (new) | Manual, one-time VPS setup steps (rclone install + OAuth + service) |
| `.env.example` (modify) | Document `GDRIVE_MOUNT_PATH` |

---

### Task 1: Config, dependency, and directories

**Files:**
- Modify: `config.js`
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.LOCALSEED = { ENABLED, MOUNT_PATH, LOCAL_DIR, MAX_CONCURRENT, RSS_CEILING_BYTES, MIN_FREE_BYTES, SEED_WINDOW_MS, DRIVE_CAP_BYTES }` — every later task reads from this.

- [ ] **Step 1: Add the `webtorrent` dependency**

```bash
npm install webtorrent@^2
```

Expected: `package.json`'s `dependencies` gains `"webtorrent": "^2.x.x"`, `package-lock.json` updates.

- [ ] **Step 2: Add the `LOCALSEED` config block**

In `config.js`, after the `PREFETCH_NEXT_EPISODE` line (currently line 104), insert:

```js
  // --- Local seedbox (VPS download + Google Drive mount) ----------------
  // Passkey-bearing releases never get an RD option (see hasPasskey gating
  // above) and depend on the playing device's own P2P connectivity, which
  // fails on some devices/networks (observed: Google TV Streamer). This is
  // the alternative: download via WebTorrent on the VPS itself (a
  // legitimate seedbox — the tracker sees the user's own passkey from one
  // consistent IP, unlike a third-party service), then move the finished
  // file onto a Google Drive mount so local disk only ever holds what is
  // actively downloading, not the accumulated library.
  LOCALSEED: {
    // Feature is entirely optional — self-disables if the mount path does
    // not exist (see lib/localseed.js's isEnabled()).
    MOUNT_PATH: process.env.GDRIVE_MOUNT_PATH || '/mnt/gdrive',
    MOUNT_SUBDIR: 'stremio-seed',
    LOCAL_DIR: path.join(__dirname, 'data', 'localseed'),
    MAX_CONCURRENT: 3,
    RSS_CEILING_BYTES: 300 * 1024 * 1024,
    MIN_FREE_BYTES: 5 * 1024 * 1024 * 1024,
    SEED_WINDOW_MS: 24 * 60 * 60 * 1000,
    DRIVE_CAP_BYTES: 12 * 1024 * 1024 * 1024
  },
```

- [ ] **Step 3: Document `GDRIVE_MOUNT_PATH` in `.env.example`**

In `.env.example`, after the `PUBLIC_ORIGIN` block, insert:

```
# Path where `rclone mount gdrive: <path>` is mounted on this VPS (see
# deploy/rclone-setup.md). Optional — the "Local" stream option (VPS
# download + seed for passkey-protected releases) simply does not appear
# if this path does not exist. Leave blank to use the default /mnt/gdrive.
GDRIVE_MOUNT_PATH=
```

- [ ] **Step 4: Verify config loads without error**

```bash
node -e "console.log(require('./config').LOCALSEED)"
```

Expected: prints the `LOCALSEED` object with `MOUNT_PATH: '/mnt/gdrive'` (or your local `.env` override) and no thrown error.

- [ ] **Step 5: Commit**

```bash
git add config.js package.json package-lock.json .env.example
git commit -m "Add local-seed config block and webtorrent dependency"
```

---

### Task 2: Pure helpers — `lib/localseed_util.js`

**Files:**
- Create: `lib/localseed_util.js`
- Test: `scripts/test_localseed_util.js`

**Interfaces:**
- Consumes: nothing (pure module, no imports beyond `crypto`)
- Produces:
  - `encodePayload({infoHash, trackers, title}) -> string`
  - `decodePayload(payloadB64) -> {infoHash, trackers, title}`
  - `mountFilename(infoHash, originalPath) -> string`
  - `shouldAdmit({activeCount, rssBytes, freeBytes}, {maxConcurrent, rssCeilingBytes, minFreeBytes}) -> {allow, reason?}`
  - `selectEvictionTargets(files, usedBytes, capBytes) -> Array<{path,size,lastPlayed}>`

- [ ] **Step 1: Write the failing test script**

Create `scripts/test_localseed_util.js`:

```js
'use strict';

const assert = require('assert');
const {
  encodePayload, decodePayload, mountFilename, shouldAdmit, selectEvictionTargets
} = require('../lib/localseed_util');

// encodePayload / decodePayload round-trip
{
  const original = { infoHash: 'ABCDEF1234', trackers: ['udp://tracker.example:80'], title: 'Test Release' };
  const encoded = encodePayload(original);
  assert.strictEqual(typeof encoded, 'string');
  const decoded = decodePayload(encoded);
  assert.deepStrictEqual(decoded, original);
  console.log('PASS: encodePayload/decodePayload round-trip');
}

// mountFilename
{
  assert.strictEqual(mountFilename('ABCDEF', 'Some.Release.2026.mkv'), 'abcdef.mkv');
  assert.strictEqual(mountFilename('ABCDEF', 'Some.Release.2026.mp4'), 'abcdef.mp4');
  assert.strictEqual(mountFilename('ABCDEF', 'no-extension-file'), 'abcdef.mkv');
  console.log('PASS: mountFilename');
}

// shouldAdmit
{
  const limits = { maxConcurrent: 3, rssCeilingBytes: 300 * 1024 * 1024, minFreeBytes: 5 * 1024 * 1024 * 1024 };

  const ok = shouldAdmit({ activeCount: 1, rssBytes: 100 * 1024 * 1024, freeBytes: 10 * 1024 * 1024 * 1024 }, limits);
  assert.strictEqual(ok.allow, true);

  const overConcurrent = shouldAdmit({ activeCount: 3, rssBytes: 100 * 1024 * 1024, freeBytes: 10 * 1024 * 1024 * 1024 }, limits);
  assert.strictEqual(overConcurrent.allow, false);
  assert.ok(/active/.test(overConcurrent.reason));

  const overMemory = shouldAdmit({ activeCount: 1, rssBytes: 300 * 1024 * 1024, freeBytes: 10 * 1024 * 1024 * 1024 }, limits);
  assert.strictEqual(overMemory.allow, false);
  assert.ok(/memory/.test(overMemory.reason));

  const underDisk = shouldAdmit({ activeCount: 1, rssBytes: 100 * 1024 * 1024, freeBytes: 1 * 1024 * 1024 * 1024 }, limits);
  assert.strictEqual(underDisk.allow, false);
  assert.ok(/disk/.test(underDisk.reason));

  console.log('PASS: shouldAdmit');
}

// selectEvictionTargets
{
  const files = [
    { path: 'a', size: 3 * 1024 * 1024 * 1024, lastPlayed: 300 },
    { path: 'b', size: 4 * 1024 * 1024 * 1024, lastPlayed: 100 },
    { path: 'c', size: 2 * 1024 * 1024 * 1024, lastPlayed: 200 }
  ];
  const usedBytes = 9 * 1024 * 1024 * 1024;
  const capBytes = 6 * 1024 * 1024 * 1024;

  const targets = selectEvictionTargets(files, usedBytes, capBytes);
  // Oldest-played first: removing just 'b' (100, 4GB) already brings 9GB
  // down to 5GB, under the 6GB cap — 'c' and 'a' must not be touched.
  assert.deepStrictEqual(targets.map(f => f.path), ['b']);

  const nothingToEvict = selectEvictionTargets(files, 5 * 1024 * 1024 * 1024, capBytes);
  assert.deepStrictEqual(nothingToEvict, []);

  console.log('PASS: selectEvictionTargets');
}

console.log('ALL PASS');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test_localseed_util.js
```

Expected: `Error: Cannot find module '../lib/localseed_util'`

- [ ] **Step 3: Write the implementation**

Create `lib/localseed_util.js`:

```js
'use strict';

/**
 * Pure helpers for the local-seed feature — no I/O, no WebTorrent, no fs.
 * Kept separate from lib/localseed.js so admission control and eviction
 * selection can be exercised without a real torrent client or filesystem.
 */

/**
 * Payload for /local/resolve/:payload — same base64url-JSON shape family as
 * the RD payload built in stream.js's toDebridStream(). Deliberately a
 * plain passthrough (not a fixed destructure) so callers can carry whatever
 * fields the resolve step needs — infoHash/trackers/title always, plus
 * season/episode when the release is a season pack and the right file
 * within it must be picked at resolve time (pickFileIdx needs them; they
 * can't be recovered from the resolve request itself, Stremio's play
 * request carries no season/episode query param).
 */
function encodePayload(fields) {
  return Buffer.from(JSON.stringify(fields)).toString('base64url');
}

function decodePayload(payloadB64) {
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
}

/**
 * Filename used both in the local download dir and on the mount, keyed by
 * infoHash so a replay can find a previously-completed download by hash
 * alone, independent of release-name variations across searches.
 */
function mountFilename(infoHash, originalPath) {
  const match = /\.[a-z0-9]+$/i.exec(String(originalPath || ''));
  const ext = match ? match[0] : '.mkv';
  return `${String(infoHash).toLowerCase()}${ext}`;
}

/**
 * Admission control for starting a new local-seed download.
 * @param {{activeCount:number, rssBytes:number, freeBytes:number}} state
 * @param {{maxConcurrent:number, rssCeilingBytes:number, minFreeBytes:number}} limits
 * @returns {{allow:boolean, reason?:string}}
 */
function shouldAdmit(state, limits) {
  if (state.activeCount >= limits.maxConcurrent) {
    return { allow: false, reason: `${limits.maxConcurrent} local-seed downloads already active` };
  }
  if (state.rssBytes >= limits.rssCeilingBytes) {
    return { allow: false, reason: 'server memory near ceiling' };
  }
  if (state.freeBytes < limits.minFreeBytes) {
    return { allow: false, reason: 'local disk below reserved floor' };
  }
  return { allow: true };
}

/**
 * Given files with size + lastPlayed (ms epoch), pick which to delete
 * (oldest-played first) to bring total usage back under capBytes.
 * @param {Array<{path:string, size:number, lastPlayed:number}>} files
 * @param {number} usedBytes current total usage
 * @param {number} capBytes
 * @returns {Array<{path:string, size:number, lastPlayed:number}>} deletion targets, oldest-played first
 */
function selectEvictionTargets(files, usedBytes, capBytes) {
  if (usedBytes <= capBytes) return [];
  const sorted = [...files].sort((a, b) => a.lastPlayed - b.lastPlayed);
  const targets = [];
  let freed = 0;
  for (const f of sorted) {
    if (usedBytes - freed <= capBytes) break;
    targets.push(f);
    freed += f.size;
  }
  return targets;
}

module.exports = { encodePayload, decodePayload, mountFilename, shouldAdmit, selectEvictionTargets };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/test_localseed_util.js
```

Expected: five `PASS:` lines and `ALL PASS`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add lib/localseed_util.js scripts/test_localseed_util.js
git commit -m "Add local-seed pure helpers (payload codec, admission control, eviction selection)"
```

---

### Task 3: Metadata sidecar — `lib/localseed_state.js`

**Files:**
- Create: `lib/localseed_state.js`
- Test: `scripts/test_localseed_state.js`

**Interfaces:**
- Consumes: nothing beyond `fs`/`path` (does not import `config.js`, takes the JSON file path as a parameter so it's testable against a temp path)
- Produces:
  - `load(storePath) -> {[infoHash]: {size:number, lastPlayed:number, status:'local'|'mounted'}}`
  - `touch(storePath, infoHash, fields) -> void` (merges `fields` into the entry for `infoHash`, creating it if absent, and saves)
  - `remove(storePath, infoHash) -> void`
  - `list(storePath) -> Array<{infoHash, size, lastPlayed, status}>`

- [ ] **Step 1: Write the failing test script**

Create `scripts/test_localseed_state.js`:

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, touch, remove, list } = require('../lib/localseed_state');

const tmpFile = path.join(os.tmpdir(), `localseed_state_test_${Date.now()}.json`);

// Fresh file: load() returns empty object, never throws
{
  const state = load(tmpFile);
  assert.deepStrictEqual(state, {});
  console.log('PASS: load() on missing file returns {}');
}

// touch() creates and merges
{
  touch(tmpFile, 'HASH1', { size: 1000, lastPlayed: 111, status: 'local' });
  touch(tmpFile, 'HASH1', { lastPlayed: 222, status: 'mounted' });
  const state = load(tmpFile);
  assert.deepStrictEqual(state.HASH1, { size: 1000, lastPlayed: 222, status: 'mounted' });
  console.log('PASS: touch() creates and merges');
}

// list() flattens with infoHash included
{
  touch(tmpFile, 'HASH2', { size: 2000, lastPlayed: 333, status: 'local' });
  const rows = list(tmpFile).sort((a, b) => a.infoHash.localeCompare(b.infoHash));
  assert.deepStrictEqual(rows, [
    { infoHash: 'HASH1', size: 1000, lastPlayed: 222, status: 'mounted' },
    { infoHash: 'HASH2', size: 2000, lastPlayed: 333, status: 'local' }
  ]);
  console.log('PASS: list()');
}

// remove()
{
  remove(tmpFile, 'HASH1');
  const state = load(tmpFile);
  assert.strictEqual(state.HASH1, undefined);
  assert.ok(state.HASH2);
  console.log('PASS: remove()');
}

fs.unlinkSync(tmpFile);
console.log('ALL PASS');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test_localseed_state.js
```

Expected: `Error: Cannot find module '../lib/localseed_state'`

- [ ] **Step 3: Write the implementation**

Create `lib/localseed_state.js`:

```js
'use strict';

/**
 * JSON sidecar tracking per-infoHash local-seed metadata: size, last-played
 * timestamp, and whether the file currently lives locally or on the mount.
 *
 * A sidecar rather than relying on the mount's own atime because FUSE mounts
 * (rclone included) commonly don't update atime on read, which would make
 * eviction's "least-recently-played" ordering silently wrong. Same
 * load/save-a-JSON-file pattern as runlog.js.
 */

const fs = require('fs');
const path = require('path');

function load(storePath) {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return {};
  }
}

function save(storePath, state) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(state));
}

function touch(storePath, infoHash, fields) {
  const state = load(storePath);
  state[infoHash] = { ...(state[infoHash] || {}), ...fields };
  save(storePath, state);
}

function remove(storePath, infoHash) {
  const state = load(storePath);
  delete state[infoHash];
  save(storePath, state);
}

function list(storePath) {
  const state = load(storePath);
  return Object.entries(state).map(([infoHash, fields]) => ({ infoHash, ...fields }));
}

module.exports = { load, touch, remove, list };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/test_localseed_state.js
```

Expected: four `PASS:` lines and `ALL PASS`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add lib/localseed_state.js scripts/test_localseed_state.js
git commit -m "Add local-seed metadata sidecar (per-infoHash size/lastPlayed/status)"
```

---

### Task 4: WebTorrent + mount wrapper — `lib/localseed.js`

**Files:**
- Create: `lib/localseed.js`

**Interfaces:**
- Consumes:
  - `config.LOCALSEED` (from Task 1)
  - `encodePayload`, `decodePayload`, `mountFilename`, `shouldAdmit`, `selectEvictionTargets` (from `lib/localseed_util.js`, Task 2)
  - `load`, `touch`, `remove`, `list` (from `lib/localseed_state.js`, Task 3)
  - `pickFileIdx` (from `lib/bencode.js`, existing)
  - `activityLog.localSeed` (from `activity-log.js`, produced in Task 5 — this task's code calls it, Task 5 lands first in execution order)
- Produces:
  - `isEnabled() -> boolean`
  - `mountReady() -> boolean`
  - `findOnMount(infoHash) -> string|null` (absolute path if present)
  - `streamRelease(req, res, {infoHash, trackers, title}, season, episode) -> Promise<void>` — handles the whole request/response cycle; used directly by the addon.js route handler
  - `sweepEviction() -> Promise<void>` — mount + local disk eviction sweep, called on a daily interval from addon.js

- [ ] **Step 1: Write the implementation**

Create `lib/localseed.js`:

```js
'use strict';

/**
 * VPS-local torrent download/seed + Google Drive mount archive.
 *
 * Offered only for releases RD already skips (hasPasskey — see stream.js).
 * The tracker sees the user's own passkey announcing from this one VPS, the
 * same as any legitimate seedbox — unlike RD, which is a third party and
 * therefore excluded from passkey releases entirely (see .env.example).
 *
 * Downloads always land on local disk first: BitTorrent writes pieces out
 * of order as they arrive from peers, and an rclone mount cannot perform
 * that kind of random-access write against Drive without falling back to
 * caching the whole file locally anyway. Once a download is complete (no
 * longer being written), the file is moved onto the mount — a safe
 * operation, since nothing is reading a file on the mount while it is still
 * being written. See docs/superpowers/specs/2026-08-27-local-seed-design.md.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { pickFileIdx } = require('./bencode');
const {
  encodePayload, decodePayload, mountFilename, shouldAdmit, selectEvictionTargets
} = require('./localseed_util');
const state = require('./localseed_state');
const activityLog = require('../activity-log');

const STATE_PATH = path.join(__dirname, '..', 'data', 'localseed_meta.json');

let client = null;
function getClient() {
  if (!client) {
    // Loaded lazily so a box that never enables this feature never even
    // requires the webtorrent package to resolve correctly.
    const WebTorrent = require('webtorrent');
    client = new WebTorrent();
  }
  return client;
}

/** Mount path existing on disk is the sole enable/disable switch — same
 * pattern config.REALDEBRID_TOKEN uses for the RD path. */
function mountReady() {
  try {
    return fs.statSync(config.LOCALSEED.MOUNT_PATH).isDirectory();
  } catch {
    return false;
  }
}

function isEnabled() {
  return mountReady();
}

function mountDir() {
  return path.join(config.LOCALSEED.MOUNT_PATH, config.LOCALSEED.MOUNT_SUBDIR);
}

/** @returns {string|null} absolute path on the mount if this infoHash was already downloaded */
function findOnMount(infoHash) {
  const dir = mountDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = String(infoHash).toLowerCase();
  const hit = entries.find(f => f.toLowerCase().startsWith(prefix));
  return hit ? path.join(dir, hit) : null;
}

function activeCount() {
  return getClient().torrents.length;
}

/** Currently downloading/seeding torrent for this infoHash, if any. */
function findActiveTorrent(infoHash) {
  const want = String(infoHash).toLowerCase();
  return getClient().torrents.find(t => t.infoHash.toLowerCase() === want) || null;
}

function freeBytesOnLocalDisk() {
  try {
    const stats = fs.statfsSync(config.LOCALSEED.LOCAL_DIR);
    return stats.bavail * stats.bsize;
  } catch {
    // LOCAL_DIR may not exist yet on first run — check its parent instead.
    const stats = fs.statfsSync(path.dirname(config.LOCALSEED.LOCAL_DIR));
    return stats.bavail * stats.bsize;
  }
}

/**
 * Serve a release over HTTP, starting/reusing a local WebTorrent download or
 * serving straight off the mount if this infoHash was already downloaded.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{infoHash:string, trackers:string[], title:string}} release
 * @param {number|null} season
 * @param {number|null} episode
 */
async function streamRelease(req, res, release, season, episode) {
  const { infoHash, trackers, title } = release;

  // 1. Already on the mount from a previous download — serve it directly,
  //    no torrent, no re-download.
  const mounted = findOnMount(infoHash);
  if (mounted) {
    state.touch(STATE_PATH, infoHash, { lastPlayed: Date.now() });
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'serve-from-mount', success: true });
    return serveFileRange(req, res, mounted);
  }

  // 2. Already downloading — reuse it.
  let torrent = findActiveTorrent(infoHash);

  // 3. Neither: admission check, then start a fresh download.
  if (!torrent) {
    const admission = shouldAdmit(
      { activeCount: activeCount(), rssBytes: process.memoryUsage().rss, freeBytes: freeBytesOnLocalDisk() },
      {
        maxConcurrent: config.LOCALSEED.MAX_CONCURRENT,
        rssCeilingBytes: config.LOCALSEED.RSS_CEILING_BYTES,
        minFreeBytes: config.LOCALSEED.MIN_FREE_BYTES
      }
    );
    if (!admission.allow) {
      activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'rejected', success: false, errorMsg: admission.reason });
      res.status(503).type('text/plain').send(`Local seedbox busy: ${admission.reason}`);
      return;
    }

    fs.mkdirSync(config.LOCALSEED.LOCAL_DIR, { recursive: true });
    torrent = await addTorrent(infoHash, trackers);
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'download-start', success: true });

    torrent.once('done', () => {
      moveToMount(torrent, infoHash, title).catch(err => {
        activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'move-to-mount', success: false, errorMsg: err.message });
      });
    });
  }

  await waitForFileSelectable(torrent);
  const fileIdx = pickFileIdx(torrent.files.map((f, idx) => ({ idx, length: f.length, path: f.path })), season, episode);
  const file = torrent.files[fileIdx];

  state.touch(STATE_PATH, infoHash, { lastPlayed: Date.now(), status: 'local' });
  streamTorrentFile(req, res, file);
}

function addTorrent(infoHash, trackers) {
  return new Promise((resolve, reject) => {
    const magnet = `magnet:?xt=urn:btih:${infoHash}` + trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    getClient().add(magnet, { path: config.LOCALSEED.LOCAL_DIR }, torrent => resolve(torrent));
    getClient().once('error', reject);
  });
}

function waitForFileSelectable(torrent) {
  if (torrent.files && torrent.files.length) return Promise.resolve();
  return new Promise(resolve => torrent.once('ready', resolve));
}

/** Pipe a byte range of a WebTorrent file into the HTTP response — WebTorrent blocks the stream on pieces not yet downloaded, which naturally paces playback to download progress. */
function streamTorrentFile(req, res, file) {
  const range = req.headers.range;
  const total = file.length;
  let start = 0, end = total - 1;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : total - 1;
    }
  }

  res.status(range ? 206 : 200);
  res.set({
    'Content-Range': range ? `bytes ${start}-${end}/${total}` : undefined,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4'
  });

  const stream = file.createReadStream({ start, end });
  stream.pipe(res);
  stream.on('error', () => res.end());
}

/** Serve a fully-local (mount or completed local) file by plain fs range read. */
function serveFileRange(req, res, absPath) {
  const stat = fs.statSync(absPath);
  const range = req.headers.range;
  let start = 0, end = stat.size - 1;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : stat.size - 1;
    }
  }

  res.status(range ? 206 : 200);
  res.set({
    'Content-Range': range ? `bytes ${start}-${end}/${stat.size}` : undefined,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4'
  });

  const stream = fs.createReadStream(absPath, { start, end });
  stream.pipe(res);
  stream.on('error', () => res.end());
}

/** Move a completed download onto the mount. Safe: the file is done, nothing reads it mid-write. */
async function moveToMount(torrent, infoHash, title) {
  if (!mountReady()) {
    activityLog.localSeed({ infoHash, releaseTitle: title, phase: 'move-to-mount', success: false, errorMsg: 'mount not available' });
    return;
  }

  const largest = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
  const srcPath = path.join(config.LOCALSEED.LOCAL_DIR, largest.path);
  const destDir = mountDir();
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, mountFilename(infoHash, largest.path));

  const t0 = Date.now();
  await fs.promises.copyFile(srcPath, destPath);
  await fs.promises.unlink(srcPath);

  state.touch(STATE_PATH, infoHash, { size: largest.length, lastPlayed: Date.now(), status: 'mounted' });
  activityLog.localSeed({
    infoHash, releaseTitle: title, phase: 'move-to-mount', success: true, duration_ms: Date.now() - t0
  });

  // Stop seeding this torrent's local copy now that it lives on the mount —
  // config.LOCALSEED.SEED_WINDOW_MS still governs how long WebTorrent keeps
  // announcing/uploading before it is removed from the client entirely.
  setTimeout(() => {
    getClient().remove(torrent.infoHash, () => {});
  }, config.LOCALSEED.SEED_WINDOW_MS);
}

/** Daily sweep: evict oldest-played files on the mount once usage exceeds the cap. Called from addon.js on the same interval as the catalog refresh. */
async function sweepEviction() {
  if (!mountReady()) return;

  const dir = mountDir();
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }

  const meta = state.load(STATE_PATH);
  const files = [];
  let usedBytes = 0;
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = await fs.promises.stat(full);
    } catch {
      continue;
    }
    const infoHash = Object.keys(meta).find(h => name.toLowerCase().startsWith(h.toLowerCase()));
    const lastPlayed = infoHash && meta[infoHash] ? meta[infoHash].lastPlayed : st.mtimeMs;
    files.push({ path: full, size: st.size, lastPlayed, infoHash });
    usedBytes += st.size;
  }

  const targets = selectEvictionTargets(files, usedBytes, config.LOCALSEED.DRIVE_CAP_BYTES);
  for (const target of targets) {
    try {
      await fs.promises.unlink(target.path);
      if (target.infoHash) state.remove(STATE_PATH, target.infoHash);
      activityLog.localSeed({ infoHash: target.infoHash, phase: 'evict', success: true });
    } catch (err) {
      activityLog.localSeed({ infoHash: target.infoHash, phase: 'evict', success: false, errorMsg: err.message });
    }
  }
}

module.exports = {
  isEnabled, mountReady, findOnMount, streamRelease, sweepEviction,
  encodePayload, decodePayload
};
```

- [ ] **Step 2: Verify the module loads without a real mount or WebTorrent download**

```bash
node -e "
const ls = require('./lib/localseed');
console.log('isEnabled:', ls.isEnabled());
console.log('findOnMount (should be null, no mount):', ls.findOnMount('deadbeef'));
const p = ls.encodePayload({ infoHash: 'abc', trackers: ['udp://t'], title: 'X' });
console.log('payload round-trip:', JSON.stringify(ls.decodePayload(p)));
"
```

Expected: `isEnabled: false` (no `/mnt/gdrive` on this dev machine), `findOnMount: null`, and the decoded payload matching `{infoHash:'abc',trackers:['udp://t'],title:'X'}`. No thrown error — confirms the module degrades gracefully with the mount absent, and confirms `require('webtorrent')` is deferred (not eagerly required at module load, so a missing/misbehaving webtorrent install can't break addon boot on a box where this feature is unused).

- [ ] **Step 3: Commit**

```bash
git add lib/localseed.js
git commit -m "Add WebTorrent + Google Drive mount wrapper for local-seed streaming"
```

---

### Task 5: Activity log integration

**Files:**
- Modify: `activity-log.js`
- Modify: `activity_html.js`

**Interfaces:**
- Produces: `activityLog.localSeed({infoHash, releaseTitle, phase, success, errorMsg, duration_ms}) -> void` — consumed by `lib/localseed.js` (Task 4)

- [ ] **Step 1: Add the `local_seed` event type to `activity-log.js`**

In `activity-log.js`, after the `rdAction` function, insert:

```js
function localSeed({ infoHash, releaseTitle, phase, success, errorMsg, duration_ms }) {
  record('local_seed', { infoHash, releaseTitle, phase, success, errorMsg, duration_ms });
}
```

Update the `readAll()` buckets object to include the new type:

```js
  const buckets = {
    stream_search: [], user_click: [], torrent_fetch: [], catalog_refresh: [], rd_action: [], local_seed: []
  };
```

Update the final `module.exports`:

```js
module.exports = { streamSearch, userClick, torrentFetch, catalogRefresh, rdAction, localSeed, readAll, rotate };
```

- [ ] **Step 2: Add the "Local Seed" tab to `activity_html.js`**

In `activity_html.js`, add to the `TABS` array (after the `rd_action` entry):

```js
  {
    key: 'local_seed',
    label: 'Local Seed',
    cols: ['Time', 'Release', 'Phase', 'Success', 'Duration (ms)', 'Error'],
    row: e => [esc(e.timestamp), esc(e.releaseTitle), esc(e.phase), ok(e.success), esc(e.duration_ms), esc(e.errorMsg)]
  }
```

- [ ] **Step 3: Verify with a smoke test**

```bash
node -e "
const a = require('./activity-log');
a.localSeed({ infoHash: 'abc123', releaseTitle: 'Test Movie', phase: 'download-start', success: true });
a.localSeed({ infoHash: 'abc123', releaseTitle: 'Test Movie', phase: 'move-to-mount', success: true, duration_ms: 4200 });
const buckets = a.readAll();
console.log('local_seed rows:', buckets.local_seed.length);
const { renderActivityPage } = require('./activity_html');
const html = renderActivityPage(buckets);
console.log(html.includes('Local Seed') ? 'PASS: tab present' : 'FAIL: tab missing');
console.log(html.includes('Test Movie') ? 'PASS: row present' : 'FAIL: row missing');
"
rm -f data/activity.log
```

Expected: `local_seed rows: 2`, both `PASS:` lines. The final `rm` clears the test data so it doesn't linger in the repo's `data/` dir (already gitignored, but keeps local state clean).

- [ ] **Step 4: Commit**

```bash
git add activity-log.js activity_html.js
git commit -m "Add local_seed event type and Activity Log tab"
```

---

### Task 6: Stream option in `stream.js`

**Files:**
- Modify: `stream.js`

**Interfaces:**
- Consumes: `localseed.isEnabled()`, `localseed.encodePayload()` (from Task 4)
- Produces: `resolveLocalSeed(req, res, payloadB64) -> Promise<void>` — consumed by the route added in Task 7

- [ ] **Step 1: Import the module**

In `stream.js`, after the `const rd = require('./lib/realdebrid');` line, add:

```js
const localseed = require('./lib/localseed');
```

- [ ] **Step 2: Add a `toLocalSeedStream()` builder**

After the existing `toDebridStream()` function in `stream.js`, add:

```js
/**
 * The local-seed path: this addon downloads/seeds the torrent on its own
 * VPS. Only offered for releases RD already excludes (hasPasskey) — see
 * lib/localseed.js's header comment for why that is safe here but not for
 * a third-party service like RD.
 */
function toLocalSeedStream({ release, torrent }, season, episode) {
  const tags = qualityTags(release.title);
  const detail = [
    tags.join(' '),
    fmtSize(torrent.totalBytes),
    `${release.seeders != null ? release.seeders : '?'} seeds`,
    release.indexer
  ].filter(Boolean).join(' · ');

  // season/episode ride along in the payload — pickFileIdx needs them to
  // select the right file out of a season-pack torrent at resolve time,
  // and Stremio's play request carries no season/episode query param of
  // its own to recover them from otherwise.
  const payload = localseed.encodePayload({
    infoHash: torrent.infoHash,
    trackers: torrent.trackers,
    title: release.title,
    season,
    episode
  });

  return {
    name: 'Local',
    title: `${release.title}\n${detail}`,
    url: null, // filled in by the caller with baseUrl, same as toDebridStream
    _payload: payload,
    behaviorHints: { bingeGroup: `prowlarr-local-${tags.join('-') || 'sd'}`, notWebReady: false }
  };
}
```

- [ ] **Step 3: Wire it into `getStreams()`'s loop**

In `getStreams()`, replace:

```js
    if (!config.REALDEBRID_TOKEN) continue;
    if (item.torrent.hasPasskey) continue; // see file header
    rdEligible++;
    streams.push(toDebridStream(item, baseUrl, rdHashes.has(item.torrent.infoHash.toLowerCase())));
```

with:

```js
    if (item.torrent.hasPasskey) {
      if (localseed.isEnabled()) {
        const local = toLocalSeedStream(item, season, episode);
        local.url = `${baseUrl}/local/resolve/${local._payload}`;
        delete local._payload;
        streams.push(local);
      }
      continue; // never sent to RD — see file header
    }
    if (!config.REALDEBRID_TOKEN) continue;
    rdEligible++;
    streams.push(toDebridStream(item, baseUrl, rdHashes.has(item.torrent.infoHash.toLowerCase())));
```

- [ ] **Step 4: Add `resolveLocalSeed()` and export it**

After the existing `resolveDebridLink()` function, add:

```js
/**
 * Resolve a local-seed stream at play time — thin adapter between Express's
 * (req, res) and lib/localseed.js's streamRelease(), which owns the whole
 * response lifecycle (it may serve from the mount, an in-progress torrent
 * download, or reject with 503 under admission control). season/episode
 * come from the payload itself (encoded in toLocalSeedStream()), not from
 * the request — Stremio's play request carries no such query param.
 */
async function resolveLocalSeed(req, res, payloadB64) {
  const { infoHash, trackers, title, season, episode } = localseed.decodePayload(payloadB64);
  await localseed.streamRelease(req, res, { infoHash, trackers, title }, season, episode);
}
```

Update the final `module.exports`:

```js
module.exports = { getStreams, resolveDebridLink, resolveLocalSeed, parseStreamId };
```

- [ ] **Step 5: Verify with a syntax + smoke check**

```bash
node -c stream.js && echo OK
node -e "
const stream = require('./stream');
console.log(typeof stream.resolveLocalSeed === 'function' ? 'PASS: resolveLocalSeed exported' : 'FAIL');
"
```

Expected: `OK`, then `PASS: resolveLocalSeed exported`.

- [ ] **Step 6: Commit**

```bash
git add stream.js
git commit -m "Add Local stream option for passkey-bearing releases"
```

---

### Task 7: Route + eviction interval in `addon.js`

**Files:**
- Modify: `addon.js`

**Interfaces:**
- Consumes: `stream.resolveLocalSeed` (Task 6), `localseed.isEnabled`, `localseed.sweepEviction` (Task 4)

- [ ] **Step 1: Import the module**

In `addon.js`, after `const activityLog = require('./activity-log');`, add:

```js
const localseed = require('./lib/localseed');
```

- [ ] **Step 2: Add the `/local/resolve/:payload` route**

After the existing `/rd/resolve/:payload` route block (inside the `if (config.REALDEBRID_TOKEN) { ... }` in `main()`), add a sibling block:

```js
  // Local-seed: this addon downloads/seeds the torrent on its own VPS for
  // releases RD can't take (passkey-bearing). Self-disables when the Drive
  // mount is not present — see lib/localseed.js.
  if (localseed.isEnabled()) {
    app.get('/local/resolve/:payload', async (req, res) => {
      try {
        await stream.resolveLocalSeed(req, res, req.params.payload);
      } catch (err) {
        console.error(`[localseed] resolve failed: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).type('text/plain').send(`Local seedbox error: ${err.message}`);
        }
      }
    });
  }
```

- [ ] **Step 3: Add the eviction sweep to the daily interval**

In `main()`, find the existing daily-refresh `setInterval` block and the activity-log rotation lines right after it:

```js
  activityLog.rotate();
  setInterval(() => activityLog.rotate(), REFRESH_INTERVAL_MS);
}
```

Replace with:

```js
  activityLog.rotate();
  setInterval(() => activityLog.rotate(), REFRESH_INTERVAL_MS);

  // Same daily cadence: keep the Google Drive mount under its usage cap.
  if (localseed.isEnabled()) {
    localseed.sweepEviction().catch(err => console.error('[localseed] eviction sweep failed:', err.message));
    setInterval(() => {
      localseed.sweepEviction().catch(err => console.error('[localseed] eviction sweep failed:', err.message));
    }, REFRESH_INTERVAL_MS);
  }
}
```

- [ ] **Step 4: Add a boot log line**

Near the existing `console.log('[boot] activity log: ...')` line, add:

```js
  console.log(`[boot] local-seed: ${localseed.isEnabled() ? 'enabled (' + config.LOCALSEED.MOUNT_PATH + ')' : 'disabled (no mount)'}`);
```

- [ ] **Step 5: Verify syntax and route registration**

```bash
node -c addon.js && echo OK
```

Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add addon.js
git commit -m "Wire /local/resolve route and daily eviction sweep into addon.js"
```

---

### Task 8: rclone mount deploy files

**Files:**
- Create: `deploy/rclone-gdrive-mount.service`
- Create: `deploy/rclone-setup.md`

- [ ] **Step 1: Write the systemd unit**

Create `deploy/rclone-gdrive-mount.service`:

```ini
[Unit]
Description=rclone mount of Google Drive for the local-seed feature
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=ubuntu
ExecStart=/usr/bin/rclone mount gdrive: /mnt/gdrive \
  --config /home/ubuntu/.config/rclone/rclone.conf \
  --vfs-cache-mode minimal \
  --allow-other \
  --dir-cache-time 1h
ExecStop=/bin/fusermount -u /mnt/gdrive
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the one-time setup doc**

Create `deploy/rclone-setup.md`:

```markdown
# rclone Google Drive mount — one-time VPS setup

Run once, manually, on the VPS. This is interactive (Google OAuth
consent) and cannot be scripted end-to-end.

1. Install rclone:

   ```bash
   curl https://rclone.org/install.sh | sudo bash
   ```

2. Create the mount point:

   ```bash
   sudo mkdir -p /mnt/gdrive
   sudo chown ubuntu:ubuntu /mnt/gdrive
   ```

3. Configure the `gdrive` remote:

   ```bash
   rclone config
   ```

   Choose `n` (new remote), name it exactly `gdrive`, type `drive`
   (Google Drive), leave client_id/client_secret blank (use rclone's own),
   scope `drive` (full access), leave root_folder_id blank, and when asked
   "Use auto config?" answer `n` if this is a headless SSH session — it
   will print a URL to open in a browser on any machine, plus a place to
   paste the resulting verification code back into the SSH session.

4. Enable `user_allow_other` for `--allow-other` to work:

   ```bash
   echo 'user_allow_other' | sudo tee -a /etc/fuse.conf
   ```

5. Install and start the mount service:

   ```bash
   sudo cp deploy/rclone-gdrive-mount.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now rclone-gdrive-mount.service
   ```

6. Verify:

   ```bash
   systemctl is-active rclone-gdrive-mount
   ls /mnt/gdrive
   ```

   `ls` should list the contents of your Google Drive root (empty is fine
   on a fresh account) without hanging or erroring.

7. Set `GDRIVE_MOUNT_PATH=/mnt/gdrive` in `.env` if you used a different
   mount point than the default.
```

- [ ] **Step 3: Commit**

```bash
git add deploy/rclone-gdrive-mount.service deploy/rclone-setup.md
git commit -m "Add rclone Google Drive mount systemd unit and setup doc"
```

---

### Task 9: Deploy to VPS

**Files:** none (operational task)

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Confirm rclone setup is done (or do it now)**

Follow `deploy/rclone-setup.md` on the VPS if not already done. This step requires the user to complete the interactive Google OAuth consent themselves (opening a URL and pasting back a code) — an agent cannot do this on the user's behalf, as it is the user's own Google account login.

```bash
ssh -i oci.key ubuntu@129.154.250.79 "systemctl is-active rclone-gdrive-mount && ls /mnt/gdrive"
```

Expected: `active`, and a directory listing (possibly empty) with no error.

- [ ] **Step 3: Pull, install dependencies, restart the addon**

```bash
ssh -i oci.key ubuntu@129.154.250.79 "cd /home/ubuntu/stremio-india-ott && git pull origin main && npm install --omit=dev && sudo systemctl restart stremio-india-ott"
```

- [ ] **Step 4: Verify boot log shows local-seed enabled**

```bash
ssh -i oci.key ubuntu@129.154.250.79 "sleep 60 && grep 'local-seed' /home/ubuntu/stremio-india-ott/addon.log | tail -1"
```

Expected: `[boot] local-seed: enabled (/mnt/gdrive)`. If it prints `disabled (no mount)`, the mount from Step 2 is not actually present — re-check `systemctl status rclone-gdrive-mount` before proceeding.

- [ ] **Step 5: Smoke test against a real passkey release**

Search for a title known to return only passkey-bearing releases (per earlier session logs, e.g. any TorrentLeech-only result), confirm a `Local` stream option now appears alongside `P2P`, and that pressing play starts a download (check `/activity`'s new "Local Seed" tab for a `download-start` row).

```bash
ssh -i oci.key ubuntu@129.154.250.79 "curl -s http://127.0.0.1:7000/activity | grep -o 'Local Seed'"
```

Expected: `Local Seed` (confirms the new tab renders).
