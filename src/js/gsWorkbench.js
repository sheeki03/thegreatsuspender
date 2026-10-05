/* Local-only tab policies, durable identity and feature-module integration. */
var gsWorkbench = (() => {
  'use strict';
  const STORAGE_KEY = 'gsWorkbenchState';
  const ALARM = 'gs-workbench-minute';
  const defaults = {
    countEnabled: false, awakeLimit: 50, awakeTarget: 40,
    snapshotEnabled: false, snapshotIntervalMinutes: 1440, snapshotKeep: 30,
    lastSnapshotAt: 0, theme: 'system',
  };
  // Per-tab metadata the workbench still uses. Older installs stored more
  // (activity, expiry, meeting mode); hydrate() drops the rest.
  const META_KEYS = ['uid', 'url', 'title', 'windowId', 'windowOrdinal', 'index', 'workspaceId', 'createdAt',
    'lastViewedAt', 'dirty', 'documentToken', 'tempWhitelist', 'snooze', 'status', 'group'];
  let state = null;
  let ready = false;
  let writing = Promise.resolve();
  let initializing = null;
  let startupRequested = false;
  let starting = null;
  let tickRunning = null;
  let countRunning = null;
  let countTimer = null;
  let notifyTimer = null;
  let focusedWindowId = gsBrowser.windows.WINDOW_ID_NONE;
  let focusedTabId = null;
  let lastVisibleUid = null;
  let activityGeneration = 0;
  let windowGeneration = 0;
  const commands = new Map();
  const tickHandlers = [];
  const viewHandlers = new Map();
  const windowsById = new Map();
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readyPromise.catch(() => {});

  const createdTabs = new Map();
  function clone(value) { return structuredClone(value); }
  function uuid() { return crypto.randomUUID(); }
  function call(owner, method, ...args) {
    return new Promise((resolve, reject) => {
      owner[method](...args, result => {
        const error = gsBrowser.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }
  function originalUrl(tab) {
    const url = tab.url || tab.pendingUrl || '';
    return gsUtils.isSuspendedUrl(url) ? gsUtils.getOriginalUrl(url) : url;
  }
  function normalTab(tab) {
    if (!tab || tab.incognito) return false;
    const url = originalUrl(tab);
    return /^(https?|file):\/\//i.test(url) && !gsUtils.isSpecialTab({ ...tab, url });
  }
  function domainOf(url) {
    try { return new URL(url).hostname || 'Local files'; }
    catch (_) { return ''; }
  }
  function tabStatus(tab) {
    if (gsUtils.isSuspendedTab(tab)) return 'suspended';
    if (tab.discarded) return 'discarded';
    return tab.status === 'loading' ? 'loading' : 'awake';
  }
  function initialState() {
    return {
      version: 1, revision: 0, installedAt: Date.now(), browserSession: uuid(),
      currentWorkspaceId: null, settings: clone(defaults), meta: {},
      workspaces: [], archive: [], undo: null, snapshots: [],
    };
  }
  function pick(source, keys) {
    const result = {};
    for (const key of keys) if (source && Object.hasOwn(source, key)) result[key] = source[key];
    return result;
  }
  function hydrate(saved) {
    if (!saved) return initialState();
    if (saved.version !== 1) throw new Error('Unsupported local workspace data version. Export your existing sessions before changing extension versions.');
    const base = initialState();
    const value = { ...base, ...pick(saved, Object.keys(base)) };
    if (saved.lastCountResult) value.lastCountResult = saved.lastCountResult;
    value.settings = { ...base.settings, ...pick(saved.settings, Object.keys(defaults)) };
    value.meta = {};
    for (const [id, meta] of Object.entries(saved.meta || {})) value.meta[id] = pick(meta, META_KEYS);
    return value;
  }
  function notify() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      gsBrowser.runtime.sendMessage({ action: 'workbenchChanged', revision: state.revision }, () => {
        // No open extension view is normal; consume only this broadcast error.
        void gsBrowser.runtime.lastError;
      });
    }, 100);
  }
  function update(mutator) {
    if (!state) return Promise.reject(new Error('Workspace storage is not ready.'));
    const operation = writing.then(async () => {
      const draft = clone(state);
      const result = mutator(draft);
      if (result && typeof result.then === 'function') {
        throw new Error('Workspace transactions must not await browser operations.');
      }
      draft.revision = state.revision + 1;
      await call(gsBrowser.storage.local, 'set', { [STORAGE_KEY]: draft });
      state = draft;
      notify();
      return result;
    });
    writing = operation.catch(() => {});
    return operation;
  }
  function getState() { return state; }
  function getMeta(tabId) { return state && state.meta[String(tabId)] || null; }
  function activeUntil(value, now = Date.now()) {
    return !!value && (!value.until || value.until > now) &&
      (!value.session || value.session === state.browserSession);
  }
  function getPolicy(tabId) {
    const base = {
      suspendMinutes: Number(gsStorage.getOption(gsStorage.SUSPEND_TIME)),
      ignorePinned: !!gsStorage.getOption(gsStorage.IGNORE_PINNED),
      ignoreAudio: !!gsStorage.getOption(gsStorage.IGNORE_AUDIO),
      ignoreForms: !!gsStorage.getOption(gsStorage.IGNORE_FORMS),
      ignoreActive: !!gsStorage.getOption(gsStorage.IGNORE_ACTIVE_TABS),
      countEnabled: state ? state.settings.countEnabled : false,
      awakeLimit: state ? state.settings.awakeLimit : 50,
      awakeTarget: state ? state.settings.awakeTarget : 40,
    };
    const meta = getMeta(tabId);
    const workspace = state && meta && state.workspaces.find(item => item.id === meta.workspaceId);
    return { ...base, ...(workspace && workspace.policy) };
  }
  function getSuspendMinutes(tabId) { return String(getPolicy(tabId).suspendMinutes); }
  // Only typing the page reported counts as unsaved work. "Couldn't check" is
  // not evidence of a draft: most pages embed cross-site frames we can't read.
  const UNSAVED_REASON = 'Unsaved form or editable content';
  function draftsProtected(tabId, action, options) {
    if (options.ignoreDrafts) return false;
    return !(action === 'suspend' && options.respectSuspensionPolicy) || getPolicy(tabId).ignoreForms;
  }
  function getProtectionReasonsSync(tab, action = 'suspend', options = {}) {
    if (!normalTab(tab)) return ['Browser, private, or extension page'];
    if (action === 'restore') return [];
    const meta = getMeta(tab.id) || tab.meta || {};
    const policy = getPolicy(tab.id);
    const reasons = [];
    const protectDrafts = draftsProtected(tab.id, action, options);
    // An explicit action on tabs the person chose overrides keep-awake rules;
    // those exist for automatic and bulk suspension. Unsaved typing still counts.
    const explicit = !!options.explicit;
    if (meta.tempWhitelist && !explicit) reasons.push('Temporarily excluded');
    if (activeUntil(meta.snooze) && !explicit) reasons.push('Snoozed');
    if (protectDrafts && (meta.dirty || tab.dirty)) reasons.push(UNSAVED_REASON);
    if (!explicit && (!(action === 'suspend' && options.respectSuspensionPolicy) || policy.ignoreAudio) && tab.audible) reasons.push('Playing audio');
    if (action === 'close' || action === 'archive') {
      if (tab.pinned && !explicit) reasons.push('Pinned tab');
    } else {
      if (!options.allowActive && (tab.id === focusedTabId || (policy.ignoreActive && tab.active))) reasons.push('Active tab');
      if (!explicit && policy.ignorePinned && tab.pinned) reasons.push('Pinned tab');
      if (!explicit && gsUtils.checkWhiteList(originalUrl(tab))) reasons.push('Always keep awake');
      if (tab.status === 'loading') reasons.push('Page is still loading');
      if (!explicit && gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) && !navigator.onLine) reasons.push('Browser is offline');
      if (!explicit && gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) && tgs.isCharging()) reasons.push('Computer is charging');
    }
    return [...new Set(reasons)];
  }
  async function draftInfo(tab) {
    let expired = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('The page did not respond to draft verification.'));
      }, 3000);
    });
    const inspect = async () => {
      if (expired) throw new Error('Draft verification timed out.');
      try {
        return await call(gsBrowser.tabs, 'sendMessage', tab.id, { action: 'requestInfo' });
      } catch (error) {
        if (expired || !/receiving end does not exist|could not establish connection/i.test(error.message)) throw error;
        await call(gsBrowser.scripting, 'executeScript', { target: { tabId: tab.id }, files: ['js/contentscript.js'] });
        if (expired) throw new Error('Draft verification timed out.');
        return call(gsBrowser.tabs, 'sendMessage', tab.id, { action: 'requestInfo' });
      }
    };
    try { return await Promise.race([inspect(), timeout]); }
    finally { clearTimeout(timer); }
  }
  async function getProtectionReasons(row, action = 'suspend', options = {}) {
    let tab;
    try { tab = await call(gsBrowser.tabs, 'get', row.id); }
    catch (_) { return ['Tab no longer exists']; }
    if (row.originalUrl && originalUrl(tab) !== row.originalUrl) return ['Page changed since selection'];
    if (action === 'restore') return normalTab(tab) ? [] : ['Browser, private, or extension page'];
    const reasons = getProtectionReasonsSync(tab, action, options);
    if (tabStatus(tab) === 'suspended' || tab.discarded) return reasons;
    if (!normalTab(tab)) return reasons;
    try {
      const info = await draftInfo(tab);
      if (!info || typeof info.dirty !== 'boolean') return reasons;
      const dirty = info.dirty || info.status === 'formInput';
      const tempWhitelist = typeof info.temporaryWhitelist === 'boolean'
        ? info.temporaryWhitelist : info.status === 'tempWhitelist';
      const known = getMeta(tab.id) || {};
      if (known.dirty !== dirty || !!known.tempWhitelist !== tempWhitelist || known.documentToken !== info.documentToken) {
        await update(draft => {
          if (draft.meta[tab.id]) Object.assign(draft.meta[tab.id], { dirty, tempWhitelist, documentToken: info.documentToken });
        });
      }
      // Fresh info can clear a submitted/reset form; don't retain a stale cached reason.
      const fresh = reasons.filter(reason => ![UNSAVED_REASON, 'Temporarily excluded'].includes(reason));
      if (dirty && draftsProtected(tab.id, action, options)) fresh.push(UNSAVED_REASON);
      if (tempWhitelist && !options.explicit) fresh.push('Temporarily excluded');
      return [...new Set(fresh)];
    } catch (_) {
      // A page that can't answer is treated like the original extension did: not dirty.
      return reasons;
    }
  }
  function newMeta(tab) {
    const url = originalUrl(tab);
    return {
      uid: uuid(), url, title: tab.title || url, windowId: tab.windowId, windowOrdinal: 0, index: tab.index,
      workspaceId: null, createdAt: createdTabs.get(tab.id) || Date.now(),
      lastViewedAt: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
      dirty: false, documentToken: null, tempWhitelist: false, snooze: null, status: tabStatus(tab),
    };
  }
  function rowFrom(tab, groups) {
    const meta = getMeta(tab.id) || newMeta(tab);
    const group = groups && groups.get(tab.groupId);
    const workspace = state.workspaces.find(item => item.id === meta.workspaceId);
    const status = tabStatus(tab);
    const url = originalUrl(tab);
    const row = { ...tab, uid: meta.uid, originalUrl: url, domain: domainOf(url),
      title: gsUtils.isSuspendedTab(tab) ? gsUtils.getSuspendedTitle(tab.url) || meta.title || url : tab.title || url,
      status, asleep: status === 'suspended' || status === 'discarded',
      windowOrdinal: (windowsById.get(tab.windowId) || {}).ordinal || 0,
      window: windowsById.get(tab.windowId) || null,
      groupTitle: group ? group.title || '' : tab.groupId >= 0 && meta.group ? meta.group.title || '' : '',
      groupColor: group ? group.color : meta.group && meta.group.color || 'grey',
      groupCollapsed: group ? group.collapsed : false,
      groupStartIndex: group ? group.startIndex : tab.index,
      groupKey: group ? group.key : null,
      workspaceId: meta.workspaceId, workspaceName: workspace ? workspace.name : '',
      createdAt: meta.createdAt, lastViewedAt: meta.lastViewedAt,
      snooze: activeUntil(meta.snooze) ? meta.snooze : null, dirty: meta.dirty, meta,
    };
    row.protectionReasons = getProtectionReasonsSync(row);
    return row;
  }
  async function browserWindows() {
    const generation = ++windowGeneration;
    const focusGeneration = activityGeneration;
    const windows = await call(gsBrowser.windows, 'getAll', { windowTypes: ['normal'] });
    if (generation !== windowGeneration) return Array.from(windowsById.values());
    windowsById.clear();
    const normal = windows.filter(item => !item.incognito).sort((a, b) => a.id - b.id);
    normal.forEach((window, ordinal) => windowsById.set(window.id, { ...window, ordinal }));
    if (focusGeneration === activityGeneration) {
      const focused = normal.find(window => window.focused);
      focusedWindowId = focused ? focused.id : gsBrowser.windows.WINDOW_ID_NONE;
    }
    return normal;
  }
  async function getTabs() {
    if (gsBrowser.extension.inIncognitoContext) return [];
    await writing;
    await browserWindows();
    const [tabs, groups] = await Promise.all([
      call(gsBrowser.tabs, 'query', {}),
      call(gsBrowser.tabGroups, 'query', {}),
    ]);
    const byGroup = new Map(groups.map(group => [group.id, group]));
    const groupKeys = new Map();
    const keyOwners = new Map();
    for (const tab of tabs) {
      const group = byGroup.get(tab.groupId);
      if (!group || group.windowId !== tab.windowId) continue;
      group.startIndex = Math.min(group.startIndex ?? Infinity, tab.index);
      const key = getMeta(tab.id)?.group?.key;
      if (!key) continue;
      if (!groupKeys.has(group.id)) groupKeys.set(group.id, new Set());
      groupKeys.get(group.id).add(key);
      if (!keyOwners.has(key)) keyOwners.set(key, new Set());
      keyOwners.get(key).add(group.id);
    }
    for (const group of groups) {
      const keys = groupKeys.get(group.id);
      const key = keys?.size === 1 ? keys.values().next().value : null;
      group.key = key && keyOwners.get(key).size === 1
        ? key : `${state.browserSession}:${group.windowId}:${group.id}`;
    }
    const managed = tabs.filter(normalTab);
    const missing = managed.filter(tab => !getMeta(tab.id));
    if (ready && missing.length) {
      const added = await update(draft => {
        const ids = [];
        for (const tab of missing) {
          if (draft.meta[tab.id]) continue;
          draft.meta[tab.id] = newMeta(tab);
          ids.push(tab.id);
        }
        return ids;
      });
      for (const id of added) createdTabs.delete(id);
    }
    const rows = managed.map(tab => rowFrom(tab, byGroup));
    const witnesses = new Map();
    for (const row of rows) {
      if (!witnesses.has(row.windowId)) witnesses.set(row.windowId, []);
      witnesses.get(row.windowId).push(row.uid);
    }
    for (const row of rows) row.windowWitnessUids = witnesses.get(row.windowId);
    return rows;
  }
  function tabSnapshot(row) {
    const group = row.groupId >= 0 ? {
      sourceId: row.groupId, key: row.groupKey || `${state.browserSession}:${row.windowId}:${row.groupId}`,
      startIndex: row.groupStartIndex ?? row.index,
      title: row.groupTitle || '', color: row.groupColor || 'grey', collapsed: !!row.groupCollapsed,
    } : null;
    const window = row.window || windowsById.get(row.windowId) || {};
    return gsWorkbenchWorkspaces.decorateSnapshot({
      uid: row.uid, tabId: row.id, title: row.title, originalUrl: row.originalUrl,
      windowId: row.windowId, windowOrdinal: row.windowOrdinal, index: row.index,
      windowWitnessUids: clone(row.windowWitnessUids || [row.uid]),
      pinned: !!row.pinned, active: !!row.active, asleep: !!row.asleep, status: row.status,
      group, windowFocused: !!window.focused,
      windowBounds: { left: window.left, top: window.top, width: window.width, height: window.height,
        state: window.state || 'normal', type: window.type || 'normal' },
      meta: clone(row.meta),
    }, row, state);
  }

  async function rememberRows(rows) {
    const snapshots = rows.map(tabSnapshot);
    if (!snapshots.length) return;
    await update(draft => {
      for (const snapshot of snapshots) {
        const workspace = draft.workspaces.find(item => item.id === snapshot.meta.workspaceId);
        const meta = draft.meta[snapshot.tabId];
        if (!meta || meta.uid !== snapshot.uid || meta.url !== snapshot.originalUrl) continue;
        Object.assign(meta, { windowId: snapshot.windowId, windowOrdinal: snapshot.windowOrdinal, index: snapshot.index });
        for (const item of draft.workspaces) {
          if (item.id === meta.workspaceId) continue;
          item.members = item.members.filter(uid => uid !== meta.uid);
          item.savedTabs = item.savedTabs.filter(entry => entry.uid !== meta.uid);
        }
        if (!workspace) { meta.group = clone(snapshot.group); continue; }
        const index = workspace.savedTabs.findIndex(item => item.uid === snapshot.uid);
        meta.group = clone(snapshot.group);
        if (index >= 0) workspace.savedTabs[index] = snapshot;
        else workspace.savedTabs.push(snapshot);
        if (!workspace.members.includes(snapshot.uid)) workspace.members.push(snapshot.uid);
      }
    });
  }

  async function attachMeta(tabId, snapshot) {
    const tab = await call(gsBrowser.tabs, 'get', tabId);
    return update(draft => {
      const meta = { ...newMeta(tab), ...pick(snapshot.meta || {}, META_KEYS),
        uid: snapshot.uid || snapshot.meta && snapshot.meta.uid || uuid(),
        url: snapshot.originalUrl || originalUrl(tab), title: snapshot.title || tab.title,
        windowId: tab.windowId, index: tab.index, status: tabStatus(tab), dirty: false,
        tempWhitelist: false, documentToken: null };
      const current = draft.meta[tabId];
      if (current && current.uid === meta.uid && current.url === meta.url) {
        meta.dirty = current.dirty;
        meta.tempWhitelist = current.tempWhitelist;
        meta.documentToken = current.documentToken;
        meta.snooze = current.snooze;
        meta.lastViewedAt = current.lastViewedAt;
      }
      if (Object.entries(draft.meta).some(([id, other]) => Number(id) !== tabId && other.uid === meta.uid)) {
        throw new Error('Cannot attach the same saved tab identity to two live tabs.');
      }
      if (meta.snooze && meta.snooze.session && meta.snooze.session !== draft.browserSession) meta.snooze = null;
      draft.meta[tabId] = meta;
      let workspace = draft.workspaces.find(item => item.id === meta.workspaceId);
      if (meta.workspaceId && !workspace) {
        workspace = draft.workspaces.find(item => item.members.includes(meta.uid) ||
          item.savedTabs.some(entry => entry.uid === meta.uid));
        meta.workspaceId = workspace ? workspace.id : null;
      }
      for (const item of draft.workspaces) {
        if (item.id === meta.workspaceId) continue;
        item.members = item.members.filter(uid => uid !== meta.uid);
        item.savedTabs = item.savedTabs.filter(entry => entry.uid !== meta.uid);
      }
      if (workspace && !workspace.members.includes(meta.uid)) workspace.members.push(meta.uid);
    });
  }
  function register(command, handler) {
    if (commands.has(command)) throw new Error(`Duplicate workspace command: ${command}`);
    commands.set(command, handler);
  }
  function registerTick(handler) { tickHandlers.push(handler); }
  function registerView(name, handler) { viewHandlers.set(name, handler); }
  async function execute(command, payload = {}, sender) {
    await readyPromise;
    if (gsBrowser.extension.inIncognitoContext && command !== 'view.get' && !command.startsWith('legacy.')) {
      throw new Error('Workspaces, snooze and undo are not available in private windows.');
    }
    const handler = commands.get(command);
    if (!handler) throw new Error(`Unknown workspace command: ${command}`);
    return handler(payload || {}, sender);
  }
  function shouldPreventAutoDiscard(tab, report) {
    const meta = getMeta(tab.id) || {};
    const policy = getPolicy(tab.id);
    if (report && meta.documentToken && report.documentToken !== meta.documentToken) report = null;
    const dirty = report && typeof report.dirty === 'boolean' ? report.dirty : meta.dirty;
    const temporary = report ? (typeof report.temporaryWhitelist === 'boolean'
      ? report.temporaryWhitelist : report.status === 'tempWhitelist') : meta.tempWhitelist;
    return activeUntil(meta.snooze) || !!temporary ||
      (policy.ignoreForms && dirty) || gsUtils.checkWhiteList(originalUrl(tab));
  }
  async function syncAutoDiscardProtection(tabIds) {
    const selected = tabIds ? new Set(tabIds) : null;
    const tabs = await call(gsBrowser.tabs, 'query', {});
    for (const tab of tabs) {
      if (!normalTab(tab) || (selected && !selected.has(tab.id))) continue;
      const autoDiscardable = !shouldPreventAutoDiscard(tab);
      if (tab.autoDiscardable !== autoDiscardable) await call(gsBrowser.tabs, 'update', tab.id, { autoDiscardable });
    }
  }

  function refreshTimers(tabIds) {
    if (!ready) return;
    syncAutoDiscardProtection(tabIds).catch(reportError);
    if (!tabIds) {
      tgs.resetAutoSuspendTimerForAllTabs();
      return;
    }
    const selected = new Set(tabIds);
    gsBrowser.tabs.query({}, tabs => {
      for (const tab of tabs) if (selected.has(tab.id) && normalTab(tab)) tgs.resetAutoSuspendTimerForTab(tab);
    });
  }
  function selectedIds(payload) {
    if (!Array.isArray(payload.tabIds) || !payload.tabIds.length || payload.tabIds.some(id => !Number.isInteger(id))) {
      throw new Error('Select at least one tab.');
    }
    return [...new Set(payload.tabIds)];
  }
  function validateSettings(patch, current) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
    const allowed = Object.keys(defaults);
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`Unknown setting: ${key}`);
    const next = { ...current, ...patch };
    for (const key of ['countEnabled', 'snapshotEnabled']) if (typeof next[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
    for (const [key, minimum, maximum, label] of [
      ['awakeLimit', 2, 10000, 'The tab limit'], ['awakeTarget', 1, 9999, 'The number to keep awake'],
      ['snapshotIntervalMinutes', 1, 43200, 'The snapshot interval'], ['snapshotKeep', 1, 100, 'The number of snapshots to keep'],
    ]) if (!Number.isInteger(next[key]) || next[key] < minimum || next[key] > maximum) throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`);
    if (next.awakeTarget >= next.awakeLimit) throw new Error('Keep fewer tabs awake than the limit, so there is room before it triggers again.');
    if (!['system', 'light', 'dark'].includes(next.theme)) throw new Error('Invalid theme.');
    if (!Number.isFinite(next.lastSnapshotAt) || next.lastSnapshotAt < 0) throw new Error('Invalid snapshot date.');
    return next;
  }
  // Snooze keeps tabs out of automatic suspension until a time or the next browser restart.
  function setSnooze(payload, clear) {
    const ids = selectedIds(payload);
    let value = null;
    if (!clear) {
      let until = null;
      let session = null;
      if (payload.mode === 'restart') session = state.browserSession;
      else if (payload.mode === 'tomorrow') {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        until = tomorrow.getTime();
      } else if (payload.until !== undefined) {
        until = Number(payload.until);
        if (!Number.isFinite(until) || until <= Date.now()) throw new Error('Choose a future time.');
      } else if (payload.minutes !== undefined) {
        if (!Number.isFinite(payload.minutes) || payload.minutes <= 0) throw new Error('Enter a positive duration in minutes.');
        until = Date.now() + payload.minutes * 60000;
      }
      if (!until && !session) throw new Error('Choose how long to keep the tab awake.');
      value = { until, session };
    }
    return update(draft => {
      const changed = [];
      for (const id of ids) {
        const meta = draft.meta[id];
        if (!meta) continue;
        meta.snooze = value ? clone(value) : null;
        changed.push(id);
      }
      return { changed, until: value && value.until, session: value && value.session };
    }).then(async result => {
      await syncAutoDiscardProtection(result.changed);
      refreshTimers(result.changed);
      return result;
    });
  }
  async function view() {
    await writing;
    const tabs = await getTabs();
    const legacySettings = clone(gsStorage.getSettings());
    const result = { ...clone(state), tabs, legacySettings,
      focusedTabId, focusedWindowId, extensionId: gsBrowser.runtime.id,
      managedSettings: Object.keys(legacySettings).filter(key => gsStorage.isOptionManaged(key)),
      awakeCount: tabs.filter(tab => !tab.asleep).length,
      suspendedCount: tabs.filter(tab => tab.asleep).length };
    for (const [name, handler] of viewHandlers) result[name] = await handler(tabs, state, Date.now());
    return result;
  }
  async function enforceCounts() {
    if (countRunning) return countRunning;
    countRunning = (async () => {
      const scopes = [];
      if (state.settings.countEnabled) scopes.push({ id: null, ...state.settings });
      for (const workspace of state.workspaces) {
        if (workspace.policy && workspace.policy.countEnabled) scopes.push({ id: workspace.id, ...state.settings, ...workspace.policy });
      }
      const optedOut = new Set(state.workspaces.filter(workspace => workspace.policy?.countEnabled === false).map(workspace => workspace.id));
      const results = [];
      for (const scope of scopes) {
        let tabs = await getTabs();
        const inScope = tab => scope.id === null ? !optedOut.has(tab.workspaceId) : tab.workspaceId === scope.id;
        let count = tabs.filter(tab => inScope(tab) && !tab.asleep).length;
        if (count <= scope.awakeLimit) continue;
        const before = count;
        const candidates = tabs.filter(tab => inScope(tab) && !tab.asleep)
          .sort((a, b) => (a.lastViewedAt || a.createdAt) - (b.lastViewedAt || b.createdAt) || a.id - b.id);
        const changed = [];
        const skipped = [];
        for (const row of candidates) {
          if (count <= scope.awakeTarget) break;
          const outcome = await gsWorkbenchActions.perform('suspend', [row.id], {
            reason: scope.id ? 'Workspace awake-tab ceiling' : 'Awake-tab ceiling', recordUndo: false,
          });
          changed.push(...outcome.changed);
          skipped.push(...outcome.skipped);
          tabs = await getTabs();
          count = tabs.filter(tab => inScope(tab) && !tab.asleep).length;
        }
        results.push({ workspaceId: scope.id, before, after: count, target: scope.awakeTarget,
          reachedTarget: count <= scope.awakeTarget, changed, skipped });
      }
      const outcome = { scopes: results, changed: results.flatMap(item => item.changed),
        skipped: results.flatMap(item => item.skipped) };
      if (results.length) await update(draft => { draft.lastCountResult = outcome; });
      return outcome;
    })();
    try { return await countRunning; }
    finally { countRunning = null; }
  }
  function scheduleCounts() {
    if (!ready || countTimer) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      enforceCounts().catch(reportError);
    }, 500);
  }
  function reportError(error) {
    console.error('Tab workbench:', error);
    if (state) update(draft => { draft.lastError = { message: error.message || String(error), at: Date.now() }; }).catch(console.error);
  }
  // Tracks the focused tab (it is never auto-suspended) and when each tab was
  // last viewed, so the tab limit suspends the least recently used tabs first.
  async function activityBoundary() {
    if (!ready || gsBrowser.extension.inIncognitoContext) return;
    const generation = ++activityGeneration;
    const windowId = focusedWindowId;
    if (windowId === gsBrowser.windows.WINDOW_ID_NONE) {
      lastVisibleUid = null;
      focusedTabId = null;
      return;
    }
    const tabs = await call(gsBrowser.tabs, 'query', { active: true, windowId });
    if (generation !== activityGeneration || windowId !== focusedWindowId) return;
    const tab = tabs[0];
    focusedTabId = tab ? tab.id : null;
    const meta = tab && normalTab(tab) ? getMeta(tab.id) : null;
    if (!meta) { lastVisibleUid = null; return; }
    if (meta.uid === lastVisibleUid) return;
    lastVisibleUid = meta.uid;
    await update(draft => {
      const current = draft.meta[tab.id];
      if (!current || current.uid !== meta.uid) return;
      current.lastViewedAt = Date.now();
      const workspace = draft.workspaces.find(item => item.id === current.workspaceId);
      const saved = workspace && workspace.savedTabs.find(item => item.uid === current.uid);
      if (saved && saved.meta) saved.meta.lastViewedAt = current.lastViewedAt;
    });
  }
  async function tick(now = Date.now()) {
    await readyPromise;
    if (tickRunning) return tickRunning;
    tickRunning = (async () => {
      const expired = Object.values(state.meta).some(meta => meta.snooze && !activeUntil(meta.snooze, now));
      if (expired) {
        await update(draft => {
          for (const meta of Object.values(draft.meta)) {
            if (meta.snooze && !activeUntil(meta.snooze, now)) meta.snooze = null;
          }
        });
        refreshTimers();
      }
      for (const handler of tickHandlers) await handler(now);
      await enforceCounts();
    })();
    try { return await tickRunning; }
    finally { tickRunning = null; }
  }
  async function browserStartup() {
    if (starting) return starting;
    starting = (async () => {
      await readyPromise;
      startupRequested = false;
      await update(draft => {
        draft.browserSession = uuid();
        for (const meta of Object.values(draft.meta)) {
          if (meta.snooze && meta.snooze.session) meta.snooze = null;
        }
      });
      refreshTimers();
    })();
    try { await starting; }
    finally { starting = null; }
  }
  async function seedTabs() {
    await browserWindows();
    const raw = (await call(gsBrowser.tabs, 'query', {})).filter(normalTab);
    const oldUrlCounts = new Map();
    for (const meta of Object.values(state.meta)) oldUrlCounts.set(meta.url, (oldUrlCounts.get(meta.url) || 0) + 1);
    const liveWitnesses = new Map();
    const candidates = raw.filter(tab => {
      const previous = state.meta[tab.id];
      return previous?.documentToken && previous.url === originalUrl(tab) &&
        oldUrlCounts.get(previous.url) > 1 && !gsUtils.isSuspendedTab(tab) && !tab.discarded;
    });
    await Promise.all(candidates.map(async tab => {
      const previous = state.meta[tab.id];
      try {
        const info = await draftInfo(tab);
        if (info?.documentToken === previous.documentToken) liveWitnesses.set(tab.id, previous.uid);
      } catch (_) {
        // An unverified document is not evidence that a numeric tab ID survived.
      }
    }));
    const reservedUids = new Set(liveWitnesses.values());
    await update(draft => {
      const old = Object.entries(draft.meta);
      const next = {};
      const used = new Set();
      for (const tab of raw) {
        const url = originalUrl(tab);
        const witnessedUid = liveWitnesses.get(tab.id);
        const available = ([id, meta]) => !used.has(id) && (!reservedUids.has(meta.uid) || meta.uid === witnessedUid);
        let match = witnessedUid && old.find(entry => available(entry) && entry[1].uid === witnessedUid && entry[1].url === url);
        if (!match) match = old.find(entry => available(entry) && entry[1].url === url &&
          entry[1].windowOrdinal === (windowsById.get(tab.windowId) || {}).ordinal && entry[1].index === tab.index);
        if (!match) match = old.find(entry => available(entry) && entry[1].url === url);
        const meta = match ? clone(match[1]) : newMeta(tab);
        if (match) used.add(match[0]);
        Object.assign(meta, { url, windowId: tab.windowId, index: tab.index,
          windowOrdinal: (windowsById.get(tab.windowId) || {}).ordinal || 0, status: tabStatus(tab) });
        next[tab.id] = meta;
      }
      draft.meta = next;
    });
    const active = raw.find(tab => tab.windowId === focusedWindowId && tab.active);
    focusedTabId = active ? active.id : null;
  }
  async function observeTab(tab) {
    if (!normalTab(tab)) {
      if (tab.id === focusedTabId) await activityBoundary();
      return;
    }
    const change = await update(draft => {
      const previous = draft.meta[tab.id];
      const meta = previous || newMeta(tab);
      const previousStatus = previous && previous.status;
      const status = tabStatus(tab);
      const previousUrl = meta.url;
      const url = originalUrl(tab);
      meta.title = gsUtils.isSuspendedTab(tab) ? meta.title : tab.title || meta.title;
      Object.assign(meta, { url, status, windowId: tab.windowId, index: tab.index,
        windowOrdinal: (windowsById.get(tab.windowId) || {}).ordinal || 0 });
      const asleep = status === 'suspended' || status === 'discarded';
      // A new document, or a sleeping one, has no typing in it yet.
      if ((previousUrl !== url && status !== 'suspended') || (status === 'loading' && previousStatus !== 'loading') ||
          (asleep && previousStatus !== status)) {
        meta.dirty = false;
        meta.tempWhitelist = false;
        meta.documentToken = null;
      }
      draft.meta[tab.id] = meta;
      return { previousStatus, status, urlChanged: previousUrl !== url };
    });
    createdTabs.delete(tab.id);
    const row = (await getTabs()).find(item => item.id === tab.id);
    if (!row) return;
    await rememberRows([row]);
    if (tab.id === focusedTabId && (change.urlChanged || change.status !== change.previousStatus)) await activityBoundary();
    scheduleCounts();
  }
  function installEvents() {
    gsBrowser.tabs.onCreated.addListener(tab => {
      if (!tab.incognito) createdTabs.set(tab.id, Date.now());
      readyPromise.then(() => observeTab(tab)).catch(reportError);
    });
    gsBrowser.tabs.onUpdated.addListener((tabId, changes, tab) => {
      if (Object.keys(changes).some(key => ['url', 'status', 'discarded', 'title', 'pinned', 'audible', 'groupId'].includes(key))) {
        readyPromise.then(() => observeTab(tab)).catch(reportError);
      }
    });
    gsBrowser.tabs.onActivated.addListener(info => {
      const generation = ++activityGeneration;
      readyPromise.then(async () => {
        const window = await call(gsBrowser.windows, 'get', info.windowId);
        if (generation !== activityGeneration) return;
        if (window.focused) { focusedWindowId = info.windowId; focusedTabId = info.tabId; }
        await activityBoundary();
      }).catch(reportError);
    });
    gsBrowser.windows.onFocusChanged.addListener(windowId => {
      ++activityGeneration;
      focusedWindowId = windowId;
      readyPromise.then(activityBoundary).catch(reportError);
    });
    gsBrowser.windows.onCreated.addListener(() => { readyPromise.then(browserWindows).catch(reportError); });
    gsBrowser.windows.onRemoved.addListener(() => { readyPromise.then(browserWindows).catch(reportError); });
    gsBrowser.windows.onBoundsChanged.addListener(window => {
      if (window.incognito || window.type !== 'normal') return;
      const previous = windowsById.get(window.id);
      if (previous) windowsById.set(window.id, { ...previous, ...window });
      readyPromise.then(() => update(draft => {
        const liveUids = new Set(Object.values(draft.meta)
          .filter(meta => meta.windowId === window.id).map(meta => meta.uid));
        for (const workspace of draft.workspaces) {
          for (const entry of workspace.savedTabs) {
            if (!liveUids.has(entry.uid)) continue;
            entry.windowBounds = { left: window.left, top: window.top, width: window.width,
              height: window.height, state: window.state || 'normal', type: 'normal' };
          }
        }
      })).catch(reportError);
    });
    gsBrowser.tabs.onRemoved.addListener(tabId => {
      readyPromise.then(async () => {
        createdTabs.delete(tabId);
        const meta = await update(draft => {
          const removed = draft.meta[tabId];
          delete draft.meta[tabId];
          return removed;
        });
        if (!meta) return;
        if (tabId === focusedTabId) await activityBoundary();
        scheduleCounts();
      }).catch(reportError);
    });
    gsBrowser.tabs.onReplaced.addListener((addedId, removedId) => {
      readyPromise.then(async () => {
        await update(draft => {
          if (draft.meta[removedId]) { draft.meta[addedId] = draft.meta[removedId]; delete draft.meta[removedId]; }
        });
        if (focusedTabId === removedId) focusedTabId = addedId;
      }).catch(reportError);
    });
    gsBrowser.tabs.onMoved.addListener(() => {
      readyPromise.then(getTabs).then(rememberRows).catch(reportError);
    });
    gsBrowser.tabs.onAttached.addListener(() => {
      readyPromise.then(browserWindows).then(getTabs).then(rememberRows).then(scheduleCounts).catch(reportError);
    });
    gsBrowser.tabGroups.onUpdated.addListener(group => {
      readyPromise.then(getTabs).then(rows => rememberRows(rows.filter(row => row.groupId === group.id))).catch(reportError);
    });
    gsBrowser.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) tick().catch(reportError); });
  }
  function installCommands() {
    register('view.get', view);
    register('settings.update', async payload => {
      await update(draft => { draft.settings = validateSettings(payload.settings, draft.settings); });
      refreshTimers();
      scheduleCounts();
      return clone(state.settings);
    });
    register('legacy.update', async payload => {
      const patch = payload.settings;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid browser settings.');
      const old = clone(gsStorage.getSettings());
      for (const key of Object.keys(patch)) {
        if (!Object.hasOwn(old, key)) throw new Error(`Unknown browser setting: ${key}`);
        if (gsStorage.isOptionManaged(key)) throw new Error(`Your administrator controls ${key}.`);
      }
      const changed = Object.keys(patch).filter(key => !Object.is(old[key], patch[key]));
      for (const key of changed) gsStorage.setOptionAndSync(key, patch[key]);
      if (changed.length) gsUtils.performPostSaveUpdates(changed, old, gsStorage.getSettings());
      refreshTimers();
      notify();
      return clone(gsStorage.getSettings());
    });
    register('snooze.set', payload => setSnooze(payload, false));
    register('snooze.clear', payload => setSnooze(payload, true));
    register('counts.enforce', enforceCounts);
  }
  function initAsPromised() {
    if (initializing) return initializing;
    initializing = (async () => {
      if (gsBrowser.extension.inIncognitoContext) {
        state = initialState();
        installCommands();
        ready = true;
        resolveReady();
        return;
      }
      const stored = await call(gsBrowser.storage.local, 'get', STORAGE_KEY);
      state = hydrate(stored[STORAGE_KEY]);
      if (state.lastError) await update(draft => { delete draft.lastError; });
      await seedTabs();
      installCommands();
      await gsWorkbenchActions.initAsPromised();
      await gsWorkbenchWorkspaces.initAsPromised();
      await gsWorkbenchSnapshots.initAsPromised();
      await gsSession.completeStartupRecovery();
      installEvents();
      ready = true;
      resolveReady();
      gsBrowser.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
      refreshTimers();
      await activityBoundary();
      if (startupRequested) await browserStartup();
      scheduleCounts();
    })();
    initializing.catch(error => { rejectReady(error); reportError(error); });
    return initializing;
  }
  gsBrowser.runtime.onStartup.addListener(() => {
    startupRequested = true;
    if (ready) browserStartup().catch(reportError);
  });
  gsBrowser.runtime.onMessage.addListener((request, sender, respond) => {
    if (request && request.action === 'reportTabState' && sender.tab && !sender.tab.incognito) {
      if (ready && typeof request.dirty === 'boolean' && typeof request.documentToken === 'string') {
        (async () => {
          const tab = await call(gsBrowser.tabs, 'get', sender.tab.id);
          if (!normalTab(tab) || tabStatus(tab) === 'suspended' || tab.discarded) return;
          const info = await draftInfo(tab);
          if (!info || info.documentToken !== request.documentToken) return;
          const previous = getMeta(tab.id);
          if (!previous || (previous.dirty === !!info.dirty &&
            previous.tempWhitelist === !!info.temporaryWhitelist && previous.documentToken === info.documentToken)) return;
          await update(draft => {
            const meta = draft.meta[tab.id];
            if (!meta || meta.url !== originalUrl(tab)) return;
            Object.assign(meta, { dirty: !!info.dirty,
              documentToken: info.documentToken, tempWhitelist: !!info.temporaryWhitelist });
          });
          await syncAutoDiscardProtection([tab.id]);
          tgs.resetAutoSuspendTimerForTab(tab);
        })().catch(error => { if (!/No tab|Invalid tab|not found/i.test(error.message)) reportError(error); });
      }
      return false;
    }
    if (!request || request.action !== 'workbench') return false;
    if (sender.id !== gsBrowser.runtime.id || !sender.url || !sender.url.startsWith(gsBrowser.runtime.getURL(''))) {
      respond({ ok: false, error: 'Workspace commands are available only to this extension.' });
      return false;
    }
    execute(request.command, request.payload, sender).then(data => respond({ ok: true, data }),
      error => respond({ ok: false, error: error.message || String(error) }));
    return true;
  });
  return { initAsPromised, isReady: () => ready, getState, getMeta, update, getTabs, tabSnapshot,
    attachMeta, getPolicy, getSuspendMinutes, getProtectionReasonsSync, getProtectionReasons,
    register, registerTick, registerView, execute, tick, refreshTimers, notify, shouldPreventAutoDiscard };
})();
