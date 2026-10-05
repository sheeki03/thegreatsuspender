/* global workbenchClient */
(function() {
  'use strict';
  var C = workbenchClient, n = C.node;
  var VIEWS = {
    tabs: ['Tabs', 'Click a tab to go to it. Select tabs to act on several at once.'],
    duplicates: ['Duplicates', 'Pages that are open more than once. Keep one copy and close the rest.'],
    workspaces: ['Workspaces', 'Named sets of tabs you can put to sleep and wake together.'],
    snapshots: ['Snapshots', 'Saved lists of your open tabs, so you can bring them back after a crash or a clean-up.'],
    archive: ['Archive', 'Tabs you archived. They are closed, but you can bring them back any time.']
  };
  var COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'cyan', 'pink', 'yellow', 'grey'];
  var TIMER_OPTIONS = [['0.33', '20 seconds'], ['1', '1 minute'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['360', '6 hours'], ['720', '12 hours'], ['1440', '1 day'], ['2880', '2 days'], ['4320', '3 days'], ['10080', '1 week'], ['20160', '2 weeks'], ['0', 'Never']];
  var UNSAVED = 'Unsaved form or editable content';
  var IGNORED = ['already-asleep', 'already-awake'];
  var VERBS = { suspend: 'Suspend', restore: 'Wake', archive: 'Archive', close: 'Close' };

  var params = new URL(location.href).searchParams;
  var route = { view: params.get('view') || 'tabs', query: params.get('q') || '', status: params.get('status') || 'all', window: params.get('window') || 'all', workspace: params.get('workspace') || '' };
  if (!VIEWS[route.view]) route.view = 'tabs';
  if (!['all', 'awake', 'asleep', 'kept'].includes(route.status)) route.status = 'all';

  var data = null, busy = false, loading = false, refreshAgain = false;
  var selected = new Set(), focusId = null, visible = [];
  var contentKey = '', tabsUi = null, rowNodes = new Map(), headingNodes = new Map();
  var editing = null, compareState = { before: '', after: '', diff: null }, duplicateChoice = new Map();
  var force = null;
  var content = $('view-content');

  function $(id) { return document.getElementById(id); }
  function plural(count, word, many) { return count + ' ' + (count === 1 ? word : many || word + 's'); }
  function tabTitle(row) { return row.title || row.originalUrl || row.url || 'Untitled tab'; }
  function site(url) {
    try { var parsed = new URL(url); return parsed.protocol === 'file:' ? 'Local file' : parsed.hostname.replace(/^www\./, '') || url; }
    catch (error) { return url || ''; }
  }
  function workspaceById(id) { return data && data.workspaces.find(function(item) { return item.id === id; }) || null; }
  function colorClass(color) { return 'color-' + (COLORS.includes(color) ? color : 'blue'); }
  function dot(color) { return n('span', { class: 'dot ' + colorClass(color), 'aria-hidden': 'true' }); }
  function button(label, handler, attributes, icon) {
    var element = C.button(label, handler, attributes);
    if (icon) element.prepend(C.icon(icon));
    return element;
  }
  function empty(title, text, action) {
    return n('div', { class: 'empty-state' }, [n('img', { src: 'img/suspendy-guy.png', alt: '' }), n('h2', { text: title }), n('p', { text: text }), action || null]);
  }
  function until(value) {
    if (!value) return '';
    if (value.session) return 'until the browser restarts';
    if (!value.until) return 'until you turn it off';
    var date = new Date(value.until), today = new Date();
    var time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return 'until ' + (date.toDateString() === today.toDateString() ? time : date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time);
  }
  function when(value) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
  function timerLabel(minutes) {
    var match = TIMER_OPTIONS.find(function(option) { return Number(option[0]) === Number(minutes); });
    return match ? match[1].toLowerCase() : minutes + ' minutes';
  }
  function keptReasons(row) {
    return (row.protectionReasons || []).filter(function(reason) { return reason !== 'Active tab'; });
  }
  function isKept(row) { return !row.asleep && (!!row.snooze || keptReasons(row).length > 0); }
  function windowLabels() {
    var labels = new Map();
    data.tabs.forEach(function(row) { if (!labels.has(row.windowId)) labels.set(row.windowId, 'Window ' + (Number(row.windowOrdinal) + 1)); });
    return labels;
  }
  function saveRoute() {
    var url = new URL(location.href);
    url.search = '';
    url.searchParams.set('view', route.view);
    if (route.query) url.searchParams.set('q', route.query);
    if (route.status !== 'all') url.searchParams.set('status', route.status);
    if (route.window !== 'all') url.searchParams.set('window', route.window);
    if (route.workspace) url.searchParams.set('workspace', route.workspace);
    history.replaceState(null, '', url.href);
  }
  function navigate(view, workspace) {
    route.view = view;
    route.workspace = workspace || '';
    if (view !== 'tabs') selected.clear();
    editing = null;
    saveRoute();
    render();
    $('view-title').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  /* Result of the last action, with Undo and "do it anyway" when typing blocked it. */
  function showResult(text, options) {
    options = options || {};
    var bar = $('result');
    bar.hidden = false;
    bar.classList.toggle('is-error', !!options.error);
    $('result-text').textContent = text;
    $('result-undo').hidden = !options.undo;
    force = options.force && options.force.ids.length ? options.force : null;
    $('result-force').hidden = !force;
    if (force) $('result-force').textContent = VERBS[force.action] + ' anyway';
    var skipped = options.skipped || [];
    $('result-details').hidden = !skipped.length;
    $('result-details').open = false;
    $('result-summary').textContent = skipped.length === 1 ? 'See why' : 'See why (' + skipped.length + ')';
    $('result-reasons').replaceChildren.apply($('result-reasons'), skipped.map(function(row) {
      var saved = row.entry || {};
      return n('li', {}, [n('strong', { text: row.title || saved.title || row.originalUrl || saved.originalUrl || 'Tab' }), n('span', { text: (row.reasons || [row.reason || 'Unavailable']).map(C.reasonText).join(', ') })]);
    }));
  }
  function errorResult(error) { showResult(error && error.message || String(error), { error: true }); }
  function describe(action, result, ids, chosen) {
    var detail = C.collectResults(result);
    var skipped = detail.skipped.filter(function(row) { return !(row.reasons || [row.reason]).every(function(reason) { return IGNORED.includes(reason); }); });
    var unsaved = skipped.filter(function(row) { return (row.reasons || []).includes(UNSAVED); });
    var changed = detail.changed.length;
    var done = { suspend: 'Suspended', restore: 'Woke', archive: 'Archived', close: 'Closed' }[action];
    var force = unsaved.length && action !== 'restore' ? { action: action, ids: unsaved.map(function(row) { return row.id; }) } : null;
    var single = ids && ids.length === 1 && (chosen || data && data.tabs.find(function(row) { return row.id === ids[0]; }));
    if (single) {
      var name = '“' + tabTitle(single) + '”';
      if (unsaved.length) return { text: name + ' has typing that may not be saved, so it was left open.', skipped: [], changed: changed, force: force };
      if (skipped.length) return { text: name + ' was left as it was: ' + (skipped[0].reasons || [skipped[0].reason]).map(C.reasonText).join(', ').toLowerCase() + '.', skipped: [], changed: changed, force: null };
      if (changed) return { text: done + ' ' + name + '.', skipped: [], changed: changed, force: null };
    }
    var text = changed ? done + ' ' + plural(changed, 'tab') + '.' : 'Nothing changed.';
    if (skipped.length) text += ' ' + plural(skipped.length, 'tab') + ' ' + (action === 'restore' ? 'stayed asleep' : action === 'suspend' ? 'stayed awake' : 'stayed open') + '.';
    if (unsaved.length) text += ' ' + (unsaved.length === 1 ? 'One has' : unsaved.length + ' have') + ' unsaved typing.';
    if (detail.errors.length) text += ' ' + plural(detail.errors.length, 'error') + '.';
    return { text: text, skipped: skipped, changed: changed, force: force };
  }

  async function operation(command, payload, trigger) {
    if (busy) return null;
    busy = true;
    if (trigger) trigger.setAttribute('aria-busy', 'true');
    updateBusy();
    try { return await C.request(command, payload); }
    catch (error) { errorResult(error); return null; }
    finally {
      busy = false;
      if (trigger) trigger.removeAttribute('aria-busy');
      await refresh();
    }
  }
  async function run(action, ids, trigger, override) {
    if (!ids.length || busy) return;
    var chosen = ids.length === 1 ? data.tabs.find(function(row) { return row.id === ids[0]; }) : null;
    var known = chosen && chosen.dirty && !chosen.asleep ? chosen : null;
    if (known && action !== 'restore' && !(override && override.ignoreDrafts)) {
      // We already know this page has typing in it: ask once, then go ahead.
      var go = await C.confirm({ title: VERBS[action] + ' “' + tabTitle(known) + '”?', text: 'You typed something on this page that may not be saved. If you continue, that typing will be lost.', accept: VERBS[action] + ' anyway', destructive: true });
      if (!go) return;
      override = Object.assign({}, override, { ignoreDrafts: true, confirmed: true });
    }
    if ((action === 'archive' || action === 'close') && !(override && override.confirmed)) {
      var accepted = await C.confirm({
        title: VERBS[action] + ' ' + plural(ids.length, 'tab') + '?',
        text: action === 'archive' ? 'They’ll close and be saved in Archive, so you can bring them back later. Tabs with unsaved typing stay open.' :
          'They’ll close. Tabs with unsaved typing stay open, and you can undo this.',
        accept: VERBS[action] + ' ' + plural(ids.length, 'tab'), destructive: action === 'close'
      });
      if (!accepted) return;
    }
    // Tabs picked here are explicit choices: keep-awake rules don't apply, unsaved typing still asks.
    var options = { allowActive: true, explicit: true, reason: 'workbench', ignoreDrafts: !!(override && override.ignoreDrafts) };
    if (action === 'archive') {
      var first = chosen || data.tabs.find(function(row) { return row.id === ids[0]; });
      options.label = first ? tabTitle(first) + (ids.length > 1 ? ' and ' + plural(ids.length - 1, 'more tab') : '') : plural(ids.length, 'archived tab');
    }
    var result = await operation('action.run', { action: action, tabIds: ids, options: options }, trigger);
    if (!result) return;
    if (action === 'archive' || action === 'close') ids.forEach(function(id) { selected.delete(id); });
    var outcome = describe(action, result, ids, chosen);
    showResult(outcome.text, { skipped: outcome.skipped, undo: outcome.changed > 0, force: outcome.force });
    render();
  }

  async function refresh() {
    if (busy || loading) { refreshAgain = true; return; }
    loading = true;
    try {
      data = await C.request('view.get');
      if (!Array.isArray(data.tabs) || !Array.isArray(data.workspaces)) throw new Error('The extension returned an incomplete view. Reload the extension, then this page.');
      var live = new Set(data.tabs.map(function(row) { return row.id; }));
      selected.forEach(function(id) { if (!live.has(id)) selected.delete(id); });
      if (route.workspace && !workspaceById(route.workspace)) route.workspace = '';
      C.theme(data.settings.theme);
      render();
    } catch (error) {
      errorResult(error);
      if (!data) content.replaceChildren(empty('Couldn’t load your tabs', 'Reload this page to try again. Your tabs have not been changed.'));
    } finally {
      loading = false;
      content.setAttribute('aria-busy', 'false');
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  function render() {
    if (!data) return;
    renderNavigation();
    var workspace = route.view === 'tabs' && route.workspace ? workspaceById(route.workspace) : null;
    var heading = $('view-title');
    heading.tabIndex = -1;
    heading.replaceChildren();
    if (workspace) heading.append(dot(workspace.color), ' ', workspace.name);
    else heading.textContent = VIEWS[route.view][0];
    $('view-description').textContent = workspace ? workspaceSummary(workspace) : VIEWS[route.view][1];
    $('view-actions').replaceChildren();
    if (workspace) $('view-actions').append.apply($('view-actions'), workspaceButtons(workspace, true));
    var undo = $('undo-button');
    undo.disabled = !data.undoSummary || busy;
    undo.title = data.undoSummary ? 'Undo your last action' : 'Nothing to undo';
    if (route.view === 'tabs') renderTabs();
    else if (route.view === 'duplicates') renderDuplicates();
    else if (route.view === 'workspaces') renderWorkspaces();
    else if (route.view === 'snapshots') renderSnapshots();
    else renderArchive();
  }
  function updateBusy() {
    $('undo-button').disabled = busy || !data || !data.undoSummary;
    document.querySelectorAll('[data-busy-sensitive]').forEach(function(element) { element.disabled = busy || element.dataset.blocked === 'true'; });
    document.querySelectorAll('.menu').forEach(function(menu) { menu.classList.toggle('is-disabled', busy || menu.dataset.blocked === 'true'); });
  }

  function renderNavigation() {
    var nav = $('main-navigation');
    var extra = (data.duplicates || []).reduce(function(total, group) { return total + group.tabs.length - 1; }, 0);
    var counts = { tabs: data.tabs.length, duplicates: extra || '', workspaces: data.workspaces.length || '', snapshots: (data.snapshots || []).length || '', archive: (data.archive || []).reduce(function(total, item) { return total + item.tabs.length; }, 0) || '' };
    if (!nav.children.length) {
      Object.keys(VIEWS).forEach(function(key) {
        var link = n('a', { class: 'nav-link', href: 'dashboard.html?view=' + key, 'data-view': key }, [n('span', { class: 'nav-label' }, [n('span', { text: VIEWS[key][0] })]), n('span', { class: 'nav-count' })]);
        link.addEventListener('click', function(event) { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); navigate(key); });
        nav.appendChild(link);
      });
    }
    Array.from(nav.children).forEach(function(link) {
      var key = link.dataset.view;
      if (key === route.view && !route.workspace) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      link.lastChild.textContent = counts[key];
    });
    var rail = $('workspace-navigation');
    rail.replaceChildren();
    data.workspaces.forEach(function(workspace) {
      var open = data.tabs.filter(function(row) { return row.workspaceId === workspace.id; }).length;
      var link = n('a', { class: 'nav-link', href: 'dashboard.html?view=tabs&workspace=' + encodeURIComponent(workspace.id) }, [n('span', { class: 'nav-label' }, [dot(workspace.color), n('span', { text: workspace.name })]), n('span', { class: 'nav-count', text: workspace.hibernated ? 'Asleep' : open || '' })]);
      if (route.view === 'tabs' && route.workspace === workspace.id) link.setAttribute('aria-current', 'page');
      link.addEventListener('click', function(event) { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); navigate('tabs', workspace.id); });
      rail.appendChild(link);
    });
    if (!data.workspaces.length) rail.appendChild(n('p', { class: 'rail-hint', text: 'None yet. Select tabs and choose Move to → New workspace.' }));
  }

  /* ---------- Tabs ---------- */
  function menu(label, icon, build, attributes) {
    var panel = n('div', { class: 'menu-panel', role: 'menu' });
    var summary = n('summary', { 'aria-haspopup': 'menu' }, [C.icon(icon), label]);
    var chev = C.icon('chevron'); chev.classList.add('chev'); summary.appendChild(chev);
    var details = n('details', Object.assign({ class: 'menu' }, attributes || {}), [summary, panel]);
    details.addEventListener('toggle', function() {
      if (!details.open) return;
      document.querySelectorAll('details.menu[open]').forEach(function(other) { if (other !== details) other.open = false; });
      panel.replaceChildren.apply(panel, build());
      var first = panel.querySelector('button'); if (first) first.focus();
    });
    return details;
  }
  function menuItem(label, handler, extra) {
    var item = C.button('', function(event) { event.currentTarget.closest('details').open = false; handler(event); }, { role: 'menuitem' });
    if (extra) item.append(extra, ' ');
    item.append(label);
    return item;
  }
  function selectedRows() { return data.tabs.filter(function(row) { return selected.has(row.id); }); }

  function buildTabsView() {
    var ui = {};
    ui.search = n('input', { type: 'search', placeholder: 'Search by title, site or URL', autocomplete: 'off', 'aria-label': 'Search tabs' });
    ui.search.addEventListener('input', function() { route.query = ui.search.value; saveRoute(); renderTabs(); });
    var searchField = n('label', { class: 'search-field' }, [C.icon('search'), ui.search, n('kbd', { class: 'search-key', text: '/' })]);
    ui.status = n('fieldset', { class: 'segmented' }, [n('legend', { class: 'sr-only', text: 'Show' })]);
    [['all', 'All'], ['awake', 'Awake'], ['asleep', 'Asleep'], ['kept', 'Kept awake']].forEach(function(pair) {
      var input = n('input', { type: 'radio', name: 'status', value: pair[0] });
      input.addEventListener('change', function() { route.status = pair[0]; saveRoute(); renderTabs(); });
      ui.status.appendChild(n('label', {}, [input, n('span', { text: pair[1] })]));
    });
    ui.windowSelect = n('select', { 'aria-label': 'Window' });
    ui.windowSelect.addEventListener('change', function() { route.window = ui.windowSelect.value; saveRoute(); renderTabs(); });
    ui.filters = n('div', { class: 'filters' }, [searchField, ui.status, ui.windowSelect]);

    ui.selectAll = n('input', { type: 'checkbox', 'aria-label': 'Select all shown tabs' });
    ui.selectAll.addEventListener('change', function() {
      visible.forEach(function(row) { if (ui.selectAll.checked) selected.add(row.id); else selected.delete(row.id); });
      renderTabs();
    });
    ui.count = n('span');
    ui.countMuted = n('span', { class: 'muted' });
    var count = n('label', { class: 'selection-count' }, [ui.selectAll, ui.count, ui.countMuted]);
    ui.suspend = button('Suspend', function(event) { run('suspend', selectedRows().filter(function(row) { return !row.asleep; }).map(function(row) { return row.id; }), event.currentTarget); }, { class: 'small', 'data-busy-sensitive': '' }, 'moon');
    ui.wake = button('Wake', function(event) { run('restore', selectedRows().filter(function(row) { return row.asleep; }).map(function(row) { return row.id; }), event.currentTarget); }, { class: 'small', 'data-busy-sensitive': '' }, 'sun');
    ui.keep = menu('Keep awake', 'clock', function() {
      var ids = selectedRows().map(function(row) { return row.id; });
      var items = [
        menuItem('For 1 hour', function() { snooze(ids, { minutes: 60 }); }),
        menuItem('Until tomorrow morning', function() { snooze(ids, { mode: 'tomorrow' }); }),
        menuItem('Until the browser restarts', function() { snooze(ids, { mode: 'restart' }); })
      ];
      if (selectedRows().some(function(row) { return row.snooze; })) items.push(n('hr'), menuItem('Stop keeping awake', function() { snooze(ids, null); }));
      return items;
    });
    ui.move = menu('Move to', 'folder', function() {
      var ids = selectedRows().map(function(row) { return row.id; });
      var items = data.workspaces.map(function(workspace) { return menuItem(workspace.name, function() { assign(workspace, ids); }, dot(workspace.color)); });
      if (items.length) items.push(n('hr'));
      items.push(menuItem('New workspace…', function() { newWorkspace(ids); }));
      if (selectedRows().some(function(row) { return row.workspaceId; })) items.push(menuItem('Remove from workspace', function() { assign(null, ids); }));
      return items;
    });
    ui.archive = button('Archive', function(event) { run('archive', Array.from(selected), event.currentTarget); }, { class: 'small', 'data-busy-sensitive': '' }, 'archive');
    ui.close = button('Close', function(event) { run('close', Array.from(selected), event.currentTarget); }, { class: 'small danger', 'data-busy-sensitive': '' }, 'x');
    ui.clear = button('Clear', function() { selected.clear(); renderTabs(); }, { class: 'small quiet' });
    ui.actions = n('div', { class: 'button-row' }, [ui.suspend, ui.wake, ui.keep, ui.move, ui.archive, ui.close, ui.clear]);
    ui.bar = n('div', { class: 'selection-bar' }, [count, ui.actions]);
    ui.list = n('ul', { class: 'tab-list', 'aria-label': 'Tabs' });
    ui.empty = empty('No tabs match', 'Try a different search or filter.');
    return ui;
  }

  function renderTabs() {
    if (contentKey !== 'tabs' || !tabsUi) {
      tabsUi = buildTabsView();
      content.replaceChildren(tabsUi.filters, tabsUi.bar, tabsUi.list, tabsUi.empty);
      contentKey = 'tabs';
      rowNodes.clear();
      headingNodes.clear();
    }
    var ui = tabsUi;
    if (document.activeElement !== ui.search && ui.search.value !== route.query) ui.search.value = route.query;
    ui.status.querySelectorAll('input').forEach(function(input) { input.checked = input.value === route.status; });
    var labels = windowLabels();
    if (route.window !== 'all' && !labels.has(Number(route.window))) route.window = 'all';
    var options = [['all', 'All windows']].concat(Array.from(labels).map(function(pair) { return [String(pair[0]), pair[1] + (pair[0] === data.focusedWindowId ? ' (this one)' : '')]; }));
    var signature = JSON.stringify(options);
    if (ui.windowSelect.dataset.signature !== signature) {
      ui.windowSelect.replaceChildren.apply(ui.windowSelect, options.map(function(option) { return n('option', { value: option[0], text: option[1] }); }));
      ui.windowSelect.dataset.signature = signature;
    }
    ui.windowSelect.value = route.window;
    ui.windowSelect.hidden = labels.size < 2;

    var terms = route.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    visible = data.tabs.filter(function(row) {
      if (route.workspace && row.workspaceId !== route.workspace) return false;
      if (route.window !== 'all' && String(row.windowId) !== route.window) return false;
      if (route.status === 'awake' && row.asleep) return false;
      if (route.status === 'asleep' && !row.asleep) return false;
      if (route.status === 'kept' && !isKept(row)) return false;
      var text = [row.title, row.originalUrl, row.domain, row.groupTitle, row.workspaceName].join(' ').toLocaleLowerCase();
      return terms.every(function(term) { return text.includes(term); });
    });
    var showHeadings = route.window === 'all' && labels.size > 1;
    var nodes = [], lastWindow = null, perWindow = new Map();
    visible.forEach(function(row) { perWindow.set(row.windowId, (perWindow.get(row.windowId) || 0) + 1); });
    if (focusId === null || !visible.some(function(row) { return row.id === focusId; })) focusId = visible.length ? visible[0].id : null;
    visible.forEach(function(row) {
      if (showHeadings && row.windowId !== lastWindow) {
        lastWindow = row.windowId;
        var heading = headingNodes.get(row.windowId) || n('li', { class: 'window-heading', role: 'presentation' });
        heading.textContent = labels.get(row.windowId) + (row.windowId === data.focusedWindowId ? ' · this window' : '') + ' · ' + plural(perWindow.get(row.windowId), 'tab');
        headingNodes.set(row.windowId, heading);
        nodes.push(heading);
      }
      var item = rowNodes.get(row.id) || createRow();
      rowNodes.set(row.id, item);
      updateRow(item, row);
      nodes.push(item);
    });
    var keep = new Set(nodes);
    Array.from(ui.list.children).forEach(function(child) { if (!keep.has(child)) child.remove(); });
    rowNodes.forEach(function(item, id) { if (!item.isConnected && !keep.has(item)) rowNodes.delete(id); });
    nodes.forEach(function(node, index) { if (ui.list.children[index] !== node) ui.list.insertBefore(node, ui.list.children[index] || null); });
    ui.list.hidden = !visible.length;
    ui.empty.hidden = !!visible.length;
    if (!visible.length) {
      var filtered = route.query || route.status !== 'all' || route.window !== 'all';
      ui.empty.querySelector('h2').textContent = filtered ? 'No tabs match' : route.workspace ? 'No open tabs in this workspace' : 'No tabs to show';
      ui.empty.querySelector('p').textContent = filtered ? 'Try a different search or filter.' : route.workspace ? 'Use “Switch to” above to reopen its saved tabs, or move tabs here from the Tabs page.' : 'Open some web pages and they’ll appear here.';
    }

    var picked = selectedRows();
    var shownSelected = visible.filter(function(row) { return selected.has(row.id); }).length;
    ui.bar.classList.toggle('has-selection', picked.length > 0);
    ui.selectAll.checked = visible.length > 0 && shownSelected === visible.length;
    ui.selectAll.indeterminate = shownSelected > 0 && shownSelected < visible.length;
    ui.selectAll.disabled = !visible.length;
    var awake = visible.filter(function(row) { return !row.asleep; }).length;
    ui.count.textContent = picked.length ? picked.length + ' selected' : plural(visible.length, 'tab');
    ui.countMuted.textContent = picked.length || !visible.length ? '' : awake === visible.length ? '· all awake' : !awake ? '· all asleep' : '· ' + awake + ' awake · ' + (visible.length - awake) + ' asleep';
    ui.actions.hidden = !picked.length;
    ui.suspend.dataset.blocked = String(!picked.some(function(row) { return !row.asleep; }));
    ui.wake.dataset.blocked = String(!picked.some(function(row) { return row.asleep; }));
    updateBusy();
  }

  function createRow() {
    var item = n('li', { class: 'tab-row' });
    var check = n('input', { type: 'checkbox', tabindex: '-1' });
    var favicon = n('img', { class: 'row-favicon', alt: '', width: '16', height: '16', loading: 'lazy' });
    var title = n('button', { type: 'button', class: 'row-title', tabindex: '-1' });
    var siteText = n('span', { class: 'row-site' });
    var sub = n('div', { class: 'row-sub' }, [siteText]);
    var state = n('span', { class: 'state' });
    var action = n('button', { type: 'button', class: 'small row-action', tabindex: '-1', 'data-busy-sensitive': '' });
    item.append(check, favicon, n('div', { class: 'row-main' }, [title, sub]), state, action);
    item._parts = { check: check, favicon: favicon, title: title, site: siteText, sub: sub, state: state, action: action };
    check.addEventListener('change', function() {
      if (check.checked) selected.add(item._row.id); else selected.delete(item._row.id);
      focusId = item._row.id;
      renderTabs();
    });
    title.addEventListener('click', function() { C.focusTab(item._row).catch(errorResult); });
    title.addEventListener('focus', function() { focusId = item._row.id; });
    title.addEventListener('keydown', function(event) { rowKeys(event, item); });
    action.addEventListener('click', function(event) { run(item._row.asleep ? 'restore' : 'suspend', [item._row.id], event.currentTarget); });
    return item;
  }
  function updateRow(item, row) {
    var parts = item._parts;
    item._row = row;
    item.classList.toggle('is-selected', selected.has(row.id));
    item.classList.toggle('is-asleep', row.asleep);
    parts.check.checked = selected.has(row.id);
    parts.check.setAttribute('aria-label', 'Select ' + tabTitle(row));
    var icon = C.favicon(row.originalUrl);
    if (parts.favicon.getAttribute('src') !== icon) parts.favicon.src = icon;
    parts.title.textContent = tabTitle(row);
    parts.title.title = 'Go to ' + tabTitle(row);
    var focusable = row.id === focusId;
    parts.title.tabIndex = focusable ? 0 : -1;
    parts.action.tabIndex = focusable ? 0 : -1;
    parts.site.textContent = site(row.originalUrl);
    parts.site.title = row.originalUrl;
    var tags = [];
    var workspace = row.workspaceId && workspaceById(row.workspaceId);
    if (workspace && route.workspace !== workspace.id) tags.push(n('span', { class: 'tag' }, [dot(workspace.color), workspace.name]));
    if (row.groupTitle) tags.push(n('span', { class: 'tag' }, [dot(row.groupColor), row.groupTitle]));
    if (row.pinned) tags.push(n('span', { class: 'tag', text: 'Pinned' }));
    if (row.audible) tags.push(n('span', { class: 'tag', text: 'Playing audio' }));
    if (row.dirty && !row.asleep) tags.push(n('span', { class: 'tag warn', text: 'Unsaved typing' }));
    if (row.snooze && !row.asleep) tags.push(n('span', { class: 'tag warn', text: 'Kept awake ' + until(row.snooze) }));
    if ((row.protectionReasons || []).includes('Always keep awake')) tags.push(n('span', { class: 'tag warn', text: 'Site always awake' }));
    var signature = tags.map(function(tag) { return tag.textContent; }).join('|');
    if (parts.sub.dataset.tags !== signature) {
      Array.from(parts.sub.children).slice(1).forEach(function(child) { child.remove(); });
      tags.forEach(function(tag) { parts.sub.appendChild(tag); });
      parts.sub.dataset.tags = signature;
    }
    // The action button already says Suspend or Wake; only call out the states worth noticing.
    parts.state.textContent = row.asleep ? 'Asleep' : row.status === 'loading' ? 'Loading' : '';
    parts.state.className = 'state ' + (row.asleep ? 'asleep' : row.status === 'loading' ? 'loading' : '');
    parts.action.replaceChildren(C.icon(row.asleep ? 'sun' : 'moon'), row.asleep ? 'Wake' : 'Suspend');
    parts.action.setAttribute('aria-label', (row.asleep ? 'Wake ' : 'Suspend ') + tabTitle(row));
  }
  function rowKeys(event, item) {
    var index = visible.findIndex(function(row) { return row.id === item._row.id; });
    var target;
    if (event.key === 'ArrowDown') target = Math.min(visible.length - 1, index + 1);
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = visible.length - 1;
    if (target !== undefined) {
      event.preventDefault();
      focusId = visible[target].id;
      renderTabs();
      rowNodes.get(focusId)._parts.title.focus();
    } else if (event.key === ' ') {
      event.preventDefault();
      if (selected.has(item._row.id)) selected.delete(item._row.id); else selected.add(item._row.id);
      renderTabs();
    } else if (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      visible.forEach(function(row) { selected.add(row.id); });
      renderTabs();
    }
  }
  async function snooze(ids, value) {
    var result = await operation(value ? 'snooze.set' : 'snooze.clear', Object.assign({ tabIds: ids }, value || {}));
    if (result) showResult(value ? 'Keeping ' + plural(result.changed.length, 'tab') + ' awake ' + until(result) + '.' : 'Stopped keeping ' + plural(result.changed.length, 'tab') + ' awake.');
  }
  async function assign(workspace, ids) {
    var result = await operation('workspace.assign', { id: workspace ? workspace.id : null, tabIds: ids });
    if (!result) return;
    selected.clear();
    showResult(workspace ? 'Moved ' + plural(result.changed.length, 'tab') + ' to ' + workspace.name + '.' : 'Removed ' + plural(result.changed.length, 'tab') + ' from their workspace.', { skipped: result.skipped });
    render();
  }
  function unusedColor() {
    var used = new Set(data.workspaces.map(function(workspace) { return workspace.color; }));
    return COLORS.find(function(color) { return !used.has(color); }) || COLORS[data.workspaces.length % COLORS.length];
  }
  async function newWorkspace(ids) {
    var input = n('input', { type: 'text', maxlength: '60', placeholder: 'e.g. Work, Trip planning', required: '' });
    var accepted = await C.confirm({ title: 'New workspace', text: ids.length ? 'The ' + plural(ids.length, 'selected tab') + ' will move into it.' : '', detail: C.field('Name', input), accept: 'Create workspace', focus: input });
    var name = input.value.trim();
    if (!accepted || !name) return;
    var result = await operation('workspace.create', { name: name, color: unusedColor(), tabIds: ids });
    if (!result) return;
    selected.clear();
    showResult('Created ' + name + (ids.length ? ' with ' + plural((result.changed || []).length, 'tab') + '.' : '.'));
    render();
  }

  /* ---------- Duplicates ---------- */
  function survivorOf(group) {
    var key = group.workspaceId + '|' + group.url;
    var choice = duplicateChoice.get(key);
    if (!group.tabs.some(function(row) { return row.id === choice; })) choice = group.recommendedSurvivorId || group.tabs[0].id;
    duplicateChoice.set(key, choice);
    return choice;
  }
  async function closeDuplicates(groups, trigger) {
    var plans = groups.map(function(group) { return { survivorId: survivorOf(group), tabIds: group.tabs.map(function(row) { return row.id; }) }; });
    var extra = plans.reduce(function(total, plan) { return total + plan.tabIds.length - 1; }, 0);
    if (!await C.confirm({ title: 'Close ' + plural(extra, 'extra copy', 'extra copies') + '?', text: 'One copy of each page stays open. Copies with unsaved typing stay open too. You can undo this.', accept: 'Close ' + plural(extra, 'copy', 'copies'), destructive: true })) return;
    var result = await operation('duplicates.merge', { groups: plans }, trigger);
    if (!result) return;
    var outcome = describe('close', result);
    showResult(outcome.text, { skipped: outcome.skipped, undo: outcome.changed > 0 });
  }
  function renderDuplicates() {
    contentKey = 'duplicates';
    var groups = data.duplicates || [];
    if (!groups.length) return content.replaceChildren(empty('No duplicate tabs', 'Every open page is open only once. Pages that differ in any part of the URL count as different pages.'));
    var extra = groups.reduce(function(total, group) { return total + group.tabs.length - 1; }, 0);
    var summary = n('div', { class: 'panel inline-form summary-bar' }, [n('p', { class: 'muted', text: plural(groups.length, 'page') + ' open more than once · ' + plural(extra, 'extra copy', 'extra copies') + '.' }), button('Close all extra copies', function(event) { closeDuplicates(groups, event.currentTarget); }, { class: 'primary', 'data-busy-sensitive': '' })]);
    var list = n('ul', { class: 'record-list' });
    groups.forEach(function(group, index) {
      var keep = survivorOf(group);
      var key = group.workspaceId + '|' + group.url;
      var item = n('li', { class: 'record' }, [
        n('div', { class: 'record-heading' }, [n('h2', {}, [n('img', { class: 'row-favicon', src: C.favicon(group.url), alt: '' }), tabTitle(group.tabs[0])]), n('span', { class: 'tag', text: group.tabs.length + ' copies' })]),
        n('p', { class: 'record-url', text: group.url }),
        n('p', { class: 'muted', text: 'Keep this copy:' })
      ]);
      group.tabs.forEach(function(row) {
        var input = n('input', { type: 'radio', name: 'duplicate-' + index, value: row.id, checked: keep === row.id });
        input.addEventListener('change', function() { duplicateChoice.set(key, row.id); });
        var facts = [windowLabels().get(row.windowId), 'tab ' + (Number(row.index) + 1), row.asleep ? 'asleep' : 'awake'];
        if (row.pinned) facts.push('pinned');
        if (row.dirty) facts.push('has unsaved typing');
        if (row.id === group.recommendedSurvivorId) facts.push('recommended');
        item.appendChild(n('label', { class: 'choice' }, [input, n('span', { text: tabTitle(row) }, [n('small', { text: facts.join(' · ') })])]));
      });
      item.appendChild(n('div', { class: 'button-row' }, [button('Close ' + plural(group.tabs.length - 1, 'extra copy', 'extra copies'), function(event) { closeDuplicates([group], event.currentTarget); }, { 'data-busy-sensitive': '' })]));
      list.appendChild(item);
    });
    content.replaceChildren(summary, list);
  }

  /* ---------- Workspaces ---------- */
  function workspaceSummary(workspace) {
    var open = data.tabs.filter(function(row) { return row.workspaceId === workspace.id; });
    var asleep = open.filter(function(row) { return row.asleep; }).length;
    var openUids = new Set(open.map(function(row) { return row.uid; }));
    var closed = (workspace.savedTabs || []).filter(function(entry) { return !openUids.has(entry.uid); }).length;
    var parts = [plural(open.length, 'tab') + ' open' + (!open.length ? '' : asleep === 0 ? ' (all awake)' : asleep === open.length ? ' (all asleep)' : ' (' + asleep + ' asleep)')];
    if (closed) parts.push(closed + ' saved, not open');
    var minutes = workspace.policy && workspace.policy.suspendMinutes;
    if (minutes != null) parts.push(Number(minutes) === 0 ? 'never suspends automatically' : 'suspends after ' + timerLabel(minutes));
    return parts.join(' · ');
  }
  function workspaceButtons(workspace, compact) {
    var current = data.currentWorkspaceId === workspace.id;
    var buttons = [
      button(current ? 'Wake & focus here' : 'Switch to', function(event) { switchWorkspace(workspace, event.currentTarget); }, { class: 'primary small', 'data-busy-sensitive': '', title: 'Wake this workspace’s tabs and put tabs from other workspaces to sleep' }, 'sun'),
      button('Put to sleep', function(event) { hibernate(workspace, event.currentTarget); }, { class: 'small', 'data-busy-sensitive': '' }, 'moon')
    ];
    if (!compact) buttons.push(
      button('Show tabs', function() { navigate('tabs', workspace.id); }, { class: 'small' }),
      button('Edit', function() { editing = workspace.id; renderWorkspaces(); var input = content.querySelector('.panel input'); if (input) input.focus(); }, { class: 'small' }),
      button('Delete', function(event) { deleteWorkspace(workspace, event.currentTarget); }, { class: 'small danger', 'data-busy-sensitive': '' })
    );
    return buttons;
  }
  async function switchWorkspace(workspace, trigger) {
    var result = await operation('workspace.switch', { id: workspace.id }, trigger);
    if (!result) return;
    var woke = (result.restored || []).length + ((result.awakened && result.awakened.changed) || []).length;
    var slept = (result.changed || []).length;
    var skipped = (result.skipped || []).filter(function(row) { return !(row.reasons || []).every(function(reason) { return IGNORED.includes(reason); }); });
    if (!result.switched) return showResult('Couldn’t switch to ' + workspace.name + '. ' + ((result.errors || [])[0] && result.errors[0].reasons ? result.errors[0].reasons.join(', ') : 'Its tabs could not be opened.'), { error: true, skipped: skipped });
    var text = 'Switched to ' + workspace.name + '.';
    if (woke) text += ' Woke ' + plural(woke, 'tab') + '.';
    if (slept) text += ' Put ' + plural(slept, 'tab') + ' from other workspaces to sleep.';
    if (skipped.length) text += ' ' + plural(skipped.length, 'tab') + ' stayed awake.';
    showResult(text, { skipped: skipped, undo: slept > 0 });
  }
  async function hibernate(workspace, trigger) {
    var result = await operation('workspace.hibernate', { id: workspace.id }, trigger);
    if (!result) return;
    var outcome = describe('suspend', result);
    var text = outcome.changed ? 'Put ' + plural(outcome.changed, 'tab') + ' in ' + workspace.name + ' to sleep.' : 'Nothing in ' + workspace.name + ' needed to sleep.';
    if (outcome.skipped.length) text += ' ' + plural(outcome.skipped.length, 'tab') + ' stayed awake.';
    showResult(text, { skipped: outcome.skipped, undo: outcome.changed > 0, force: outcome.force });
  }
  async function deleteWorkspace(workspace, trigger) {
    var targets = [['', 'No workspace']].concat(data.workspaces.filter(function(item) { return item.id !== workspace.id; }).map(function(item) { return [item.id, item.name]; }));
    var reassign = C.select(targets, '');
    var accepted = await C.confirm({ title: 'Delete ' + workspace.name + '?', text: 'Open tabs stay open. Saved tabs that aren’t open go to Archive if they have no new workspace.', detail: C.field('Move its tabs to', reassign), accept: 'Delete workspace', destructive: true });
    if (!accepted) return;
    var result = await operation('workspace.delete', { id: workspace.id, reassignToId: reassign.value || null }, trigger);
    if (result) showResult('Deleted ' + workspace.name + '.' + (result.archivedId ? ' Its closed tabs were saved in Archive.' : ''));
  }
  function workspaceEditor(workspace) {
    var policy = workspace && workspace.policy || {};
    var legacy = data.legacySettings || {};
    var form = n('form', { class: 'panel' });
    var name = n('input', { type: 'text', maxlength: '60', required: '', value: workspace ? workspace.name : '', placeholder: 'e.g. Work' });
    var color = workspace ? workspace.color : unusedColor();
    var swatches = n('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' });
    COLORS.forEach(function(value) {
      swatches.appendChild(n('label', { title: value }, [n('input', { type: 'radio', name: 'workspace-color', value: value, checked: value === color, 'aria-label': value }), n('span', { class: 'dot ' + colorClass(value) })]));
    });
    var timer = C.select([['', 'Same as Settings (' + timerLabel(legacy.gsTimeToSuspend) + ')']].concat(TIMER_OPTIONS), policy.suspendMinutes == null ? '' : String(policy.suspendMinutes));
    var rules = {};
    var more = n('details', {}, [n('summary', { text: 'More rules' })]);
    var grid = n('div', { class: 'form-grid' });
    [['ignorePinned', 'Keep pinned tabs awake'], ['ignoreAudio', 'Keep tabs playing audio awake'], ['ignoreForms', 'Keep tabs with unsaved typing awake'], ['ignoreActive', 'Keep each window’s active tab awake']].forEach(function(pair) {
      rules[pair[0]] = C.select([['', 'Same as Settings'], ['true', 'Yes'], ['false', 'No']], policy[pair[0]] == null ? '' : String(policy[pair[0]]));
      grid.appendChild(C.field(pair[1], rules[pair[0]]));
    });
    rules.countEnabled = C.select([['', 'Same as Settings'], ['true', 'On'], ['false', 'Off']], policy.countEnabled == null ? '' : String(policy.countEnabled));
    var limit = n('input', { type: 'number', min: '2', step: '1', value: policy.awakeLimit == null ? '' : policy.awakeLimit, placeholder: String(data.settings.awakeLimit) });
    var target = n('input', { type: 'number', min: '1', step: '1', value: policy.awakeTarget == null ? '' : policy.awakeTarget, placeholder: String(data.settings.awakeTarget) });
    grid.append(C.field('Tab limit for this workspace', rules.countEnabled), C.field('Most tabs awake at once', limit), C.field('Then put tabs to sleep until only this many are awake', target));
    more.appendChild(grid);
    var error = n('p', { class: 'error-text', hidden: true });
    var save = n('button', { type: 'submit', class: 'primary', text: workspace ? 'Save' : 'Create workspace' });
    form.append(n('h2', { text: workspace ? 'Edit ' + workspace.name : 'New workspace' }), n('div', { class: 'form-grid' }, [C.field('Name', name), C.field('Suspend its tabs after', timer)]), n('div', { class: 'field' }, [n('span', { text: 'Color' }), swatches]), more, error, n('div', { class: 'button-row' }, [save, C.button('Cancel', function() { editing = null; renderWorkspaces(); })]));
    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      var updated = { suspendMinutes: timer.value === '' ? null : Number(timer.value), awakeLimit: limit.value === '' ? null : Number(limit.value), awakeTarget: target.value === '' ? null : Number(target.value) };
      Object.keys(rules).forEach(function(key) { updated[key] = rules[key].value === '' ? null : rules[key].value === 'true'; });
      var effectiveLimit = updated.awakeLimit == null ? data.settings.awakeLimit : updated.awakeLimit;
      var effectiveTarget = updated.awakeTarget == null ? data.settings.awakeTarget : updated.awakeTarget;
      if (effectiveTarget >= effectiveLimit) { error.textContent = 'Keep fewer tabs awake than the limit.'; error.hidden = false; more.open = true; target.focus(); return; }
      var payload = { name: name.value.trim(), color: swatches.querySelector('input:checked').value, policy: updated };
      if (workspace) payload.id = workspace.id;
      var result = await operation(workspace ? 'workspace.update' : 'workspace.create', payload, save);
      if (!result) return;
      editing = null;
      showResult(workspace ? 'Saved ' + payload.name + '.' : 'Created ' + payload.name + '. Select tabs on the Tabs page and choose Move to → ' + payload.name + ' to add them.');
      render();
    });
    return form;
  }
  function renderWorkspaces() {
    contentKey = 'workspaces';
    $('view-actions').replaceChildren(button('New workspace', function() { editing = 'new'; renderWorkspaces(); var input = content.querySelector('.panel input'); if (input) input.focus(); }, { class: 'primary' }));
    var children = [];
    if (editing === 'new') children.push(workspaceEditor(null));
    if (!data.workspaces.length && editing !== 'new') children.push(empty('No workspaces yet', 'A workspace is a named set of tabs, like “Work” or “Trip planning”, that you can put to sleep and wake together. On the Tabs page, select some tabs and choose Move to → New workspace.'));
    var list = n('ul', { class: 'record-list' });
    data.workspaces.forEach(function(workspace) {
      if (editing === workspace.id) { list.appendChild(n('li', {}, [workspaceEditor(workspace)])); return; }
      var current = data.currentWorkspaceId === workspace.id;
      var open = data.tabs.filter(function(row) { return row.workspaceId === workspace.id; });
      var status = current ? 'Current' : workspace.hibernated || (open.length && open.every(function(row) { return row.asleep; })) ? 'Asleep' : open.length ? 'Awake' : 'Not open';
      list.appendChild(n('li', { class: 'record' }, [
        n('div', { class: 'record-heading' }, [n('h2', {}, [dot(workspace.color), workspace.name]), n('span', { class: 'state ' + (status === 'Asleep' ? 'asleep' : status === 'Not open' ? 'loading' : 'awake'), text: status })]),
        n('p', { class: 'record-meta', text: workspaceSummary(workspace) }),
        n('div', { class: 'button-row' }, workspaceButtons(workspace, false))
      ]));
    });
    if (data.workspaces.length) children.push(list);
    content.replaceChildren.apply(content, children);
    updateBusy();
  }

  /* ---------- Snapshots ---------- */
  function tabsDetails(entries) {
    var detail = n('details', {}, [n('summary', { text: 'Show ' + plural(entries.length, 'tab') })]);
    detail.addEventListener('toggle', function() {
      if (!detail.open || detail.children.length > 1) return;
      detail.appendChild(n('ul', { class: 'record-tabs' }, entries.map(function(entry) { return n('li', { text: tabTitle(entry) + ' — ' + site(entry.originalUrl || entry.url) }); })));
    });
    return detail;
  }
  function renderSnapshots() {
    contentKey = 'snapshots';
    var settings = data.settings;
    var label = n('input', { type: 'text', maxlength: '100', placeholder: 'Name (optional)', 'aria-label': 'Snapshot name' });
    var saveButton = n('button', { type: 'submit', class: 'primary', text: 'Save snapshot now', 'data-busy-sensitive': '' });
    var form = n('form', { class: 'panel' }, [n('div', { class: 'inline-form' }, [label, saveButton]), n('p', { class: 'muted form-note' }, [settings.snapshotEnabled ?
      'Automatic snapshots are on: every ' + timerLabel(settings.snapshotIntervalMinutes) + ', keeping the last ' + settings.snapshotKeep + '. ' :
      'Automatic snapshots are off. ', n('a', { href: 'options.html#snapshots', text: settings.snapshotEnabled ? 'Change' : 'Turn on' })])]);
    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      var result = await operation('snapshot.create', { label: label.value.trim() }, saveButton);
      if (result) showResult('Saved “' + result.label + '” with ' + plural(result.tabs.length, 'tab') + '.');
    });
    var snapshots = (data.snapshots || []).slice().sort(function(a, b) { return b.createdAt - a.createdAt; });
    var children = [form];
    if (!snapshots.length) {
      children.push(empty('No snapshots yet', 'A snapshot saves the list of tabs you have open right now, so you can reopen them later.'));
      return content.replaceChildren.apply(content, children);
    }
    var list = n('ul', { class: 'record-list' });
    snapshots.forEach(function(snapshot) {
      list.appendChild(n('li', { class: 'record' }, [
        n('div', { class: 'record-heading' }, [n('h2', { text: snapshot.label || 'Snapshot' })]),
        n('p', { class: 'record-meta', text: when(snapshot.createdAt) + ' · ' + plural(snapshot.tabs.length, 'tab') + (snapshot.reason === 'scheduled' ? ' · automatic' : '') }),
        n('div', { class: 'button-row' }, [
          button('Reopen missing tabs', function(event) { restoreSnapshot(snapshot, event.currentTarget); }, { class: 'small primary', 'data-busy-sensitive': '', title: 'Reopen this snapshot’s tabs that aren’t open now. They open asleep.' }),
          button('Delete', async function(event) {
            var trigger = event.currentTarget;
            if (!await C.confirm({ title: 'Delete this snapshot?', text: 'Only the saved list is deleted. Your open tabs don’t change.', accept: 'Delete snapshot', destructive: true })) return;
            if (await operation('snapshot.delete', { id: snapshot.id }, trigger)) showResult('Snapshot deleted.');
          }, { class: 'small danger', 'data-busy-sensitive': '' })
        ]),
        tabsDetails(snapshot.tabs)
      ]));
    });
    children.push(list);
    if (snapshots.length >= 2) children.push(compareSection(snapshots));
    content.replaceChildren.apply(content, children);
    updateBusy();
  }
  async function restoreSnapshot(snapshot, trigger) {
    var result = await operation('snapshot.restore', { id: snapshot.id }, trigger);
    if (!result) return;
    var reopened = (result.created || []).length;
    var text = reopened ? 'Reopened ' + plural(reopened, 'tab') + ' from “' + snapshot.label + '”. ' + (reopened === 1 ? 'It’s asleep until you open it.' : 'They’re asleep until you open them.') : 'All of this snapshot’s tabs are already open.';
    if (result.alreadyOpen && reopened) text += ' ' + plural(result.alreadyOpen, 'tab') + ' were already open.';
    showResult(text, { skipped: result.skipped, undo: reopened > 0 });
  }
  function compareSection(snapshots) {
    var options = snapshots.map(function(snapshot) { return [snapshot.id, (snapshot.label || 'Snapshot') + ' — ' + when(snapshot.createdAt)]; });
    if (!snapshots.some(function(item) { return item.id === compareState.before; })) compareState.before = snapshots[1].id;
    if (!snapshots.some(function(item) { return item.id === compareState.after; })) compareState.after = snapshots[0].id;
    var before = C.select(options, compareState.before), after = C.select(options, compareState.after);
    before.addEventListener('change', function() { compareState.before = before.value; });
    after.addEventListener('change', function() { compareState.after = after.value; });
    var output = n('div');
    var section = n('details', { class: 'panel' }, [n('summary', { text: 'Compare two snapshots' }), n('div', { class: 'form-grid' }, [C.field('Older', before), C.field('Newer', after)]), C.button('Compare', async function() {
      if (before.value === after.value) { output.replaceChildren(n('p', { class: 'error-text', text: 'Choose two different snapshots.' })); return; }
      try {
        var diff = await C.request('snapshot.compare', { beforeId: before.value, afterId: after.value });
        var parts = [n('p', { class: 'diff-summary', text: diff.added.length + ' added · ' + diff.removed.length + ' removed · ' + diff.changed.length + ' moved or changed · ' + diff.unchangedCount + ' unchanged' })];
        [['Added', diff.added], ['Removed', diff.removed]].forEach(function(pair) {
          if (pair[1].length) parts.push(n('h3', { text: pair[0] }), n('ul', { class: 'record-tabs' }, pair[1].map(function(entry) { return n('li', { text: tabTitle(entry) + ' — ' + site(entry.originalUrl || entry.url) }); })));
        });
        if (diff.changed.length) parts.push(n('h3', { text: 'Moved or changed' }), n('ul', { class: 'record-tabs' }, diff.changed.map(function(change) { return n('li', { text: tabTitle(change.after) + ' — ' + change.fields.join(', ') }); })));
        output.replaceChildren.apply(output, parts);
      } catch (error) { output.replaceChildren(n('p', { class: 'error-text', text: error.message })); }
    }), output]);
    section.open = !!output.children.length;
    return section;
  }

  /* ---------- Archive ---------- */
  function renderArchive() {
    contentKey = 'archive';
    var archives = (data.archive || []).slice().sort(function(a, b) { return b.createdAt - a.createdAt; });
    if (!archives.length) return content.replaceChildren(empty('Nothing archived', 'Archiving closes tabs but keeps them here so you can bring them back. On the Tabs page, select tabs and choose Archive.'));
    var list = n('ul', { class: 'record-list' });
    archives.forEach(function(entry) {
      list.appendChild(n('li', { class: 'record' }, [
        n('div', { class: 'record-heading' }, [n('h2', { text: entry.label || 'Archived tabs' })]),
        n('p', { class: 'record-meta', text: when(entry.createdAt) + ' · ' + plural(entry.tabs.length, 'tab') }),
        n('div', { class: 'button-row' }, [
          button('Restore', async function(event) {
            var result = await operation('archive.restore', { id: entry.id }, event.currentTarget);
            if (result) showResult('Restored ' + plural((result.restored || []).length, 'tab') + '.' + (result.remaining ? ' ' + plural(result.remaining, 'tab') + ' couldn’t be restored and stay in Archive.' : ''), { skipped: result.skipped, undo: (result.changed || []).length > 0 });
          }, { class: 'small primary', 'data-busy-sensitive': '' }),
          button('Delete', async function(event) {
            var trigger = event.currentTarget;
            if (!await C.confirm({ title: 'Delete this archive?', text: 'These saved tabs will be gone for good. This can’t be undone.', accept: 'Delete', destructive: true })) return;
            if (await operation('archive.delete', { id: entry.id }, trigger)) showResult('Archive deleted.');
          }, { class: 'small danger', 'data-busy-sensitive': '' })
        ]),
        tabsDetails(entry.tabs)
      ]));
    });
    content.replaceChildren(list);
    updateBusy();
  }

  /* ---------- Page-level events ---------- */
  $('undo-button').addEventListener('click', async function(event) {
    var result = await operation('action.undo', {}, event.currentTarget);
    if (!result) return;
    var changed = (result.changed || []).length;
    showResult(changed ? 'Undone. ' + plural(changed, 'tab') + ' back as ' + (changed === 1 ? 'it was' : 'they were') + '.' : 'Nothing left to undo.', { skipped: result.skipped });
  });
  $('result-undo').addEventListener('click', function(event) { $('undo-button').click(); event.currentTarget.hidden = true; });
  $('result-force').addEventListener('click', function(event) { if (force) run(force.action, force.ids, event.currentTarget, { ignoreDrafts: true, confirmed: true }); });
  $('result-dismiss').addEventListener('click', function() { $('result').hidden = true; });
  document.addEventListener('click', function(event) {
    document.querySelectorAll('details.menu[open]').forEach(function(menuElement) { if (!menuElement.contains(event.target)) menuElement.open = false; });
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      var open = document.querySelector('details.menu[open]');
      if (open) { open.open = false; open.querySelector('summary').focus(); return; }
      if (route.view === 'tabs' && selected.size && !document.querySelector('dialog[open]')) { selected.clear(); renderTabs(); }
      return;
    }
    if (route.view === 'tabs' && tabsUi) C.searchKeys(event, tabsUi.search);
  });
  C.subscribe(refresh);
  var interval = setInterval(function() { if (!document.hidden) refresh(); }, 15000);
  window.addEventListener('pagehide', function() { clearInterval(interval); });
  window.addEventListener('focus', refresh);
  refresh();
})();
