# penantia-browser-agent

Penantia AI browser agent — DOM automation made visible.

MV3 Chrome extension that gives the Penantia AI agent full control of your browser.
The user watches every action happen in real time via an animated cursor and element highlights.

## Architecture

- `background.js` — Service worker: WebSocket keepalive + command router
- `content.js` — DOM serializer + action executor + cursor manager (self-contained)
- `manifest.json` — MV3 permissions
- `popup/` — Connection status popup
- `install/` — noVNC Chrome launch scripts

## Install (noVNC desktop)

See `install/launch-chrome.sh` for how to launch Chrome with the extension pre-loaded.
The extension auto-connects to the Penantia AI backend on startup.
