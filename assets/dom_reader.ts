/**
 * assets/dom_reader.ts
 *
 * The DOM inspector + action executor that runs *inside* the WebView.
 *
 * Authored as a plain string so Metro can bundle it without a raw loader. The
 * script must avoid backticks and ${ so it survives String.raw.
 *
 * Responsibilities inside the page:
 *   1. Tag every interactive element with a stable `data-agent-id`, reaching
 *      into open shadow roots and same-origin iframes — Google Forms, ATS
 *      widgets and embedded checkouts all render inside one or the other.
 *   2. Wait for elements to appear rather than failing the moment they are
 *      missing; dynamic pages attach inputs seconds after first paint.
 *   3. Wait for the DOM to settle after a mutating action, so multi-step forms
 *      are never driven faster than they render.
 *   4. Detect SPA route changes, where no load event ever fires.
 *   5. Execute actions with real synthetic events so React / Vue / Angular
 *      controlled inputs actually register the change.
 *
 * Messages posted to RN are JSON: { channel, ...payload }.
 * Commands from RN arrive on window.__AGENT__.handleCommand(cmdJson).
 */

export const DOM_READER_JS = String.raw`
(function () {
  var VERSION = 2;
  if (window.__AGENT__ && window.__AGENT__.version === VERSION) {
    window.__AGENT__.scan(true);
    return;
  }

  var MAX_ELEMENTS = 220;
  var MAX_TEXT = 6000;
  var MAX_FRAME_DEPTH = 4;
  var MAX_SHADOW_DEPTH = 12;
  var DEFAULT_WAIT_MS = 10000;
  var SETTLE_QUIET_MS = 400;
  var SETTLE_MAX_MS = 8000;

  var counter = 0;
  var lastUrl = location.href;
  var blockedFrames = 0;
  var blockedFrameUrls = [];

  function post(channel, payload) {
    try {
      var msg = Object.assign({ channel: channel }, payload || {});
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (e) {
      try {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ channel: 'error', message: String(e && e.message) })
        );
      } catch (e2) { /* nothing left to do */ }
    }
  }

  /* ------------------------------ popup capture ----------------------------- */

  /**
   * The WebView runs with multiple windows disabled, so window.open() is a
   * silent no-op. Job boards overwhelmingly open their application form that
   * way, which made "click Apply" look successful while nothing happened.
   * Redirect popups into the current view instead, and neutralise target=_blank
   * for the same reason.
   */
  function capturePopups() {
    if (window.__agentPopupPatched) return;
    window.__agentPopupPatched = true;

    window.open = function (url) {
      if (url) {
        post('popup', { url: String(url) });
        setTimeout(function () { location.href = url; }, 0);
      }
      return window;
    };

    document.addEventListener('click', function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[target]') : null;
      if (anchor && anchor.target && anchor.target !== '_self') anchor.target = '_self';
    }, true);
  }

  /* ------------------------------- root walking ------------------------------ */

  /**
   * Every queryable root: the main document, open shadow roots, and the
   * documents of same-origin iframes. Cross-origin frames throw on access and
   * are counted instead, so the agent knows content is hidden from it.
   */
  function collectRoots() {
    blockedFrames = 0;
    blockedFrameUrls = [];
    var roots = [];

    /**
     * Shadow depth and frame depth are budgeted separately: component
     * libraries nest shadow roots many levels deep (a Material radio group is
     * routinely 4-6 hosts down), while frames rarely nest past two.
     */
    function walk(root, shadowDepth, frameDepth) {
      if (!root || roots.indexOf(root) !== -1) return;
      if (shadowDepth > MAX_SHADOW_DEPTH || frameDepth > MAX_FRAME_DEPTH) return;
      roots.push(root);

      var hosts;
      try { hosts = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) walk(hosts[i].shadowRoot, shadowDepth + 1, frameDepth);
      }

      var frames;
      try { frames = root.querySelectorAll('iframe,frame'); } catch (e) { frames = []; }
      for (var j = 0; j < frames.length; j++) {
        var doc = null;
        try {
          doc = frames[j].contentDocument;
          if (doc && !doc.body) doc = null;
        } catch (e) {
          doc = null;
        }
        if (doc) {
          walk(doc, shadowDepth, frameDepth + 1);
        } else {
          blockedFrames++;
          // Report the src so the agent can open the embed as a top-level page,
          // which turns an unreadable cross-origin form into a readable one.
          var src = frames[j].src || frames[j].getAttribute('src');
          if (src && blockedFrameUrls.indexOf(src) === -1) blockedFrameUrls.push(src);
        }
      }
    }

    walk(document, 0, 0);
    return roots;
  }

  function queryAll(selector) {
    var roots = collectRoots();
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      var found;
      try { found = roots[i].querySelectorAll(selector); } catch (e) { continue; }
      for (var j = 0; j < found.length; j++) out.push(found[j]);
    }
    return out;
  }

  function findEl(agentId) {
    var selector = '[data-agent-id="' + CSS.escape(agentId) + '"]';
    var roots = collectRoots();
    for (var i = 0; i < roots.length; i++) {
      var el;
      try { el = roots[i].querySelector(selector); } catch (e) { continue; }
      if (el) return el;
    }
    return null;
  }

  /* --------------------------------- tagging -------------------------------- */

  /**
   * Design systems (Material, Polymer, most component libraries) render a
   * styled wrapper and hide the real control behind it — opacity:0, a 1x1
   * sr-only box, or a zero-size input inside a shadow root. The control is
   * still the only thing that accepts a click, so judge visibility by the
   * nearest painted ancestor rather than the control's own box.
   */
  function hasVisibleAncestor(el) {
    var node = el;
    for (var depth = 0; node && depth < 8; depth++) {
      var next = node.parentElement;
      if (!next) {
        var root = node.getRootNode ? node.getRootNode() : null;
        next = root && root.host ? root.host : null;
      }
      node = next;
      if (!node || !node.getBoundingClientRect) continue;

      var view = (node.ownerDocument && node.ownerDocument.defaultView) || window;
      var style;
      try { style = view.getComputedStyle(node); } catch (e) { continue; }
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

      var box = node.getBoundingClientRect();
      if (box.width >= 2 && box.height >= 2) return true;
    }
    return false;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled) return false;

    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();

    // Never surface inputs the user could not interact with at all.
    if (tag === 'input' && type === 'hidden') return false;

    // File, radio and checkbox inputs are almost always visually replaced by a
    // styled wrapper. They are the only clickable target, so keep them
    // whenever anything above them is actually painted. This check must
    // precede every other visibility rule.
    if (type === 'file' || type === 'radio' || type === 'checkbox') {
      return el.getBoundingClientRect().width >= 2 || hasVisibleAncestor(el);
    }

    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var style;
    try { style = view.getComputedStyle(el); } catch (e) { return false; }
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;

    var r = el.getBoundingClientRect();

    // A transparent or sr-only control still counts if its wrapper is painted.
    if (parseFloat(style.opacity || '1') < 0.05 || r.width < 2 || r.height < 2) {
      return hasVisibleAncestor(el);
    }

    if (r.bottom < -view.innerHeight * 2) return false;
    if (r.top > view.innerHeight * 4) return false;
    return true;
  }

  /** innerText is layout-aware but absent in some engines; fall back safely. */
  function textOf(el) {
    if (!el) return '';
    var t = el.innerText;
    if (typeof t !== 'string' || !t.length) t = el.textContent || '';
    return t;
  }

  function labelFor(el) {
    var parts = [];
    var doc = el.ownerDocument || document;
    if (el.id) {
      try {
        var lab = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) { var labText = textOf(lab); if (labText) parts.push(labText); }
      } catch (e) { /* id is not selector-safe */ }
    }
    var wrapper = el.closest ? el.closest('label') : null;
    if (wrapper) { var wrapText = textOf(wrapper); if (wrapText) parts.push(wrapText); }
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(function (id) {
        var node = doc.getElementById(id);
        if (node) { var nodeText = textOf(node); if (nodeText) parts.push(nodeText); }
      });
    }
    if (!parts.length) {
      // Google Forms keeps the question text in an ancestor listitem.
      var item = el.closest ? el.closest('[role=listitem]') : null;
      if (item && item.innerText) parts.push(item.innerText.split('\n')[0]);
    }
    if (!parts.length && el.previousElementSibling) {
      var prev = el.previousElementSibling;
      var prevText = textOf(prev); if (prevText && prevText.length < 120) parts.push(prevText);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  function kindOf(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'file') return 'file';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'input';
    }
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'tab' || role === 'menuitem') return 'button';
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'link') return 'link';
    if (role === 'combobox' || role === 'listbox') return 'select';
    if (role === 'textbox' || role === 'searchbox' || el.isContentEditable) return 'textarea';
    if (role === 'option') return 'checkbox';
    // Custom controls with no role still announce their state via ARIA.
    if (el.hasAttribute && el.hasAttribute('aria-checked')) return 'checkbox';
    return 'button';
  }

  var SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a[href]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=switch]', '[role=radio]',
    '[role=radiogroup]', '[role=tab]', '[role=combobox]', '[role=listbox]', '[role=option]',
    '[role=menuitem]', '[role=textbox]', '[role=searchbox]', '[role=spinbutton]',
    '[contenteditable=true]', '[onclick]',
    // Custom elements expose no standard tag or role, but a focusable one is
    // still the control the user clicks — Google Careers renders its radio
    // questions this way.
    '[tabindex]:not([tabindex="-1"])',
    '[aria-checked]', '[aria-selected]', '[data-value]'
  ].join(',');

  function tagAll() {
    var nodes = queryAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].getAttribute('data-agent-id')) {
        counter += 1;
        nodes[i].setAttribute('data-agent-id', kindOf(nodes[i]) + '-' + counter);
      }
    }
  }

  function describe(el) {
    var kind = kindOf(el);
    var text = (textOf(el) || el.value || el.getAttribute('title') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120);

    var item = {
      agentId: el.getAttribute('data-agent-id'),
      kind: kind,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || undefined,
      label: labelFor(el) || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || undefined,
      text: text || undefined
    };

    if (el.ownerDocument !== document) item.inFrame = true;

    if (kind === 'input' || kind === 'textarea') {
      item.value = (el.value || el.innerText || '').slice(0, 160);
    }
    if (kind === 'checkbox' || kind === 'radio') {
      item.checked = !!el.checked || el.getAttribute('aria-checked') === 'true';
    }
    if (kind === 'link') item.href = el.href;
    if (kind === 'select' && el.options) {
      item.options = Array.prototype.slice.call(el.options, 0, 60).map(function (o) {
        return o.text.trim();
      });
    }
    return item;
  }

  function readableText() {
    var out = '';
    var roots = collectRoots();
    for (var i = 0; i < roots.length && out.length < MAX_TEXT; i++) {
      var body = roots[i].body || roots[i];
      if (!body || !body.cloneNode) continue;
      var clone;
      try { clone = body.cloneNode(true); } catch (e) { continue; }
      var junk = clone.querySelectorAll ? clone.querySelectorAll('script,style,noscript,svg') : [];
      for (var j = 0; j < junk.length; j++) junk[j].remove();
      out += (clone.innerText || '') + '\n';
    }
    return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, MAX_TEXT);
  }

  function snapshot() {
    tagAll();
    var nodes = queryAll('[data-agent-id]');
    var elements = [];
    for (var i = 0; i < nodes.length && elements.length < MAX_ELEMENTS; i++) {
      if (isVisible(nodes[i])) elements.push(describe(nodes[i]));
    }
    return {
      url: location.href,
      title: document.title || '',
      text: readableText(),
      elements: elements,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      blockedFrames: blockedFrames,
      blockedFrameUrls: blockedFrameUrls.slice(0, 5),
      capturedAt: Date.now()
    };
  }

  /* --------------------------------- waiting -------------------------------- */

  /**
   * Poll for an element rather than failing immediately. Dynamic pages attach
   * inputs long after first paint, and an agent that gives up on the first
   * miss cannot drive a Google Form or any ATS at all.
   */
  function waitForElement(agentId, timeout, cb) {
    var deadline = Date.now() + (timeout || DEFAULT_WAIT_MS);
    var immediate = findEl(agentId);
    if (immediate) return cb(immediate);

    var timer = setInterval(function () {
      var el = findEl(agentId);
      if (el) {
        clearInterval(timer);
        cb(el);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        cb(null);
      }
    }, 250);
  }

  /**
   * Resolves once the DOM has been quiet for quietMs, or maxMs has elapsed.
   * Runs after every mutating action so the next action sees the page that
   * the previous click actually produced.
   */
  function settle(cb, quietMs, maxMs) {
    var quiet = quietMs || SETTLE_QUIET_MS;
    var max = maxMs || SETTLE_MAX_MS;
    var done = false;
    var quietTimer = null;
    var observer = null;

    var hardStop = setTimeout(finish, max);

    function finish() {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (observer) observer.disconnect();
      clearTimeout(hardStop);
      cb();
    }

    function restartQuiet() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quiet);
    }

    try {
      observer = new MutationObserver(restartQuiet);
      observer.observe(document.body || document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
    } catch (e) { /* observation unavailable; the hard stop still fires */ }

    restartQuiet();
  }

  /* --------------------------------- actions -------------------------------- */

  function scrollIntoView(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* older engines */ }
  }

  /**
   * React (and Vue/Angular) track input values on the DOM node's own property,
   * so assigning el.value directly is swallowed. Calling the *prototype*
   * setter bypasses the framework's value tracker, after which a bubbling
   * input event makes the framework observe the real change.
   */
  function setNativeValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function keyEvents(el, key) {
    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var opts = { bubbles: true, cancelable: true, key: key, code: key, view: view };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Full synthetic chain: focus -> keydown -> input -> change -> blur. */
  function fill(el, value) {
    scrollIntoView(el);
    if (el.focus) el.focus();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    el.dispatchEvent(new Event('focus', { bubbles: false }));

    if (el.isContentEditable) {
      el.innerText = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      keyEvents(el, value.slice(-1) || 'a');
      setNativeValue(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: false }));
    if (el.blur) el.blur();
    return 'filled ' + (el.getAttribute('data-agent-id') || '');
  }

  function click(el) {
    scrollIntoView(el);
    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var rect = el.getBoundingClientRect();
    var opts = {
      bubbles: true, cancelable: true, view: view,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* no PointerEvent */ }
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (el.focus) el.focus();
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) { /* no PointerEvent */ }
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return 'clicked ' + (el.getAttribute('data-agent-id') || '');
  }

  function selectOption(el, value) {
    scrollIntoView(el);
    var wanted = String(value).toLowerCase();
    var matched = false;
    if (el.options) {
      for (var i = 0; i < el.options.length; i++) {
        var opt = el.options[i];
        if ((opt.text || '').toLowerCase() === wanted || (opt.value || '').toLowerCase() === wanted) {
          el.selectedIndex = i; matched = true; break;
        }
      }
      if (!matched) {
        for (var j = 0; j < el.options.length; j++) {
          if ((el.options[j].text || '').toLowerCase().indexOf(wanted) !== -1) {
            el.selectedIndex = j; matched = true; break;
          }
        }
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return matched ? 'selected ' + value : 'no option matching ' + value;
  }

  function setChecked(el, wanted) {
    scrollIntoView(el);
    var want = wanted !== 'false';
    var current = !!el.checked || el.getAttribute('aria-checked') === 'true';
    if (current !== want) click(el);
    return 'checkbox now ' + (!!el.checked || el.getAttribute('aria-checked') === 'true');
  }

  function uploadFile(el, fileName, mimeType, base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var file = new File([bytes], fileName, { type: mimeType || 'application/octet-stream' });
    var dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: false }));
    return 'uploaded ' + fileName;
  }

  function performAction(action, el) {
    try {
      switch (action.type) {
        case 'fill':   return { ok: true, detail: fill(el, action.value || '') };
        case 'click':  return { ok: true, detail: click(el) };
        case 'select': return { ok: true, detail: selectOption(el, action.value || '') };
        case 'check':  return { ok: true, detail: setChecked(el, action.value || 'true') };
        case 'key':
          keyEvents(el || document.activeElement || document.body, action.value || 'Enter');
          if (action.value === 'Enter' && el && el.form && el.form.requestSubmit) {
            try { el.form.requestSubmit(); } catch (e) { /* blocked by the page */ }
          }
          return { ok: true, detail: 'pressed ' + (action.value || 'Enter') };
        case 'upload':
          return { ok: true, detail: uploadFile(el, action.fileName, action.mimeType, action.base64) };
        case 'scroll':
          window.scrollBy({ top: action.amount || window.innerHeight * 0.85, behavior: 'instant' });
          return { ok: true, detail: 'scrolled' };
        case 'navigate':
          location.href = action.url;
          return { ok: true, detail: 'navigating to ' + action.url };
        case 'extract':
          return { ok: true, detail: (el ? el.innerText : document.body.innerText).slice(0, 2000) };
        case 'waitFor':
          return { ok: true, detail: 'element ' + action.targetAgentId + ' is present' };
        default:
          return { ok: false, detail: 'unknown action type ' + action.type };
      }
    } catch (e) {
      return { ok: false, detail: String(e && e.message ? e.message : e) };
    }
  }

  var MUTATING = ['click', 'select', 'check', 'key', 'upload'];

  /**
   * Runs actions in sequence. Each targeted action waits for its element to
   * exist first, and every mutating action is followed by a settle window so
   * the next action sees the page the previous one produced.
   */
  function runActions(actions, index, results, done) {
    if (index >= actions.length) return done(results);
    var action = actions[index];

    function advance(result) {
      results.push({ action: action, ok: result.ok, detail: result.detail });
      if (!result.ok || action.type === 'navigate') return done(results);
      if (MUTATING.indexOf(action.type) !== -1) {
        settle(function () { runActions(actions, index + 1, results, done); },
               action.settleQuietMs, action.settleMaxMs);
      } else {
        runActions(actions, index + 1, results, done);
      }
    }

    if (action.targetAgentId) {
      var budget = action.waitTimeout || DEFAULT_WAIT_MS;
      waitForElement(action.targetAgentId, budget, function (el) {
        if (!el) {
          results.push({
            action: action,
            ok: false,
            detail: 'element ' + action.targetAgentId + ' did not appear within ' + budget + 'ms'
          });
          return done(results);
        }
        advance(performAction(action, el));
      });
    } else {
      advance(performAction(action, null));
    }
  }

  /* ------------------------------ observation ------------------------------- */

  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () { post('snapshot', { snapshot: snapshot() }); }, 450);
  }

  function observeRoot(root) {
    try {
      var target = root.body || root.documentElement || root;
      if (!target || target.__agentObserved) return;
      target.__agentObserved = true;
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          if (records[i].addedNodes.length || records[i].removedNodes.length) {
            scheduleScan();
            return;
          }
        }
      }).observe(target, { childList: true, subtree: true });
    } catch (e) { /* cross-origin or detached */ }
  }

  function observeAll() {
    var roots = collectRoots();
    for (var i = 0; i < roots.length; i++) observeRoot(roots[i]);
  }

  /**
   * SPA route changes fire no load event, so the native side never learns the
   * page changed. Patch the history API, listen for pops, and poll as a
   * backstop for frameworks that change location by other means.
   */
  function watchUrl() {
    function announce() {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      post('urlchange', { url: location.href });
      setTimeout(function () {
        observeAll();
        post('snapshot', { snapshot: snapshot() });
      }, 500);
    }

    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      if (!original || original.__agentPatched) return;
      var patched = function () {
        var result = original.apply(this, arguments);
        setTimeout(announce, 0);
        return result;
      };
      patched.__agentPatched = true;
      history[name] = patched;
    });

    window.addEventListener('popstate', announce);
    window.addEventListener('hashchange', announce);
    setInterval(announce, 700);
  }

  /* -------------------------------- dispatch -------------------------------- */

  window.__AGENT__ = {
    version: VERSION,
    scan: function (immediate) {
      if (immediate) post('snapshot', { snapshot: snapshot() });
      else scheduleScan();
    },
    handleCommand: function (raw) {
      var cmd;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch (e) { return post('error', { message: 'bad command json' }); }

      if (cmd.op === 'snapshot') {
        return post('snapshot', { requestId: cmd.requestId, snapshot: snapshot() });
      }

      if (cmd.op === 'waitFor') {
        return waitForElement(cmd.agentId, cmd.timeout || DEFAULT_WAIT_MS, function (el) {
          post('waitResult', { requestId: cmd.requestId, found: !!el, agentId: cmd.agentId });
        });
      }

      if (cmd.op === 'settle') {
        return settle(function () {
          post('settleResult', { requestId: cmd.requestId, snapshot: snapshot() });
        }, cmd.quietMs, cmd.maxMs);
      }

      if (cmd.op === 'execute') {
        return runActions(cmd.actions, 0, [], function (results) {
          post('actionResult', { requestId: cmd.requestId, results: results });
          settle(function () { post('snapshot', { snapshot: snapshot() }); }, 300, 4000);
        });
      }

      post('error', { message: 'unknown op ' + cmd.op });
    }
  };

  capturePopups();
  observeAll();
  watchUrl();
  post('ready', { url: location.href, title: document.title, version: VERSION });
  post('snapshot', { snapshot: snapshot() });
})();
true;
`;

export default DOM_READER_JS;
