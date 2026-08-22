#!/usr/bin/env python3
"""Distribution of the fields the ZEE5 scraper will depend on."""
import json, re
from collections import Counter

html = open('/tmp/zee_full.html', encoding='utf-8', errors='replace').read()
data = json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S).group(1))
rails = data['props']['pageProps']['collectionData']['rails']

sub, langs, atype, biz = Counter(), Counter(), Counter(), Counter()
total = 0
no_date = 0
for r in rails:
    for it in (r.get('contents') or []):
        total += 1
        sub[it.get('assetSubType')] += 1
        atype[it.get('assetType')] += 1
        biz[it.get('businessType')] += 1
        for l in (it.get('languages') or ['<none>']):
            langs[l] += 1
        if not it.get('releaseDate'):
            no_date += 1

print('total items :', total)
print('no releaseDate:', no_date)
print('assetSubType :', dict(sub))
print('assetType    :', dict(atype))
print('businessType :', dict(biz))
print('languages    :', dict(langs))
print()
for r in rails:
    items = r.get('contents') or []
    print('--- rail:', r.get('title'), '| totalResults=', r.get('totalResults'), '| url=', r.get('url'))
    for it in items[:5]:
        print('    %-34s %-10s %-6s %s' % (
            str(it.get('title'))[:34],
            it.get('assetSubType'),
            ','.join(it.get('languages') or []),
            it.get('releaseDate')))
