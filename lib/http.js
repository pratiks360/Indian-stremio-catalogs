'use strict';

/**
 * Shared HTTP helpers for the platform scrapers.
 *
 * The header set here is not decoration. ZEE5 returns a 403 Akamai
 * "Access Denied" to a bare user-agent and a full 200 with the complete
 * Chrome header set — from the same IP, in the same second. Anything that
 * fronts Akamai (ZEE5, SonyLIV, JioHotstar) wants to see the whole shape of a
 * real browser request, not just a UA string.
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function browserHeaders(extra = {}) {
  return Object.assign(
    {
      'user-agent': CHROME_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-IN,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    },
    extra
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * fetch with retry/backoff. These endpoints reset connections and rate-limit
 * under load, and a scrape failure means an empty catalog, so it is worth
 * a few attempts before giving up.
 */
async function fetchWithRetry(url, options = {}, { retries = 3, label = 'http', minBytes = 0 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      if (text.length < minBytes) {
        throw new Error(`response too short (${text.length} < ${minBytes} bytes)`);
      }
      return text;
    } catch (err) {
      lastErr = err.cause ? new Error(`${err.message}: ${err.cause.message}`) : err;
      console.warn(`[${label}] attempt ${attempt}/${retries} failed: ${lastErr.message}`);
      if (attempt < retries) await sleep(attempt * 1500);
    }
  }
  throw lastErr;
}

/** Pull and parse the __NEXT_DATA__ blob out of a Next.js server-rendered page. */
function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found in page');
  return JSON.parse(m[1]);
}

module.exports = { CHROME_UA, browserHeaders, fetchWithRetry, extractNextData, sleep };
