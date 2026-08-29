// Cloudflare Worker: dumb reverse-proxy in front of api.themoviedb.org.
//
// Exists because Amazon CloudFront (which fronts TMDB) resets ~60-80% of
// TLS handshakes from this app's Oracle Cloud VPS IP (confirmed live via
// curl/openssl testing — a raw TCP connect succeeds every time, but the
// TLS ClientHello gets RST'd most of the time; a control request to a
// Fastly-fronted site from the same VPS was 100% clean). Cloudflare's own
// edge isn't subject to that block, so TMDB calls get routed through here
// instead of straight from the VPS.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste
// this file's contents -> Deploy. No account permissions beyond the
// account you're already in are needed; this is a stateless passthrough.
//
// Wire-up: set TMDB_PROXY_URL=https://<worker-name>.<subdomain>.workers.dev/3
// in .env (the trailing /3 matches TMDB_BASE's shape in config.js) and
// restart the addon. Leave unset to hit TMDB directly (the pre-existing
// behavior).
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL('https://api.themoviedb.org' + url.pathname + url.search);

    const upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body
    });

    const res = new Response(upstream.body, upstream);
    res.headers.set('access-control-allow-origin', '*');
    return res;
  }
};
