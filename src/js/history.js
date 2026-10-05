/* global chrome, workbenchClient, legacyUi, historyItems, historyUtils */
(function() {
  'use strict';
  var C = workbenchClient;
  var currentSessionId = null, expanded = new Set(), rendering = false, renderAgain = false;

  async function restore(sessionId, windowId, asleep) {
    var payload = { sessionId: sessionId, asleep: asleep };
    if (windowId !== null) payload.windowId = windowId;
    legacyUi.status(asleep ? 'Opening saved tabs suspended…' : 'Restoring saved tabs…');
    var result = await C.request('legacy.sessions.restore', payload);
    legacyUi.status(C.resultText(result, 'Saved tabs restored.'), 'success');
    var host = document.getElementById('session-operation-result');
    C.renderResult(host, result, 'Saved tabs restored.');
  }

  async function populateSession(container, sessionId) {
    var contents = container.querySelector('.sessionContents');
    var session = await C.request('legacy.sessions.get', { sessionId: sessionId });
    if (!session) throw new Error('This session no longer exists. Refresh the session list.');
    var fragment = document.createDocumentFragment();
    (session.windows || []).forEach(function(window, index) {
      var windowData = Object.assign({}, window, { sessionId: sessionId });
      var heading = historyItems.createWindowHtml(windowData, index, sessionId !== currentSessionId);
      legacyUi.bind(heading.querySelector('.resuspendLink'), function() { return restore(sessionId, window.id, true); });
      legacyUi.bind(heading.querySelector('.reloadLink'), function() { return restore(sessionId, window.id, false); });
      fragment.appendChild(heading);
      (window.tabs || []).forEach(function(tab) {
        var tabData = Object.assign({}, tab, { windowId: window.id, sessionId: sessionId });
        var row = historyItems.createTabHtml(tabData, sessionId !== currentSessionId);
        legacyUi.bind(row.querySelector('.removeLink'), async function() {
          var result = await C.request('legacy.sessions.removeTab', { sessionId: sessionId, windowId: window.id, tabId: tab.id });
          if (!result) expanded.delete(sessionId);
          await render();
          legacyUi.status('Tab removed from the saved session. Open browser tabs are unchanged.', 'success');
        });
        fragment.appendChild(row);
      });
    });
    contents.replaceChildren(fragment);
    contents.hidden = false;
    container.querySelectorAll('.sessionLink, .sessionIcon').forEach(function(control) { control.setAttribute('aria-expanded', 'true'); });
    var icon = container.querySelector('.sessionIcon');
    icon.classList.remove('icon-plus-squared-alt'); icon.classList.add('icon-minus-squared-alt'); icon.setAttribute('aria-label', 'Collapse session');
  }

  async function toggle(container, sessionId) {
    if (expanded.has(sessionId)) {
      expanded.delete(sessionId);
      container.querySelector('.sessionContents').hidden = true;
      container.querySelectorAll('.sessionLink, .sessionIcon').forEach(function(control) { control.setAttribute('aria-expanded', 'false'); });
      var icon = container.querySelector('.sessionIcon');
      icon.classList.remove('icon-minus-squared-alt'); icon.classList.add('icon-plus-squared-alt'); icon.setAttribute('aria-label', 'Expand session');
    } else { await populateSession(container, sessionId); expanded.add(sessionId); }
  }

  function createSession(session) {
    var container = historyItems.createSessionHtml(session, true, currentSessionId);
    legacyUi.bind(container.querySelector('.sessionIcon'), function() { return toggle(container, session.sessionId); });
    legacyUi.bind(container.querySelector('.sessionLink'), function() { return toggle(container, session.sessionId); });
    legacyUi.bind(container.querySelector('.exportLink'), async function() { await historyUtils.exportSessionWithId(session.sessionId); legacyUi.status('Session exported.', 'success'); });
    legacyUi.bind(container.querySelector('.resuspendLink'), function() { return restore(session.sessionId, null, true); });
    legacyUi.bind(container.querySelector('.reloadLink'), function() { return restore(session.sessionId, null, false); });
    legacyUi.bind(container.querySelector('.saveLink'), async function() { if (await historyUtils.saveSession(session.sessionId)) { await render(); legacyUi.status('Session saved.', 'success'); } });
    legacyUi.bind(container.querySelector('.renameLink'), async function() { if (await historyUtils.renameSession(session)) { await render(); legacyUi.status('Session renamed.', 'success'); } });
    legacyUi.bind(container.querySelector('.deleteLink'), async function() {
      if (!window.confirm(chrome.i18n.getMessage('js_history_confirm_delete'))) return;
      await C.request('legacy.sessions.delete', { sessionId: session.sessionId });
      expanded.delete(session.sessionId); await render(); legacyUi.status('Session deleted. Open browser tabs are unchanged.', 'success');
    });
    return container;
  }

  async function render() {
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    var focus = legacyUi.focusKey(document.activeElement);
    try {
      var result = await C.request('legacy.sessions.list');
      currentSessionId = result.currentSessionId;
      var current = document.getElementById('currentSessions'), recent = document.getElementById('recoverySessions'), saved = document.getElementById('historySessions');
      current.replaceChildren(); recent.replaceChildren(); saved.replaceChildren();
      var sessions = [];
      result.current.forEach(function(session, index) {
        var element = createSession(session);
        (session.sessionId === currentSessionId || index === 0 ? current : recent).appendChild(element);
        sessions.push([element, session.sessionId]);
      });
      result.saved.forEach(function(session) { var element = createSession(session); saved.appendChild(element); sessions.push([element, session.sessionId]); });
      await Promise.all(sessions.filter(function(item) { return expanded.has(item[1]); }).map(function(item) { return populateSession(item[0], item[1]); }));
      [[current, 'No current session is recorded yet.'], [recent, 'No previous sessions.'], [saved, 'No saved sessions. Save a current or recent session, or import a text file.']].forEach(function(item) { if (!item[0].childElementCount) item[0].appendChild(C.node('p', { class: 'lesserText', text: item[1] })); });
      legacyUi.restoreFocus(focus);
    } finally { rendering = false; if (renderAgain) { renderAgain = false; render().catch(legacyUi.error); } }
  }

  legacyUi.start(async function() {
    var content = document.querySelector('.content');
    content.prepend(C.node('div', { id: 'session-operation-result', role: 'status', 'aria-live': 'polite', hidden: true }));
    legacyUi.bind(document.getElementById('importSession'), function() { document.getElementById('importSessionAction').click(); });
    document.getElementById('importSessionAction').addEventListener('change', async function(event) {
      try { if (await historyUtils.importSession(event)) { await render(); legacyUi.status('Session imported.', 'success'); } }
      catch (error) { legacyUi.error(error); }
    });
    C.subscribe(function() { render().catch(legacyUi.error); });
    await render();
  });
})();
