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
