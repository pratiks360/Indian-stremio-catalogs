#!/usr/bin/env bash
# Probe the Indian OTT endpoints from whatever host this runs on.
# Prints status + the few bytes that tell us whether we were geo-blocked,
# bot-blocked, or served real data.

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

hdrs=(
  -H "user-agent: $UA"
  -H "accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  -H "accept-language: en-IN,en;q=0.9"
  -H "sec-ch-ua: \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\""
  -H "sec-ch-ua-mobile: ?0"
  -H "sec-ch-ua-platform: \"Windows\""
  -H "sec-fetch-dest: document"
  -H "sec-fetch-mode: navigate"
  -H "sec-fetch-site: none"
  -H "sec-fetch-user: ?1"
  -H "upgrade-insecure-requests: 1"
)

echo "=== egress ==="
curl -s ipinfo.io/json | tr -d '\n' | head -c 300; echo

echo
echo "=== ZEE5 homepage (bare UA) ==="
curl -s -o /tmp/zee_bare.html -w 'status=%{http_code} size=%{size_download}\n' \
  -A "$UA" --compressed https://www.zee5.com/
head -c 300 /tmp/zee_bare.html; echo

echo
echo "=== ZEE5 homepage (full browser headers) ==="
curl -s -o /tmp/zee_full.html -w 'status=%{http_code} size=%{size_download}\n' \
  "${hdrs[@]}" --compressed https://www.zee5.com/
echo "__NEXT_DATA__ present: $(grep -c '__NEXT_DATA__' /tmp/zee_full.html)"
echo "country in payload   : $(grep -o '"country":"[A-Z][A-Z]"' /tmp/zee_full.html | head -3 | tr '\n' ' ')"
echo "collectionData       : $(grep -o '"collectionData":.\{0,30\}' /tmp/zee_full.html | head -1)"
head -c 300 /tmp/zee_full.html; echo

echo
echo "=== SonyLIV token ==="
curl -s -o /tmp/sony_tok.json -w 'status=%{http_code}\n' \
  -H "user-agent: $UA" -H 'accept: application/json' \
  https://apiv2.sonyliv.com/AGL/1.4/A/ENG/WEB/ALL/GETTOKEN
head -c 200 /tmp/sony_tok.json; echo

echo
echo "=== SonyLIV tray (with token) ==="
TOKEN=$(sed -n 's/.*"resultObj":"\([^"]*\)".*/\1/p' /tmp/sony_tok.json)
echo "token length: ${#TOKEN}"
curl -s -o /tmp/sony_tray.json -w 'status=%{http_code} size=%{size_download}\n' \
  -H "user-agent: $UA" \
  -H 'accept: application/json' \
  -H 'accept-language: en-IN,en;q=0.9' \
  -H "security_token: $TOKEN" \
  -H 'app_version: 3.5.20' \
  -H 'device_id: dc0b1a2b-0000-4000-8000-000000000001' \
  -H 'Origin: https://www.sonyliv.com' \
  -H 'Referer: https://www.sonyliv.com/' \
  'https://apiv2.sonyliv.com/AGL/2.4/A/ENG/WEB/IN/HOME/1/LIST?from=0&to=20'
head -c 300 /tmp/sony_tray.json; echo

echo
echo "=== JioHotstar homepage ==="
curl -s -o /tmp/jhs.html -w 'status=%{http_code} size=%{size_download}\n' \
  "${hdrs[@]}" --compressed https://www.jiohotstar.com/in/home
echo "__NEXT_DATA__ present: $(grep -c '__NEXT_DATA__' /tmp/jhs.html)"
grep -o 'not available[^<]\{0,60\}' /tmp/jhs.html | head -2

echo
echo "=== JioHotstar apix ==="
curl -s -o /tmp/jhs_api.json -w 'status=%{http_code} size=%{size_download}\n' \
  -H "user-agent: $UA" \
  -H 'x-country-code: in' \
  -H 'x-platform-code: PCTV' \
  -H 'x-client-code: LR' \
  -H 'x-hs-accept-language: eng' \
  -H 'x-hs-platform: web' \
  'https://apix.hotstar.com/o/v1/page/1256?offset=0&size=20&tao=0&tas=20'
head -c 250 /tmp/jhs_api.json; echo

echo
echo "=== Netflix Tudum (control) ==="
curl -s -o /dev/null -w 'status=%{http_code} size=%{size_download}\n' \
  -A "$UA" https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv
