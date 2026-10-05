/* global chrome, workbenchClient */
(function() {
  'use strict';
  var C = workbenchClient, n = C.node, b = C.button;
  var params = new URL(location.href).searchParams;
  var route = { view: params.get('view') || 'tabs', query: params.get('q') || '', status: params.get('status') || 'all', window: params.get('window') || 'all', workspace: params.get('workspace') || '' };
  var views = {
    tabs: ['Tabs', 'Across your browser, without losing your place.'],
    inbox: ['Inbox', 'New tabs you have not revisited. Keep what matters; safely clear the rest.'],
    duplicates: ['Duplicates', 'Exact URLs only. Tabs in separate workspaces stay separate.'],
    temporary: ['Temporary tabs', 'Expiring tabs and groups. Protected tabs stay open, even when overdue.'],
    workspaces: ['Workspaces', 'Keep a task together, with its own suspension rules.'],
    archive: ['Archive', 'Locally saved tabs you can restore when you need them.'],
    snapshots: ['Snapshots', 'Save and compare browser sessions without replacing your open work.'],
    timeline: ['Timeline', 'A local record of what opened, slept, returned and closed.'],
    insights: ['Insights', 'Measured browser activity and suspension behavior. No estimated memory savings.'],
    neglected: ['Neglected tabs', 'A review queue, not an automatic close rule.']
  };
  if (!views[route.view]) route.view = 'tabs';
  var data = null, selected = new Set(), inspectedId = null, rowFocusId = null;
  var busy = false, loading = false, refreshAgain = false, currentContent = '', inspectorKey = '';
  var rowsById = new Map(), visibleRows = [], duplicateChoices = new Map();
  var undoButton = document.getElementById('undo-button');
  var content = document.getElementById('view-content');
  var inspector = document.getElementById('inspector');
  var notice = document.getElementById('page-notice');
  var search = document.getElementById('tab-search');
  var statusFilter = document.getElementById('status-filter');
  var windowFilter = document.getElementById('window-filter');
  var resultBox = null, previewBox = null, previewTrigger = null;
  var workspaceEditor = null, bookmarkPanel = null, comparePanel = null, transitionPanel = null;
  var snapshotSelection = { before: '', after: '' };
  var timelineLimit = 100, previewVersion = 0;
  var listHost, listCount, selectAll;
  var nativeColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

  function say(text, kind) { C.notice(notice, text, kind); }
  function failed(error) { say(error.message || String(error), 'error'); }
  function tabTitle(row) { return row.title || row.originalUrl || row.url || 'Untitled tab'; }
  function workspaceName(id) {
    var workspace = data && data.workspaces.find(function(item) { return item.id === id; });
    return workspace ? workspace.name : 'Unassigned';
  }
  function activeRows() {
    if (!data) return [];
    if (selected.size) return data.tabs.filter(function(row) { return selected.has(row.id); });
    return data.tabs.filter(function(row) { return row.id === inspectedId; });
  }
  function idsForAction() { return activeRows().map(function(row) { return row.id; }); }
  function empty(title, text) { return n('div', { class: 'empty-state' }, [n('img', { class: 'empty-mascot', src: 'img/suspendy-guy.png', alt: '', width: '48', height: '71' }), n('h2', { text: title }), n('p', { text: text })]); }
  function saveRoute() {
    var url = new URL(location.href);
    url.searchParams.set('view', route.view);
    [['q', route.query], ['status', route.status === 'all' ? '' : route.status], ['window', route.window === 'all' ? '' : route.window], ['workspace', route.workspace]].forEach(function(pair) {
      if (pair[1]) url.searchParams.set(pair[0], pair[1]); else url.searchParams.delete(pair[0]);
    });
    history.replaceState(null, '', url.href);
  }
  function navigate(view, workspace) {
    route.view = view;
    route.workspace = workspace || '';
    currentContent = '';
    inspectorKey = '';
    saveRoute();
    render();
  }
  function restoreTrigger(trigger) {
    var key = trigger && trigger.dataset.focusKey;
    var current = trigger && trigger.isConnected ? trigger :
      key ? Array.from(document.querySelectorAll('[data-focus-key]')).find(function(element) { return element.dataset.focusKey === key; }) : null;
    if (current && current.closest('[hidden]')) current = null;
    if (!current) current = document.querySelector('.row-title[tabindex="0"]') || document.getElementById('refresh-button');
    if (current) { current.disabled = false; current.focus(); }
  }
  function closeInlinePanel(panel) {
    if (!panel) return;
    if (panel === workspaceEditor) workspaceEditor = null;
    else if (panel === bookmarkPanel) bookmarkPanel = null;
    else if (panel === transitionPanel) transitionPanel = null;
    else if (panel === comparePanel) comparePanel = null;
    else return;
    if (route.view === 'workspaces') renderWorkspaces();
    else if (route.view === 'snapshots') renderSnapshots();
    restoreTrigger(panel._trigger);
  }
  function preserveFocus(handler) {
    var active = document.activeElement;
    var key = active && active.dataset.focusKey;
    var start = active && active.selectionStart;
    var end = active && active.selectionEnd;
    var value = active && active.value;
    var checked = active && active.checked;
    var expanded = new Set(Array.from(document.querySelectorAll('details[open] > summary[data-focus-key]')).map(function(summary) { return summary.dataset.focusKey; }));
    handler();
    assignFocusKeys();
    Array.from(document.querySelectorAll('details > summary[data-focus-key]')).forEach(function(summary) { if (expanded.has(summary.dataset.focusKey)) summary.parentElement.open = true; });
    if (active && document.activeElement !== active) {
      var next = active.isConnected ? active : key ? Array.from(document.querySelectorAll('[data-focus-key]')).find(function(element) { return element.dataset.focusKey === key; }) : null;
      if (next) {
        if (next !== active && /^(INPUT|TEXTAREA|SELECT)$/.test(next.tagName)) {
          if (next.tagName !== 'SELECT' || Array.from(next.options).some(function(option) { return option.value === value; })) next.value = value;
          if (next.type === 'checkbox' || next.type === 'radio') next.checked = checked;
        }
        next.focus({ preventScroll: true });
        if (typeof start === 'number' && next.setSelectionRange && /^(search|text|url|tel|password)$/.test(next.type)) next.setSelectionRange(start, end);
      }
    }
  }
  function assignFocusKeys() {
    var counts = new Map();
    document.querySelectorAll('a, button, input, select, textarea, summary').forEach(function(element) {
      if (element.dataset.focusKey) return;
      var record = element.closest('[data-record-key]');
      var scopeKey = record ? record.dataset.recordKey : route.view;
      var base = scopeKey + ':' + element.tagName + ':' + (element.getAttribute('aria-label') || element.name || element.textContent.trim().slice(0, 80));
      var index = counts.get(base) || 0;
      counts.set(base, index + 1);
      element.dataset.focusKey = 'control:' + base + ':' + index;
    });
  }
  async function refresh() {
    if (busy || loading) { refreshAgain = true; return; }
    loading = true;
    document.getElementById('refresh-button').disabled = true;
    try {
      data = await C.request('view.get');
      if (!Array.isArray(data.tabs) || !Array.isArray(data.workspaces)) throw new Error('The extension returned an incomplete view. Reload the extension, then refresh.');
      var liveIds = new Set(data.tabs.map(function(row) { return row.id; }));
      selected.forEach(function(id) { if (!liveIds.has(id)) selected.delete(id); });
      if (inspectedId === null && data.focusedTabId && liveIds.has(data.focusedTabId)) inspectedId = data.focusedTabId;
      if (inspectedId !== null && !liveIds.has(inspectedId)) inspectedId = null;
      C.theme(data.settings.theme);
      preserveFocus(render);
    } catch (error) {
      failed(error);
      if (!data) content.replaceChildren(empty('Could not load your workbench', 'Use Refresh to reconnect. Your tabs have not been changed.'));
    } finally {
      loading = false;
      content.setAttribute('aria-busy', 'false');
      document.getElementById('refresh-button').disabled = false;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }
  async function operation(command, payload, trigger, fallback) {
    if (busy) { say('Wait for the current action to finish.'); return null; }
    var focusTrigger = trigger && previewBox && previewBox.contains(trigger) ? previewTrigger : trigger;
    busy = true;
    if (trigger) { trigger.disabled = true; trigger.setAttribute('aria-busy', 'true'); }
    say('Working locally…');
    try {
      var result = await C.request(command, payload);
      say(C.resultText(result, fallback), 'success');
      C.renderResult(document.getElementById('operation-outcome'), result, fallback);
      if (resultBox && resultBox.isConnected) C.renderResult(resultBox, result, fallback);
      return result;
    } catch (error) { failed(error); return null; }
    finally {
      busy = false;
      if (trigger && trigger.isConnected) { trigger.disabled = false; trigger.removeAttribute('aria-busy'); }
      await refresh();
      if (document.activeElement === document.body) restoreTrigger(focusTrigger);
    }
  }
  function updateOptions(element, options, value) {
    var signature = JSON.stringify(options);
    if (element.dataset.options !== signature) {
      element.replaceChildren();
      options.forEach(function(option) { element.appendChild(n('option', { value: option[0], text: option[1] })); });
      element.dataset.options = signature;
    }
    element.value = value;
  }
  function renderNavigation() {
    var nav = document.getElementById('main-navigation');
    if (!nav.children.length) {
      Object.keys(views).forEach(function(key) {
        var count = n('span', { class: 'nav-count' });
        var link = n('a', { class: 'nav-link', href: 'dashboard.html?view=' + key, 'data-view': key, 'data-focus-key': 'nav-' + key }, [n('span', { text: views[key][0] }), count]);
        link.addEventListener('click', function(event) { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); navigate(key); });
        nav.appendChild(link);
      });
    }
    var counts = { tabs: data.tabs.length, inbox: (data.inbox || []).length, duplicates: (data.duplicates || []).length, temporary: (data.temporary || []).length, workspaces: data.workspaces.length, archive: (data.archive || []).length, snapshots: (data.snapshots || []).length, neglected: (data.neglected || []).length };
    Array.from(nav.children).forEach(function(link) {
      var key = link.dataset.view;
      if (key === route.view && !route.workspace) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      link.lastChild.textContent = counts[key] === undefined ? '' : counts[key];
    });
    var rail = document.getElementById('workspace-navigation');
    var railSignature = data.workspaces.map(function(workspace) { return [workspace.id, workspace.name, workspace.color, workspace.hibernated]; });
    if (rail.dataset.signature !== JSON.stringify(railSignature)) {
      rail.replaceChildren();
      data.workspaces.forEach(function(workspace) {
        var link = n('a', { class: 'nav-link', href: 'dashboard.html?view=tabs&workspace=' + encodeURIComponent(workspace.id), 'data-workspace': workspace.id, 'data-focus-key': 'workspace-rail-' + workspace.id }, [n('span', { class: 'workspace-rail-name' }, [n('span', { class: 'workspace-dot color-' + (nativeColors.includes(workspace.color) ? workspace.color : 'blue'), 'aria-hidden': 'true' }), n('span', { text: workspace.name })]), n('span', { class: 'nav-count', text: workspace.hibernated ? 'Asleep' : '' })]);
        link.addEventListener('click', function(event) { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); navigate('tabs', workspace.id); });
        rail.appendChild(link);
      });
      if (!data.workspaces.length) rail.appendChild(n('p', { class: 'empty-rail', text: 'Create a workspace to keep a task together.' }));
      rail.dataset.signature = JSON.stringify(railSignature);
    }
    Array.from(rail.querySelectorAll('[data-workspace]')).forEach(function(link) {
      if (link.dataset.workspace === route.workspace) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
  }
  function render() {
    if (!data) return;
    renderNavigation();
    var rowView = ['tabs', 'inbox', 'temporary', 'neglected'].includes(route.view);
    document.getElementById('app-shell').classList.toggle('without-inspector', !rowView && route.view !== 'duplicates');
    document.getElementById('view-title').textContent = route.workspace && route.view === 'tabs' ? workspaceName(route.workspace) : views[route.view][0];
    document.getElementById('view-description').textContent = views[route.view][1];
    document.getElementById('filters').hidden = !rowView && !['timeline', 'duplicates'].includes(route.view);
    document.getElementById('filters').classList.toggle('search-only', !rowView);
    statusFilter.parentElement.hidden = !rowView;
    windowFilter.parentElement.hidden = !rowView;
    search.value = route.query;
    statusFilter.value = route.status;
    var windowMap = new Map();
    data.tabs.forEach(function(row) { if (!windowMap.has(row.windowId)) windowMap.set(row.windowId, 'Window ' + (Number(row.windowOrdinal) + 1)); });
    var windows = [['all', 'All windows']].concat(Array.from(windowMap).map(function(pair) { return [String(pair[0]), pair[1]]; }));
    if (route.window !== 'all' && !windowMap.has(Number(route.window))) route.window = 'all';
    updateOptions(windowFilter, windows, route.window);
    undoButton.disabled = !data.undo;
    undoButton.title = data.undo ? 'Restores URLs, order, groups and suspension state; not unsaved application state.' : 'No action available to undo.';
    if (rowView) renderRows();
    else if (route.view === 'duplicates') renderDuplicates();
    else if (route.view === 'workspaces') renderWorkspaces();
    else if (route.view === 'archive') renderArchive();
    else if (route.view === 'snapshots') renderSnapshots();
    else if (route.view === 'timeline') renderTimeline();
    else if (route.view === 'insights') renderInsights();
    if (rowView || route.view === 'duplicates') renderInspector();
    assignFocusKeys();
  }
  function filterRows(rows) {
    var terms = route.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(function(row) {
      if (route.workspace && row.workspaceId !== route.workspace) return false;
      if (route.window !== 'all' && row.windowId !== Number(route.window)) return false;
      if (route.status === 'protected' && !(row.protectionReasons || []).length && !row.dirty && !row.snooze && !row.protection) return false;
      if (route.status !== 'all' && route.status !== 'protected' && row.status !== route.status) return false;
      var text = [row.title, row.originalUrl, row.url, row.domain, row.groupTitle, row.workspaceName, row.status].join(' ').toLocaleLowerCase();
      return terms.every(function(term) { return text.includes(term); });
    });
  }
  function rowsForView() {
    if (route.view === 'tabs') return data.tabs;
    var source = data[route.view] || [];
    return source.map(function(item) {
      var id = typeof item === 'number' ? item : item.id || item.tabId;
      var live = data.tabs.find(function(row) { return row.id === id; });
      return live ? Object.assign({}, live, typeof item === 'object' ? item : {}) : null;
    }).filter(Boolean);
  }
  function setupRows() {
    if (currentContent === 'rows') return;
    content.replaceChildren();
    var toolbar = n('div', { class: 'list-toolbar' });
    selectAll = n('input', { type: 'checkbox', 'aria-label': 'Select all visible tabs', 'data-focus-key': 'select-visible' });
    selectAll.addEventListener('change', function() { visibleRows.forEach(function(row) { if (selectAll.checked) selected.add(row.id); else selected.delete(row.id); }); renderRows(); renderInspector(); });
    listCount = n('span', { class: 'list-count' });
    var clear = b('Clear selection', function() { selected.clear(); renderRows(); renderInspector(); }, { class: 'quiet' });
    toolbar.append(n('label', { class: 'select-all' }, [selectAll, n('span', { text: 'Select visible' })]), n('div', { class: 'button-row' }, [listCount, clear, b('Selection actions', function() { inspector.scrollIntoView({ block: 'start' }); var heading = inspector.querySelector('h2'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } })]));
    listHost = n('ul', { class: 'tab-list', 'aria-label': 'Browser tabs' });
    var rowEmpty = empty('No tabs here', 'Try another view or clear your search and filters.');
    rowEmpty.id = 'rows-empty';
    content.append(toolbar, listHost, rowEmpty);
    if (route.view === 'neglected') {
      content.appendChild(n('p', { class: 'muted', text: 'The threshold is configurable in Settings. Recommendations use last foreground view or creation time; they do not measure whether a page is useful.' }));
    }
    rowsById.clear();
    currentContent = 'rows';
  }
  function createRow(row) {
    var item = n('li', { class: 'tab-row', 'data-tab-id': row.id });
    var checkbox = n('input', { type: 'checkbox', tabindex: '-1', 'aria-label': 'Select ' + tabTitle(row) });
    var title = b(tabTitle(row), function() { selected.clear(); inspectedId = item._row.id; rowFocusId = item._row.id; renderRows(); renderInspector(); }, { class: 'row-title', 'data-focus-key': 'row-' + row.id, tabindex: '-1' });
    var url = n('span', { class: 'row-url' });
    var meta = n('div', { class: 'row-meta' });
    var state = n('span', { class: 'row-state' });
    item.append(checkbox, n('div', { class: 'row-main' }, [title, url, meta]), state);
    item._parts = { checkbox: checkbox, title: title, url: url, meta: meta, state: state };
    checkbox.addEventListener('change', function() { if (checkbox.checked) selected.add(item._row.id); else selected.delete(item._row.id); inspectedId = item._row.id; renderRows(); renderInspector(); });
    title.addEventListener('focus', function() { rowFocusId = item._row.id; });
    title.addEventListener('keydown', function(event) {
      var index = visibleRows.findIndex(function(candidate) { return candidate.id === item._row.id; });
      var target;
      if (event.key === 'ArrowDown') target = Math.min(visibleRows.length - 1, index + 1);
      if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = visibleRows.length - 1;
      if (target !== undefined) {
        event.preventDefault();
        rowFocusId = visibleRows[target].id;
        inspectedId = rowFocusId;
        renderRows(); renderInspector();
        rowsById.get(rowFocusId)._parts.title.focus();
      } else if (event.key === ' ') {
        event.preventDefault();
        if (selected.has(item._row.id)) selected.delete(item._row.id); else selected.add(item._row.id);
        inspectedId = item._row.id;
        renderRows(); renderInspector();
      } else if (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault(); visibleRows.forEach(function(candidate) { selected.add(candidate.id); }); renderRows(); renderInspector();
      }
    });
    return item;
  }
  function renderRows() {
    setupRows();
    visibleRows = filterRows(rowsForView());
    var visibleIds = new Set(visibleRows.map(function(row) { return row.id; }));
    rowsById.forEach(function(item, id) { if (!visibleIds.has(id)) { item.remove(); rowsById.delete(id); } });
    if (!visibleIds.has(rowFocusId)) rowFocusId = visibleRows.length ? visibleRows[0].id : null;
    visibleRows.forEach(function(row, index) {
      var item = rowsById.get(row.id);
      if (!item) { item = createRow(row); rowsById.set(row.id, item); }
      item._row = row;
      var parts = item._parts;
      parts.checkbox.checked = selected.has(row.id);
      parts.checkbox.setAttribute('aria-label', 'Select ' + tabTitle(row));
      parts.title.textContent = tabTitle(row);
      parts.title.title = tabTitle(row);
      parts.title.tabIndex = row.id === rowFocusId ? 0 : -1;
      parts.title.setAttribute('aria-pressed', row.id === inspectedId ? 'true' : 'false');
      parts.url.textContent = row.originalUrl || row.url;
      parts.url.title = row.originalUrl || row.url;
      var metadata = ['Window ' + (Number(row.windowOrdinal) + 1)];
      if (row.workspaceName) metadata.push(row.workspaceName);
      if (row.groupTitle) metadata.push('Group: ' + row.groupTitle);
      if (row.pinned) metadata.push('Pinned');
      if (row.audible) metadata.push('Playing audio');
      if (row.dirty) metadata.push('Unsaved input');
      if (row.snooze) metadata.push('Snoozed: ' + C.expiry(row.snooze));
      if (row.protection) metadata.push(row.protection.kind + ': ' + C.expiry(row.protection));
      if (row.expiresAt) metadata.push((row.expiresAt <= Date.now() ? 'Overdue: ' : 'Expires: ') + C.date(row.expiresAt));
      if (row.overdue && row.reasons) metadata.push('Kept open: ' + row.reasons.join(', '));
      var metaText = metadata.join(' | ');
      if (parts.meta.dataset.text !== metaText) { parts.meta.replaceChildren(); metadata.forEach(function(text) { parts.meta.appendChild(n('span', { text: text })); }); parts.meta.dataset.text = metaText; }
      parts.state.textContent = row.overdue ? 'Overdue' : row.status;
      parts.state.className = 'row-state ' + (row.overdue ? 'overdue' : row.status);
      item.classList.toggle('is-selected', selected.has(row.id));
      item.classList.toggle('is-inspected', row.id === inspectedId);
      var current = listHost.children[index];
      if (current !== item) listHost.insertBefore(item, current || null);
    });
    listHost.hidden = !visibleRows.length;
    document.getElementById('rows-empty').hidden = !!visibleRows.length;
    var selectedVisible = visibleRows.filter(function(row) { return selected.has(row.id); }).length;
    selectAll.checked = visibleRows.length > 0 && selectedVisible === visibleRows.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleRows.length;
    selectAll.disabled = !visibleRows.length;
    listCount.textContent = visibleRows.length + ' visible' + (selected.size ? ' / ' + selected.size + ' selected' : '');
  }
  function renderInspector() {
    var rows = activeRows(), ids = rows.map(function(row) { return row.id; });
    var signature = ids.slice().sort().join(',') + ':' + rows.map(function(row) { return row.id + '/' + row.groupId; }).join('|') + ':' + data.workspaces.map(function(workspace) { return workspace.id + workspace.name; }).join('|');
    if (signature === inspectorKey) {
      var info = inspector.querySelector('.selection-info');
      if (info) info.textContent = selectionDescription(rows);
      var heading = inspector.querySelector('.inspector-title'), url = inspector.querySelector('.record-url');
      if (heading) heading.textContent = rows.length === 1 ? tabTitle(rows[0]) : rows.length + ' tabs selected';
      if (url && rows.length === 1) url.textContent = rows[0].originalUrl || rows[0].url;
      return;
    }
    inspectorKey = signature;
    inspector.replaceChildren();
    resultBox = n('div', { class: 'operation-result', role: 'status', 'aria-live': 'polite', hidden: true });
    previewBox = n('div', { hidden: true });
    if (!rows.length) {
      inspector.append(n('h2', { text: 'Selection' }), n('p', { class: 'muted', text: 'Inspect a tab or use Space to select several. Actions check draft, audio, meeting and snooze protection before changing anything.' }), resultBox);
      return;
    }
    inspector.append(n('h2', { class: 'inspector-title', text: rows.length === 1 ? tabTitle(rows[0]) : rows.length + ' tabs selected' }), n('p', { class: 'muted selection-info', text: selectionDescription(rows) }));
    if (rows.length === 1) {
      inspector.append(n('p', { class: 'record-url', text: rows[0].originalUrl || rows[0].url }), b('Open tab', function(event) { C.focusTab(activeRows()[0]).catch(failed); }, { 'data-focus-key': 'open-selected-tab' }));
    }
    var includeActive = n('input', { type: 'checkbox', 'data-focus-key': 'include-active' });
    var actions = n('div', { class: 'button-row' });
    [['suspend', 'Suspend'], ['restore', 'Restore'], ['archive', 'Archive'], ['close', 'Close']].forEach(function(action) {
      actions.appendChild(b(action[1], function(event) { previewAction(action[0], idsForAction(), { allowActive: includeActive.checked }, event.currentTarget); }, { class: action[0] === 'close' ? 'danger' : '', 'data-focus-key': 'action-' + action[0] }));
    });
    inspector.append(n('div', { class: 'inspector-section' }, [n('h3', { text: 'Safe actions' }), actions, C.check('Allow selected active tabs to suspend', includeActive, 'Drafts, audio, meetings and snoozes remain protected.'), previewBox, resultBox]));
    if (route.view === 'inbox') inspector.appendChild(b('Keep & mark reviewed', function(event) { operation('inbox.keep', { tabIds: idsForAction() }, event.currentTarget, 'Marked reviewed; these tabs leave Inbox.'); }, { 'data-focus-key': 'inbox-keep' }));
    inspector.append(buildSnooze(), buildProtection(), buildAssignment(), buildGrouping(), buildExpiry());
    inspector.appendChild(n('p', { class: 'muted', text: 'Undo restores URLs, tab order, groups and suspension state. It cannot restore unsaved page or application state.' }));
  }
  function selectionDescription(rows) {
    var protectedCount = rows.filter(function(row) { return (row.protectionReasons || []).length || row.dirty || row.snooze || row.protection; }).length;
    return rows.length + ' tab' + (rows.length === 1 ? '' : 's') + '; ' + rows.filter(function(row) { return !row.asleep; }).length + ' awake' + (protectedCount ? '; ' + protectedCount + ' with protections' : '') + (rows.length === 1 && rows[0].protectionReasons && rows[0].protectionReasons.length ? '. ' + rows[0].protectionReasons.join(', ') : '');
  }
  function details(title, children) { return n('details', {}, [n('summary', { text: title })].concat(children)); }
  function savedTabsDetails(rows, title) {
    var detail = n('details', {}, [n('summary', { text: (title || 'Saved tabs') + ' (' + rows.length + ')' })]);
    detail.addEventListener('toggle', function() {
      if (!detail.open || detail.children.length > 1) return;
      detail.appendChild(n('ul', { class: 'record-tabs' }, rows.map(function(row) { return n('li', { text: tabTitle(row) + ' — ' + (row.originalUrl || row.url) }); })));
    });
    return detail;
  }
  function buildSnooze() {
    var choice = C.select([['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['tomorrow', 'Tomorrow at 09:00 (local)'], ['restart', 'Until browser restart'], ['custom', 'Choose a time']], '60', { 'data-focus-key': 'snooze-duration' });
    var time = n('input', { type: 'datetime-local', 'data-focus-key': 'snooze-time' });
    var timeField = C.field('Snooze until', time); timeField.hidden = true;
    choice.addEventListener('change', function() { timeField.hidden = choice.value !== 'custom'; });
    return details('Snooze suspension', [C.field('Keep selected tabs awake for', choice), timeField, n('div', { class: 'button-row' }, [b('Snooze', function(event) {
      var payload = { tabIds: idsForAction() };
      if (['tomorrow', 'restart'].includes(choice.value)) payload.mode = choice.value;
      else if (choice.value === 'custom') { payload.until = new Date(time.value).getTime(); if (!Number.isFinite(payload.until) || payload.until <= Date.now()) return say('Choose a snooze time in the future.', 'error'); }
      else payload.minutes = Number(choice.value);
      operation('snooze.set', payload, event.currentTarget, 'Snooze saved.');
    }), b('End snooze', function(event) { operation('snooze.clear', { tabIds: idsForAction() }, event.currentTarget, 'Snooze ended.'); })])]);
  }
  function buildProtection() {
    var kind = C.select([['meeting', 'Meeting'], ['presentation', 'Presentation']], 'meeting', { 'data-focus-key': 'protection-kind' });
    var duration = C.select([['60', '1 hour'], ['120', '2 hours'], ['restart', 'Until browser restart'], ['manual', 'Until I end it']], '60', { 'data-focus-key': 'protection-duration' });
    return details('Meeting & presentation', [C.field('Protection mode', kind), C.field('Duration', duration), n('div', { class: 'button-row' }, [b('Protect tabs', function(event) {
      var payload = { tabIds: idsForAction(), kind: kind.value };
      if (duration.value === 'restart') payload.mode = 'restart'; else if (duration.value !== 'manual') payload.minutes = Number(duration.value);
      operation('protection.set', payload, event.currentTarget, 'Protection enabled.');
    }), b('End protection', function(event) { operation('protection.clear', { tabIds: idsForAction() }, event.currentTarget, 'Protection ended.'); })])]);
  }
  function buildAssignment() {
    var select = C.select([['', 'Choose a workspace']].concat(data.workspaces.map(function(workspace) { return [workspace.id, workspace.name]; })), '', { 'data-focus-key': 'assign-workspace' });
    var assign = b('Assign tabs', function(event) { if (!select.value) return say('Choose a workspace first.', 'error'); operation('workspace.assign', { id: select.value, tabIds: idsForAction() }, event.currentTarget, 'Tabs assigned.'); });
    return details('Workspace', [C.field('Move selected tabs into', select), assign, n('p', { class: 'muted', text: 'Create or edit workspace rules in the Workspaces view.' })]);
  }
  function buildGrouping() {
    var mode = C.select([['domain', 'Website / domain'], ['topic', 'Topic from local title keywords']], 'domain', { 'data-focus-key': 'group-mode' });
    return details('Native tab groups', [C.field('Group selected tabs by', mode), b('Preview groups', function(event) { previewGroups(idsForAction(), mode.value, event.currentTarget); }, { 'data-focus-key': 'preview-groups' }), n('p', { class: 'muted', text: 'Topic grouping uses deterministic title keywords on this device. No cloud or AI service.' })]);
  }
  function buildExpiry() {
    var time = n('input', { type: 'datetime-local', 'data-focus-key': 'expiry-time' });
    var rows = activeRows();
    var groupIds = Array.from(new Set(rows.map(function(row) { return row.groupId; }))).filter(function(id) { return id >= 0; });
    var scope = C.select([['tab', 'Selected tabs']].concat(groupIds.length === 1 && rows.every(function(row) { return row.groupId === groupIds[0]; }) ? [['group', 'Entire native group, including future tabs']] : []), 'tab', { 'data-focus-key': 'expiry-scope' });
    return details('Temporary tabs & groups', [C.field('Expiry scope', scope), C.field('Close safely after', time, 'Checked each minute. Draft, pinned, audio, meeting and snooze protections still apply.'), n('div', { class: 'button-row' }, [b('Set expiry', function(event) {
      var until = new Date(time.value).getTime(); if (!Number.isFinite(until) || until <= Date.now()) return say('Choose an expiry time in the future.', 'error');
      var payload = { tabIds: idsForAction(), until: until };
      if (scope.value === 'group') payload.groupId = groupIds[0];
      operation('temporary.set', payload, event.currentTarget, 'Expiry saved.');
    }), b('Remove expiry', function(event) { operation('temporary.clear', { tabIds: idsForAction(), scope: scope.value, groupId: scope.value === 'group' ? groupIds[0] : undefined }, event.currentTarget, 'Expiry removed.'); })])]);
  }
  function skipList(skipped) {
    var list = n('ul', { class: 'reason-list' });
    (skipped || []).forEach(function(row) { list.appendChild(n('li', {}, [n('strong', { text: tabTitle(row) }), n('span', { text: (row.reasons || [row.reason || 'Unavailable']).join(', ') })])); });
    return list;
  }
  async function previewAction(action, ids, options, trigger) {
    if (!ids.length) return say('Select at least one tab.', 'error');
    if (busy) return say('Wait for the current action to finish.');
    trigger.disabled = true;
    var version = ++previewVersion, selectionKey = inspectorKey;
    previewBox.className = 'preview-panel'; previewBox.hidden = false; previewBox.setAttribute('aria-busy', 'true');
    previewBox.replaceChildren(n('h3', { text: 'Checking tab protection' }), n('p', { text: 'Waiting for the browser to verify current page and draft state.' }));
    try {
      var preview = await C.request('action.preview', { action: action, tabIds: ids, options: options });
      if (version !== previewVersion || selectionKey !== inspectorKey) return;
      var eligible = preview.eligible || [], skipped = preview.skipped || [];
      previewTrigger = trigger;
      options.expectedTabs = eligible.concat(skipped).map(function(row) { return { id: row.id, uid: row.uid, originalUrl: row.originalUrl }; });
      previewBox.replaceChildren(); previewBox.hidden = false; previewBox.className = 'preview-panel';
      var verb = action.charAt(0).toUpperCase() + action.slice(1);
      previewBox.append(n('h3', { text: verb + ' preview' }), n('p', { text: eligible.length + ' eligible; ' + skipped.length + ' skipped. Protection is checked again when the action runs.' }));
      var eligibleDetails = details('Eligible tabs (' + eligible.length + ')', [n('ul', { class: 'record-tabs' }, eligible.map(function(row) { return n('li', { text: tabTitle(row) }); }))]);
      previewBox.append(eligibleDetails);
      if (skipped.length) previewBox.appendChild(skipList(skipped));
      previewBox.appendChild(b(verb + ' ' + eligible.length + ' tabs', async function(event) {
        var runButton = event.currentTarget;
        if (['archive', 'close'].includes(action)) {
          var accepted = await C.confirm({ title: verb + ' selected tabs?', text: 'Only tabs still eligible will change. Undo can restore URLs, order, groups and suspension state, but not unsaved application state.', accept: verb + ' tabs', destructive: true });
          if (!accepted) return;
        }
        var result = await operation('action.run', { action: action, tabIds: ids, options: Object.assign({ reason: 'workbench' }, options) }, runButton, verb + ' completed.');
        if (result && previewBox.isConnected) previewBox.hidden = true;
      }, { class: ['archive', 'close'].includes(action) ? 'danger' : 'primary', disabled: !eligible.length, 'data-focus-key': 'run-preview' }));
      previewBox.appendChild(b('Cancel preview', function() { previewBox.hidden = true; restoreTrigger(trigger); }, { class: 'quiet' }));
    } catch (error) { failed(error); if (version === previewVersion) previewBox.replaceChildren(n('p', { class: 'error-text', text: 'Preview unavailable: ' + (error.message || String(error)) })); }
    finally { previewBox.setAttribute('aria-busy', 'false'); if (trigger.isConnected) trigger.disabled = false; }
  }
  async function previewGroups(ids, mode, trigger) {
    if (!ids.length) return say('Select at least one tab.', 'error');
    trigger.disabled = true;
    var version = ++previewVersion, selectionKey = inspectorKey;
    previewBox.className = 'preview-panel'; previewBox.hidden = false; previewBox.setAttribute('aria-busy', 'true');
    previewBox.replaceChildren(n('h3', { text: 'Planning native groups' }), n('p', { text: 'Reading the selected browser tabs.' }));
    try {
      var plan = await C.request('group.preview', { tabIds: ids, mode: mode });
      if (version !== previewVersion || selectionKey !== inspectorKey) return;
      previewTrigger = trigger;
      previewBox.replaceChildren(n('h3', { text: 'Group preview' }), n('p', { text: mode === 'topic' ? 'Topic names come from local title keywords.' : 'Each website is grouped within its existing browser window.' }));
      previewBox.className = 'preview-panel'; previewBox.hidden = false;
      var groups = plan.groups || [];
      previewBox.appendChild(n('ul', { class: 'reason-list' }, groups.map(function(group) { return n('li', { text: group.title + ': ' + group.tabIds.length + ' tabs' }); })));
      if ((plan.skipped || []).length) previewBox.appendChild(skipList(plan.skipped));
      previewBox.appendChild(b('Apply ' + groups.length + ' groups', function(event) { operation('group.apply', { tabIds: ids, mode: mode }, event.currentTarget, 'Native groups created.'); }, { class: 'primary', disabled: !groups.length, 'data-focus-key': 'apply-preview-groups' }));
      previewBox.appendChild(b('Cancel preview', function() { previewBox.hidden = true; restoreTrigger(trigger); }, { class: 'quiet', 'data-focus-key': 'cancel-preview-groups' }));
    } catch (error) { failed(error); if (version === previewVersion) previewBox.replaceChildren(n('p', { class: 'error-text', text: 'Group preview unavailable: ' + (error.message || String(error)) })); }
    finally { previewBox.setAttribute('aria-busy', 'false'); if (trigger.isConnected) trigger.disabled = false; }
  }
  function replaceView(key, children) {
    if (currentContent !== key) { content.replaceChildren(); currentContent = key; }
    content.replaceChildren.apply(content, children);
  }
  function renderDuplicates() {
    var groups = (data.duplicates || []).filter(function(group) {
      if (route.workspace && group.workspaceId !== route.workspace) return false;
      return !route.query || [group.url].concat(group.tabs.map(tabTitle)).join(' ').toLocaleLowerCase().includes(route.query.toLocaleLowerCase());
    });
    var list = n('ul', { class: 'record-list' });
    groups.forEach(function(group, index) {
      var key = group.workspaceId + '|' + group.url;
      var survivor = duplicateChoices.get(key) || group.recommendedSurvivorId;
      if (!group.tabs.some(function(row) { return row.id === survivor; })) survivor = group.recommendedSurvivorId || group.tabs[0].id;
      duplicateChoices.set(key, survivor);
      var item = n('li', { class: 'record', 'data-record-key': 'duplicates-' + key });
      item.append(n('h2', { text: group.tabs.length + ' copies' }), n('p', { class: 'record-url', text: group.url }), n('p', { class: 'muted', text: workspaceName(group.workspaceId) + '. Choose the copy to keep; protected copies are never closed.' }));
      group.tabs.forEach(function(row) {
        var input = n('input', { type: 'radio', name: 'duplicate-' + index, value: row.id, checked: survivor === row.id, 'data-focus-key': 'duplicate-' + row.id });
        input.addEventListener('change', function() { duplicateChoices.set(key, row.id); });
        item.appendChild(n('label', { class: 'duplicate-choice' }, [input, n('span', { text: tabTitle(row) }, [n('small', { text: 'Window ' + (Number(row.windowOrdinal) + 1) + '; ' + row.status + (row.active ? '; active' : '') + ((row.protectionReasons || []).length ? '; ' + row.protectionReasons.join(', ') : '') })])]));
      });
      item.appendChild(b('Preview merge', async function(event) {
        var trigger = event.currentTarget;
        var keep = duplicateChoices.get(key);
        var closeIds = group.tabs.filter(function(row) { return row.id !== keep; }).map(function(row) { return row.id; });
        try {
          var preview = await C.request('action.preview', { action: 'close', tabIds: closeIds });
          var detail = n('div', {}, [n('p', { text: (preview.eligible || []).length + ' copies can close; ' + (preview.skipped || []).length + ' protected copies will stay open.' }), skipList(preview.skipped)]);
          if (!await C.confirm({ title: 'Merge these duplicates?', text: 'The chosen survivor stays open. Exact URLs and workspace boundaries are preserved. Undo cannot recover unsaved application state.', detail: detail, accept: 'Merge duplicates', destructive: true })) return;
          operation('duplicates.merge', { groups: [{ survivorId: keep, tabIds: group.tabs.map(function(row) { return row.id; }) }] }, trigger, 'Duplicates merged.');
        } catch (error) { failed(error); }
      }, { 'data-focus-key': 'merge-' + index }));
      list.appendChild(item);
    });
    replaceView('duplicates', [groups.length ? list : empty('No exact duplicates', 'Distinct query strings, fragments and workspaces are intentionally kept separate.')]);
  }
  function buildWorkspaceEditor(workspace, trigger) {
    var editor = n('section', { class: 'editor-panel', 'data-record-key': 'workspace-editor-' + (workspace ? workspace.id : 'new'), 'aria-label': workspace ? 'Edit workspace' : 'Create workspace' });
    editor._trigger = trigger;
    var form = n('form');
    var name = n('input', { type: 'text', required: '', maxlength: '100', value: workspace ? workspace.name : '', 'data-focus-key': 'workspace-name' });
    var color = C.select(nativeColors.map(function(value) { return [value, value.charAt(0).toUpperCase() + value.slice(1)]; }), workspace ? workspace.color : 'blue', { 'data-focus-key': 'workspace-color' });
    var policy = workspace && workspace.policy || {};
    var legacy = data.legacySettings || {};
    var minutes = n('input', { type: 'number', min: '0', step: '0.01', value: policy.suspendMinutes == null ? '' : policy.suspendMinutes, placeholder: 'Global: ' + legacy.gsTimeToSuspend + ' min', 'data-focus-key': 'workspace-minutes' });
    var policyInputs = {};
    var grid = n('div', { class: 'form-grid' }, [C.field('Workspace name', name), C.field('Color', color), C.field('Suspend after inactivity (minutes)', minutes, 'Leave empty to inherit global settings. 0 means never.')]);
    [['ignorePinned', 'Pinned tab protection'], ['ignoreAudio', 'Audio tab protection'], ['ignoreForms', 'Form-input protection'], ['ignoreActive', 'Active-tab protection'], ['countEnabled', 'Awake-tab count policy']].forEach(function(pair) {
      var select = C.select([['inherit', 'Inherit global setting'], ['true', 'Enabled'], ['false', 'Disabled']], policy[pair[0]] == null ? 'inherit' : String(policy[pair[0]]), { 'data-focus-key': 'workspace-' + pair[0] });
      policyInputs[pair[0]] = select;
      grid.appendChild(C.field(pair[1], select));
    });
    var limit = n('input', { type: 'number', min: '1', step: '1', value: policy.awakeLimit == null ? '' : policy.awakeLimit, placeholder: 'Global: ' + data.settings.awakeLimit, 'data-focus-key': 'workspace-limit' });
    var target = n('input', { type: 'number', min: '1', step: '1', value: policy.awakeTarget == null ? '' : policy.awakeTarget, placeholder: 'Global: ' + data.settings.awakeTarget, 'data-focus-key': 'workspace-target' });
    grid.append(C.field('Suspend when awake count exceeds', limit), C.field('Suspend down to awake count', target));
    var save = n('button', { type: 'submit', class: 'primary', text: workspace ? 'Save workspace' : 'Create workspace' });
    form.append(grid, n('p', { class: 'muted', text: 'Explicit bulk actions always retain draft, audio, meeting and snooze safeguards.' }), n('div', { class: 'button-row' }, [save, b('Cancel', function() { closeInlinePanel(editor); })]));
    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (!name.value.trim()) return say('Enter a workspace name.', 'error');
      var updatedPolicy = { suspendMinutes: minutes.value === '' ? null : Number(minutes.value), awakeLimit: limit.value === '' ? null : Number(limit.value), awakeTarget: target.value === '' ? null : Number(target.value) };
      Object.keys(policyInputs).forEach(function(key) { updatedPolicy[key] = policyInputs[key].value === 'inherit' ? null : policyInputs[key].value === 'true'; });
      var effectiveLimit = updatedPolicy.awakeLimit == null ? data.settings.awakeLimit : updatedPolicy.awakeLimit;
      var effectiveTarget = updatedPolicy.awakeTarget == null ? data.settings.awakeTarget : updatedPolicy.awakeTarget;
      if (effectiveTarget >= effectiveLimit) { target.focus(); return say('The awake target must be lower than the awake limit.', 'error'); }
      var payload = { name: name.value.trim(), color: color.value, policy: updatedPolicy };
      if (workspace) payload.id = workspace.id;
      var result = await operation(workspace ? 'workspace.update' : 'workspace.create', payload, save, workspace ? 'Workspace saved.' : 'Workspace created.');
      if (result) closeInlinePanel(editor);
    });
    editor.append(n('h2', { text: workspace ? 'Edit ' + workspace.name : 'Create a workspace' }), form);
    return editor;
  }
  function renderWorkspaces() {
    var isExisting = currentContent === 'workspaces';
    if (!isExisting) { workspaceEditor = null; bookmarkPanel = null; transitionPanel = null; content.replaceChildren(); currentContent = 'workspaces'; }
    var toolbar = n('div', { class: 'button-row' }, [b('Create workspace', function(event) { workspaceEditor = buildWorkspaceEditor(null, event.currentTarget); renderWorkspaces(); workspaceEditor.querySelector('input').focus(); }, { class: 'primary', 'data-focus-key': 'create-workspace' }), b('Import bookmarks', function(event) { openBookmarkPicker('import', null, event.currentTarget); }, { 'data-focus-key': 'import-bookmarks' })]);
    var list = n('ul', { class: 'record-list content-section' });
    data.workspaces.forEach(function(workspace) {
      var live = data.tabs.filter(function(row) { return row.workspaceId === workspace.id; });
      var item = n('li', { class: 'record', 'data-record-key': 'workspace-' + workspace.id });
      item.append(n('div', { class: 'record-heading' }, [n('h2', { text: workspace.name }), n('span', { class: 'row-state', text: workspace.id === data.currentWorkspaceId ? 'Current' : workspace.hibernated ? 'Hibernated' : 'Available' })]), n('p', { class: 'muted', text: live.length + ' open tabs; ' + (workspace.savedTabs || []).length + ' saved entries. ' + (workspace.policy && workspace.policy.suspendMinutes != null ? 'Inactivity: ' + (workspace.policy.suspendMinutes === 0 ? 'never suspend' : workspace.policy.suspendMinutes + ' min') + '.' : 'Inherits global inactivity policy.') }));
      item.appendChild(n('div', { class: 'button-row' }, [
        b('View tabs', function() { navigate('tabs', workspace.id); }, { 'data-focus-key': 'workspace-view-' + workspace.id }),
        b('Switch here', function(event) { workspaceTransition(workspace, 'switch', event.currentTarget); }, { class: 'primary', 'data-focus-key': 'workspace-switch-' + workspace.id }),
        b('Hibernate', function(event) { workspaceTransition(workspace, 'hibernate', event.currentTarget); }, { 'data-focus-key': 'workspace-hibernate-' + workspace.id }),
        b('Edit rules', function(event) { workspaceEditor = buildWorkspaceEditor(workspace, event.currentTarget); renderWorkspaces(); workspaceEditor.querySelector('input').focus(); }, { 'data-focus-key': 'workspace-edit-' + workspace.id }),
        b('Export bookmarks', function(event) { openBookmarkPicker('export', workspace, event.currentTarget); }, { 'data-focus-key': 'workspace-export-' + workspace.id }),
        b('Delete', function(event) { deleteWorkspace(workspace, event.currentTarget); }, { class: 'danger', 'data-focus-key': 'workspace-delete-' + workspace.id })
      ]));
      if (live.length) item.appendChild(savedTabsDetails(live, 'Open tabs'));
      if ((workspace.savedTabs || []).length) item.appendChild(savedTabsDetails(workspace.savedTabs, 'Saved entries'));
      list.appendChild(item);
    });
    content.replaceChildren(toolbar);
    if (params.get('startup') === 'choose') content.appendChild(n('div', { class: 'notice', text: 'Choose a workspace for this browser session. “Switch here” restores it and safely hibernates eligible tabs in other workspaces. Protected work stays open.' }));
    if (workspaceEditor) content.appendChild(workspaceEditor);
    if (bookmarkPanel) content.appendChild(bookmarkPanel);
    if (transitionPanel) content.appendChild(transitionPanel);
    content.appendChild(data.workspaces.length ? list : empty('A workspace keeps a task together', 'Create one, then select tabs and use Workspace in the inspector to assign them. Or import a real bookmark folder.'));
  }
  async function workspaceTransition(workspace, type, trigger) {
    var ids = type === 'hibernate' ? data.tabs.filter(function(row) { return row.workspaceId === workspace.id && !row.asleep; }).map(function(row) { return row.id; }) : data.tabs.filter(function(row) { return row.workspaceId && row.workspaceId !== workspace.id && !row.asleep; }).map(function(row) { return row.id; });
    trigger.disabled = true;
    try {
      var preview = await C.request('action.preview', { action: 'suspend', tabIds: ids, options: { allowActive: true } });
      var panel = n('section', { class: 'editor-panel' }, [n('h2', { text: type === 'hibernate' ? 'Hibernate ' + workspace.name : 'Switch to ' + workspace.name }), n('p', { text: (preview.eligible || []).length + ' tabs can sleep; ' + (preview.skipped || []).length + ' protected tabs will stay awake.' }), skipList(preview.skipped), n('p', { class: 'muted', text: type === 'switch' ? 'This workspace will be restored with its tab organization. Unassigned tabs remain untouched.' : 'Tab URLs and organization stay saved in the workspace.' })]);
      panel._trigger = trigger;
      panel.appendChild(n('div', { class: 'button-row' }, [b(type === 'switch' ? 'Switch workspace' : 'Hibernate workspace', async function(event) {
        var result = await operation('workspace.' + type, { id: workspace.id }, event.currentTarget, 'Workspace ' + (type === 'switch' ? 'switched.' : 'hibernated.'));
        if (result) { C.renderResult(panel, result, 'Workspace updated.'); panel.appendChild(b('Dismiss', function() { closeInlinePanel(panel); })); }
      }, { class: 'primary' }), b('Cancel', function() { closeInlinePanel(panel); })]));
      transitionPanel = panel; renderWorkspaces();
    } catch (error) { failed(error); }
    finally { if (trigger.isConnected) trigger.disabled = false; }
  }
  async function deleteWorkspace(workspace, trigger) {
    var targets = [['unassigned', 'Unassigned (closed entries go to Archive)']].concat(data.workspaces.filter(function(item) { return item.id !== workspace.id; }).map(function(item) { return [item.id, item.name]; }));
    var reassign = C.select(targets, 'unassigned');
    if (!await C.confirm({ title: 'Delete ' + workspace.name + '?', text: 'Open tabs stay open. Choose where to move this workspace’s open and saved tabs.', detail: C.field('Reassign members to', reassign), accept: 'Delete workspace', destructive: true })) return;
    operation('workspace.delete', { id: workspace.id, reassignToId: reassign.value === 'unassigned' ? null : reassign.value }, trigger, 'Workspace deleted; tabs reassigned.');
  }
  function folderOptions(tree) {
    var folders = [];
    function visit(node, path) {
      if (node.url) return;
      var title = node.title || (node.id === '0' ? 'Bookmarks' : 'Untitled folder');
      var next = path.concat(title);
      if (node.id !== '0') folders.push([node.id, next.join(' / ')]);
      (node.children || []).forEach(function(child) { visit(child, next); });
    }
    tree.forEach(function(root) { visit(root, []); });
    return folders;
  }
  async function openBookmarkPicker(mode, workspace, trigger) {
    trigger.disabled = true;
    try {
      var response = await C.request('bookmarks.tree');
      var tree = Array.isArray(response) ? response : response.tree;
      if (!Array.isArray(tree)) throw new Error('The browser returned no bookmark tree.');
      var options = folderOptions(tree);
      if (!options.length) throw new Error('No bookmark folders are available. Create a folder in the browser’s bookmark manager first.');
      var folder = C.select(options, options[0][0], { 'data-focus-key': 'bookmark-folder' });
      var name = n('input', { type: 'text', required: '', maxlength: '100', value: workspace ? workspace.name : '', 'data-focus-key': 'bookmark-name' });
      var form = n('form');
      var submit = n('button', { type: 'submit', class: 'primary', text: mode === 'import' ? 'Import folder' : 'Export workspace' });
      form.append(C.field(mode === 'import' ? 'Bookmark folder to import' : 'Destination bookmark folder', folder), C.field(mode === 'import' ? 'New workspace name' : 'New bookmark folder name', name), n('p', { class: 'muted', text: mode === 'import' ? 'Imports real bookmark URLs into a new workspace and keeps nested folder grouping. It does not delete bookmarks.' : 'Creates a real folder inside the chosen destination. Existing bookmarks stay untouched.' }), n('div', { class: 'button-row' }, [submit, b('Cancel', function() { closeInlinePanel(panel); })]));
      form.addEventListener('submit', async function(event) {
        event.preventDefault();
        var payload = mode === 'import' ? { folderId: folder.value, name: name.value.trim() } : { id: workspace.id, parentId: folder.value, name: name.value.trim() };
        var result = await operation('bookmarks.' + mode, payload, submit, 'Bookmarks ' + (mode === 'import' ? 'imported.' : 'exported.'));
        if (result) {
          C.renderResult(bookmarkPanel, result, mode === 'import' ? result.imported + ' bookmark tabs imported.' : result.created + ' bookmarks exported.');
          bookmarkPanel.appendChild(b('Done', function() { closeInlinePanel(panel); }));
        }
      });
      var panel = n('section', { class: 'editor-panel', 'data-record-key': 'bookmarks-' + mode + '-' + (workspace ? workspace.id : 'new') }, [n('h2', { text: mode === 'import' ? 'Import bookmark folder' : 'Export ' + workspace.name }), form]);
      panel._trigger = trigger;
      bookmarkPanel = panel;
      renderWorkspaces(); folder.focus();
    } catch (error) { failed(error); }
    finally { if (trigger.isConnected) trigger.disabled = false; }
  }
  function renderArchive() {
    var list = n('ul', { class: 'record-list' });
    (data.archive || []).slice().reverse().forEach(function(entry) {
      var item = n('li', { class: 'record', 'data-record-key': 'archive-' + entry.id });
      item.append(n('h2', { text: entry.label || 'Archived tabs' }), n('p', { class: 'muted', text: C.date(entry.createdAt) + '; ' + entry.tabs.length + ' tabs' + (entry.reason ? '; ' + entry.reason : '') }), savedTabsDetails(entry.tabs), n('div', { class: 'button-row' }, [b('Restore archive', function(event) { operation('archive.restore', { id: entry.id }, event.currentTarget, 'Archive restored.'); }, { class: 'primary', 'data-focus-key': 'archive-restore-' + entry.id }), b('Delete saved archive', async function(event) {
        var trigger = event.currentTarget;
        if (await C.confirm({ title: 'Delete saved archive?', text: 'This removes the locally saved URLs. It does not close open tabs and cannot be undone.', accept: 'Delete archive', destructive: true })) operation('archive.delete', { id: entry.id }, trigger, 'Saved archive deleted.');
      }, { class: 'danger', 'data-focus-key': 'archive-delete-' + entry.id })]));
      list.appendChild(item);
    });
    replaceView('archive', [(data.archive || []).length ? list : empty('Your archive is empty', 'Select tabs in any review queue, then preview Archive in the inspector. Protected work stays open.')]);
  }
  function snapshotValue(row, field) {
    if (!row) return 'Not present';
    if (field === 'status') return row.status || (row.asleep ? 'Suspended' : 'Awake');
    if (field === 'url' || field === 'originalUrl') return row.originalUrl || row.url;
    if (field === 'window') return Number.isInteger(row.windowOrdinal) ? 'Window ' + (row.windowOrdinal + 1) : 'Browser window ' + row.windowId;
    if (field === 'index') return Number(row.index) + 1;
    if (field === 'workspace') {
      var id = row.workspaceId || row.meta && row.meta.workspaceId;
      var workspace = data.workspaces.find(function(item) { return item.id === id; });
      return workspace ? workspace.name : id ? row.workspaceName || 'Workspace ' + id : 'Unassigned';
    }
    if (field === 'snooze' || field === 'protection') {
      var protection = row.meta && row.meta[field] || row[field];
      return protection ? (protection.kind ? protection.kind + ': ' : '') + C.expiry(protection) : 'None';
    }
    var value = field === 'expiresAt' ? row.meta && row.meta.expiresAt || row.expiresAt : field.split('.').reduce(function(current, key) { return current && current[key]; }, row);
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (/At$/.test(field) && typeof value === 'number') return C.date(value);
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  function renderSnapshots() {
    var wasSnapshots = currentContent === 'snapshots';
    if (!wasSnapshots) { comparePanel = null; content.replaceChildren(); currentContent = 'snapshots'; }
    var label = n('input', { type: 'text', maxlength: '100', placeholder: 'Optional snapshot name', 'data-focus-key': 'snapshot-label' });
    var oldLabel = content.querySelector('[data-focus-key="snapshot-label"]'); if (oldLabel) label.value = oldLabel.value;
    var create = b('Save snapshot', function(event) { operation('snapshot.create', { label: label.value.trim() }, event.currentTarget, 'Snapshot saved locally.'); }, { class: 'primary', 'data-focus-key': 'snapshot-create' });
    var createForm = n('div', { class: 'form-grid' }, [C.field('Save your current browser session', label), n('div', { class: 'button-row' }, [create, n('a', { href: 'options.html#snapshots', text: 'Scheduled snapshots' })])]);
    var snapshots = (data.snapshots || []).slice().sort(function(a, b) { return b.createdAt - a.createdAt; });
    var list = n('ul', { class: 'record-list content-section' });
    snapshots.forEach(function(snapshot) {
      var item = n('li', { class: 'record', 'data-record-key': 'snapshot-' + snapshot.id });
      item.append(n('h2', { text: snapshot.label || 'Browser snapshot' }), n('p', { class: 'muted', text: C.date(snapshot.createdAt) + '; ' + snapshot.tabs.length + ' tabs; ' + snapshot.reason }), savedTabsDetails(snapshot.tabs), n('div', { class: 'button-row' }, [
        b('Restore saved state', function(event) { restoreSnapshot(snapshot, undefined, event.currentTarget); }, { 'data-focus-key': 'snapshot-restore-' + snapshot.id }),
        b('Restore asleep', function(event) { restoreSnapshot(snapshot, true, event.currentTarget); }, { 'data-focus-key': 'snapshot-asleep-' + snapshot.id }),
        b('Restore awake', function(event) { restoreSnapshot(snapshot, false, event.currentTarget); }, { 'data-focus-key': 'snapshot-awake-' + snapshot.id }),
        b('Delete', async function(event) {
          var trigger = event.currentTarget;
          if (await C.confirm({ title: 'Delete snapshot?', text: 'This removes the saved snapshot, not your current tabs. Deletion cannot be undone.', accept: 'Delete snapshot', destructive: true })) operation('snapshot.delete', { id: snapshot.id }, trigger, 'Snapshot deleted.');
        }, { class: 'danger', 'data-focus-key': 'snapshot-delete-' + snapshot.id })
      ]));
      list.appendChild(item);
    });
    content.replaceChildren(createForm);
    if (snapshots.length >= 2) {
      var options = snapshots.map(function(snapshot) { return [snapshot.id, (snapshot.label || 'Snapshot') + ' (' + C.date(snapshot.createdAt) + ')']; });
      if (!snapshots.some(function(snapshot) { return snapshot.id === snapshotSelection.before; })) snapshotSelection.before = snapshots[1].id;
      if (!snapshots.some(function(snapshot) { return snapshot.id === snapshotSelection.after; })) snapshotSelection.after = snapshots[0].id;
      var before = C.select(options, snapshotSelection.before, { 'data-focus-key': 'compare-before' }), after = C.select(options, snapshotSelection.after, { 'data-focus-key': 'compare-after' });
      before.addEventListener('change', function() { snapshotSelection.before = before.value; }); after.addEventListener('change', function() { snapshotSelection.after = after.value; });
      content.appendChild(n('section', { class: 'content-section' }, [n('h2', { text: 'Compare snapshots' }), n('div', { class: 'compare-controls' }, [C.field('Before', before), C.field('After', after), b('Compare', async function(event) {
        if (before.value === after.value) return say('Choose two different snapshots.', 'error');
        var trigger = event.currentTarget; trigger.disabled = true;
        try {
          var diff = await C.request('snapshot.compare', { beforeId: before.value, afterId: after.value });
          comparePanel = n('section', { class: 'editor-panel' }, [n('h2', { text: 'Snapshot comparison' }), n('p', { text: diff.added.length + ' added; ' + diff.removed.length + ' removed; ' + diff.changed.length + ' changed; ' + diff.unchangedCount + ' unchanged.' })]);
          comparePanel._trigger = trigger;
          [['Added', diff.added], ['Removed', diff.removed]].forEach(function(pair) { if (pair[1].length) comparePanel.appendChild(details(pair[0], [n('ul', { class: 'record-tabs' }, pair[1].map(function(row) { return n('li', { text: tabTitle(row) + ' — ' + (row.originalUrl || row.url) }); }))])); });
          if (diff.changed.length) comparePanel.appendChild(details('Changed', [n('ul', { class: 'record-tabs' }, diff.changed.map(function(change) {
            return n('li', {}, [n('strong', { text: tabTitle(change.after || change.before) }), n('ul', {}, (change.fields || []).map(function(field) { return n('li', { text: field + ': ' + snapshotValue(change.before, field) + ' → ' + snapshotValue(change.after, field) }); }))]);
          }))]));
          comparePanel.appendChild(b('Dismiss', function() { closeInlinePanel(comparePanel); }, { 'data-focus-key': 'dismiss-snapshot-comparison' }));
          preserveFocus(renderSnapshots);
        } catch (error) { failed(error); }
        finally { if (trigger.isConnected) trigger.disabled = false; if (document.activeElement === document.body) restoreTrigger(trigger); }
      }, { 'data-focus-key': 'compare-snapshots' })]) ]));
    }
    if (comparePanel) content.appendChild(comparePanel);
    content.appendChild(snapshots.length ? list : empty('No snapshots saved yet', 'Save your real current session above or enable a local snapshot schedule in Settings.'));
  }
  async function restoreSnapshot(snapshot, asleep, trigger) {
    var panel = n('section', { class: 'editor-panel' }, [n('h2', { text: 'Restore ' + (snapshot.label || 'snapshot') }), n('p', { text: snapshot.tabs.length + ' saved tabs will be matched or recreated, preserving unrelated open work. ' + (asleep === undefined ? 'Each tab keeps its saved suspension state.' : asleep ? 'Restored tabs will stay asleep.' : 'Restored tabs will be awake.') }), n('p', { class: 'muted', text: 'Restoration uses the throttle configured in Settings. It restores URLs and organization, not unsaved page state. Protected or changed pages are retained.' })]);
    panel._trigger = trigger;
    panel.appendChild(n('div', { class: 'button-row' }, [b('Restore snapshot', async function(event) {
      var payload = { id: snapshot.id }; if (asleep !== undefined) payload.asleep = asleep;
      var result = await operation('snapshot.restore', payload, event.currentTarget, 'Snapshot restored.');
      if (result) { comparePanel = n('section', { class: 'editor-panel' }); comparePanel._trigger = trigger; C.renderResult(comparePanel, result, 'Snapshot restored.'); comparePanel.appendChild(b('Dismiss', function() { closeInlinePanel(comparePanel); })); renderSnapshots(); }
    }, { class: 'primary' }), b('Cancel', function() { closeInlinePanel(panel); })]));
    comparePanel = panel; renderSnapshots();
  }
  function renderTimeline() {
    var terms = route.query.toLocaleLowerCase();
    var events = (data.timeline || []).slice().reverse().filter(function(event) { return !terms || [event.type, event.title, event.url, event.reason, workspaceName(event.workspaceId)].join(' ').toLocaleLowerCase().includes(terms); });
    var table = n('table', { class: 'data-table' }, [n('thead', {}, [n('tr', {}, [n('th', { text: 'When' }), n('th', { text: 'Event / tab' }), n('th', { text: 'Reason' })])])]);
    var body = n('tbody');
    events.slice(0, timelineLimit).forEach(function(event) { body.appendChild(n('tr', {}, [n('td', { class: 'timeline-time', text: C.date(event.at) }), n('td', {}, [n('strong', { text: event.type }), n('div', { text: event.title || 'Browser operation' }), n('small', { text: event.url || '' })]), n('td', { text: event.reason || 'Browser activity' })])); });
    table.appendChild(body);
    var children = [n('p', { class: 'muted', text: Math.min(events.length, timelineLimit) + ' of ' + events.length + ' recorded events' }), events.length ? table : empty('No matching events', 'Lifecycle events are recorded locally as you use your browser. Clear search to see all recorded events.')];
    if (events.length > timelineLimit) children.push(b('Show older events', function() { timelineLimit += 100; preserveFocus(renderTimeline); }, { 'data-focus-key': 'older-events' }));
    replaceView('timeline', children);
  }
  function metricList(rows) { var list = n('dl', { class: 'metric-list' }); rows.forEach(function(row) { list.append(n('dt', { text: row[0] }), n('dd', { text: row[1] })); }); return list; }
  function activityTable(rows, nameKey, valueKey) {
    var table = n('table', { class: 'data-table' }, [n('thead', {}, [n('tr', {}, [n('th', { text: nameKey === 'domain' ? 'Website' : 'Workspace' }), n('th', { text: 'Foreground-active time' })])])]);
    var body = n('tbody');
    rows.forEach(function(row) { body.appendChild(n('tr', {}, [n('td', { text: nameKey === 'domain' ? row.domain : row.name || workspaceName(row.workspaceId) }), n('td', { text: C.duration(row[valueKey] || 0) })])); });
    table.appendChild(body); return table;
  }
  function renderInsights() {
    var metrics = data.metrics || {}, activity = metrics.activity || {}, memory = data.memory || {};
    var latency = metrics.restoreAverageMs;
    if (latency === undefined && metrics.restoreSamples) latency = metrics.restoreLatencyMs / metrics.restoreSamples;
    var children = [n('h2', { text: 'Suspension policy' }), metricList([
      ['Currently awake', data.tabs.filter(function(row) { return !row.asleep; }).length],
      ['Currently suspended / discarded', data.tabs.filter(function(row) { return row.asleep; }).length],
      ['Recorded suspensions', metrics.suspensions || 0], ['Recorded restorations', metrics.restorations || 0],
      ['Time tabs spent asleep (combined)', C.duration(metrics.sleepMs || 0)],
      ['Average measured restore latency', metrics.restoreSamples ? Math.round(latency) + ' ms (' + metrics.restoreSamples + ' samples)' : 'No completed restores yet'],
      ['Recorded archives', metrics.archives || 0], ['Recorded closes', metrics.closes || 0],
      ['Recorded protected-tab skips', metrics.protectionSkips || 0]
    ]), n('p', { class: 'muted', text: 'Counts start when local recording begins. Combined sleep time can exceed wall-clock time because several tabs can sleep together. No RAM reduction is inferred.' })];
    var reasons = Object.keys(metrics.protectionReasons || {});
    var protectionSection = n('section', { class: 'content-section' }, [n('h2', { text: 'Why tabs were skipped' })]);
    protectionSection.appendChild(reasons.length ? metricList(reasons.map(function(reason) { return [reason, metrics.protectionReasons[reason]]; })) : n('p', { class: 'muted', text: 'No protection skips have been recorded yet.' }));
    children.push(protectionSection);
    var activitySection = n('section', { class: 'content-section' }, [n('h2', { text: 'Foreground activity' }), n('p', { class: 'muted', text: 'Measured while a browser tab is active in the focused window and the browser is not idle. This is not inferred attention. Rolling ' + (activity.days || 90) + '-day local history.' })]);
    if ((activity.byDomain || []).length) activitySection.append(n('h3', { text: 'By website' }), activityTable(activity.byDomain, 'domain', 'ms'));
    if ((activity.byWorkspace || []).length) activitySection.append(n('h3', { text: 'By workspace' }), activityTable(activity.byWorkspace, 'name', 'ms'));
    if (!(activity.byDomain || []).length && !(activity.byWorkspace || []).length) activitySection.appendChild(n('p', { class: 'muted', text: 'Foreground intervals will appear after you spend time in a normal browser tab.' }));
    activitySection.appendChild(b('Refresh activity measurements', function(event) { operation('activity.get', {}, event.currentTarget, 'Activity measurements refreshed.'); }));
    children.push(activitySection, n('section', { class: 'content-section' }, [n('h2', { text: 'Neglected review' }), n('p', { class: 'muted', text: (data.neglected || []).length + ' tabs have not been viewed for at least ' + data.settings.neglectedDays + ' days. Nothing is closed automatically.' }), b('Review neglected tabs', function() { navigate('neglected'); }), n('a', { class: 'button-link', href: 'options.html#review', text: 'Change review threshold' })]), n('section', { class: 'content-section' }, [n('h2', { text: 'Optional macOS memory pressure' }), n('p', { class: 'muted', text: 'Helper: ' + (memory.connected ? 'connected' : 'not connected') + '; pressure: ' + (memory.level || 'unknown') + (memory.checkedAt ? '; checked ' + C.date(memory.checkedAt) : '. Not checked yet.') }), n('a', { class: 'button-link', href: 'options.html#memory', text: 'Native helper settings & installation' })]));
    replaceView('insights', children);
  }

  search.value = route.query; statusFilter.value = route.status;
  search.addEventListener('input', function() { route.query = search.value; saveRoute(); preserveFocus(render); });
  statusFilter.addEventListener('change', function() { route.status = statusFilter.value; saveRoute(); render(); });
  windowFilter.addEventListener('change', function() { route.window = windowFilter.value; saveRoute(); render(); });
  document.getElementById('refresh-button').addEventListener('click', refresh);
  undoButton.addEventListener('click', function(event) { operation('action.undo', {}, event.currentTarget, 'Last action undone. Unsaved application state is not restored.'); });
  document.addEventListener('keydown', function(event) {
    C.searchKeys(event, search);
    if (event.key !== 'Escape' || event.defaultPrevented || busy || document.querySelector('dialog[open]')) return;
    if (previewBox && previewBox.isConnected && !previewBox.hidden) {
      event.preventDefault(); previewBox.hidden = true; restoreTrigger(previewTrigger); return;
    }
    var panels = [workspaceEditor, bookmarkPanel, transitionPanel, comparePanel].filter(function(panel) { return panel && panel.isConnected; });
    var panel = panels.find(function(item) { return item.contains(event.target); }) || panels[panels.length - 1];
    if (panel) { event.preventDefault(); closeInlinePanel(panel); }
  });
  C.subscribe(refresh);
  var refreshInterval = setInterval(function() { if (!document.hidden) refresh(); }, 15000);
  window.addEventListener('pagehide', function() { clearInterval(refreshInterval); });
  window.addEventListener('focus', refresh);
  refresh();
})();
