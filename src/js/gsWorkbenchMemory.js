/*global chrome, gsUtils, gsWorkbench, gsWorkbenchActions */
// eslint-disable-next-line no-unused-vars
var gsWorkbenchMemory = (function() {
  'use strict';

  const HOST_NAME = 'com.sheeki.tab_memory';
  const REQUEST_TIMEOUT_MS = 10000;
  const LEVELS = { 1: 'normal', 2: 'warning', 4: 'critical' };
  const RANKS = { normal: 0, warning: 1, critical: 2 };

  let _initialized = false;
  let _port = null;
  let _pending = null;
  let _generation = 0;
  let _checkPromise = null;
  let _checkGeneration = -1;

  function settings() {
    return gsWorkbench.getState().settings.memory;
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function installationError(detail) {
    return new Error(
      'Memory helper unavailable: ' + String(detail).slice(0, 1000) +
      '. On macOS, run native/install-host.sh --extension-id ' +
      gsBrowser.runtime.id + ' from this extension’s source.' +
      ' Brave on macOS uses ~/Library/Application Support/Google/Chrome/NativeMessagingHosts;' +
      ' --user-data-dir does not redirect that native-host registry. Then choose Check pressure again.'
    );
  }

  function cancelledError() {
    return new Error('The memory check was cancelled because its configuration or connection changed.');
  }

  function updateStatus(values) {
    return gsWorkbench.update(draft => {
      Object.assign(draft.memory, values);
    });
  }

  function settlePending(error, reading) {
    const pending = _pending;
    if (!pending) return;
    _pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(reading);
  }

  function closePort(error) {
    const port = _port;
    _port = null;
    if (_pending) settlePending(error || cancelledError());
    if (port) {
      // Remove identity before disconnect: intentional shutdown is not a
      // missing-host error, and an old port must never reject a new request.
      port.disconnect();
    }
  }

  function invalidateConnection() {
    _generation += 1;
    closePort(cancelledError());
  }

  function validateReading(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Memory helper protocol error: expected a pressure object.');
    }
    if (message.error) {
      const detail = typeof message.error === 'object'
        ? message.error.message || message.error.code
        : message.error;
      throw new Error('Memory helper error: ' + String(detail).slice(0, 1000));
    }
    if (
      !Number.isInteger(message.rawLevel) ||
      !Object.prototype.hasOwnProperty.call(LEVELS, message.rawLevel) ||
      LEVELS[message.rawLevel] !== message.level ||
      !Number.isSafeInteger(message.at) || message.at <= 0
    ) {
      throw new Error('Memory helper protocol error: invalid pressure flag, level or timestamp.');
    }
    return { level: message.level, rawLevel: message.rawLevel, at: message.at };
  }

  function connectPort() {
    if (_port) return _port;
    if (!gsBrowser.runtime || typeof gsBrowser.runtime.connectNative !== 'function') {
      throw new Error('Native messaging is not available. The extension needs the nativeMessaging permission');
    }
    const port = gsBrowser.runtime.connectNative(HOST_NAME);
    _port = port;
    port.onMessage.addListener(message => {
      if (_port !== port) return;
      if (!_pending || _pending.port !== port) {
        const error = new Error('Memory helper protocol error: unsolicited response.');
        closePort(error);
        updateStatus({ connected: false, error: error.message }).catch(e => {
          gsUtils.error('gsWorkbenchMemory', e);
        });
        return;
      }
      try {
        settlePending(null, validateReading(message));
      } catch (error) {
        closePort(error);
      }
    });
    port.onDisconnect.addListener(() => {
      // runtime.lastError is only valid within this callback; always consume
      // it, even when this is an intentionally disconnected, obsolete port.
      const lastError = gsBrowser.runtime.lastError;
      if (_port !== port) return;
      _port = null;
      const error = installationError(
        lastError ? lastError.message : 'The native messaging host disconnected unexpectedly'
      );
      if (_pending && _pending.port === port) {
        settlePending(error);
      } else {
        updateStatus({ connected: false, error: error.message }).catch(e => {
          gsUtils.error('gsWorkbenchMemory', e);
        });
      }
    });
    return port;
  }

  function requestReading() {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = connectPort();
      } catch (error) {
        reject(installationError(errorMessage(error)));
        return;
      }
      const pending = { port, resolve, reject, timer: null };
      _pending = pending;
      pending.timer = setTimeout(() => {
        if (_pending !== pending) return;
        closePort(installationError('The helper did not respond within 10 seconds'));
      }, REQUEST_TIMEOUT_MS);
      try {
        // No tab URLs, titles, tokens, form state or browser metadata are sent.
        port.postMessage({ action: 'memory' });
      } catch (error) {
        closePort(installationError(errorMessage(error)));
      }
    });
  }

  function oldestFirst(a, b) {
    const aTime = a.lastViewedAt === null || a.lastViewedAt === undefined
      ? a.createdAt : a.lastViewedAt;
    const bTime = b.lastViewedAt === null || b.lastViewedAt === undefined
      ? b.createdAt : b.lastViewedAt;
    return (aTime || 0) - (bTime || 0) ||
      a.windowOrdinal - b.windowOrdinal || a.index - b.index || a.id - b.id;
  }

  function awakeTabs(tabs) {
    return tabs.filter(tab => !tab.asleep);
  }

  // Internal handler, deliberately not a message command or an OS reading
  // override. A throwaway proof may supply a structured threshold fixture to
  // this function; only check() writes actual native measurements to state.
  async function handlePressure(message) {
    const reading = validateReading(message);
    const generation = _generation;
    const config = settings();
    const result = {
      triggered: false,
      target: config.target,
      awakeBefore: null,
      awakeAfter: null,
      changed: [],
      skipped: [],
      reason: 'disabled',
    };
    if (!config.enabled) return result;
    if (RANKS[reading.level] < RANKS[config.level]) {
      result.reason = 'below-threshold';
      return result;
    }

    const tabs = awakeTabs(await gsWorkbench.getTabs()).sort(oldestFirst);
    result.awakeBefore = tabs.length;
    result.awakeAfter = tabs.length;
    if (tabs.length <= config.target) {
      result.reason = 'target-met';
      return result;
    }
    const options = {
      reason: 'memory-pressure',
      allowActive: false,
      recordUndo: false,
    };
    const preview = await gsWorkbenchActions.preview(
      'suspend', tabs.map(tab => tab.id), options
    );
    result.triggered = true;
    result.skipped = preview.skipped.slice();
    const candidates = preview.eligible.slice().sort(oldestFirst);
    for (const candidate of candidates) {
      if (generation !== _generation || !settings().enabled) {
        result.reason = 'configuration-changed';
        break;
      }
      // Recount between confirmed actions, not just at preview time. Tabs can
      // be opened, restored or protected while screenshot/suspension awaits.
      const current = awakeTabs(await gsWorkbench.getTabs());
      result.awakeAfter = current.length;
      if (generation !== _generation || !settings().enabled) {
        result.reason = 'configuration-changed';
        break;
      }
      if (current.length <= settings().target) break;
      if (!current.some(tab => tab.id === candidate.id)) continue;
      const action = await gsWorkbenchActions.perform(
        'suspend', [candidate.id], options
      );
      result.changed.push(...action.changed);
      result.skipped.push(...action.skipped);
    }
    result.awakeAfter = awakeTabs(await gsWorkbench.getTabs()).length;
    if (result.reason !== 'configuration-changed') {
      result.reason = result.awakeAfter <= settings().target ? 'target-met' : 'protected-tabs';
    }
    return result;
  }

  async function performCheck(generation) {
    let reading;
    try {
      reading = await requestReading();
      if (generation !== _generation) throw cancelledError();
      await updateStatus({
        connected: true,
        level: reading.level,
        rawLevel: reading.rawLevel,
        checkedAt: reading.at,
        error: null,
      });
    } catch (error) {
      if (generation === _generation) {
        closePort(error);
        // Preserve the last genuine reading, with its timestamp, as stale.
        await updateStatus({ connected: false, error: errorMessage(error) });
      }
      throw error;
    }

    try {
      if (generation !== _generation) throw cancelledError();
      const enforcement = await handlePressure(reading);
      if (generation !== _generation) throw cancelledError();
      return Object.assign({}, reading, { enforcement });
    } catch (error) {
      if (generation === _generation) {
        await updateStatus({
          error: 'Pressure was read successfully, but automatic suspension failed: ' + errorMessage(error),
        });
      }
      throw error;
    } finally {
      // A manual check with automation disabled is a one-shot process, not a
      // hidden persistent helper. Enabled polling reuses the same native port.
      if (generation === _generation && !settings().enabled) {
        closePort();
        await updateStatus({ connected: false });
      }
    }
  }

  async function check() {
    if (_checkPromise && _checkGeneration === _generation) return _checkPromise;
    const generation = _generation;
    const operation = performCheck(generation);
    _checkPromise = operation;
    _checkGeneration = generation;
    try {
      return await operation;
    } finally {
      if (_checkPromise === operation) _checkPromise = null;
    }
  }

  async function reconcile() {
    invalidateConnection();
    await updateStatus({ connected: false, error: null });
    if (settings().enabled) await check();
    return Object.assign({}, settings());
  }

  async function configure(payload) {
    if (!payload || typeof payload.enabled !== 'boolean') {
      throw new Error('Memory automation enabled must be true or false.');
    }
    if (payload.level !== 'warning' && payload.level !== 'critical') {
      throw new Error('Memory pressure threshold must be warning or critical.');
    }
    if (!Number.isSafeInteger(payload.target) || payload.target < 1 || payload.target > 10000) {
      throw new Error('Memory awake-tab target must be an integer from 1 to 10000.');
    }
    const config = {
      enabled: payload.enabled,
      level: payload.level,
      target: payload.target,
    };
    invalidateConnection();
    await gsWorkbench.update(draft => {
      draft.settings.memory = config;
      draft.memory.connected = false;
      draft.memory.error = null;
    });
    if (config.enabled) await check();
    return Object.assign({}, settings());
  }

  async function disconnect() {
    invalidateConnection();
    await gsWorkbench.update(draft => {
      draft.settings.memory.enabled = false;
      draft.memory.connected = false;
      draft.memory.error = null;
    });
    return Object.assign({}, settings());
  }

  async function tick() {
    if (!settings().enabled) {
      if (_port) await reconcile();
      return null;
    }
    try {
      return await check();
    } catch (error) {
      // The actionable error is durably visible in the memory settings UI;
      // alarm-driven failure must not become an unhandled background promise.
      return { error: errorMessage(error) };
    }
  }

  async function initAsPromised() {
    if (_initialized) return;
    gsWorkbench.register('memory.check', check);
    gsWorkbench.register('memory.configure', configure);
    gsWorkbench.register('memory.disconnect', disconnect);
    gsWorkbench.registerTick(tick);
    // A persisted connected flag describes a previous process. Do not start
    // anything during hydration; enabled polling begins at the next core tick.
    if (gsWorkbench.getState().memory.connected) {
      await updateStatus({ connected: false });
    }
    _initialized = true;
  }

  return {
    initAsPromised,
    check,
    configure,
    disconnect,
    reconcile,
    handlePressure,
    hostName: HOST_NAME,
  };
})();
