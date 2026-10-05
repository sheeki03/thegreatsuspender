/* global chrome */
var workbenchClient = (function() {
  'use strict';

  function request(command, payload) {
    return new Promise(function(resolve, reject) {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error('This page must be opened inside the installed extension.'));
        return;
      }
      chrome.runtime.sendMessage({ action: 'workbench', command: command, payload: payload || {} }, function(response) {
        var error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        if (!response || response.ok !== true) {
          return reject(new Error(response && response.error ? response.error : 'The extension did not respond. Reload this page to reconnect.'));
        }
        resolve(response.data);
      });
    });
  }

  function api(object, method, args) {
    return new Promise(function(resolve, reject) {
      if (!object || typeof object[method] !== 'function') return reject(new Error('The browser does not support ' + method + '.'));
      try {
        object[method].apply(object, (args || []).concat(function(value) {
          var error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(value);
        }));
      } catch (error) { reject(error); }
    });
  }

  function node(tag, attributes, children) {
    var element = document.createElement(tag);
    Object.keys(attributes || {}).forEach(function(key) {
      var value = attributes[key];
      if (key === 'text') element.textContent = value == null ? '' : String(value);
      else if (key === 'class') element.className = value;
      else if (key === 'on') Object.keys(value).forEach(function(event) { element.addEventListener(event, value[event]); });
      else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'value') element[key] = value;
      else if (value !== null && value !== undefined) element.setAttribute(key, String(value));
    });
    (children || []).forEach(function(child) { if (child) element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return element;
  }

  function button(text, handler, attributes) {
    return node('button', Object.assign({ type: 'button', text: text, on: { click: handler } }, attributes || {}));
  }

  function select(options, value, attributes) {
    var element = node('select', attributes || {});
    options.forEach(function(option) { element.appendChild(node('option', { value: option[0], text: option[1] })); });
    if (value !== undefined && value !== null) element.value = String(value);
    return element;
  }

  function field(text, input, help) {
    var label = node('label', { class: 'field' }, [node('span', { text: text }), input]);
    if (help) label.appendChild(node('small', { text: help }));
    return label;
  }

  function check(text, input, help) {
    var label = node('label', { class: 'check-field' }, [input, node('span', { text: text })]);
    if (help) label.appendChild(node('small', { text: help }));
    return label;
  }

  function notice(element, text, kind) {
    element.textContent = text || '';
    element.classList.toggle('is-error', kind === 'error');
    element.classList.toggle('is-success', kind === 'success');
    element.hidden = !text;
  }

  function date(value) {
    return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
  }

  function duration(ms) {
    if (!Number.isFinite(Number(ms))) return 'Not recorded';
    var minutes = Math.floor(Math.max(0, Number(ms)) / 60000);
    if (minutes < 1) return 'Less than a minute';
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    return hours + ' h' + (minutes % 60 ? ' ' + minutes % 60 + ' min' : '');
  }

  function expiry(value) {
    if (!value) return '';
    if (value.session) return 'Until browser restart';
    if (value.until) return 'Until ' + date(value.until);
    return 'Until ended';
  }

  // The chosen theme is remembered so the next page opens in it without a flash.
  function theme(value) {
    document.documentElement.dataset.theme = value || 'system';
    try { localStorage.setItem('gsUiTheme', value || 'system'); } catch (error) { /* Optional. */ }
  }
  try { document.documentElement.dataset.theme = localStorage.getItem('gsUiTheme') || 'system'; } catch (error) { /* Optional. */ }

  function subscribe(listener) {
    var timer;
    function receive(message) {
      if (message && message.action === 'workbenchChanged') {
        clearTimeout(timer);
        timer = setTimeout(listener, 100);
      }
    }
    if (window.chrome && chrome.runtime) chrome.runtime.onMessage.addListener(receive);
    return function() {
      clearTimeout(timer);
      if (window.chrome && chrome.runtime) chrome.runtime.onMessage.removeListener(receive);
    };
  }

  function collectResults(result) {
    var skipped = [], errors = [], warnings = [], changed = [], seen = new Set();
    function visit(value, depth) {
      if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value.skipped)) value.skipped.forEach(function(row) { skipped.push(row); });
      if (Array.isArray(value.errors)) value.errors.forEach(function(error) { errors.push(error); });
      if (Array.isArray(value.warnings)) value.warnings.forEach(function(warning) { warnings.push(warning); });
      if (Array.isArray(value.changed)) value.changed.forEach(function(id) { changed.push(id); });
      Object.keys(value).forEach(function(key) { if (!['skipped', 'errors', 'warnings', 'changed', 'tabs', 'eligible', 'entries'].includes(key)) visit(value[key], depth + 1); });
    }
    visit(result, 0);
    var uniqueSkipped = new Map();
    skipped.forEach(function(row) {
      var saved = row.entry && (row.entry.before || row.entry.after || row.entry.restored);
      var key = [row.id || row.tabId || row.uid || row.entry && row.entry.key || '', row.originalUrl || row.url || saved && (saved.originalUrl || saved.url) || '', (row.reasons || [row.reason || '']).join(',')].join('|');
      if (!uniqueSkipped.has(key)) uniqueSkipped.set(key, row);
    });
    return { skipped: Array.from(uniqueSkipped.values()), errors: errors, warnings: Array.from(new Set(warnings)), changed: Array.from(new Set(changed)) };
  }

  function resultText(result, fallback) {
    if (result && typeof result.summary === 'string') return result.summary;
    var detail = collectResults(result);
    var parts = [];
    if (detail.changed.length) parts.push(detail.changed.length + ' tab' + (detail.changed.length === 1 ? '' : 's') + ' changed');
    if (result && Array.isArray(result.restored)) parts.push(result.restored.length + ' tabs restored');
    if (detail.skipped.length) parts.push(detail.skipped.length + ' protected or unavailable tabs skipped');
    if (detail.errors.length) parts.push(detail.errors.length + ' errors');
    if (result && Array.isArray(result.scopes)) {
      if (!result.scopes.length) parts.push('You are under your tab limit, so nothing needed to sleep');
      result.scopes.forEach(function(scope) {
        parts.push((scope.workspaceId ? 'Workspace limit' : 'Tab limit') + ': ' + scope.before + ' → ' + scope.after + ' awake' + (scope.reachedTarget ? '' : ' (some tabs are kept awake, so the target wasn’t reached)'));
      });
    }
    return parts.length ? parts.join('; ') + '.' : fallback || 'Saved.';
  }

  function renderResult(element, result, fallback) {
    element.replaceChildren(node('p', { text: resultText(result, fallback) }));
    var detail = collectResults(result);
    if (detail.skipped.length) {
      var list = node('ul', { class: 'reason-list' });
      detail.skipped.forEach(function(row) {
        var saved = row.entry && (row.entry.before || row.entry.after || row.entry.restored);
        list.appendChild(node('li', {}, [node('strong', { text: row.title || row.originalUrl || row.url || saved && (saved.title || saved.originalUrl || saved.url) || 'Tab ' + (row.id || row.tabId || '') }), node('span', { text: (row.reasons || [row.reason || 'Unavailable']).join(', ') })]));
      });
      element.appendChild(list);
    }
    detail.errors.forEach(function(error) { element.appendChild(node('p', { class: 'error-text', text: typeof error === 'string' ? error : error.error || error.message || 'An operation could not be completed.' })); });
    detail.warnings.forEach(function(warning) { element.appendChild(node('p', { class: 'warning-text', text: typeof warning === 'string' ? warning : warning.message || 'The operation completed with a warning.' })); });
    if (result && Number.isFinite(result.remaining) && result.remaining > 0) element.appendChild(node('p', { class: 'warning-text', text: result.remaining + ' saved entries remain. Resolve the skipped reasons before retrying.' }));
    element.hidden = false;
  }

  function confirm(options) {
    var trigger = document.activeElement;
    var triggerKey = trigger && trigger.dataset.focusKey;
    return new Promise(function(resolve) {
      var dialog = node('dialog', { class: 'confirm-dialog', 'aria-labelledby': 'confirmation-title' });
      var title = node('h2', { id: 'confirmation-title', text: options.title });
      var cancel = button('Cancel', function() { finish(false); });
      var accept = button(options.accept || 'Confirm', function() { finish(true); }, { class: options.destructive ? 'danger solid' : 'primary' });
      var form = node('form', { method: 'dialog' });
      form.addEventListener('submit', function(event) { event.preventDefault(); finish(true); });
      form.append(title);
      if (options.text) form.append(node('p', { text: options.text }));
      if (options.detail) form.append(options.detail);
      form.append(node('div', { class: 'button-row' }, [cancel, accept]));
      dialog.append(form);
      function finish(value) {
        dialog.close();
        dialog.remove();
        var focusTarget = trigger && trigger.isConnected ? trigger : triggerKey ? Array.from(document.querySelectorAll('[data-focus-key]')).find(function(element) { return element.dataset.focusKey === triggerKey; }) : null;
        if (focusTarget) focusTarget.focus();
        resolve(value);
      }
      dialog.addEventListener('cancel', function(event) { event.preventDefault(); finish(false); });
      document.body.appendChild(dialog);
      dialog.showModal();
      (options.focus || cancel).focus();
    });
  }

  // Plain-language versions of the engine's reasons a tab was left as it was.
  var REASONS = {
    'Unsaved form or editable content': 'You typed something that may not be saved',
    'Always keep awake': 'This site is set to stay awake',
    'Snoozed': 'Kept awake for now',
    'Temporarily excluded': 'Paused with the keyboard shortcut',
    'Page is still loading': 'Still loading',
    'Playing audio': 'Playing audio',
    'Pinned tab': 'Pinned',
    'Active tab': 'You’re viewing it',
    'Browser is offline': 'You’re offline',
    'Computer is charging': 'Your computer is plugged in',
    'Browser, private, or extension page': 'Browser pages can’t be suspended',
    'tab-unavailable-or-excluded': 'This tab can’t be suspended'
  };
  function reasonText(reason) { return REASONS[reason] || reason; }

  function favicon(url) {
    return chrome.runtime.getURL('_favicon/') + '?pageUrl=' + encodeURIComponent(url || '') + '&size=32';
  }

  // Uses the page's inline <svg> sprite: <symbol id="i-NAME">.
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  async function openPage(path) {
    await api(chrome.tabs, 'create', [{ url: chrome.runtime.getURL(path) }]);
  }

  async function focusTab(row) {
    if (!row) throw new Error('Select a tab first.');
    await api(chrome.tabs, 'update', [row.id, { active: true }]);
    await api(chrome.windows, 'update', [row.windowId, { focused: true }]);
  }

  function searchKeys(event, input) {
    var editing = event.target && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
    if ((event.key === '/' && !editing) || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  }

  return { request: request, api: api, node: node, button: button, select: select, field: field, check: check, notice: notice, date: date, duration: duration, expiry: expiry, theme: theme, subscribe: subscribe, collectResults: collectResults, resultText: resultText, renderResult: renderResult, confirm: confirm, openPage: openPage, focusTab: focusTab, searchKeys: searchKeys, favicon: favicon, icon: icon, reasonText: reasonText };
})();
