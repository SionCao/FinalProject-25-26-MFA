#!/usr/bin/env bash
set -euo pipefail

VERSION="fusion-growth-20260814-2"
BASE_URL="http://127.0.0.1:5501"
CHROME_APP="/Applications/Google Chrome.app"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Google Chrome executable not found at $CHROME_BIN"
  exit 1
fi

echo "Opening capture page without tabs/address bar..."
"$CHROME_BIN" \
  --new-window \
  --start-fullscreen \
  --app="$BASE_URL/index.html?v=$VERSION&absorbFusion=1" \
  >/tmp/face-cell-chrome-capture.log 2>&1 &

sleep 1

echo "Opening projection page in kiosk mode..."
"$CHROME_BIN" \
  --new-window \
  --kiosk \
  "$BASE_URL/petri.html?v=$VERSION&absorbFusion=1" \
  >/tmp/face-cell-chrome-projection.log 2>&1 &

echo "Done. Quit exhibition windows with Cmd+Q."
