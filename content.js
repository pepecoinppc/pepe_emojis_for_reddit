/*
 * Pepe Emojis for Reddit — content script
 *
 * 1. Finds the "Show formatting options" (Aa) button in Reddit comment boxes
 *    (including inside Reddit's shadow-DOM web components) and adds a Pepe
 *    button right after it.
 * 2. Clicking the Pepe button opens a GIF-keyboard-style picker with two
 *    folders: Static and GIFs (emojis/static, emojis/gif).
 * 3. Picking one attaches the image to the comment by handing the file to
 *    Reddit's own image-upload path (paste → drop → file input), the same way
 *    pasting an image from your clipboard works.
 */
(() => {
  'use strict';
  if (window.__pepeEmojiLoaded) return;
  window.__pepeEmojiLoaded = true;

  const BTN_CLASS = 'pepe-emoji-btn';
  const ITEM_CLASS = 'pepe-emoji-item';
  const ITEM_TAG = 'RTE-TOOLBAR-BUTTON';
  const RECENT_KEY = 'pepeRecent';
  const MAX_RECENT = 18;
  const CHANGE_WAIT_MS = 1200;

  const url = (p) => chrome.runtime.getURL(p);
  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  };

  /* ------------------------------------------------------------------ */
  /* Deep DOM helpers (walk through open AND closed shadow roots)       */
  /* ------------------------------------------------------------------ */

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.tagName.includes('-')) {
      try {
        if (chrome.dom && chrome.dom.openOrClosedShadowRoot) {
          return chrome.dom.openOrClosedShadowRoot(el) || null;
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  // Yields every element under `root`, descending into shadow roots.
  function* deepElements(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 1) {
        yield node;
        const sr = shadowOf(node);
        if (sr) stack.push(sr);
      }
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        yield el;
        const sr = shadowOf(el);
        if (sr) stack.push(sr);
      }
    }
  }

  // Parent that crosses shadow boundaries (shadow root → host).
  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const p = node.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  }

  const isVisible = (el) => el.getClientRects().length > 0;

  /* ------------------------------------------------------------------ */
  /* Finding the comment box + formatting button                        */
  /* ------------------------------------------------------------------ */

  function labelText(el) {
    const parts = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tooltip'),
      el.getAttribute('tooltip'),
      el.textContent && el.textContent.length < 120 ? el.textContent : '',
    ];
    // Tooltip wrapper, e.g. <faceplate-tooltip><button/><span slot="content">Show formatting options</span>
    const tip = el.closest('faceplate-tooltip, [data-tooltip], [tooltip]');
    if (tip && tip !== el) {
      parts.push(tip.getAttribute('data-tooltip'), tip.getAttribute('tooltip'), tip.getAttribute('label'));
      if (tip.textContent && tip.textContent.length < 120) parts.push(tip.textContent);
    }
    return parts.filter(Boolean).join(' ');
  }

  function isFormattingButton(el) {
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    if (el.classList.contains(BTN_CLASS)) return false;
    const text = labelText(el);
    if (/formatting/i.test(text)) return true;
    if (el.textContent.trim() === 'Aa') return true;
    return !!el.querySelector('[icon-name*="format" i], [name*="text-format" i]');
  }

  // Find the editable area that belongs to the same composer as `anchor`.
  function findComposer(anchor) {
    let node = parentOf(anchor);
    for (let depth = 0; node && depth < 30; depth++, node = parentOf(node)) {
      if (node === document.body || node === document.documentElement) break;
      let textarea = null;
      for (const el of deepElements(node)) {
        if (el.closest && el.closest('#pepe-emoji-picker-host')) continue;
        const ce = el.getAttribute && el.getAttribute('contenteditable');
        if ((ce === 'true' || ce === '' || ce === 'plaintext-only') && isVisible(el)) {
          // Use the outermost editable (Lexical root), not a nested one.
          let root = el;
          while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
          return { composer: node, editor: root };
        }
        if (!textarea && el.tagName === 'TEXTAREA' && isVisible(el)) textarea = el;
      }
      if (textarea) return { composer: node, editor: textarea };
    }
    return null;
  }

  // Climb out of single-child / tooltip wrappers so our button sits beside
  // the Aa button in the toolbar, not inside its tooltip.
  function insertionPoint(btn) {
    let node = btn;
    for (let i = 0; i < 4; i++) {
      const p = node.parentElement;
      if (!p) break;
      const tag = p.tagName.toLowerCase();
      const wrapper = tag.includes('tooltip') || p.hasAttribute('tooltip') || p.childElementCount === 1;
      if (!wrapper) break;
      node = p;
    }
    return node;
  }

  // Reddit wraps each toolbar icon in its own <rte-toolbar-button>. Find the
  // one that holds the Aa button (it may be across a shadow-root boundary).
  function toolbarItemFor(btn) {
    let node = btn;
    for (let i = 0; i < 8 && node; i++, node = parentOf(node)) {
      if (node.tagName === ITEM_TAG) return node;
    }
    return null;
  }

  // Our own <rte-toolbar-button>, styled like the original but without
  // anything that identifies it as the formatting button.
  function makeToolbarItem(original, button) {
    const item = document.createElement(original.localName);
    for (const { name, value } of original.attributes) {
      if (/^(id|name|title|label|tooltip|data-testid)$|^aria-/.test(name) || /format/i.test(value)) continue;
      item.setAttribute(name, value);
    }
    item.classList.add(ITEM_CLASS);
    item.append(button);
    return item;
  }

  function iconSizeFor(btn) {
    const icon = btn.querySelector('svg, img, [icon-name]');
    const h = icon ? Math.round(icon.getBoundingClientRect().height) : 0;
    return Math.max(18, Math.min(26, (h || 20) + 2));
  }

  function makeButton(anchorBtn) {
    const b = document.createElement('button');
    b.type = 'button';
    // Reuse Reddit's own classes so it gets the same size / hover circle.
    b.className = `${anchorBtn.className || ''} ${BTN_CLASS}`.trim();
    b.setAttribute('aria-label', 'Add a Pepe emoji');
    b.title = 'Pepe emojis';
    b.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;';
    if (!anchorBtn.className) {
      b.style.cssText +=
        'width:32px;height:32px;padding:0;border:0;border-radius:999px;background:transparent;';
    }
    const size = iconSizeFor(anchorBtn);
    const img = document.createElement('img');
    img.src = url('icons/pepe-button.png');
    img.alt = '';
    img.draggable = false;
    img.style.cssText = `width:${size}px;height:${size}px;display:block;pointer-events:none;`;
    b.appendChild(img);

    let savedRange = null;
    // Keep focus (and the caret) in the comment box when the button is pressed.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const ctx = findComposer(b);
      savedRange = ctx ? captureRange(ctx.editor) : null;
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (picker.isOpenFor(b)) { picker.close(); return; }
      const ctx = findComposer(b);
      if (!ctx) { toast("Couldn't find the comment box for this button."); return; }
      if (!savedRange) savedRange = captureRange(ctx.editor);
      picker.open(b, { ...ctx, range: savedRange });
      savedRange = null;
    });
    return b;
  }

  function scan() {
    if (!alive()) { stop(); return; }
    for (const el of deepElements(document.body)) {
      if (!isFormattingButton(el)) continue;
      const item = toolbarItemFor(el);
      const point = item || insertionPoint(el);
      const next = point.nextElementSibling;
      if (next && (next.classList.contains(BTN_CLASS) || next.classList.contains(ITEM_CLASS))) continue;
      if (!isVisible(el) || !findComposer(el)) continue;
      const button = makeButton(el);
      if (item) {
        const wrapper = makeToolbarItem(item, button);
        item.insertAdjacentElement('afterend', wrapper);
        // If Reddit's element doesn't display content added this way, fall
        // back to placing the button on its own right after the Aa item.
        requestAnimationFrame(() => {
          if (wrapper.isConnected && !isVisible(button)) wrapper.replaceWith(button);
        });
      } else {
        point.insertAdjacentElement('afterend', button);
      }
    }
  }

  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('focusin', scheduleScan, true);
  document.addEventListener('click', scheduleScan, true);
  const interval = setInterval(scheduleScan, 2000);
  scheduleScan();

  function stop() {
    observer.disconnect();
    clearInterval(interval);
  }

  /* ------------------------------------------------------------------ */
  /* Selection save / restore                                           */
  /* ------------------------------------------------------------------ */

  function selectionFor(el) {
    const root = el.getRootNode();
    return (root.getSelection && root.getSelection()) || document.getSelection();
  }

  function captureRange(editor) {
    try {
      if (editor.tagName === 'TEXTAREA') return { start: editor.selectionStart, end: editor.selectionEnd };
      const sel = selectionFor(editor);
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (editor.contains(r.startContainer)) return r.cloneRange();
      }
    } catch { /* ignore */ }
    return null;
  }

  function restoreFocus(editor, range) {
    try { editor.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (!range) return;
    try {
      if (editor.tagName === 'TEXTAREA') {
        editor.setSelectionRange(range.start, range.end);
      } else if (range instanceof Range && editor.contains(range.startContainer)) {
        const sel = selectionFor(editor);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Inserting the emoji into the comment                               */
  /* ------------------------------------------------------------------ */

  async function loadFile(emoji) {
    const res = await fetch(url(emoji.file));
    const blob = await res.blob();
    const ext = emoji.file.split('.').pop().toLowerCase();
    const type = blob.type || (ext === 'gif' ? 'image/gif' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    return new File([blob], `${emoji.name}.${ext}`, { type });
  }

  function dataTransferWith(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }

  function viaPaste(editor, file) {
    const ev = new ClipboardEvent('paste', {
      clipboardData: dataTransferWith(file), bubbles: true, cancelable: true, composed: true,
    });
    editor.dispatchEvent(ev);
  }

  function viaDrop(editor, file) {
    const dt = dataTransferWith(file);
    const r = editor.getBoundingClientRect();
    const opts = {
      dataTransfer: dt, bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 20),
    };
    for (const type of ['dragenter', 'dragover', 'drop']) editor.dispatchEvent(new DragEvent(type, opts));
  }

  function viaFileInput(composer, file) {
    const inputs = [...deepElements(composer)].filter(
      (el) => el.tagName === 'INPUT' && el.type === 'file' && !el.disabled
    );
    const accepts = (el) => {
      const a = (el.accept || '').toLowerCase();
      return !a || a.includes('image') || a.includes(file.type) || a.includes(`.${file.name.split('.').pop()}`);
    };
    const input = inputs.find((el) => (el.accept || '').toLowerCase().includes('image')) || inputs.find(accepts);
    if (!input) return false;
    input.files = dataTransferWith(file).files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  function signature(composer, editor) {
    let count = 0, media = 0;
    for (const el of deepElements(composer)) {
      count++;
      if (/^(IMG|FIGURE|VIDEO|PROGRESS)$/.test(el.tagName) && !el.closest(`.${BTN_CLASS}`)) media++;
    }
    const content = editor.tagName === 'TEXTAREA' ? editor.value : editor.innerHTML;
    return `${count}|${media}|${content.length}`;
  }

  function waitForChange(ctx, before, ms) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (signature(ctx.composer, ctx.editor) !== before) return resolve(true);
        if (performance.now() - start > ms) return resolve(false);
        setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
    });
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  async function insertEmoji(emoji, ctx) {
    // The composer may have re-rendered while the picker was open.
    if (!ctx.editor.isConnected) {
      const fresh = ctx.anchor && ctx.anchor.isConnected ? findComposer(ctx.anchor) : null;
      if (!fresh) { toast("The comment box closed — open it and try again."); return; }
      Object.assign(ctx, fresh);
    }

    let file;
    try { file = await loadFile(emoji); }
    catch { toast(`Couldn't load ${emoji.name}.`); return; }

    restoreFocus(ctx.editor, ctx.range);
    await nextFrame();

    const attempts = [
      () => { viaPaste(ctx.editor, file); return true; },
      () => { viaDrop(ctx.editor, file); return true; },
      () => viaFileInput(ctx.composer, file),
    ];
    for (const attempt of attempts) {
      const before = signature(ctx.composer, ctx.editor);
      if (!attempt()) continue;
      if (await waitForChange(ctx, before, CHANGE_WAIT_MS)) {
        saveRecent(emoji);
        return;
      }
    }

    // Nothing took it. Most likely this community doesn't allow images in comments.
    let copied = false;
    if (file.type === 'image/png') {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
        copied = true;
      } catch { /* ignore */ }
    }
    toast(
      "Reddit didn't accept the image here — this community may not allow images in comments." +
      (copied ? ' It’s copied to your clipboard if you want to try Ctrl+V.' : ''),
      6000
    );
  }

  /* ------------------------------------------------------------------ */
  /* Emoji data + recents                                               */
  /* ------------------------------------------------------------------ */

  let indexPromise = null;
  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(url('emojis/index.json'))
        .then((r) => r.json())
        .then((data) => ({
          static: (data.static || []).map((e) => ({ ...e, kind: 'static' })),
          gif: (data.gif || []).map((e) => ({ ...e, kind: 'gif' })),
        }))
        .catch(() => { indexPromise = null; return { static: [], gif: [] }; });
    }
    return indexPromise;
  }

  function getRecent() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(RECENT_KEY, (res) => resolve((res && res[RECENT_KEY]) || []));
      } catch { resolve([]); }
    });
  }

  async function saveRecent(emoji) {
    try {
      const list = (await getRecent()).filter((f) => f !== emoji.file);
      list.unshift(emoji.file);
      chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, MAX_RECENT) });
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Theme                                                              */
  /* ------------------------------------------------------------------ */

  function isDarkPage() {
    const html = document.documentElement;
    if (html.classList.contains('theme-dark')) return true;
    if (html.classList.contains('theme-light')) return false;
    for (const el of [document.body, html]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || parseFloat(m[3]) > 0)) {
        const [r, g, b] = m.map(Number);
        return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
      }
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /* ------------------------------------------------------------------ */
  /* Picker UI                                                          */
  /* ------------------------------------------------------------------ */

  const PICKER_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --bg: #ffffff; --surface: #f2f4f5; --surface-2: #e5ebee; --text: #0f1a1c;
      --muted: #576f76; --border: #d5dde0; --accent: #3f8f3a; --accent-soft: rgba(63,143,58,.14);
      --shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
      position: fixed; width: 360px; height: 444px; display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 16px; box-shadow: var(--shadow); overflow: hidden;
      font: 14px/1.35 "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      animation: pop .14s ease-out;
    }
    .panel.dark {
      --bg: #181c1f; --surface: #23292c; --surface-2: #2c3437; --text: #f2f4f5;
      --muted: #8ba2ad; --border: #343c40; --accent: #6cc565; --accent-soft: rgba(108,197,101,.16);
      --shadow: 0 14px 44px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
    }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }

    .head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 14px; }
    .head img { width: 30px; height: 30px; }
    .heading { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .title { font-weight: 600; font-size: 14px; letter-spacing: .1px; }
    .byline { font-size: 12px; color: var(--muted); }
    .byline a { color: inherit; text-decoration: none; border-radius: 4px; outline-offset: 2px; }
    .byline a:hover { color: var(--accent); text-decoration: underline; }
    .byline a:focus-visible { outline: 2px solid var(--accent); }
    .close {
      width: 28px; height: 28px; border-radius: 999px; border: 0; background: transparent;
      color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; display: grid; place-items: center;
    }
    .close:hover { background: var(--surface); color: var(--text); }

    .search { padding: 0 12px 8px; }
    .search input {
      width: 100%; height: 36px; border-radius: 999px; border: 1px solid transparent;
      background: var(--surface); color: var(--text); padding: 0 14px 0 34px; font: inherit; outline: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238ba2ad' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: 12px center;
    }
    .search input::placeholder { color: var(--muted); }
    .search input:focus { border-color: var(--accent); }

    .tabs { display: flex; gap: 4px; padding: 0 12px 8px; border-bottom: 1px solid var(--border); }
    .tab {
      border: 0; background: transparent; color: var(--muted); font: inherit; font-weight: 600; font-size: 13px;
      padding: 6px 12px; border-radius: 999px; cursor: pointer;
    }
    .tab:hover { background: var(--surface); color: var(--text); }
    .tab[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); }
    .tab .n { font-weight: 500; opacity: .7; margin-left: 4px; font-size: 12px; }

    .body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 10px 10px;
      scrollbar-width: thin; scrollbar-color: var(--surface-2) transparent; }
    .section { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px;
      color: var(--muted); padding: 10px 4px 6px; }
    .grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; }
    .tile {
      position: relative; aspect-ratio: 1; border: 0; border-radius: 10px; background: transparent;
      display: grid; place-items: center; cursor: pointer; padding: 6px;
    }
    .tile:hover, .tile:focus-visible { background: var(--surface-2); outline: none; }
    .tile:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
    .tile img { width: 100%; height: 100%; min-width: 0; max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; }
    .tile .badge {
      position: absolute; right: 3px; bottom: 3px; font-size: 8px; font-weight: 700; letter-spacing: .4px;
      padding: 1px 3px; border-radius: 4px; background: rgba(0,0,0,.55); color: #fff; pointer-events: none;
    }
    .empty { text-align: center; color: var(--muted); padding: 48px 16px; }
    .empty img { width: 48px; height: 48px; opacity: .8; display: block; margin: 0 auto 10px; }

    .foot {
      display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 14px;
      border-top: 1px solid var(--border); background: var(--surface);
    }
    .foot img { width: 32px; height: 32px; object-fit: contain; }
    .foot .name { font-weight: 600; }
    .foot .hint { color: var(--muted); font-size: 12px; margin-left: auto; }
  `;

  const picker = (() => {
    let host = null, panel = null, anchor = null, ctx = null;
    let tab = 'all', query = '';
    let data = null, recent = [];

    function isOpenFor(btn) { return !!host && anchor === btn; }

    function close() {
      if (!host) return;
      host.remove();
      host = panel = anchor = ctx = null;
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', onScroll, true);
    }

    function onOutside(e) {
      const path = e.composedPath();
      if (path.includes(host) || path.includes(anchor)) return;
      close();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    let scrollRaf = 0;
    function onScroll(e) {
      if (host && e.composedPath && e.composedPath().includes(host)) return;
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(position);
    }

    function position() {
      if (!panel || !anchor) return;
      if (!anchor.isConnected) { close(); return; }
      const r = anchor.getBoundingClientRect();
      const w = panel.offsetWidth || 360, h = panel.offsetHeight || 444, gap = 8;
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(gap, Math.min(left, window.innerWidth - w - gap));
      let top = r.top - h - gap;
      if (top < gap) top = Math.min(r.bottom + gap, window.innerHeight - h - gap);
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(Math.max(gap, top))}px`;
    }

    function el(tag, attrs = {}, children = []) {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      }
      for (const c of children) n.append(c);
      return n;
    }

    function setFooter(emoji) {
      const foot = panel.querySelector('.foot');
      foot.replaceChildren();
      if (emoji) {
        foot.append(
          el('img', { src: url(emoji.file), alt: '' }),
          el('span', { class: 'name', text: `:${emoji.name}:` }),
          el('span', { class: 'hint', text: emoji.kind === 'gif' ? 'Animated' : 'Static' })
        );
      } else {
        foot.append(el('span', { class: 'hint', style: 'margin-left:0', text: 'Pick a Pepe to add it to your comment' }));
      }
    }

    function tile(emoji) {
      const b = el('button', {
        class: 'tile', type: 'button', title: emoji.name, 'aria-label': emoji.name,
        onmouseenter: () => setFooter(emoji),
        onfocus: () => setFooter(emoji),
        onclick: () => choose(emoji),
      });
      b.append(el('img', { src: url(emoji.file), alt: '', loading: 'lazy', decoding: 'async' }));
      if (emoji.kind === 'gif') b.append(el('span', { class: 'badge', text: 'GIF' }));
      return b;
    }

    function section(label, list) {
      const frag = document.createDocumentFragment();
      if (label) frag.append(el('div', { class: 'section', text: label }));
      const grid = el('div', { class: 'grid' });
      list.forEach((e) => grid.append(tile(e)));
      frag.append(grid);
      return frag;
    }

    function render() {
      if (!panel || !data) return;
      const body = panel.querySelector('.body');
      body.replaceChildren();
      panel.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));

      const q = query.trim().toLowerCase();
      const match = (e) => !q || e.name.toLowerCase().includes(q);
      const statics = data.static.filter(match);
      const gifs = data.gif.filter(match);
      const all = [...data.static, ...data.gif];
      const recents = recent.map((f) => all.find((e) => e.file === f)).filter(Boolean);

      if (tab === 'all') {
        if (!q && recents.length) body.append(section('Recently used', recents));
        if (statics.length) body.append(section('Static', statics));
        if (gifs.length) body.append(section('GIFs', gifs));
      } else if (tab === 'static') {
        if (statics.length) body.append(section(null, statics));
      } else if (gifs.length) {
        body.append(section(null, gifs));
      }

      if (!body.childElementCount) {
        body.append(el('div', { class: 'empty' }, [
          el('img', { src: url('icons/pepe-button.png'), alt: '' }),
          document.createTextNode(q ? `No Pepes match “${query.trim()}”` : 'No emojis in this folder yet'),
        ]));
      }
      body.scrollTop = 0;
    }

    async function choose(emoji) {
      const c = ctx;
      close();
      if (c) await insertEmoji(emoji, c);
    }

    async function open(btn, context) {
      close();
      anchor = btn;
      ctx = { ...context, anchor: btn };
      tab = 'all';
      query = '';

      host = document.createElement('div');
      host.id = 'pepe-emoji-picker-host';
      host.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.append(el('style', { text: PICKER_CSS }));

      panel = el('div', { class: `panel${isDarkPage() ? ' dark' : ''}`, role: 'dialog', 'aria-label': 'Pepe Emojis for Reddit' });
      const search = el('input', {
        type: 'text', placeholder: 'Search Pepe emojis', 'aria-label': 'Search Pepe emojis', spellcheck: 'false',
        oninput: (e) => { query = e.target.value; render(); },
        onkeydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { const first = panel.querySelector('.tile'); if (first) first.click(); }
          if (e.key === 'ArrowDown') { const first = panel.querySelector('.tile'); if (first) { e.preventDefault(); first.focus(); } }
        },
      });
      const mkTab = (id, label) => el('button', {
        class: 'tab', type: 'button', role: 'tab', 'data-tab': id,
        onclick: () => { tab = id; render(); },
      }, [label]);
      const tabStatic = mkTab('static', 'Static');
      const tabGif = mkTab('gif', 'GIFs');

      panel.append(
        el('div', { class: 'head' }, [
          el('img', { src: url('icons/pepe-button.png'), alt: '' }),
          el('div', { class: 'heading' }, [
            el('div', { class: 'title', text: 'Pepe Emojis for Reddit' }),
            el('div', { class: 'byline' }, [
              'by ',
              el('a', {
                href: 'https://pepecoin.com', target: '_blank', rel: 'noopener noreferrer', text: 'Pepecoin.com',
              }),
            ]),
          ]),
          el('button', { class: 'close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: close, text: '×' }),
        ]),
        el('div', { class: 'search' }, [search]),
        el('div', { class: 'tabs', role: 'tablist' }, [mkTab('all', 'All'), tabStatic, tabGif]),
        el('div', { class: 'body' }),
        el('div', { class: 'foot' })
      );
      // Stop Reddit's global keyboard shortcuts while typing in the picker.
      panel.addEventListener('keydown', (e) => e.stopPropagation());
      panel.addEventListener('keyup', (e) => e.stopPropagation());
      panel.addEventListener('keypress', (e) => e.stopPropagation());

      root.append(panel);
      document.body.append(host);
      setFooter(null);
      position();

      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', position);
      window.addEventListener('scroll', onScroll, true);

      const [d, r] = await Promise.all([loadIndex(), getRecent()]);
      if (!panel) return; // closed while loading
      data = d; recent = r;
      tabStatic.append(el('span', { class: 'n', text: String(d.static.length) }));
      tabGif.append(el('span', { class: 'n', text: String(d.gif.length) }));
      render();
      search.focus({ preventScroll: true });
    }

    return { open, close, isOpenFor };
  })();

  /* ------------------------------------------------------------------ */
  /* Toast                                                              */
  /* ------------------------------------------------------------------ */

  let toastHost = null, toastTimer = null;
  function toast(message, ms = 3500) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;';
      const root = toastHost.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        .t{display:flex;gap:10px;align-items:center;max-width:min(440px,calc(100vw - 32px));padding:10px 14px;
        border-radius:12px;background:#1f2427;color:#f2f4f5;box-shadow:0 8px 28px rgba(0,0,0,.35);
        font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
        img{width:24px;height:24px;flex:none}</style>
        <div class="t"><img alt=""><span></span></div>`;
      root.querySelector('img').src = url('icons/pepe-button.png');
    }
    toastHost.shadowRoot.querySelector('span').textContent = message;
    document.body.append(toastHost);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastHost && toastHost.remove(), ms);
  }
})();
