/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  legacyUi.start(async function() {
    var info = await workbenchClient.request('legacy.info');
    document.getElementById('aboutVersion').textContent = 'v' + info.version;
  });
})();
