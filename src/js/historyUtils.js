/* global chrome, workbenchClient */
var historyUtils = (function() {
  'use strict';
  var C = workbenchClient;

  async function chooseName(initial, sessionId) {
    var name = window.prompt(chrome.i18n.getMessage('js_history_enter_name_for_session'), initial || '');
    if (name === null || !name.trim()) return null;
    name = name.trim();
    var sessions = await C.request('legacy.sessions.list');
    var conflict = sessions.saved.some(function(session) { return session.name === name && session.sessionId !== sessionId; });
    if (conflict && !window.confirm(chrome.i18n.getMessage('js_history_confirm_session_overwrite'))) return null;
    return { name: name, overwrite: conflict };
  }

  async function importSession(event) {
    var file = event.target.files[0];
    if (!file) return null;
    try {
      if (file.type && file.type !== 'text/plain' && !/\.txt$/i.test(file.name)) throw new Error(chrome.i18n.getMessage('js_history_import_fail'));
      var choice = await chooseName(file.name);
      if (!choice) return null;
      var text = await file.text();
      return await C.request('legacy.sessions.import', { name: choice.name, overwrite: choice.overwrite, text: text });
    } finally { event.target.value = ''; }
  }

  async function exportSessionWithId(sessionId, current) {
    var result = await C.request('legacy.sessions.export', current ? { current: true } : { sessionId: sessionId });
    var blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = C.node('a', { href: url, download: result.filename || 'session.txt' });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    return result;
  }

  async function saveSession(sessionId) {
    var choice = await chooseName();
    if (!choice) return null;
    return C.request('legacy.sessions.save', { sessionId: sessionId, name: choice.name, overwrite: choice.overwrite });
  }

  async function renameSession(session) {
    var choice = await chooseName(session.name, session.sessionId);
    if (!choice || choice.name === session.name) return null;
    return C.request('legacy.sessions.rename', { sessionId: session.sessionId, name: choice.name, overwrite: choice.overwrite });
  }
  return { importSession: importSession, exportSessionWithId: exportSessionWithId, saveSession: saveSession, renameSession: renameSession };
})();
