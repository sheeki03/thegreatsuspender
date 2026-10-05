/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient;
  legacyUi.start(async function() {
    var shortcuts = document.getElementById('keyboardShortcuts');
    var result = await C.request('legacy.shortcuts.get');
    var grouping = ['2-toggle-temp-whitelist-tab', '2b-unsuspend-selected-tabs', '4-unsuspend-active-window'];
    result.commands.filter(function(command) { return command.name !== '_execute_action'; }).forEach(function(command) {
      shortcuts.append(C.node('div', { class: grouping.includes(command.name) ? 'bottomMargin' : '', text: command.description }), C.node('div', { class: command.shortcut ? 'hotkeyCommand' : 'lesserText', text: command.shortcut || '(' + chrome.i18n.getMessage('js_shortcuts_not_set') + ')' }));
    });
    legacyUi.bind(document.getElementById('configureShortcuts'), function() { return C.api(chrome.tabs, 'create', [{ url: 'chrome://extensions/shortcuts' }]); });
  });
})();
