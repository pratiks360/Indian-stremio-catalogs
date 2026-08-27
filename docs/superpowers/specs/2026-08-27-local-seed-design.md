# Local Seedbox (VPS Download + Google Drive Archive) — Design Spec

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
Stremio over plain HTTP while it downloads, and archive the finished file to
Google Drive for reuse without needing the VPS's own disk to hold everything
long-term.

## Architecture

- `lib/localseed.js` — new module, mirrors the shape of `lib/realdebrid.js`.
  Owns one long-lived `WebTorrent.Client()` instance for the addon process.
- `lib/gdrive.js` — thin Google Drive API wrapper (OAuth2 refresh-token
  auth): upload, list, delete.
- New stream option **"Local"**, offered alongside P2P for any release
  `hasPasskey` — i.e. exactly the releases RD already skips. RD-eligible
  releases are unaffected; this does not change the existing P2P/RD logic.
- New endpoint `GET /local/resolve/:payload` (parallel to
  `/rd/resolve/:payload`) — payload carries infoHash, tracker list, and
  release title, same shape as the RD resolve payload. Stremio's play
  request hits this URL; the addon starts (or resumes) the torrent locally
  and streams the response.

## Data Flow

1. `stream.js` builds a `Local` stream entry for any `hasPasskey` release,
   pointing at `/local/resolve/:payload`.
2. On play, `/local/resolve/:payload`:
   - If the torrent is already active in the `WebTorrent.Client()` (a prior
     request for the same title), reuse it.
   - Else add it by infoHash + tracker list; WebTorrent starts fetching
     pieces immediately.
3. The addon selects the right file within the torrent (reusing
   `pickFileIdx()` from `lib/bencode.js` for season packs) and pipes
   `file.createReadStream({start, end})` directly into the HTTP response.
   Stremio's own range requests naturally throttle to download progress —
   this is standard WebTorrent server behavior, no custom buffering needed.
4. On file completion: a background job uploads the file to the Drive
   `stremio-seed` folder, tagging it with the release's `infoHash` in Drive
   file metadata (dedupe key — same role `guid` plays in
   `lib/prowlarr.js`'s existing disk cache).
5. The torrent keeps seeding locally for a configured window after
   completion (24h default, ratio/goodwill), then WebTorrent removes it —
   the local video file itself stays on disk until LRU eviction reclaims it.

## Concurrency & Memory

The VPS has ~954MB RAM total; baseline OS + Prowlarr + this addon already
use roughly half of it, leaving limited headroom for WebTorrent's own piece
buffers.

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
  the box's total RAM, leaving room for the OS, Prowlarr, and the rest of
  the addon).

## Storage & Eviction

- Local disk: `data/localseed/` — video files only, separate from the
  existing `.torrent` metadata cache in `data/torrents/`.
- Two-tier LRU eviction, both keyed on **least-recently-played**, not
  upload time:
  - **Local disk**: before starting a new download, if free space drops
    below a reserved floor, delete completed local files (oldest-played
    first) until there is room. A file already archived on Drive is safe to
    delete locally — a later replay simply re-downloads it.
  - **Google Drive**: a periodic sweep (daily, alongside the existing
    catalog-refresh interval in `addon.js`) checks total usage in the
    `stremio-seed` folder against a configured cap and deletes the oldest
    files first when over it.

## Google Drive Auth

- OAuth2 refresh-token flow — Drive's write API does not support a
  permanent API key. One-time setup: authorize via Google's consent screen,
  store the resulting refresh token in `.env`
  (`GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`), the
  same pattern `REALDEBRID_TOKEN` already follows.
- A one-off script, `scripts/gdrive_auth.js`, walks through the consent flow
  locally and prints the refresh token to paste into `.env`. Not part of the
  running addon.
- `lib/gdrive.js` exchanges the refresh token for short-lived access tokens
  automatically — no manual renewal needed afterward.
- All uploads go to one fixed folder (`stremio-seed`), created on first use
  if it does not already exist.

## Error Handling

- WebTorrent add failure (bad infoHash/trackers, no reachable peers) →
  same `pending`-style response as RD's "still downloading" — Stremio shows
  it as unavailable rather than erroring hard.
- Drive upload failure → logged via `console.warn`; the file stays local
  only and playback is unaffected (upload happens in the background, after
  playback has already started). Retried once on the next daily eviction
  sweep; given up after that (logged, not retried indefinitely).
- Memory ceiling hit → the new request is rejected immediately with a clear
  "server busy" response rather than queuing indefinitely.
- Disk full despite an eviction attempt (e.g. a single file larger than the
  reserved floor) → the download is aborted and the error is surfaced the
  same way an existing Prowlarr torrent-fetch failure is.

## Activity Log Integration

Reuses the existing `activity-log.js` module
(`docs/superpowers/specs/2026-08-26-activity-log-design.md`). A new
`local_seed` event type, and a corresponding 6th tab on the existing
`/activity` page, logs: torrent added, download start/complete, Drive
upload result, and eviction events (local and Drive), following the same
line-delimited-JSON, 7-day-retention pattern the other five event types
already use.
