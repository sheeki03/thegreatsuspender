/* global workbenchClient, legacyUi */
(function() {
  'use strict';
  legacyUi.start(async function() {
    var notice = await workbenchClient.request('legacy.notice.get');
    var element = document.getElementById('gsNotice');
    if (!notice) { element.textContent = 'There are no new notices.'; return; }
    legacyUi.appendNotice(element, notice.text);
    await workbenchClient.request('legacy.notice.dismiss', { version: notice.version });
  });
})();
