#!/usr/bin/env python3
"""Dump the shape of ZEE5's homepage collectionData so we can write a parser."""
import json, re, sys

html = open('/tmp/zee_full.html', encoding='utf-8', errors='replace').read()
m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
if not m:
    sys.exit('no __NEXT_DATA__')

data = json.loads(m.group(1))
cd = data['props']['pageProps']['collectionData']
print('collectionData keys:', list(cd.keys()))
print('id:', cd.get('id'), '| title:', cd.get('title'))

rails = cd.get('rails') or []
print('rails:', len(rails))
print()

for i, b in enumerate(rails[:20]):
    items = b.get('contents') or []
    print('%2d | %-42s | items=%-3d | keys=%s' % (
        i,
        str(b.get('title') or b.get('original_title') or '?')[:42],
        len(items),
        ','.join(list(b.keys())[:8])
    ))

print()
# First rail that actually carries titles -> show one item in full
for b in rails:
    items = b.get('contents') or []
    if items:
        print('=== sample rail:', b.get('title'), '===')
        print('item keys:', list(items[0].keys()))
        print()
        for it in items[:6]:
            print(' -', repr(it.get('title'))[:60],
                  '| asset_subtype=', it.get('asset_subtype'),
                  '| asset_type=', it.get('asset_type'),
                  '| lang=', it.get('languages'),
                  '| release=', it.get('release_date'))
        print()
        print('full first item:')
        print(json.dumps(items[0], indent=1)[:1500])
        break
