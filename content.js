// content.js — Penantia Browser Agent Content Script v1.0.0
// Self-contained: DOM serializer + action executor + Shadow DOM cursor
// Injected into every tab. Re-injection safe.

(function () {
  'use strict';
  if (window.__penantiaAgent) return; // already injected
  window.__penantiaAgent = true;

  // ============================================================
  // ELEMENT REGISTRY — stable ref IDs survive React reconciliation
  // ============================================================
  const _elMap = new Map();    // ref (int) -> Element
  const _elToRef = new WeakMap(); // Element -> ref (int)
  let _refSeq = 0;

  function _reg(el) {
    if (_elToRef.has(el)) return _elToRef.get(el);
    const ref = ++_refSeq;
    _elMap.set(ref, el);
    _elToRef.set(el, ref);
    return ref;
  }

  function _get(ref) { return _elMap.get(Number(ref)) || null; }

  function _resetRegistry() { _elMap.clear(); _refSeq = 0; }

  // ============================================================
  // DOM SERIALIZER
  // ============================================================
  const _INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY','LABEL']);
  const _INTERACTIVE_ROLES = new Set([
    'button','link','checkbox','menuitem','tab','option','radio',
    'combobox','listbox','textbox','searchbox','switch','treeitem','menuitemcheckbox'
  ]);

  function _isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.bottom < -100 || r.right < -100) return false;
      if (r.top > window.innerHeight + 100) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      return true;
    } catch { return false; }
  }

  function _isInteractive(el) {
    if (_INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && _INTERACTIVE_ROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1') return true;
    return false;
  }

  function _text(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.innerText || '').replace(/\s+/g, ' ')
    ).slice(0, 100).trim();
  }

  function _bounds(el) {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  function _harvest(root, out) {
    if (!root) return;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode: () => NodeFilter.FILTER_ACCEPT
      });
      let node = walker.nextNode();
      while (node) {
        if (_isInteractive(node) && _isVisible(node)) out.push(node);
        if (node.shadowRoot && node.shadowRoot.mode === 'open') {
          _harvest(node.shadowRoot, out); // pierce shadow DOM
        }
        node = walker.nextNode();
      }
    } catch { /* cross-origin frame — ignore */ }
  }

  function buildSnapshot() {
    _resetRegistry();
    const els = [];
    _harvest(document.documentElement, els);

    const nodes = els.map(el => {
      const node = {
        ref: _reg(el),
        role: el.tagName.toLowerCase(),
        text: _text(el),
        bounds: _bounds(el),
      };
      if (el.type) node.type = el.type;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value).slice(0, 120);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
      if (el.getAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded');
      if (el.getAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked');
      return node;
    });

    return {
      type: 'snapshot',
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      nodes,
      count: nodes.length,
    };
  }

  // ============================================================
  // ACTION EXECUTOR
  // ============================================================
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  async function execClick(ref) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    await _cursor.moveTo(el);
    el.focus();
    // Dispatch full pointer event sequence
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
    el.click(); // native click for any missed handlers
    await _sleep(400);
    return { ok: true, tag: el.tagName.toLowerCase(), text: _text(el) };
  }

  async function execFill(ref, text) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    await _cursor.moveTo(el);
    el.focus();
    el.click();

    // React 18-compatible: use native value setter to bypass synthetic dedup
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, text);
    } else {
      el.value = text;
    }

    // Reset React's internal _valueTracker so onChange fires
    if (el._valueTracker) el._valueTracker.setValue('');

    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return { ok: true, filled: text };
  }

  async function execUpload(ref, filename, base64data, mimeType) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    if (el.type !== 'file') return { ok: false, error: `ref ${ref} is not type=file` };
    await _cursor.moveTo(el);

    // Reconstruct File from base64 payload
    const resp = await fetch(`data:${mimeType || 'application/octet-stream'};base64,${base64data}`);
    const blob = await resp.blob();
    const file = new File([blob], filename, { type: mimeType || blob.type, lastModified: Date.now() });

    // DataTransfer is the ONLY way to assign a FileList from JS
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;

    // Reset React _valueTracker
    if (el._valueTracker) el._valueTracker.setValue('');

    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return { ok: true, filename, size: file.size, mime: file.type };
  }

  async function execScroll(direction, amount, ref) {
    if (ref) {
      const el = _get(ref);
      if (el) { el.scrollBy({ top: direction === 'down' ? amount : -amount, behavior: 'smooth' }); return { ok: true }; }
    }
    window.scrollBy({ top: direction === 'down' ? (amount || 400) : -(amount || 400), behavior: 'smooth' });
    return { ok: true };
  }

  async function execHover(ref) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    await _cursor.moveTo(el);
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { ok: true, tag: el.tagName.toLowerCase() };
  }

  // ============================================================
  // CURSOR MANAGER — Hi-tech scanning reticle, isolated Shadow DOM
  // ============================================================
  const _cursor = (() => {
    let _reticle = null;
    let _burst = null;
    let _box = null;
    let _hudLabel = null;
    let _scanLine = null;
    let _initialized = false;

    function _init() {
      if (_initialized) return;
      _initialized = true;

      const host = document.createElement('div');
      host.id = '__penantia_cursor_root';
      Object.assign(host.style, {
        position: 'fixed', top: '0', left: '0',
        width: '0', height: '0',
        pointerEvents: 'none',
        zIndex: '2147483647',
        overflow: 'visible',
      });

      const shadow = host.attachShadow({ mode: 'closed' });

      const css = new CSSStyleSheet();
      css.replaceSync(`
        #reticle {
          position: fixed;
          width: 40px; height: 40px;
          left: -200px; top: -200px;
          transform: translate(-50%, -50%);
          pointer-events: none;
          opacity: 0;
          transition: left 0.28s cubic-bezier(0.22,1,0.36,1),
                      top  0.28s cubic-bezier(0.22,1,0.36,1),
                      opacity 0.18s ease;
        }
        #reticle.show { opacity: 1; }

        /* Outer rotating ring */
        #ring-outer {
          position: absolute; inset: 0;
          border-radius: 50%;
          border: 1.5px solid transparent;
          border-top-color: #00d4ff;
          border-right-color: #00d4ff;
          animation: spin-outer 1.2s linear infinite;
          box-shadow: 0 0 8px #00d4ff88;
        }
        /* Inner counter-rotating ring */
        #ring-inner {
          position: absolute; inset: 7px;
          border-radius: 50%;
          border: 1.5px solid transparent;
          border-bottom-color: #a855f7;
          border-left-color: #a855f7;
          animation: spin-inner 0.8s linear infinite;
        }
        /* Center dot */
        #dot-center {
          position: absolute;
          width: 6px; height: 6px;
          background: #00d4ff;
          border-radius: 50%;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          box-shadow: 0 0 10px #00d4ff, 0 0 20px #00d4ff88;
          animation: pulse-dot 1s ease-in-out infinite;
        }
        /* Crosshair lines */
        #cross-h, #cross-v {
          position: absolute;
          background: #00d4ff66;
        }
        #cross-h { height: 1px; width: 10px; top: 50%; left: 50%; transform: translate(5px, -50%); }
        #cross-v { width: 1px; height: 10px; left: 50%; top: 50%; transform: translate(-50%, 5px); }
        #cross-h2, #cross-v2 {
          position: absolute;
          background: #00d4ff66;
        }
        #cross-h2 { height: 1px; width: 10px; top: 50%; right: 50%; transform: translate(-5px, -50%); }
        #cross-v2 { width: 1px; height: 10px; left: 50%; bottom: 50%; transform: translate(-50%, -5px); }

        @keyframes spin-outer { to { transform: rotate(360deg); } }
        @keyframes spin-inner { to { transform: rotate(-360deg); } }
        @keyframes pulse-dot  {
          0%,100% { box-shadow: 0 0 6px #00d4ff, 0 0 12px #00d4ff88; }
          50%      { box-shadow: 0 0 14px #00d4ff, 0 0 28px #00d4ffaa; }
        }

        /* Click burst */
        #burst {
          position: absolute; inset: -8px;
          border-radius: 50%;
          border: 2px solid #00d4ff;
          opacity: 0;
          transform: scale(0.5);
        }
        #burst.fire {
          animation: burst-anim 0.4s ease-out forwards;
        }
        @keyframes burst-anim {
          0%   { opacity: 0.9; transform: scale(0.5); }
          100% { opacity: 0;   transform: scale(1.8); }
        }

        /* Target box — corner-bracket style */
        #target-box {
          position: fixed;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.15s ease, left 0.12s ease, top 0.12s ease,
                      width 0.12s ease, height 0.12s ease;
        }
        #target-box.show { opacity: 1; }

        /* Corner brackets via pseudo via child divs */
        .corner {
          position: absolute;
          width: 10px; height: 10px;
          border-color: #00d4ff;
          border-style: solid;
        }
        .corner.tl { top: -1px; left: -1px;  border-width: 2px 0 0 2px; }
        .corner.tr { top: -1px; right: -1px; border-width: 2px 2px 0 0; }
        .corner.bl { bottom: -1px; left: -1px;  border-width: 0 0 2px 2px; }
        .corner.br { bottom: -1px; right: -1px; border-width: 0 2px 2px 0; }

        /* Scan line */
        #scan-line {
          position: absolute; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, #00d4ff88, transparent);
          opacity: 0;
        }
        #target-box.show #scan-line {
          opacity: 1;
          animation: scan 1.2s ease-in-out infinite;
          top: 0;
        }
        @keyframes scan {
          0%   { top: 0%;   opacity: 0.8; }
          50%  { opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }

        /* HUD label */
        #hud-label {
          position: absolute;
          bottom: calc(100% + 6px); left: 0;
          font-family: 'Courier New', monospace;
          font-size: 10px; font-weight: 600;
          color: #00d4ff;
          text-shadow: 0 0 8px #00d4ff;
          white-space: nowrap;
          opacity: 0;
          letter-spacing: 0.08em;
          transition: opacity 0.2s;
          background: rgba(0,0,0,0.6);
          padding: 2px 5px; border-radius: 2px;
          border-left: 2px solid #00d4ff;
        }
        #target-box.show #hud-label { opacity: 1; }
`);
      shadow.adoptedStyleSheets = [css];

      // Build reticle
      _reticle = document.createElement('div');
      _reticle.id = 'reticle';
      _reticle.innerHTML = `
        <div id="ring-outer"></div>
        <div id="ring-inner"></div>
        <div id="cross-h"></div><div id="cross-h2"></div>
        <div id="cross-v"></div><div id="cross-v2"></div>
        <div id="dot-center"></div>
        <div id="burst"></div>
      `;
      _burst = _reticle.querySelector('#burst');

      // Build target box
      _box = document.createElement('div');
      _box.id = 'target-box';
      _box.innerHTML = `
        <div class="corner tl"></div>
        <div class="corner tr"></div>
        <div class="corner bl"></div>
        <div class="corner br"></div>
        <div id="scan-line"></div>
        <div id="hud-label"></div>
      `;
      _hudLabel = _box.querySelector('#hud-label');

      shadow.appendChild(_box);
      shadow.appendChild(_reticle);
      document.documentElement.appendChild(host);
    }

    const _sleep = ms => new Promise(r => setTimeout(r, ms));

    async function moveTo(el) {
      _init();
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;

      // Move reticle to element center
      _reticle.style.left = cx + 'px';
      _reticle.style.top  = cy + 'px';
      _reticle.classList.add('show');

      // Position target box
      _box.style.left   = (rect.left - 5) + 'px';
      _box.style.top    = (rect.top  - 5) + 'px';
      _box.style.width  = (rect.width  + 10) + 'px';
      _box.style.height = (rect.height + 10) + 'px';

      // HUD label: element role + truncated text
      const tag = el.tagName.toLowerCase();
      const txt = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').slice(0, 28).trim();
      _hudLabel.textContent = `[${tag}] ${txt || '...'}`.toUpperCase();
      _box.classList.add('show');

      await _sleep(300); // wait for cursor to travel

      // Click burst
      _burst.classList.remove('fire');
      void _burst.offsetWidth;
      _burst.classList.add('fire');
      await _sleep(100);
    }

    function hide() {
      if (_reticle) _reticle.classList.remove('show');
      if (_box) _box.classList.remove('show');
    }

    return { moveTo, hide };
  })();Agent Content Script v1.0.0
// Self-contained: DOM serializer + action executor + Shadow DOM cursor
// Injected into every tab. Re-injection safe.

(function () {
  'use strict';
  if (window.__penantiaAgent) return; // already injected
  window.__penantiaAgent = true;

  // ============================================================
  // ELEMENT REGISTRY — stable ref IDs survive React reconciliation
  // ============================================================
  const _elMap = new Map();    // ref (int) -> Element
  const _elToRef = new WeakMap(); // Element -> ref (int)
  let _refSeq = 0;

  function _reg(el) {
    if (_elToRef.has(el)) return _elToRef.get(el);
    const ref = ++_refSeq;
    _elMap.set(ref, el);
    _elToRef.set(el, ref);
    return ref;
  }

  function _get(ref) { return _elMap.get(Number(ref)) || null; }

  function _resetRegistry() { _elMap.clear(); _refSeq = 0; }

  // ============================================================
  // DOM SERIALIZER
  // ============================================================
  const _INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY','LABEL']);
  const _INTERACTIVE_ROLES = new Set([
    'button','link','checkbox','menuitem','tab','option','radio',
    'combobox','listbox','textbox','searchbox','switch','treeitem','menuitemcheckbox'
  ]);

  function _isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.bottom < -100 || r.right < -100) return false;
      if (r.top > window.innerHeight + 100) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      return true;
    } catch { return false; }
  }

  function _isInteractive(el) {
    if (_INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && _INTERACTIVE_ROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1') return true;
    return false;
  }

  function _text(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.innerText || '').replace(/\s+/g, ' ')
    ).slice(0, 100).trim();
  }

  function _bounds(el) {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  function _harvest(root, out) {
    if (!root) return;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode: () => NodeFilter.FILTER_ACCEPT
      });
      let node = walker.nextNode();
      while (node) {
        if (_isInteractive(node) && _isVisible(node)) out.push(node);
        if (node.shadowRoot && node.shadowRoot.mode === 'open') {
          _harvest(node.shadowRoot, out); // pierce shadow DOM
        }
        node = walker.nextNode();
      }
    } catch { /* cross-origin frame — ignore */ }
  }

  function buildSnapshot() {
    _resetRegistry();
    const els = [];
    _harvest(document.documentElement, els);

    const nodes = els.map(el => {
      const node = {
        ref: _reg(el),
        role: el.tagName.toLowerCase(),
        text: _text(el),
        bounds: _bounds(el),
      };
      if (el.type) node.type = el.type;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value).slice(0, 120);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
      if (el.getAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded');
      if (el.getAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked');
      return node;
    });

    return {
      type: 'snapshot',
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      nodes,
      count: nodes.length,
    };
  }

  // ============================================================
  // ACTION EXECUTOR
  // ============================================================
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  async function execClick(ref) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    await _cursor.moveTo(el);
    el.focus();
    // Dispatch full pointer event sequence
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
    el.click(); // native click for any missed handlers
    await _sleep(400);
    return { ok: true, tag: el.tagName.toLowerCase(), text: _text(el) };
  }

  async function execFill(ref, text) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    await _cursor.moveTo(el);
    el.focus();
    el.click();

    // React 18-compatible: use native value setter to bypass synthetic dedup
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, text);
    } else {
      el.value = text;
    }

    // Reset React's internal _valueTracker so onChange fires
    if (el._valueTracker) el._valueTracker.setValue('');

    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return { ok: true, filled: text };
  }

  async function execUpload(ref, filename, base64data, mimeType) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    if (el.type !== 'file') return { ok: false, error: `ref ${ref} is not type=file` };
    await _cursor.moveTo(el);

    // Reconstruct File from base64 payload
    const resp = await fetch(`data:${mimeType || 'application/octet-stream'};base64,${base64data}`);
    const blob = await resp.blob();
    const file = new File([blob], filename, { type: mimeType || blob.type, lastModified: Date.now() });

    // DataTransfer is the ONLY way to assign a FileList from JS
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;

    // Reset React _valueTracker
    if (el._valueTracker) el._valueTracker.setValue('');

    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return { ok: true, filename, size: file.size, mime: file.type };
  }

  async function execScroll(direction, amount, ref) {
    if (ref) {
      const el = _get(ref);
      if (el) { el.scrollBy({ top: direction === 'down' ? amount : -amount, behavior: 'smooth' }); return { ok: true }; }
    }
    window.scrollBy({ top: direction === 'down' ? (amount || 400) : -(amount || 400), behavior: 'smooth' });
    return { ok: true };
  }

  async function execHover(ref) {
    const el = _get(ref);
    if (!el) return { ok: false, error: `ref ${ref} not in registry` };
    await _cursor.moveTo(el);
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { ok: true, tag: el.tagName.toLowerCase() };
  }

  // ============================================================
  // CURSOR MANAGER — isolated Shadow DOM so React can't touch it
  // ============================================================
  const _cursor = (() => {
    let _dot = null;
    let _box = null;
    let _initialized = false;

    function _init() {
      if (_initialized) return;
      _initialized = true;

      const host = document.createElement('div');
      host.id = '__penantia_cursor_root';
      Object.assign(host.style, {
        position: 'fixed', top: '0', left: '0',
        width: '0', height: '0',
        pointerEvents: 'none',
        zIndex: '2147483647',
        overflow: 'visible',
      });

      // Closed shadow prevents page JS from accessing our elements
      const shadow = host.attachShadow({ mode: 'closed' });

      const css = new CSSStyleSheet();
      // CSSStyleSheet.replaceSync bypasses page CSP style-src restrictions
      css.replaceSync(`
        #dot {
          position: fixed;
          width: 22px; height: 22px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 35%, #818cf8 0%, #4f46e5 70%);
          border: 2.5px solid rgba(255,255,255,0.9);
          box-shadow: 0 0 0 3px rgba(99,102,241,0.35), 0 4px 14px rgba(0,0,0,0.35);
          pointer-events: none;
          left: -200px; top: -200px;
          transform: translate(-50%,-50%) scale(0);
          transition:
            left 0.32s cubic-bezier(0.22,1,0.36,1),
            top  0.32s cubic-bezier(0.22,1,0.36,1),
            transform 0.18s ease,
            opacity 0.18s ease;
          opacity: 0;
        }
        #dot.show  { transform: translate(-50%,-50%) scale(1); opacity: 1; }
        #dot.press { transform: translate(-50%,-50%) scale(0.62); opacity: 0.9; }

        #box {
          position: fixed;
          border: 2px solid #6366f1;
          background: rgba(99,102,241,0.08);
          border-radius: 5px;
          pointer-events: none;
          opacity: 0;
          left: 0; top: 0; width: 0; height: 0;
          transition: opacity 0.15s ease, left 0.15s ease, top 0.15s ease,
                      width 0.12s ease, height 0.12s ease;
          box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
        }
        #box.show { opacity: 1; }

        @keyframes ripple {
          0%   { box-shadow: 0 0 0 0   rgba(99,102,241,0.5); }
          60%  { box-shadow: 0 0 0 10px rgba(99,102,241,0);  }
          100% { box-shadow: 0 0 0 0   rgba(99,102,241,0);   }
        }
        #box.ripple { animation: ripple 0.38s ease-out; }
      `);
      shadow.adoptedStyleSheets = [css];

      _dot = document.createElement('div'); _dot.id = 'dot';
      _box = document.createElement('div'); _box.id = 'box';
      shadow.appendChild(_box);
      shadow.appendChild(_dot);
      document.documentElement.appendChild(host);
    }

    async function moveTo(el) {
      _init();
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top  + r.height / 2;

      // Move cursor
      _dot.style.left = cx + 'px';
      _dot.style.top  = cy + 'px';
      _dot.classList.add('show');
      _dot.classList.remove('press');

      // Highlight element bounding box
      _box.style.left   = (r.left - 4) + 'px';
      _box.style.top    = (r.top  - 4) + 'px';
      _box.style.width  = (r.width  + 8) + 'px';
      _box.style.height = (r.height + 8) + 'px';
      _box.classList.add('show');
      _box.classList.remove('ripple');
      void _box.offsetWidth; // trigger reflow for animation restart
      _box.classList.add('ripple');

      await new Promise(res => setTimeout(res, 340)); // wait for cursor travel

      // Click flash
      _dot.classList.add('press');
      await new Promise(res => setTimeout(res, 120));
      _dot.classList.remove('press');
    }

    return { moveTo };
  })();

  // ============================================================
  // MESSAGE LISTENER
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    (async () => {
      try {
        reply(await _dispatch(msg));
      } catch (err) {
        reply({ type: 'action_result', ok: false, error: String(err) });
      }
    })();
    return true; // keep channel open for async reply
  });

  async function _dispatch(msg) {
    switch (msg.cmd) {
      case 'snapshot':
        return buildSnapshot();

      case 'click': {
        const r = await execClick(msg.ref);
        await _sleep(500);
        return { type: 'action_result', ...r, post_snapshot: buildSnapshot() };
      }

      case 'fill': {
        const r = await execFill(msg.ref, msg.text);
        return { type: 'action_result', ...r };
      }

      case 'upload': {
        const r = await execUpload(msg.ref, msg.filename, msg.data, msg.mimeType);
        await _sleep(400);
        return { type: 'action_result', ...r, post_snapshot: buildSnapshot() };
      }

      case 'scroll': {
        const r = await execScroll(msg.direction, msg.amount, msg.ref);
        await _sleep(300);
        return { type: 'action_result', ...r, post_snapshot: buildSnapshot() };
      }

      case 'hover': {
        const r = await execHover(msg.ref);
        return { type: 'action_result', ...r };
      }

      case 'get_state':
        return { type: 'state', url: location.href, title: document.title, readyState: document.readyState };

      default:
        return { type: 'error', error: `unknown cmd: ${msg.cmd}` };
    }
  }

  // Re-snapshot on major DOM mutations (debounced)
  let _mutationTimer = null;
  const _observer = new MutationObserver(() => {
    clearTimeout(_mutationTimer);
    _mutationTimer = setTimeout(() => {
      // Registry is stale after major mutations — clear it so next snapshot is fresh
      _resetRegistry();
    }, 800);
  });
  _observer.observe(document.documentElement, { childList: true, subtree: true });

  console.log('[Penantia] content script v1.0.0 ready:', location.href);
})();
