/*global crypto, gsWorkbench, gsWorkbenchActions */
'use strict';

// eslint-disable-next-line no-unused-vars
var gsWorkbenchWorkspaces = (function() {
  const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const booleanPolicies = ['ignorePinned', 'ignoreAudio', 'ignoreForms', 'ignoreActive', 'countEnabled'];
  const numberPolicies = ['suspendMinutes', 'awakeLimit', 'awakeTarget'];
  let initialized = false;
  let operationTail = Promise.resolve();

  function serialized(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(function() {});
    return result;
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function name(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('A workspace name is required.');
    const trimmed = value.trim();
    return trimmed;
  }

  function color(value) {
    if (typeof value !== 'string' || !colors.includes(value)) throw new Error('Choose a supported native tab-group color.');
    return value;
  }

  function policyPatch(value, existing) {
    if (value === undefined) return copy(existing || {});
    if (value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace policy must be an object.');
    const result = Object.assign({}, existing || {});
    Object.keys(value).forEach(function(key) {
      if (!booleanPolicies.includes(key) && !numberPolicies.includes(key)) throw new Error('Unknown workspace policy: ' + key);
      if (value[key] === null) {
        delete result[key];
      } else if (booleanPolicies.includes(key)) {
        if (typeof value[key] !== 'boolean') throw new Error(key + ' must be true or false.');
        result[key] = value[key];
      } else {
        if (value[key] === '' || (typeof value[key] !== 'number' && typeof value[key] !== 'string')) throw new Error(key + ' must be a number.');
        const numeric = Number(value[key]);
        if (!Number.isFinite(numeric) || numeric < 0 || (key !== 'suspendMinutes' && (!Number.isInteger(numeric) || numeric < 1))) {
          throw new Error(key + (key === 'suspendMinutes' ? ' must be a nonnegative number (0 disables the timer).' : ' must be a positive whole number.'));
        }
        result[key] = numeric;
      }
    });
    const settings = gsWorkbench.getState().settings;
    const limit = result.awakeLimit === undefined ? settings.awakeLimit : result.awakeLimit;
    const target = result.awakeTarget === undefined ? settings.awakeTarget : result.awakeTarget;
    if (target > limit) throw new Error('The awake target cannot exceed the awake limit.');
    return result;
  }

  function workspace(id, state) {
    const found = (state || gsWorkbench.getState()).workspaces.find(item => item.id === id);
    if (!found) throw new Error('Workspace not found.');
    return found;
  }

  function tabIds(value, allowEmpty) {
    if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error('Select at least one tab.');
    if (value.some(id => !Number.isInteger(id) || id < 0)) throw new Error('Tab IDs must be nonnegative integers.');
    return Array.from(new Set(value));
  }

  function tabUid(row, state) {
    const meta = (state || gsWorkbench.getState()).meta[String(row.id)];
    return row.uid || (meta && meta.uid) || null;
  }

  function workspaceId(row, state) {
    const meta = (state || gsWorkbench.getState()).meta[String(row.id)];
    return meta && meta.workspaceId !== undefined ? meta.workspaceId : (row.workspaceId || null);
  }

  function originalUrl(row) {
    return row.originalUrl || row.url || '';
  }

  function skipped(row, reason) {
    return Object.assign({}, row || {}, { reasons: Array.isArray(reason) ? reason : [reason] });
  }

  function selectTabs(tabs, requested) {
    const byId = new Map(tabs.map(row => [row.id, row]));
    const selected = [];
    const unavailable = [];
    requested.forEach(function(id) {
      const row = byId.get(id);
      if (row) selected.push(row);
      else unavailable.push(skipped({ id: id, tabId: id }, 'Tab is no longer available or is outside normal managed tabs.'));
    });
    return { tabs: selected, skipped: unavailable };
  }

  function decorateSnapshot(snapshot, row, state) {
    state = state || gsWorkbench.getState();
    const stableUid = tabUid(row, state) || snapshot.uid;
    if (!stableUid) throw new Error('Tab has no durable identity; refresh before assigning or saving it.');
    snapshot.uid = stableUid;
    snapshot.meta = copy(state.meta[String(row.id)] || snapshot.meta || {});
    snapshot.meta.uid = stableUid;
    snapshot.meta.workspaceId = workspaceId(row, state);
    snapshot.workspaceId = snapshot.meta.workspaceId;
    if (snapshot.group && row.groupId >= 0) {
      if (snapshot.group.sourceId === undefined) snapshot.group.sourceId = row.groupId;
      if (!snapshot.group.key) snapshot.group.key = row.windowId + ':' + row.groupId;
    }
    return snapshot;
  }

  function rowSnapshot(row, state) {
    return decorateSnapshot(copy(gsWorkbench.tabSnapshot(row)), row, state);
  }

  function putSnapshot(target, snapshot) {
    target.members = Array.from(new Set((target.members || []).concat(snapshot.uid)));
    target.savedTabs = (target.savedTabs || []).filter(item => item.uid !== snapshot.uid).concat(snapshot);
  }

  function saveRows(draft, rows) {
    rows.forEach(function(row) {
      const meta = draft.meta[String(row.id)];
      const stableUid = tabUid(row, draft);
      if (!meta || meta.uid !== stableUid || meta.url !== originalUrl(row)) return;
      const id = workspaceId(row, draft);
      draft.workspaces.forEach(function(item) {
        if (item.id === id) return;
        item.members = (item.members || []).filter(value => value !== stableUid);
        item.savedTabs = (item.savedTabs || []).filter(entry => entry.uid !== stableUid);
      });
      const target = draft.workspaces.find(item => item.id === id);
      if (!target) return;
      putSnapshot(target, rowSnapshot(row, draft));
    });
  }

  function emptyAction(action) {
    return { action: action, changed: [], skipped: [], operationId: null };
  }

  async function createWorkspace(payload) {
    const created = {
      id: uid(), name: name(payload.name), color: payload.color === undefined ? 'blue' : color(payload.color),
      policy: policyPatch(payload.policy, {}), members: [], savedTabs: [], hibernated: false, createdAt: Date.now()
    };
    await gsWorkbench.update(function(draft) { draft.workspaces.push(created); });
    if (Array.isArray(payload.tabIds) && payload.tabIds.length) {
      const assigned = await assignWorkspace({ id: created.id, tabIds: payload.tabIds });
      return Object.assign(copy(workspace(created.id)), { workspace: assigned.workspace, changed: assigned.changed, skipped: assigned.skipped });
    }
    return copy(workspace(created.id));
  }

  async function updateWorkspace(payload) {
    const current = workspace(payload.id);
    const updatedName = payload.name === undefined ? current.name : name(payload.name);
    const updatedColor = payload.color === undefined ? current.color : color(payload.color);
    const updatedPolicy = policyPatch(payload.policy, current.policy);
    await gsWorkbench.update(function(draft) {
      const target = workspace(payload.id, draft);
      target.name = updatedName;
      target.color = updatedColor;
      target.policy = updatedPolicy;
    });
    await gsWorkbench.refreshTimers();
    return copy(workspace(payload.id));
  }

  async function assignWorkspace(payload) {
    if (payload.id !== null) workspace(payload.id);
    const requested = tabIds(payload.tabIds, false);
    const selection = selectTabs(await gsWorkbench.getTabs(), requested);
    const changed = [];
    await gsWorkbench.update(function(draft) {
      selection.tabs.forEach(function(row) {
        const meta = draft.meta[String(row.id)];
        const stableUid = tabUid(row, draft);
        if (!meta || !stableUid) {
          selection.skipped.push(skipped(row, 'Tab metadata is unavailable; refresh and try again.'));
          return;
        }
        draft.workspaces.forEach(function(item) {
          if (item.id !== payload.id) {
            item.members = (item.members || []).filter(member => member !== stableUid);
            item.savedTabs = (item.savedTabs || []).filter(entry => entry.uid !== stableUid);
          }
        });
        meta.workspaceId = payload.id;
        if (payload.id !== null) putSnapshot(workspace(payload.id, draft), rowSnapshot(row, draft));
        changed.push(row.id);
      });
    });
    await gsWorkbench.refreshTimers();
    return { workspace: payload.id === null ? null : copy(workspace(payload.id)), changed: changed, skipped: selection.skipped };
  }

  async function deleteWorkspace(payload) {
    const current = workspace(payload.id);
    const supplied = Object.prototype.hasOwnProperty.call(payload, 'reassignToId');
    const rows = (await gsWorkbench.getTabs()).filter(row => workspaceId(row) === current.id);
    const nonempty = rows.length || (current.members || []).length || (current.savedTabs || []).length;
    if (!supplied && (nonempty || gsWorkbench.getState().currentWorkspaceId === current.id)) {
      throw new Error('Current or nonempty workspaces require explicit reassignToId (another workspace ID, or null for unassigned).');
    }
    const targetId = supplied ? payload.reassignToId : null;
    if (targetId === current.id) throw new Error('Choose a different workspace for reassignment.');
    if (targetId !== null) workspace(targetId);
    let archivedId = null;
    await gsWorkbench.update(function(draft) {
      const source = workspace(current.id, draft);
      saveRows(draft, rows);
      const snapshots = (source.savedTabs || []).map(function(entry) {
        const snapshot = copy(entry);
        snapshot.workspaceId = targetId;
        snapshot.meta = Object.assign({}, snapshot.meta || {}, { uid: snapshot.uid, workspaceId: targetId });
        return snapshot;
      });
      Object.keys(draft.meta).forEach(function(id) {
        if (draft.meta[id].workspaceId === source.id) draft.meta[id].workspaceId = targetId;
      });
      if (targetId !== null) {
        const target = workspace(targetId, draft);
        snapshots.forEach(snapshot => putSnapshot(target, snapshot));
        target.members = Array.from(new Set((target.members || []).concat(source.members || [])));
      } else {
        const openUids = new Set(rows.map(row => tabUid(row, draft)));
        const closedEntries = snapshots.filter(entry => !openUids.has(entry.uid));
        if (closedEntries.length) {
          archivedId = uid();
          draft.archive.push({ id: archivedId, label: source.name + ' — closed members', reason: 'Workspace deleted with unassigned members', createdAt: Date.now(), tabs: closedEntries });
        }
      }
      if (draft.currentWorkspaceId === source.id) draft.currentWorkspaceId = targetId;
      draft.workspaces = draft.workspaces.filter(item => item.id !== source.id);
    });
    await gsWorkbench.refreshTimers();
    return { deletedId: current.id, reassignedToId: targetId, archivedId: archivedId, changed: rows.map(row => row.id) };
  }

  async function hibernateWorkspace(payload) {
    const current = workspace(payload.id);
    const rows = (await gsWorkbench.getTabs()).filter(row => workspaceId(row) === current.id);
    await gsWorkbench.update(function(draft) { saveRows(draft, rows); });
    const awake = rows.filter(row => !row.asleep);
    const result = awake.length ? await gsWorkbenchActions.perform('suspend', awake.map(row => row.id), {
      reason: 'Workspace hibernation', label: 'Hibernate ' + current.name, allowActive: true
    }) : emptyAction('suspend');
    const after = (await gsWorkbench.getTabs()).filter(row => workspaceId(row) === current.id);
    await gsWorkbench.update(function(draft) {
      saveRows(draft, after);
      workspace(current.id, draft).hibernated = !after.some(row => !row.asleep);
    });
    return Object.assign({}, result, {
      workspace: copy(workspace(current.id)), alreadyAsleep: rows.filter(row => row.asleep).map(row => row.id),
      missing: (workspace(current.id).members || []).filter(member => !after.some(row => tabUid(row) === member)).length
    });
  }

  async function switchWorkspace(payload) {
    const current = workspace(payload.id);
    let rows = await gsWorkbench.getTabs();
    await gsWorkbench.update(function(draft) { saveRows(draft, rows); });
    const target = workspace(current.id);
    // A member counts as open only if its tab still shows the saved page.
    const openPages = new Map(rows.map(row => [tabUid(row), originalUrl(row)]));
    const missing = (target.savedTabs || []).filter(entry => openPages.get(entry.uid) !== (entry.originalUrl || entry.url));
    let restored = [];
    const errors = [];
    if (missing.length) {
      try {
        restored = await gsWorkbenchActions.restoreEntries(copy(missing), {
          asleep: false, priorityWorkspaceId: target.id, recordUndo: false, reason: 'workspace-restore'
        });
        (restored.errors || restored.skipped || []).forEach(error => errors.push(error));
      } catch (error) {
        errors.push({ reasons: [errorText(error)], entries: missing.map(entry => entry.uid) });
      }
    }
    rows = await gsWorkbench.getTabs();
    const targetRows = rows.filter(row => workspaceId(row) === target.id);
    missing.forEach(function(entry) {
      if (!targetRows.some(row => tabUid(row) === entry.uid) && !errors.some(error => error.entry && error.entry.uid === entry.uid)) {
        errors.push({ entry: entry, reasons: ['Workspace member could not be reopened; its saved snapshot is retained.'] });
      }
    });
    const sleepingTarget = targetRows.filter(row => row.asleep).map(row => row.id);
    const awakened = sleepingTarget.length ? await gsWorkbenchActions.perform('restore', sleepingTarget, {
      reason: 'Workspace switch', label: 'Wake ' + target.name, recordUndo: false
    }) : emptyAction('restore');
    rows = await gsWorkbench.getTabs();
    if ((target.savedTabs || []).length && !rows.some(row => workspaceId(row) === target.id && !row.asleep)) {
      errors.push({ reasons: ['No target workspace member could be made awake; other workspaces were left unchanged.'] });
      return { workspace: copy(workspace(target.id)), switched: false, hibernated: [], restored: Array.from(restored), awakened: awakened, skipped: awakened.skipped || [], errors: errors };
    }
    const outgoing = rows.filter(row => workspaceId(row) && workspaceId(row) !== target.id && !row.asleep);
    await gsWorkbench.update(function(draft) {
      saveRows(draft, rows);
      draft.currentWorkspaceId = target.id;
      workspace(target.id, draft).hibernated = false;
    });
    const suspended = outgoing.length ? await gsWorkbenchActions.perform('suspend', outgoing.map(row => row.id), {
      reason: 'Workspace switch', label: 'Switch to ' + target.name, allowActive: true
    }) : emptyAction('suspend');
    const after = await gsWorkbench.getTabs();
    const hibernated = [];
    await gsWorkbench.update(function(draft) {
      saveRows(draft, after);
      draft.workspaces.forEach(function(item) {
        const members = after.filter(row => workspaceId(row, draft) === item.id);
        item.hibernated = item.id !== target.id && !members.some(row => !row.asleep);
        if (item.id !== target.id) {
          const ids = new Set(outgoing.filter(row => workspaceId(row, draft) === item.id).map(row => row.id));
          hibernated.push({ id: item.id, name: item.name, hibernated: item.hibernated, changed: suspended.changed.filter(id => ids.has(id)), skipped: (suspended.skipped || []).filter(row => ids.has(row.id)) });
        }
      });
    });
    await gsWorkbench.refreshTimers();
    return {
      workspace: copy(workspace(target.id)), switched: true, hibernated: hibernated, restored: Array.from(restored), awakened: awakened,
      action: 'suspend', changed: suspended.changed, operationId: suspended.operationId,
      skipped: (awakened.skipped || []).concat(suspended.skipped || []), errors: errors
    };
  }

  function survivorScore(row) {
    const reasons = gsWorkbench.getProtectionReasonsSync(row, 'close');
    const critical = reasons.some(reason => /dirty|form|draft|unverified/i.test(reason)) ? 10000 : 0;
    return critical + reasons.length * 1000 + (row.active ? 500 : 0) + (row.pinned ? 300 : 0) + (row.audible ? 200 : 0) + (!row.asleep ? 100 : 0);
  }

  function duplicateGroups(tabs, state) {
    const buckets = new Map();
    tabs.forEach(function(row) {
      const url = originalUrl(row);
      if (!url) return;
      const key = JSON.stringify([workspaceId(row, state), url]);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });
    return Array.from(buckets.values()).filter(group => group.length > 1).map(function(group) {
      const ranked = group.slice().sort(function(a, b) {
        return survivorScore(b) - survivorScore(a) || (b.lastViewedAt || 0) - (a.lastViewedAt || 0) || a.windowOrdinal - b.windowOrdinal || a.index - b.index || a.id - b.id;
      });
      return { url: originalUrl(group[0]), workspaceId: workspaceId(group[0], state), workspaceName: group[0].workspaceName || 'Unassigned', tabs: group, recommendedSurvivorId: ranked[0].id };
    });
  }

  async function previewDuplicates(payload) {
    const rows = await gsWorkbench.getTabs();
    const selection = payload.tabIds === undefined ? { tabs: rows, skipped: [] } : selectTabs(rows, tabIds(payload.tabIds, true));
    return { groups: duplicateGroups(selection.tabs, gsWorkbench.getState()), skipped: selection.skipped };
  }

  async function mergeDuplicates(payload) {
    if (!Array.isArray(payload.groups) || !payload.groups.length) throw new Error('Select duplicate groups and their surviving tabs.');
    const plans = payload.groups.map(function(group) {
      if (!group || !Number.isInteger(group.survivorId) || group.survivorId < 0) throw new Error('Each duplicate group requires a surviving tab.');
      return { survivorId: group.survivorId, tabIds: tabIds(group.tabIds, false) };
    });
    const survivors = new Set(plans.map(group => group.survivorId));
    const rows = await gsWorkbench.getTabs();
    const byId = new Map(rows.map(row => [row.id, row]));
    const candidates = new Set();
    const skippedRows = [];
    plans.forEach(function(plan) {
      const survivor = byId.get(plan.survivorId);
      plan.tabIds.forEach(function(id) {
        if (id === plan.survivorId) return;
        const row = byId.get(id);
        if (!row) skippedRows.push(skipped({ id: id }, 'Duplicate tab is no longer available.'));
        else if (!survivor) skippedRows.push(skipped(row, 'Selected survivor is no longer available; no duplicates from this group were closed.'));
        else if (survivors.has(id)) skippedRows.push(skipped(row, 'This tab is selected as a survivor in another group.'));
        else if (workspaceId(row) !== workspaceId(survivor)) skippedRows.push(skipped(row, 'Tabs in different workspaces are never merged.'));
        else if (originalUrl(row) !== originalUrl(survivor)) skippedRows.push(skipped(row, 'URL differs from the selected survivor, including query or fragment.'));
        else candidates.add(id);
      });
    });
    // Recheck survivors after preparing the plan; Actions revalidates each closing tab's draft/protection state.
    const freshRows = await gsWorkbench.getTabs();
    const fresh = new Map(freshRows.map(row => [row.id, row]));
    const eligible = [];
    candidates.forEach(function(id) {
      const row = fresh.get(id);
      const owner = plans.find(plan => plan.tabIds.includes(id) && fresh.has(plan.survivorId) && row && workspaceId(fresh.get(plan.survivorId)) === workspaceId(row) && originalUrl(fresh.get(plan.survivorId)) === originalUrl(row));
      if (owner) eligible.push(id);
      else skippedRows.push(skipped(row || { id: id }, 'The survivor or exact duplicate changed before merge; tab kept open.'));
    });
    const result = eligible.length ? await gsWorkbenchActions.perform('close', eligible, {
      reason: 'Duplicate merge', label: 'Merge duplicate tabs',
      guard: async function(row) {
        const latest = await gsWorkbench.getTabs();
        const candidate = latest.find(item => item.id === row.id);
        const reference = fresh.get(row.id);
        if (!candidate || !reference || tabUid(candidate) !== tabUid(reference) || originalUrl(candidate) !== originalUrl(reference) || workspaceId(candidate) !== workspaceId(reference)) {
          return ['Duplicate changed before close; tab kept open.'];
        }
        const validSurvivor = plans.some(function(plan) {
          const survivor = latest.find(item => item.id === plan.survivorId);
          const savedSurvivor = fresh.get(plan.survivorId);
          return plan.tabIds.includes(candidate.id) && survivor && savedSurvivor && tabUid(survivor) === tabUid(savedSurvivor) &&
            originalUrl(survivor) === originalUrl(candidate) && workspaceId(survivor) === workspaceId(candidate);
        });
        return validSurvivor ? [] : ['Selected survivor disappeared or changed before close; duplicate kept open.'];
      }
    }) : emptyAction('close');
    const after = await gsWorkbench.getTabs();
    return Object.assign({}, result, { survivors: Array.from(survivors).filter(id => after.some(row => row.id === id)), skipped: skippedRows.concat(result.skipped || []) });
  }

  async function initAsPromised() {
    if (initialized) return;
    initialized = true;
    const mutations = {
      'workspace.create': createWorkspace, 'workspace.update': updateWorkspace, 'workspace.delete': deleteWorkspace,
      'workspace.assign': assignWorkspace, 'workspace.hibernate': hibernateWorkspace, 'workspace.switch': switchWorkspace,
      'duplicates.merge': mergeDuplicates
    };
    Object.keys(mutations).forEach(function(command) {
      gsWorkbench.register(command, function(payload) { return serialized(() => mutations[command](payload || {})); });
    });
    gsWorkbench.register('duplicates.preview', previewDuplicates);
    gsWorkbench.registerView('duplicates', (tabs, state) => duplicateGroups(tabs, state));
  }

  return {
    initAsPromised: initAsPromised,
    decorateSnapshot: decorateSnapshot,
    snapshot: rowSnapshot
  };
})();
