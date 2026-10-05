/*global gsBrowser, gsWorkbench, gsStorage, gsStorageSettings, gsSession, gsIndexedDb, gsUtils, gsChrome, gsSuspendedTab, gsMessages, gsTabSuspendManager, tgs */
// eslint-disable-next-line no-unused-vars
var gsLegacyRpc = (function() {
  'use strict';

  function isPrivate(sender) {
    return !!(gsBrowser.extension.inIncognitoContext ||
      (sender && (sender.incognito || (sender.tab && sender.tab.incognito))));
  }

  function requireNormal(sender) {
    if (isPrivate(sender)) throw new Error('Session history, recovery and debugging are unavailable in private windows.');
  }

  function browserCall(namespace, method, ...args) {
    return new Promise((resolve, reject) => {
      gsBrowser[namespace][method](...args, result => {
        if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
        else resolve(result);
      });
    });
  }

  function normalizeTab(tab, sessionId) {
    const suspended = gsUtils.isSuspendedTab(tab, true);
    return {
      ...tab,
      ...(sessionId ? { sessionId } : {}),
      originalUrl: suspended ? gsUtils.getOriginalUrl(tab.url) : tab.url,
      title: suspended ? gsUtils.getSuspendedTitle(tab.url) || tab.title : tab.title || tab.url,
    };
  }

  function normalizeSession(session) {
    if (!session) return null;
    const windows = (session.windows || []).filter(window => !window.incognito).map(window => ({
      ...window,
      tabs: (window.tabs || []).filter(tab => !tab.incognito && !gsUtils.isInternalTab(tab))
        .map(tab => normalizeTab(tab, session.sessionId)),
    })).filter(window => window.tabs.length);
    return { ...session, windows };
  }

  async function getSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('A session ID is required.');
    return normalizeSession(await gsIndexedDb.fetchSessionBySessionId(sessionId));
  }

  function sessionName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a name for the session.');
    return name.trim();
  }

  async function saveNamedSession(session, name, overwrite, rename) {
    name = sessionName(name);
    const saved = await gsIndexedDb.fetchSavedSessions();
    const conflict = saved.find(item => item.name === name && item.sessionId !== (rename ? session.sessionId : null));
    if (conflict && !overwrite) throw new Error('A session with this name already exists.');
    const record = structuredClone(session);
    delete record.id;
    record.name = name;
    record.sessionId = rename && session.sessionId.startsWith('_')
      ? session.sessionId : conflict ? conflict.sessionId : '_' + crypto.randomUUID();
    record.date = new Date().toISOString();
    await gsIndexedDb.updateSession(record);
    if (rename && conflict && conflict.sessionId !== record.sessionId) {
      await gsIndexedDb.removeSessionFromHistory(conflict.sessionId);
    }
    return getSession(record.sessionId);
  }

  function registerNormal(command, handler) {
    gsWorkbench.register(command, (payload, sender) => {
      requireNormal(sender);
      return handler(payload, sender);
    });
  }

  async function requireSuspendedTab(payload, sender) {
    if (!sender || sender.id !== gsBrowser.runtime.id || !sender.tab ||
        !Number.isInteger(payload.tabId) || sender.tab.id !== payload.tabId ||
        typeof payload.url !== 'string' || sender.url !== payload.url) {
      throw new Error('Suspended page commands must come from the current suspended tab.');
    }
    const tab = await gsChrome.tabsGet(payload.tabId);
    if (!tab || tab.url !== payload.url || !gsUtils.isSuspendedTab(tab) ||
        !!tab.incognito !== isPrivate(sender)) {
      throw new Error('The suspended tab has changed or belongs to another browser context.');
    }
    return tab;
  }

  async function recoveryTabs() {
    const session = normalizeSession(await gsIndexedDb.fetchLastSession());
    if (!session) return [];
    const live = (await gsChrome.tabsQuery({})).filter(tab => !tab.incognito && !gsUtils.isInternalTab(tab))
      .map(tab => normalizeTab(tab));
    const tabs = [];
    for (const window of session.windows) {
      for (const tab of window.tabs) {
        let index = live.findIndex(current => current.id === tab.id && current.originalUrl === tab.originalUrl);
        if (index < 0) index = live.findIndex(current => current.originalUrl === tab.originalUrl);
        if (index >= 0) live.splice(index, 1);
        else tabs.push(tab);
      }
    }
    return tabs;
  }

  function requirePrivate(sender) {
    if (!gsBrowser.extension.inIncognitoContext || !isPrivate(sender)) {
      throw new Error('These legacy tab controls are available only in private windows.');
    }
  }

  function privateResponse(request, fallback) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), 3000);
      try { request(finish); }
      catch (_) { finish(fallback); }
    });
  }

  async function privateRow(tab) {
    const status = await privateResponse(resolve => tgs.calculateTabStatus(tab, null, resolve), gsUtils.STATUS_UNKNOWN);
    const reasonByStatus = {
      loading: 'Tab is still loading', special: 'Browser or extension page',
      blockedFile: 'Local file access is disabled', never: 'Automatic suspension is disabled',
      formInput: 'Form input protection', audible: 'Playing audio', active: 'Active tab',
      tempWhitelist: 'Temporarily excluded', pinned: 'Pinned tab', whitelisted: 'Never-suspend list',
      charging: 'Charging protection', noConnectivity: 'Offline protection',
      unknown: 'Tab state could not be verified',
    };
    return {
      ...normalizeTab(tab),
      status: gsUtils.isSuspendedTab(tab) ? 'suspended' : tab.discarded ? 'discarded' :
        tab.status === 'loading' ? 'loading' : 'awake',
      asleep: gsUtils.isSuspendedTab(tab) || !!tab.discarded,
      protectionReasons: reasonByStatus[status] ? [reasonByStatus[status]] : [],
    };
  }

  async function privatePreview(payload, sender) {
    requirePrivate(sender);
    if (!['suspend', 'restore'].includes(payload.action)) throw new Error('Choose suspend or restore.');
    if (!Array.isArray(payload.tabIds) || payload.tabIds.some(id => !Number.isInteger(id))) {
      throw new Error('Choose the private tabs to change.');
    }
    const requestedIds = [...new Set(payload.tabIds)];
    const tabs = (await gsChrome.tabsQuery({})).filter(tab => tab.incognito);
    const eligible = [];
    const skipped = [];
    const forceLevel = payload.options && payload.options.allowActive ? 1 : 2;
    const requested = new Set(requestedIds);
    const rows = new Map(await Promise.all(tabs.filter(tab => requested.has(tab.id))
      .map(async tab => [tab.id, await privateRow(tab)])));
    for (const id of requestedIds) {
      const tab = tabs.find(item => item.id === id);
      if (!tab) {
        skipped.push({ id, reasons: ['This private tab no longer exists.'] });
        continue;
      }
      const row = rows.get(id);
      let reasons = [];
      const expected = payload.options && Array.isArray(payload.options.expectedTabs)
        ? payload.options.expectedTabs.find(item => item.id === id) : null;
      if (expected && expected.originalUrl !== row.originalUrl) {
        reasons = ['Tab navigated after the preview.'];
      } else if (payload.action === 'restore') {
        if (!row.asleep) reasons = ['Tab is already awake.'];
      } else if (row.asleep) {
        reasons = ['Tab is already asleep.'];
      } else if (!gsTabSuspendManager.checkTabEligibilityForSuspension(tab, forceLevel)) {
        reasons = row.protectionReasons.filter(reason => reason !== 'Tab state could not be verified');
        if (!reasons.length) reasons = ['Protected by legacy suspension preferences.'];
      } else if (forceLevel >= 2 && !tab.discarded) {
        // Only what the page actually reports blocks; a page that can't answer is not dirty.
        const info = await privateResponse(resolve => {
          gsMessages.sendRequestInfoToContentScript(id, (error, value) => resolve(error ? null : value));
        }, null);
        if (info && (info.temporaryWhitelist || info.status === gsUtils.STATUS_TEMPWHITELIST)) {
          reasons = ['Temporarily excluded'];
        } else if (info && gsStorage.getOption(gsStorage.IGNORE_FORMS) &&
            (info.dirty || info.status === gsUtils.STATUS_FORMINPUT)) {
          reasons = ['Unsaved form or editable content'];
        }
      } else if (payload.action === 'suspend' && !tab.discarded && !(payload.options && payload.options.ignoreDrafts)) {
        // A tab chosen by hand still asks before losing typing the page reported.
        const info = await privateResponse(resolve => {
          gsMessages.sendRequestInfoToContentScript(id, (error, value) => resolve(error ? null : value));
        }, null);
        if (info && (info.dirty || info.status === gsUtils.STATUS_FORMINPUT)) reasons = ['Unsaved form or editable content'];
      }
      if (reasons.length) skipped.push({ ...row, reasons });
      else eligible.push(row);
    }
    return { action: payload.action, eligible, skipped, requested: requestedIds.length };
  }

  async function waitForPrivateTransition(tabId, predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const tab = await gsChrome.tabsGet(tabId);
      if (!tab || !tab.incognito) return false;
      if (predicate(tab)) return true;
      await gsUtils.setTimeout(50);
    }
    return false;
  }

  async function runPrivate(payload, sender) {
    const plan = await privatePreview(payload, sender);
    const changed = [];
    const skipped = plan.skipped.slice();
    const forceLevel = payload.options && payload.options.allowActive ? 1 : 2;
    for (const row of plan.eligible) {
      try {
        const tab = await gsChrome.tabsGet(row.id);
        if (!tab || !tab.incognito || normalizeTab(tab).originalUrl !== row.originalUrl) {
          skipped.push({ ...row, reasons: ['This private tab changed before the action.'] });
          continue;
        }
        let success;
        if (payload.action === 'suspend') {
          success = await gsTabSuspendManager.queueTabForSuspensionAsPromise(tab, forceLevel, {
            expectedOriginalUrl: tab.url,
          });
          if (success) success = await waitForPrivateTransition(tab.id,
            current => gsUtils.isSuspendedTab(current) || current.discarded);
        } else if (gsUtils.isSuspendedTab(tab)) {
          success = await tgs.unsuspendTab(tab);
          if (success) success = await waitForPrivateTransition(tab.id,
            current => !gsUtils.isSuspendedTab(current) && current.url === row.originalUrl);
        } else {
          success = await gsChrome.tabsReload(tab.id);
          if (success) success = await waitForPrivateTransition(tab.id, current => !current.discarded);
        }
        if (success) changed.push(tab.id);
        else skipped.push({ ...row, reasons: ['The browser did not complete the action, or protection changed.'] });
      } catch (error) {
        skipped.push({ ...row, reasons: [error.message || String(error)] });
      }
    }
    return { action: payload.action, changed, skipped,
      summary: 'Private tab controls use legacy suspension preferences. Workspace metadata, history and undo are not recorded.' };
  }

  function debugFlags() {
    return {
      debugInfo: gsUtils.isDebugInfo(),
      debugError: gsUtils.isDebugError(),
      discardInPlaceOfSuspend: !!gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND),
      useAlternateScreenCaptureLib: !!gsStorage.getOption(gsStorage.USE_ALT_SCREEN_CAPTURE_LIB),
    };
  }

  function currentNotice() {
    const version = gsBrowser.runtime.getManifest().version;
    if (!gsSession.isUpdated() || gsStorage.fetchNoticeVersion() === version) return null;
    return { version, text: gsBrowser.runtime.getManifest().name + ' was updated to version ' + version + '. Your session history and preferences remain stored locally.' };
  }

  async function initAsPromised() {
    gsWorkbench.register('legacy.private.view', async (payload, sender) => {
      requirePrivate(sender);
      const tabs = (await gsChrome.tabsQuery({})).filter(tab => tab.incognito);
      const window = await gsChrome.windowsGetLastFocused();
      const focusedTab = window && tabs.find(tab => tab.windowId === window.id && tab.active);
      return {
        tabs: await Promise.all(tabs.filter(tab => !gsUtils.isInternalTab(tab)).map(privateRow)),
        focusedTabId: focusedTab ? focusedTab.id : null,
        focusedWindowId: window ? window.id : null,
        focusedTab: focusedTab ? { id: focusedTab.id, title: focusedTab.title,
          url: focusedTab.url, windowId: focusedTab.windowId } : null,
        highlightedTabIds: tabs.filter(tab => tab.highlighted && window && tab.windowId === window.id).map(tab => tab.id),
        legacySettings: gsStorage.getSettings(),
      };
    });
    gsWorkbench.register('legacy.private.preview', privatePreview);
    gsWorkbench.register('legacy.private.run', runPrivate);
    gsWorkbench.register('legacy.info', (payload, sender) => ({
      version: gsBrowser.runtime.getManifest().version,
      incognito: isPrivate(sender),
      updateType: gsSession.getUpdateType(),
      updated: gsSession.isUpdated(),
    }));
    gsWorkbench.register('legacy.settings.get', (payload, sender) => ({
      settings: gsStorage.getSettings(),
      managedKeys: Object.values(gsStorageSettings).filter(gsStorage.isOptionManaged),
      incognito: isPrivate(sender),
    }));
    gsWorkbench.register('legacy.whitelist.check', payload => {
      if (typeof payload.url !== 'string') throw new Error('A page URL is required.');
      const whitelist = payload.whitelist === undefined
        ? gsStorage.getOption(gsStorage.WHITELIST) : payload.whitelist;
      if (typeof whitelist !== 'string') throw new Error('The whitelist must be text.');
      const matchingEntries = whitelist.split(/[\s\n]+/).filter(item => gsUtils.testForMatch(item, payload.url));
      return { matches: matchingEntries.length > 0, matchingEntries };
    });
    gsWorkbench.register('legacy.whitelist.remove', async (payload, sender) => {
      if (typeof payload.url !== 'string') throw new Error('A page URL is required.');
      const whitelist = gsStorage.getOption(gsStorage.WHITELIST);
      const value = whitelist.split(/[\s\n]+/).filter(item => item && !gsUtils.testForMatch(item, payload.url)).join('\n');
      return gsWorkbench.execute('legacy.update', { settings: { [gsStorage.WHITELIST]: value } }, sender);
    });
    gsWorkbench.register('legacy.whitelist.test', async (payload, sender) => {
      if (typeof payload.whitelist !== 'string') throw new Error('The whitelist must be text.');
      const tabs = (await gsChrome.tabsQuery({})).filter(tab => !!tab.incognito === isPrivate(sender) &&
        !gsUtils.isSpecialTab(tab)).map(tab => normalizeTab(tab));
      return { tabs: tabs.filter(tab => gsUtils.checkSpecificWhiteList(tab.originalUrl, payload.whitelist)) };
    });
    gsWorkbench.register('legacy.shortcuts.get', async () => ({
      commands: await browserCall('commands', 'getAll'),
      suspensionToggleHotkey: await tgs.getSuspensionToggleHotkey(),
    }));

    registerNormal('legacy.sessions.list', async () => {
      await gsSession.updateCurrentSession();
      const [current, saved] = await Promise.all([
        gsIndexedDb.fetchCurrentSessions(), gsIndexedDb.fetchSavedSessions(),
      ]);
      return { currentSessionId: gsSession.getSessionId(),
        current: current.map(normalizeSession), saved: saved.map(normalizeSession) };
    });
    registerNormal('legacy.sessions.get', payload => getSession(payload.sessionId));
    registerNormal('legacy.sessions.save', async payload => {
      if (payload.sessionId === gsSession.getSessionId()) await gsSession.updateCurrentSession();
      const session = await getSession(payload.sessionId);
      if (!session) throw new Error('This session no longer exists.');
      return saveNamedSession(session, payload.name, payload.overwrite, false);
    });
    registerNormal('legacy.sessions.rename', async payload => {
      const session = await getSession(payload.sessionId);
      if (!session || !session.sessionId.startsWith('_')) throw new Error('Only saved sessions can be renamed.');
      return saveNamedSession(session, payload.name, payload.overwrite, true);
    });
    registerNormal('legacy.sessions.delete', async payload => {
      const session = await getSession(payload.sessionId);
      if (!session) return { deleted: false };
      await gsIndexedDb.removeSessionFromHistory(session.sessionId);
      return { deleted: true };
    });
    registerNormal('legacy.sessions.removeTab', async payload => {
      const session = await getSession(payload.sessionId);
      if (!session) return null;
      const window = session.windows.find(item => String(item.id) === String(payload.windowId));
      if (!window) throw new Error('This session window no longer exists.');
      const tab = window.tabs.find(item => String(item.id) === String(payload.tabId));
      if (!tab) throw new Error('This recorded tab no longer exists.');
      return normalizeSession(await gsIndexedDb.removeTabFromSessionHistory(session.sessionId, window.id, tab.id));
    });
    registerNormal('legacy.sessions.restore', async payload => {
      const session = await getSession(payload.sessionId);
      if (!session) throw new Error('This session no longer exists.');
      const windows = payload.windowId === undefined ? session.windows :
        session.windows.filter(window => String(window.id) === String(payload.windowId));
      if (!windows.length) throw new Error('This session contains no windows to restore.');
      const restored = [];
      const errors = [];
      for (const window of windows) {
        try {
          restored.push(...await gsSession.restoreSessionWindow(window, null, payload.asleep ? 1 : 2));
        } catch (error) {
          if (error.restored) restored.push(...error.restored);
          errors.push(error.message || String(error));
        }
      }
      await gsSession.updateCurrentSession();
      return { restored: restored.map(tab => normalizeTab(tab)), errors };
    });
    registerNormal('legacy.sessions.import', async payload => {
      if (typeof payload.text !== 'string') throw new Error('Choose a text session file.');
      const windows = [];
      let current = { id: 'import-window-0', tabs: [] };
      for (const input of payload.text.replace(/\r\n?/g, '\n').split('\n')) {
        const url = input.trim();
        if (!url) {
          if (current.tabs.length) {
            windows.push(current);
            current = { id: 'import-window-' + windows.length, tabs: [] };
          }
          continue;
        }
        let parsed;
        try { parsed = new URL(url); } catch (error) { continue; }
        if (!['http:', 'https:', 'file:', 'chrome:', 'brave:', 'about:'].includes(parsed.protocol)) continue;
        const saved = await gsIndexedDb.fetchTabInfo(url);
        current.tabs.push({ id: current.id + '-tab-' + current.tabs.length,
          windowId: current.id, url, title: saved ? saved.title : url,
          ...(saved && saved.favIconUrl ? { favIconUrl: saved.favIconUrl } : {}),
          index: current.tabs.length, pinned: false });
      }
      if (current.tabs.length) windows.push(current);
      if (!windows.length) throw new Error('The file contains no supported tab URLs.');
      return saveNamedSession({ sessionId: '', windows }, payload.name, payload.overwrite, false);
    });
    registerNormal('legacy.sessions.export', async payload => {
      const session = payload.current ? normalizeSession(await gsSession.buildCurrentSession()) : await getSession(payload.sessionId);
      if (!session) throw new Error('There is no session to export.');
      const text = session.windows.map(window => window.tabs.map(tab => tab.originalUrl || tab.url).join('\n'))
        .join('\n\n') + '\n';
      return { text, filename: 'session.txt' };
    });

    registerNormal('legacy.recovery.get', async () => ({
      tabs: await recoveryTabs(), screenCapture: String(gsStorage.getOption(gsStorage.SCREEN_CAPTURE)),
    }));
    registerNormal('legacy.recovery.restore', async payload => {
      if (payload.tabId === undefined) {
        try {
          const restored = await gsSession.recoverLostTabs();
          return { restored: restored.map(tab => normalizeTab(tab)), errors: [] };
        } catch (error) {
          return { restored: (error.restored || []).map(tab => normalizeTab(tab)), errors: [error.message || String(error)] };
        }
      }
      const session = await getSession(payload.sessionId);
      const window = session && session.windows.find(item => String(item.id) === String(payload.windowId));
      const tab = window && window.tabs.find(item => String(item.id) === String(payload.tabId));
      if (!tab) throw new Error('This recovery tab no longer exists.');
      const witnesses = new Set(window.tabs.flatMap(item => item.workbench ?
        [item.workbench.uid, ...(item.workbench.windowWitnessUids || [])] : []).filter(Boolean));
      const witnessWindows = new Set((await gsWorkbench.getTabs())
        .filter(row => witnesses.has(row.uid)).map(row => row.windowId));
      const currentWindows = await gsChrome.windowsGetAll();
      const existing = witnessWindows.size === 1 ?
        currentWindows.find(item => witnessWindows.has(item.id) && !item.incognito) : null;
      const recoveryTab = { ...tab, workbench: { ...tab.workbench, windowWitnessUids: Array.from(witnesses) } };
      const restored = await gsSession.restoreSessionWindow({ ...window, tabs: [recoveryTab] }, existing, 2, { recovery: true });
      await gsSession.updateCurrentSession();
      return { restored: restored.map(item => normalizeTab(item)), errors: [] };
    });

    gsWorkbench.register('legacy.notice.get', () => currentNotice());
    gsWorkbench.register('legacy.notice.dismiss', payload => {
      const notice = currentNotice();
      if (!notice || String(payload.version) !== String(notice.version)) return { dismissed: false };
      gsStorage.setNoticeVersion(notice.version);
      return { dismissed: true };
    });
    registerNormal('legacy.debug.get', async () => {
      const tabs = await gsChrome.tabsQuery({});
      const details = await Promise.all(tabs.filter(tab => !tab.incognito).map(tab => new Promise(resolve => {
        tgs.getDebugInfo(tab.id, info => resolve({ ...info, tab: normalizeTab(tab) }));
      })));
      return { tabs: details, ...debugFlags() };
    });
    registerNormal('legacy.debug.update', async payload => {
      for (const name of ['debugInfo', 'debugError', 'discardInPlaceOfSuspend', 'useAlternateScreenCaptureLib']) {
        if (payload[name] !== undefined && typeof payload[name] !== 'boolean') throw new Error('Debug flags must be true or false.');
      }
      if (payload.debugInfo !== undefined) gsUtils.setDebugInfo(payload.debugInfo);
      if (payload.debugError !== undefined) gsUtils.setDebugError(payload.debugError);
      const settings = {};
      if (payload.discardInPlaceOfSuspend !== undefined) settings[gsStorage.DISCARD_IN_PLACE_OF_SUSPEND] = payload.discardInPlaceOfSuspend;
      if (payload.useAlternateScreenCaptureLib !== undefined) settings[gsStorage.USE_ALT_SCREEN_CAPTURE_LIB] = payload.useAlternateScreenCaptureLib;
      if (Object.keys(settings).length) await gsWorkbench.execute('legacy.update', { settings });
      return debugFlags();
    });
    registerNormal('legacy.debug.claim', async () => {
      const changed = [];
      const errors = [];
      for (const tab of await gsChrome.tabsQuery({})) {
        if (tab.incognito || gsUtils.isSuspendedTab(tab)) continue;
        let url;
        try { url = new URL(tab.url); } catch (error) { continue; }
        if (url.protocol !== 'chrome-extension:' || url.pathname !== '/suspended.html') continue;
        const originalUrl = gsUtils.getOriginalUrl(tab.url);
        if (!originalUrl) continue;
        const suspendedUrl = gsUtils.generateSuspendedUrl(originalUrl,
          gsUtils.getSuspendedTitle(tab.url), gsUtils.getSuspendedScrollPosition(tab.url));
        const updated = await gsChrome.tabsUpdate(tab.id, { url: suspendedUrl });
        if (updated) changed.push(tab.id);
        else errors.push('Could not claim tab ' + tab.id);
      }
      return { changed, errors };
    });

    gsWorkbench.register('legacy.suspended.get', async (payload, sender) => {
      const tab = await requireSuspendedTab(payload, sender);
      return gsSuspendedTab.getData(tab);
    });
    gsWorkbench.register('legacy.suspended.restore', async (payload, sender) => {
      const tab = await requireSuspendedTab(payload, sender);
      const restoring = await tgs.unsuspendTab(tab);
      return { restoring, offline: !navigator.onLine };
    });
    gsWorkbench.register('legacy.suspended.unload', async (payload, sender) => {
      const tab = await requireSuspendedTab(payload, sender);
      const recorded = tgs.isCurrentFocusedTab(tab);
      if (recorded) tgs.setTabStatePropForTabId(tab.id, tgs.STATE_UNLOADED_URL, tab.url);
      return { recorded };
    });
  }

  return { initAsPromised };
})();
