/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient;
  async function refresh() {
    try {
      var info = await C.request('legacy.info');
      document.getElementById('patchMessage').hidden = info.updateType !== 'patch';
      document.getElementById('minorUpdateDetail').hidden = info.updateType !== 'minor';
      document.getElementById('majorUpdateDetail').hidden = info.updateType !== 'major';
      document.getElementById('updateDetail').hidden = !['major', 'minor'].includes(info.updateType);
      if (info.updated) {
        document.getElementById('updating').hidden = true;
        document.getElementById('updated').classList.remove('reallyHidden');
      }
    } catch (error) { legacyUi.error(error); }
  }
  legacyUi.start(async function() {
    legacyUi.bind(document.getElementById('sessionManagerLink'), function() { return C.openPage('history.html'); });
    chrome.runtime.onMessage.addListener(function(message, sender) { if (sender.id === chrome.runtime.id && message.action === 'legacy.updated.changed') refresh(); });
    C.subscribe(refresh);
    await refresh();
  });
})();
