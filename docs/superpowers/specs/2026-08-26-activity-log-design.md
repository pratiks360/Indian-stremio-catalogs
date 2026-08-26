# Activity/Debug Log — Design Spec

Date: 2026-08-26

## Purpose

Track addon activity end-to-end for debugging: what was searched, what was
sent to Prowlarr, what came back, what the user clicked, whether the torrent
fetch/RD add succeeded, and daily catalog refresh outcomes. Expose as a
human-readable HTML table at `/activity`.

## Architecture

New module `activity-log.js`: centralized logger, single writer to
`data/activity.log` (line-delimited JSON, append-only). Call sites elsewhere
in the addon call its methods; failures inside the logger are caught and
never propagate — activity logging must never break addon function.

`/activity` HTTP endpoint (added in `addon.js`) reads the log file, parses
each line, buckets by event type, and renders an HTML page with 5 tabs (one
per event type). Each tab shows the latest 100 events for that type, newest
first, one **row per event** (not columns-as-events).

## Event Schema

Five event types, each a JSON object with a `type` field plus these fields:

| Event type | Fields |
|---|---|
| `stream_search` | `timestamp`, `imdbId`, `title`, `searchType` (movie/series), `prowlarrQuery`, `releaseCount`, `releases` (top 10 result titles), `success` |
| `user_click` | `timestamp`, `imdbId`, `releaseTitle`, `indexer`, `infoHash`, `deliveryPath` (p2p/rd) |
| `torrent_fetch` | `timestamp`, `releaseTitle`, `indexer`, `success`, `errorMsg`, `duration_ms` |
| `catalog_refresh` | `timestamp`, `platform`, `itemsAdded`, `duration_ms` |
| `rd_action` | `timestamp`, `action` (add/poll/resolve), `torrentHash`, `success`, `status`, `duration_ms` |

`timestamp` is an ISO 8601 string, UTC.

## activity-log.js API

```js
streamSearch({ imdbId, title, searchType, prowlarrQuery, releaseCount, releases, success })
userClick({ imdbId, releaseTitle, indexer, infoHash, deliveryPath })
torrentFetch({ releaseTitle, indexer, success, errorMsg, duration_ms })
catalogRefresh({ platform, itemsAdded, duration_ms })
rdAction({ action, torrentHash, success, status, duration_ms })
```

Each method stamps `timestamp` + `type`, serializes to one JSON line, and
appends to `data/activity.log`. All methods are synchronous fire-and-forget
from the caller's perspective — internally wrapped in try-catch, errors go to
`console.warn` only.

## Integration Points

| File | Call site | Method |
|---|---|---|
| `stream.js` | `getStreams()` — after Prowlarr query resolves | `streamSearch` |
| `stream.js` | stream click / resolve handler | `userClick` |
| `lib/realdebrid.js` | `addTorrent()`, `pollTorrent()`, resolve | `rdAction` |
| `catalog.js` | `getCatalog()` platform refresh | `catalogRefresh` |
| `debrid_catalog.js` | `build()` | `catalogRefresh` (platform: `'realdebrid'`) |
| `stream.js` (or wherever the actual torrent/magnet fetch happens) | torrent fetch success/fail | `torrentFetch` |

Each call site wraps its `activityLog.*` call in try-catch (belt-and-suspenders
on top of the logger's own internal catch) so a logging failure can never
abort the real request being served.

## /activity Endpoint & UI

- Route: `GET /activity`, HTML response.
- Reads `data/activity.log`, parses line by line; malformed/corrupted lines
  are skipped silently.
- Groups events by `type` into 5 buckets.
- Renders a tabbed page (plain HTML/CSS, no JS framework — consistent with
  existing `/runlog` page style):
  - Tabs: Streams · Clicks · Fetches · Catalog Refreshes · RD Actions
  - Each tab: a table, latest 100 events of that type, **newest first, one
    row per event**, columns = that event's fields per the schema table
    above (success/failure shown as ✓/✗, durations in ms).
  - No filters, no pagination beyond the 100-row cap, no query params.

## Data Rotation

7-day rolling retention. On addon startup and once every 24h (same interval
used for the existing daily catalog refresh in `addon.js`), the logger scans
`data/activity.log`, drops lines with `timestamp` older than `now - 7d`, and
rewrites the file with only the surviving lines. This keeps the file small
(~1MB range at typical addon traffic) without needing a database.

## Error Handling

- Every `activity-log.js` method is wrapped in try-catch internally; a write
  failure (disk full, permission error) is logged to `console.warn` and
  swallowed — the caller's real operation (serving a stream, updating a
  catalog) is never blocked or failed because logging failed.
- The `/activity` endpoint treats any unparseable line in the log file as
  skippable noise rather than a fatal read error; the page still renders with
  whatever valid events remain.
- Log rotation is best-effort: if rewriting the file fails, the old file is
  left in place and rotation is retried on the next interval.
