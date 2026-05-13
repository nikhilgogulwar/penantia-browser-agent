// background.js — Penantia Browser Agent Service Worker v1.0.0
// Handles: WS connection, keepalive, command routing to content script

const VERSION = "1.0.0";

// --- Config (override via chrome.storage.sync) ---
const DEFAULT_WS_URL = "wss://penantia-ai-backend-x64glrg3eq-as.a.run.app/extension-ws";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;  // 30s — covers Cloud Run cold start
const PORT_CYCLE_MS = 295000;    // 295s — evades Chrome's 5-min port hard kill
const HEARTBEAT_MINUTES = 0.4;   // 24s — resets Chrome's 30s idle kill

// --- State ---
let ws = null;
let wsReconnectDelay = RECONNECT_BASE_MS;
let wsConnecting = false;

// ============================================================
// KEEPALIVE 1 — chrome.alarms heartbeat (resets 30s idle kill)
// ============================================================
chrome.alarms.create("penantia-heartbeat", { periodInMinutes: HEARTBEAT_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "penantia-heartbeat") return;
  // Minimal storage write resets Chromium idle timer
  chrome.storage.session.set({ lastHeartbeat: Date.now() });
  // Reconnect if WS dropped
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    scheduleReconnect(true);
  }
});

// ============================================================
// KEEPALIVE 2 — port cycling (evades 5-min hard port kill)
// ============================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "penantia-keepalive") return;
  port.onDisconnect.addListener(() => {
    // Content script will reconnect at PORT_CYCLE_MS interval
  });
});

// ============================================================
// WEBSOCKET MANAGEMENT
// ============================================================
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["wsUrl"], (r) => {
      resolve({ wsUrl: r.wsUrl || DEFAULT_WS_URL });
    });
  });
}

async function connect() {
  if (wsConnecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  wsConnecting = true;
  const { wsUrl } = await getConfig();
  const { sessionContextId } = await chrome.storage.session.get(["sessionContextId"]).catch(() => ({}));

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[Penantia] WS connected to", wsUrl);
      wsReconnectDelay = RECONNECT_BASE_MS;
      wsConnecting = false;

      const hello = sessionContextId
        ? { type: "SESSION_RESUME", version: VERSION, contextId: sessionContextId }
        : { type: "connected", version: VERSION };
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = async (event) => {
      let cmd;
      try { cmd = JSON.parse(event.data); } catch { return; }
      await handleCommand(cmd);
    };

    ws.onclose = (ev) => {
      console.log("[Penantia] WS closed:", ev.code, ev.reason);
      ws = null;
      wsConnecting = false;
      scheduleReconnect(false);
    };

    ws.onerror = () => {
      wsConnecting = false;
    };

  } catch (err) {
    console.error("[Penantia] connect error:", err);
    wsConnecting = false;
    scheduleReconnect(false);
  }
}

function scheduleReconnect(immediate) {
  if (wsConnecting) return;
  const delay = immediate ? 1000 : wsReconnectDelay;
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, RECONNECT_MAX_MS);
  setTimeout(() => { connect(); }, delay);
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// ============================================================
// COMMAND HANDLER
// ============================================================
async function handleCommand(cmd) {
  const { cmd: action, req_id } = cmd;

  // Persist context ID for session resume
  if (cmd.contextId) {
    chrome.storage.session.set({ sessionContextId: cmd.contextId });
  }

  // Config update from backend
  if (action === "set_config") {
    if (cmd.wsUrl) chrome.storage.sync.set({ wsUrl: cmd.wsUrl });
    send({ type: "config_ack", req_id });
    return;
  }

  // Ping — no tab needed
  if (action === "ping") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [null]);
    send({ type: "pong", req_id, version: VERSION, tabUrl: tab?.url || null });
    return;
  }

  // Get active tab for all other commands
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  } catch { /* swallow */ }

  if (!tab) {
    send({ type: "error", req_id, error: "No active tab" });
    return;
  }

  // Navigate is handled in background (tab API access needed)
  if (action === "navigate") {
    try {
      await chrome.tabs.update(tab.id, { url: cmd.url });
      await waitForTabLoad(tab.id, 20000);
      // After load, take a snapshot
      const snapshot = await sendToContentScript(tab.id, { cmd: "snapshot" });
      send({ type: "action_result", req_id, ok: true, url: cmd.url, post_snapshot: snapshot });
    } catch (err) {
      send({ type: "action_result", req_id, ok: false, error: String(err) });
    }
    return;
  }

  // All other commands go to content script
  try {
    // Ensure content script is injected
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    }).catch(() => {}); // ignore if already injected

    const result = await sendToContentScript(tab.id, { ...cmd });
    send({ ...result, req_id });
  } catch (err) {
    send({ type: "action_result", req_id, ok: false, error: String(err) });
  }
}

// Send message to content script with timeout
function sendToContentScript(tabId, msg, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Content script timeout")), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

// Wait for tab to finish loading
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === "complete") { resolve(); return; }
    });
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // don't reject — page may be interactive even if not "complete"
    }, timeoutMs);
    const listener = (updId, info) => {
      if (updId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 800); // extra 800ms for React hydration
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Startup
connect();
console.log("[Penantia] Background service worker started v" + VERSION);

// ============================================================
// INTERNAL MESSAGES — popup.js communication
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.cmd === "popup_status") {
    reply({ wsOpen: ws !== null && ws.readyState === WebSocket.OPEN });
    return false;
  }
  if (msg.cmd === "reconnect") {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    wsReconnectDelay = RECONNECT_BASE_MS;
    wsConnecting = false;
    setTimeout(connect, 500);
    reply({ ok: true });
    return false;
  }
  // Unknown internal messages — ignore
  return false;
});
