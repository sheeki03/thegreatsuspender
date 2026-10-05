/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient, data;
  var flags = { toggleDebugInfo: 'debugInfo', toggleDebugError: 'debugError', toggleDiscardInPlaceOfSuspend: 'discardInPlaceOfSuspend', toggleUseAlternateScreenCaptureLib: 'useAlternateScreenCaptureLib' };
  function showFlags() {
    Object.keys(flags).forEach(function(id) { var value = !!data[flags[id]], element = document.getElementById(id); element.textContent = String(value); element.setAttribute('aria-pressed', String(value)); });
  }
  async function refresh() {
    data = await C.request('legacy.debug.get');
    showFlags();
    var body = document.getElementById('gsProfilerBody');
    body.replaceChildren();
    data.tabs.forEach(function(info) {
      var tab = info.tab || {};
      var image = C.node('img', { src: legacyUi.imageSource(tab.favIconUrl) || legacyUi.favicon(tab.originalUrl || tab.url), width: '16', height: '16', alt: '' });
      var timer = info.timerUp && info.timerUp !== '-' ? new Date(info.timerUp).toLocaleString() : '—';
      body.appendChild(C.node('tr', {}, [C.node('td', { text: info.windowId }), C.node('td', { text: info.tabId }), C.node('td', { text: tab.index }), C.node('td', {}, [image]), C.node('td', { text: tab.title || tab.url }), C.node('td', { text: timer }), C.node('td', { text: info.status })]));
    });
  }
  legacyUi.start(async function() {
    Object.keys(flags).forEach(function(id) {
      legacyUi.bind(document.getElementById(id), async function() {
        var payload = {}; payload[flags[id]] = !data[flags[id]];
        Object.assign(data, await C.request('legacy.debug.update', payload));
        showFlags(); legacyUi.status('Debug preference updated.', 'success');
      });
    });
    legacyUi.bind(document.getElementById('claimSuspendedTabs'), async function() { var result = await C.request('legacy.debug.claim'); legacyUi.status(C.resultText(result, 'Suspended tabs claimed.'), 'success'); await refresh(); });
    var url = 'chrome://extensions/?id=' + chrome.runtime.id;
    document.getElementById('backgroundPage').href = url;
    legacyUi.bind(document.getElementById('backgroundPage'), function() { return C.api(chrome.tabs, 'create', [{ url: url }]); });
    await refresh();
  });
})();
