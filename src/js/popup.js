/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient, n = C.node, b = C.button;
  var data = null, current = null, rawCurrent = null, highlighted = [], whitelisted = false;
  var busy = false, loading = false, refreshAgain = false, loadError = false, previewTriggerKey = null;
  var privateContext = !!(chrome.extension && chrome.extension.inIncognitoContext);
  var privateUnavailable = ['apply-snooze', 'end-snooze', 'apply-protection', 'end-protection'];
  var notice = document.getElementById('popup-notice'), preview = document.getElementById('popup-preview'), resultBox = document.getElementById('popup-result');
  var scope = document.getElementById('popup-scope'), workspace = document.getElementById('popup-workspace');
  document.querySelectorAll('button[id], input[id], select[id]').forEach(function(element) { element.dataset.focusKey = 'popup-' + element.id; });
  var currentControls = ['current-suspend', 'current-restore', 'apply-snooze', 'end-snooze', 'apply-protection', 'end-protection', 'whitelist-page', 'whitelist-domain', 'remove-whitelist'];
  currentControls.forEach(function(id) { document.getElementById(id).disabled = true; });
  document.getElementById('popup-private-info').hidden = !privateContext;
  if (privateContext) {
    document.getElementById('popup-snooze').disabled = true;
    document.getElementById('popup-protection').disabled = true;
    document.getElementById('popup-search').disabled = true;
    document.querySelector('#popup-search-form button').disabled = true;
    document.getElementById('manage-workspaces').disabled = true;
    document.getElementById('open-dashboard').disabled = true;
    scope.querySelector('option[value="all"]').textContent = 'All private windows';
    document.querySelector('.undo-help').textContent = 'Private tab actions are not recorded for undo.';
  }
  function say(text, kind) { C.notice(notice, text, kind); }
  function failed(error) { say(error.message || String(error), 'error'); }
  function title(row) { return row.title || row.originalUrl || row.url || 'Untitled tab'; }
  function scopeRows() {
    if (!data) return [];
    if (scope.value === 'selected') return data.tabs.filter(function(row) { return highlighted.includes(row.id); });
    if (scope.value === 'window') return data.tabs.filter(function(row) { return row.windowId === (rawCurrent && rawCurrent.windowId || data.focusedWindowId) && (!current || row.id !== current.id); });
    return data.tabs;
  }
  function refreshScope() {
    var rows = scopeRows();
    document.getElementById('scope-count').textContent = rows.length + ' tabs; ' + rows.filter(function(row) { return !row.asleep; }).length + ' awake. ' + (privateContext ? 'Original suspension preferences and private-only eligibility checks apply.' : 'Draft, audio, active, pinned, snooze and meeting safeguards remain on.');
    document.getElementById('bulk-suspend').disabled = !rows.length || busy;
    document.getElementById('bulk-restore').disabled = !rows.length || busy;
  }
  function render() {
    C.theme(data.settings.theme);
    document.getElementById('current-tab-title').textContent = current ? title(current) : rawCurrent ? title(rawCurrent) : 'No current browser tab';
    document.getElementById('current-tab-title').title = current ? title(current) : rawCurrent ? title(rawCurrent) : '';
    document.getElementById('current-tab-url').textContent = current ? current.originalUrl || current.url : rawCurrent ? rawCurrent.url || '' : '';
    document.getElementById('current-state').textContent = current ? current.status : 'Browser page';
    document.getElementById('current-state').className = 'row-state ' + (current ? current.status : '');
    var reasons = current ? (current.protectionReasons || []).slice() : ['Browser and extension pages cannot be suspended.'];
    if (current && current.snooze) reasons.push('Snoozed: ' + C.expiry(current.snooze));
    if (current && current.protection) reasons.push(current.protection.kind + ': ' + C.expiry(current.protection));
    document.getElementById('current-protection').textContent = reasons.length ? reasons.join('; ') : 'No additional protection is active. Safety is checked before suspension.';
    currentControls.forEach(function(id) { document.getElementById(id).disabled = !current || busy || privateContext && privateUnavailable.includes(id); });
    document.getElementById('current-suspend').hidden = !!(current && current.asleep);
    document.getElementById('current-restore').hidden = !current || !current.asleep;
    document.getElementById('end-snooze').disabled = privateContext || !current || !current.snooze || busy;
    document.getElementById('end-protection').disabled = privateContext || !current || !current.protection || busy;
    document.getElementById('remove-whitelist').hidden = !whitelisted;
    var signature = JSON.stringify(data.workspaces.map(function(item) { return [item.id, item.name]; }));
    if (workspace.dataset.signature !== signature) {
      var existing = workspace.value;
      workspace.replaceChildren(n('option', { value: '', text: data.workspaces.length ? 'Choose a workspace' : 'No workspaces yet' }));
      data.workspaces.forEach(function(item) { workspace.appendChild(n('option', { value: item.id, text: item.name })); });
      if (data.workspaces.some(function(item) { return item.id === existing; })) workspace.value = existing;
      else if (data.currentWorkspaceId) workspace.value = data.currentWorkspaceId;
      workspace.dataset.signature = signature;
    }
    workspace.disabled = privateContext;
    document.getElementById('switch-workspace').disabled = privateContext || !workspace.value || busy;
    document.getElementById('popup-undo').disabled = privateContext || !data.undo || busy;
    refreshScope();
  }
  async function refresh() {
    if (busy || loading) { refreshAgain = true; return; }
    loading = true;
    document.getElementById('popup-refresh').disabled = true;
    try {
      var response;
      if (privateContext) {
        response = await Promise.all([C.request('view.get'), C.request('legacy.private.view')]);
        data = response[0];
        data.tabs = response[1].tabs; data.legacySettings = response[1].legacySettings;
        data.focusedTabId = response[1].focusedTabId; data.focusedWindowId = response[1].focusedWindowId;
        rawCurrent = response[1].focusedTab; highlighted = response[1].highlightedTabIds;
      } else {
        response = await Promise.all([C.request('view.get'), C.api(chrome.tabs, 'query', [{ active: true, lastFocusedWindow: true }]), C.api(chrome.tabs, 'query', [{ highlighted: true, lastFocusedWindow: true }])]);
        data = response[0]; rawCurrent = response[1][0] || null; highlighted = response[2].map(function(row) { return row.id; });
      }
      current = data.tabs.find(function(row) { return rawCurrent && row.id === rawCurrent.id; }) || null;
      whitelisted = current ? (await C.request('legacy.whitelist.check', { url: current.originalUrl || current.url })).matches : false;
      if (loadError) { say(''); loadError = false; }
      render();
    } catch (error) { loadError = true; failed(error); }
    finally { loading = false; document.getElementById('popup-refresh').disabled = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
  }
  async function run(command, payload, trigger, fallback) {
    if (busy) return say('Wait for the current action to finish.');
    var focus = legacyUi.focusKey(trigger);
    busy = true; trigger.disabled = true; trigger.setAttribute('aria-busy', 'true');
    say('Working locally…');
    try {
      var result = await C.request(command, payload);
      C.renderResult(resultBox, result, fallback);
      say(C.resultText(result, fallback), 'success');
      return result;
    } catch (error) { failed(error); return null; }
    finally { busy = false; trigger.disabled = false; trigger.removeAttribute('aria-busy'); await refresh(); if (document.activeElement === document.body) legacyUi.restoreFocus(focus); }
  }
  async function open(path) {
    try { await C.openPage(path); window.close(); } catch (error) { failed(error); }
  }
  function skippedList(rows) {
    return n('ul', { class: 'reason-list' }, (rows || []).map(function(row) { return n('li', {}, [n('strong', { text: title(row) }), n('span', { text: (row.reasons || [row.reason || 'Unavailable']).join(', ') })]); }));
  }
  async function actionPreview(action, rows, allowActive, trigger) {
    if (!rows.length) return say('No eligible browser tabs are in this scope.', 'error');
    if (busy) return say('Wait for the current action to finish.');
    trigger.disabled = true;
    var ids = rows.map(function(row) { return row.id; });
    try {
      var options = { allowActive: !!allowActive, reason: 'popup' };
      var plan = await C.request(privateContext ? 'legacy.private.preview' : 'action.preview', { action: action, tabIds: ids, options: options });
      var eligible = plan.eligible || [], skipped = plan.skipped || [];
      previewTriggerKey = legacyUi.focusKey(trigger);
      var verb = action === 'suspend' ? 'Suspend' : 'Restore';
      preview.replaceChildren(n('h2', { text: verb + ' preview' }), n('p', { text: eligible.length + ' eligible; ' + skipped.length + ' skipped. Eligibility is checked again when the action runs.' }));
      if (eligible.length) preview.appendChild(n('details', {}, [n('summary', { text: 'Eligible tabs' }), n('ul', { class: 'record-tabs' }, eligible.map(function(row) { return n('li', { text: title(row) }); }))]));
      if (skipped.length) preview.appendChild(skippedList(skipped));
      options.expectedTabs = eligible.concat(skipped).map(function(row) { return { id: row.id, uid: row.uid, originalUrl: row.originalUrl }; });
      preview.appendChild(n('div', { class: 'button-row' }, [b(verb + ' ' + eligible.length + ' tabs', async function(event) {
        var result = await run(privateContext ? 'legacy.private.run' : 'action.run', { action: action, tabIds: ids, options: options }, event.currentTarget, verb + ' completed.');
        if (result) { preview.hidden = true; legacyUi.restoreFocus(previewTriggerKey); }
      }, { class: 'primary', disabled: !eligible.length, 'data-focus-key': 'popup-preview-run' }), b('Cancel', function() { preview.hidden = true; legacyUi.restoreFocus(previewTriggerKey); }, { 'data-focus-key': 'popup-preview-cancel' })]));
      preview.hidden = false;
    } catch (error) { failed(error); }
    finally { if (!busy) render(); if (document.activeElement === document.body) legacyUi.restoreFocus(legacyUi.focusKey(trigger)); }
  }
  async function switchPreview(trigger) {
    if (!workspace.value) return say('Choose a workspace first.', 'error');
    var target = data.workspaces.find(function(item) { return item.id === workspace.value; });
    var ids = data.tabs.filter(function(row) { return row.workspaceId && row.workspaceId !== target.id && !row.asleep; }).map(function(row) { return row.id; });
    trigger.disabled = true;
    try {
      var plan = await C.request('action.preview', { action: 'suspend', tabIds: ids, options: { allowActive: true, reason: 'workspace-switch' } });
      previewTriggerKey = legacyUi.focusKey(trigger);
      preview.replaceChildren(n('h2', { text: 'Switch to ' + target.name }), n('p', { text: 'Restore this workspace first, then safely suspend eligible tabs in the other workspaces. ' + (plan.eligible || []).length + ' can sleep; ' + (plan.skipped || []).length + ' protected tabs will stay awake.' }), skippedList(plan.skipped));
      preview.appendChild(n('div', { class: 'button-row' }, [b('Switch workspace', async function(event) { var result = await run('workspace.switch', { id: target.id }, event.currentTarget, 'Workspace switched.'); if (result) { preview.hidden = true; legacyUi.restoreFocus(previewTriggerKey); } }, { class: 'primary', 'data-focus-key': 'popup-preview-run' }), b('Cancel', function() { preview.hidden = true; legacyUi.restoreFocus(previewTriggerKey); }, { 'data-focus-key': 'popup-preview-cancel' })]));
      preview.hidden = false;
    } catch (error) { failed(error); }
    finally { render(); if (document.activeElement === document.body) legacyUi.restoreFocus(legacyUi.focusKey(trigger)); }
  }
  async function whitelist(mode, trigger) {
    if (!current) return;
    var url = current.originalUrl || current.url;
    var lines = (data.legacySettings.gsWhitelist || '').split(/\s+/).filter(Boolean);
    if (mode === 'remove') {
      await run('legacy.whitelist.remove', { url: url }, trigger, 'Matching exclusions removed.');
      return;
    } else {
      var value = url;
      if (mode === 'domain') { try { value = new URL(url).hostname; } catch (error) { return failed(error); } }
      if (!value) return say('This tab has no website hostname. Add its URL from Settings instead.', 'error');
      if (!lines.includes(value)) lines.push(value);
    }
    await run('legacy.update', { settings: { gsWhitelist: lines.join('\n') } }, trigger, mode === 'remove' ? 'Matching exclusions removed.' : 'Never-suspend list updated.');
  }
  function on(id, handler) { document.getElementById(id).addEventListener('click', handler); }
  on('current-suspend', function(event) { actionPreview('suspend', current ? [current] : [], true, event.currentTarget); });
  on('current-restore', function(event) { actionPreview('restore', current ? [current] : [], false, event.currentTarget); });
  on('bulk-suspend', function(event) { actionPreview('suspend', scopeRows(), false, event.currentTarget); });
  on('bulk-restore', function(event) { actionPreview('restore', scopeRows(), false, event.currentTarget); });
  on('apply-snooze', function(event) {
    if (!current) return;
    var value = document.getElementById('popup-snooze').value, payload = { tabIds: [current.id] };
    if (['tomorrow', 'restart'].includes(value)) payload.mode = value; else payload.minutes = Number(value);
    run('snooze.set', payload, event.currentTarget, 'Current tab snoozed.');
  });
  on('end-snooze', function(event) { if (current) run('snooze.clear', { tabIds: [current.id] }, event.currentTarget, 'Snooze ended.'); });
  on('apply-protection', function(event) { if (current) run('protection.set', { tabIds: [current.id], kind: document.getElementById('popup-protection').value, minutes: 60 }, event.currentTarget, 'Current tab protected for one hour.'); });
  on('end-protection', function(event) { if (current) run('protection.clear', { tabIds: [current.id] }, event.currentTarget, 'Protection ended.'); });
  on('whitelist-page', function(event) { whitelist('page', event.currentTarget); });
  on('whitelist-domain', function(event) { whitelist('domain', event.currentTarget); });
  on('remove-whitelist', function(event) { whitelist('remove', event.currentTarget); });
  on('popup-undo', function(event) { run('action.undo', {}, event.currentTarget, 'Action undone. Unsaved application state is not restored.'); });
  on('popup-refresh', refresh);
  on('switch-workspace', function(event) { switchPreview(event.currentTarget); });
  on('manage-workspaces', function() { open('dashboard.html?view=workspaces'); });
  on('open-dashboard', function() { open('dashboard.html'); });
  on('open-settings', function() { open('options.html'); });
  document.getElementById('brand-link').addEventListener('click', function(event) { event.preventDefault(); open(privateContext ? 'options.html' : 'dashboard.html'); });
  scope.addEventListener('change', refreshScope);
  workspace.addEventListener('change', function() { document.getElementById('switch-workspace').disabled = privateContext || !workspace.value; });
  var search = document.getElementById('popup-search');
  document.getElementById('popup-search-form').addEventListener('submit', function(event) { event.preventDefault(); open('dashboard.html?view=tabs&q=' + encodeURIComponent(search.value)); });
  document.addEventListener('keydown', function(event) { C.searchKeys(event, search); if (event.key === 'Escape' && !preview.hidden) { event.preventDefault(); preview.hidden = true; legacyUi.restoreFocus(previewTriggerKey); } });
  C.subscribe(refresh);
  refresh();
})();
