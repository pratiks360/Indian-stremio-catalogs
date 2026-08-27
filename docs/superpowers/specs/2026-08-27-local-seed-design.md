# Local Seedbox (VPS Download + Google Drive Mount) — Design Spec

Date: 2026-08-27

## Purpose

Some Prowlarr releases carry a tracker passkey and are therefore never
offered through Real-Debrid (RD) — sending a passkey-bearing torrent to a
third-party service like RD would have RD's servers announce to the tracker
as the user, a bannable offence on most private trackers (see
`.env.example`'s existing note and `stream.js`'s `hasPasskey` check). Today
those releases fall back to direct P2P only, which depends on Stremio's
built-in torrent engine and the playing device's own network — and fails
outright on some devices/networks (observed: works on Android mobile, hangs
forever on a Google TV Streamer, most likely a local network/BitTorrent
connectivity limitation on that device).

This feature adds a third stream option for exactly those passkey releases:
download and seed the torrent from the addon's own VPS (a legitimate
seedbox — the tracker sees the user's own passkey announcing from a single
consistent, user-controlled IP, unlike a third-party service), stream it to
Stremio over plain HTTP while it downloads, then move the finished file onto
a Google Drive mount so the VPS's own disk (34GB free) only ever has to hold
what's actively downloading right now, not the whole accumulated library.
Replays stream straight off the mount — no re-download.

## Architecture

- `lib/localseed.js` — new module, mirrors the shape of `lib/realdebrid.js`.
  Owns one long-lived `WebTorrent.Client()` instance for the addon process.
- **rclone mount**, not a Drive API client — `rclone mount gdrive:
  /mnt/gdrive` runs as its own systemd service, a separate Go process
  outside the Node addon. Auth is set up once via `rclone config`'s own
  interactive OAuth flow; the addon never touches Drive credentials
  directly.
- New stream option **"Local"**, offered alongside P2P for any release
  `hasPasskey` — i.e. exactly the releases RD already skips. RD-eligible
  releases are unaffected; this does not change the existing P2P/RD logic.
- New endpoint `GET /local/resolve/:payload` (parallel to
  `/rd/resolve/:payload`) — payload carries infoHash, tracker list, and
  release title, same shape as the RD resolve payload. Stremio's play
  request hits this URL; the addon starts (or resumes) the torrent, or
  serves the already-completed file straight off the mount.

### Why not write/stream the torrent directly on the mount

BitTorrent writes pieces out of order as they arrive from different peers,
not sequentially. rclone's mount cannot perform that kind of random-access
write directly against Drive — to support it at all, rclone would fall back
to caching the entire file locally anyway (`vfs-cache-mode=full`) before or
while uploading. So downloading straight onto the mount would not avoid
local disk usage during the download; it would use the same amount (or
more, with added FUSE overhead) as downloading to local disk directly.
Local disk during the active download is therefore unavoidable — what this
design avoids is *accumulating* every download there permanently.

## Data Flow

1. `stream.js` builds a `Local` stream entry for any `hasPasskey` release,
   pointing at `/local/resolve/:payload`.
2. On play, `/local/resolve/:payload`:
   - If the file already exists on the mount (`/mnt/gdrive/stremio-seed/`,
     keyed by infoHash) from a previous download, stream it straight from
     there — no torrent involved, no re-download.
   - Else if the torrent is already active in the `WebTorrent.Client()` (a
     prior request for the same title, still downloading), reuse it.
   - Else add it by infoHash + tracker list to local disk
     (`data/localseed/`); WebTorrent starts fetching pieces immediately.
3. While downloading to local disk, the addon selects the right file within
   the torrent (reusing `pickFileIdx()` from `lib/bencode.js` for season
   packs) and pipes `file.createReadStream({start, end})` directly into the
   HTTP response. Stremio's own range requests naturally throttle to
   download progress — standard WebTorrent server behavior, no custom
   buffering needed.
4. On download completion: the addon moves the finished file from
   `data/localseed/` to `/mnt/gdrive/stremio-seed/`, named/tagged by the
   release's infoHash (dedupe key — same role `guid` plays in
   `lib/prowlarr.js`'s existing disk cache). This frees local disk
   immediately; the move itself is safe because the file is complete and no
   longer being written — the risky case (reading a file on the mount while
   it's still being written) never occurs.
5. The torrent keeps seeding locally for a configured window after
   completion (24h default, ratio/goodwill) before WebTorrent removes it —
   independent of the move to the mount, which already happened in step 4.

## Concurrency & Memory

The VPS has ~954MB RAM total; baseline OS + Prowlarr + this addon already
use roughly half of it, leaving limited headroom for WebTorrent's own piece
buffers. `rclone mount` runs as its own process outside the Node addon, so
it does not count against the addon's own memory ceiling — but it does add
to the box's overall RAM usage and must be accounted for in practice.

- Hard cap: **3 concurrent local-seed torrents** via the single
  `WebTorrent.Client()`.
- A request for a torrent already active (a second viewer of the same
  title) reuses the existing instance and does not count against the cap
  again.
- Before adding a torrent past the concurrency cap, or when memory is
  already tight, check `process.memoryUsage().rss` against a configured
  ceiling. Over ceiling → reject with a `pending`-style "server busy"
  response (same shape as RD's "still downloading" response) rather than
  silently queuing or risking an OOM.
- The exact RSS ceiling is tuned during implementation against real
  measured growth per active torrent, starting conservatively (well under
  the box's total RAM, leaving room for the OS, Prowlarr, rclone, and the
  rest of the addon).

## Storage & Eviction

- Local disk: `data/localseed/` — video files only, separate from the
  existing `.torrent` metadata cache in `data/torrents/`. Only ever holds
  files actively downloading or just-completed-and-not-yet-moved; not a
  long-term store, so eviction pressure here is minimal by design.
- Mount (`/mnt/gdrive/stremio-seed/`) is the long-term store. LRU eviction
  keyed on **least-recently-played**: a periodic sweep (daily, alongside
  the existing catalog-refresh interval in `addon.js`) checks usage via
  `rclone about gdrive:` against a configured cap and deletes the
  oldest-played files first when over it, using a plain `fs.unlink` on the
  mount path.
- If local disk is ever still low when a new download needs to start (e.g.
  several large downloads in flight against the 3-concurrent cap), the
  request is rejected the same way as hitting the memory ceiling, rather
  than starting a download it may not be able to finish.

## rclone Mount Setup

- One-time setup on the VPS: `rclone config` walks through Google's OAuth
  consent flow interactively and stores the resulting token in rclone's own
  config file (`~/.config/rclone/rclone.conf`) — the addon never sees or
  stores Drive credentials itself.
- The mount runs as a systemd service (`rclone-gdrive-mount.service`,
  alongside the existing `deploy/stremio-india-ott.service`), so it comes
  up automatically on boot and restarts if it crashes — the addon's
  `/local/resolve/` handler depends on `/mnt/gdrive` being present.
- `vfs-cache-mode writes` — not `minimal`/`off`. Live testing hit
  `EIO: i/o error` copying a 500MB+ completed file onto the mount; `writes`
  mode gives rclone a real local write buffer, which is a more robust
  setup for large writes regardless. **The actual root cause of that
  specific EIO was traced separately to a Google API rate limit
  (403 `RATE_LIMIT_EXCEEDED`) on rclone's shared client_id** — see the
  rclone-setup note below. `vfs-cache-mode` was not the cause; kept as a
  defensive improvement anyway.
- **Known risk**: this remote uses rclone's shared client_id (see
  `rclone-setup.md`), not a dedicated one. That shared client_id is a
  single Google Cloud project used by every rclone user who skips the
  "create your own client_id" step, so its request-rate quota is shared
  globally — a rate-limit 403 was hit during testing after normal usage,
  unrelated to anything specific this addon did. rclone itself also warns
  the shared client_id is being retired in 2026. If rate-limit errors
  recur, the fix is creating a dedicated Google Cloud OAuth client_id/secret
  (`rclone config` → edit the `gdrive` remote) rather than tuning
  `vfs-cache-mode` further.

## Error Handling

- WebTorrent add failure (bad infoHash/trackers, no reachable peers) →
  same `pending`-style response as RD's "still downloading" — Stremio shows
  it as unavailable rather than erroring hard.
- Move-to-mount failure (rclone mount unreachable, Drive quota exceeded) →
  logged via `console.warn`; the file stays in `data/localseed/` and is
  still playable from there. Retried on the next daily eviction sweep.
- Memory ceiling or local-disk-too-low hit → the new request is rejected
  immediately with a clear "server busy" response rather than queuing
  indefinitely or starting a download that can't complete.
- Mount unavailable entirely (systemd service down) → `/local/resolve/`
  falls back to the local-disk/WebTorrent path only (no replay-from-mount
  shortcut, no move-on-completion); logged as a warning so the mount
  service getting stuck is visible.

## Activity Log Integration

Reuses the existing `activity-log.js` module
(`docs/superpowers/specs/2026-08-26-activity-log-design.md`). A new
`local_seed` event type, and a corresponding 6th tab on the existing
`/activity` page, logs: torrent added, download start/complete, move-to-
mount result, and mount eviction events, following the same
line-delimited-JSON, 7-day-retention pattern the other five event types
already use.
