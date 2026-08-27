'use strict';

const assert = require('assert');
const {
  encodePayload, decodePayload, mountFilename, shouldAdmit, selectEvictionTargets
} = require('../lib/localseed_util');

// encodePayload / decodePayload round-trip
{
  const original = { infoHash: 'ABCDEF1234', trackers: ['udp://tracker.example:80'], title: 'Test Release', season: 1, episode: 2 };
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
