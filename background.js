// background.js — Penantia Browser Agent v1.2.0
// Cursor: idle (always visible) → active (1s before action) → click → idle
// executeScript: isolated world, no world:MAIN

const VERSION = "1.2.0";
const DEFAULT_WS_URL = "wss://penantia-ai-backend-x64glrg3eq-as.a.run.app/extension-ws";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null, wsDelay = RECONNECT_BASE_MS, wsConnecting = false;

// ── KEEPALIVE ────────────────────────────────────────────────────────────────
chrome.alarms.create("pmt-hb", { periodInMinutes: 1.0 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== "pmt-hb") return;
  chrome.storage.session.set({ hb: Date.now() });
  if (!ws || ws.readyState > 1) scheduleReconnect(true);
});
chrome.runtime.onConnect.addListener(p => { if (p.name === "pmt-ka") p.onDisconnect.addListener(() => {}); });

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
async function getUrl() { return new Promise(r => chrome.storage.sync.get(["wsUrl"], d => r(d.wsUrl || DEFAULT_WS_URL))); }

async function connect() {
  if (wsConnecting || (ws && ws.readyState <= 1)) return;
  wsConnecting = true;
  const url = await getUrl();
  const { ctx } = await chrome.storage.session.get(["ctx"]).catch(() => ({}));
  try {
    ws = new WebSocket(url);
    ws.onopen = () => {
      wsDelay = RECONNECT_BASE_MS; wsConnecting = false;
      ws.send(JSON.stringify(ctx ? { type: "SESSION_RESUME", version: VERSION, contextId: ctx }
                                 : { type: "connected", version: VERSION }));
    };
    ws.onmessage = async e => { let c; try { c = JSON.parse(e.data); } catch { return; } await handle(c); };
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
const send = p => ws?.readyState === 1 && ws.send(JSON.stringify(p));

// ── PAGE FUNCTIONS ────────────────────────────────────────────────────────────
// All inline self-contained cursor CSS + animation. Runs in ISOLATED world.

// Initialize and show cursor — called by snapshot and navigate
// Cursor starts in IDLE state (visible, calm, at screen center or last position)
function fn_init_cursor(cx, cy) {
  if (window.__pmtCursor) {
    // Just update position if already exists
    const c = window.__pmtCursor;
    if (cx !== undefined) { c.dot.style.left = cx + 'px'; c.dot.style.top = cy + 'px'; }
    return true;
  }

  const host = document.createElement('div');
  host.id = '__pmt_cursor_host';
  Object.assign(host.style, { position:'fixed', top:'0', left:'0', width:'0', height:'0',
    pointerEvents:'none', zIndex:'2147483647', overflow:'visible' });
  const shadow = host.attachShadow({ mode:'closed' });

  const css = new CSSStyleSheet();
  css.replaceSync(`
    #dot {
      position:fixed; width:22px; height:22px; border-radius:50%;
      background:radial-gradient(circle at 35% 35%, #818cf8 0%, #4f46e5 70%);
      border:2.5px solid rgba(255,255,255,0.85);
      pointer-events:none; left:-200px; top:-200px;
      transform:translate(-50%,-50%);
      box-shadow:0 0 0 3px rgba(99,102,241,0.25), 0 4px 14px rgba(0,0,0,0.3);
      transition: left 0.32s cubic-bezier(0.22,1,0.36,1), top 0.32s cubic-bezier(0.22,1,0.36,1),
                  opacity 0.25s ease;
      opacity: 0;
    }
    #dot.show  { opacity: 0.55; animation: pulse-idle 2.5s ease-in-out infinite; }
    #dot.active { opacity: 1;  animation: pulse-act  0.9s ease-in-out infinite; }
    #dot.press  { transform:translate(-50%,-50%) scale(0.6); opacity:1; }

    #ro { position:absolute; inset:0; border-radius:50%; border:2px solid transparent;
          border-top-color:#00d4ff; border-right-color:#00d4ff;
          box-shadow: 0 0 8px #00d4ff44; opacity:0;
          transition: opacity 0.3s ease; }
    #ri { position:absolute; inset:7px; border-radius:50%; border:1.5px solid transparent;
          border-bottom-color:#a855f7; border-left-color:#a855f7; opacity:0;
          transition: opacity 0.3s ease; }
    #dot.active ~ #dummy { }
    .rings-on #ro { opacity:1; animation:ro 1s linear infinite; }
    .rings-on #ri { opacity:1; animation:ri 0.75s linear infinite; }

    #cross { position:absolute; inset:0; opacity:0; transition: opacity 0.3s; }
    .rings-on #cross { opacity:1; }
    #ch  { position:absolute; height:1px; width:9px; background:#00d4ff88; top:50%; left:50%; transform:translate(5px,-50%); }
    #ch2 { position:absolute; height:1px; width:9px; background:#00d4ff88; top:50%; right:50%; transform:translate(-5px,-50%); }
    #cv  { position:absolute; width:1px; height:9px; background:#00d4ff88; left:50%; top:50%; transform:translate(-50%,5px); }
    #cv2 { position:absolute; width:1px; height:9px; background:#00d4ff88; left:50%; bottom:50%; transform:translate(-50%,-5px); }

    #burst { position:absolute; inset:-8px; border-radius:50%; border:2px solid #00d4ff; opacity:0; transform:scale(0.5); }
    #burst.fire { animation:burst 0.45s ease-out forwards; }

    #box { position:fixed; pointer-events:none; opacity:0;
           transition:opacity 0.15s ease, left 0.15s ease, top 0.15s ease, width 0.12s ease, height 0.12s ease; }
    #box.show { opacity:1; }
    .c { position:absolute; width:10px; height:10px; border-color:#00d4ff; border-style:solid; }
    .c.tl { top:-2px; left:-2px;  border-width:2px 0 0 2px; }
    .c.tr { top:-2px; right:-2px; border-width:2px 2px 0 0; }
    .c.bl { bottom:-2px; left:-2px;  border-width:0 0 2px 2px; }
    .c.br { bottom:-2px; right:-2px; border-width:0 2px 2px 0; }
    #scan { position:absolute; left:0; right:0; height:1px;
            background:linear-gradient(90deg,transparent,#00d4ff99,transparent);
            top:0; opacity:0; }
    #box.show #scan { opacity:1; animation:scan 1.1s ease-in-out infinite; }
    #lbl { position:absolute; bottom:calc(100% + 7px); left:0;
           font-family:Courier New,monospace; font-size:10px; font-weight:700;
           color:#00d4ff; text-shadow:0 0 10px #00d4ff;
           background:rgba(0,0,0,0.8); padding:3px 8px; border-radius:2px;
           border-left:2px solid #00d4ff; white-space:nowrap; letter-spacing:.1em;
           opacity:0; transition:opacity 0.2s; }
    #box.show #lbl { opacity:1; }

    @keyframes pulse-idle { 0%,100%{box-shadow:0 0 0 3px rgba(99,102,241,0.2), 0 4px 14px rgba(0,0,0,0.3);}
                             50%{box-shadow:0 0 0 6px rgba(99,102,241,0.1), 0 4px 20px rgba(99,102,241,0.25);} }
    @keyframes pulse-act  { 0%,100%{box-shadow:0 0 10px #00d4ff, 0 0 20px #00d4ff66;}
                             50%{box-shadow:0 0 20px #00d4ff, 0 0 40px #00d4ffaa;} }
    @keyframes ro   { to{transform:rotate(360deg);} }
    @keyframes ri   { to{transform:rotate(-360deg);} }
    @keyframes burst{ 0%{opacity:.9;transform:scale(.5);} 100%{opacity:0;transform:scale(2.2);} }
    @keyframes scan { 0%{top:0;opacity:.8;} 50%{opacity:1;} 100%{top:100%;opacity:0;} }
  `);
  shadow.adoptedStyleSheets = [css];

  const wrap = document.createElement('div'); // wrapper with rings inside dot
  const dot = document.createElement('div'); dot.id = 'dot';
  const ro  = document.createElement('div'); ro.id  = 'ro';
  const ri  = document.createElement('div'); ri.id  = 'ri';
  const cross = document.createElement('div'); cross.id = 'cross';
  cross.innerHTML = '<div id="ch"></div><div id="ch2"></div><div id="cv"></div><div id="cv2"></div>';
  const burst = document.createElement('div'); burst.id = 'burst';
  dot.appendChild(ro); dot.appendChild(ri); dot.appendChild(cross); dot.appendChild(burst);

  const box  = document.createElement('div'); box.id  = 'box';
  box.innerHTML = '<div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div><div id="scan"></div><div id="lbl"></div>';

  shadow.appendChild(box);
  shadow.appendChild(dot);
  document.documentElement.appendChild(host);

  const startX = cx ?? window.innerWidth / 2;
  const startY = cy ?? window.innerHeight / 2;
  dot.style.left = startX + 'px';
  dot.style.top  = startY + 'px';
  dot.classList.add('show');

  window.__pmtCursor = { dot, box, burst, lbl: box.querySelector('#lbl') };
  return true;
}

// Move cursor to element, activate full scanning, click, then return to idle
async function fn_cursor_click(ref) {
  const el = (window.__pmt || {})[ref];
  if (!el) return { ok: false, error: `ref ${ref} not in registry` };

  // Ensure cursor exists
  if (!window.__pmtCursor) fn_init_cursor();
  const { dot, box, burst, lbl } = window.__pmtCursor;

  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

  // Smooth travel to element
  dot.style.left = cx + 'px'; dot.style.top = cy + 'px';
  dot.classList.remove('show'); dot.classList.add('active');
  dot.classList.add('rings-on');

  // Position bounding box
  box.style.left   = (r.left - 5) + 'px'; box.style.top    = (r.top - 5) + 'px';
  box.style.width  = (r.width + 10) + 'px'; box.style.height = (r.height + 10) + 'px';
  const tag = el.tagName.toLowerCase();
  const txt = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').slice(0, 32).trim();
  lbl.textContent = '[' + tag.toUpperCase() + '] ' + txt.toUpperCase();
  box.classList.add('show');

  // 900ms pre-action scanning animation
  await new Promise(res => setTimeout(res, 900));

  // Click with press animation
  dot.classList.add('press');
  burst.classList.remove('fire'); void burst.offsetWidth; burst.classList.add('fire');

  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window })));
  el.click();

  await new Promise(res => setTimeout(res, 180));
  dot.classList.remove('press');

  // Stay active 1.5s after click, then return to idle
  await new Promise(res => setTimeout(res, 1500));
  dot.classList.remove('active', 'rings-on');
  dot.classList.add('show'); // idle — stays visible at last position
  box.classList.remove('show');

  return { ok: true, tag, text: txt };
}

// Move cursor to element with active animation, fill text, return to idle
async function fn_cursor_fill(ref, text) {
  const el = (window.__pmt || {})[ref];
  if (!el) return { ok: false, error: `ref ${ref} not in registry` };

  if (!window.__pmtCursor) fn_init_cursor();
  const { dot, box, lbl } = window.__pmtCursor;

  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

  dot.style.left = cx + 'px'; dot.style.top = cy + 'px';
  dot.classList.remove('show'); dot.classList.add('active', 'rings-on');
  box.style.left = (r.left-5)+'px'; box.style.top = (r.top-5)+'px';
  box.style.width = (r.width+10)+'px'; box.style.height = (r.height+10)+'px';
  lbl.textContent = '[TYPING] ' + text.slice(0,28).toUpperCase();
  box.classList.add('show');

  await new Promise(res => setTimeout(res, 600));

  el.focus(); el.click();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, text); else el.value = text;
  if (el._valueTracker) el._valueTracker.setValue('');
  el.dispatchEvent(new Event('input', { bubbles:true }));

  await new Promise(res => setTimeout(res, 1200));
  dot.classList.remove('active','rings-on'); dot.classList.add('show');
  box.classList.remove('show');

  return { ok: true, filled: text };
}

// DOM snapshot — also initializes cursor so it appears on page immediately
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
    if (role && IROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && ti !== '-1'; }

  function getText(el) {
    return (el.getAttribute('aria-label')||el.getAttribute('alt')||
            el.getAttribute('placeholder')||el.getAttribute('title')||
            (el.innerText||'')).slice(0,100).trim(); }

  function harvest(root, out) {
    if (!root) return;
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT,
        { acceptNode: () => NodeFilter.FILTER_ACCEPT });
      let n = w.nextNode();
      while (n) {
        if (isInt(n) && isVis(n)) out.push(n);
        if (n.shadowRoot?.mode==='open') harvest(n.shadowRoot, out);
        n = w.nextNode();
      }
    } catch {} }

  const els = []; harvest(document.documentElement, els);
  const nodes = els.map(el => {
    const ref = ++window.__pmtSeq; window.__pmt[ref] = el;
    const r2 = el.getBoundingClientRect();
    const node = { ref, role:el.tagName.toLowerCase(), text:getText(el),
      bounds:[Math.round(r2.left),Math.round(r2.top),Math.round(r2.width),Math.round(r2.height)] };
    if (el.type) node.type = el.type;
    if (el.value) node.value = String(el.value).slice(0,100);
    if (el.disabled) node.disabled = true;
    return node; });

  // Initialize cursor at screen center (idle state) so it's always visible
  if (typeof fn_init_cursor !== 'undefined') {
    try { fn_init_cursor(window.innerWidth / 2, window.innerHeight / 2); } catch {}
  } else {
    // fn_init_cursor is defined in same world — call it inline
    // (it's defined above in the same executeScript context when called via fn_snapshot_with_cursor)
  }

  return { type:'snapshot', url:location.href, title:document.title,
    viewport:{w:window.innerWidth,h:window.innerHeight},
    nodes, count:nodes.length }; }

function fn_scroll(dir, amt) {
  window.scrollBy({ top: dir==='down'?(amt||400):-(amt||400), behavior:'smooth' });
  return { ok:true }; }

// ── RUN-IN-PAGE ───────────────────────────────────────────────────────────────
async function run(tabId, fn, args=[]) {
  const res = await chrome.scripting.executeScript({
    target:{tabId}, func:fn, args
  });
  return res?.[0]?.result;
}

async function ensureCs(tabId) {
  await chrome.scripting.executeScript({target:{tabId},files:['content.js']}).catch(()=>{});
  await new Promise(r=>setTimeout(r,300));
}

// ── COMMAND HANDLER ───────────────────────────────────────────────────────────
async function handle(cmd) {
  const { cmd:action, req_id } = cmd;
  if (cmd.contextId) chrome.storage.session.set({ ctx: cmd.contextId });
  if (action==='set_config') { if(cmd.wsUrl) chrome.storage.sync.set({wsUrl:cmd.wsUrl}); send({type:'config_ack',req_id}); return; }
  if (action==='ping') {
    const [t] = await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[null]);
    send({type:'pong',req_id,version:VERSION,tabUrl:t?.url||null}); return; }

  const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[null]);
  if (!tab) { send({type:'error',req_id,error:'No active tab'}); return; }
  const tid = tab.id;

  try {
    switch(action) {
      case 'navigate': {
        await chrome.tabs.update(tid,{url:cmd.url});
        await waitLoad(tid,20000);
        await ensureCs(tid);
        await new Promise(r=>setTimeout(r,500));
        // Initialize cursor immediately after navigation
        await run(tid, fn_init_cursor, [Math.round(1280/2), Math.round(900/2)]);
        const snap = await run(tid, fn_snapshot);
        send({type:'action_result',req_id,ok:true,url:cmd.url,post_snapshot:snap});
        break; }

      case 'snapshot': {
        await ensureCs(tid);
        const snap = await run(tid, fn_snapshot);
        // Init cursor if not there
        if (snap?.count > 0) await run(tid, fn_init_cursor, [Math.round(1280/2), Math.round(900/2)]);
        send({...(snap||{}),req_id});
        break; }

      case 'click': {
        // fn_cursor_click is atomic: moves cursor, scans, clicks, returns to idle
        // Must define fn_init_cursor in same call since fns are serialized independently
        const res = await chrome.scripting.executeScript({
          target:{tabId:tid},
          func: async function(ref) {
            // inline fn_init_cursor
            if (!window.__pmtCursor) {
              const h = document.createElement('div');
              h.id='__pmt_c'; Object.assign(h.style,{position:'fixed',top:'0',left:'0',width:'0',height:'0',pointerEvents:'none',zIndex:'2147483647',overflow:'visible'});
              const s = h.attachShadow({mode:'closed'});
              const css = new CSSStyleSheet();
              css.replaceSync(`
                #dot{position:fixed;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#818cf8 0%,#4f46e5 70%);border:2.5px solid rgba(255,255,255,0.85);pointer-events:none;left:-200px;top:-200px;transform:translate(-50%,-50%);box-shadow:0 0 0 3px rgba(99,102,241,0.25),0 4px 14px rgba(0,0,0,0.3);transition:left 0.32s cubic-bezier(0.22,1,0.36,1),top 0.32s cubic-bezier(0.22,1,0.36,1),opacity 0.25s ease;opacity:0;}
                #dot.show{opacity:.55;animation:pi 2.5s ease-in-out infinite;}
                #dot.act{opacity:1;animation:pa .9s ease-in-out infinite;}
                #dot.press{transform:translate(-50%,-50%) scale(0.62);}
                #ro{position:absolute;inset:0;border-radius:50%;border:2px solid transparent;border-top-color:#00d4ff;border-right-color:#00d4ff;box-shadow:0 0 8px #00d4ff44;opacity:0;transition:opacity .3s;}
                #ri{position:absolute;inset:7px;border-radius:50%;border:1.5px solid transparent;border-bottom-color:#a855f7;border-left-color:#a855f7;opacity:0;transition:opacity .3s;}
                #dot.act #ro{opacity:1;animation:ro 1s linear infinite;}
                #dot.act #ri{opacity:1;animation:ri .75s linear infinite;}
                #ch,#ch2{position:absolute;height:1px;width:9px;background:#00d4ff66;top:50%;}
                #ch{left:50%;transform:translate(5px,-50%);}#ch2{right:50%;transform:translate(-5px,-50%);}
                #cv,#cv2{position:absolute;width:1px;height:9px;background:#00d4ff66;left:50%;}
                #cv{top:50%;transform:translate(-50%,5px);}#cv2{bottom:50%;transform:translate(-50%,-5px);}
                #burst{position:absolute;inset:-8px;border-radius:50%;border:2px solid #00d4ff;opacity:0;transform:scale(.5);}
                #burst.fire{animation:br .45s ease-out forwards;}
                #box{position:fixed;pointer-events:none;opacity:0;transition:opacity .15s ease,left .15s,top .15s,width .12s,height .12s;}
                #box.on{opacity:1;}
                .c{position:absolute;width:10px;height:10px;border-color:#00d4ff;border-style:solid;}
                .c.tl{top:-2px;left:-2px;border-width:2px 0 0 2px;}
                .c.tr{top:-2px;right:-2px;border-width:2px 2px 0 0;}
                .c.bl{bottom:-2px;left:-2px;border-width:0 0 2px 2px;}
                .c.br{bottom:-2px;right:-2px;border-width:0 2px 2px 0;}
                #scan{position:absolute;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#00d4ff99,transparent);top:0;opacity:0;}
                #box.on #scan{opacity:1;animation:sc 1.1s ease-in-out infinite;}
                #lbl{position:absolute;bottom:calc(100% + 7px);left:0;font-family:Courier New,monospace;font-size:10px;font-weight:700;color:#00d4ff;text-shadow:0 0 10px #00d4ff;background:rgba(0,0,0,.8);padding:3px 8px;border-radius:2px;border-left:2px solid #00d4ff;white-space:nowrap;letter-spacing:.1em;opacity:0;transition:opacity .2s;}
                #box.on #lbl{opacity:1;}
                @keyframes pi{0%,100%{box-shadow:0 0 0 3px rgba(99,102,241,.2),0 4px 14px rgba(0,0,0,.3);}50%{box-shadow:0 0 0 6px rgba(99,102,241,.1),0 4px 20px rgba(99,102,241,.25);}}
                @keyframes pa{0%,100%{box-shadow:0 0 10px #00d4ff,0 0 20px #00d4ff66;}50%{box-shadow:0 0 20px #00d4ff,0 0 40px #00d4ffaa;}}
                @keyframes ro{to{transform:rotate(360deg);}}
                @keyframes ri{to{transform:rotate(-360deg);}}
                @keyframes br{0%{opacity:.9;transform:scale(.5);}100%{opacity:0;transform:scale(2.2);}}
                @keyframes sc{0%{top:0;opacity:.8;}50%{opacity:1;}100%{top:100%;opacity:0;}}
              `);
              s.adoptedStyleSheets=[css];
              const dot=document.createElement('div');dot.id='dot';
              dot.innerHTML='<div id="ro"></div><div id="ri"></div><div id="ch"></div><div id="ch2"></div><div id="cv"></div><div id="cv2"></div><div id="burst"></div>';
              const box=document.createElement('div');box.id='box';
              box.innerHTML='<div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div><div id="scan"></div><div id="lbl"></div>';
              s.appendChild(box);s.appendChild(dot);
              document.documentElement.appendChild(h);
              window.__pmtCursor={dot,box,burst:dot.querySelector('#burst'),lbl:box.querySelector('#lbl')};
            }
            const el=(window.__pmt||{})[ref];
            if(!el) return {ok:false,error:`ref ${ref} not found`};
            const {dot,box,burst,lbl}=window.__pmtCursor;
            const r=el.getBoundingClientRect();
            const cx=r.left+r.width/2,cy=r.top+r.height/2;
            // Travel to element
            dot.style.left=cx+'px';dot.style.top=cy+'px';
            dot.className='act';
            box.style.left=(r.left-5)+'px';box.style.top=(r.top-5)+'px';
            box.style.width=(r.width+10)+'px';box.style.height=(r.height+10)+'px';
            const tag=el.tagName.toLowerCase();
            const txt=(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.innerText||'').slice(0,32).trim();
            lbl.textContent='['+tag.toUpperCase()+'] '+txt.toUpperCase();
            box.className='on';
            // 900ms pre-action scanning
            await new Promise(r=>setTimeout(r,900));
            // Click burst
            dot.classList.add('press');
            burst.className='';void burst.offsetWidth;burst.className='fire';
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t=>
              el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})));
            el.click();
            await new Promise(r=>setTimeout(r,180));dot.classList.remove('press');
            // 1.5s post-click active, then idle
            await new Promise(r=>setTimeout(r,1500));
            dot.className='show';box.className='';
            // Fresh snapshot
            const snap=await (async()=>{
              window.__pmt={};window.__pmtSeq=0;
              const ITAGS=new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY']);
              const IROLES=new Set(['button','link','checkbox','menuitem','tab','option','combobox','textbox','searchbox']);
              function isVis(e){try{const r2=e.getBoundingClientRect();if(!r2.width||!r2.height||r2.top>window.innerHeight+50)return false;const s=window.getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden';}catch{return false;}}
              function isInt(e){if(ITAGS.has(e.tagName))return true;const ro=e.getAttribute('role');if(ro&&IROLES.has(ro))return true;const ti=e.getAttribute('tabindex');return ti!==null&&ti!=='-1';}
              const els=[];
              const w2=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_ELEMENT,{acceptNode:()=>NodeFilter.FILTER_ACCEPT});
              let n2=w2.nextNode();while(n2){if(isInt(n2)&&isVis(n2))els.push(n2);if(n2.shadowRoot?.mode==='open'){const w3=document.createTreeWalker(n2.shadowRoot,NodeFilter.SHOW_ELEMENT,{acceptNode:()=>NodeFilter.FILTER_ACCEPT});let n3=w3.nextNode();while(n3){if(isInt(n3)&&isVis(n3))els.push(n3);n3=w3.nextNode();}}n2=w2.nextNode();}
              const nodes=els.map(e=>{const ref2=++window.__pmtSeq;window.__pmt[ref2]=e;const r3=e.getBoundingClientRect();return{ref:ref2,role:e.tagName.toLowerCase(),text:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||(e.innerText||'')).slice(0,80).trim(),bounds:[Math.round(r3.left),Math.round(r3.top),Math.round(r3.width),Math.round(r3.height)],type:e.type||undefined};});
              return{type:'snapshot',url:location.href,title:document.title,nodes,count:nodes.length};
            })();
            return {type:'action_result',ok:true,tag,text:txt,post_snapshot:snap};
          },
          args: [cmd.ref]
        });
        send({ ...(res?.[0]?.result||{}), req_id });
        break; }

      case 'fill': {
        await ensureCs(tid);
        const res = await run(tid, fn_cursor_fill, [cmd.ref, cmd.text]);
        send({type:'action_result',req_id,...(res||{})});
        break; }

      case 'scroll': {
        await ensureCs(tid);
        const res = await run(tid, fn_scroll, [cmd.direction, cmd.amount]);
        await new Promise(r=>setTimeout(r,400));
        const snap = await run(tid, fn_snapshot);
        send({type:'action_result',req_id,...(res||{}),post_snapshot:snap});
        break; }

      default: send({type:'error',req_id,error:`Unknown: ${action}`});
    }
  } catch(err) { send({type:'action_result',req_id,ok:false,error:String(err)}); }
}

function waitLoad(tabId, ms) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, t => { if (t?.status==='complete') { resolve(); return; } });
    const timer = setTimeout(resolve, ms);
    const fn = (id, info) => {
      if (id===tabId && info.status==='complete') {
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn);
        setTimeout(resolve, 800); } };
    chrome.tabs.onUpdated.addListener(fn); }); }

chrome.runtime.onMessage.addListener((msg,_,reply) => {
  if (msg.cmd==='popup_status') { reply({wsOpen:ws?.readyState===1}); return false; }
  if (msg.cmd==='reconnect') { if(ws){try{ws.close();}catch{} ws=null;} wsDelay=RECONNECT_BASE_MS; wsConnecting=false; setTimeout(connect,500); reply({ok:true}); return false; }
  return false; });

connect();
console.log('[Penantia] background v'+VERSION);
