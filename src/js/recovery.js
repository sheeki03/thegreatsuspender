/* global chrome, workbenchClient, legacyUi, historyItems */
(function() {
  'use strict';
  var C = workbenchClient, attempted = false, busy = false, loading = false;
  var restore, list;
  async function refresh() {
    if (busy || loading) return;
    loading = true;
    var focus = legacyUi.focusKey(document.activeElement);
    try {
      var info = await C.request('legacy.recovery.get');
      document.getElementById('screenCaptureNotice').style.display = info.screenCapture === '0' ? 'none' : 'block';
      list.replaceChildren();
      info.tabs.forEach(function(tab) {
        var row = historyItems.createTabHtml(tab, false);
        var link = row.querySelector('.historyLink');
        legacyUi.bind(link, async function() {
          busy = true;
          legacyUi.status('Restoring ' + (tab.title || tab.originalUrl || tab.url) + '…');
          try {
            var result = await C.request('legacy.recovery.restore', { sessionId: tab.sessionId, windowId: tab.windowId, tabId: tab.id });
            attempted = true;
            C.renderResult(document.getElementById('recovery-result'), result, 'Tab restored.');
          } finally { busy = false; await refresh(); }
        });
        list.appendChild(row);
      });
      restore.disabled = !info.tabs.length;
      document.querySelector('.recoverySection').hidden = !info.tabs.length;
      restore.hidden = !info.tabs.length;
      if (!info.tabs.length && attempted) {
        document.getElementById('suspendy-guy-inprogress').hidden = true;
        document.getElementById('recovery-inprogress').hidden = true;
        document.getElementById('suspendy-guy-complete').classList.remove('reallyHidden');
        document.getElementById('recovery-complete').classList.remove('reallyHidden');
        legacyUi.status('All recoverable tabs are open.', 'success');
      } else if (!info.tabs.length) legacyUi.status('No lost suspended tabs need recovery. Saved and recent sessions are still available in the session manager.');
      legacyUi.restoreFocus(focus);
    } catch (error) { legacyUi.error(error); }
    finally { loading = false; }
  }

  legacyUi.start(async function() {
    restore = document.getElementById('restoreSession'); list = document.getElementById('recoveryTabs');
    document.querySelector('.splash > div:last-child').appendChild(C.node('div', { id: 'recovery-result', role: 'status', 'aria-live': 'polite', hidden: true }));
    legacyUi.bind(document.getElementById('manageManuallyLink'), function() { return C.openPage('history.html'); });
    legacyUi.bind(document.getElementById('previewsOffBtn'), async function() { await C.request('legacy.update', { settings: { screenCapture: '0' } }); await refresh(); });
    legacyUi.bind(restore, async function() {
      busy = true; attempted = true;
      legacyUi.status('Restoring lost tabs. Keep this page open until the recovery completes.');
      list.querySelectorAll('img').forEach(function(image) { image.replaceWith(C.node('span', { class: 'faviconSpinner', 'aria-label': 'Restoring tab' })); });
      try {
        var result = await C.request('legacy.recovery.restore');
        C.renderResult(document.getElementById('recovery-result'), result, 'Recovery finished.');
      } finally { busy = false; await refresh(); }
    });
    chrome.runtime.onMessage.addListener(function(message, sender) { if (sender.id === chrome.runtime.id && message.action === 'legacy.recovery.changed') refresh(); });
    C.subscribe(refresh);
    await refresh();
  });
})();
