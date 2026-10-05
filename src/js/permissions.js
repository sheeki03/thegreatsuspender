/* global chrome, workbenchClient, historyUtils, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient;
  legacyUi.start(function() {
    legacyUi.bind(document.getElementById('exportBackupBtn'), async function(event) {
      var trigger = event.currentTarget;
      await historyUtils.exportSessionWithId(null, true);
      trigger.hidden = true;
      legacyUi.status('Current session exported. Keep the backup before changing file URL permissions.', 'success');
    });
    legacyUi.bind(document.getElementById('setFilePermissiosnBtn'), function() { return C.api(chrome.tabs, 'create', [{ url: 'chrome://extensions/?id=' + chrome.runtime.id }]); });
  });
})();
