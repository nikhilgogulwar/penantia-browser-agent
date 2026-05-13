# Installing Penantia Browser Agent in noVNC Desktop

## Auto-install (recommended)

1. Clone this repo inside the noVNC container:
   ```bash
   git clone https://github.com/nikhilgogulwar/penantia-browser-agent.git /opt/penantia-extension
   ```

2. Launch Chrome with the extension pre-loaded:
   ```bash
   cd /opt/penantia-extension
   bash install/launch-chrome.sh
   ```

Chrome will open with the Penantia extension active.
The extension connects to the AI backend WebSocket automatically on startup.

## Manual install (development)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `penantia-browser-agent` directory

## Verifying the connection

1. Click the Penantia extension icon (top right of Chrome)
2. The popup shows **Connected** with a green dot
3. In the AI backend logs: `[ExtWS] Extension connected: <id>`

## Changing the backend URL

Edit the WebSocket URL in the popup, then click **Save & Reconnect**.
Or set `PENANTIA_WS_URL` environment variable before running `launch-chrome.sh`.
