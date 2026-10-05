/* global chrome, workbenchClient, legacyUi */
var historyItems = (function() {
  'use strict';
  var C = workbenchClient, n = C.node;
  function text(key) { return chrome.i18n.getMessage(key); }
  function control(label, className, key) { return n('button', { type: 'button', class: className, text: label, 'data-focus-key': key }); }
  function createSessionHtml(session, showLinks, currentSessionId) {
    var windows = session.windows || [];
    var type = session.sessionId === currentSessionId ? 'current' : session.name ? 'saved' : 'recent';
    var key = 'session-' + session.sessionId;
    var title = type === 'saved' ? session.name : new Date(session.date).toLocaleString();
    var tabCount = windows.reduce(function(count, window) { return count + (window.tabs || []).length; }, 0);
    var plural = text('js_history_plural');
    var count = windows.length + ' ' + text('js_history_window').toLowerCase() + (windows.length === 1 ? '' : plural) + ', ' + tabCount + ' ' + text('js_history_tab').toLowerCase() + (tabCount === 1 ? '' : plural);
    var container = n('div', { class: 'sessionContainer', 'data-session-id': session.sessionId });
    var contents = n('div', { class: 'sessionContents', id: key + '-contents', hidden: true });
    var icon = control('', 'sessionIcon icon icon-plus-squared-alt', key + '-toggle-icon');
    icon.setAttribute('aria-label', 'Expand ' + title); icon.setAttribute('aria-expanded', 'false'); icon.setAttribute('aria-controls', contents.id);
    var heading = control(title, 'sessionLink', key + '-toggle');
    heading.setAttribute('aria-expanded', 'false'); heading.setAttribute('aria-controls', contents.id);
    heading.appendChild(n('small', { class: 'session-count', text: ' (' + count + ')' }));
    container.append(icon, heading);
    if (showLinks && type !== 'current') container.append(control(text('js_history_resuspend'), 'groupLink resuspendLink', key + '-sleep'), control(text('js_history_reload'), 'groupLink reloadLink', key + '-restore'));
    if (showLinks) container.appendChild(control(text('js_history_export'), 'groupLink exportLink', key + '-export'));
    if (showLinks && type !== 'saved') container.appendChild(control(text('js_history_save'), 'groupLink saveLink', key + '-save'));
    if (showLinks && type === 'saved') container.appendChild(control('Rename', 'groupLink renameLink', key + '-rename'));
    if (showLinks && type !== 'current') container.appendChild(control(text('js_history_delete'), 'groupLink deleteLink', key + '-delete'));
    container.appendChild(contents);
    return container;
  }

  function createWindowHtml(window, index, showLinks) {
    var key = 'session-' + window.sessionId + '-window-' + window.id;
    var container = n('div', { class: 'windowContainer' }, [n('span', { text: text('js_history_window') + ' ' + (index + 1) + ': ' })]);
    if (showLinks) container.append(control(text('js_history_resuspend'), 'groupLink resuspendLink', key + '-sleep'), control(text('js_history_reload'), 'groupLink reloadLink', key + '-restore'));
    return container;
  }

  function createTabHtml(tab, showLinks) {
    var url = tab.originalUrl || tab.url;
    var key = 'session-' + (tab.sessionId || 'recovery') + '-window-' + tab.windowId + '-tab-' + tab.id;
    var container = n('div', { class: 'tabContainer', 'data-tab-id': tab.id, 'data-url': url });
    if (showLinks) container.appendChild(control('Remove', 'itemHover removeLink', key + '-remove'));
    container.appendChild(n('img', { src: legacyUi.imageSource(tab.favIconUrl) || legacyUi.favicon(url), height: '16', width: '16', alt: '', loading: 'lazy' }));
    var link = legacyUi.href(url);
    container.appendChild(n(link ? 'a' : 'span', { class: 'historyLink', href: link, target: link ? '_blank' : null, rel: link ? 'noopener' : null, text: tab.title || url, title: url, 'data-focus-key': key + '-open' }));
    return container;
  }
  return { createSessionHtml: createSessionHtml, createWindowHtml: createWindowHtml, createTabHtml: createTabHtml };
})();
