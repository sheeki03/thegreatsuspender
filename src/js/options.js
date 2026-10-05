/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient, n = C.node, b = C.button;
  var content = document.getElementById('settings-content'), notice = document.getElementById('settings-notice');
  var data = null, legacyInfo = null, loading = false, built = false;
  var forms = [], memoryStatus = null, memoryResult = null;
  var suspendOptions = [['0', 'Never'], ['0.33', '20 seconds'], ['1', '1 minute'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['360', '6 hours'], ['720', '12 hours'], ['1440', '1 day'], ['2880', '2 days'], ['4320', '3 days'], ['10080', '1 week'], ['20160', '2 weeks']];

  function say(text, kind) { C.notice(notice, text, kind); }
  function error(err) { say(err.message || String(err), 'error'); }
  function managed(key) {
    return !!(legacyInfo && legacyInfo.managedKeys.includes(key));
  }
  function createInput(descriptor, value) {
    var input;
    if (descriptor.type === 'select') input = C.select(descriptor.options, value);
    else if (descriptor.type === 'textarea') input = n('textarea', { rows: descriptor.rows || 7, value: value || '', spellcheck: 'false' });
    else if (descriptor.type === 'checkbox') input = n('input', { type: 'checkbox', checked: !!value });
    else input = n('input', { type: descriptor.type || 'number', value: value == null ? '' : value, min: descriptor.min === undefined ? '1' : descriptor.min, max: descriptor.max, step: descriptor.step || '1' });
    input.id = descriptor.id || descriptor.key;
    input.dataset.setting = descriptor.key;
    input.dataset.valueType = descriptor.type === 'checkbox' ? 'boolean' : descriptor.type === 'select' || descriptor.type === 'textarea' || descriptor.type === 'text' ? 'string' : 'number';
    input.dataset.focusKey = 'setting-' + input.id;
    return input;
  }
  function readValue(input) {
    if (input.dataset.valueType === 'boolean') return input.checked;
    if (input.dataset.valueType === 'number') return Number(input.value);
    return input.value;
  }
  function populate(form) {
    if (form.dataset.dirty === 'true' || form.contains(document.activeElement)) return;
    var source = form.dataset.source === 'legacy' ? data.legacySettings : data.settings;
    Array.from(form.querySelectorAll('[data-setting]')).forEach(function(input) {
      var value = source[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = !!value;
      else if (value !== undefined && value !== null) {
        if (input.tagName === 'SELECT' && !Array.from(input.options).some(function(option) { return option.value === String(value); })) input.appendChild(n('option', { value: value, text: 'Current: ' + value }));
        input.value = value;
      }
    });
  }
  function addSection(id, title, description, source, descriptors, options) {
    options = options || {};
    var section = n('section', { class: 'settings-section', id: id }, [n('h2', { text: title }), n('p', { text: description })]);
    var form = n('form', { 'data-source': source });
    var editRevision = 0;
    var grid = n('div', { class: 'form-grid' });
    var values = source === 'legacy' ? data.legacySettings : data.settings;
    descriptors.forEach(function(descriptor) {
      var input = createInput(descriptor, values[descriptor.key]);
      var help = descriptor.help || '';
      if (source === 'legacy' && managed(descriptor.key)) { input.disabled = true; help = (help ? help + ' ' : '') + 'Managed by your organization.'; }
      if (legacyInfo.incognito && ['gsSyncSettings', 'gsAddContextMenu'].includes(descriptor.key)) { input.disabled = true; help = 'Unavailable in an incognito extension context.'; }
      var field = descriptor.type === 'checkbox' ? C.check(descriptor.label, input, help) : C.field(descriptor.label, input, help);
      if (descriptor.full) field.classList.add('full-width');
      grid.appendChild(field);
    });
    var status = n('span', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    var submit = n('button', { type: 'submit', class: 'primary', text: 'Save ' + title.toLowerCase() });
    submit.dataset.focusKey = 'save-settings-' + id;
    form.append(grid, n('div', { class: 'save-row' }, [submit, status]));
    form.addEventListener('input', function() { editRevision++; form.dataset.dirty = 'true'; status.textContent = 'Unsaved changes'; });
    form.addEventListener('change', function() { editRevision++; form.dataset.dirty = 'true'; status.textContent = 'Unsaved changes'; if (options.onChange) options.onChange(form); });
    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      var submittedRevision = editRevision, settings = {};
      Array.from(form.querySelectorAll('[data-setting]')).forEach(function(input) { if (!input.disabled) settings[input.dataset.setting] = readValue(input); });
      if (!Object.keys(settings).length) { status.textContent = 'These settings are managed.'; return; }
      if (source !== 'legacy') {
        var effectiveLimit = settings.awakeLimit === undefined ? data.settings.awakeLimit : settings.awakeLimit;
        var effectiveTarget = settings.awakeTarget === undefined ? data.settings.awakeTarget : settings.awakeTarget;
        if (effectiveTarget >= effectiveLimit) { status.textContent = 'Target must be lower than the awake-tab limit.'; status.classList.add('error-text'); var targetInput = form.querySelector('[data-setting="awakeTarget"]'); if (targetInput) targetInput.focus(); return; }
      }
      if (source === 'legacy' && settings.gsSyncSettings && !data.legacySettings.gsSyncSettings) {
        if (!await C.confirm({ title: 'Enable legacy preference sync?', text: 'This can overwrite legacy settings on other browsers using the same browser account. New workbench data is never synced.', accept: 'Enable sync' })) return;
      }
      status.classList.remove('error-text');
      var focus = legacyUi.focusKey(submit);
      submit.disabled = true; status.textContent = 'Saving…';
      try {
        await C.request(source === 'legacy' ? 'legacy.update' : 'settings.update', { settings: settings });
        var newerEdits = editRevision !== submittedRevision;
        form.dataset.dirty = newerEdits ? 'true' : 'false'; status.textContent = newerEdits ? 'Saved; newer changes are unsaved' : 'Saved';
        if (settings.theme) C.theme(settings.theme);
        await refresh();
      } catch (err) { status.textContent = err.message || String(err); status.classList.add('error-text'); }
      finally { submit.disabled = false; if (document.activeElement === document.body) legacyUi.restoreFocus(focus); }
    });
    section.appendChild(form); content.appendChild(section); forms.push(form);
    if (options.extra) options.extra(section, form);
    if (options.onChange) options.onChange(form);
    return section;
  }
  function build() {
    content.replaceChildren(); forms = [];
    addSection('suspension', 'Automatic suspension', 'These are the original suspension preferences. Workspaces can inherit or override them. Workbench bulk actions always keep real drafts, audio, meetings and snoozes safe.', 'legacy', [
      { key: 'gsTimeToSuspend', id: 'timeToSuspend', type: 'select', options: suspendOptions, label: 'Suspend an inactive tab after' },
      { key: 'gsDontSuspendPinned', id: 'dontSuspendPinned', type: 'checkbox', label: 'Never automatically suspend pinned tabs' },
      { key: 'gsDontSuspendForms', id: 'dontSuspendForms', type: 'checkbox', label: 'Never automatically suspend tabs with unsaved form input' },
      { key: 'gsDontSuspendAudio', id: 'dontSuspendAudio', type: 'checkbox', label: 'Never automatically suspend tabs playing audio' },
      { key: 'gsDontSuspendActiveTabs', id: 'dontSuspendActiveTabs', type: 'checkbox', label: 'Never automatically suspend the active tab in each window' },
      { key: 'onlineCheck', type: 'checkbox', label: 'Never automatically suspend while offline' },
      { key: 'batteryCheck', type: 'checkbox', label: 'Never automatically suspend while connected to power' }
    ]);
    addSection('counts', 'Awake-tab limit', 'When the awake count exceeds the limit, eligible tabs sleep oldest-first until the target is reached. Protected tabs stay awake, so the final count may remain above target.', 'workbench', [
      { key: 'countEnabled', type: 'checkbox', label: 'Enable awake-tab count policy', full: true },
      { key: 'awakeLimit', label: 'Suspend when awake count exceeds', min: '1', max: '100000' },
      { key: 'awakeTarget', label: 'Suspend down to awake count', min: '1', max: '100000' }
    ], { extra: function(section) {
      var result = n('div', { class: 'operation-result', role: 'status', hidden: true });
      section.append(b('Enforce saved policy now', async function(event) {
        var trigger = event.currentTarget; trigger.disabled = true;
        try { var outcome = await C.request('counts.enforce'); C.renderResult(result, outcome, 'Saved awake-tab policy checked.'); await refresh(); }
        catch (err) { error(err); } finally { trigger.disabled = false; }
      }), result, n('a', { class: 'button-link', href: 'dashboard.html?view=insights', text: 'See measured policy results' }));
    } });
    addSection('exclusions', 'Never-suspend list', 'One URL, domain fragment or /regular expression/ per line. Matching uses the original extension rules.', 'legacy', [
      { key: 'gsWhitelist', id: 'whitelist', type: 'textarea', label: 'Excluded URLs and sites', help: 'Examples: https://mail.google.com, example.com, /^https:.*example\\.com/', full: true }
    ], { extra: function(section, form) {
      var result = n('div', { class: 'operation-result', hidden: true, role: 'status' });
      section.append(b('Test list against open tabs', async function() {
        try {
          var whitelist = form.querySelector('textarea').value;
          var matches = (await C.request('legacy.whitelist.test', { whitelist: whitelist })).tabs;
          result.replaceChildren(n('p', { text: matches.length + ' matching open tabs. This tests the entered list; use Save to apply unsaved changes.' }));
          if (matches.length) result.appendChild(n('ul', { class: 'reason-list' }, matches.map(function(row) { return n('li', { text: (row.title || 'Untitled tab') + ' — ' + (row.originalUrl || row.url) }); })));
          result.hidden = false;
        } catch (err) { error(err); }
      }), result);
    } });
    addSection('appearance', 'Workbench appearance', 'Popup, dashboard and settings use the same theme. The suspended-page theme remains separately configurable below.', 'workbench', [
      { key: 'theme', id: 'workbenchTheme', type: 'select', label: 'Workbench theme', options: [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']] }
    ]);
    addSection('screenshots', 'Suspended pages & screenshots', 'Preserves the original suspended page and screenshot controls. Screenshots may increase suspension time and resource use.', 'legacy', [
      { key: 'gsTheme', id: 'theme', type: 'select', label: 'Suspended-page theme', options: [['light', 'Light'], ['dark', 'Dark']] },
      { key: 'screenCapture', id: 'preview', type: 'select', label: 'Screen capture', options: [['0', 'Disabled'], ['1', 'Visible screen only'], ['2', 'Entire page']] },
      { key: 'screenCaptureForce', id: 'forceScreenCapture', type: 'checkbox', label: 'Enable high-quality screen capture', help: 'Removes the original capture quality, timeout and height limits; can increase CPU and memory use.' },
      { key: 'cleanScreencaps', id: 'cleanScreenCaptures', type: 'checkbox', label: 'Clean screen captures', help: 'Preserves the original advertisement-blocking capture option and its host blocklist behavior.' },
      { key: 'discardAfterSuspend', type: 'checkbox', label: 'Also apply browser tab discarding after suspension', help: 'May add a rendering delay when selecting the suspended tab.' }
    ]);
    addSection('restoration', 'Restoration', 'A measured queue for restoring archives, snapshots and workspaces. Lower concurrency and a longer delay reduce simultaneous page loads.', 'workbench', [
      { key: 'restoreConcurrency', label: 'Concurrent tab restores', min: '1', max: '10' },
      { key: 'restoreDelayMs', label: 'Delay between restores (milliseconds)', min: '0', max: '10000', step: '1' }
    ]);
    addSection('focus-restoration', 'Original restore behavior', 'The original focus and cache preferences still apply to suspended pages.', 'legacy', [
      { key: 'gsUnsuspendOnFocus', id: 'unsuspendOnFocus', type: 'checkbox', label: 'Automatically restore a suspended tab when it is viewed' },
      { key: 'gsIgnoreCache', id: 'ignoreCache', type: 'checkbox', label: 'Bypass browser cache when restoring', help: 'Requests fresh content rather than reusing the browser cache.' }
    ]);
    addSection('snapshots', 'Scheduled snapshots', 'Real local snapshots are checked each minute. Retention applies to saved snapshots; these are URL and organization records, not page backups.', 'workbench', [
      { key: 'snapshotEnabled', type: 'checkbox', label: 'Enable scheduled local snapshots', full: true },
      { key: 'snapshotIntervalMinutes', label: 'Snapshot interval (minutes)', min: '1', max: '525600' },
      { key: 'snapshotKeep', label: 'Snapshots to retain', min: '1', max: '1000' }
    ], { extra: function(section) { section.appendChild(n('a', { class: 'button-link', href: 'dashboard.html?view=snapshots', text: 'Save, compare & restore snapshots' })); } });
    addSection('startup', 'Browser startup', 'Runs on an actual browser startup, not when the extension or this page reloads. Workspace switching keeps protected work open.', 'workbench', [
      { key: 'startupPolicy', type: 'select', label: 'When the browser starts', options: [['leave', 'Leave tabs exactly as they are'], ['current', 'Restore current workspace; safely hibernate the others'], ['choose', 'Open the workspace chooser without waking tabs']], full: true }
    ], { extra: function(section) { section.appendChild(n('a', { class: 'button-link', href: 'dashboard.html?view=workspaces', text: 'Choose current workspace' })); } });
    addSection('review', 'Review & activity', 'Neglected-tab recommendations use the last recorded foreground view, or creation time. Nothing is closed just for being old. Activity measures focused, non-idle browser time, not attention.', 'workbench', [
      { key: 'neglectedDays', label: 'Recommend review after this many days', min: '1', max: '3650' }
    ], { extra: function(section) { section.append(n('a', { class: 'button-link', href: 'dashboard.html?view=neglected', text: 'Review neglected tabs' }), n('a', { class: 'button-link', href: 'dashboard.html?view=insights', text: 'View local activity & metrics' })); } });
    buildMemory();
    addSection('browser', 'Browser integration', 'These original browser preferences remain available. New tab metadata and activity are local-only.', 'legacy', [
      { key: 'gsAddContextMenu', id: 'addContextMenu', type: 'checkbox', label: 'Enable right-click context menu actions' },
      { key: 'gsSyncSettings', id: 'syncSettings', type: 'checkbox', label: 'Sync legacy preferences using the browser account', help: 'Enabling can overwrite settings on other signed-in browsers. Does not sync workbench data.' },
      { key: 'suspendInPlaceOfDiscard', type: 'checkbox', label: 'Suspend tabs when the browser would otherwise discard them', help: 'The original low-memory behavior. This can suspend earlier than your inactivity timer and is separate from the optional native helper.' }
    ]);
    built = true;
    requestAnimationFrame(function() {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView({ block: 'start' });
    });
  }
  function buildMemory() {
    var section = n('section', { class: 'settings-section', id: 'memory' }, [n('h2', { text: 'Optional macOS memory helper' }), n('p', { text: 'Off by default. An optional local native host reads macOS memory pressure using sysctl. While enabled, the extension checks each minute and safely suspends oldest eligible tabs when your chosen threshold is reached. It never estimates RAM savings.' })]);
    memoryStatus = n('div', { class: 'notice', role: 'status', 'aria-live': 'polite' });
    memoryResult = n('div', { class: 'operation-result', hidden: true });
    var settings = data.settings.memory;
    var enabled = n('input', { type: 'checkbox', checked: settings.enabled, id: 'memory-enabled', 'data-focus-key': 'memory-enabled' });
    var level = C.select([['warning', 'Warning or critical pressure'], ['critical', 'Critical pressure only']], settings.level, { id: 'memory-level', 'data-focus-key': 'memory-level' });
    var target = n('input', { type: 'number', min: '1', max: '10000', step: '1', value: settings.target, id: 'memory-target', 'data-focus-key': 'memory-target' });
    var save = n('button', { type: 'submit', class: 'primary', text: 'Save memory helper settings', 'data-focus-key': 'memory-save' });
    var form = n('form', {}, [n('div', { class: 'form-grid' }, [C.check('Enable automatic pressure-based suspension', enabled, 'Requires the separately installed macOS helper.'), C.field('Pressure threshold', level), C.field('Target awake tabs under pressure', target)]), n('div', { class: 'button-row' }, [save, b('Check pressure now', function(event) { memoryCommand('memory.check', {}, event.currentTarget); }, { 'data-focus-key': 'memory-check' }), b('Disable & disconnect', function(event) { memoryCommand('memory.disconnect', {}, event.currentTarget); }, { 'data-focus-key': 'memory-disconnect' })])]);
    form.addEventListener('submit', function(event) { event.preventDefault(); memoryCommand('memory.configure', { enabled: enabled.checked, level: level.value, target: Number(target.value) }, save); });
    var extensionId = chrome.runtime.id;
    var command = './native/install-host.sh --extension-id ' + extensionId;
    var install = n('details', {}, [n('summary', { text: 'Install or remove the optional helper' }), n('p', { text: 'macOS only. In Terminal, from the extension source folder containing native/install-host.sh, run the command below. It compiles the Swift host using Apple’s command-line tools and registers it for this extension ID. This page does not install anything automatically.' }), n('p', { class: 'muted', text: 'Installed extension ID: ' + extensionId }), n('code', { class: 'native-command', text: command }), b('Copy install command', async function() {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard access is unavailable. Select and copy the command manually.');
        await navigator.clipboard.writeText(command); say('Install command copied.', 'success');
      } catch (err) { error(err); }
    }), n('p', { class: 'muted', text: 'On macOS, the installer defaults to $HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts, where Brave looks up user-level native hosts. --user-data-dir does not change that lookup. Optional --browser-dir selects a host-registration base or NativeMessagingHosts directory—not a browser profile—and only changes where the installer writes files; it does not redirect Brave. The helper receives no tab titles, URLs or page values.' })]);
    var uninstallCommand = command.replace('/install-host.sh', '/uninstall-host.sh');
    install.append(n('h3', { text: 'Remove an installed helper' }), n('p', { text: 'Use Disable & disconnect first, then run this command from the same source folder. For a custom install, use the exact host-registration --browser-dir and helper --install-dir passed during installation. Removal verifies the extension ID and host path and does not remove browser profile data.' }), n('code', { class: 'native-command', text: uninstallCommand }), b('Copy removal command', async function() {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard access is unavailable. Select and copy the command manually.');
        await navigator.clipboard.writeText(uninstallCommand); say('Removal command copied.', 'success');
      } catch (err) { error(err); }
    }));
    section.append(memoryStatus, form, memoryResult, install); content.appendChild(section);
    var controls = { form: form, enabled: enabled, level: level, target: target, editRevision: 0 };
    section._memoryForm = controls;
    form.addEventListener('input', function() { controls.editRevision++; form.dataset.dirty = 'true'; });
    form.addEventListener('change', function() { controls.editRevision++; form.dataset.dirty = 'true'; });
  }
  async function memoryCommand(command, payload, trigger) {
    var focus = legacyUi.focusKey(trigger);
    var controls = document.getElementById('memory')._memoryForm, submittedRevision = controls.editRevision;
    trigger.disabled = true;
    try {
      var result = await C.request(command, payload);
      var newerEdits = command === 'memory.configure' && controls.editRevision !== submittedRevision;
      if (command === 'memory.configure') controls.form.dataset.dirty = newerEdits ? 'true' : 'false';
      C.renderResult(memoryResult, result, command === 'memory.check' ? 'Memory pressure checked using the installed native host.' : newerEdits ? 'Submitted memory helper settings saved; newer changes are unsaved.' : 'Memory helper settings updated.');
      await refresh();
    } catch (err) {
      memoryResult.replaceChildren(n('p', { class: 'error-text', text: err.message || String(err) }));
      memoryResult.hidden = false;
      await refresh();
    }
    finally { trigger.disabled = false; if (document.activeElement === document.body) legacyUi.restoreFocus(focus); }
  }
  function updateMemory() {
    if (!memoryStatus) return;
    var memory = data.memory || {};
    var text = (data.settings.memory.enabled ? 'Automation enabled' : 'Automation disabled') + '. Helper ' + (memory.connected ? 'connected' : 'not connected') + '. Pressure: ' + (memory.level || 'unknown') + (memory.rawLevel == null ? '' : ' (macOS value ' + memory.rawLevel + ')') + (memory.checkedAt ? '. Last checked ' + C.date(memory.checkedAt) + '.' : '. No reading yet.');
    if (memory.error) text += ' ' + memory.error;
    C.notice(memoryStatus, text, memory.error ? 'error' : '');
    var controls = document.getElementById('memory')._memoryForm;
    if (controls.form.dataset.dirty !== 'true' && !controls.form.contains(document.activeElement)) {
      controls.enabled.checked = data.settings.memory.enabled; controls.level.value = data.settings.memory.level; controls.target.value = data.settings.memory.target;
    }
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      var response = await Promise.all([C.request('view.get'), C.request('legacy.settings.get')]);
      data = response[0]; legacyInfo = response[1]; data.legacySettings = legacyInfo.settings;
      C.theme(data.settings.theme);
      if (!built) build();
      else forms.forEach(populate);
      updateMemory();
      if (legacyInfo.incognito) say('Workbench excludes incognito tabs and does not record incognito activity. Some legacy preferences are unavailable in this context.');
    } catch (err) {
      error(err);
      if (!built) content.replaceChildren(n('div', { class: 'empty-state' }, [n('h2', { text: 'Could not load settings' }), n('p', { text: 'Your settings have not been changed.' }), b('Retry loading settings', refresh)]));
    } finally { loading = false; content.setAttribute('aria-busy', 'false'); }
  }
  if (new URL(location.href).searchParams.has('firstTime')) {
    document.getElementById('settings-title').textContent = 'Welcome to The Great Suspender';
    say('Your existing suspension controls are here. Open the workbench to organize tabs, review safety previews and save local sessions.');
  }
  C.subscribe(refresh);
  window.addEventListener('focus', refresh);
  refresh();
})();
