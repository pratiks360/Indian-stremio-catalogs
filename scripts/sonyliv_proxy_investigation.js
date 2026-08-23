'use strict';

/**
 * Documents why SonyLIV / JioHotstar stayed on TMDB Discover rather than
 * getting a real scraper, so a future session doesn't re-run this whole
 * investigation from scratch.
 *
 * FINDING: both platforms block this VPS's IP at the CDN edge by datacenter
 * ASN (Oracle Cloud, AS31898) — confirmed via response headers:
 *   SonyLIV:    server: CloudFront, x-cache: Error from cloudfront
 *   JioHotstar: server: AkamaiGHost, x-asnno: 31898 (our own ASN, echoed back)
 * This happens before any page JS runs — a real headless Chromium hits the
 * exact same 403/475 as a plain fetch. Browser sophistication was never the
 * variable; only requests NOT from a flagged datacenter IP get through.
 *
 * TRIED: free public proxies (api.proxyscrape.com list) via lib/proxy.js,
 * combined with headless Chromium routed through a working one (lib/browser.js
 * supports this via the `proxyServer` option). Two live runs on this VPS:
 *   - Run A: proxy passed www.sonyliv.com AND loaded the full SPA bundle, but
 *     the page's own request to bootstrap-prod.sonyliv.com got a 403 — a
 *     THIRD subdomain with its own independent CDN/WAF check. Passing one
 *     subdomain's block doesn't mean passing another's.
 *   - Run B (different random proxy pick): timed out loading the homepage
 *     itself in 8s.
 * Conclusion: free proxy pool quality is too inconsistent run-to-run to be a
 * dependable 24h-refresh source, and SonyLIV in particular gates multiple
 * subdomains independently. This is a real infrastructure limit (proxy
 * quality / multi-domain WAF), not a code bug — confirmed live, not guessed.
 *
 * A paid residential/mobile proxy would very likely fix this (real IPs,
 * consistent uptime) but was explicitly not what was asked for.
 *
 * lib/proxy.js and lib/browser.js are kept as reusable infra for a future
 * target that's blocked by IP reputation alone (single domain, no multi-CDN
 * gate) rather than rebuilding this from zero.
 *
 * Run this to see the current state of the free proxy pool + SonyLIV's block
 * (both fluctuate — this is not a fixed, one-time result):
 *   node scripts/sonyliv_proxy_investigation.js
 */

const { findWorkingProxy, fetchViaProxy: fetch } = require('../lib/proxy');
const { browserHeaders } = require('../lib/http');
const { captureApiResponses } = require('../lib/browser');

(async () => {
  console.log('=== 1. plain fetch, no proxy (expected: 403 CloudFront) ===');
  const bare = await globalThis.fetch('https://www.sonyliv.com/', { headers: browserHeaders() });
  console.log('status:', bare.status, '| server:', bare.headers.get('server'));

  console.log('\n=== 2. finding a working free proxy for www.sonyliv.com ===');
  const found = await findWorkingProxy(
    'https://www.sonyliv.com/',
    (status, body) => status === 200 && body.length > 5000 && !/error/i.test(body.slice(0, 200)),
    40
  );
  if (!found) {
    console.log('No working proxy found this run (pool quality varies).');
    return;
  }
  console.log('working proxy:', found.addr);

  console.log('\n=== 3. plain fetch of the DATA api through that proxy ===');
  const tokRes = await fetch('https://apiv2.sonyliv.com/AGL/1.4/A/ENG/WEB/ALL/GETTOKEN', {
    headers: browserHeaders({ accept: 'application/json' }),
    dispatcher: found.dispatcher
  });
  const token = (await tokRes.json()).resultObj;
  const trayRes = await fetch('https://apiv2.sonyliv.com/AGL/2.4/A/ENG/WEB/IN/HOME/1/LIST?from=0&to=20', {
    headers: browserHeaders({ accept: 'application/json', security_token: token }),
    dispatcher: found.dispatcher
  });
  console.log('tray status:', trayRes.status, '(503 = Akamai JS-sensor challenge on this subdomain)');

  console.log('\n=== 4. headless Chromium through the same proxy, capturing apiv2 XHRs ===');
  const captured = await captureApiResponses('https://www.sonyliv.com/', {
    matchUrl: /apiv2\.sonyliv\.com/i,
    timeoutMs: 45000,
    waitAfterMs: 8000,
    proxyServer: `http://${found.addr}`
  });
  console.log(`captured ${captured.length} apiv2 JSON responses via headless browser+proxy`);
})().catch(err => console.error('FAILED:', err.message));
