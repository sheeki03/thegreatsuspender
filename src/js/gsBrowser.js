/* The offscreen engine has DOM access; this boundary owns privileged API IPC. */
var gsBrowser = (() => {
  'use strict';
  const nativeRuntime = chrome.runtime;
  const listeners = new Map();
  let callbackError = null;
  const nativePorts = new Map();
  let manifest;
  let engineReady = false;
  let engineError = null;
  let resolveEngine;
  const initialized = new Promise(resolve => { resolveEngine = resolve; });
  const api = { windows: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 }, tabs: { TAB_ID_NONE: -1 }, extension: {} };

  function event(name) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    const entries = listeners.get(name);
    return { addListener: handler => entries.add(handler), removeListener: handler => entries.delete(handler),
      hasListener: handler => entries.has(handler), hasListeners: () => !!entries.size };
  }
  function request(command, details = {}) {
    return new Promise((resolve, reject) => {
      nativeRuntime.sendMessage({ action: 'browserBroker', command, ...details }, response => {
        const error = nativeRuntime.lastError;
        if (error) reject(new Error(error.message));
        else if (!response || !response.ok) reject(new Error(response && response.error || 'The browser API worker did not respond.'));
        else resolve(response.data);
      });
    });
  }
  function remote(command, details, callback) {
    const result = request(command, details);
    if (callback) {
      result.then(value => { callbackError = null; callback(value); }, error => {
        callbackError = { message: error.message };
        try { callback(undefined); } finally { callbackError = null; }
      });
      return;
    }
    result.catch(error => console.error('Browser API:', error.message));
    return result;
  }
  function namespace(path) {
    return path.split('.').reduce((owner, name) => owner[name] || (owner[name] = {}), api);
  }
  function finishNativePort(id, error) {
    const state = nativePorts.get(id);
    if (!state) return;
    state.closed = true;
    nativePorts.delete(id);
    const previousError = callbackError;
    callbackError = error ? { message: error } : null;
    try {
      for (const handler of Array.from(listeners.get('nativePort.' + id + '.onDisconnect') || [])) handler(state.port);
    } finally {
      callbackError = previousError;
      listeners.delete('nativePort.' + id + '.onMessage');
      listeners.delete('nativePort.' + id + '.onDisconnect');
    }
  }
  function connectNative(hostName) {
    const id = crypto.randomUUID();
    const state = { closed: false, port: null, connected: null };
    const port = {
      name: hostName,
      onMessage: event('nativePort.' + id + '.onMessage'),
      onDisconnect: event('nativePort.' + id + '.onDisconnect'),
      postMessage(message) {
        if (state.closed) throw new Error('The native connection is closed.');
        state.connected.then(() => {
          if (!state.closed) return request('nativePost', { portId: id, message });
        }).catch(error => finishNativePort(id, error.message));
      },
      disconnect() {
        if (state.closed) return;
        state.closed = true;
        nativePorts.delete(id);
        listeners.delete('nativePort.' + id + '.onMessage');
        listeners.delete('nativePort.' + id + '.onDisconnect');
        state.connected.then(() => request('nativeDisconnect', { portId: id })).catch(() => {});
      },
    };
    state.port = port;
    nativePorts.set(id, state);
    state.connected = request('nativeConnect', { portId: id, hostName });
    state.connected.catch(error => finishNativePort(id, error.message));
    return port;
  }
  api.runtime = {
    id: nativeRuntime.id,
    getURL: path => nativeRuntime.getURL(path),
    getManifest: () => manifest,
    sendMessage: (...args) => nativeRuntime.sendMessage(...args),
    connectNative,
    onMessage: event('runtime.onMessage'), onStartup: event('runtime.onStartup'),
    onInstalled: event('runtime.onInstalled'), onUpdateAvailable: event('runtime.onUpdateAvailable'),
  };
  Object.defineProperty(api.runtime, 'lastError', { get: () => callbackError || nativeRuntime.lastError });
  api.runScriptJob = (details, callback) => remote('scriptJob', { details }, callback);
  api.signalReady = error => {
    engineError = error ? error.message || String(error) : null;
    engineReady = !error;
    resolveEngine();
  };
  nativeRuntime.onMessage.addListener((message, sender, respond) => {
    if (!message || sender.id !== nativeRuntime.id) return false;
    if (message.action === 'nativePortEvent') {
      if (message.event === 'disconnect') finishNativePort(message.portId, message.error);
      else if (message.event === 'message' && nativePorts.has(message.portId)) {
        for (const handler of Array.from(listeners.get('nativePort.' + message.portId + '.onMessage') || [])) handler(message.message);
      }
      respond({ ok: true });
      return false;
    }
    if (message.action === 'engineControl' && message.command === 'ready') {
      initialized.then(() => respond(engineReady ? { ok: true } : { ok: false, error: engineError }));
      return true;
    }
    if (message.action !== 'engineEvent') return false;
    const handlers = Array.from(listeners.get(message.event) || []);
    if (message.event === 'runtime.onMessage') {
      let replied = false;
      let pending = false;
      const reply = data => { if (!replied) { replied = true; respond({ ok: true, data }); } };
      try {
        for (const handler of handlers) {
          if (handler(message.args[0], message.args[1], reply) === true) pending = true;
        }
        if (!replied && !pending) reply(undefined);
      } catch (error) { if (!replied) respond({ ok: false, error: error.message || String(error) }); }
      return true;
    }
    Promise.all(handlers.map(handler => Promise.resolve().then(() => handler(...message.args))))
      .then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message || String(error) }));
    return true;
  });
  api.ready = request('initialize').then(capabilities => {
    manifest = capabilities.manifest;
    for (const [path, names] of Object.entries(capabilities.methods)) {
      const owner = namespace(path);
      for (const name of names) owner[name] = (...args) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        return remote('invoke', { method: path + '.' + name, args }, callback);
      };
    }
    for (const name of capabilities.events) {
      const split = name.lastIndexOf('.');
      namespace(name.slice(0, split))[name.slice(split + 1)] = event(name);
    }
    api.extension.inIncognitoContext = capabilities.incognito;
    api.windows.WINDOW_ID_NONE = capabilities.windowIdNone;
    api.windows.WINDOW_ID_CURRENT = capabilities.windowIdCurrent;
    api.tabs.TAB_ID_NONE = capabilities.tabIdNone;
    api.i18n = {
      getUILanguage: () => capabilities.language,
      getMessage: (name, substitutions) => {
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return (capabilities.messages[name] || '').replace(/\{\{GS_SUB_(\d)\}\}/g, (match, index) => values[index] == null ? '' : String(values[index]));
      },
    };
    return api;
  });
  api.ready.catch(api.signalReady);
  return api;
})();
