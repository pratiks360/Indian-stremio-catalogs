'use strict';

/**
 * Headless-browser fetch for platforms whose Akamai Bot Manager fails a
 * plain HTTP client outright (SonyLIV, JioHotstar) — unlike ZEE5, which only
 * needed a full browser header set (see lib/http.js), these run a real JS
 * sensor challenge that only an actual browser engine can pass.
 *
 * Rather than scraping the rendered DOM (fragile — breaks on any UI/class
 * name change), this drives a real page load and captures the site's own
 * XHR/fetch JSON responses as the page makes them. The browser solves the
 * bot challenge as a side effect of loading the page normally; we just
 * listen for the same clean API responses a real user's browser receives.
 *
 * Resource note: this VPS runs on ~1GB RAM with the addon's Node process
 * already resident. Chromium is launched fresh per call and closed
 * immediately after — never kept warm — specifically to keep it out of the
 * steady-state memory footprint. Callers must not run two of these
 * concurrently.
 */

const { CHROME_UA } = require('./http');

let launchLock = Promise.resolve(); // serializes calls — see file header

/**
 * Load a page in headless Chromium and capture JSON responses whose URL
 * matches `matchUrl`.
 *
 * @param {string} pageUrl
 * @param {{matchUrl: RegExp, timeoutMs?: number, waitAfterMs?: number, extraHeaders?: object, proxyServer?: string}} opts
 * @returns {Promise<Array<{url: string, json: any}>>}
 */
async function captureApiResponses(pageUrl, opts) {
  const { matchUrl, timeoutMs = 30000, waitAfterMs = 4000, extraHeaders, proxyServer } = opts;

  // Run one browser at a time — chromium under memory pressure on a ~1GB
  // box is a bad place to have two instances launching together.
  const run = launchLock.then(() => doCaptureApiResponses(pageUrl, matchUrl, timeoutMs, waitAfterMs, extraHeaders, proxyServer));
  launchLock = run.catch(() => {}); // don't let one failure jam the queue
  return run;
}

async function doCaptureApiResponses(pageUrl, matchUrl, timeoutMs, waitAfterMs, extraHeaders, proxyServer) {
  const { chromium } = require('playwright');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--no-sandbox', // no setuid sandbox helper installed on this box
      '--disable-dev-shm-usage', // /dev/shm is tiny on small VPS instances; use /tmp instead
      '--disable-setuid-sandbox'
    ],
    // SonyLIV/JioHotstar block this VPS's IP by datacenter ASN at the CDN
    // edge — proven via response headers, before any page JS runs. Routing
    // Chromium itself through a proxy is what actually gets a page to load
    // at all; a real browser is still needed on top of that for the
    // separate Akamai JS-sensor challenge these platforms' API domains run.
    proxy: proxyServer ? { server: proxyServer } : undefined
  });

  try {
    const context = await browser.newContext({
      userAgent: CHROME_UA,
      locale: 'en-IN',
      extraHTTPHeaders: extraHeaders
    });
    const page = await context.newPage();

    const captured = [];
    page.on('response', res => {
      const url = res.url();
      if (!matchUrl.test(url)) return;
      if (res.status() !== 200) return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      captured.push(
        res.json()
          .then(json => ({ url, json }))
          .catch(() => null)
      );
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(err => {
      console.warn(`[browser] navigation to ${pageUrl} did not settle: ${err.message}`);
    });
    await page.waitForTimeout(waitAfterMs); // late XHRs after networkidle

    const resolved = await Promise.all(captured);
    return resolved.filter(Boolean);
  } finally {
    await browser.close();
  }
}

module.exports = { captureApiResponses };
