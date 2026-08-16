/**
 * assets/dom_reader.ts
 *
 * The DOM inspector + action executor that runs *inside* the WebView.
 *
 * It is authored here as a plain string so Metro can bundle it without a raw
 * loader. The script must avoid backticks and ${ so it survives String.raw.
 *
 * Responsibilities inside the page:
 *   1. Tag every interactive element with a stable `data-agent-id`.
 *   2. Re-tag on DOM mutations (SPA route changes, async form rendering).
 *   3. Serialise a compact PageSnapshot back to React Native.
 *   4. Execute actions with *real* synthetic events so React / Vue / Angular
 *      controlled inputs actually register the change.
 *
 * Messages posted to RN are JSON: { channel, ...payload }.
 * Commands from RN arrive on window.__AGENT__.handleCommand(cmdJson).
 */

export const DOM_READER_JS = String.raw`
(function () {
  if (window.__AGENT__ && window.__AGENT__.version === 1) {
    window.__AGENT__.scan(true);
    return;
  }

  var MAX_ELEMENTS = 220;
  var MAX_TEXT = 6000;
  var counter = 0;

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

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    var r = el.getBoundingClientRect();
    // File inputs are routinely 0x0 and driven by a styled label; keep them.
    if (el.type === 'file') return true;
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -window.innerHeight * 2) return false;
    if (r.top > window.innerHeight * 4) return false;
    return true;
  }

  function labelFor(el) {
    var parts = [];
    if (el.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.innerText) parts.push(lab.innerText);
    }
    var wrapper = el.closest ? el.closest('label') : null;
    if (wrapper && wrapper.innerText) parts.push(wrapper.innerText);
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(function (id) {
        var node = document.getElementById(id);
        if (node && node.innerText) parts.push(node.innerText);
      });
    }
    if (!parts.length && el.parentElement) {
      // Fall back to the nearest preceding text node in the field group.
      var prev = el.previousElementSibling;
      if (prev && prev.innerText && prev.innerText.length < 120) parts.push(prev.innerText);
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
    if (role === 'checkbox') return 'checkbox';
    if (role === 'link') return 'link';
    if (role === 'combobox' || role === 'listbox') return 'select';
    if (el.isContentEditable) return 'textarea';
    return 'button';
  }

  var SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a[href]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=tab]',
    '[role=combobox]', '[role=listbox]', '[role=menuitem]',
    '[contenteditable=true]', '[onclick]'
  ].join(',');

  function tagAll() {
    var nodes = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.getAttribute('data-agent-id')) {
        counter += 1;
        el.setAttribute('data-agent-id', kindOf(el) + '-' + counter);
      }
    }
  }

  function describe(el) {
    var kind = kindOf(el);
    var text = (el.innerText || el.value || el.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

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
    var clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return '';
    var junk = clone.querySelectorAll('script,style,noscript,svg,iframe');
    for (var i = 0; i < junk.length; i++) junk[i].remove();
    return (clone.innerText || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
      .trim().slice(0, MAX_TEXT);
  }

  function snapshot() {
    tagAll();
    var nodes = document.querySelectorAll('[data-agent-id]');
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
      capturedAt: Date.now()
    };
  }

  function find(agentId) {
    return document.querySelector('[data-agent-id="' + CSS.escape(agentId) + '"]');
  }

  function scrollIntoView(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* older engines */ }
  }

  /**
   * React (and Vue/Angular) track input values on the DOM node's own property,
   * so assigning el.value directly is swallowed. Calling the *prototype*
   * setter bypasses the framework's value tracker, after which a bubbling
   * 'input' event makes the framework observe the real change.
   */
  function setNativeValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill(el, value) {
    scrollIntoView(el);
    el.focus();
    if (el.isContentEditable) {
      el.innerText = value;
      fireInputEvents(el);
    } else {
      setNativeValue(el, '');
      fireInputEvents(el);
      setNativeValue(el, value);
      fireInputEvents(el);
    }
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return 'filled ' + (el.getAttribute('data-agent-id') || '');
  }

  function click(el) {
    scrollIntoView(el);
    var rect = el.getBoundingClientRect();
    var opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return 'clicked ' + (el.getAttribute('data-agent-id') || '');
  }

  function selectOption(el, value) {
    scrollIntoView(el);
    var wanted = String(value).toLowerCase();
    var matched = false;
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var text = (opt.text || '').toLowerCase();
      if (text === wanted || (opt.value || '').toLowerCase() === wanted) {
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
    fireInputEvents(el);
    return matched ? 'selected ' + value : 'no option matching ' + value;
  }

  function setChecked(el, wanted) {
    scrollIntoView(el);
    var want = wanted !== 'false';
    if (!!el.checked !== want) click(el);
    return 'checkbox now ' + (!!el.checked);
  }

  /**
   * Attaches a file to an <input type=file> from a base64 payload handed down
   * by React Native (the WebView has no access to the app sandbox otherwise).
   */
  function uploadFile(el, fileName, mimeType, base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var file = new File([bytes], fileName, { type: mimeType || 'application/octet-stream' });
    var dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    fireInputEvents(el);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return 'uploaded ' + fileName;
  }

  function pressKey(el, key) {
    var target = el || document.activeElement || document.body;
    var opts = { bubbles: true, cancelable: true, key: key, code: key };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (key === 'Enter' && target.form && target.form.requestSubmit) {
      try { target.form.requestSubmit(); } catch (e) { /* blocked by the page */ }
    }
    return 'pressed ' + key;
  }

  function runAction(action) {
    var el = action.targetAgentId ? find(action.targetAgentId) : null;
    if (action.targetAgentId && !el) {
      return { ok: false, detail: 'no element with data-agent-id=' + action.targetAgentId };
    }
    try {
      switch (action.type) {
        case 'fill':     return { ok: true, detail: fill(el, action.value || '') };
        case 'click':    return { ok: true, detail: click(el) };
        case 'select':   return { ok: true, detail: selectOption(el, action.value || '') };
        case 'check':    return { ok: true, detail: setChecked(el, action.value || 'true') };
        case 'key':      return { ok: true, detail: pressKey(el, action.value || 'Enter') };
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
        default:
          return { ok: false, detail: 'unknown action type ' + action.type };
      }
    } catch (e) {
      return { ok: false, detail: String(e && e.message ? e.message : e) };
    }
  }

  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () { post('snapshot', { snapshot: snapshot() }); }, 450);
  }

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].addedNodes.length || records[i].removedNodes.length) {
        scheduleScan();
        return;
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.__AGENT__ = {
    version: 1,
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
      if (cmd.op === 'execute') {
        var results = [];
        for (var i = 0; i < cmd.actions.length; i++) {
          var r = runAction(cmd.actions[i]);
          results.push({ action: cmd.actions[i], ok: r.ok, detail: r.detail });
          if (!r.ok) break;
          if (cmd.actions[i].type === 'navigate') break;
        }
        post('actionResult', { requestId: cmd.requestId, results: results });
        setTimeout(function () { post('snapshot', { snapshot: snapshot() }); }, 900);
        return;
      }
      post('error', { message: 'unknown op ' + cmd.op });
    }
  };

  post('ready', { url: location.href, title: document.title });
  post('snapshot', { snapshot: snapshot() });
})();
true;
`;

export default DOM_READER_JS;
