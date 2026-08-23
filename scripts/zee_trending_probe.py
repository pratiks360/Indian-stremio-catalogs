#!/usr/bin/env python3
"""
Probe several ZEE5 pages for a rail that's an actual trending/most-watched
chart rather than the homepage's promotional carousel. Prints rail titles
and item counts per URL so we can compare against the known homepage shape.
"""
import json, re, subprocess, sys

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

HEADERS = [
    '-H', f'user-agent: {UA}',
    '-H', 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '-H', 'accept-language: en-IN,en;q=0.9',
    '-H', 'sec-ch-ua: "Chromium";v="131", "Not_A Brand";v="24"',
    '-H', 'sec-ch-ua-mobile: ?0',
    '-H', 'sec-ch-ua-platform: "Windows"',
    '-H', 'sec-fetch-dest: document',
    '-H', 'sec-fetch-mode: navigate',
    '-H', 'sec-fetch-site: none',
    '-H', 'sec-fetch-user: ?1',
    '-H', 'upgrade-insecure-requests: 1',
]

URLS = [
    'https://www.zee5.com/movies',
    'https://www.zee5.com/web-series',
    'https://www.zee5.com/tv-shows',
    'https://www.zee5.com/trending',
    'https://www.zee5.com/movies/language/hindi',
    'https://www.zee5.com/web-series/language/hindi',
]

COOKIE_JAR = '/tmp/zee_cookies.txt'

def fetch(url, referer=None):
    hdrs = list(HEADERS)
    if referer:
        hdrs += ['-H', f'referer: {referer}']
    out = subprocess.run(
        ['curl', '-s', '-w', '\n__STATUS__%{http_code}',
         '-b', COOKIE_JAR, '-c', COOKIE_JAR] + hdrs + [url],
        capture_output=True, text=True, timeout=30
    ).stdout
    body, _, status = out.rpartition('__STATUS__')
    return body, status.strip()

# Prime the cookie jar with a homepage visit — Akamai may be gating on a
# session cookie / prior referer, not just headers.
print('Priming session via homepage...')
_home, _status = fetch('https://www.zee5.com/')
print('  homepage status:', _status)

def extract_next_data(html):
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None

for url in URLS:
    print(f'\n=== {url} ===')
    try:
        html, status = fetch(url, referer='https://www.zee5.com/')
    except Exception as e:
        print('  fetch failed:', e)
        continue
    print('  status:', status, '| size:', len(html))
    if status != '200':
        continue
    data = extract_next_data(html)
    if not data:
        print('  no __NEXT_DATA__')
        continue
    pp = data.get('props', {}).get('pageProps', {})
    print('  pageProps keys:', list(pp.keys()))
    cd = pp.get('collectionData')
    if cd and isinstance(cd, dict):
        rails = cd.get('rails') or []
        print(f'  collectionData id={cd.get("id")} rails={len(rails)}')
        for r in rails[:12]:
            n = len(r.get('contents') or [])
            print(f'    - {str(r.get("title"))[:50]:50} items={n} sortType={r.get("sortType")} url={r.get("url")}')
    else:
        # Some listing pages may use a different key entirely.
        for k, v in pp.items():
            if isinstance(v, dict) and ('rails' in v or 'contents' in v):
                print(f'  candidate key "{k}":', list(v.keys())[:10])
