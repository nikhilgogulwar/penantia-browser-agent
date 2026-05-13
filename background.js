// background.js v1.1.1 — clean working base + reload_extension command
// CACHE TERMINATOR: has reload_extension handler so all future updates self-apply

const VERSION = "1.1.1";
const DEFAULT_WS_URL = "wss://penantia-ai-backend-x64glrg3eq-as.a.run.app/extension-ws";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null, wsDelay = RECONNECT_BASE_MS, wsConnecting = false;

chrome.alarms.create("pmt-hb", { periodInMinutes: 1.0 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== "pmt-hb") return;
  chrome.storage.session.set({ hb: Date.now() });
  if (!ws || ws.readyState > 1) scheduleReconnect(true);
});
chrome.runtime.onConnect.addListener(p => { if (p.name==="pmt-ka") p.onDisconnect.addListener(()=>{}); });

async function getUrl() {
  return new Promise(r => chrome.storage.sync.get(["wsUrl"], d => r(d.wsUrl || DEFAULT_WS_URL)));
}

async function connect() {
  if (wsConnecting || (ws && ws.readyState <= 1)) return;
  wsConnecting = true;
  const url = await getUrl();
  const saved = await chrome.storage.session.get(["ctx"]).catch(() => ({}));
  const ctx = saved.ctx;
  try {
    ws = new WebSocket(url);
    ws.onopen = () => {
      wsDelay = RECONNECT_BASE_MS; wsConnecting = false;
      ws.send(JSON.stringify(ctx
        ? { type: "SESSION_RESUME", version: VERSION, contextId: ctx }
        : { type: "connected", version: VERSION }));
    };
    ws.onmessage = async e => {
      let cmd; try { cmd = JSON.parse(e.data); } catch { return; }
      await handle(cmd);
    };
    ws.onclose = () => { ws = null; wsConnecting = false; scheduleReconnect(false); };
    ws.onerror = () => { wsConnecting = false; };
  } catch { wsConnecting = false; scheduleReconnect(false); }
}

function scheduleReconnect(imm) {
  if (wsConnecting) return;
  const d = imm ? 500 : wsDelay;
  wsDelay = Math.min(wsDelay * 2, RECONNECT_MAX_MS);
  setTimeout(connect, d);
}

const send = p => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(p)); };

// ── PAGE FUNCTIONS (executeScript, isolated world) ────────────────────────────

function fn_snapshot() {
  window.__pmt = {}; window.__pmtSeq = 0;
  const ITAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY','LABEL']);
  const IROLES = new Set(['button','link','checkbox','menuitem','tab','option','radio',
    'combobox','listbox','textbox','searchbox','switch','treeitem']);
  function isVis(el) {
    try { const r = el.getBoundingClientRect();
      if (!r.width||!r.height||r.bottom<-50||r.top>window.innerHeight+50) return false;
      const s = window.getComputedStyle(el);
      return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';
    } catch { return false; } }
  function isInt(el) {
    if (ITAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role&&IROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    return ti!==null&&ti!=='-1'; }
  function getText(el) {
    return (el.getAttribute('aria-label')||el.getAttribute('alt')||
            el.getAttribute('placeholder')||el.getAttribute('title')||
            (el.innerText||'')).slice(0,100).trim(); }
  function harvest(root, out) {
    if (!root) return;
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT,
        {acceptNode:()=>NodeFilter.FILTER_ACCEPT});
      let n = w.nextNode();
      while (n) { if (isInt(n)&&isVis(n)) out.push(n);
        if (n.shadowRoot&&n.shadowRoot.mode==='open') harvest(n.shadowRoot,out);
        n = w.nextNode(); }
    } catch {} }
  const els = []; harvest(document.documentElement, els);
  const nodes = els.map(el => {
    const ref = ++window.__pmtSeq; window.__pmt[ref] = el;
    const r2 = el.getBoundingClientRect();
    const node = {ref, role:el.tagName.toLowerCase(), text:getText(el),
      bounds:[Math.round(r2.left),Math.round(r2.top),Math.round(r2.width),Math.round(r2.height)]};
    if (el.type) node.type = el.type;
    if (el.value) node.value = String(el.value).slice(0,100);
    if (el.disabled) node.disabled = true;
    return node; });
  return {type:'snapshot',url:location.href,title:document.title,
    viewport:{w:window.innerWidth,h:window.innerHeight},nodes,count:nodes.length}; }

function fn_click(ref) {
  const el = (window.__pmt||{})[ref];
  if (!el) return {ok:false,error:`ref ${ref} not found`};
  el.scrollIntoView({behavior:'smooth',block:'center'});
  el.focus();
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t=>
    el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})));
  el.click();
  return {ok:true,tag:el.tagName.toLowerCase(),text:(el.innerText||'').slice(0,40)}; }

function fn_fill(ref, text) {
  const el = (window.__pmt||{})[ref];
  if (!el) return {ok:false,error:`ref ${ref} not found`};
  el.focus(); el.click();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto,'value');
  if (desc&&desc.set) desc.set.call(el,text); else el.value = text;
  if (el._valueTracker) el._valueTracker.setValue('');
  el.dispatchEvent(new Event('input',{bubbles:true}));
  return {ok:true,filled:text}; }

function fn_scroll(dir, amt) {
  window.scrollBy({top:dir==='down'?(amt||400):-(amt||400),behavior:'smooth'});
  return {ok:true}; }

async function run(tabId, fn, args=[]) {
  const res = await chrome.scripting.executeScript({target:{tabId},func:fn,args});
  return res&&res[0]&&res[0].result; }

async function ensureCs(tabId) {
  await chrome.scripting.executeScript({target:{tabId},files:['content.js']}).catch(()=>{});
  await new Promise(r=>setTimeout(r,300)); }

// ── COMMAND HANDLER ───────────────────────────────────────────────────────────
async function handle(cmd) {
  const { cmd:action, req_id } = cmd;
  if (cmd.contextId) chrome.storage.session.set({ctx:cmd.contextId});

  // ── CACHE TERMINATOR ──────────────────────────────────────────────────────
  // When backend pushes new code: POST /extension/exec {cmd:"reload_extension"}
  // Extension reloads itself, Chrome re-reads all files from /opt/penantia-extension/
  if (action === 'reload_extension') {
    send({type:'reload_ack',req_id,version:VERSION});
    setTimeout(() => chrome.runtime.reload(), 500);
    return; }

  if (action==='ping') {
    const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
    const t = tabs[0];
    send({type:'pong',req_id,version:VERSION,tabUrl:t&&t.url||null}); return; }

  const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
  const tab = tabs[0];
  if (!tab) { send({type:'error',req_id,error:'No active tab'}); return; }
  const tid = tab.id;

  try {
    switch(action) {
      case 'navigate': {
        await chrome.tabs.update(tid,{url:cmd.url});
        await waitLoad(tid,20000);
        await ensureCs(tid);
        await new Promise(r=>setTimeout(r,500));
        const snap = await run(tid, fn_snapshot);
        send({type:'action_result',req_id,ok:true,url:cmd.url,post_snapshot:snap});
        break; }
      case 'snapshot': {
        await ensureCs(tid);
        const snap = await run(tid, fn_snapshot);
        send({...(snap||{}),req_id}); break; }
      case 'click': {
        await ensureCs(tid);
        const res = await run(tid, fn_click, [cmd.ref]);
        await new Promise(r=>setTimeout(r,500));
        const snap = await run(tid, fn_snapshot);
        send({type:'action_result',req_id,...(res||{}),post_snapshot:snap}); break; }
      case 'fill': {
        await ensureCs(tid);
        const res = await run(tid, fn_fill, [cmd.ref, cmd.text]);
        send({type:'action_result',req_id,...(res||{})}); break; }
      case 'scroll': {
        await ensureCs(tid);
        await run(tid, fn_scroll, [cmd.direction, cmd.amount]);
        await new Promise(r=>setTimeout(r,400));
        const snap = await run(tid, fn_snapshot);
        send({type:'action_result',req_id,ok:true,post_snapshot:snap}); break; }
      default: send({type:'error',req_id,error:`Unknown: ${action}`}); }
  } catch(err) { send({type:'action_result',req_id,ok:false,error:String(err)}); }
}

function waitLoad(tabId, ms) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, t => { if(t&&t.status==='complete'){resolve();return;} });
    const timer = setTimeout(resolve, ms);
    const fn = (id,info) => { if(id===tabId&&info.status==='complete'){
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn); setTimeout(resolve,800); }};
    chrome.tabs.onUpdated.addListener(fn); }); }

chrome.runtime.onMessage.addListener((msg,_,reply) => {
  if (msg.cmd==='popup_status') { reply({wsOpen:ws&&ws.readyState===1}); return false; }
  if (msg.cmd==='reconnect') { if(ws){try{ws.close();}catch{} ws=null;} wsDelay=RECONNECT_BASE_MS; wsConnecting=false; setTimeout(connect,500); reply({ok:true}); return false; }
  return false; });

connect();
console.log('[Penantia] v'+VERSION+' ready');
