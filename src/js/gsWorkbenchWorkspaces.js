/*global gsBrowser, crypto, gsWorkbench, gsWorkbenchActions */
'use strict';

// eslint-disable-next-line no-unused-vars
var gsWorkbenchWorkspaces = (function() {
  const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const booleanPolicies = ['ignorePinned', 'ignoreAudio', 'ignoreForms', 'ignoreActive', 'countEnabled'];
  const numberPolicies = ['suspendMinutes', 'awakeLimit', 'awakeTarget'];
  const stopWords = new Set(('a an and are as at be been but by can for from has have how i in is it its me my of on or our that the their them there these they this to was we were what when where which who why will with you your home new page tab untitled http https www com org net').split(' '));
  let initialized = false;
  let operationTail = Promise.resolve();
  const expirySkips = new Map();

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

  function api(namespace, method, args) {
    return new Promise(function(resolve, reject) {
      if (!gsBrowser[namespace] || typeof gsBrowser[namespace][method] !== 'function') {
        reject(new Error('The browser does not support ' + namespace + '.' + method + '. Check browser support and extension permissions.'));
        return;
      }
      try {
        gsBrowser[namespace][method].apply(gsBrowser[namespace], args.concat(function(result) {
          const error = gsBrowser.runtime.lastError;
          if (error) reject(new Error(error.message || String(error)));
          else resolve(result);
        }));
      } catch (error) {
        reject(error);
      }
    });
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

  function deadline(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  function memberUids(descriptor) {
    return Array.isArray(descriptor.memberUids) ? Array.from(new Set(descriptor.memberUids.filter(value => typeof value === 'string' && value))) : [];
  }

  function temporaryInfo(row, state) {
    state = state || gsWorkbench.getState();
    const meta = state.meta[String(row.id)] || {};
    const own = deadline(meta.expiresAt);
    const stableUid = tabUid(row, state);
    const groups = Object.values(state.temporaryGroups).filter(function(descriptor) {
      return stableUid && memberUids(descriptor).includes(stableUid);
    });
    const deadlines = groups.filter(descriptor => !(descriptor.exemptUids || []).includes(stableUid))
      .map(descriptor => deadline(descriptor.expiresAt)).filter(Boolean);
    const groupDeadline = deadlines.length ? Math.min.apply(null, deadlines) : null;
    return {
      expiresAt: own && groupDeadline ? Math.min(own, groupDeadline) : (own || groupDeadline),
      ownExpiresAt: own,
      groupExpiresAt: groupDeadline,
      temporaryGroupIds: groups.map(descriptor => descriptor.id)
    };
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
    const expiry = temporaryInfo(row, state);
    snapshot.meta.expiresAt = expiry.ownExpiresAt;
    snapshot.effectiveExpiresAt = expiry.expiresAt;
    snapshot.temporaryGroups = Object.values(state.temporaryGroups).filter(descriptor => memberUids(descriptor).includes(stableUid)).map(function(descriptor) {
      return {
        id: descriptor.id, expiresAt: descriptor.expiresAt, createdAt: descriptor.createdAt,
        memberUids: memberUids(descriptor), exemptUids: (descriptor.exemptUids || []).slice(),
        exempt: (descriptor.exemptUids || []).includes(stableUid)
      };
    });
    if (snapshot.group && row.groupId >= 0) {
      if (snapshot.group.sourceId === undefined) snapshot.group.sourceId = row.groupId;
      if (!snapshot.group.key) snapshot.group.key = row.windowId + ':' + row.groupId;
      snapshot.group.temporaryId = expiry.temporaryGroupIds[0] || null;
      snapshot.group.temporaryExpiresAt = expiry.groupExpiresAt;
    }
    return snapshot;
  }

  function rowSnapshot(row, state) {
    return decorateSnapshot(copy(gsWorkbench.tabSnapshot(row)), row, state);
  }

  function putSnapshot(target, snapshot) {
    target.members = Array.from(new Set((target.members || []).concat(snapshot.uid)));
    const previous = (target.savedTabs || []).find(item => item.uid === snapshot.uid);
    if (previous && previous.group && snapshot.group && previous.group.title === snapshot.group.title) {
      if (previous.group.bookmarkPath) snapshot.group.bookmarkPath = copy(previous.group.bookmarkPath);
      if (previous.group.bookmarkPathIds) snapshot.group.bookmarkPathIds = copy(previous.group.bookmarkPathIds);
    }
    target.savedTabs = (target.savedTabs || []).filter(item => item.uid !== snapshot.uid).concat(snapshot);
  }

  function saveRows(draft, rows, restoredEntries) {
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
      const snapshot = rowSnapshot(row, draft);
      const origin = restoredEntries && restoredEntries.find(entry => entry.uid === snapshot.uid);
      if (origin && origin.group && snapshot.group && origin.group.title === snapshot.group.title) {
        if (origin.group.bookmarkPath) snapshot.group.bookmarkPath = copy(origin.group.bookmarkPath);
        if (origin.group.bookmarkPathIds) snapshot.group.bookmarkPathIds = copy(origin.group.bookmarkPathIds);
      }
      putSnapshot(target, snapshot);
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
    await gsWorkbench.record('workspace', null, 'Workspace created', { workspaceId: created.id, name: created.name });
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
    await gsWorkbench.record('workspace', null, 'Workspace policy updated', { workspaceId: payload.id, name: updatedName });
    return copy(workspace(payload.id));
  }

  async function assignWorkspace(payload) {
    if (payload.id !== null) workspace(payload.id);
    const requested = tabIds(payload.tabIds, false);
    const selection = selectTabs(await gsWorkbench.getTabs(), requested);
    const changed = [];
    await gsWorkbench.activityBoundary();
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
    await gsWorkbench.activityBoundary();
    await gsWorkbench.refreshTimers();
    await gsWorkbench.record('workspace', null, 'Tabs assigned', { workspaceId: payload.id, tabIds: changed });
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
    await gsWorkbench.activityBoundary();
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
    await gsWorkbench.activityBoundary();
    await gsWorkbench.refreshTimers();
    await gsWorkbench.record('workspace', null, 'Workspace deleted', { workspaceId: current.id, reassignedToId: targetId, archivedId: archivedId });
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
    await gsWorkbench.record('workspace', null, 'Workspace hibernated', { workspaceId: current.id, changed: result.changed.length, skipped: result.skipped.length });
    return Object.assign({}, result, {
      workspace: copy(workspace(current.id)), alreadyAsleep: rows.filter(row => row.asleep).map(row => row.id),
      missing: (workspace(current.id).members || []).filter(member => !after.some(row => tabUid(row) === member)).length
    });
  }

  function savedTemporaryInfo(entry) {
    const own = deadline(entry.meta && entry.meta.expiresAt);
    const descriptors = Array.isArray(entry.temporaryGroups) ? entry.temporaryGroups : null;
    const expiries = descriptors ? descriptors.filter(function(descriptor) {
      return !descriptor.exempt && !(descriptor.exemptUids || []).includes(entry.uid) &&
        !(entry.sourceUid && (descriptor.exemptUids || []).includes(entry.sourceUid));
    }).map(descriptor => deadline(descriptor.expiresAt)).filter(Boolean) :
      [deadline(entry.group && entry.group.temporaryExpiresAt)].filter(Boolean);
    const group = expiries.length ? Math.min.apply(null, expiries) : null;
    return { ownExpiresAt: own, groupExpiresAt: group, expiresAt: own && group ? Math.min(own, group) : (own || group) };
  }

  function normalizeTemporaryGroups(state) {
    const groups = Object.create(null);
    let legacyEntries = null;
    Object.keys(state.temporaryGroups).forEach(function(key) {
      const source = state.temporaryGroups[key];
      if (!source || !deadline(source.expiresAt)) return;
      const id = typeof source.id === 'string' && source.id ? source.id : 'temporary:' + key;
      const members = memberUids(source);
      const exemptions = Array.isArray(source.exemptUids) ? source.exemptUids.filter(value => typeof value === 'string' && value) : [];
      if (!Array.isArray(source.memberUids)) {
        // Legacy numeric IDs are never evidence by themselves. Recover identity
        // only from a saved rule with the same deadline and source organization.
        if (!legacyEntries) {
          legacyEntries = state.workspaces.flatMap(item => item.savedTabs || [])
            .concat(state.archive.flatMap(item => item.tabs || []), state.snapshots.flatMap(item => item.tabs || []));
          Object.values(state.meta).forEach(function(meta) {
            if (meta.group) legacyEntries.push({ uid: meta.uid, group: meta.group });
          });
          if (state.undo) (state.undo.entries || []).forEach(function(item) {
            if (item.before) legacyEntries.push(item.before);
          });
        }
        legacyEntries.forEach(function(entry) {
          const group = entry.group;
          if (!entry.uid || !group || String(group.sourceId) !== key) return;
          const sameWindow = source.windowId == null || entry.windowId === source.windowId ||
            group.key === source.windowId + ':' + key;
          if (sameWindow && (deadline(group.temporaryExpiresAt) === source.expiresAt || exemptions.includes(entry.uid))) members.push(entry.uid);
        });
      }
      const descriptor = {
        id: id, expiresAt: source.expiresAt, createdAt: deadline(source.createdAt) || 0,
        memberUids: Array.from(new Set(members.concat(exemptions))),
        exemptUids: Array.from(new Set(exemptions)), bindings: []
      };
      if (groups[id]) {
        descriptor.expiresAt = Math.min(descriptor.expiresAt, groups[id].expiresAt);
        descriptor.memberUids = Array.from(new Set(descriptor.memberUids.concat(groups[id].memberUids)));
        descriptor.exemptUids = Array.from(new Set(descriptor.exemptUids.concat(groups[id].exemptUids)));
      }
      groups[id] = descriptor;
    });
    return groups;
  }

  function reboundTemporaryState(state, entries, rows, options) {
    const groups = normalizeTemporaryGroups(state);
    const live = rows.filter(row => !row.incognito && state.meta[String(row.id)] &&
      state.meta[String(row.id)].uid === tabUid(row, state));
    const byUid = new Map(live.map(row => [tabUid(row, state), row]));
    const metaExpiries = new Map();
    const expiredExemptions = [];
    const now = Date.now();
    entries.forEach(function(entry) {
      const row = byUid.get(entry.uid);
      if (!row || originalUrl(row) !== (entry.originalUrl || entry.meta && entry.meta.url || entry.url)) return;
      const saved = savedTemporaryInfo(entry);
      const exemptOwn = options.exemptExpired && saved.ownExpiresAt && saved.ownExpiresAt <= now;
      metaExpiries.set(row.id, exemptOwn ? null : saved.ownExpiresAt);
      let descriptors = Array.isArray(entry.temporaryGroups) ? entry.temporaryGroups : null;
      if (!descriptors) {
        const group = entry.group;
        const expiry = deadline(group && group.temporaryExpiresAt);
        if (expiry) {
          const id = group.temporaryId || 'saved:' + (group.key || entry.windowId + ':' + group.sourceId) + ':' + expiry;
          descriptors = [{ id: id, expiresAt: expiry, createdAt: 0, exemptUids: [] }];
        } else if (group && group.temporaryId && groups[group.temporaryId]) {
          descriptors = [Object.assign({}, groups[group.temporaryId], { exempt: true })];
        } else descriptors = [];
      }
      const restoredIds = new Set(descriptors.filter(descriptor => deadline(descriptor.expiresAt)).map(descriptor => descriptor.id));
      Object.values(groups).forEach(function(descriptor) {
        if (!descriptor.memberUids.includes(entry.uid)) return;
        if (!restoredIds.has(descriptor.id)) {
          // A snapshot from before this rule existed explicitly keeps this
          // restored tab exempt, even if it still shares the native group.
          descriptor.exemptUids = Array.from(new Set(descriptor.exemptUids.concat(entry.uid)));
        }
      });
      descriptors.forEach(function(source) {
        if (!deadline(source.expiresAt) || typeof source.id !== 'string' || !source.id) return;
        let descriptor = groups[source.id];
        if (!descriptor) {
          descriptor = groups[source.id] = {
            id: source.id, expiresAt: source.expiresAt, createdAt: deadline(source.createdAt) || 0,
            memberUids: [], exemptUids: [], bindings: []
          };
        }
        descriptor.memberUids = Array.from(new Set(descriptor.memberUids.concat(entry.uid)));
        const restoredExempt = source.exempt || (source.exemptUids || []).includes(entry.uid) ||
          (entry.sourceUid && (source.exemptUids || []).includes(entry.sourceUid));
        const exemptGroup = options.exemptExpired && descriptor.expiresAt <= now;
        descriptor.exemptUids = descriptor.exemptUids.filter(value => value !== entry.uid);
        if (restoredExempt || exemptGroup) descriptor.exemptUids.push(entry.uid);
      });
      if (exemptOwn || options.exemptExpired && saved.groupExpiresAt && saved.groupExpiresAt <= now) {
        expiredExemptions.push({ uid: entry.uid, ownExpiresAt: saved.ownExpiresAt, groupExpiresAt: saved.groupExpiresAt });
      }
    });
    const owner = new Map();
    Object.values(groups).sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id)).forEach(function(descriptor) {
      descriptor.memberUids = descriptor.memberUids.filter(function(stableUid) {
        const previous = owner.get(stableUid);
        if (!previous) {
          owner.set(stableUid, descriptor);
          return true;
        }
        if (previous.exemptUids.includes(stableUid) && !descriptor.exemptUids.includes(stableUid)) {
          previous.memberUids = previous.memberUids.filter(value => value !== stableUid);
          previous.exemptUids = previous.exemptUids.filter(value => value !== stableUid);
          owner.set(stableUid, descriptor);
          return true;
        }
        return false;
      });
    });
    const nativeMembers = new Map();
    live.filter(row => row.groupId >= 0).forEach(function(row) {
      const key = row.windowId + ':' + row.groupId;
      if (!nativeMembers.has(key)) nativeMembers.set(key, []);
      nativeMembers.get(key).push(row);
    });
    Object.values(groups).forEach(function(descriptor) {
      nativeMembers.forEach(function(members) {
        if (!members.some(row => descriptor.memberUids.includes(tabUid(row, state)))) return;
        descriptor.bindings.push({ groupId: members[0].groupId, windowId: members[0].windowId });
        members.forEach(function(row) {
          const stableUid = tabUid(row, state);
          if (!owner.has(stableUid)) {
            descriptor.memberUids.push(stableUid);
            owner.set(stableUid, descriptor);
          }
        });
      });
      descriptor.memberUids.sort();
      descriptor.exemptUids = descriptor.exemptUids.filter(value => descriptor.memberUids.includes(value)).sort();
      descriptor.bindings.sort((a, b) => a.windowId - b.windowId || a.groupId - b.groupId);
    });
    return { groups: groups, metaExpiries: metaExpiries, expiredExemptions: expiredExemptions };
  }

  async function rebindTemporaryGroups(entries, rows, options) {
    entries = entries || [];
    options = options || {};
    if (!Array.isArray(entries) || !Array.isArray(rows)) throw new Error('Temporary expiry recovery requires saved entries and live tab rows.');
    const current = gsWorkbench.getState();
    const next = reboundTemporaryState(current, entries, rows, options);
    const changed = JSON.stringify(current.temporaryGroups) !== JSON.stringify(next.groups) ||
      Array.from(next.metaExpiries).some(([id, expiry]) => deadline(current.meta[String(id)].expiresAt) !== expiry);
    let applied = next;
    if (changed) {
      await gsWorkbench.update(function(draft) {
        applied = reboundTemporaryState(draft, entries, rows, options);
        draft.temporaryGroups = applied.groups;
        applied.metaExpiries.forEach(function(expiry, id) { draft.meta[String(id)].expiresAt = expiry; });
        saveRows(draft, rows);
      });
    }
    if (applied.expiredExemptions.length) {
      await gsWorkbench.record('workspace', null, 'Expired entries intentionally restored without rescheduling expiry', { exemptions: applied.expiredExemptions });
    }
    return {
      changed: changed,
      reboundGroups: Object.values(applied.groups).reduce((total, descriptor) => total + descriptor.bindings.length, 0),
      expiredExemptions: applied.expiredExemptions
    };
  }

  async function switchWorkspace(payload) {
    const current = workspace(payload.id);
    let rows = await gsWorkbench.getTabs();
    await rebindTemporaryGroups([], rows);
    await gsWorkbench.update(function(draft) { saveRows(draft, rows); });
    const target = workspace(current.id);
    const openUids = new Set(rows.map(row => tabUid(row)));
    const restorationSkips = [];
    const now = Date.now();
    const missing = (target.savedTabs || []).filter(function(entry) {
      if (openUids.has(entry.uid)) return false;
      const expiresAt = savedTemporaryInfo(entry).expiresAt;
      if (expiresAt && expiresAt <= now) {
        restorationSkips.push(skipped({ uid: entry.uid, title: entry.title, originalUrl: entry.originalUrl }, 'Saved temporary member has expired; snapshot is retained, but workspace switching does not reopen it.'));
        return false;
      }
      return true;
    });
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
    await rebindTemporaryGroups([], rows);
    const targetRows = rows.filter(row => workspaceId(row) === target.id);
    missing.forEach(function(entry) {
      if (!targetRows.some(row => tabUid(row) === entry.uid) && !errors.some(error => error.entry && error.entry.uid === entry.uid)) {
        errors.push({ entry: entry, reasons: ['Workspace member could not be reopened; its saved snapshot is retained.'] });
      }
    });
    const sleepingTarget = targetRows.filter(function(row) {
      if (!row.asleep) return false;
      const expiry = temporaryInfo(row).expiresAt;
      if (expiry && expiry <= Date.now()) {
        restorationSkips.push(skipped(row, 'Temporary workspace member is overdue; it was kept asleep rather than awakened for automatic archival.'));
        return false;
      }
      return true;
    }).map(row => row.id);
    const awakened = sleepingTarget.length ? await gsWorkbenchActions.perform('restore', sleepingTarget, {
      reason: 'Workspace switch', label: 'Wake ' + target.name, recordUndo: false
    }) : emptyAction('restore');
    rows = await gsWorkbench.getTabs();
    if ((target.savedTabs || []).length && !rows.some(row => workspaceId(row) === target.id && !row.asleep)) {
      errors.push({ reasons: ['No target workspace member could be made awake; other workspaces were left unchanged.'] });
      return { workspace: copy(workspace(target.id)), switched: false, hibernated: [], restored: Array.from(restored), awakened: awakened, skipped: restorationSkips.concat(awakened.skipped || []), errors: errors };
    }
    const outgoing = rows.filter(row => workspaceId(row) && workspaceId(row) !== target.id && !row.asleep);
    await gsWorkbench.update(function(draft) {
      saveRows(draft, rows, missing);
      draft.currentWorkspaceId = target.id;
      workspace(target.id, draft).hibernated = false;
    });
    const suspended = outgoing.length ? await gsWorkbenchActions.perform('suspend', outgoing.map(row => row.id), {
      reason: 'Workspace switch', label: 'Switch to ' + target.name, allowActive: true
    }) : emptyAction('suspend');
    const after = await gsWorkbench.getTabs();
    const hibernated = [];
    await gsWorkbench.update(function(draft) {
      saveRows(draft, after, missing);
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
    await gsWorkbench.record('workspace', null, 'Workspace switched', { workspaceId: target.id, restored: restored.length, suspended: suspended.changed.length, skipped: (suspended.skipped || []).length });
    return {
      workspace: copy(workspace(target.id)), switched: true, hibernated: hibernated, restored: Array.from(restored), awakened: awakened,
      action: 'suspend', changed: suspended.changed, operationId: suspended.operationId,
      skipped: restorationSkips.concat(awakened.skipped || [], suspended.skipped || []), errors: errors
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

  async function keepInbox(payload) {
    const selection = selectTabs(await gsWorkbench.getTabs(), tabIds(payload.tabIds, false));
    const reviewedAt = Date.now();
    const changed = [];
    await gsWorkbench.update(function(draft) {
      selection.tabs.forEach(function(row) {
        const meta = draft.meta[String(row.id)];
        if (!meta) selection.skipped.push(skipped(row, 'Tab metadata is unavailable.'));
        else {
          meta.reviewedAt = reviewedAt;
          changed.push(row.id);
        }
      });
      saveRows(draft, selection.tabs);
    });
    return { changed: changed, skipped: selection.skipped, reviewedAt: reviewedAt };
  }

  function colorFor(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    return colors[1 + (Math.abs(hash) % (colors.length - 1))];
  }

  function titleWords(title) {
    const found = String(title || '').match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) || [];
    const seen = new Set();
    return found.map(function(label) {
      return { label: label, key: label.normalize('NFKC').toLowerCase().replace(/^[.-]+|[.-]+$/g, '') };
    }).filter(function(word) {
      if (word.key.length < 2 || stopWords.has(word.key) || /^\d+$/.test(word.key) || seen.has(word.key)) return false;
      seen.add(word.key);
      return true;
    });
  }

  function domainOf(row) {
    if (row.domain) return row.domain;
    try {
      const parsed = new URL(originalUrl(row));
      return parsed.hostname || (parsed.protocol === 'file:' ? 'Local files' : parsed.protocol.replace(':', '') + ' pages');
    } catch (error) {
      return 'Other pages';
    }
  }

  function groupingPlan(tabs, requested, mode) {
    if (mode !== 'domain' && mode !== 'topic') throw new Error('Grouping mode must be domain or topic. Topic grouping uses local title keywords, not AI.');
    const selection = selectTabs(tabs, requested);
    const partitions = new Map();
    selection.tabs.forEach(function(row) {
      if (row.pinned) {
        selection.skipped.push(skipped(row, 'Pinned tabs cannot join native tab groups.'));
        return;
      }
      const key = JSON.stringify([row.windowId, workspaceId(row)]);
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push(row);
    });
    const groups = [];
    partitions.forEach(function(rows) {
      const words = new Map();
      const frequency = new Map();
      if (mode === 'topic') rows.forEach(function(row) {
        const tokens = titleWords(row.title);
        words.set(row.id, tokens);
        tokens.forEach(word => frequency.set(word.key, (frequency.get(word.key) || 0) + 1));
      });
      const buckets = new Map();
      rows.forEach(function(row) {
        let title;
        let key;
        if (mode === 'domain') {
          title = domainOf(row);
          key = title.toLowerCase();
        } else {
          const tokens = words.get(row.id);
          const ranked = tokens.map((word, index) => ({ word: word, index: index, count: frequency.get(word.key) })).sort((a, b) => b.count - a.count || a.index - b.index || a.word.key.localeCompare(b.word.key));
          const selected = ranked.length ? ranked[0].word : null;
          key = selected ? selected.key : 'other titles';
          title = selected ? selected.label : 'Other titles';
          if (title === title.toLowerCase()) title = title.charAt(0).toUpperCase() + title.slice(1);
        }
        if (!buckets.has(key)) buckets.set(key, { title: title, color: colorFor(key), windowId: row.windowId, workspaceId: workspaceId(row), tabIds: [] });
        buckets.get(key).tabIds.push(row.id);
      });
      buckets.forEach(group => groups.push(group));
    });
    return { mode: mode, basis: mode === 'topic' ? 'local title keywords' : 'domain', groups: groups, skipped: selection.skipped };
  }

  async function previewGroups(payload) {
    return groupingPlan(await gsWorkbench.getTabs(), tabIds(payload.tabIds, false), payload.mode);
  }

  async function applyGroups(payload) {
    if (!gsBrowser.tabs || typeof gsBrowser.tabs.group !== 'function' || !gsBrowser.tabGroups || typeof gsBrowser.tabGroups.update !== 'function') {
      throw new Error('Native tab grouping is unavailable. Check tabGroups permission and browser support.');
    }
    const plan = await previewGroups(payload);
    const applied = [];
    const changed = [];
    const errors = [];
    for (const group of plan.groups) {
      let nativeId;
      try {
        nativeId = await api('tabs', 'group', [{ tabIds: group.tabIds, createProperties: { windowId: group.windowId } }]);
        changed.push.apply(changed, group.tabIds);
        const nativeGroup = await api('tabGroups', 'update', [nativeId, { title: group.title, color: group.color, collapsed: false }]);
        applied.push(Object.assign({}, group, { id: nativeId, nativeGroup: nativeGroup }));
        await gsWorkbench.record('grouped', null, plan.basis, { groupId: nativeId, title: group.title, tabIds: group.tabIds, workspaceId: group.workspaceId });
      } catch (error) {
        errors.push({ group: Object.assign({}, group, nativeId === undefined ? {} : { id: nativeId }), reasons: [errorText(error)] });
      }
    }
    const after = await gsWorkbench.getTabs();
    await rebindTemporaryGroups([], after);
    await gsWorkbench.update(function(draft) { saveRows(draft, after.filter(row => changed.includes(row.id))); });
    gsWorkbench.notify();
    return { mode: plan.mode, basis: plan.basis, groups: applied, changed: changed, skipped: plan.skipped, errors: errors };
  }

  async function setTemporary(payload) {
    if (!deadline(payload.until)) throw new Error('Temporary tabs require a valid expiry timestamp.');
    const hasGroup = payload.groupId !== undefined && payload.groupId !== null;
    if (hasGroup && (!Number.isInteger(payload.groupId) || payload.groupId < 0)) throw new Error('Select an existing native tab group.');
    const requested = tabIds(payload.tabIds === undefined && hasGroup ? [] : payload.tabIds, hasGroup);
    const rows = await gsWorkbench.getTabs();
    const selection = selectTabs(rows, requested);
    let nativeGroup = null;
    let groupRows = [];
    if (hasGroup) {
      nativeGroup = await api('tabGroups', 'get', [payload.groupId]);
      groupRows = rows.filter(row => row.groupId === payload.groupId && row.windowId === nativeGroup.windowId);
      if (!groupRows.length) throw new Error('The selected group has no normal, non-incognito managed tabs.');
    }
    const groupIds = new Set(groupRows.map(row => row.id));
    const changed = [];
    const temporaryId = hasGroup ? uid() : null;
    await gsWorkbench.update(function(draft) {
      if (hasGroup) {
        const members = groupRows.map(row => tabUid(row, draft)).filter(Boolean);
        if (members.length !== groupRows.length) throw new Error('The selected group has members without durable metadata; refresh before scheduling expiry.');
        Object.keys(draft.temporaryGroups).forEach(function(key) {
          const descriptor = draft.temporaryGroups[key];
          const previousMembers = memberUids(descriptor);
          descriptor.memberUids = previousMembers.filter(value => !members.includes(value));
          descriptor.exemptUids = (descriptor.exemptUids || []).filter(value => !members.includes(value));
          if (previousMembers.length && !descriptor.memberUids.length) delete draft.temporaryGroups[key];
        });
        draft.temporaryGroups[temporaryId] = {
          id: temporaryId, expiresAt: payload.until, createdAt: Date.now(), memberUids: members, exemptUids: [],
          bindings: [{ groupId: payload.groupId, windowId: nativeGroup.windowId }]
        };
      }
      selection.tabs.forEach(function(row) {
        if (groupIds.has(row.id)) return;
        const meta = draft.meta[String(row.id)];
        if (meta && meta.uid === tabUid(row, draft)) {
          meta.expiresAt = payload.until;
          changed.push(row.id);
          expirySkips.delete(meta.uid);
        } else selection.skipped.push(skipped(row, 'Tab metadata is unavailable.'));
      });
      groupRows.forEach(function(row) {
        const meta = draft.meta[String(row.id)];
        if (!meta || meta.uid !== tabUid(row, draft)) {
          selection.skipped.push(skipped(row, 'Group member changed before expiry could be scheduled.'));
          return;
        }
        meta.expiresAt = null;
        changed.push(row.id);
        expirySkips.delete(meta.uid);
      });
      saveRows(draft, selection.tabs.concat(groupRows));
    });
    await gsWorkbench.record('workspace', null, 'Temporary expiry scheduled', { tabIds: changed, groupId: hasGroup ? payload.groupId : null, expiresAt: payload.until });
    return { changed: Array.from(new Set(changed)), skipped: selection.skipped, groupId: hasGroup ? payload.groupId : null, expiresAt: payload.until };
  }

  async function clearTemporary(payload) {
    const groupScope = payload.scope === 'group';
    if (payload.scope !== undefined && payload.scope !== 'tab' && !groupScope) throw new Error('Temporary expiry scope must be tab or group.');
    const rows = await gsWorkbench.getTabs();
    await rebindTemporaryGroups([], rows);
    const hasGroup = groupScope && payload.groupId !== undefined && payload.groupId !== null;
    if (hasGroup && (!Number.isInteger(payload.groupId) || payload.groupId < 0)) throw new Error('Select an existing native tab group.');
    const selection = selectTabs(rows, tabIds(payload.tabIds === undefined && hasGroup ? [] : payload.tabIds, hasGroup));
    const nativeKeys = new Set(selection.tabs.filter(row => row.groupId >= 0).map(row => row.windowId + ':' + row.groupId));
    if (hasGroup) {
      const nativeGroup = await api('tabGroups', 'get', [payload.groupId]);
      nativeKeys.add(nativeGroup.windowId + ':' + payload.groupId);
    }
    const selectedRows = groupScope ? rows.filter(row => selection.tabs.includes(row) || nativeKeys.has(row.windowId + ':' + row.groupId)) : selection.tabs;
    const affectedUids = new Set(selectedRows.map(row => tabUid(row)));
    const clearedGroups = [];
    const changed = [];
    await gsWorkbench.update(function(draft) {
      Object.keys(draft.temporaryGroups).forEach(function(key) {
        const descriptor = draft.temporaryGroups[key];
        const members = memberUids(descriptor);
        if (!members.some(value => affectedUids.has(value))) return;
        if (groupScope) {
          members.forEach(value => affectedUids.add(value));
          clearedGroups.push(descriptor.id);
          delete draft.temporaryGroups[key];
        } else {
          descriptor.exemptUids = Array.from(new Set((descriptor.exemptUids || []).concat(members.filter(value => affectedUids.has(value)))));
        }
      });
      Object.keys(draft.meta).forEach(function(id) {
        const meta = draft.meta[id];
        if (!affectedUids.has(meta.uid)) return;
        meta.expiresAt = null;
        expirySkips.delete(meta.uid);
        const row = rows.find(item => String(item.id) === id && tabUid(item, draft) === meta.uid);
        if (row) changed.push(row.id);
      });
      if (groupScope) draft.workspaces.forEach(function(item) {
        (item.savedTabs || []).forEach(function(entry) {
          if (!affectedUids.has(entry.uid)) return;
          if (entry.meta) entry.meta.expiresAt = null;
          entry.effectiveExpiresAt = null;
          entry.temporaryGroups = [];
          if (entry.group) {
            entry.group.temporaryId = null;
            entry.group.temporaryExpiresAt = null;
          }
        });
      });
      saveRows(draft, rows.filter(row => affectedUids.has(tabUid(row, draft))));
    });
    return { changed: changed, skipped: selection.skipped, clearedTemporaryGroupIds: clearedGroups, memberUids: Array.from(affectedUids) };
  }

  function temporaryView(tabs, state, now) {
    return tabs.map(function(row) {
      const info = temporaryInfo(row, state);
      if (!info.expiresAt) return null;
      const overdue = info.expiresAt <= now;
      const currentReasons = overdue ? gsWorkbench.getProtectionReasonsSync(row, 'archive') : [];
      const previous = expirySkips.get(tabUid(row, state));
      const reasons = overdue ? Array.from(new Set(currentReasons.concat(previous ? previous.reasons : []))) : [];
      return Object.assign({}, row, info, { overdue: overdue, reasons: reasons });
    }).filter(Boolean).sort((a, b) => a.expiresAt - b.expiresAt || a.id - b.id);
  }

  async function runDueWork(now) {
    const rows = await gsWorkbench.getTabs();
    await rebindTemporaryGroups([], rows);
    const state = gsWorkbench.getState();
    const due = rows.filter(row => {
      const expiry = temporaryInfo(row, state).expiresAt;
      return expiry && expiry <= now;
    });
    if (!due.length) return emptyAction('archive');
    // Save effective deadlines in workspace snapshots without converting a group rule into an individual rule.
    await gsWorkbench.update(function(draft) {
      due.forEach(function(row) {
        expirySkips.delete(tabUid(row, draft));
      });
      saveRows(draft, due);
    });
    const result = await gsWorkbenchActions.perform('archive', due.map(row => row.id), { reason: 'Temporary expiry', label: 'Expired temporary tabs' });
    (result.skipped || []).forEach(function(row) {
      const stableUid = tabUid(row);
      if (stableUid) expirySkips.set(stableUid, { at: now, reasons: row.reasons || ['Expiry was skipped to keep this tab safe.'] });
    });
    if ((result.skipped || []).length) gsWorkbench.notify();
    return result;
  }

  async function bookmarkTree() {
    return { tree: await api('bookmarks', 'getTree', []) };
  }

  function bookmarkUrl(value) {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:', 'file:'].includes(parsed.protocol);
    } catch (error) {
      return false;
    }
  }

  async function importBookmarks(payload) {
    if (typeof payload.folderId !== 'string' && typeof payload.folderId !== 'number') throw new Error('Select a bookmark folder.');
    const roots = await api('bookmarks', 'getSubTree', [String(payload.folderId)]);
    const root = roots && roots[0];
    if (!root || root.url) throw new Error('The selected bookmark item is not a folder.');
    const createdAt = Date.now();
    const created = {
      id: uid(), name: payload.name === undefined ? name(root.title || 'Imported bookmarks') : name(payload.name), color: 'blue',
      policy: {}, members: [], savedTabs: [], hibernated: true, createdAt: createdAt
    };
    const skippedEntries = [];
    const importedGroups = new Map();
    function walk(folder, path, pathIds) {
      (folder.children || []).forEach(function(node) {
        if (!node.url) {
          walk(node, path.concat(node.title || 'Untitled folder'), pathIds.concat(String(node.id)));
          return;
        }
        if (!bookmarkUrl(node.url)) {
          skippedEntries.push({ id: node.id, title: node.title, url: node.url, reasons: ['Only HTTP, HTTPS, and local-file bookmark pages can be restored as workspace tabs; unsupported URLs and bookmarklets were not imported.'] });
          return;
        }
        const stableUid = uid();
        const index = created.savedTabs.length;
        const groupTitle = path.length ? path.join(' / ') : (root.title || created.name);
        const groupKey = 'bookmark:' + folder.id;
        const group = { title: groupTitle, color: colorFor(groupKey), collapsed: false, sourceId: groupKey, key: groupKey, bookmarkPath: path.slice(), bookmarkPathIds: pathIds.slice() };
        importedGroups.set(groupKey, { title: groupTitle, color: group.color, tabCount: (importedGroups.get(groupKey) || { tabCount: 0 }).tabCount + 1 });
        const meta = {
          uid: stableUid, url: node.url, title: node.title || node.url, windowOrdinal: 0, index: index,
          workspaceId: created.id, createdAt: createdAt, lastViewedAt: null, reviewedAt: null, visitCount: 0,
          isNew: false, dirty: false, snooze: null, protection: null, expiresAt: null, suspendedAt: null, sleepMs: 0
        };
        created.members.push(stableUid);
        created.savedTabs.push({
          uid: stableUid, tabId: null, title: meta.title, originalUrl: node.url, url: node.url,
          windowId: null, windowOrdinal: 0, index: index, pinned: false, active: false, asleep: false, status: 'awake',
          workspaceId: created.id, group: group, meta: meta
        });
      });
    }
    walk(root, [], []);
    const groupOrder = new Map(Array.from(importedGroups.keys()).map((key, index) => [key, index]));
    created.savedTabs.sort((a, b) => groupOrder.get(a.group.key) - groupOrder.get(b.group.key) || a.index - b.index);
    created.savedTabs.forEach(function(entry, index) {
      entry.index = index;
      entry.meta.index = index;
    });
    await gsWorkbench.update(function(draft) { draft.workspaces.push(created); });
    await gsWorkbench.record('workspace', null, 'Bookmark folder imported', { workspaceId: created.id, folderId: root.id, imported: created.savedTabs.length, skipped: skippedEntries.length });
    return { workspace: copy(workspace(created.id)), imported: created.savedTabs.length, groups: Array.from(importedGroups.values()), skipped: skippedEntries };
  }

  async function exportBookmarks(payload) {
    const current = workspace(payload.id);
    const rows = (await gsWorkbench.getTabs()).filter(row => workspaceId(row) === current.id);
    await gsWorkbench.update(function(draft) { saveRows(draft, rows); });
    const target = workspace(current.id);
    const title = payload.name === undefined ? target.name : name(payload.name);
    const details = { title: title };
    if (payload.parentId !== undefined && payload.parentId !== null && payload.parentId !== '') {
      const parents = await api('bookmarks', 'get', [String(payload.parentId)]);
      if (!parents || !parents[0] || parents[0].url) throw new Error('Choose a bookmark folder as the export destination.');
      details.parentId = String(payload.parentId);
    }
    const folder = await api('bookmarks', 'create', [details]);
    const folders = new Map();
    const skippedEntries = [];
    const errors = [];
    let createdCount = 0;
    const entries = (target.savedTabs || []).slice().sort((a, b) => a.windowOrdinal - b.windowOrdinal || a.index - b.index);
    for (const entry of entries) {
      const url = entry.originalUrl || (entry.meta && entry.meta.url) || entry.url;
      if (!bookmarkUrl(url)) {
        skippedEntries.push({ uid: entry.uid, title: entry.title, url: url, reasons: ['Only HTTP, HTTPS, and local-file tab URLs can be exported from a restorable workspace.'] });
        continue;
      }
      try {
        let parentId = folder.id;
        if (entry.group) {
          const imported = Array.isArray(entry.group.bookmarkPath);
          const path = imported ? entry.group.bookmarkPath : [entry.group.title || 'Untitled group'];
          const keys = imported ? (entry.group.bookmarkPathIds || path) : [entry.group.key || entry.group.sourceId || entry.group.id || entry.group.title || 'Untitled group'];
          for (let index = 0; index < path.length; index++) {
            const key = JSON.stringify([parentId, String(keys[index] === undefined ? path[index] : keys[index])]);
            if (!folders.has(key)) {
              const child = await api('bookmarks', 'create', [{ parentId: parentId, title: String(path[index]) || 'Untitled folder' }]);
              folders.set(key, child.id);
            }
            parentId = folders.get(key);
          }
        }
        await api('bookmarks', 'create', [{ parentId: parentId, title: entry.title || url, url: url }]);
        createdCount++;
      } catch (error) {
        errors.push({ entry: entry, reasons: [errorText(error)] });
      }
    }
    await gsWorkbench.record('workspace', null, 'Workspace exported to bookmarks', { workspaceId: target.id, folderId: folder.id, created: createdCount, skipped: skippedEntries.length, errors: errors.length });
    return { folder: folder, created: createdCount, skipped: skippedEntries, errors: errors };
  }

  async function initAsPromised() {
    if (initialized) return;
    initialized = true;
    const mutations = {
      'workspace.create': createWorkspace, 'workspace.update': updateWorkspace, 'workspace.delete': deleteWorkspace,
      'workspace.assign': assignWorkspace, 'workspace.hibernate': hibernateWorkspace, 'workspace.switch': switchWorkspace,
      'duplicates.merge': mergeDuplicates, 'inbox.keep': keepInbox, 'group.apply': applyGroups,
      'temporary.set': setTemporary, 'temporary.clear': clearTemporary,
      'bookmarks.import': importBookmarks, 'bookmarks.export': exportBookmarks
    };
    Object.keys(mutations).forEach(function(command) {
      gsWorkbench.register(command, function(payload) { return serialized(() => mutations[command](payload || {})); });
    });
    gsWorkbench.register('duplicates.preview', previewDuplicates);
    gsWorkbench.register('group.preview', previewGroups);
    gsWorkbench.register('bookmarks.tree', bookmarkTree);
    gsWorkbench.registerTick(now => serialized(() => runDueWork(now)));
    gsWorkbench.registerView('duplicates', (tabs, state) => duplicateGroups(tabs, state));
    gsWorkbench.registerView('inbox', tabs => tabs.filter(row => row.isNew && !row.reviewedAt && (row.visitCount || 0) < 2));
    gsWorkbench.registerView('temporary', temporaryView);
    gsWorkbench.registerStartup(async function() {
      await rebindTemporaryGroups([], await gsWorkbench.getTabs());
    });
    gsBrowser.tabGroups.onRemoved.addListener(function(group) {
      serialized(async function() {
        if (!gsWorkbench.isReady()) return;
        const state = gsWorkbench.getState();
        if (!Object.values(state.temporaryGroups).some(descriptor => (descriptor.bindings || []).some(binding => binding.groupId === group.id && binding.windowId === group.windowId))) return;
        await gsWorkbench.update(function(draft) {
          Object.values(draft.temporaryGroups).forEach(function(descriptor) {
            descriptor.bindings = (descriptor.bindings || []).filter(binding => binding.groupId !== group.id || binding.windowId !== group.windowId);
          });
        });
      }).catch(function(error) {
        console.warn('Unable to detach removed native group metadata:', errorText(error));
      });
    });
    await rebindTemporaryGroups([], await gsWorkbench.getTabs());
  }

  return {
    initAsPromised: initAsPromised,
    getTemporaryInfo: temporaryInfo,
    getSavedTemporaryInfo: savedTemporaryInfo,
    decorateSnapshot: decorateSnapshot,
    snapshot: rowSnapshot,
    rebindTemporaryGroups: rebindTemporaryGroups
  };
})();
