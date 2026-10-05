/* global workbenchClient */
(function() {
  'use strict';
  var C = workbenchClient, n = C.node;
  var TIMER = [['0.33', '20 seconds'], ['1', '1 minute'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['360', '6 hours'], ['720', '12 hours'], ['1440', '1 day'], ['2880', '2 days'], ['4320', '3 days'], ['10080', '1 week'], ['20160', '2 weeks'], ['0', 'Never (only when I ask)']];
  var screenshotsOn = function(values) { return values.legacy.screenCapture !== '0'; };
  var SECTIONS = [
    { id: 'suspension', title: 'Automatic suspension', text: 'Tabs you haven’t used for a while go to sleep to free up memory. Click a sleeping tab to wake it.', settings: [
      { key: 'gsTimeToSuspend', type: 'select', options: TIMER, label: 'Suspend tabs I haven’t used for' },
      { key: 'gsDontSuspendPinned', type: 'switch', label: 'Keep pinned tabs awake' },
      { key: 'gsDontSuspendForms', type: 'switch', label: 'Keep tabs with unsaved typing awake', help: 'Applies when a page sees you type something. You can still suspend these tabs yourself.' },
      { key: 'gsDontSuspendAudio', type: 'switch', label: 'Keep tabs playing audio awake' },
      { key: 'gsDontSuspendActiveTabs', type: 'switch', label: 'Keep the tab you’re viewing in each window awake' },
      { key: 'onlineCheck', type: 'switch', label: 'Don’t suspend while offline', help: 'A sleeping tab needs a connection to load again.' },
      { key: 'batteryCheck', type: 'switch', label: 'Don’t suspend while plugged in' }
    ] },
    { id: 'sites', title: 'Sites that stay awake', text: 'Tabs from these sites are never suspended automatically. You can also add the current site from the toolbar popup.', settings: [
      { key: 'gsWhitelist', type: 'textarea', label: 'One site or address per line', help: 'For example mail.google.com, or example.com/dashboard. Advanced: a /regular expression/.' }
    ], extra: whitelistTest },
    { id: 'limit', title: 'Tab limit', text: 'When too many tabs are awake, the ones you used least recently go to sleep.', settings: [
      { key: 'countEnabled', source: 'workbench', type: 'switch', label: 'Limit how many tabs stay awake' },
      { key: 'awakeLimit', source: 'workbench', type: 'number', min: 2, max: 10000, label: 'Most tabs awake at once', when: function(values) { return values.workbench.countEnabled; } },
      { key: 'awakeTarget', source: 'workbench', type: 'number', min: 1, max: 9999, label: 'Then put tabs to sleep until this many are awake', help: 'Leaves room so the limit doesn’t kick in again right away.', when: function(values) { return values.workbench.countEnabled; } }
    ], extra: enforceButton },
    { id: 'snapshots', title: 'Snapshots', text: 'A snapshot is a saved list of your open tabs, so you can reopen them after a crash or a clean-up.', settings: [
      { key: 'snapshotEnabled', source: 'workbench', type: 'switch', label: 'Save snapshots automatically' },
      { key: 'snapshotIntervalMinutes', source: 'workbench', type: 'select', number: true, options: [['60', 'Every hour'], ['240', 'Every 4 hours'], ['720', 'Every 12 hours'], ['1440', 'Every day'], ['10080', 'Every week']], label: 'How often', when: function(values) { return values.workbench.snapshotEnabled; } },
      { key: 'snapshotKeep', source: 'workbench', type: 'number', min: 1, max: 100, label: 'How many to keep', help: 'Older automatic and manual snapshots are removed first.', when: function(values) { return values.workbench.snapshotEnabled; } }
    ], extra: function(section) { section.appendChild(n('p', { class: 'form-note' }, [n('a', { href: 'dashboard.html?view=snapshots', text: 'See and restore your snapshots' })])); } },
    { id: 'appearance', title: 'Appearance', settings: [
      { key: 'theme', source: 'workbench', type: 'select', options: [['system', 'Match my system'], ['light', 'Light'], ['dark', 'Dark']], label: 'Theme', help: 'For the popup, the tab list and these settings.' },
      { key: 'gsTheme', type: 'select', options: [['light', 'Light'], ['dark', 'Dark']], label: 'Sleeping tab page' },
      { key: 'screenCapture', type: 'select', options: [['0', 'Don’t show a screenshot'], ['1', 'Show the visible part'], ['2', 'Show the whole page']], label: 'Screenshot on sleeping tabs', help: 'Screenshots make suspending slower and use more memory.' },
      { key: 'screenCaptureForce', type: 'switch', label: 'High-quality screenshots', help: 'Sharper, but slower and heavier.', when: screenshotsOn },
      { key: 'cleanScreencaps', type: 'switch', label: 'Hide ads in screenshots', help: 'Downloads a public ad-blocking list to filter what is captured.', when: screenshotsOn }
    ] },
    { id: 'advanced', title: 'Advanced', settings: [
      { key: 'gsUnsuspendOnFocus', type: 'switch', label: 'Wake a sleeping tab as soon as I switch to it' },
      { key: 'gsIgnoreCache', type: 'switch', label: 'Reload pages fresh when waking', help: 'Skips the browser cache. Slower, but always up to date.' },
      { key: 'discardAfterSuspend', type: 'switch', label: 'Also let the browser unload sleeping tabs', help: 'Frees a little more memory; switching back to a tab takes a moment longer.' },
      { key: 'suspendInPlaceOfDiscard', type: 'switch', label: 'Suspend tabs the browser would otherwise unload', help: 'Keeps a readable page instead of a blank tab when memory runs low.' },
      { key: 'gsAddContextMenu', type: 'switch', label: 'Add suspend options to the right-click menu' },
      { key: 'gsSyncSettings', type: 'switch', label: 'Sync these settings with your browser account', help: 'Can overwrite settings on your other signed-in browsers. Tabs, workspaces and snapshots never sync.' }
    ] }
  ];

  var data = null, info = null, built = false, loading = false;
  var controls = [], enforce = null;

  function values() { return { legacy: data.legacySettings, workbench: data.settings }; }
  function managed(setting) { return setting.source !== 'workbench' && info.managedKeys.includes(setting.key); }
  function status(section, text, kind) {
    var element = section.querySelector('.save-status');
    element.textContent = text || '';
    element.className = 'save-status' + (kind ? ' is-' + kind : '');
    clearTimeout(element._timer);
    if (kind === 'saved') element._timer = setTimeout(function() { element.textContent = ''; element.className = 'save-status'; }, 2500);
  }
  function current(setting) {
    var source = setting.source === 'workbench' ? data.settings : data.legacySettings;
    return source[setting.key];
  }
  function read(control) {
    var setting = control.setting, input = control.input;
    if (setting.type === 'switch') return input.checked;
    if (setting.type === 'number' || setting.number) return Number(input.value);
    return input.value;
  }
  function write(control) {
    var value = current(control.setting), input = control.input;
    if (control.setting.type === 'switch') input.checked = !!value;
    else if (control.setting.type === 'select') {
      if (!Array.from(input.options).some(function(option) { return option.value === String(value); })) {
        input.appendChild(n('option', { value: String(value), text: String(value) + (control.setting.number ? ' minutes' : '') }));
      }
      input.value = String(value);
    } else input.value = value == null ? '' : value;
  }
  function validate(control, value) {
    var setting = control.setting;
    if (setting.type !== 'number') return '';
    if (!Number.isInteger(value) || value < setting.min || value > setting.max) return 'Enter a whole number from ' + setting.min + ' to ' + setting.max + '.';
    if (setting.key === 'awakeTarget' && value >= data.settings.awakeLimit) return 'Must be fewer than the limit (' + data.settings.awakeLimit + ').';
    return '';
  }
  async function save(control) {
    var setting = control.setting, value = read(control);
    var problem = validate(control, value);
    if (problem) { status(control.section, problem, 'error'); return; }
    if (value === current(setting)) return;
    if (setting.key === 'gsSyncSettings' && value) {
      var accepted = await C.confirm({ title: 'Sync these settings?', text: 'Your settings may replace the ones on your other signed-in browsers. Tabs, workspaces and snapshots never sync.', accept: 'Turn on sync' });
      if (!accepted) { write(control); return; }
    }
    status(control.section, 'Saving…');
    try {
      var patch = {}; patch[setting.key] = value;
      // Lowering the limit below the keep-awake number moves that number down with it.
      if (setting.key === 'awakeLimit' && value <= data.settings.awakeTarget) patch.awakeTarget = Math.max(1, Math.floor(value * 0.8));
      if (setting.source === 'workbench') data.settings = await C.request('settings.update', { settings: patch });
      else data.legacySettings = await C.request('legacy.update', { settings: patch });
      if (setting.key === 'theme') C.theme(value);
      status(control.section, patch.awakeTarget !== undefined && setting.key === 'awakeLimit' ? 'Saved. Keeping ' + patch.awakeTarget + ' awake after the limit is reached.' : 'Saved', 'saved');
      controls.forEach(function(other) { if (other !== control && document.activeElement !== other.input) write(other); });
      applyDependencies();
    } catch (error) {
      status(control.section, error.message || String(error), 'error');
      write(control);
    }
  }
  function applyDependencies() {
    controls.forEach(function(control) {
      var off = control.setting.when && !control.setting.when(values());
      control.row.classList.toggle('is-disabled', !!off || control.locked);
      control.input.disabled = !!off || control.locked;
    });
    if (enforce) enforce.disabled = !data.settings.countEnabled || info.incognito;
  }
  function settingRow(setting, section) {
    var id = 'setting-' + setting.key, input;
    if (setting.type === 'switch') input = n('input', { type: 'checkbox', class: 'switch', id: id, role: 'switch' });
    else if (setting.type === 'select') input = C.select(setting.options, undefined, { id: id });
    else if (setting.type === 'textarea') input = n('textarea', { id: id, rows: '6', spellcheck: 'false' });
    else input = n('input', { type: 'number', id: id, min: String(setting.min), max: String(setting.max), step: '1' });
    var help = setting.help || '';
    var privateOnly = info.incognito && (setting.source === 'workbench' || ['gsSyncSettings', 'gsAddContextMenu'].includes(setting.key));
    var locked = managed(setting) || privateOnly;
    if (managed(setting)) help = 'Set by your organization.';
    else if (privateOnly) help = 'Change this from a normal (non-private) window.';
    var text = n('div', { class: 'setting-text' }, [n('label', { for: id, text: setting.label }), help ? n('small', { text: help }) : null]);
    var row = n('div', { class: 'setting' + (setting.type === 'textarea' ? ' stacked' : '') + (setting.type === 'switch' ? ' is-switch' : '') }, [text, input]);
    var control = { setting: setting, input: input, row: row, section: section, locked: locked };
    write(control);
    var event = setting.type === 'textarea' || setting.type === 'number' ? 'change' : 'input';
    input.addEventListener(event, function() { save(control); });
    if (setting.type === 'number') input.addEventListener('keydown', function(keyEvent) { if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); save(control); } });
    controls.push(control);
    return row;
  }
  function whitelistTest(section) {
    var output = n('div', { class: 'form-note', role: 'status' });
    var test = C.button('Which open tabs match?', async function() {
      try {
        var list = section.querySelector('textarea').value;
        var matches = (await C.request('legacy.whitelist.test', { whitelist: list })).tabs;
        output.replaceChildren(n('p', { class: 'muted', text: matches.length ? matches.length + ' open ' + (matches.length === 1 ? 'tab matches' : 'tabs match') + ' this list:' : 'No open tabs match this list.' }));
        if (matches.length) output.appendChild(n('ul', { class: 'record-tabs' }, matches.map(function(row) { return n('li', { text: (row.title || 'Untitled tab') + ' — ' + (row.originalUrl || row.url) }); })));
      } catch (error) { output.replaceChildren(n('p', { class: 'error-text', text: error.message })); }
    }, { class: 'small' });
    section.append(n('div', { class: 'button-row form-note' }, [test]), output);
  }
  function enforceButton(section) {
    var output = n('p', { class: 'form-note muted', role: 'status' });
    var apply = C.button('Apply the limit now', async function() {
      apply.disabled = true;
      try { output.textContent = C.resultText(await C.request('counts.enforce'), 'Done.'); }
      catch (error) { output.textContent = error.message; }
      finally { apply.disabled = false; }
    }, { class: 'small' });
    section.append(n('div', { class: 'button-row form-note' }, [apply]), output);
    enforce = apply;
  }
  function build() {
    var content = document.getElementById('settings-content');
    var nav = document.getElementById('settings-navigation');
    content.replaceChildren(); nav.replaceChildren(); controls = [];
    SECTIONS.forEach(function(definition) {
      var section = n('section', { class: 'settings-section', id: definition.id, 'aria-labelledby': definition.id + '-title' });
      section.append(n('div', { class: 'record-heading' }, [n('h2', { id: definition.id + '-title', text: definition.title }), n('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' })]));
      if (definition.text) section.appendChild(n('p', { text: definition.text }));
      definition.settings.forEach(function(setting) { section.appendChild(settingRow(setting, section)); });
      if (definition.extra) definition.extra(section);
      content.appendChild(section);
      var link = n('a', { class: 'nav-link', href: '#' + definition.id, text: definition.title });
      nav.appendChild(link);
    });
    applyDependencies();
    built = true;
    // Highlight the section being read in the sidebar.
    var links = Array.from(nav.children);
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function(link) { if (link.getAttribute('href') === '#' + entry.target.id) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
      });
    }, { rootMargin: '-80px 0px -60% 0px' });
    content.querySelectorAll('.settings-section').forEach(function(section) { observer.observe(section); });
    requestAnimationFrame(function() {
      var target = location.hash && document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView({ block: 'start' });
    });
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      var response = await Promise.all([C.request('view.get'), C.request('legacy.settings.get')]);
      data = response[0]; info = response[1]; data.legacySettings = info.settings;
      C.theme(data.settings.theme);
      if (!built) build();
      else controls.forEach(function(control) { if (document.activeElement !== control.input) write(control); });
      applyDependencies();
      if (info.incognito) C.notice(document.getElementById('settings-notice'), 'You’re in a private window. Some settings are only available in a normal window.');
    } catch (error) {
      C.notice(document.getElementById('settings-notice'), error.message || String(error), 'error');
      if (!built) document.getElementById('settings-content').replaceChildren(n('div', { class: 'empty-state' }, [n('h2', { text: 'Couldn’t load settings' }), n('p', { text: 'Reload this page to try again. Nothing was changed.' })]));
    } finally {
      loading = false;
      document.getElementById('settings-content').setAttribute('aria-busy', 'false');
    }
  }
  if (new URL(location.href).searchParams.has('firstTime')) {
    document.getElementById('settings-title').textContent = 'Welcome to The Great Suspender';
    C.notice(document.getElementById('settings-notice'), 'Tabs you haven’t used for an hour will now go to sleep to save memory. Pin the extension to your toolbar to suspend or wake a tab with one click. Everything below is optional.', 'success');
  }
  C.subscribe(refresh);
  window.addEventListener('focus', refresh);
  refresh();
})();
