/*global gsBrowser, gsWorkbench, gsWorkbenchActions, gsWorkbenchWorkspaces */
// eslint-disable-next-line no-unused-vars
var gsWorkbenchInsights = (function() {
  'use strict';

  const TIMELINE_LIMIT = 3000;
  const ACTIVITY_DAYS = 90;
  const UNASSIGNED_WORKSPACE = '$unassigned';
  const EVENT_TYPES = new Set([
    'opened',
    'suspended',
    'restored',
    'closed',
    'archived',
    'snoozed',
    'protected',
    'workspace',
    'snapshot',
    'undo',
    'grouped',
  ]);
  let initialized = false;
  // Only the parent can establish foreground activity. Never resume this across
  // an engine-document reload: elapsed browser shutdown/idle time is not activity.
  let activity = null;

  function makeId() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => ('0' + byte.toString(16)).slice(-2));
    return (
      hex.slice(0, 4).join('') + '-' +
      hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' +
      hex.slice(8, 10).join('') + '-' +
      hex.slice(10).join('')
    );
  }

  function finiteNonnegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function amount(value) {
    return finiteNonnegative(value) ? value : 0;
  }

  function increment(map, key, value) {
    const previous = Object.prototype.hasOwnProperty.call(map, key)
      ? amount(map[key])
      : 0;
    // Hostnames and workspace names are not trusted object property names.
    Object.defineProperty(map, key, {
      value: previous + value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  function dateKey(epoch) {
    const date = new Date(epoch);
    return (
      date.getFullYear() + '-' +
      ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
      ('0' + date.getDate()).slice(-2)
    );
  }

  function cutoffDay(now) {
    const date = new Date(now);
    return dateKey(new Date(
      date.getFullYear(), date.getMonth(), date.getDate() - ACTIVITY_DAYS + 1
    ).getTime());
  }

  function snapshotKeep(state) {
    const keep = Number(state.settings.snapshotKeep);
    return Number.isFinite(keep) && keep > 0 ? Math.max(1, Math.floor(keep)) : 30;
  }

  function ensureMetrics(state) {
    const metrics = state.metrics || (state.metrics = {});
    [
      'suspensions', 'restorations', 'archives', 'closes', 'sleepMs',
      'restoreLatencyMs', 'restoreSamples', 'protectionSkips',
    ].forEach(key => {
      if (!finiteNonnegative(metrics[key])) metrics[key] = 0;
    });
    if (!metrics.protectionReasons) metrics.protectionReasons = {};
    if (!metrics.activityByDay) metrics.activityByDay = {};
    return metrics;
  }

  function pruneActivity(byDay, now) {
    const cutoff = cutoffDay(now);
    const today = dateKey(now);
    Object.keys(byDay).forEach(day => {
      if (day < cutoff || day > today) delete byDay[day];
    });
  }

  function pruneState(state, now) {
    if (state.timeline.length > TIMELINE_LIMIT) {
      state.timeline.splice(0, state.timeline.length - TIMELINE_LIMIT);
    }
    const keep = snapshotKeep(state);
    if (state.snapshots.length > keep) {
      state.snapshots.splice(0, state.snapshots.length - keep);
    }
    pruneActivity(ensureMetrics(state).activityByDay, now);
  }

  function originalUrl(row) {
    return row && (row.originalUrl || (row.meta && row.meta.url) || row.url) || '';
  }

  function workspaceId(row) {
    if (!row) return null;
    if (Object.prototype.hasOwnProperty.call(row, 'workspaceId')) {
      return row.workspaceId || null;
    }
    return row.meta && row.meta.workspaceId || null;
  }

  function uid(row) {
    return row && (row.uid || (row.meta && row.meta.uid)) || null;
  }

  function userUrl(row) {
    if (!row || row.incognito) return null;
    try {
      const url = new URL(originalUrl(row));
      return ['http:', 'https:', 'file:', 'ftp:'].indexOf(url.protocol) !== -1
        ? url
        : null;
    } catch (error) {
      return null;
    }
  }

  function appendEvent(state, type, row, reason, extra, at) {
    const event = {
      id: makeId(),
      at: at,
      type: type,
      uid: uid(row),
      tabId: row && Number.isInteger(row.id) ? row.id :
        row && Number.isInteger(row.tabId) ? row.tabId : null,
      title: row && typeof row.title === 'string' ? row.title : '',
      url: originalUrl(row),
      workspaceId: workspaceId(row),
      reason: typeof reason === 'string' ? reason : '',
      extra: extra,
    };
    const timeline = state.timeline;
    // Late browser callbacks still appear in event-time order.
    if (timeline.length && timeline[timeline.length - 1].at > at) {
      let position = timeline.length;
      while (position && timeline[position - 1].at > at) position--;
      timeline.splice(position, 0, event);
    } else {
      timeline.push(event);
    }
    if (timeline.length > TIMELINE_LIMIT) {
      timeline.splice(0, timeline.length - TIMELINE_LIMIT);
    }
    return event;
  }

  function record(type, row, reason, extra) {
    if (!EVENT_TYPES.has(type)) {
      return Promise.reject(new Error('Unknown lifecycle event: ' + type));
    }
    if (row && !userUrl(row)) return Promise.resolve(null);
    const details = extra ? JSON.parse(JSON.stringify(extra)) : {};
    const at = finiteNonnegative(details.at) ? details.at : Date.now();
    return gsWorkbench.update(state => {
      if (type === 'restored' && details.consumePendingSleep) {
        const meta = state.meta[row.id];
        if (!meta || meta.uid !== uid(row) || meta.url !== originalUrl(row) ||
            (!meta.pendingRestore && !meta.pendingSleepMs)) return null;
        // Commit the interval and its acknowledgement together: a reload cannot
        // count it twice or drop the interval between separate storage writes.
        details.sleepMs = amount(meta.pendingSleepMs);
        delete details.consumePendingSleep;
        meta.pendingSleepMs = 0;
        meta.pendingRestore = false;
      }
      const metrics = ensureMetrics(state);
      const event = appendEvent(state, type, row, reason, details, at);
      if (type === 'suspended') metrics.suspensions++;
      if (type === 'restored') {
        metrics.restorations++;
        if (finiteNonnegative(details.restoreLatencyMs)) {
          metrics.restoreLatencyMs += details.restoreLatencyMs;
          metrics.restoreSamples++;
        }
      }
      if (type === 'archived') metrics.archives++;
      if (type === 'closed') metrics.closes++;
      // Completed sleep intervals come from real restore/remove transitions,
      // not from an archive/action request followed by the same close event.
      if ((type === 'restored' || type === 'closed') &&
          finiteNonnegative(details.sleepMs)) {
        metrics.sleepMs += details.sleepMs;
      }
      if (type === 'protected' && Array.isArray(details.reasons)) {
        const reasons = new Set(details.reasons.filter(value =>
          typeof value === 'string' && value.length
        ));
        if (reasons.size) metrics.protectionSkips++;
        reasons.forEach(key => increment(metrics.protectionReasons, key, 1));
      }
      pruneActivity(metrics.activityByDay, Date.now());
      return event;
    });
  }

  function segments(interval, end) {
    const result = [];
    let cursor = interval.startedAt;
    if (!Number.isFinite(end) || end <= cursor) return result;
    while (cursor < end) {
      const date = new Date(cursor);
      // Calendar arithmetic is intentional: local days can be 23 or 25 hours.
      const midnight = new Date(
        date.getFullYear(), date.getMonth(), date.getDate() + 1
      ).getTime();
      const stop = Math.min(end, midnight > cursor ? midnight : end);
      result.push({day: dateKey(cursor), ms: stop - cursor});
      cursor = stop;
    }
    return result;
  }

  function addActivity(byDay, interval, end, now) {
    const cutoff = cutoffDay(now);
    const today = dateKey(now);
    let elapsed = 0;
    segments(interval, end).forEach(segment => {
      if (segment.day < cutoff || segment.day > today) return;
      let day = byDay[segment.day];
      if (!day) {
        day = {totalMs: 0, domains: {}, workspaces: {}};
        byDay[segment.day] = day;
      }
      if (!day.domains) day.domains = {};
      if (!day.workspaces) day.workspaces = {};
      day.totalMs = amount(day.totalMs) + segment.ms;
      increment(day.domains, interval.domain, segment.ms);
      increment(day.workspaces, interval.workspaceId || UNASSIGNED_WORKSPACE, segment.ms);
      elapsed += segment.ms;
    });
    return elapsed;
  }

  function persistInterval(interval, end) {
    if (!interval || end <= interval.startedAt) return Promise.resolve(0);
    return gsWorkbench.update(state => {
      const byDay = ensureMetrics(state).activityByDay;
      const elapsed = addActivity(byDay, interval, end, end);
      pruneActivity(byDay, end);
      return elapsed;
    });
  }

  function onActivityChange(row) {
    const now = Date.now();
    const previous = activity;
    const url = userUrl(row);
    // An active suspended/discarded tab and extension UI are not site activity.
    activity = url && row.active && !row.asleep &&
      row.status !== 'suspended' && row.status !== 'discarded'
      ? {
        uid: uid(row),
        tabId: row.id,
        domain: url.hostname || (url.protocol === 'file:' ? 'Local files' : url.protocol),
        workspaceId: workspaceId(row),
        startedAt: now,
      }
      : null;
    // Change the boundary synchronously, before the durable update. Concurrent
    // focus/idle/activation callbacks cannot flush the same interval twice.
    return persistInterval(previous, now);
  }

  function flushActivity() {
    if (!activity) return Promise.resolve(0);
    const now = Date.now();
    const previous = activity;
    activity = Object.assign({}, previous, {startedAt: now});
    return persistInterval(previous, now);
  }

  function metricsView(tabs, state, now) {
    const stored = state.metrics || {};
    const byDay = JSON.parse(JSON.stringify(stored.activityByDay || {}));
    if (activity) addActivity(byDay, activity, now, now);
    pruneActivity(byDay, now);
    const domains = Object.create(null);
    const workspaces = Object.create(null);
    let foregroundMs = 0;
    Object.keys(byDay).sort().forEach(key => {
      const day = byDay[key];
      foregroundMs += amount(day.totalMs);
      Object.keys(day.domains || {}).forEach(domain => {
        increment(domains, domain, amount(day.domains[domain]));
      });
      Object.keys(day.workspaces || {}).forEach(id => {
        increment(workspaces, id, amount(day.workspaces[id]));
      });
    });
    const byDomain = Object.keys(domains).map(domain => ({
      domain: domain,
      ms: domains[domain],
    })).sort((left, right) => right.ms - left.ms || left.domain.localeCompare(right.domain));
    const byWorkspace = Object.keys(workspaces).map(key => {
      const id = key === UNASSIGNED_WORKSPACE ? null : key;
      const workspace = state.workspaces.find(item => item.id === id);
      return {
        workspaceId: id,
        name: workspace ? workspace.name : id ? 'Deleted workspace' : 'Unassigned',
        ms: workspaces[key],
      };
    }).sort((left, right) => right.ms - left.ms || left.name.localeCompare(right.name));
    let suspendedNow = 0;
    let currentSleepMs = 0;
    tabs.forEach(row => {
      if (!row.asleep || row.incognito) return;
      suspendedNow++;
      const since = row.meta && row.meta.suspendedAt;
      if (finiteNonnegative(since) && since > 0 && since <= now) {
        currentSleepMs += now - since;
      }
    });
    const reasons = Object.assign({}, stored.protectionReasons || {});
    const protectionSkips = amount(stored.protectionSkips);
    const samples = amount(stored.restoreSamples);
    return Object.assign({}, stored, {
      sleepMs: amount(stored.sleepMs) + currentSleepMs,
      completedSleepMs: amount(stored.sleepMs),
      currentSleepMs: currentSleepMs,
      suspendedNow: suspendedNow,
      restoreAverageMs: samples ? amount(stored.restoreLatencyMs) / samples : null,
      protectionReasons: reasons,
      protectionSkips: protectionSkips,
      activityByDay: byDay,
      activity: {
        totalMs: foregroundMs,
        byDomain: byDomain,
        byWorkspace: byWorkspace,
        days: ACTIVITY_DAYS,
        measurement: 'Foreground-active time only; idle, background and sleeping tabs excluded.',
      },
    });
  }

  function neglectedRows(tabs, state, now, requestedDays) {
    const days = requestedDays === undefined
      ? Number(state.settings.neglectedDays)
      : Number(requestedDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('Neglected-tab age must be a positive number of days.');
    }
    const threshold = days * 24 * 60 * 60 * 1000;
    return tabs.filter(row => {
      if (row.incognito) return false;
      const since = row.lastViewedAt || row.createdAt;
      return finiteNonnegative(since) && since > 0 && now - since >= threshold;
    }).map(row => {
      const since = row.lastViewedAt || row.createdAt;
      return Object.assign({}, row, {
        neglectedSince: since,
        neglectedMs: now - since,
        recommendation: 'Review this tab; archive only if you no longer need it.',
      });
    }).sort((left, right) => left.neglectedSince - right.neglectedSince || left.id - right.id);
  }

  function findSnapshot(id, state) {
    if (typeof id !== 'string' || !id) throw new Error('Select a snapshot.');
    const snapshot = (state || gsWorkbench.getState()).snapshots.find(item => item.id === id);
    if (!snapshot) throw new Error('This snapshot no longer exists.');
    return snapshot;
  }

  function snapshotLabel(label, now, reason) {
    if (label !== undefined && typeof label !== 'string') {
      throw new Error('Snapshot label must be text.');
    }
    if (label && label.trim()) {
      if (label.trim().length > 120) throw new Error('Snapshot labels can have at most 120 characters.');
      return label.trim();
    }
    return (reason === 'scheduled' ? 'Scheduled snapshot — ' : 'Snapshot — ') +
      new Date(now).toLocaleString();
  }

  function snapshotDue(state, now) {
    const settings = state.settings;
    const minutes = Number(settings.snapshotIntervalMinutes);
    return settings.snapshotEnabled && Number.isFinite(minutes) && minutes > 0 &&
      (!settings.lastSnapshotAt || now - settings.lastSnapshotAt >= minutes * 60 * 1000);
  }

  async function takeSnapshot(label, reason, now) {
    const name = snapshotLabel(label, now, reason);
    const rows = await gsWorkbench.getTabs();
    await gsWorkbenchWorkspaces.rebindTemporaryGroups([], rows);
    const entries = rows.filter(row => !row.incognito).map(row => gsWorkbenchWorkspaces.snapshot(row));
    return gsWorkbench.update(state => {
      // Two alarm/command callbacks can both collect tabs; only the first due
      // scheduled callback commits a version and advances the schedule.
      if (reason === 'scheduled' && !snapshotDue(state, now)) return null;
      const snapshot = {
        id: makeId(),
        label: name,
        createdAt: now,
        reason: reason,
        tabs: entries,
      };
      state.snapshots.push(snapshot);
      state.snapshots.sort((left, right) => left.createdAt - right.createdAt);
      state.settings.lastSnapshotAt = now;
      appendEvent(state, 'snapshot', null, reason, {
        snapshotId: snapshot.id,
        label: snapshot.label,
        tabCount: entries.length,
      }, now);
      pruneState(state, now);
      return snapshot;
    });
  }

  function changedFields(before, after) {
    const fields = [];
    const values = entry => ({
      url: originalUrl(entry),
      title: entry.title || '',
      window: Number.isInteger(entry.windowOrdinal) ? entry.windowOrdinal : entry.windowId,
      windowBounds: JSON.stringify(entry.windowBounds || null),
      windowFocused: !!entry.windowFocused,
      index: entry.index,
      pinned: !!entry.pinned,
      active: !!entry.active,
      asleep: !!entry.asleep,
      status: entry.status || (entry.asleep ? 'suspended' : 'awake'),
      group: JSON.stringify(entry.group ? {
        key: entry.group.key || entry.group.sourceId || null,
        title: entry.group.title || '',
        color: entry.group.color || '',
        collapsed: !!entry.group.collapsed,
      } : null),
      workspace: workspaceId(entry),
      ...gsWorkbenchWorkspaces.getSavedTemporaryInfo(entry),
      snooze: JSON.stringify(entry.meta && entry.meta.snooze || null),
      protection: JSON.stringify(entry.meta && entry.meta.protection || null),
    });
    const oldValues = values(before);
    const newValues = values(after);
    Object.keys(oldValues).forEach(key => {
      if (oldValues[key] !== newValues[key]) fields.push(key);
    });
    return fields;
  }

  function compareSnapshots(before, after) {
    const oldTabs = before.tabs;
    const newTabs = after.tabs;
    const oldUsed = new Set();
    const newUsed = new Set();
    const changed = [];
    let unchangedCount = 0;
    const byUid = new Map();
    const byUrl = new Map();
    newTabs.forEach((entry, index) => {
      const id = uid(entry);
      if (id) {
        if (!byUid.has(id)) byUid.set(id, []);
        byUid.get(id).push(index);
      }
      const url = originalUrl(entry);
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(index);
    });

    function match(oldIndex, candidates, requireLegacy) {
      const old = oldTabs[oldIndex];
      let best = -1;
      let bestFields;
      let bestScore = Infinity;
      (candidates || []).forEach(newIndex => {
        if (newUsed.has(newIndex)) return;
        const next = newTabs[newIndex];
        // Distinct durable UIDs are distinct tabs even if their URLs coincide.
        if (requireLegacy && uid(old) && uid(next)) return;
        const fields = changedFields(old, next);
        const score = fields.length + (workspaceId(old) !== workspaceId(next) ? 20 : 0);
        if (score < bestScore) {
          best = newIndex;
          bestFields = fields;
          bestScore = score;
        }
      });
      if (best === -1) return;
      oldUsed.add(oldIndex);
      newUsed.add(best);
      if (bestFields.length) {
        changed.push({before: old, after: newTabs[best], fields: bestFields});
      } else {
        unchangedCount++;
      }
    }

    // Identity matches precede URL fallback so duplicate occurrences never
    // consume a surviving durable tab belonging to a later match.
    oldTabs.forEach((entry, index) => {
      const id = uid(entry);
      if (id) match(index, byUid.get(id), false);
    });
    oldTabs.forEach((entry, index) => {
      if (!oldUsed.has(index)) match(index, byUrl.get(originalUrl(entry)), true);
    });
    return {
      beforeId: before.id,
      afterId: after.id,
      added: newTabs.filter((entry, index) => !newUsed.has(index)),
      removed: oldTabs.filter((entry, index) => !oldUsed.has(index)),
      changed: changed,
      unchangedCount: unchangedCount,
    };
  }

  async function restoreSnapshot(payload) {
    if (payload.asleep !== undefined && typeof payload.asleep !== 'boolean') {
      throw new Error('Snapshot restore state must be awake or asleep.');
    }
    const snapshot = findSnapshot(payload.id);
    // Entries are immutable versions. The Actions engine may enrich its own
    // copy while restoring windows/groups and binding durable metadata.
    const entries = JSON.parse(JSON.stringify(snapshot.tabs));
    const eligible = [];
    const expirationSkips = [];
    const now = Date.now();
    entries.forEach((entry, index) => {
      const expiry = gsWorkbenchWorkspaces.getSavedTemporaryInfo(entry).expiresAt;
      if (expiry && expiry <= now) {
        expirationSkips.push({
          entry: entry, restoreEntryIndex: index,
          reasons: ['Saved temporary tab is overdue; its snapshot was retained without reopening it for automatic archival.'],
        });
      } else eligible.push({entry: entry, index: index});
    });
    const options = {
      recordUndo: true,
      reason: 'snapshot-restore',
      label: snapshot.label,
      priorityWorkspaceId: gsWorkbench.getState().currentWorkspaceId,
    };
    if (payload.asleep !== undefined) options.asleep = payload.asleep;
    const rows = await gsWorkbenchActions.restoreEntries(eligible.map(item => item.entry), options);
    const remapIndex = row => {
      if (Number.isInteger(row.restoreEntryIndex) && eligible[row.restoreEntryIndex]) {
        row.restoreEntryIndex = eligible[row.restoreEntryIndex].index;
      }
      return row;
    };
    rows.forEach(remapIndex);
    (rows.partial || []).forEach(remapIndex);
    (rows.skipped || []).forEach(remapIndex);
    const skipped = expirationSkips.concat(rows.skipped || []);
    const errors = rows.errors || [];
    const created = rows.created;
    const changed = rows.changed;
    await record('snapshot', null, 'restore', {
      snapshotId: snapshot.id,
      label: snapshot.label,
      restoredCount: rows.length,
      createdCount: created.length,
      changedCount: changed.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
    });
    return {
      id: snapshot.id,
      label: snapshot.label,
      restored: rows,
      changed: changed,
      created: created,
      partial: rows.partial,
      skipped: skipped,
      errors: errors,
      operationId: rows.operationId || null,
      undoSummary: rows.undoSummary,
      semantics: 'merge',
      summary: 'Matched ' + rows.length + ' snapshot tab(s); changed ' + changed.length +
        ', including ' + created.length + ' newly created. Current changed pages and unrelated tabs were kept. ' +
        'Overdue saved tabs were skipped. Undo reverses restored tab organization/state, not unsaved application data.',
    };
  }

  function browserCall(namespace, method, args) {
    return new Promise((resolve, reject) => {
      if (!gsBrowser[namespace] || typeof gsBrowser[namespace][method] !== 'function') {
        reject(new Error('The browser does not support ' + namespace + '.' + method + '.'));
        return;
      }
      gsBrowser[namespace][method].apply(gsBrowser[namespace], args.concat(result => {
        if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
        else resolve(result);
      }));
    });
  }

  async function openStartupChooser() {
    const route = gsBrowser.runtime.getURL('dashboard.html?view=workspaces&startup=choose');
    const dashboard = gsBrowser.runtime.getURL('dashboard.html');
    const tabs = await browserCall('tabs', 'query', [{windowType: 'normal'}]);
    const existing = tabs.find(tab => !tab.incognito &&
      (tab.url || '').split('?')[0].split('#')[0] === dashboard);
    if (existing) {
      const tab = await browserCall('tabs', 'update', [existing.id, {url: route, active: true}]);
      await browserCall('windows', 'update', [existing.windowId, {focused: true}]);
      return tab;
    }
    const windows = await browserCall('windows', 'getAll', [{windowTypes: ['normal']}]);
    const normal = windows.filter(window => !window.incognito);
    const target = normal.find(window => window.focused) || normal[0];
    if (target) {
      const tab = await browserCall('tabs', 'create', [{url: route, active: true, windowId: target.id}]);
      if (!target.focused) await browserCall('windows', 'update', [target.id, {focused: true}]);
      return tab;
    }
    const created = await browserCall('windows', 'create', [{
      url: route, type: 'normal', incognito: false, focused: true,
    }]);
    if (!created || !created.tabs || !created.tabs.length) {
      throw new Error('The browser did not create the workspace chooser.');
    }
    return created.tabs[0];
  }

  async function applyStartup() {
    const state = gsWorkbench.getState();
    const policy = state.settings.startupPolicy;
    if (policy === 'leave') {
      return {policy: policy, applied: false, summary: 'Existing tabs were left untouched; no pages were awakened.'};
    }
    if (policy === 'choose') {
      const tab = await openStartupChooser();
      return {policy: policy, applied: true, tabId: tab.id, url: tab.url};
    }
    if (policy !== 'current') throw new Error('Unknown startup policy.');
    const id = state.currentWorkspaceId;
    if (!id || !state.workspaces.some(workspace => workspace.id === id)) {
      return {
        policy: policy,
        applied: false,
        workspaceId: null,
        summary: 'No current workspace has been selected; existing tabs were left untouched.',
      };
    }
    const result = await gsWorkbench.execute('workspace.switch', {id: id});
    return {policy: policy, applied: result.switched === true, workspaceId: id, result: result};
  }

  async function pruneStoredData(now) {
    const state = gsWorkbench.getState();
    const cutoff = cutoffDay(now);
    const today = dateKey(now);
    const oldDays = Object.keys((state.metrics || {}).activityByDay || {})
      .some(day => day < cutoff || day > today);
    if (!oldDays && state.timeline.length <= TIMELINE_LIMIT &&
        state.snapshots.length <= snapshotKeep(state)) return;
    await gsWorkbench.update(draft => pruneState(draft, now));
  }

  async function tick(now) {
    await flushActivity();
    await pruneStoredData(now);
    if (snapshotDue(gsWorkbench.getState(), now)) {
      return takeSnapshot(undefined, 'scheduled', now);
    }
    return null;
  }

  async function initAsPromised() {
    if (initialized) return;
    initialized = true;
    gsWorkbench.register('snapshot.create', payload => takeSnapshot(payload.label, 'manual', Date.now()));
    gsWorkbench.register('snapshot.delete', payload => gsWorkbench.update(state => {
      const snapshot = findSnapshot(payload.id, state);
      state.snapshots = state.snapshots.filter(item => item.id !== snapshot.id);
      appendEvent(state, 'snapshot', null, 'delete', {
        snapshotId: snapshot.id,
        label: snapshot.label,
      }, Date.now());
      return {
        id: snapshot.id,
        deleted: true,
        summary: 'Deleted only this saved snapshot. Live tabs, archives and other snapshots were not changed.',
      };
    }));
    gsWorkbench.register('snapshot.compare', payload => {
      const state = gsWorkbench.getState();
      return compareSnapshots(findSnapshot(payload.beforeId, state), findSnapshot(payload.afterId, state));
    });
    gsWorkbench.register('snapshot.restore', restoreSnapshot);
    gsWorkbench.register('startup.apply', applyStartup);
    gsWorkbench.register('neglected.list', async payload => {
      const tabs = await gsWorkbench.getTabs();
      return neglectedRows(tabs, gsWorkbench.getState(), Date.now(), payload.days);
    });
    gsWorkbench.register('activity.get', async () => {
      await flushActivity();
      const tabs = await gsWorkbench.getTabs();
      return metricsView(tabs, gsWorkbench.getState(), Date.now());
    });
    gsWorkbench.registerView('metrics', metricsView);
    gsWorkbench.registerView('neglected', (tabs, state, now) => neglectedRows(tabs, state, now));
    gsWorkbench.registerTick(tick);
    gsWorkbench.registerStartup(applyStartup);
    await pruneStoredData(Date.now());
  }

  return {
    initAsPromised: initAsPromised,
    record: record,
    onActivityChange: onActivityChange,
    flushActivity: flushActivity,
  };
})();
