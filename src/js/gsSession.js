/*global gsBrowser, localStorage, tgs, gsStorage, gsIndexedDb, gsUtils, gsChrome, gsTabCheckManager, gsTabDiscardManager, gsWorkbench, gsWorkbenchActions, gsWorkbenchWorkspaces, crypto */
// eslint-disable-next-line no-unused-vars
var gsSession = (function() {
  'use strict';

  let updatedUrl;

  let initialisationMode = true;
  let sessionId;
  let updateType = null;
  let updated = false;
  let fileUrlsAccessAllowed = false;

  let startupTabCheckTimeTakenInSeconds;
  let startupRecoveryTimeTakenInSeconds;
  let startupType;
  let startupLastVersion;
  let syncedSettingsOnInit;
  let pendingRecovery = null;
  let recoveryInFlight = 0;

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function browserCall(namespace, method, ...args) {
    return new Promise((resolve, reject) => {
      gsBrowser[namespace][method](...args, result => {
        if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
        else resolve(result);
      });
    });
  }


  function sessionEntries(sessionWindow, state, ordinal, refreshMeta) {
    const tabs = sessionWindow.tabs.filter(tab => !tab.incognito && !gsUtils.isInternalTab(tab));
    const entries = tabs.map(tab => {
      const originalUrl = gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
      const saved = tab.workbench ? copy(tab.workbench) : {};
      const storedMeta = state && state.meta[String(tab.id)];
      const meta = storedMeta && storedMeta.url === originalUrl &&
        (!saved.uid || saved.uid === storedMeta.uid) && (!tab.workbench || refreshMeta) ? storedMeta : null;
      const entry = {
        ...saved,
        uid: meta && meta.uid || saved.uid,
        tabId: tab.id,
        title: tab.title || saved.title || originalUrl,
        originalUrl,
        url: tab.url,
        windowId: sessionWindow.id,
        windowOrdinal: ordinal === undefined ? saved.windowOrdinal || meta && meta.windowOrdinal || 0 : ordinal,
        index: tab.index,
        pinned: !!tab.pinned,
        active: !!tab.active,
        asleep: gsUtils.isSuspendedTab(tab) || !!tab.discarded,
        status: gsUtils.isSuspendedTab(tab) ? 'suspended' : tab.discarded ? 'discarded' : 'awake',
        group: copy(meta && Object.prototype.hasOwnProperty.call(meta, 'group') ? meta.group : saved.group || tab.group || null),
        windowFocused: !!sessionWindow.focused,
        windowBounds: {
          left: sessionWindow.left, top: sessionWindow.top,
          width: sessionWindow.width, height: sessionWindow.height,
          state: sessionWindow.state || 'normal', type: 'normal',
        },
        meta: copy(meta || saved.meta || {}),
      };
      if (meta) {
        gsWorkbenchWorkspaces.decorateSnapshot(entry, {
          id: tab.id, uid: meta.uid, workspaceId: meta.workspaceId,
          windowId: tab.windowId, groupId: tab.groupId,
        }, state);
      }
      return entry;
    });
    tabs.forEach((tab, index) => {
      if (entries[index].group || tab.pinned || !(tab.groupId >= 0)) return;
      const member = entries.find(entry => entry.group && entry.group.sourceId === tab.groupId);
      if (member) {
        entries[index].group = copy(member.group);
        if (isBrowserPageEntry(entries[index])) {
          delete entries[index].group.temporaryId;
          delete entries[index].group.temporaryExpiresAt;
        }
      }
    });
    const witnesses = [...new Set(entries.flatMap(entry =>
      [entry.uid, ...(entry.windowWitnessUids || [])]).filter(Boolean))];
    entries.forEach(entry => { entry.windowWitnessUids = witnesses.slice(); });
    return entries;
  }

  async function deferStartupRecovery() {
    const session = await gsIndexedDb.fetchLastSession();
    if (!session) return;
    const stored = await new Promise((resolve, reject) => {
      gsBrowser.storage.local.get('gsWorkbenchState', result => {
        if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
        else resolve(result.gsWorkbenchState || null);
      });
    });
    pendingRecovery = copy(session);
    pendingRecovery.windows.forEach((window, ordinal) => {
      const entries = sessionEntries(window, stored, ordinal, true);
      window.tabs.forEach(tab => {
        const entry = entries.find(item => item.tabId === tab.id);
        if (entry) tab.workbench = entry;
      });
    });
  }

  async function completeStartupRecovery() {
    if (!pendingRecovery || gsBrowser.extension.inIncognitoContext) return [];
    try {
      return await recoverLostTabs(pendingRecovery);
    } catch (error) {
      await gsWorkbench.update(state => {
        state.lastError = { message: 'Startup recovery is incomplete: ' + error.message, at: Date.now() };
      });
      return error.restored || [];
    }
  }

  async function initAsPromised() {
    updatedUrl = gsBrowser.runtime.getURL('updated.html');

    // Set fileUrlsAccessAllowed to determine if extension can work on file:// URLs
    await new Promise(r => {
      gsBrowser.extension.isAllowedFileSchemeAccess(isAllowedAccess => {
        fileUrlsAccessAllowed = isAllowedAccess;
        r();
      });
    });

    //remove any update screens
    await Promise.all([
      gsUtils.removeTabsByUrlAsPromised(updatedUrl),
    ]);

    //handle special event where an extension update is available
    gsBrowser.runtime.onUpdateAvailable.addListener(details => {
      prepareForUpdate(details); //async
    });
    gsUtils.log('gsSession', 'init successful');
  }

  async function prepareForUpdate(newVersionDetails) {
    const currentVersion = gsBrowser.runtime.getManifest().version;
    const newVersion = newVersionDetails.version;

    gsUtils.log(
      'gsSession',
      'A new version is available: ' + currentVersion + ' -> ' + newVersion
    );

    let sessionRestorePoint;
    const currentSession = await buildCurrentSession();
    if (currentSession) {
      sessionRestorePoint = await gsIndexedDb.createOrUpdateSessionRestorePoint(
        currentSession,
        currentVersion
      );
    }

    const suspendedTabCount = await gsUtils.getSuspendedTabCount();
    if (suspendedTabCount === 0) {
      // if there are no suspended tabs then simply install the update immediately
      gsBrowser.runtime.reload();
    } else {
      //do nothing. this prevents chrome from automatically updating and will instead wait
      //until a browser restart to update
    }
  }

  function getSessionId() {
    if (!sessionId) {
      //turn this into a string to make comparisons easier further down the track
      sessionId = Date.now() + '';
      gsUtils.log('gsSession', 'sessionId: ', sessionId);
    }
    return sessionId;
  }

  async function buildCurrentSession() {
    if (gsBrowser.extension.inIncognitoContext) return null;
    const currentWindows = (await gsChrome.windowsGetAll()).filter(window => !window.incognito);
    if (!currentWindows.some(window => window.tabs && window.tabs.length)) return null;
    if (gsWorkbench.getState()) {
      const rows = new Map((await gsWorkbench.getTabs()).map(row => [row.id, row]));
      const nativeGroups = new Map((await browserCall('tabGroups', 'query', {})).map(group => [group.id, group]));
      const groupKeys = new Map();
      for (const row of rows.values()) {
        if (row.groupId >= 0 && row.groupKey) groupKeys.set(row.groupId, row.groupKey);
      }
      for (const window of currentWindows) {
        const groupStarts = new Map();
        for (const tab of window.tabs) {
          if (tab.groupId >= 0 && !groupStarts.has(tab.groupId)) groupStarts.set(tab.groupId, tab.index);
        }
        for (const tab of window.tabs) {
          const row = rows.get(tab.id);
          if (row) {
            tab.workbench = copy(gsWorkbench.tabSnapshot(row));
          } else if (!tab.pinned && tab.groupId >= 0 && nativeGroups.has(tab.groupId)) {
            const group = nativeGroups.get(tab.groupId);
            tab.group = {
              sourceId: group.id,
              key: groupKeys.get(group.id) || gsWorkbench.getState().browserSession + ':' + window.id + ':' + group.id,
              startIndex: groupStarts.get(group.id),
              title: group.title || '',
              color: group.color,
              collapsed: !!group.collapsed,
            };
          }
        }
      }
    }
    return {
      sessionId: getSessionId(),
      windows: currentWindows,
      date: new Date().toISOString(),
    };
  }

  async function updateCurrentSession() {
    if (gsBrowser.extension.inIncognitoContext) return;
    if (pendingRecovery) {
      if (recoveryInFlight || !gsWorkbench.getState()) return;
      await settlePendingRecovery();
      if (pendingRecovery) return;
    }
    const currentSession = await buildCurrentSession();
    if (currentSession) {
      await gsIndexedDb.updateSession(currentSession);
    }
  }

  function isUpdated() {
    return updated;
  }

  function isInitialising() {
    return initialisationMode;
  }

  function isFileUrlsAccessAllowed() {
    return fileUrlsAccessAllowed;
  }

  function getTabCheckTimeTakenInSeconds() {
    return startupTabCheckTimeTakenInSeconds;
  }

  function getRecoveryTimeTakenInSeconds() {
    return startupRecoveryTimeTakenInSeconds;
  }

  function getStartupType() {
    return startupType;
  }

  function getStartupLastVersion() {
    return startupLastVersion;
  }

  function getUpdateType() {
    return updateType;
  }

  function setSynchedSettingsOnInit(syncedSettings) {
    syncedSettingsOnInit = syncedSettings;
  }

  async function runStartupChecks() {
    initialisationMode = true;

    const currentSessionTabs = await gsChrome.tabsQuery();
    gsUtils.log('gsSession', 'preRecovery open tabs:', currentSessionTabs);

    const curVersion = gsBrowser.runtime.getManifest().version;
    gsUtils.log('gsSession', 'curVersion:', curVersion);

    startupLastVersion = gsStorage.fetchLastVersion();
    gsUtils.log('gsSession', 'startupLastVersion:', startupLastVersion);

    if (gsBrowser.extension.inIncognitoContext) {
      // do nothing if in incognito context
      startupType = 'Incognito';
    } else if (startupLastVersion === curVersion) {
      gsUtils.log('gsSession', 'HANDLING NORMAL STARTUP');
      startupType = 'Restart';
      await handleNormalStartup(currentSessionTabs, curVersion);
    } else if (!startupLastVersion || startupLastVersion === '0.0.0') {
      gsUtils.log('gsSession', 'HANDLING NEW INSTALL');
      startupType = 'Install';
      await handleNewInstall(curVersion);
    } else {
      gsUtils.log('gsSession', 'HANDLING UPDATE');
      startupType = 'Update';
      await handleUpdate(currentSessionTabs, curVersion, startupLastVersion);
    }

    if (!pendingRecovery) await updateCurrentSession();
  }

  async function finishStartupTabChecks() {
    await performTabChecks();
    const currentWindowActiveTabs = await gsChrome.tabsQuery({
      active: true,
      lastFocusedWindow: true,
    });
    if (currentWindowActiveTabs.length > 0) {
      gsTabCheckManager.queueTabCheck(currentWindowActiveTabs[0]);
    }
    await updateCurrentSession();

    initialisationMode = false;
  }

  //make sure the contentscript / suspended script of each tab is responsive
  async function performTabChecks() {
    const initStartTime = Date.now();
    gsUtils.log(
      'gsSession',
      '\n\n------------------------------------------------\n' +
        `Checking tabs for responsiveness..\n` +
        '------------------------------------------------\n\n'
    );

    const postRecoverySessionTabs = await gsChrome.tabsQuery();
    gsUtils.log(
      'gsSession',
      'postRecoverySessionTabs:',
      postRecoverySessionTabs
    );

    const tabCheckResults = await gsTabCheckManager.performInitialisationTabChecks(
      postRecoverySessionTabs
    );
    const totalTabCheckCount = tabCheckResults.length;
    const successfulTabChecksCount = tabCheckResults.filter(
      o => o === gsUtils.STATUS_SUSPENDED || o === gsUtils.STATUS_DISCARDED
    ).length;

    startupTabCheckTimeTakenInSeconds = parseInt(
      (Date.now() - initStartTime) / 1000
    );
    gsUtils.log(
      'gsSession',
      '\n\n------------------------------------------------\n' +
        `Checking tabs finished. Time taken: ${startupTabCheckTimeTakenInSeconds} sec\n` +
        `${successfulTabChecksCount} / ${totalTabCheckCount} initialised successfully\n` +
        '------------------------------------------------\n\n'
    );
  }

  async function handleNormalStartup(currentSessionTabs, curVersion) {
    if (await checkForCrashRecovery(currentSessionTabs)) {
      gsStorage.setLastExtensionRecoveryTimestamp(Date.now());
      await deferStartupRecovery();
    } else {
      await gsIndexedDb.trimDbItems();
    }
  }

  async function handleNewInstall(curVersion) {
    gsStorage.setLastVersion(curVersion);

    // Try to determine if this is a new install for the computer or for the whole profile
    // If settings sync contains non-default options, then we can assume it's only
    // a new install for this computer
    if (
      !syncedSettingsOnInit ||
      Object.keys(syncedSettingsOnInit).length === 0
    ) {
      //show welcome message
      const optionsUrl = gsBrowser.runtime.getURL('options.html?firstTime');
      await gsChrome.tabsCreate(optionsUrl);
    }
  }

  async function handleUpdate(currentSessionTabs, curVersion, lastVersion) {
    gsStorage.setLastVersion(curVersion);
    const lastVersionParts = lastVersion.split('.');
    const curVersionParts = curVersion.split('.');
    if (lastVersionParts.length >= 2 && curVersionParts.length >= 2) {
      if (parseInt(curVersionParts[0]) > parseInt(lastVersionParts[0])) {
        updateType = 'major';
      } else if (parseInt(curVersionParts[1]) > parseInt(lastVersionParts[1])) {
        updateType = 'minor';
      } else {
        updateType = 'patch';
      }
    }

    const sessionRestorePoint = await gsIndexedDb.fetchSessionRestorePoint(
      lastVersion
    );
    if (!sessionRestorePoint) {
      const lastSession = await gsIndexedDb.fetchLastSession();
      if (lastSession) {
        await gsIndexedDb.createOrUpdateSessionRestorePoint(
          lastSession,
          lastVersion
        );
      } else {
        gsUtils.error(
          'gsSession',
          'No session restore point found, and no lastSession exists!'
        );
      }
    }

    await gsUtils.removeTabsByUrlAsPromised(updatedUrl);

    await gsIndexedDb.performMigration(lastVersion);
    gsStorage.setNoticeVersion('0');
    const shouldRecoverTabs = await checkForCrashRecovery(currentSessionTabs);
    if (shouldRecoverTabs) {
      await gsUtils.createTabAndWaitForFinishLoading(updatedUrl, 10000);

      await deferStartupRecovery();
      updated = true;

      const updatedTabs = await gsChrome.tabsQuery({ url: updatedUrl });
      if (updatedTabs.length) {
        gsBrowser.runtime.sendMessage({ action: 'legacy.updated.changed' }, () => {
          void gsBrowser.runtime.lastError;
        });
      } else {
        await gsChrome.tabsCreate({ url: updatedUrl });
      }
    } else {
      updated = true;
      await gsChrome.tabsCreate({ url: updatedUrl });
    }
  }

  // This function is used only for testing
  async function triggerDiscardOfAllTabs() {
    await new Promise(resolve => {
      gsBrowser.tabs.query({ active: false, discarded: false }, function(tabs) {
        for (let i = 0; i < tabs.length; ++i) {
          if (tabs[i] === undefined || gsUtils.isSpecialTab(tabs[i])) {
            continue;
          }
          gsTabDiscardManager.queueTabForDiscard(tabs[i]);
        }
        resolve();
      });
    });
  }

  async function checkForCrashRecovery(currentSessionTabs) {
    gsUtils.log(
      'gsSession',
      'Checking for crash recovery: ' + new Date().toISOString()
    );

    //try to detect whether the extension has crashed as apposed to chrome restarting
    //if it is an extension crash, then in theory all suspended tabs will be gone
    //and all normal tabs will still exist with the same ids
    const currentSessionNonExtensionTabs = currentSessionTabs.filter(
      o => o.url.indexOf(gsBrowser.runtime.id) === -1
    );


    const lastSession = await gsIndexedDb.fetchLastSession();
    if (!lastSession) {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Could not find last session.'
      );
      return false;
    }
    gsUtils.log('gsSession', 'lastSession: ', lastSession);

    const lastSessionTabs = lastSession.windows.reduce(
      (a, o) => a.concat(o.tabs),
      []
    );
    const lastSessionSuspendedTabs = lastSessionTabs.filter(o =>
      gsUtils.isSuspendedTab(o)
    );
    const lastSessionNonExtensionTabs = lastSessionTabs.filter(
      o => o.url.indexOf(gsBrowser.runtime.id) === -1
    );

    if (lastSessionSuspendedTabs.length === 0) {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Last session contained no suspended tabs.'
      );
      return false;
    }
    const available = new Map();
    const originalUrl = tab => gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
    currentSessionTabs.filter(tab => !tab.incognito && (gsUtils.isNormalTab(tab) || gsUtils.isSuspendedTab(tab))).forEach(tab => {
      const url = originalUrl(tab);
      available.set(url, (available.get(url) || 0) + 1);
    });
    lastSessionTabs.filter(tab => gsUtils.isNormalTab(tab)).forEach(tab => {
      const url = originalUrl(tab);
      if (available.get(url)) available.set(url, available.get(url) - 1);
    });
    let missingSuspendedTab = false;
    lastSessionSuspendedTabs.forEach(tab => {
      const url = originalUrl(tab);
      if (available.get(url)) available.set(url, available.get(url) - 1);
      else missingSuspendedTab = true;
    });
    if (!missingSuspendedTab) return false;


    // Match against all tabIds from last session here, not just non-extension tabs
    // as there is a chance during tabInitialisation of a suspended tab getting reloaded
    // directly and hence keeping its tabId (ie: file:// tabs)
    function matchingTabExists(tab) {
      if (tab.url.indexOf('chrome://newtab') === 0 && tab.index === 0)
        return false;
      return lastSessionTabs.some(o => o.id === tab.id && o.url === tab.url);
    }
    const matchingTabIdsCount = currentSessionNonExtensionTabs.reduce(
      (a, o) => (matchingTabExists(o) ? a + 1 : a),
      0
    );
    const maxMatchableTabsCount = Math.max(
      lastSessionNonExtensionTabs.length,
      currentSessionNonExtensionTabs.length
    );
    gsUtils.log(
      'gsSession',
      matchingTabIdsCount +
        ' / ' +
        maxMatchableTabsCount +
        ' tabs have the same id between the last session and the current session.'
    );
    if (
      matchingTabIdsCount === 0 ||
      maxMatchableTabsCount - matchingTabIdsCount > 1
    ) {
      gsUtils.log('gsSession', 'Aborting tab recovery. Tab IDs do not match.');
      return false;
    }

    return true;
  }

  function isOverdueRecoveryEntry(entry, now = Date.now()) {
    const expiry = gsWorkbenchWorkspaces.getSavedTemporaryInfo(entry).expiresAt;
    return !!expiry && expiry <= now;
  }

  async function retainExpiredRecovery(entries, sourceSessionId) {
    if (!entries.length) return;
    const archiveId = 'legacy-recovery-expired:' + sourceSessionId;
    const key = entry => (entry.uid || entry.windowId + ':' + entry.tabId) + '\n' + entry.originalUrl;
    await gsWorkbench.update(state => {
      let archive = state.archive.find(item => item.id === archiveId);
      if (!archive) {
        archive = { id: archiveId, label: 'Expired recovery tabs', reason: 'startup-recovery-expired', createdAt: Date.now(), tabs: [] };
        state.archive.push(archive);
      }
      const retained = new Set(archive.tabs.map(key));
      for (const entry of entries) {
        if (retained.has(key(entry))) continue;
        archive.tabs.push(copy(entry));
        retained.add(key(entry));
      }
    });
  }

  async function settlePendingRecovery(sessionWindow, restoredEntries = [], restoredRows = []) {
    const session = pendingRecovery;
    if (!session || recoveryInFlight) return;
    const sourceWindow = sessionWindow && session.windows.find(window => String(window.id) === String(sessionWindow.id));
    let rebound = false;
    for (const [index, entry] of restoredEntries.entries()) {
      if (entry.uid || isBrowserPageEntry(entry)) continue;
      const row = restoredRows.find(item => item.restoreEntryIndex === index && item.originalUrl === entry.originalUrl);
      const tab = sourceWindow && sourceWindow.tabs.find(item => String(item.id) === String(entry.tabId) &&
        (gsUtils.isSuspendedTab(item) ? gsUtils.getOriginalUrl(item.url) : item.url) === entry.originalUrl);
      if (!row || !tab || tab.workbench && tab.workbench.uid) continue;
      tab.workbench = { ...copy(entry), uid: row.uid, meta: { ...copy(entry.meta), uid: row.uid }, windowWitnessUids: [row.uid] };
      rebound = true;
    }
    if (rebound) await gsIndexedDb.updateSession(session);
    const saved = session.windows.filter(window => !window.incognito).flatMap((window, ordinal) =>
      sessionEntries({ ...window, tabs: window.tabs.filter(tab => gsUtils.isNormalTab(tab) || gsUtils.isSuspendedTab(tab)) }, null, ordinal));
    const live = await gsWorkbench.getTabs();
    const used = new Set();
    const expired = [];
    let unresolved = false;
    for (const entry of saved) {
      const row = entry.uid ? live.find(item => item.uid === entry.uid) :
        live.find(item => !used.has(item.id) && item.originalUrl === entry.originalUrl && item.windowOrdinal === entry.windowOrdinal);
      if (row) {
        used.add(row.id);
        if (entry.asleep && row.status === 'loading') unresolved = true;
      } else if (entry.asleep) {
        if (isOverdueRecoveryEntry(entry)) expired.push(entry);
        else unresolved = true;
      }
    }
    await retainExpiredRecovery(expired, session.sessionId);
    if (unresolved || pendingRecovery !== session) return;
    pendingRecovery = null;
    if ((gsWorkbench.getState().lastError || {}).message && gsWorkbench.getState().lastError.message.startsWith('Startup recovery is incomplete:')) {
      await gsWorkbench.update(state => { delete state.lastError; });
    }
  }

  async function recoverLostTabs(session) {
    if (gsBrowser.extension.inIncognitoContext) return [];
    session = copy(session || pendingRecovery || await gsIndexedDb.fetchLastSession());
    if (!session) return [];
    pendingRecovery = session;
    const startedAt = Date.now();
    const saved = session.windows.filter(window => !window.incognito).flatMap((window, ordinal) =>
      sessionEntries({
        ...window,
        tabs: window.tabs.filter(tab => gsUtils.isNormalTab(tab) || gsUtils.isSuspendedTab(tab)),
      }, gsWorkbench.getState(), ordinal));
    const live = await gsWorkbench.getTabs();
    const used = new Set();
    const missing = [];
    const surviving = [];
    for (const entry of saved) {
      const hasSavedIdentity = !!entry.uid;
      let row = entry.uid && live.find(item => item.uid === entry.uid);
      if (row && row.originalUrl !== entry.originalUrl) continue;
      if (!row && !entry.uid) {
        row = live.find(item => !used.has(item.id) && item.originalUrl === entry.originalUrl &&
          item.windowOrdinal === entry.windowOrdinal);
      }
      if (row && !used.has(row.id)) {
        used.add(row.id);
        entry.uid = row.uid;
        entry.meta = copy(row.meta);
        entry.status = row.status;
        entry.asleep = row.asleep;
        entry.url = row.url;
        entry.active = row.active;
        entry.pinned = row.pinned;
        if (hasSavedIdentity) surviving.push(entry);
      } else if (!row && entry.asleep) {
        missing.push(entry);
      }
    }
    const expired = missing.filter(entry => isOverdueRecoveryEntry(entry));
    const recoverable = missing.filter(entry => !expired.includes(entry));
    await retainExpiredRecovery(expired, session.sessionId);
    const groupKey = entry => entry.group && entry.windowId + ':' +
      (entry.group.key || entry.group.sourceId || entry.group.title + ':' + entry.group.color);
    const affectedGroups = new Set(recoverable.map(groupKey).filter(Boolean));
    const anchors = surviving.filter(entry => !entry.pinned && affectedGroups.has(groupKey(entry)) && !isOverdueRecoveryEntry(entry));
    let restored;
    recoveryInFlight += 1;
    try {
      restored = await gsWorkbenchActions.restoreEntries(recoverable.concat(anchors), {
        recordUndo: false, reason: 'Legacy startup recovery',
      });
    } finally {
      recoveryInFlight -= 1;
    }
    startupRecoveryTimeTakenInSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const terminalSkips = restored.skipped.filter(item => item.entry && !item.partiallyChanged && isOverdueRecoveryEntry(item.entry));
    await retainExpiredRecovery(terminalSkips.map(item => item.entry), session.sessionId);
    const retriableSkips = restored.skipped.filter(item => !terminalSkips.includes(item));
    if (retriableSkips.length) {
      const error = new Error(retriableSkips.flatMap(item => item.reasons).join('; '));
      error.restored = Array.from(restored).concat(restored.partial || []);
      throw error;
    }
    pendingRecovery = null;
    if ((gsWorkbench.getState().lastError || {}).message && gsWorkbench.getState().lastError.message.startsWith('Startup recovery is incomplete:')) {
      await gsWorkbench.update(state => { delete state.lastError; });
    }
    await updateCurrentSession();
    return Array.from(restored);
  }


  function isBrowserPageEntry(entry) {
    return /^(?:chrome|brave):\/\/|^about:/i.test(entry.originalUrl || '');
  }

  async function waitForBrowserPage(tabId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const tab = await browserCall('tabs', 'get', tabId);
      if (tab.incognito) throw new Error('The restored page belongs to a private window.');
      if (tab.status === 'complete' && !tab.discarded && !gsUtils.isSuspendedTab(tab)) return tab;
      await gsUtils.setTimeout(50);
    }
    throw new Error('The browser page did not finish loading; its tab remains available.');
  }

  async function restoreBrowserPages(entries, restored, existingWindow) {
    const browserEntries = entries.filter(isBrowserPageEntry);
    if (!browserEntries.length) return;
    const normalRows = Array.from(restored).concat(restored.partial || []);
    let windowId = normalRows.length ? normalRows[0].windowId : existingWindow && existingWindow.id;
    const created = [];
    for (const entry of browserEntries.slice().sort((a, b) => a.index - b.index)) {
      let tab;
      try {
        if (isOverdueRecoveryEntry(entry)) throw new Error('Saved temporary tab is overdue; restore it intentionally from Archive instead.');
        if (windowId == null) {
          const bounds = entry.windowBounds || {};
          const details = { url: entry.originalUrl, type: 'normal', focused: false };
          if (!bounds.state || bounds.state === 'normal') {
            for (const name of ['left', 'top', 'width', 'height']) {
              if (Number.isInteger(bounds[name])) details[name] = bounds[name];
            }
          }
          const window = await browserCall('windows', 'create', details);
          windowId = window.id;
          tab = window.tabs && window.tabs[0];
          if (!tab) throw new Error('The browser did not return the created page.');
          await browserCall('tabs', 'update', tab.id, { pinned: !!entry.pinned });
        } else {
          tab = await browserCall('tabs', 'create', {
            windowId, url: entry.originalUrl, active: false,
            pinned: !!entry.pinned, index: Math.max(0, Number(entry.index) || 0),
          });
        }
        created.push({ entry, row: await waitForBrowserPage(tab.id) });
      } catch (error) {
        restored.skipped.push({ entry, reasons: [error.message], partiallyChanged: !!tab });
        if (tab) {
          try { restored.partial.push(await browserCall('tabs', 'get', tab.id)); }
          catch (_) { restored.partial.push(tab); }
        }
      }
    }
    if (!created.length) return;
    const entriesByUid = new Map(entries.map(entry => [entry.uid, entry]));
    const items = Array.from(restored).map(row => ({ entry: entriesByUid.get(row.sourceUid || row.uid), row }))
      .filter(item => item.entry).concat(created);
    try {
      const savedGroups = new Map();
      for (const item of items) {
        if (!item.entry.group || item.entry.pinned) continue;
        const group = item.entry.group;
        const key = group.key || group.sourceId || group.id || group.title + ':' + group.color;
        if (!savedGroups.has(key)) savedGroups.set(key, []);
        savedGroups.get(key).push(item);
      }
      for (const members of savedGroups.values()) {
        const additions = members.filter(item => created.includes(item));
        if (!additions.length) continue;
        const normalGroups = new Set(members.filter(item => !created.includes(item) && item.row.groupId >= 0)
          .map(item => item.row.groupId));
        if (normalGroups.size > 1) throw new Error('Saved native group identity changed during browser-page restore.');
        const groupId = await browserCall('tabs', 'group', {
          ...(normalGroups.size ? { groupId: Array.from(normalGroups)[0] } : { createProperties: { windowId } }),
          tabIds: additions.map(item => item.row.id),
        });
        const descriptor = members[0].entry.group;
        await browserCall('tabGroups', 'update', groupId, {
          title: descriptor.title || '', color: descriptor.color || 'grey', collapsed: !!descriptor.collapsed,
        });
      }
      const actual = new Map((await browserCall('tabs', 'query', { windowId })).map(tab => [tab.id, tab]));
      const units = new Map();
      for (const item of items) {
        const tab = actual.get(item.row.id);
        if (!tab) throw new Error('A restored tab disappeared before browser-page placement.');
        const key = tab.groupId >= 0 ? 'group:' + tab.groupId : 'tab:' + tab.id;
        if (!units.has(key)) {
          units.set(key, { groupId: tab.groupId, pinned: !!item.entry.pinned, items: [], index: item.entry.group &&
            Number.isInteger(item.entry.group.startIndex) ? item.entry.group.startIndex : Math.max(0, Number(item.entry.index) || 0) });
        }
        units.get(key).items.push(item);
      }
      for (const unit of Array.from(units.values()).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index)) {
        if (unit.groupId < 0) {
          await browserCall('tabs', 'move', unit.items[0].row.id, { windowId, index: unit.index });
          continue;
        }
        const members = (await browserCall('tabs', 'query', { groupId: unit.groupId })).sort((a, b) => a.index - b.index);
        const selected = new Set(unit.items.map(item => item.row.id));
        const order = new Array(members.length);
        const overflow = [];
        for (const item of unit.items.slice().sort((a, b) => a.entry.index - b.entry.index)) {
          const index = Math.max(0, (Number(item.entry.index) || 0) - unit.index);
          if (index >= order.length) overflow.push(item.row.id);
          else if (order[index] != null) throw new Error('Saved native group positions conflict.');
          else order[index] = item.row.id;
        }
        const spare = members.filter(tab => !selected.has(tab.id)).map(tab => tab.id).concat(overflow);
        let next = 0;
        for (let index = 0; index < order.length; index += 1) {
          if (order[index] == null) order[index] = spare[next++];
        }
        if (order.some(id => !Number.isInteger(id))) throw new Error('Native group membership changed during browser-page restore.');
        if (members[0].index !== unit.index || members.some((tab, index) => tab.id !== order[index])) {
          const others = order.slice(1);
          if (others.length) await browserCall('tabs', 'ungroup', others);
          await browserCall('tabGroups', 'move', unit.groupId, { windowId, index: unit.index });
          if (others.length) {
            await browserCall('tabs', 'move', others, { windowId, index: unit.index + 1 });
            await browserCall('tabs', 'group', { groupId: unit.groupId, tabIds: others });
          }
        }
      }
      const active = created.find(item => item.entry.active);
      if (active && (!existingWindow || !existingWindow.focused)) {
        await browserCall('tabs', 'update', active.row.id, { active: true });
      }
      for (const members of savedGroups.values()) {
        const group = members[0].entry.group;
        const current = await browserCall('tabs', 'get', members[0].row.id);
        if (current.groupId < 0) throw new Error('Saved native group membership was not retained.');
        const actualGroup = await browserCall('tabGroups', 'update', current.groupId, { collapsed: !!group.collapsed });
        if (actualGroup.title !== (group.title || '') || actualGroup.color !== (group.color || 'grey') ||
            actualGroup.collapsed !== !!group.collapsed) {
          throw new Error('The browser did not retain the saved native group details.');
        }
      }
      if (!normalRows.length) {
        const bounds = browserEntries[0].windowBounds || {};
        const details = {};
        if (bounds.state && bounds.state !== 'normal') details.state = bounds.state;
        else {
          details.state = 'normal';
          for (const name of ['left', 'top', 'width', 'height']) {
            if (Number.isInteger(bounds[name])) details[name] = bounds[name];
          }
        }
        await browserCall('windows', 'update', windowId, details);
        const current = await browserCall('windows', 'get', windowId);
        if (bounds.state && current.state !== bounds.state || (!bounds.state || bounds.state === 'normal') &&
            ['left', 'top', 'width', 'height'].some(name => Number.isInteger(bounds[name]) && current[name] !== bounds[name])) {
          throw new Error('The browser did not retain the saved window geometry.');
        }
      }
      const placed = (await browserCall('tabs', 'query', { windowId })).sort((a, b) => a.index - b.index);
      const selected = new Set(items.map(item => item.row.id));
      const order = placed.filter(tab => selected.has(tab.id));
      const expected = items.slice().sort((a, b) => Number(b.entry.pinned) - Number(a.entry.pinned) || a.entry.index - b.entry.index);
      if (order.length !== expected.length || order.some((tab, index) =>
        tab.id !== expected[index].row.id || tab.pinned !== !!expected[index].entry.pinned)) {
        throw new Error('The browser did not retain the saved tab order or pins.');
      }
      const byId = new Map(placed.map(tab => [tab.id, tab]));
      for (let index = 0; index < restored.length; index += 1) {
        const tab = byId.get(restored[index].id);
        if (tab) restored[index] = { ...restored[index], ...tab, status: restored[index].status, asleep: restored[index].asleep };
      }
      restored.push(...created.map(item => byId.get(item.row.id)));
    } catch (error) {
      for (const item of created) {
        restored.skipped.push({ entry: item.entry, reasons: [error.message], partiallyChanged: true });
        try { restored.partial.push(await browserCall('tabs', 'get', item.row.id)); }
        catch (_) { restored.partial.push(item.row); }
      }
    }
  }

  // suspendMode controls whether the tabs are restored as suspended or unsuspended
  // 0: Leave the urls as they are (suspended stay suspended, ussuspended stay unsuspended)
  // 1: Open all unsuspended tabs as suspended
  // 2: Open all suspended tabs as unsuspended
  async function restoreSessionWindow(sessionWindow, existingWindow, suspendMode, restoreOptions = {}) {
    if (gsBrowser.extension.inIncognitoContext || sessionWindow.incognito) return [];
    const entries = sessionEntries(sessionWindow, null);
    if (!entries.length) return [];
    if (existingWindow) {
      const witnesses = new Set(entries.flatMap(entry => entry.windowWitnessUids));
      const witnessWindows = new Set((await gsWorkbench.getTabs())
        .filter(row => witnesses.has(row.uid)).map(row => row.windowId));
      if (existingWindow.incognito || witnessWindows.size !== 1 || !witnessWindows.has(existingWindow.id)) {
        existingWindow = null;
      }
    }
    if (!existingWindow && !restoreOptions.recovery) {
      const identities = new Map(entries.filter(entry => entry.uid).map(entry => [entry.uid, crypto.randomUUID()]));
      const groups = new Map();
      const groupKeys = new Map();
      for (const entry of entries) {
        entry.uid = identities.get(entry.uid) || crypto.randomUUID();
        entry.meta.uid = entry.uid;
        entry.windowWitnessUids = [];
        if (Array.isArray(entry.temporaryGroups)) {
          entry.temporaryGroups = entry.temporaryGroups.map(descriptor => {
            if (!groups.has(descriptor.id)) groups.set(descriptor.id, crypto.randomUUID());
            return {
              ...descriptor, id: groups.get(descriptor.id),
              memberUids: descriptor.memberUids.filter(uid => identities.has(uid)).map(uid => identities.get(uid)),
              exemptUids: (descriptor.exemptUids || []).filter(uid => identities.has(uid)).map(uid => identities.get(uid)),
            };
          });
        }
        if (entry.group) {
          const key = entry.group.key || entry.group.sourceId || entry.group.id || entry.group.title + ':' + entry.group.color;
          if (!groupKeys.has(key)) groupKeys.set(key, crypto.randomUUID());
          entry.group.key = groupKeys.get(key);
        }
        if (entry.group && entry.group.temporaryId) {
          entry.group.temporaryId = groups.get(entry.group.temporaryId) || null;
        }
      }
    } else if (existingWindow) {
      entries.forEach(entry => { entry.windowId = existingWindow.id; });
    }
    const options = { recordUndo: true, reason: 'Legacy saved-session restore' };
    if (suspendMode === 1) options.asleep = true;
    else if (suspendMode === 2) options.asleep = false;
    let restored;
    if (restoreOptions.recovery) recoveryInFlight += 1;
    try {
      restored = await gsWorkbenchActions.restoreEntries(entries.filter(entry => !isBrowserPageEntry(entry)), options);
      await restoreBrowserPages(entries, restored, existingWindow);
    } finally {
      if (restoreOptions.recovery) recoveryInFlight -= 1;
    }
    gsBrowser.runtime.sendMessage({ action: 'legacy.recovery.changed' }, () => {
      void gsBrowser.runtime.lastError;
    });
    if (restored.skipped.length) {
      const error = new Error(restored.skipped.flatMap(item => item.reasons).join('; '));
      error.restored = Array.from(restored).concat(restored.partial || []);
      throw error;
    }
    if (restoreOptions.recovery) await settlePendingRecovery(sessionWindow, entries.filter(entry => !isBrowserPageEntry(entry)), restored);
    return Array.from(restored);
  }


  // Session metrics tracking functions removed for privacy

  return {
    initAsPromised,
    runStartupChecks,
    finishStartupTabChecks,
    completeStartupRecovery,
    getSessionId,
    buildCurrentSession,
    updateCurrentSession,
    isInitialising,
    isUpdated,
    isFileUrlsAccessAllowed,
    getTabCheckTimeTakenInSeconds,
    getRecoveryTimeTakenInSeconds,
    getStartupType,
    setSynchedSettingsOnInit,
    getStartupLastVersion,
    recoverLostTabs,
    triggerDiscardOfAllTabs,
    restoreSessionWindow,
    prepareForUpdate,
    getUpdateType,
  };
})();
