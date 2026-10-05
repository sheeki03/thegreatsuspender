/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient;
  var privateContext = !!(chrome.extension && chrome.extension.inIncognitoContext);
  var SUSPENDED_PAGE = chrome.runtime.getURL('suspended.html');
  // Reasons that are either implied by acting from the popup (the active tab is
  // allowed) or already shown by the keep-awake status line.
  var IGNORED_SKIPS = ['already-asleep', 'already-awake'];
  var UNSAVED_REASON = 'Unsaved form or editable content';

  var browserTabs = [], rawCurrent = null, highlightedIds = [], forceTabs = [], forceExplicit = false;
  var data = null, current = null, whitelisted = false;
  var busy = false, loading = false, refreshAgain = false;

  function $(id) { return document.getElementById(id); }
  var els = {
    favicon: $('current-favicon'), title: $('current-title'), site: $('current-site'), state: $('current-state'),
    primary: $('primary-action'), primaryLabel: $('primary-label'), primaryIcon: $('primary-icon'), shortcut: $('primary-shortcut'),
    note: $('current-note'), keepAwake: $('keep-awake'), keepAwakeLabel: $('keep-awake-label'), keepAwakeOptions: $('keep-awake-options'),
    keepAwakeStatus: $('keep-awake-status'), keepAwakeText: $('keep-awake-text'), keepAwakeEnd: $('keep-awake-end'),
    snoozeHour: $('snooze-hour'), snoozeRestart: $('snooze-restart'), neverSite: $('never-site'),
    othersSuspend: $('others-suspend'), othersWake: $('others-wake'), othersCount: $('others-count'),
    result: $('result'), resultText: $('result-text'), resultDetails: $('result-details'), resultSummary: $('result-summary'),
    resultReasons: $('result-reasons'), undo: $('undo'), force: $('force'), search: $('search'),
  };

  // Tab facts the popup can read straight from the browser, before the engine answers.
  function isSuspendedUrl(url) { return typeof url === 'string' && url.indexOf(SUSPENDED_PAGE) === 0; }
  function hashValue(url, key) {
    var hash = url.indexOf('#') >= 0 ? url.slice(url.indexOf('#') + 1) : '';
    var uri = hash.indexOf('uri=');
    if (key === 'uri') return uri >= 0 ? hash.slice(uri + 4) : '';
    if (uri >= 0) hash = hash.slice(0, uri);
    var pair = hash.split('&').find(function(item) { return item.indexOf(key + '=') === 0; });
    try { return pair ? decodeURIComponent(pair.slice(key.length + 1)) : ''; } catch (error) { return ''; }
  }
  function facts(tab) {
    var suspended = isSuspendedUrl(tab.url);
    var url = suspended ? hashValue(tab.url, 'uri') || hashValue(tab.url, 'url') : tab.url || tab.pendingUrl || '';
    return {
      id: tab.id, windowId: tab.windowId, url: url,
      title: (suspended ? hashValue(tab.url, 'ttl') : tab.title) || url || 'Untitled tab',
      asleep: suspended || !!tab.discarded,
      sleepable: suspended || /^(https?|file):/i.test(url),
    };
  }
  function site(url) {
    try {
      var parsed = new URL(url);
      if (parsed.protocol === 'file:') return 'Local file';
      if (!/^https?:$/.test(parsed.protocol)) return '';
      return parsed.hostname.replace(/^www\./, '') || url;
    } catch (error) { return url || ''; }
  }
  function plural(count, word) { return count + ' ' + word + (count === 1 ? '' : 's'); }

  function currentFacts() { return rawCurrent ? facts(rawCurrent) : null; }
  function selectedFacts() {
    return browserTabs.filter(function(tab) { return highlightedIds.includes(tab.id); }).map(facts).filter(function(tab) { return tab.sleepable; });
  }
  function otherFacts() {
    var scope = document.querySelector('input[name="scope"]:checked').value;
    return browserTabs.map(facts).filter(function(tab) {
      return tab.sleepable && (!rawCurrent || tab.id !== rawCurrent.id) && (scope === 'all' || !rawCurrent || tab.windowId === rawCurrent.windowId);
    });
  }

  // The primary action follows the browser selection: one tab, or every highlighted tab.
  function primaryPlan() {
    var tab = currentFacts();
    var selected = selectedFacts();
    if (selected.length > 1) {
      var awake = selected.filter(function(row) { return !row.asleep; });
      return awake.length ?
        { action: 'suspend', tabs: awake, label: 'Suspend ' + awake.length + ' selected tabs' } :
        { action: 'restore', tabs: selected, label: 'Wake ' + selected.length + ' selected tabs' };
    }
    if (!tab || !tab.sleepable) return null;
    return tab.asleep ?
      { action: 'restore', tabs: [tab], label: 'Wake this tab' } :
      { action: 'suspend', tabs: [tab], label: 'Suspend this tab' };
  }

  function keepAwakeState() {
    var tab = currentFacts();
    if (!tab || !tab.sleepable) return null;
    if (whitelisted) return { text: 'Always awake on ' + site(tab.url), end: 'whitelist' };
    if (current && current.snooze) return { text: 'Kept awake ' + until(current.snooze), end: 'snooze' };
    return null;
  }
  function until(value) {
    if (value.session) return 'until the browser restarts';
    if (!value.until) return 'until you turn it off';
    var date = new Date(value.until), today = new Date();
    var time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return date.toDateString() === today.toDateString() ? 'until ' + time : 'until ' + date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
  }

  function render() {
    var tab = currentFacts();
    var plan = primaryPlan();
    var keep = keepAwakeState();

    els.title.textContent = tab ? (current && current.title) || tab.title : 'No tab selected';
    els.title.title = els.title.textContent;
    els.site.textContent = tab ? site(tab.url) : '';
    if (tab && tab.url) { els.favicon.src = legacyUi.favicon(tab.url); els.favicon.hidden = false; }
    else els.favicon.hidden = true;

    var stateText = '', stateClass = '';
    if (tab && !tab.sleepable) stateText = 'Browser page';
    else if (tab && tab.asleep) { stateText = 'Asleep'; stateClass = 'is-asleep'; }
    else if (tab && keep) { stateText = 'Kept awake'; stateClass = 'is-kept'; }
    else if (tab) { stateText = 'Awake'; stateClass = 'is-awake'; }
    els.state.textContent = stateText;
    els.state.className = 'current-state ' + stateClass;

    els.primary.hidden = !plan;
    // When the page already reported typing, the button itself is the confirmation.
    var unsaved = !!current && current.id === (tab && tab.id) && !current.asleep && (current.protectionReasons || []).includes(UNSAVED_REASON);
    if (plan) {
      els.primaryLabel.textContent = plan.tabs.length === 1 && plan.action === 'suspend' && unsaved ? 'Suspend anyway' : plan.label;
      els.primaryIcon.setAttribute('href', plan.action === 'suspend' ? '#i-moon' : '#i-sun');
      els.shortcut.hidden = !els.shortcut.textContent || plan.tabs.length > 1;
    }

    // Suspending a tab yourself overrides keep-awake rules; only unsaved typing asks first.
    if (plan) els.primary.disabled = busy;
    if (tab && !tab.sleepable) showNote('Browser pages can’t be suspended. You can still put the other tabs to sleep.', true);
    else if (plan && plan.tabs.length === 1 && unsaved) showNote('You’ve typed something on this page that may not be saved. Suspending will lose it.');
    else showNote('');

    var showKeepAwake = !!tab && tab.sleepable && (!tab.asleep || !!keep) && (!plan || plan.tabs.length === 1);
    els.keepAwake.hidden = !showKeepAwake;
    els.keepAwakeStatus.hidden = !keep;
    els.keepAwakeLabel.hidden = els.keepAwakeOptions.hidden = !!keep;
    if (keep) { els.keepAwakeText.textContent = keep.text; els.keepAwakeEnd.dataset.end = keep.end; }
    els.keepAwakeEnd.disabled = busy || !data;
    els.snoozeHour.hidden = els.snoozeRestart.hidden = privateContext;
    els.snoozeHour.disabled = els.snoozeRestart.disabled = busy;
    els.neverSite.disabled = busy || !data || !/^https?:/i.test(tab && tab.url || '');
    els.neverSite.textContent = 'Always on this site';
    els.neverSite.title = tab && /^https?:/i.test(tab.url) ? 'Never suspend ' + site(tab.url) + ' automatically' : '';

    var others = otherFacts();
    var awakeOthers = others.filter(function(row) { return !row.asleep; }).length;
    els.othersCount.textContent = !others.length ? 'No other tabs here.' :
      awakeOthers === others.length ? plural(others.length, 'tab') + ', all awake' :
      !awakeOthers ? plural(others.length, 'tab') + ', all asleep' :
      plural(others.length, 'tab') + ' · ' + awakeOthers + ' awake · ' + (others.length - awakeOthers) + ' asleep';
    els.othersSuspend.disabled = busy || !awakeOthers;
    els.othersWake.disabled = busy || awakeOthers === others.length;
    // When the current tab can't sleep, "suspend the rest" becomes the main thing to do.
    els.othersSuspend.classList.toggle('primary', !plan);
  }

  function showNote(text, muted) {
    els.note.textContent = text;
    els.note.hidden = !text;
    els.note.classList.toggle('is-muted', !!muted);
  }

  function showResult(text, options) {
    options = options || {};
    els.result.hidden = false;
    els.result.classList.toggle('is-error', !!options.error);
    els.resultText.textContent = text;
    els.undo.hidden = !options.undo;
    forceTabs = options.forceTabs || [];
    els.force.hidden = !forceTabs.length;
    var skipped = options.skipped || [];
    els.resultDetails.hidden = !skipped.length;
    els.resultDetails.open = false;
    if (skipped.length) {
      els.resultSummary.textContent = skipped.length === 1 ? 'Why it stayed ' + (options.action === 'restore' ? 'asleep' : 'awake') : 'See why';
      els.resultReasons.replaceChildren.apply(els.resultReasons, skipped.map(function(row) {
        return C.node('li', {}, [C.node('strong', { text: row.title || row.originalUrl || row.url || 'Tab' }),
          C.node('span', { text: (row.reasons || [row.reason || 'Unavailable']).map(C.reasonText).join(', ') })]);
      }));
    }
  }

  function describe(action, result, tabs) {
    var detail = C.collectResults(result);
    var skipped = detail.skipped.filter(function(row) {
      return !(row.reasons || [row.reason]).every(function(reason) { return IGNORED_SKIPS.includes(reason); });
    });
    var changed = detail.changed.length;
    var verb = action === 'suspend' ? 'Suspended' : 'Woke';
    var stayed = action === 'suspend' ? 'stayed awake' : 'stayed asleep';
    var single = tabs.length === 1 && rawCurrent && tabs[0].id === rawCurrent.id;
    // Typing the page reported is the one protection a manual action can override.
    var unsaved = action === 'suspend' ? skipped.filter(function(row) { return (row.reasons || []).includes(UNSAVED_REASON); }) : [];
    var text;
    if (single && unsaved.length) {
      return { text: 'You’ve typed something on this page that may not be saved.', skipped: [], changed: changed, unsaved: unsaved };
    }
    if (single) {
      var why = skipped.length ? (skipped[0].reasons || [skipped[0].reason]).map(C.reasonText).join(', ') : detail.errors.length ? String(detail.errors[0].error || detail.errors[0].message || detail.errors[0]) : '';
      text = changed ? (action === 'suspend' ? 'This tab is asleep.' : 'This tab is awake again.') :
        'This tab ' + stayed + (why ? ': ' + why.charAt(0).toLowerCase() + why.slice(1) : '') + '.';
      return { text: text, skipped: [], changed: changed, unsaved: [] };
    }
    text = changed ? verb + ' ' + plural(changed, 'tab') + '.' : 'Nothing changed.';
    if (skipped.length) text += ' ' + plural(skipped.length, 'tab') + ' ' + stayed + '.';
    if (unsaved.length) text += ' ' + (unsaved.length === 1 ? 'One has' : unsaved.length + ' have') + ' unsaved typing.';
    if (detail.errors.length) text += ' ' + plural(detail.errors.length, 'error') + '.';
    return { text: text, skipped: skipped, changed: changed, unsaved: unsaved };
  }

  async function act(action, tabs, trigger, override) {
    if (busy || !tabs.length) return;
    busy = true;
    trigger.setAttribute('aria-busy', 'true');
    render();
    try {
      var ids = tabs.map(function(tab) { return tab.id; });
      // Every tab is re-checked for drafts, audio, pins and keep-awake rules as it runs,
      // so there is no separate preview step. Undo is the safety net.
      var result = await C.request(privateContext ? 'legacy.private.run' : 'action.run', {
        action: action, tabIds: ids, options: { allowActive: true, reason: 'popup', ignoreDrafts: !!(override && override.ignoreDrafts), explicit: !!(override && override.explicit) },
      });
      forceExplicit = !!(override && override.explicit);
      var outcome = describe(action, result, tabs);
      showResult(outcome.text, { skipped: outcome.skipped, action: action, undo: !privateContext && outcome.changed > 0,
        forceTabs: outcome.unsaved.map(function(row) { return { id: row.id }; }) });
    } catch (error) {
      showResult(error.message || String(error), { error: true });
    } finally {
      busy = false;
      trigger.removeAttribute('aria-busy');
      await refresh();
    }
  }

  async function command(name, payload, trigger, done) {
    if (busy) return;
    busy = true;
    trigger.setAttribute('aria-busy', 'true');
    render();
    try {
      var result = await C.request(name, payload);
      if (done) showResult(typeof done === 'function' ? done(result) : done);
      else els.result.hidden = true;
    } catch (error) {
      showResult(error.message || String(error), { error: true });
    } finally {
      busy = false;
      trigger.removeAttribute('aria-busy');
      await refresh();
    }
  }

  async function refresh() {
    if (loading) { refreshAgain = true; return; }
    loading = true;
    try {
      // Paint from the browser first; the engine's richer view can take a moment on a cold start.
      var tabs = (await C.api(chrome.tabs, 'query', [{ windowType: 'normal' }])).filter(function(tab) { return !!tab.incognito === privateContext; });
      browserTabs = tabs;
      rawCurrent = await C.api(chrome.tabs, 'query', [{ active: true, lastFocusedWindow: true }]).then(function(rows) { return rows[0] || null; });
      highlightedIds = tabs.filter(function(tab) { return tab.highlighted && rawCurrent && tab.windowId === rawCurrent.windowId; }).map(function(tab) { return tab.id; });
      render();

      if (privateContext) {
        var response = await Promise.all([C.request('view.get'), C.request('legacy.private.view')]);
        data = response[0];
        data.tabs = response[1].tabs;
        data.legacySettings = response[1].legacySettings;
      } else {
        data = await C.request('view.get');
      }
      C.theme(data.settings && data.settings.theme);
      current = rawCurrent ? data.tabs.find(function(row) { return row.id === rawCurrent.id; }) || null : null;
      var url = current ? current.originalUrl || current.url : rawCurrent ? facts(rawCurrent).url : '';
      whitelisted = url && /^(https?|file):/i.test(url) ? (await C.request('legacy.whitelist.check', { url: url })).matches : false;
      render();
    } catch (error) {
      showResult(error.message || String(error), { error: true });
    } finally {
      loading = false;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  async function loadShortcut() {
    try {
      var commands = await C.api(chrome.commands, 'getAll', []);
      var toggle = commands.find(function(item) { return item.name === '1-suspend-tab'; });
      els.shortcut.textContent = toggle && toggle.shortcut || '';
      els.shortcut.title = toggle && toggle.shortcut ? 'Keyboard shortcut' : '';
      render();
    } catch (error) { /* The shortcut hint is optional. */ }
  }

  async function open(path) {
    try { await C.openPage(path); window.close(); }
    catch (error) { showResult(error.message || String(error), { error: true }); }
  }

  function on(element, handler) { element.addEventListener('click', function(event) { handler(event.currentTarget); }); }

  on(els.primary, function(trigger) {
    var plan = primaryPlan();
    if (!plan) return;
    var anyway = els.primaryLabel.textContent === 'Suspend anyway';
    act(plan.action, plan.tabs, trigger, { explicit: true, ignoreDrafts: anyway });
  });
  on(els.othersSuspend, function(trigger) { act('suspend', otherFacts().filter(function(tab) { return !tab.asleep; }), trigger); });
  on(els.othersWake, function(trigger) { act('restore', otherFacts().filter(function(tab) { return tab.asleep; }), trigger); });
  on(els.snoozeHour, function(trigger) {
    if (rawCurrent) command('snooze.set', { tabIds: [rawCurrent.id], minutes: 60 }, trigger);
  });
  on(els.snoozeRestart, function(trigger) {
    if (rawCurrent) command('snooze.set', { tabIds: [rawCurrent.id], mode: 'restart' }, trigger);
  });
  on(els.neverSite, function(trigger) {
    var host;
    if (!rawCurrent || !data) return;
    try { host = new URL(facts(rawCurrent).url).hostname; } catch (error) { return; }
    var lines = (data.legacySettings.gsWhitelist || '').split(/\s+/).filter(Boolean);
    if (!lines.includes(host)) lines.push(host);
    command('legacy.update', { settings: { gsWhitelist: lines.join('\n') } }, trigger);
  });
  on(els.keepAwakeEnd, function(trigger) {
    if (!rawCurrent) return;
    var end = trigger.dataset.end;
    if (end === 'whitelist') command('legacy.whitelist.remove', { url: current ? current.originalUrl || current.url : facts(rawCurrent).url }, trigger);
    else command('snooze.clear', { tabIds: [rawCurrent.id] }, trigger);
  });
  on(els.force, function(trigger) { act('suspend', forceTabs, trigger, { ignoreDrafts: true, explicit: forceExplicit }); });
  on(els.undo, function(trigger) {
    command('action.undo', {}, trigger, function(result) {
      var changed = C.collectResults(result).changed.length;
      var text = changed ? 'Undone. ' + plural(changed, 'tab') + ' back as ' + (changed === 1 ? 'it was' : 'they were') + '.' : 'Nothing left to undo.';
      if (result && result.remaining > 0) text += ' ' + result.remaining + ' could not be restored yet.';
      return text;
    });
  });
  document.querySelectorAll('input[name="scope"]').forEach(function(input) { input.addEventListener('change', render); });
  on($('open-dashboard'), function() { open('dashboard.html'); });
  on($('open-settings'), function() { open('options.html'); });
  $('search-form').addEventListener('submit', function(event) {
    event.preventDefault();
    open('dashboard.html?view=tabs&q=' + encodeURIComponent(els.search.value.trim()));
  });
  document.addEventListener('keydown', function(event) { if (!privateContext) C.searchKeys(event, els.search); });

  if (privateContext) {
    // Private windows have no workbench, search or undo history.
    $('search-form').hidden = true;
    $('open-dashboard').hidden = true;
  }

  C.subscribe(refresh);
  loadShortcut();
  refresh();
})();
