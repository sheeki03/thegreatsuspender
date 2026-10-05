/*global gsWorkbench, gsWorkbenchActions, gsWorkbenchWorkspaces */
// Local session snapshots: save, schedule, compare and restore. Snapshots record
// tab URLs and organization only, never page contents.
// eslint-disable-next-line no-unused-vars
var gsWorkbenchSnapshots = (function() {
  'use strict';

  let initialized = false;

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(row) {
    return row && (row.uid || (row.meta && row.meta.uid)) || null;
  }

  function originalUrl(row) {
    return row && (row.originalUrl || (row.meta && row.meta.url) || row.url) || '';
  }

  function workspaceId(row) {
    if (!row) return null;
    if (Object.prototype.hasOwnProperty.call(row, 'workspaceId')) return row.workspaceId || null;
    return row.meta && row.meta.workspaceId || null;
  }

  function snapshotKeep(state) {
    const keep = Number(state.settings.snapshotKeep);
    return Number.isFinite(keep) && keep > 0 ? Math.max(1, Math.floor(keep)) : 30;
  }

  function findSnapshot(id, state) {
    if (typeof id !== 'string' || !id) throw new Error('Select a snapshot.');
    const snapshot = (state || gsWorkbench.getState()).snapshots.find(item => item.id === id);
    if (!snapshot) throw new Error('This snapshot no longer exists.');
    return snapshot;
  }

  function snapshotLabel(label, now, reason) {
    if (label !== undefined && typeof label !== 'string') throw new Error('Snapshot name must be text.');
    if (label && label.trim()) {
      if (label.trim().length > 120) throw new Error('Snapshot names can have at most 120 characters.');
      return label.trim();
    }
    return (reason === 'scheduled' ? 'Automatic snapshot — ' : 'Snapshot — ') + new Date(now).toLocaleString();
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
    const entries = rows.filter(row => !row.incognito).map(row => gsWorkbenchWorkspaces.snapshot(row));
    return gsWorkbench.update(state => {
      // Two alarm callbacks can both collect tabs; only the first due one commits.
      if (reason === 'scheduled' && !snapshotDue(state, now)) return null;
      const snapshot = { id: crypto.randomUUID(), label: name, createdAt: now, reason, tabs: entries };
      state.snapshots.push(snapshot);
      state.snapshots.sort((left, right) => left.createdAt - right.createdAt);
      state.settings.lastSnapshotAt = now;
      const keep = snapshotKeep(state);
      if (state.snapshots.length > keep) state.snapshots.splice(0, state.snapshots.length - keep);
      return snapshot;
    });
  }

  function changedFields(before, after) {
    const values = entry => ({
      url: originalUrl(entry),
      title: entry.title || '',
      window: Number.isInteger(entry.windowOrdinal) ? entry.windowOrdinal : entry.windowId,
      index: entry.index,
      pinned: !!entry.pinned,
      asleep: !!entry.asleep,
      group: JSON.stringify(entry.group ? { title: entry.group.title || '', color: entry.group.color || '' } : null),
      workspace: workspaceId(entry),
    });
    const oldValues = values(before);
    const newValues = values(after);
    return Object.keys(oldValues).filter(key => oldValues[key] !== newValues[key]);
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
        // Distinct durable IDs are distinct tabs even if their URLs coincide.
        if (requireLegacy && uid(old) && uid(next)) return;
        const fields = changedFields(old, next);
        if (fields.length < bestScore) {
          best = newIndex;
          bestFields = fields;
          bestScore = fields.length;
        }
      });
      if (best === -1) return;
      oldUsed.add(oldIndex);
      newUsed.add(best);
      if (bestFields.length) changed.push({ before: old, after: newTabs[best], fields: bestFields });
      else unchangedCount++;
    }

    // Identity matches come first so a duplicate URL never steals a surviving tab.
    oldTabs.forEach((entry, index) => { if (uid(entry)) match(index, byUid.get(uid(entry)), false); });
    oldTabs.forEach((entry, index) => { if (!oldUsed.has(index)) match(index, byUrl.get(originalUrl(entry)), true); });
    return {
      beforeId: before.id,
      afterId: after.id,
      added: newTabs.filter((entry, index) => !newUsed.has(index)),
      removed: oldTabs.filter((entry, index) => !oldUsed.has(index)),
      changed,
      unchangedCount,
    };
  }

  // Reopens the snapshot's tabs that aren't open now, asleep, in their saved
  // windows and groups. Tabs that are already open are left exactly as they are.
  async function restoreSnapshot(payload) {
    const snapshot = findSnapshot(payload.id);
    const live = await gsWorkbench.getTabs();
    // A tab keeps its identity when it navigates, so identity only counts with the same page.
    const liveUrlByUid = new Map(live.map(row => [row.uid, row.originalUrl]));
    const liveUrls = new Map();
    live.forEach(row => liveUrls.set(row.originalUrl, (liveUrls.get(row.originalUrl) || 0) + 1));
    const missing = [];
    let alreadyOpen = 0;
    for (const entry of snapshot.tabs) {
      const url = originalUrl(entry);
      if (uid(entry) && liveUrlByUid.get(uid(entry)) === url) {
        liveUrls.set(url, Math.max(0, (liveUrls.get(url) || 0) - 1));
        alreadyOpen++;
        continue;
      }
      if (liveUrls.get(url) > 0) { liveUrls.set(url, liveUrls.get(url) - 1); alreadyOpen++; continue; }
      // Reopened pages arrive asleep in the background; don't switch any window's current tab.
      missing.push(Object.assign({}, entry, { active: false }));
    }
    // Saved entries are immutable; Actions enriches its own copy while restoring.
    const rows = missing.length ? await gsWorkbenchActions.restoreEntries(copy(missing), {
      recordUndo: true, reason: 'snapshot-restore', label: snapshot.label, asleep: true,
      priorityWorkspaceId: gsWorkbench.getState().currentWorkspaceId,
    }) : Object.assign([], { changed: [], created: [], partial: [], skipped: [], operationId: null });
    return {
      id: snapshot.id,
      label: snapshot.label,
      restored: Array.from(rows),
      changed: rows.changed,
      created: rows.created,
      alreadyOpen,
      skipped: rows.skipped || [],
      operationId: rows.operationId || null,
    };
  }

  async function tick(now) {
    const state = gsWorkbench.getState();
    if (state.snapshots.length > snapshotKeep(state)) {
      await gsWorkbench.update(draft => { draft.snapshots.splice(0, draft.snapshots.length - snapshotKeep(draft)); });
    }
    return snapshotDue(gsWorkbench.getState(), now) ? takeSnapshot(undefined, 'scheduled', now) : null;
  }

  async function initAsPromised() {
    if (initialized) return;
    initialized = true;
    gsWorkbench.register('snapshot.create', payload => takeSnapshot(payload.label, 'manual', Date.now()));
    gsWorkbench.register('snapshot.delete', payload => gsWorkbench.update(state => {
      const snapshot = findSnapshot(payload.id, state);
      state.snapshots = state.snapshots.filter(item => item.id !== snapshot.id);
      return { id: snapshot.id, deleted: true, summary: 'Snapshot deleted. Your open tabs were not changed.' };
    }));
    gsWorkbench.register('snapshot.compare', payload => {
      const state = gsWorkbench.getState();
      return compareSnapshots(findSnapshot(payload.beforeId, state), findSnapshot(payload.afterId, state));
    });
    gsWorkbench.register('snapshot.restore', restoreSnapshot);
    gsWorkbench.registerTick(tick);
  }

  return { initAsPromised };
})();
