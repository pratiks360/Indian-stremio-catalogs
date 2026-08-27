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
