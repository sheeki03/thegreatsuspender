/* global chrome, workbenchClient */
var legacyUi = (function() {
  'use strict';
  var C = workbenchClient;

  function localise(root) {
    var elements = Array.from(root.querySelectorAll('[data-i18n], [data-i18n-tooltip]'));
    if (root.nodeType === 1 && (root.hasAttribute('data-i18n') || root.hasAttribute('data-i18n-tooltip'))) elements.unshift(root);
    elements.forEach(function(element) {
      ['data-i18n', 'data-i18n-tooltip'].forEach(function(attribute) {
        if (!element.hasAttribute(attribute)) return;
        var text = element.getAttribute(attribute).replace(/__MSG_(\w+)__/g, function(match, key) { return chrome.i18n.getMessage(key) || key; });
        if (attribute === 'data-i18n-tooltip') element.title = text;
        else {
          var lines = text.split('\n');
          element.replaceChildren();
          lines.forEach(function(line, index) { if (index) element.appendChild(document.createElement('br')); element.appendChild(document.createTextNode(line)); });
        }
      });
    });
  }

  async function ready() {
    if (document.readyState === 'loading') await new Promise(function(resolve) { document.addEventListener('DOMContentLoaded', resolve, { once: true }); });
    document.body.classList.add('legacy-page');
    localise(document);
    document.body.hidden = false;
    document.body.classList.remove('hide-initially');
    if (chrome.extension && chrome.extension.inIncognitoContext) document.querySelectorAll('.noIncognito').forEach(function(element) { element.hidden = true; });
  }

  function status(text, kind) {
    var element = document.getElementById('legacy-status');
    if (!element) {
      element = C.node('div', { id: 'legacy-status', class: 'legacy-status', role: 'status', 'aria-live': 'polite' });
      var host = document.querySelector('.content, .splash > div:last-child, main, #gsNotice') || document.body;
      host.prepend(element);
    }
    C.notice(element, text, kind);
  }

  function error(value) { status(value && value.message || String(value), 'error'); }
  function start(handler) { ready().then(handler).catch(error); }
  function bind(element, handler) {
    if (!element) return;
    element.addEventListener('click', async function(event) {
      event.preventDefault();
      if (element.disabled) return;
      element.disabled = true;
      element.setAttribute('aria-busy', 'true');
      try { await handler(event); }
      catch (value) { error(value); }
      finally { element.disabled = false; element.removeAttribute('aria-busy'); }
    });
  }
  function focusKey(element) { return element && (element.dataset.focusKey || element.id) || null; }
  function restoreFocus(key) {
    if (!key) return;
    var target = Array.from(document.querySelectorAll('[data-focus-key], [id]')).find(function(element) { return (element.dataset.focusKey || element.id) === key; });
    if (target && !target.disabled && !target.closest('[hidden]')) target.focus();
  }
  function href(value) {
    try {
      var url = new URL(value);
      return ['http:', 'https:', 'file:', 'chrome:', 'chrome-extension:', 'about:'].includes(url.protocol) ? url.href : null;
    } catch (valueError) { return null; }
  }
  function favicon(url) { return chrome.runtime.getURL('_favicon/') + '?pageUrl=' + encodeURIComponent(url || '') + '&size=16'; }
  function imageSource(value) {
    return typeof value === 'string' && (/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);/i.test(value) || /^chrome-extension:\/\//.test(value) || /^https?:\/\//.test(value)) ? value : null;
  }
  function appendNotice(element, text) {
    var doc = new DOMParser().parseFromString(String(text), 'text/html');
    var allowed = new Set(['P', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'BR', 'CODE', 'PRE', 'A']);
    function append(parent, node) {
      if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(node.tagName)) return;
      var next = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : parent;
      if (next !== parent) {
        if (node.tagName === 'A') {
          var link = href(node.getAttribute('href'));
          if (link && /^https?:/.test(link)) { next.href = link; next.target = '_blank'; next.rel = 'noopener noreferrer'; }
        }
        parent.appendChild(next);
      }
      Array.from(node.childNodes).forEach(function(child) { append(next, child); });
    }
    element.replaceChildren();
    Array.from(doc.body.childNodes).forEach(function(node) { append(element, node); });
  }
  return { ready: ready, localise: localise, status: status, error: error, start: start, bind: bind, focusKey: focusKey, restoreFocus: restoreFocus, href: href, favicon: favicon, imageSource: imageSource, appendNotice: appendNotice };
})();
