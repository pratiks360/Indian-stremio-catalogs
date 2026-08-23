'use strict';

/**
 * Free public HTTP proxies, for the two platforms (SonyLIV, JioHotstar) that
 * block this VPS's IP at the CDN edge by datacenter ASN — confirmed via
 * response headers (CloudFront/Akamai reporting our ASN back at us), not a
 * JS/fingerprint challenge. No browser sophistication fixes an IP-reputation
 * block; only a request that doesn't originate from a flagged datacenter IP
 * does. This is the free version of that — a paid residential/mobile proxy
 * would be far more reliable, but wasn't what was asked for.
 *
 * Set expectations accordingly: free public proxy lists are low-quality.
 * Most listed proxies are dead, slow, or already blocklisted themselves
 * (frequently because they're ALSO hosted on cloud/datacenter IPs, which
 * would hit the exact same ASN block we're trying to route around). This
 * tests each candidate against the real target before trusting it, and
 * gives up cleanly — not silently returning empty data — when none work.
 */

const { ProxyAgent, fetch: undiciFetch } = require('undici');
const { browserHeaders } = require('./http');

// Node's global fetch is powered by its own internally bundled undici. A
// ProxyAgent built from the separately npm-installed "undici" package is a
// different module instance — passing it as `dispatcher` to global fetch
// throws UND_ERR_INVALID_ARG on every call, unconditionally (confirmed live:
// 100% failure across 40 distinct proxies, immediately, is a code bug
// signature, not proxy-quality variance). Must use undici's own fetch.

const PROXY_LIST_URL =
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=yes&anonymity=all';

async function fetchProxyCandidates() {
  const res = await fetch(PROXY_LIST_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`proxy list fetch failed: ${res.status}`);
  const text = await res.text();
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(l));
}

/**
 * Try candidate proxies against the real target URL until one actually gets
 * past whatever is blocking us (verified by status + a sanity check on body
 * size, not just "didn't throw" — a proxy can "succeed" with a 403 too).
 *
 * @param {string} testUrl - the real URL that's currently blocked
 * @param {(status:number, body:string) => boolean} isGood - does this response mean we got through?
 * @param {number} maxAttempts
 * @returns {Promise<{addr: string, dispatcher: ProxyAgent}|null>} a working proxy, or null if none worked
 */
async function findWorkingProxy(testUrl, isGood, maxAttempts = 12) {
  let candidates;
  try {
    candidates = await fetchProxyCandidates();
  } catch (err) {
    console.warn(`[proxy] could not fetch proxy list: ${err.message}`);
    return null;
  }

  // Shuffle — the list is roughly freshness-ordered, but "freshest" free
  // proxies get hammered by every scraper using the same public list.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  console.log(`[proxy] ${candidates.length} candidates fetched, testing up to ${maxAttempts}`);

  let tried = 0;
  for (const addr of candidates) {
    if (tried >= maxAttempts) break;
    tried++;
    const dispatcher = new ProxyAgent(`http://${addr}`);
    try {
      const res = await undiciFetch(testUrl, {
        headers: browserHeaders(),
        dispatcher,
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.text();
      if (isGood(res.status, body)) {
        console.log(`[proxy] working proxy found: ${addr} (attempt ${tried}/${maxAttempts})`);
        return { addr, dispatcher };
      }
      console.log(`[proxy] ${addr} -> status ${res.status}, ${body.length}b (rejected)`);
    } catch (err) {
      const cause = err.cause ? `: ${err.cause.code || err.cause.message}` : '';
      console.log(`[proxy] ${addr} -> ${err.message}${cause}`);
    }
  }

  console.warn(`[proxy] no working proxy found after ${tried} attempts`);
  return null;
}

module.exports = { findWorkingProxy, fetchProxyCandidates, fetchViaProxy: undiciFetch };
