/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  legacyUi.start(function() {
    legacyUi.bind(document.getElementById('restartExtension'), function() { chrome.runtime.reload(); });
    legacyUi.bind(document.getElementById('sessionManagementLink'), function() { return workbenchClient.openPage('history.html'); });
  });
})();
