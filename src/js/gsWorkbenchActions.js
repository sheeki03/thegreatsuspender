/*global chrome, gsWorkbench, gsUtils, gsStorage, gsTabSuspendManager, gsTabDiscardManager, tgs */
// eslint-disable-next-line no-unused-vars
var gsWorkbenchActions = (function() {
  'use strict';

  const ACTIONS = ['suspend', 'restore', 'archive', 'close'];
  const UNDO_SUMMARY = 'Undo restores tab URLs, tab order, groups, pins and suspension state. It cannot recover unsaved page data or application JavaScript state.';
  const DRAFT_VERIFICATION_TIMEOUT_MS = 3000;
  let initialised = false;
  let operationTail = Promise.resolve();
  let restoreTimer = null;
  let nextRestoreAt = 0;
  let activeRestores = 0;
  let restoreSequence = 0;
  let restoreAdmission = Promise.resolve();
  let lastNavigationStartedAt = 0;
  const restoreJobs = [];

  function uuid() {
    return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() :
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function api(owner, name, ...args) {
    return new Promise((resolve, reject) => {
      if (!owner || typeof owner[name] !== 'function') {
        reject(new Error('Browser API unavailable: ' + name));
        return;
      }
      try {
        owner[name](...args, result => {
          const error = gsBrowser.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
          } else {
            resolve(result);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function exclusive(handler) {
    const result = operationTail.then(handler, handler);
    operationTail = result.catch(() => {});
    return result;
  }

  function tabIds(input) {
    if (!Array.isArray(input) || input.some(id => !Number.isInteger(id) || id < 0)) {
      throw new Error('Select valid tab IDs.');
    }
    return Array.from(new Set(input));
  }

  function validateAction(action) {
    if (!ACTIONS.includes(action)) {
      throw new Error('Unsupported tab action: ' + action);
    }
  }

  function originalUrl(tab) {
    return gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
  }

  function isAsleep(tab) {
    return !!tab.discarded || gsUtils.isSuspendedTab(tab);
  }

  function status(tab) {
    return gsUtils.isSuspendedTab(tab) ? 'suspended' : tab.discarded ? 'discarded' :
      tab.status === 'loading' ? 'loading' : 'awake';
  }

  function windowDiffers(entry, current) {
    const bounds = entry.windowBounds;
    if (!bounds || !current) return false;
    return (bounds.state && bounds.state !== current.state) ||
      ['left', 'top', 'width', 'height'].some(name =>
        (!bounds.state || bounds.state === 'normal') &&
        Number.isInteger(bounds[name]) && bounds[name] !== current[name]);
  }

  function snapshot(row) {
    const entry = copy(gsWorkbench.tabSnapshot(row));
    entry.status = row.status;
    entry.url = row.url;
    if (entry.group && row.groupId >= 0) {
      entry.group.sourceId = row.groupId;
      if (Number.isInteger(row.groupStartIndex)) entry.group.startIndex = row.groupStartIndex;
    }
    return entry;
  }

  async function readRow(id, reference) {
    const tab = await api(gsBrowser.tabs, 'get', id);
    if (tab.incognito || gsUtils.isSpecialTab(tab) || gsUtils.isFileTab(tab) && gsUtils.isBlockedFileTab(tab)) {
      throw new Error('Tab is not an eligible normal browser page.');
    }
    const meta = gsWorkbench.getMeta(id) || {};
    const row = {
      ...reference,
      ...tab,
      id,
      uid: meta.uid || (reference && reference.uid),
      originalUrl: originalUrl(tab),
      title: gsUtils.isSuspendedTab(tab) ? gsUtils.getSuspendedTitle(tab.url) || meta.title || originalUrl(tab) : tab.title || originalUrl(tab),
      status: status(tab),
      asleep: isAsleep(tab),
      workspaceId: meta.workspaceId || null,
      windowOrdinal: reference && reference.windowId === tab.windowId ? reference.windowOrdinal : meta.windowOrdinal,
      dirty: !!meta.dirty,
      draftUnverified: !!meta.draftUnverified,
      meta,
      window: await api(gsBrowser.windows, 'get', tab.windowId),
      snooze: meta.snooze || null,
      protection: meta.protection || null,
    };
    if (tab.groupId >= 0) {
      const group = await api(gsBrowser.tabGroups, 'get', tab.groupId);
      row.groupTitle = group.title || '';
      row.groupColor = group.color;
      row.groupCollapsed = !!group.collapsed;
      const members = await api(gsBrowser.tabs, 'query', { groupId: tab.groupId });
      row.groupStartIndex = Math.min(...members.map(member => member.index));
    } else {
      row.groupTitle = '';
      row.groupColor = null;
      row.groupCollapsed = false;
    }
    const windowTabs = await api(gsBrowser.tabs, 'query', { windowId: tab.windowId });
    row.windowWitnessUids = windowTabs.map(member => (gsWorkbench.getMeta(member.id) || {}).uid).filter(Boolean);
    row.expiresAt = gsWorkbenchWorkspaces.getTemporaryInfo(row).expiresAt;
    return row;
  }

  function expectedReasons(row, options) {
    if (!Array.isArray(options.expectedTabs)) {
      return [];
    }
    const expected = options.expectedTabs.find(entry => entry.id === row.id);
    return !expected || expected.uid !== row.uid || expected.originalUrl !== row.originalUrl ?
      ['Page changed since preview'] : [];
  }

  async function inspect(action, reference, options) {
    let row = reference;
    try {
      row = await readRow(reference.id, reference);
      let reasons = expectedReasons(row, options);
      if (!reasons.length && (row.uid !== reference.uid || row.originalUrl !== reference.originalUrl)) {
        reasons = ['Page changed during this operation'];
      }
      if (!reasons.length && action === 'suspend' && row.asleep) {
        reasons = ['already-asleep'];
      }
      if (!reasons.length && action === 'restore' && !row.asleep) {
        reasons = ['already-awake'];
      }
      if (!reasons.length) {
        reasons = await gsWorkbench.getProtectionReasons(row, action, options);
      }
      if (!reasons.length) {
        const current = await readRow(row.id, row);
        if (current.uid !== row.uid || current.originalUrl !== row.originalUrl) {
          reasons = ['Page changed during safety check'];
        } else {
          row = current;
          reasons = gsWorkbench.getProtectionReasonsSync(row, action, options);
        }
      }
      return { row, reasons };
    } catch (error) {
      return { row, reasons: ['Unable to verify tab: ' + error.message] };
    }
  }

  async function preview(action, ids, options) {
    validateAction(action);
    ids = tabIds(ids);
    options = { ...options, respectSuspensionPolicy: false };
    const rows = await gsWorkbench.getTabs();
    const rowsById = new Map(rows.map(row => [row.id, row]));
    const inspected = await Promise.all(ids.map(async id => {
      const row = rowsById.get(id);
      return row ? inspect(action, row, options) :
        { row: { id }, reasons: ['tab-unavailable-or-excluded'] };
    }));
    return {
      action,
      eligible: inspected.filter(item => !item.reasons.length).map(item => item.row),
      skipped: inspected.filter(item => item.reasons.length).map(item => ({ ...item.row, reasons: item.reasons })),
      requested: ids.length,
    };
  }

  function navigation(tabId, predicate, trigger, timeoutMs) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let admitted = false;
      let checking = false;
      let timer;
      let interval;
      const finish = (error, tab) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(interval);
        gsBrowser.tabs.onUpdated.removeListener(updated);
        gsBrowser.tabs.onRemoved.removeListener(removed);
        if (error) reject(error); else resolve(tab);
      };
      const check = async () => {
        if (!admitted || checking || finished) return;
        checking = true;
        try {
          const tab = await api(gsBrowser.tabs, 'get', tabId);
          if (predicate(tab)) finish(null, tab);
        } catch (error) {
          finish(error);
        } finally {
          checking = false;
        }
      };
      const updated = id => { if (id === tabId) check(); };
      const removed = id => { if (id === tabId) finish(new Error('Tab was removed before navigation finished.')); };
      gsBrowser.tabs.onUpdated.addListener(updated);
      gsBrowser.tabs.onRemoved.addListener(removed);
      interval = setInterval(check, 300);
      Promise.resolve().then(() => trigger(() => finished)).then(result => {
        if (finished) return;
        if (result === false || result === null) {
          finish(new Error('Browser declined the requested transition.'));
          return;
        }
        admitted = true;
        timer = setTimeout(() => finish(new Error('Navigation did not finish in time; the tab remains available for retry.')), timeoutMs || 60000);
        check();
      }, error => finish(error));
    });
  }

  function draftMessage(row, request) {
    let expired = false;
    let timer;
    const deadlineAt = Date.now() + DRAFT_VERIFICATION_TIMEOUT_MS;
    const message = request.action === 'prepareTabAction' ? { ...request, deadlineAt } : request;
    const pending = api(gsBrowser.tabs, 'sendMessage', row.id, message, { frameId: 0 }).then(response => {
      if (expired) {
        if (request.action === 'prepareTabAction' && response && response.draftLease) {
          // A late response belongs only to the abandoned attempt, never a
          // subsequent action. Token-scoped release cannot revoke a newer lease.
          release(row, response.draftLease);
        }
        return null;
      }
      return response;
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('The page did not respond to draft verification.'));
      }, DRAFT_VERIFICATION_TIMEOUT_MS);
    });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  }

  async function lease(row) {
    if (row.asleep) return null;
    let response;
    try {
      response = await draftMessage(row, { action: 'prepareTabAction' });
    } catch (error) {
      throw noAction('Draft state unverified: ' + error.message);
    }
    if (!response || typeof response.dirty !== 'boolean' || typeof response.draftUnverified !== 'boolean' ||
        response.dirty || response.draftUnverified || !response.draftLease ||
        response.documentUrl !== row.originalUrl || response.draftLease.expiresAt <= Date.now()) {
      throw noAction(response && response.dirty ? 'Unsaved draft detected at execution' : 'Draft state unverified at execution');
    }
    return response.draftLease;
  }

  async function release(row, token) {
    if (!token) return;
    try {
      await draftMessage(row, { action: 'releaseTabAction', token: token.token });
    } catch (error) {
      // A closed, navigated or frozen document must not hold the action queue
      // or replace the original action failure with a release failure.
    }
  }

  async function suspend(row, options) {
    try {
      return await navigation(row.id, tab => (options.targetStatus === 'suspended' ?
        gsUtils.isSuspendedTab(tab) : isAsleep(tab)) && (tab.discarded || tab.status === 'complete'), () =>
        gsTabSuspendManager.queueTabForSuspensionAsPromise(row, 1, {
          workbench: true,
          allowActive: !!options.allowActive,
          expectedOriginalUrl: row.originalUrl,
          preserveExactUrl: true,
          discardInPlace: options.targetStatus === 'suspended' ? false : undefined,
          reason: options.reason || 'bulk-suspend',
          guard: options.guard,
        }).then(async success => {
          if (success === false) {
            const checked = await inspect('suspend', row, { ...options, respectSuspensionPolicy: false });
            let reasons = checked.reasons;
            if (!reasons.length && typeof options.guard === 'function') {
              const guarded = await options.guard(checked.row);
              reasons = Array.isArray(guarded) ? guarded : ['Action guard could not verify safety'];
            }
            if (!reasons.length) reasons = ['Browser declined suspension without changing the tab'];
            const error = noAction(reasons.join(', '));
            error.reasons = reasons;
            throw error;
          }
          return success;
        }), gsStorage.getOption(gsStorage.SCREEN_CAPTURE_FORCE) ? 330000 : 75000);
    } catch (error) {
      gsTabSuspendManager.unqueueTabForSuspension(row);
      throw error;
    }
  }

  function noAction(message) {
    const error = new Error(message);
    error.noAction = true;
    return error;
  }

  async function wake(row, options) {
    const current = await readRow(row.id, row);
    if (current.uid !== row.uid || current.originalUrl !== row.originalUrl) {
      throw noAction('Page changed before restore; the current page was not replaced');
    }
    if (!current.asleep) throw noAction('Tab was restored independently before queued navigation');
    try { gsTabSuspendManager.unqueueTabForSuspension(current); } catch (error) {
      throw new Error('Unable to cancel pending suspension: ' + error.message);
    }
    return navigation(current.id, tab => !isAsleep(tab) && tab.status === 'complete', cancelled => admitRestore(async () => {
      if (cancelled()) throw noAction('Queued restore was cancelled before navigation');
      const latest = await api(gsBrowser.tabs, 'get', current.id);
      const meta = gsWorkbench.getMeta(current.id);
      if (!meta || meta.uid !== current.uid || originalUrl(latest) !== current.originalUrl || !isAsleep(latest)) {
        throw noAction('Queued restore no longer targets the selected sleeping page; the current page was not replaced');
      }
      gsWorkbench.intent(current.id, 'restore', options.reason || 'bulk-restore');
      if (gsUtils.isSuspendedTab(latest)) {
        // Preserve the legacy scroll/history/autoDiscardable restore path.
        tgs.unsuspendTab(latest);
        return true;
      }
      return api(gsBrowser.tabs, 'reload', latest.id).then(() => true);
    }));
  }

  function admitRestore(trigger) {
    const admission = restoreAdmission.then(async () => {
      const delay = Math.max(0, Number(gsWorkbench.getState().settings.restoreDelayMs) || 0);
      const remaining = lastNavigationStartedAt + delay - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      const result = await trigger();
      lastNavigationStartedAt = Date.now();
      return result;
    });
    restoreAdmission = admission.catch(() => {});
    return admission;
  }

  function restorePriority(row, options, focusedWindowId) {
    if (row.active && row.windowId === focusedWindowId) return 0;
    const workspaceId = options.priorityWorkspaceId || gsWorkbench.getState().currentWorkspaceId;
    return (row.workspaceId && row.workspaceId === workspaceId ? 1 : 5) +
      (row.active ? 0 : 2) + (row.windowId === focusedWindowId ? 0 : 1);
  }

  function enqueueRestore(handler, priority) {
    const result = new Promise((resolve, reject) => {
      restoreJobs.push({ handler, priority, sequence: restoreSequence++, resolve, reject });
    });
    pumpRestores();
    return result;
  }

  function pumpRestores() {
    clearTimeout(restoreTimer);
    restoreTimer = null;
    const settings = gsWorkbench.getState().settings;
    const concurrency = Math.max(1, Math.floor(Number(settings.restoreConcurrency) || 1));
    const delay = Math.max(0, Number(settings.restoreDelayMs) || 0);
    if (!restoreJobs.length || activeRestores >= concurrency) return;
    const waitMs = nextRestoreAt - Date.now();
    if (waitMs > 0) {
      restoreTimer = setTimeout(pumpRestores, waitMs);
      return;
    }
    restoreJobs.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    const job = restoreJobs.shift();
    activeRestores += 1;
    nextRestoreAt = Date.now() + delay;
    Promise.resolve().then(job.handler).then(job.resolve, job.reject).finally(() => {
      activeRestores -= 1;
      pumpRestores();
    });
    pumpRestores();
  }

  function operation(action, options) {
    return { id: uuid(), action, options, changed: [], created: [], warnings: [] };
  }

  async function stageUndo(context, entry) {
    if (context.options.recordUndo === false) return null;
    const key = uuid();
    await gsWorkbench.update(state => {
      if (!state.undo || state.undo.id !== context.id) {
        state.undo = {
          id: context.id,
          action: context.action,
          label: context.options.label || context.action,
          createdAt: Date.now(),
          summary: UNDO_SUMMARY,
          previous: state.undo,
          entries: [],
        };
      }
      state.undo.entries.push({ ...copy(entry), key, status: 'pending', failures: [] });
    });
    return key;
  }

  async function updateUndo(context, key, changes) {
    if (!key) return;
    await gsWorkbench.update(state => {
      if (!state.undo || state.undo.id !== context.id) return;
      const entry = state.undo.entries.find(item => item.key === key);
      if (entry) Object.assign(entry, copy(changes));
      if (changes.status === 'changed') delete state.undo.previous;
    });
  }

  async function dropUndo(context, key) {
    if (!key) return;
    await gsWorkbench.update(state => {
      if (!state.undo || state.undo.id !== context.id) return;
      state.undo.entries = state.undo.entries.filter(item => item.key !== key);
      if (!state.undo.entries.length) state.undo = state.undo.previous || null;
    });
  }

  function matchesSnapshot(row, before) {
    if (!before) return false;
    const group = before.group;
    return row.uid === before.uid && row.originalUrl === entryUrl(before) &&
      row.status === before.status && row.pinned === !!before.pinned &&
      row.windowId === before.windowId && row.index === before.index && !windowDiffers(before, row.window) &&
      (!!group === (row.groupId >= 0)) && (!group ||
        (row.groupTitle === group.title && row.groupColor === group.color &&
        row.groupCollapsed === !!group.collapsed &&
        (!Number.isInteger(group.sourceId) || row.groupId === group.sourceId)));
  }

  async function observeChanged(context, key, row, before) {
    let current;
    try {
      current = await readRow(row.id, row);
    } catch (error) {
      if (before && ['close', 'archive'].includes(context.action)) {
        try { await api(gsBrowser.tabs, 'get', row.id); } catch (missing) {
          if (/No tab|Invalid tab|not found/i.test(missing.message)) {
            await updateUndo(context, key, { status: 'changed', afterTabId: null });
            if (!context.changed.includes(row.id)) context.changed.push(row.id);
            return true;
          }
        }
      }
      // Preserve the pending journal entry when the browser outcome cannot be
      // verified. A later undo may recover it; do not silently throw it away.
      await updateUndo(context, key, { failures: ['Transition outcome could not be verified: ' + error.message] });
      return null;
    }
    if (!matchesSnapshot(current, before)) {
      await updateUndo(context, key, { status: 'changed', afterTabId: current.id, after: snapshot(current) });
      if (!context.changed.includes(current.id)) context.changed.push(current.id);
      return true;
    }
    return false;
  }

  async function recordProtection(row, action, reasons, context) {
    if (!reasons.length || reasons.every(reason =>
        ['already-awake', 'already-asleep', 'tab-unavailable-or-excluded'].includes(reason))) return;
    try {
      await gsWorkbench.record('protected', row, reasons.join(', '), { action, reasons });
    } catch (error) {
      context.warnings.push('Protection metrics could not be saved: ' + error.message);
    }
  }

  async function performNow(action, ids, options) {
    const plan = await preview(action, ids, options);
    const context = operation(action, options);
    const skipped = plan.skipped.slice();
    const candidates = plan.eligible;
    const focus = action === 'restore' && candidates.length ?
      await api(gsBrowser.windows, 'getLastFocused', { windowTypes: ['normal'] }) : null;
    for (const item of plan.skipped) await recordProtection(item, action, item.reasons, context);
    const run = async reference => {
      const checked = await inspect(action, reference, options);
      if (checked.reasons.length) {
        skipped.push({ ...checked.row, reasons: checked.reasons });
        await recordProtection(checked.row, action, checked.reasons, context);
        return;
      }
      const row = checked.row;
      // Capture the batch's original position, not the shifted position left
      // after closing an earlier selected tab in this same window/group.
      const before = snapshot(reference);
      let key = null;
      let token = null;
      let archived = false;
      try {
        key = await stageUndo(context, {
          kind: action === 'archive' || action === 'close' ? 'reopen' : 'state',
          before,
          afterTabId: row.id,
          archiveId: action === 'archive' ? context.id : null,
        });
        if (action === 'archive') {
          await gsWorkbench.update(state => {
            let archive = state.archive.find(entry => entry.id === context.id);
            if (!archive) {
              archive = { id: context.id, label: options.label || 'Archived tabs', reason: options.reason || 'bulk-archive', createdAt: Date.now(), tabs: [] };
              state.archive.push(archive);
            }
            archive.tabs.push(before);
          });
          archived = true;
        }
        const finalRow = await readRow(row.id, row);
        if (finalRow.uid !== row.uid || finalRow.originalUrl !== row.originalUrl) {
          throw new Error('Page changed before execution');
        }
        const finalReasons = gsWorkbench.getProtectionReasonsSync(finalRow, action, options);
        if (finalReasons.length) throw new Error(finalReasons.join(', '));
        if (typeof options.guard === 'function') {
          const guardReasons = await options.guard(finalRow);
          if (!Array.isArray(guardReasons)) throw new Error('Action guard could not verify safety');
          if (guardReasons.length) throw new Error(guardReasons.join(', '));
        }
        if (action === 'close' || action === 'archive') {
          token = await lease(finalRow);
          const raw = await api(gsBrowser.tabs, 'get', row.id);
          const latest = { ...finalRow, ...raw, originalUrl: originalUrl(raw), status: status(raw), asleep: isAsleep(raw) };
          if (!token && !latest.asleep) {
            throw noAction('Sleeping tab woke before execution; preview its current page before closing');
          }
          if ((gsWorkbench.getMeta(row.id) || {}).uid !== row.uid || latest.originalUrl !== row.originalUrl) {
            throw noAction('Page changed at execution; its new page was not closed');
          }
          if (typeof options.guard === 'function') {
            const guardReasons = await options.guard(latest);
            if (!Array.isArray(guardReasons)) throw new Error('Action guard could not verify safety');
            if (guardReasons.length) throw new Error(guardReasons.join(', '));
          }
          const reasons = gsWorkbench.getProtectionReasonsSync(latest, action, options);
          if (reasons.length) throw new Error(reasons.join(', '));
          if (token && token.expiresAt <= Date.now()) throw new Error('Draft safety lease expired; retry this action');
          gsWorkbench.intent(row.id, action, options.reason || 'bulk-' + action);
          await api(gsBrowser.tabs, 'remove', row.id);
          await updateUndo(context, key, { status: 'changed', afterTabId: null });
        } else if (action === 'suspend') {
          await suspend(finalRow, options);
          const after = await readRow(row.id, row);
          await updateUndo(context, key, { status: 'changed', afterTabId: row.id, after: snapshot(after) });
        } else {
          await wake(finalRow, options);
          const after = await readRow(row.id, row);
          await updateUndo(context, key, { status: 'changed', afterTabId: row.id, after: snapshot(after) });
        }
        if (!context.changed.includes(row.id)) context.changed.push(row.id);
        if (action === 'archive') {
          try { await gsWorkbench.record('archived', row, options.reason || 'bulk-archive', { archiveId: context.id }); }
          catch (error) { context.warnings.push('Archive metric could not be saved: ' + error.message); }
        }
      } catch (error) {
        const changed = error.noAction ? false : await observeChanged(context, key, row, before);
        if (changed === false) {
          await dropUndo(context, key);
          if (archived) {
            await gsWorkbench.update(state => {
              const archive = state.archive.find(entry => entry.id === context.id);
              if (archive) archive.tabs = archive.tabs.filter(entry => entry.uid !== before.uid);
              state.archive = state.archive.filter(entry => entry.id !== context.id || entry.tabs.length);
            });
          }
        }
        const reasons = error.reasons || [error.message];
        skipped.push({ ...row, reasons, partiallyChanged: changed === true, outcomeUnverified: changed === null });
        await recordProtection(row, action, reasons, context);
      } finally {
        await release(row, token);
      }
    };
    if (action === 'restore') {
      // Enqueue the whole batch before starting so priority is independent of
      // Chrome's original tab enumeration order.
      candidates.sort((a, b) => restorePriority(a, options, focus.id) - restorePriority(b, options, focus.id));
      await Promise.all(candidates.map(row => enqueueRestore(() => run(row), restorePriority(row, options, focus.id))));
    } else {
      for (const row of candidates) await run(row);
    }
    return { action, changed: context.changed, skipped, operationId: context.id, warnings: context.warnings, undoSummary: UNDO_SUMMARY };
  }

  function perform(action, ids, options) {
    validateAction(action);
    ids = tabIds(ids);
    options = { ...options, respectSuspensionPolicy: false };
    return exclusive(() => performNow(action, ids, options));
  }

  function entryUrl(entry) {
    return entry.originalUrl || (entry.url && gsUtils.isSuspendedUrl(entry.url) ? gsUtils.getOriginalUrl(entry.url) : entry.url);
  }

  function entryKey(entry, index) {
    return (entry.uid || 'entry-' + index) + '\n' + entryUrl(entry);
  }

  function desiredStatus(entry, options) {
    if (typeof options.asleep === 'boolean') return options.asleep ? 'suspended' : 'awake';
    if (entry.status === 'discarded' || entry.status === 'suspended') return entry.status;
    return entry.asleep ? 'suspended' : 'awake';
  }

  async function restoreNow(entries, options) {
    if (!Array.isArray(entries)) throw new Error('Provide saved tab entries.');
    const context = operation('restore-entries', options);
    const result = [];
    result.skipped = [];
    result.errors = result.skipped;
    result.changed = context.changed;
    result.created = context.created;
    result.partial = [];
    result.operationId = context.id;
    result.undoSummary = UNDO_SUMMARY;
    const existingRows = await gsWorkbench.getTabs();
    const windows = await api(gsBrowser.windows, 'getAll', { populate: true, windowTypes: ['normal'] });
    const normalWindows = windows.filter(win => !win.incognito);
    const focused = normalWindows.find(win => win.focused) || normalWindows[0];
    const byUid = new Map(existingRows.map(row => [row.uid, row]));
    const usedRows = new Set();
    const seenEntries = new Set();
    const windowPromises = new Map();
    const windowMappings = new Map();
    const completed = [];
    const createdWindowStates = [];
    const sourceWindows = new Map();
    entries.forEach(entry => {
      if (entry.windowId == null) return;
      const source = String(entry.windowId);
      if (!sourceWindows.has(source)) sourceWindows.set(source, new Set());
      const witnesses = sourceWindows.get(source);
      if (entry.uid) witnesses.add(entry.uid);
      for (const uid of entry.windowWitnessUids || []) witnesses.add(uid);
    });
    for (const [source, witnesses] of sourceWindows) {
      const liveWindows = new Set(existingRows.filter(row => witnesses.has(row.uid)).map(row => row.windowId));
      if (liveWindows.size === 1) {
        const id = Array.from(liveWindows)[0];
        windowMappings.set(source, Promise.resolve({ id, created: false, recreated: id !== Number(source) }));
      }
    }

    async function ensureWindow(entry) {
      const source = entry.windowId == null ? 'default' : String(entry.windowId);
      if (windowMappings.has(source)) return windowMappings.get(source);
      if (source === 'default' && focused) {
        const mapping = Promise.resolve({ id: focused.id, created: false });
        windowMappings.set(source, mapping);
        return mapping;
      }
      if (!windowPromises.has(source)) {
        windowPromises.set(source, (async () => {
          const bounds = entry.windowBounds || {};
          const details = { url: 'about:blank', type: 'normal', focused: false };
          if (!bounds.state || bounds.state === 'normal') {
            ['left', 'top', 'width', 'height'].forEach(name => {
              if (Number.isInteger(bounds[name])) details[name] = bounds[name];
            });
          }
          const win = await api(gsBrowser.windows, 'create', details);
          const mapping = { id: win.id, created: true, placeholderId: win.tabs && win.tabs[0] ? win.tabs[0].id : null, state: bounds.state, source };
          createdWindowStates.push(mapping);
          windowMappings.set(source, Promise.resolve(mapping));
          return mapping;
        })());
      }
      return windowPromises.get(source);
    }

    const indexed = entries.map((entry, index) => ({ entry: copy(entry), index }));
    for (const item of indexed.slice().sort((a, b) => Number(a.entry.windowOrdinal || 0) - Number(b.entry.windowOrdinal || 0))) {
      if (/^(https?|file):\/\//i.test(entryUrl(item.entry) || '')) {
        try { await ensureWindow(item.entry); } catch (error) {
          // The per-entry executor reports this same rejected window promise.
        }
      }
    }
    indexed.sort((a, b) => {
      const aRow = byUid.get(a.entry.uid) || { windowId: a.entry.windowId, workspaceId: a.entry.meta && a.entry.meta.workspaceId, active: a.entry.active };
      const bRow = byUid.get(b.entry.uid) || { windowId: b.entry.windowId, workspaceId: b.entry.meta && b.entry.meta.workspaceId, active: b.entry.active };
      return restorePriority(aRow, options, focused && focused.id) - restorePriority(bRow, options, focused && focused.id) ||
        Number(a.entry.windowOrdinal || 0) - Number(b.entry.windowOrdinal || 0) || Number(a.entry.index || 0) - Number(b.entry.index || 0);
    });

    const jobs = indexed.map(item => {
      const entry = item.entry;
      const sourceUid = entry.uid;
      const url = entryUrl(entry);
      const unique = entryKey(entry, item.index);
      const expiry = gsWorkbenchWorkspaces.getSavedTemporaryInfo(entry).expiresAt;
      if (expiry && expiry <= Date.now() && !['archive-restore', 'bulk-undo'].includes(options.reason)) {
        result.skipped.push({ entry, restoreEntryIndex: item.index, reasons: ['Saved temporary tab is overdue; restore it intentionally from Archive instead.'] });
        return Promise.resolve();
      }
      if (typeof url !== 'string' || !url || !/^(https?|file):\/\//i.test(url)) {
        result.skipped.push({ entry, restoreEntryIndex: item.index, reasons: ['Saved URL is not a restorable normal browser page.'] });
        return Promise.resolve();
      }
      if (seenEntries.has(unique)) {
        result.skipped.push({ entry, restoreEntryIndex: item.index, reasons: ['Duplicate saved tab identity.'] });
        return Promise.resolve();
      }
      seenEntries.add(unique);
      const candidate = byUid.get(entry.uid);
      const priorityRow = candidate || { windowId: entry.windowId, workspaceId: entry.meta && entry.meta.workspaceId, active: entry.active };
      return enqueueRestore(async () => {
        let row = candidate && candidate.originalUrl === url && !usedRows.has(candidate.id) ? candidate : null;
        if (row) usedRows.add(row.id);
        if (candidate && !row) {
          // A tab may have navigated since a snapshot. Preserve it and give the
          // restored old page a fresh identity rather than sharing one UID.
          entry.uid = uuid();
          if (entry.meta) entry.meta.uid = entry.uid;
        }
        if (!entry.uid) entry.uid = uuid();
        const targetStatus = desiredStatus(entry, options);
        let key = null;
        let before = null;
        let created = false;
        let mapping;
        try {
          mapping = await ensureWindow(entry);
          if (row) {
            row = await readRow(row.id, row);
            if (row.uid !== candidate.uid || row.originalUrl !== url) throw new Error('Page changed during snapshot restore');
            before = snapshot(candidate);
            const groupChanged = (!!entry.group !== (row.groupId >= 0)) || (entry.group &&
              (entry.group.title !== row.groupTitle || entry.group.color !== row.groupColor || !!entry.group.collapsed !== row.groupCollapsed ||
              Number.isInteger(entry.group.sourceId) && entry.group.sourceId !== row.groupId));
            const differs = row.windowId !== mapping.id || row.index !== entry.index || row.pinned !== !!entry.pinned || groupChanged ||
              windowDiffers(entry, row.window) || (targetStatus === 'awake' ? row.asleep : row.status !== targetStatus);
            if (differs) key = await stageUndo(context, { kind: 'state', before, afterTabId: row.id });
            if (targetStatus === 'suspended' && row.status !== 'suspended') {
              const suspendOptions = { ...options, allowActive: true, targetStatus: 'suspended' };
              const reasons = row.asleep ? await gsWorkbench.getProtectionReasons(row, 'suspend', suspendOptions) :
                (await inspect('suspend', row, suspendOptions)).reasons;
              if (reasons.length) throw new Error(reasons.join(', '));
              await suspend(row, suspendOptions);
            } else if ((targetStatus === 'awake' && row.asleep) ||
                (targetStatus === 'discarded' && row.status === 'suspended')) {
              await wake(row, options);
            }
          } else {
            key = await stageUndo(context, { kind: 'remove-created', before: null, restored: entry, sourceUid, afterTabId: null });
            const targetUrl = targetStatus === 'suspended' ?
              (entry.url && gsUtils.isSuspendedUrl(entry.url) && entryUrl(entry) === url ? entry.url : gsUtils.generateSuspendedUrl(url, entry.title || url, 0)) : url;
            let tab;
            if (mapping.placeholderId != null) {
              const placeholderId = mapping.placeholderId;
              mapping.placeholderId = null;
              tab = await api(gsBrowser.tabs, 'get', placeholderId);
            } else {
              tab = await api(gsBrowser.tabs, 'create', { windowId: mapping.id, active: false, pinned: !!entry.pinned, index: Math.max(0, Number(entry.index) || 0), url: 'about:blank' });
            }
            created = true;
            row = { ...entry, id: tab.id, uid: entry.uid, windowId: mapping.id, originalUrl: url, asleep: false };
            context.created.push(tab.id);
            context.changed.push(tab.id);
            await updateUndo(context, key, { status: 'changed', afterTabId: tab.id, afterUid: entry.uid, afterUrl: url });
            await gsWorkbench.attachMeta(tab.id, entry);
            await navigation(tab.id, current => (targetStatus === 'suspended' ? gsUtils.isSuspendedTab(current) : !isAsleep(current)) && current.status === 'complete',
              cancelled => admitRestore(async () => {
                if (cancelled()) throw noAction('New restore tab was removed before navigation');
                const current = await api(gsBrowser.tabs, 'get', tab.id);
                if ((current.url || current.pendingUrl) !== 'about:blank' ||
                    (gsWorkbench.getMeta(tab.id) || {}).uid !== entry.uid) {
                  throw noAction('New restore tab was used before navigation; its current page was not replaced');
                }
                gsWorkbench.intent(tab.id, targetStatus === 'suspended' ? 'suspend' : 'restore', options.reason || 'saved-tab-restore');
                return api(gsBrowser.tabs, 'update', tab.id, { url: targetUrl, pinned: !!entry.pinned, active: false });
              }));
            row = await readRow(tab.id, { ...entry, id: tab.id, windowId: mapping.id, originalUrl: url });
          }
          if (targetStatus === 'discarded') {
            const raw = await api(gsBrowser.tabs, 'get', row.id);
            if (!raw.discarded) {
              const checked = await inspect('suspend', await readRow(row.id, row), { ...options, allowActive: true });
              if (checked.reasons.length) throw new Error(checked.reasons.join(', '));
              let token = await lease(checked.row);
              let leaseActive = true;
              let discardReasons = [];
              const renew = setInterval(async () => {
                try {
                  const renewed = await lease(checked.row);
                  if (leaseActive) token = renewed;
                  else await release(checked.row, renewed);
                } catch (error) {
                  if (leaseActive) gsTabDiscardManager.unqueueTabForDiscard(raw);
                }
              }, 750);
              try {
                const success = await gsTabDiscardManager.queueTabForDiscardAsPromise(raw, {
                  beforeDiscard: async current => {
                    const latest = { ...checked.row, ...current, originalUrl: originalUrl(current), status: status(current), asleep: isAsleep(current) };
                    if ((gsWorkbench.getMeta(current.id) || {}).uid !== checked.row.uid ||
                        latest.originalUrl !== checked.row.originalUrl) {
                      discardReasons = ['Page changed before restoring discarded status'];
                      return false;
                    }
                    discardReasons = gsWorkbench.getProtectionReasonsSync(latest, 'suspend', { allowActive: true });
                    if (discardReasons.length) return false;
                    token = await lease(latest);
                    const finalTab = await api(gsBrowser.tabs, 'get', current.id);
                    const finalRow = { ...latest, ...finalTab, originalUrl: originalUrl(finalTab), status: status(finalTab), asleep: isAsleep(finalTab) };
                    if ((gsWorkbench.getMeta(current.id) || {}).uid !== checked.row.uid ||
                        finalRow.originalUrl !== checked.row.originalUrl) {
                      discardReasons = ['Page changed at discard execution'];
                      return false;
                    }
                    discardReasons = gsWorkbench.getProtectionReasonsSync(finalRow, 'suspend', { allowActive: true });
                    if (discardReasons.length || token && token.expiresAt <= Date.now()) return false;
                    gsWorkbench.intent(current.id, 'suspend', options.reason || 'snapshot-restore');
                    return true;
                  },
                });
                if (!success) throw new Error(discardReasons.join(', ') || 'Browser declined restoring discarded status');
              } finally {
                leaseActive = false;
                clearInterval(renew);
                await release(checked.row, token);
              }
            }
          }
          await api(gsBrowser.tabs, 'update', row.id, { pinned: !!entry.pinned });
          await gsWorkbench.attachMeta(row.id, entry);
          completed.push({ entry, sourceUid, row: await readRow(row.id, row), key, before, created, mapping, index: item.index });
        } catch (error) {
          if (row && !created) {
            if (!before) {
              await dropUndo(context, key);
            } else {
              const changed = error.noAction ? false : await observeChanged(context, key, row, before);
              if (changed === false) await dropUndo(context, key);
            }
          }
          result.skipped.push({ entry, restoreEntryIndex: item.index, reasons: error.reasons || [error.message], partiallyChanged: created || context.changed.includes(row && row.id) });
          if (created && row) {
            try {
              const partial = await readRow(row.id, row);
              partial.restoreEntryIndex = item.index;
              result.partial.push(partial);
            } catch (missing) {
              result.partial.push({ ...row, restoreEntryIndex: item.index, restoreError: error.message });
            }
          }
        }
      }, restorePriority(priorityRow, options, focused && focused.id));
    });
    await Promise.all(jobs);

    const groupSets = new Map();
    for (const item of completed) {
      if (!item.entry.group) continue;
      const group = item.entry.group;
      const key = item.mapping.id + ':' + (group.key || group.sourceId || group.id || group.title + ':' + group.color);
      if (!groupSets.has(key)) groupSets.set(key, []);
      groupSets.get(key).push(item);
    }
    const organizationFailures = new Map();
    for (const items of groupSets.values()) {
      try {
        const descriptor = items[0].entry.group;
        const savedUids = new Set(entries.filter(entry => entry.group &&
          (entry.group.key || entry.group.sourceId) === (descriptor.key || descriptor.sourceId)).map(entry => entry.uid));
        const candidateIds = new Set(items.filter(item => !item.created && item.row.groupId >= 0).map(item => item.row.groupId));
        let groupId = null;
        for (const candidateId of candidateIds) {
          const members = await api(gsBrowser.tabs, 'query', { groupId: candidateId });
          if (members.length && members.every(member => member.windowId === items[0].mapping.id &&
            savedUids.has((gsWorkbench.getMeta(member.id) || {}).uid))) {
            groupId = candidateId;
            break;
          }
        }
        const details = { tabIds: items.map(item => item.row.id) };
        if (groupId != null) details.groupId = groupId;
        else details.createProperties = { windowId: items[0].mapping.id };
        const restoredGroupId = await api(gsBrowser.tabs, 'group', details);
        items.forEach(item => { item.targetGroupId = restoredGroupId; });
        await api(gsBrowser.tabGroups, 'update', restoredGroupId, { title: descriptor.title || '', color: descriptor.color || 'grey', collapsed: !!descriptor.collapsed });
      } catch (error) {
        items.forEach(item => organizationFailures.set(item, 'Native group restore failed: ' + error.message));
      }
    }
    const units = [];
    for (const items of groupSets.values()) {
      if (items[0].targetGroupId == null) continue;
      const descriptor = items[0].entry.group;
      units.push({
        items, groupId: items[0].targetGroupId, windowId: items[0].mapping.id,
        index: Number.isInteger(descriptor.startIndex) ? descriptor.startIndex : Math.min(...items.map(item => Number(item.entry.index) || 0)),
        pinned: false,
      });
    }
    completed.filter(item => !item.entry.group).forEach(item => units.push({
      items: [item], windowId: item.mapping.id,
      index: Math.max(0, Number(item.entry.index) || 0), pinned: !!item.entry.pinned,
    }));
    units.sort((a, b) => a.windowId - b.windowId || Number(b.pinned) - Number(a.pinned) || a.index - b.index);
    for (const unit of units) {
      try {
        if (unit.groupId != null) {
          const members = (await api(gsBrowser.tabs, 'query', { groupId: unit.groupId })).sort((a, b) => a.index - b.index);
          const selected = new Set(unit.items.map(item => item.row.id));
          if (!members.length || selected.size > members.length) throw new Error('Native group membership changed during restore.');
          const orderedMembers = new Array(members.length);
          const overflow = [];
          for (const item of unit.items.slice().sort((a, b) => a.entry.index - b.entry.index)) {
            const relativeIndex = Math.max(0, (Number(item.entry.index) || 0) - unit.index);
            if (relativeIndex >= orderedMembers.length) {
              overflow.push(item.row.id);
            } else if (orderedMembers[relativeIndex] != null) {
              throw new Error('Saved group tab positions conflict.');
            } else {
              orderedMembers[relativeIndex] = item.row.id;
            }
          }
          const spare = members.filter(member => !selected.has(member.id)).map(member => member.id).concat(overflow);
          let nextSpare = 0;
          for (let index = 0; index < orderedMembers.length; index += 1) {
            if (orderedMembers[index] == null) orderedMembers[index] = spare[nextSpare++];
          }
          if (orderedMembers.some(id => !Number.isInteger(id))) throw new Error('Native group membership changed during restore.');
          if (members[0].index !== unit.index || members.some((member, index) => member.id !== orderedMembers[index])) {
            // Leave one member grouped at all times, keeping the native ID and
            // its temporary-group policy alive while the other members reorder.
            const anchor = orderedMembers[0];
            const others = orderedMembers.slice(1);
            if (others.length) await api(gsBrowser.tabs, 'ungroup', others);
            await api(gsBrowser.tabGroups, 'move', unit.groupId, { windowId: unit.windowId, index: Math.max(0, unit.index) });
            if (others.length) {
              await api(gsBrowser.tabs, 'move', others, { windowId: unit.windowId, index: Math.max(0, unit.index + 1) });
              await api(gsBrowser.tabs, 'group', { groupId: unit.groupId, tabIds: others });
            }
            const anchorTab = await api(gsBrowser.tabs, 'get', anchor);
            if (anchorTab.groupId !== unit.groupId) throw new Error('Native group anchor changed during restore.');
            await api(gsBrowser.tabGroups, 'move', unit.groupId, { windowId: unit.windowId, index: Math.max(0, unit.index) });
          }
        } else {
          const item = unit.items[0];
          if (item.row.groupId >= 0) await api(gsBrowser.tabs, 'ungroup', item.row.id);
          await api(gsBrowser.tabs, 'move', item.row.id, { windowId: unit.windowId, index: unit.index });
        }
      } catch (error) {
        unit.items.forEach(item => organizationFailures.set(item, 'Tab order restore failed: ' + error.message));
      }
    }
    for (const item of completed) {
      if (item.entry.active && (item.mapping.created || !focused || item.mapping.id !== focused.id)) {
        try { await api(gsBrowser.tabs, 'update', item.row.id, { active: true }); }
        catch (error) { organizationFailures.set(item, 'Active tab restore failed: ' + error.message); }
      }
    }
    for (const items of groupSets.values()) {
      if (items[0].targetGroupId == null) continue;
      try {
        await api(gsBrowser.tabGroups, 'update', items[0].targetGroupId, { collapsed: !!items[0].entry.group.collapsed });
      } catch (error) {
        items.forEach(item => organizationFailures.set(item, 'Group collapse restore failed: ' + error.message));
      }
    }
    try {
      const actualRows = await gsWorkbench.getTabs();
      const rebindEntries = completed.map(item => ({ ...item.entry, sourceUid: item.sourceUid }));
      for (const row of result.partial) {
        const entry = indexed.find(item => item.index === row.restoreEntryIndex);
        if (entry) rebindEntries.push(entry.entry);
      }
      await gsWorkbenchWorkspaces.rebindTemporaryGroups(rebindEntries, actualRows,
        { exemptExpired: ['archive-restore', 'bulk-undo'].includes(options.reason) });
    } catch (error) {
      completed.forEach(item => organizationFailures.set(item, 'Temporary expiry could not be restored: ' + error.message));
    }
    const completedByWindow = new Map();
    for (const item of completed) {
      if (!completedByWindow.has(item.mapping.id)) completedByWindow.set(item.mapping.id, []);
      completedByWindow.get(item.mapping.id).push(item);
    }
    for (const [windowId, items] of completedByWindow) {
      const bounds = items[0].entry.windowBounds;
      if (!bounds) continue;
      try {
        const current = await api(gsBrowser.windows, 'get', windowId);
        if (bounds.state && bounds.state !== current.state) {
          await api(gsBrowser.windows, 'update', windowId, { state: bounds.state });
        }
        if (!bounds.state || bounds.state === 'normal') {
          const details = {};
          for (const name of ['left', 'top', 'width', 'height']) {
            if (Number.isInteger(bounds[name]) && bounds[name] !== current[name]) details[name] = bounds[name];
          }
          if (Object.keys(details).length) await api(gsBrowser.windows, 'update', windowId, details);
        }
      } catch (error) {
        items.forEach(item => organizationFailures.set(item, 'Window geometry restore failed: ' + error.message));
      }
    }
    for (const [windowId, items] of completedByWindow) {
      try {
        const liveTabs = (await api(gsBrowser.tabs, 'query', { windowId })).sort((a, b) => a.index - b.index);
        const selectedIds = new Set(items.map(item => item.row.id));
        const actualOrder = liveTabs.filter(tab => selectedIds.has(tab.id)).map(tab => tab.id);
        const desiredOrder = items.slice().sort((a, b) =>
          Number(b.entry.pinned) - Number(a.entry.pinned) || a.entry.index - b.entry.index).map(item => item.row.id);
        if (actualOrder.length !== desiredOrder.length || actualOrder.some((id, index) => id !== desiredOrder[index])) {
          items.forEach(item => organizationFailures.set(item, 'Saved tab order could not be restored.'));
        }
        for (const item of items) {
          const actual = liveTabs.find(tab => tab.id === item.row.id);
          const expectedIndex = Math.min(Math.max(0, Number(item.entry.index) || 0), liveTabs.length - 1);
          if (actual && !item.mapping.created && !item.mapping.recreated && actual.index !== expectedIndex) {
            organizationFailures.set(item, 'The saved tab position is blocked by current browser organization.');
          }
        }
      } catch (error) {
        items.forEach(item => organizationFailures.set(item, 'Tab order could not be verified: ' + error.message));
      }
    }
    for (const item of completed) {
      try {
        const current = await readRow(item.row.id, item.row);
        current.sourceUid = item.sourceUid;
        current.restoreEntryIndex = item.index;
        const changed = item.created || !matchesSnapshot(current, item.before);
        if (changed) {
          await updateUndo(context, item.key, { status: 'changed', afterTabId: current.id, after: snapshot(current) });
          if (!context.changed.includes(current.id)) context.changed.push(current.id);
        } else {
          await dropUndo(context, item.key);
        }
        let failed = organizationFailures.get(item);
        if (!failed && (current.windowId !== item.mapping.id || windowDiffers(item.entry, current.window) || current.pinned !== !!item.entry.pinned ||
            (item.entry.group ? current.groupId !== item.targetGroupId ||
            current.groupTitle !== (item.entry.group.title || '') ||
            current.groupColor !== (item.entry.group.color || 'grey') ||
            current.groupCollapsed !== !!item.entry.group.collapsed : current.groupId >= 0))) {
          failed = 'Browser did not retain the requested window geometry, pin or native group organization.';
        }
        if (failed) {
          result.skipped.push({ entry: item.entry, restoreEntryIndex: item.index, reasons: [failed], partiallyChanged: changed });
          result.partial.push(current);
        } else {
          result.push(current);
        }
      } catch (error) {
        result.skipped.push({ entry: item.entry, restoreEntryIndex: item.index, reasons: ['Tab organization restore failed: ' + error.message], partiallyChanged: true });
        await observeChanged(context, item.key, item.row, item.before);
      }
    }
    for (const mapping of createdWindowStates) {
      if (mapping.placeholderId != null) {
        try { await api(gsBrowser.tabs, 'remove', mapping.placeholderId); }
        catch (error) { result.skipped.push({ windowId: mapping.id, reasons: ['Unused restore window could not be removed: ' + error.message] }); }
      } else if (mapping.state && mapping.state !== 'normal') {
        try { await api(gsBrowser.windows, 'update', mapping.id, { state: mapping.state, focused: false }); }
        catch (error) { result.skipped.push({ windowId: mapping.id, reasons: ['Window state could not be restored: ' + error.message] }); }
      }
    }
    result.sort((a, b) => a.restoreEntryIndex - b.restoreEntryIndex);
    return result;
  }

  function restoreEntries(entries, options) {
    options = { recordUndo: false, ...options, respectSuspensionPolicy: false };
    return exclusive(() => restoreNow(entries, options));
  }

  async function undoNow() {
    const undo = copy(gsWorkbench.getState().undo);
    if (!undo) return { changed: [], skipped: [], remaining: 0, summary: UNDO_SUMMARY };
    const changed = [];
    const skipped = [];
    const warnings = [];
    const toRestore = [];
    const options = { recordUndo: false, reason: 'bulk-undo', allowActive: true };

    async function finishEntry(entry) {
      await gsWorkbench.update(state => {
        if (!state.undo || state.undo.id !== undo.id) return;
        if (entry.archiveId && entry.before) {
          const archive = state.archive.find(item => item.id === entry.archiveId);
          if (archive) archive.tabs = archive.tabs.filter(item =>
            item.uid !== entry.before.uid || entryUrl(item) !== entryUrl(entry.before));
          state.archive = state.archive.filter(item => item.id !== entry.archiveId || item.tabs.length);
        }
        if (entry.archiveRestoreHeader && entry.archiveRestoreSnapshot) {
          let archive = state.archive.find(item => item.id === entry.archiveRestoreHeader.id);
          if (!archive) {
            archive = { ...copy(entry.archiveRestoreHeader), tabs: [] };
            state.archive.push(archive);
          }
          if (!archive.tabs.some(item => item.uid === entry.archiveRestoreSnapshot.uid &&
              entryUrl(item) === entryUrl(entry.archiveRestoreSnapshot))) {
            archive.tabs.push(copy(entry.archiveRestoreSnapshot));
            archive.tabs.sort((a, b) => Number(a.windowOrdinal || 0) - Number(b.windowOrdinal || 0) ||
              Number(a.index || 0) - Number(b.index || 0));
          }
        }
        state.undo.entries = state.undo.entries.filter(item => item.key !== entry.key);
        if (!state.undo.entries.length) state.undo = state.undo.previous || null;
      });
    }

    async function failEntry(entry, reasons, partial) {
      skipped.push({ entry, reasons });
      await gsWorkbench.update(state => {
        if (!state.undo || state.undo.id !== undo.id) return;
        const remaining = state.undo.entries.find(item => item.key === entry.key);
        if (!remaining) return;
        remaining.failures = reasons;
        remaining.lastAttemptAt = Date.now();
        if (partial) {
          const retry = copy(entry.retrySnapshot || entry.before);
          retry.uid = partial.uid;
          if (retry.meta) retry.meta.uid = partial.uid;
          retry.windowId = partial.windowId;
          remaining.retrySnapshot = retry;
        }
      });
    }

    for (const entry of undo.entries.slice().reverse()) {
      try {
        const rows = await gsWorkbench.getTabs();
        const expected = entry.after || entry.restored || entry.before;
        const uid = entry.afterUid || (expected && expected.uid);
        const url = entry.afterUrl || (expected && entryUrl(expected));
        const live = rows.find(row => row.uid === uid && row.originalUrl === url);
        if (entry.kind === 'remove-created') {
          if (!live && entry.afterTabId != null) {
            if (rows.some(row => row.id === entry.afterTabId)) {
              throw new Error('Created tab has changed page; it was not closed.');
            }
            let stillExists = false;
            try { await api(gsBrowser.tabs, 'get', entry.afterTabId); stillExists = true; }
            catch (error) {
              if (!/No tab|Invalid tab|not found/i.test(error.message)) throw error;
            }
            if (stillExists) throw new Error('Created tab identity is unverified; it was not closed.');
          }
          if (!live && entry.afterTabId == null) {
            throw new Error('Interrupted restore has no verified created-tab identity.');
          }
          if (live) {
            const outcome = await performNow('close', [live.id], {
              ...options,
              expectedTabs: [{ id: live.id, uid: live.uid, originalUrl: live.originalUrl }],
            });
            changed.push(...outcome.changed);
            if (!outcome.changed.includes(live.id) || outcome.skipped.some(item => item.id === live.id)) {
              throw new Error(outcome.skipped.map(item => item.reasons.join(', ')).join('; ') || 'Created tab could not be closed.');
            }
          }
          await finishEntry(entry);
        } else {
          if (!entry.before) throw new Error('Undo entry has no saved tab snapshot.');
          if (entry.status === 'pending' && live && matchesSnapshot(live, entry.before)) {
            await finishEntry(entry);
          } else {
            toRestore.push(entry);
          }
        }
      } catch (error) {
        await failEntry(entry, [error.message]);
      }
    }

    if (toRestore.length) {
      let restored;
      try {
        // One restore batch preserves common groups and relative tab/window
        // ordering. Restoring each entry separately would split native groups.
        restored = await restoreNow(toRestore.map(entry => entry.retrySnapshot || entry.before), options);
        changed.push(...restored.changed);
      } catch (error) {
        for (const entry of toRestore) await failEntry(entry, [error.message]);
      }
      if (restored) {
        for (const [index, entry] of toRestore.entries()) {
          const row = restored.find(item => item.restoreEntryIndex === index);
          if (row) {
            await finishEntry(entry);
          } else {
            const failures = restored.skipped.filter(item => item.restoreEntryIndex === index ||
              item.entry && item.entry.uid === (entry.retrySnapshot || entry.before).uid);
            const reasons = failures.flatMap(item => item.reasons);
            const partial = restored.partial.find(item => item.restoreEntryIndex === index);
            await failEntry(entry, reasons.length ? reasons : ['Saved tab could not be completely restored.'], partial);
          }
        }
      }
    }
    try {
      await gsWorkbench.record('undo', null, 'bulk-undo', {
        operationId: undo.id, changed: Array.from(new Set(changed)), failed: skipped.length,
      });
    } catch (error) {
      warnings.push('Undo activity could not be saved: ' + error.message);
    }
    const remaining = gsWorkbench.getState().undo;
    return {
      operationId: undo.id, changed: Array.from(new Set(changed)), skipped, warnings,
      remaining: remaining && remaining.id === undo.id ? remaining.entries.length : 0,
      summary: UNDO_SUMMARY,
    };
  }

  async function archiveRestore(payload) {
    const archive = copy(gsWorkbench.getState().archive.find(entry => entry.id === payload.id));
    if (!archive) throw new Error('Archive not found.');
    const restored = await restoreNow(archive.tabs, { recordUndo: true, reason: 'archive-restore', label: archive.label });
    const successful = new Set(restored.map(row => row.restoreEntryIndex));
    await gsWorkbench.update(state => {
      if (state.undo && state.undo.id === restored.operationId) {
        for (const row of restored) {
          const entry = state.undo.entries.find(item => item.afterTabId === row.id);
          if (!entry) continue;
          entry.archiveRestoreHeader = {
            id: archive.id, label: archive.label, reason: archive.reason, createdAt: archive.createdAt,
          };
          entry.archiveRestoreSnapshot = copy(archive.tabs[row.restoreEntryIndex]);
        }
      }
      const current = state.archive.find(entry => entry.id === archive.id);
      if (current) current.tabs = current.tabs.filter((entry, index) => !successful.has(index));
      state.archive = state.archive.filter(entry => entry.id !== archive.id || entry.tabs.length);
    });
    return { restored: Array.from(restored), changed: restored.changed, created: restored.created, skipped: restored.skipped, operationId: restored.operationId, remaining: archive.tabs.length - successful.size, undoSummary: UNDO_SUMMARY };
  }

  function initAsPromised() {
    if (initialised) return Promise.resolve();
    initialised = true;
    gsWorkbench.register('action.preview', payload => preview(payload.action, payload.tabIds, payload.options));
    gsWorkbench.register('action.run', payload => perform(payload.action, payload.tabIds, payload.options));
    gsWorkbench.register('action.undo', () => exclusive(undoNow));
    gsWorkbench.register('archive.restore', payload => exclusive(() => archiveRestore(payload)));
    gsWorkbench.register('archive.delete', payload => exclusive(async () => {
      const found = gsWorkbench.getState().archive.some(entry => entry.id === payload.id);
      if (!found) throw new Error('Archive not found.');
      await gsWorkbench.update(state => { state.archive = state.archive.filter(entry => entry.id !== payload.id); });
      return { id: payload.id, deleted: true };
    }));
    gsWorkbench.registerView('undoSummary', (tabs, state) => state.undo ? {
      id: state.undo.id,
      action: state.undo.action,
      label: state.undo.label,
      createdAt: state.undo.createdAt,
      count: state.undo.entries.length,
      pending: state.undo.entries.filter(entry => entry.status === 'pending').length,
      failed: state.undo.entries.filter(entry => entry.failures && entry.failures.length).length,
      summary: UNDO_SUMMARY,
    } : null);
    return Promise.resolve();
  }

  return { initAsPromised, preview, perform, restoreEntries };
})();
