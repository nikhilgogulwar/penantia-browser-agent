// background.js — Penantia Browser Agent Service Worker v1.1.0
// Execution: chrome.scripting.executeScript (direct injection, no message passing)

const VERSION = "1.1.0";
const DEFAULT_WS_URL = "wss://penantia-ai-backend-x64glrg3eq-as.a.run.app/extension-ws";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PORT_CYCLE_MS = 295000;

let ws = null;
let wsReconnectDelay = RECONNECT_BASE_MS;
let wsConnecting = false;

// ── KEEPALIVE: alarms (1 min minimum — avoids Chrome ping sound) ──────────────
chrome.alarms.create("penantia-heartbeat", { periodInMinutes: 1.0 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "penantia-heartbeat") return;
  chrome.storage.session.set({ lastHeartbeat: Date.now() });
  if (!ws || ws.readyState > 1) scheduleReconnect(true);
});

// ── KEEPALIVE: port cycling ────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "penantia-keepalive") return;
  port.onDisconnect.addListener(() => {});
});

// ── WEBSOCKET ──────────────────────────────────────────────────────────────────
async function getWsUrl() {
  return new Promise(res => chrome.storage.sync.get(["wsUrl"], r => res(r.wsUrl || DEFAULT_WS_URL)));
}

async function connect() {
  if (wsConnecting || (ws && ws.readyState <= 1)) return;
  wsConnecting = true;
  const wsUrl = await getWsUrl();
  const { sessionContextId } = await chrome.storage.session.get(["sessionContextId"]).catch(() => ({}));
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      wsReconnectDelay = RECONNECT_BASE_MS; wsConnecting = false;
      ws.send(JSON.stringify(sessionContextId
        ? { type: "SESSION_RESUME", version: VERSION, contextId: sessionContextId }
        : { type: "connected", version: VERSION }));
    };
    ws.onmessage = async (e) => {
      let cmd; try { cmd = JSON.parse(e.data); } catch { return; }
      await handleCommand(cmd);
    };
    ws.onclose = () => { ws = null; wsConnecting = false; scheduleReconnect(false); };
    ws.onerror  = () => { wsConnecting = false; };
  } catch { wsConnecting = false; scheduleReconnect(false); }
}

function scheduleReconnect(immediate) {
  if (wsConnecting) return;
  const delay = immediate ? 500 : wsReconnectDelay;
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, RECONNECT_MAX_MS);
  setTimeout(connect, delay);
}

function send(payload) {
  if (ws?.readyState === 1) { ws.send(JSON.stringify(payload)); return true; }
  return false;
}

// ── SCRIPTING HELPERS ──────────────────────────────────────────────────────────
// Run a function in the page's MAIN world and return its result
async function runInPage(tabId, fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  });
  return results?.[0]?.result;
}

// Inject cursor CSS+logic into ISOLATED world (where content.js runs)
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
}

// ── PAGE FUNCTIONS (run via scripting.executeScript MAIN world) ────────────────

function fn_snapshot() {
  // Build/refresh global element registry on window.__pmt
  window.__pmt = window.__pmt || {};
  window.__pmtSeq = (window.__pmtSeq || 0);

  const ITAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY','LABEL']);
  const IROLES = new Set(['button','link','checkbox','menuitem','tab','option','radio',
    'combobox','listbox','textbox','searchbox','switch','treeitem']);

  function isVis(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.bottom < -50 || r.top > window.innerHeight + 50) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch { return false; }
  }

  function isInt(el) {
    if (ITAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && IROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && ti !== '-1';
  }

  function getText(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('alt') ||
            el.getAttribute('placeholder') || el.getAttribute('title') ||
            (el.innerText || '')).slice(0, 100).trim();
  }

  function harvest(root, out) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT,
      { acceptNode: () => NodeFilter.FILTER_ACCEPT });
    let n = walker.nextNode();
    while (n) {
      if (isInt(n) && isVis(n)) out.push(n);
      if (n.shadowRoot?.mode === 'open') harvest(n.shadowRoot, out);
      n = walker.nextNode();
    }
  }

  // Reset registry
  window.__pmt = {};
  window.__pmtSeq = 0;
  const els = [];
  harvest(document.documentElement, els);

  const nodes = els.map(el => {
    const ref = ++window.__pmtSeq;
    window.__pmt[ref] = el;
    const r = el.getBoundingClientRect();
    const node = {
      ref,
      role: el.tagName.toLowerCase(),
      text: getText(el),
      bounds: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
    if (el.type)  node.type  = el.type;
    if (el.value) node.value = String(el.value).slice(0, 100);
    if (el.disabled) node.disabled = true;
    return node;
  });

  return { type: 'snapshot', url: location.href, title: document.title,
           viewport: { w: window.innerWidth, h: window.innerHeight },
           nodes, count: nodes.length };
}

function fn_click(ref) {
  const el = (window.__pmt || {})[ref];
  if (!el) return { ok: false, error: 'ref ' + ref + ' not found. Take a snapshot first.' };
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 40) };
}

function fn_fill(ref, text) {
  const el = (window.__pmt || {})[ref];
  if (!el) return { ok: false, error: 'ref ' + ref + ' not found' };
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, text); else el.value = text;
  if (el._valueTracker) el._valueTracker.setValue('');
  ['input','change'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
  return { ok: true, filled: text };
}

function fn_scroll(direction, amount) {
  window.scrollBy({ top: direction === 'down' ? (amount||400) : -(amount||400), behavior: 'smooth' });
  return { ok: true };
}

// ── CURSOR (injected via content.js into isolated world) ──────────────────────
function fn_show_cursor(cx, cy, tag, labelText) {
  // This runs in MAIN world — we communicate to the cursor in isolated world
  // via a custom event that content.js listens for
  window.dispatchEvent(new CustomEvent('__penantia_move', {
    detail: { cx, cy, tag, label: labelText }
  }));
  return true;
}

// ── COMMAND HANDLER ────────────────────────────────────────────────────────────
async function handleCommand(cmd) {
  const { cmd: action, req_id } = cmd;
  if (cmd.contextId) chrome.storage.session.set({ sessionContextId: cmd.contextId });

  if (action === "set_config") {
    if (cmd.wsUrl) chrome.storage.sync.set({ wsUrl: cmd.wsUrl });
    send({ type: "config_ack", req_id }); return;
  }

  if (action === "ping") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [null]);
    send({ type: "pong", req_id, version: VERSION, tabUrl: tab?.url || null }); return;
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [null]);
  if (!tab) { send({ type: "error", req_id, error: "No active tab" }); return; }
  const tabId = tab.id;

  try {
    switch (action) {

      case "navigate": {
        await chrome.tabs.update(tabId, { url: cmd.url });
        await waitForTabLoad(tabId, 20000);
        await ensureContentScript(tabId);
        await new Promise(r => setTimeout(r, 500));
        const snap = await runInPage(tabId, fn_snapshot);
        send({ type: "action_result", req_id, ok: true, url: cmd.url, post_snapshot: snap });
        break;
      }

      case "snapshot": {
        await ensureContentScript(tabId);
        const snap = await runInPage(tabId, fn_snapshot);
        send({ ...(snap || {}), req_id });
        break;
      }

      case "click": {
        await ensureContentScript(tabId);
        // Move cursor to element bounds (from last snapshot)
        const bounds = cmd.bounds;
        if (bounds) {
          const cx = bounds[0] + bounds[2]/2, cy = bounds[1] + bounds[3]/2;
          await runInPage(tabId, fn_show_cursor, [cx, cy, cmd.role||'', cmd.text||'']);
          await new Promise(r => setTimeout(r, 380));
        }
        const res = await runInPage(tabId, fn_click, [cmd.ref]);
        await new Promise(r => setTimeout(r, 500));
        const snap = await runInPage(tabId, fn_snapshot);
        send({ type: "action_result", req_id, ...(res||{}), post_snapshot: snap });
        break;
      }

      case "fill": {
        const res = await runInPage(tabId, fn_fill, [cmd.ref, cmd.text]);
        send({ type: "action_result", req_id, ...(res||{}) });
        break;
      }

      case "scroll": {
        const res = await runInPage(tabId, fn_scroll, [cmd.direction, cmd.amount]);
        await new Promise(r => setTimeout(r, 400));
        const snap = await runInPage(tabId, fn_snapshot);
        send({ type: "action_result", req_id, ...(res||{}), post_snapshot: snap });
        break;
      }

      default:
        send({ type: "error", req_id, error: `Unknown cmd: ${action}` });
    }
  } catch (err) {
    send({ type: "action_result", req_id, ok: false, error: String(err) });
  }
}

// Wait for tab load
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, t => { if (t?.status === "complete") { resolve(); return; } });
    const timer = setTimeout(resolve, timeoutMs);
    const fn = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn);
        setTimeout(resolve, 800);
      }
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// ── POPUP MESSAGES ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.cmd === "popup_status")  { reply({ wsOpen: ws?.readyState === 1 }); return false; }
  if (msg.cmd === "reconnect") {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    wsReconnectDelay = RECONNECT_BASE_MS; wsConnecting = false;
    setTimeout(connect, 500); reply({ ok: true }); return false;
  }
  return false;
});

connect();
console.log("[Penantia] background v" + VERSION + " started");
