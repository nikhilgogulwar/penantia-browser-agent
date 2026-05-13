// popup.js — Penantia Browser Agent popup
const DEFAULT_WS_URL = "wss://penantia-ai-backend-x64glrg3eq-as.a.run.app/extension-ws";

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const wsUrlInput = document.getElementById('wsUrl');
const saveBtn = document.getElementById('saveBtn');

function setStatus(state) {
  dot.className = 'status-dot ' + state;
  const labels = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting...' };
  statusText.textContent = labels[state] || state;
}

// Load current config
chrome.storage.sync.get(['wsUrl'], (r) => {
  wsUrlInput.value = r.wsUrl || DEFAULT_WS_URL;
});

// Check connection state via background ping
function checkStatus() {
  setStatus('connecting');
  chrome.runtime.sendMessage({ cmd: 'popup_status' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('disconnected'); return;
    }
    setStatus(response.wsOpen ? 'connected' : 'disconnected');
  });
}

saveBtn.addEventListener('click', () => {
  const newUrl = wsUrlInput.value.trim();
  if (!newUrl) return;
  chrome.storage.sync.set({ wsUrl: newUrl }, () => {
    chrome.runtime.sendMessage({ cmd: 'reconnect' });
    setTimeout(checkStatus, 1500);
  });
});

checkStatus();
setInterval(checkStatus, 3000);
