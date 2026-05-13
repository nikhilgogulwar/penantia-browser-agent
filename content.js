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
