#!/bin/bash
# launch-chrome.sh — Launch Chrome in the noVNC desktop with Penantia extension pre-loaded
# Run this inside the noVNC container (in the Xvfb display session)
#
# Usage: bash launch-chrome.sh
# The extension auto-connects to the Penantia AI backend on startup.

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_WS_URL="${PENANTIA_WS_URL:-wss://penantia-ai-backend-x64glrg3eq-as.a.run.app/extension-ws}"

echo "[Penantia] Launching Chrome with extension from: $EXTENSION_DIR"
echo "[Penantia] Backend WS: $BACKEND_WS_URL"

# Write runtime config into the extension's storage via a startup page
# (Chrome extensions can read storage on first run via defaults)
cat > /tmp/penantia_startup.html <<EOF
<html><body><script>
chrome.storage.sync.set({ wsUrl: '$BACKEND_WS_URL' }, () => {
  document.body.textContent = 'Penantia Agent configured. Closing...';
  setTimeout(() => window.close(), 1000);
});
</script></body></html>
EOF

# Launch Chrome with extension loaded, no sandbox (needed in container)
google-chrome \
  --load-extension="$EXTENSION_DIR" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --remote-debugging-port=9222 \
  --window-size=1280,900 \
  --start-maximized \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except="$EXTENSION_DIR" \
  --user-data-dir=/tmp/penantia-chrome-profile \
  "file:///tmp/penantia_startup.html" \
  "about:blank" &

echo "[Penantia] Chrome launched. Extension connecting to backend..."
echo "[Penantia] Remote debugging: http://localhost:9222"
