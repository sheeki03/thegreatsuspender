'use strict';
importScripts('js/injectionJobs.js');

const ENGINE_URL = chrome.runtime.getURL('engine.html');
const isPrivate = !!chrome.extension.inIncognitoContext;
const methods = {
  runtime: ['reload'],
  tabs: ['query', 'get', 'getCurrent', 'create', 'update', 'remove', 'reload', 'discard', 'group', 'ungroup', 'move', 'duplicate', 'highlight', 'captureVisibleTab', 'sendMessage'],
  windows: ['get', 'getAll', 'getCurrent', 'getLastFocused', 'create', 'update', 'remove'],
  'storage.local': ['get', 'set', 'remove', 'clear', 'getBytesInUse'],
  'storage.sync': ['get', 'set', 'remove', 'clear', 'getBytesInUse'],
  'storage.managed': ['get', 'getBytesInUse'],
  tabGroups: ['get', 'query', 'update', 'move'],
  alarms: ['create', 'get', 'getAll', 'clear', 'clearAll'],
  contextMenus: ['create', 'update', 'remove', 'removeAll'],
  action: ['setIcon', 'setTitle', 'getTitle', 'setBadgeText', 'getBadgeText', 'setBadgeBackgroundColor', 'enable', 'disable'],
  cookies: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'],
  commands: ['getAll'],
  extension: ['isAllowedIncognitoAccess', 'isAllowedFileSchemeAccess'],
  permissions: ['contains', 'request', 'remove', 'getAll'],
  history: ['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange', 'deleteAll'],
  scripting: ['executeScript'],
  declarativeNetRequest: ['getSessionRules', 'updateSessionRules', 'getDynamicRules', 'updateDynamicRules'],
};
const events = [
  'tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated', 'tabs.onHighlighted',
  'tabs.onMoved', 'tabs.onAttached', 'tabs.onDetached', 'tabs.onReplaced',
  'windows.onCreated', 'windows.onRemoved', 'windows.onFocusChanged', 'windows.onBoundsChanged',
  'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onRemoved', 'tabGroups.onMoved',
  'alarms.onAlarm', 'commands.onCommand', 'contextMenus.onClicked',
  'storage.onChanged', 'permissions.onAdded', 'permissions.onRemoved', 'cookies.onChanged',
  'runtime.onStartup', 'runtime.onInstalled', 'runtime.onUpdateAvailable',
];
let creating = null;
let capabilities = null;
const tabScopes = new Map();
const windowScopes = new Map();

function ownerAt(path) {
  return path.split('.').reduce((owner, part) => owner && owner[part], chrome);
}
async function engineContext() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [ENGINE_URL], incognito: isPrivate,
  });
  return contexts[0] || null;
}
async function authenticateEngine(sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== ENGINE_URL || sender.tab) throw new Error('Browser API requests must originate in the offscreen engine.');
  const context = await engineContext();
  // Chromium omits documentId for offscreen senders. Their browser-supplied
  // engine URL and absent tab identify the sole native offscreen context.
  if (!context || (sender.documentId && context.documentId !== sender.documentId)) throw new Error('The engine document is no longer current.');
  return context;
}
async function ensureEngine() {
  if (creating) return creating;
  creating = (async () => {
    if (!await engineContext()) {
      await chrome.offscreen.createDocument({
        url: 'engine.html', reasons: ['LOCAL_STORAGE', 'BLOBS', 'BATTERY_STATUS'],
        justification: 'Read existing local suspension settings, process local favicon and preview images, and honor the battery/charging suspension policy without opening a browser tab.',
      });
    }
    const response = await chrome.runtime.sendMessage({ action: 'engineControl', command: 'ready' });
    if (!response || !response.ok) throw new Error(response && response.error || 'The suspension engine did not initialize.');
  })();
  try { await creating; }
  finally { creating = null; }
}
async function getCapabilities() {
  if (capabilities) return capabilities;
  const locale = await fetch(chrome.runtime.getURL('_locales/en/messages.json')).then(response => response.json());
  const substitutions = Array.from({ length: 9 }, (_, index) => '{{GS_SUB_' + index + '}}');
  const messages = {};
  for (const key of Object.keys(locale)) messages[key] = chrome.i18n.getMessage(key, substitutions);
  capabilities = { methods, events, manifest: chrome.runtime.getManifest(), incognito: isPrivate, messages,
    language: chrome.i18n.getUILanguage(), windowIdNone: chrome.windows.WINDOW_ID_NONE,
    windowIdCurrent: chrome.windows.WINDOW_ID_CURRENT, tabIdNone: chrome.tabs.TAB_ID_NONE };
  return capabilities;
}
async function invoke(path, args) {
  const split = path.lastIndexOf('.');
  const namespace = path.slice(0, split);
  const method = path.slice(split + 1);
  if (!methods[namespace] || !methods[namespace].includes(method)) return Promise.reject(new Error('Unsupported browser operation: ' + path));
  const owner = ownerAt(namespace);
  if (!owner || typeof owner[method] !== 'function') return Promise.reject(new Error('Browser operation is unavailable: ' + path));
  await guardOperation(path, args);
  // These APIs have no callback form; the remaining exposed methods support it.
  if (path === 'alarms.create' || path === 'runtime.reload') return Promise.resolve(owner[method](...args));
  return new Promise((resolve, reject) => {
    let immediate;
    try {
      immediate = owner[method](...args, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result === undefined && path === 'contextMenus.create' ? immediate : result);
      });
    } catch (error) { reject(error); }
  });
}
async function runScriptJob(details) {
  const job = details && gsInjectionJobs[details.job];
  if (typeof job !== 'function' || !Object.hasOwn(gsInjectionJobs, details.job)) throw new Error('Unknown bundled script job.');
  await requireTab(details.target && details.target.tabId);
  return chrome.scripting.executeScript({ target: details.target, func: job, args: details.args || [],
    injectImmediately: !!details.injectImmediately });
}

async function requireTab(id) {
  const tab = await chrome.tabs.get(id);
  tabScopes.set(tab.id, !!tab.incognito);
  if (!!tab.incognito !== isPrivate) throw new Error('Tab belongs to a different privacy context.');
  return tab;
}
async function requireWindow(id) {
  if (id === chrome.windows.WINDOW_ID_NONE) throw new Error('No browser window is focused.');
  const window = await chrome.windows.get(id);
  windowScopes.set(window.id, !!window.incognito);
  if (!!window.incognito !== isPrivate) throw new Error('Window belongs to a different privacy context.');
  return window;
}
async function guardOperation(path, args) {
  if (path.startsWith('tabs.') && !['tabs.query', 'tabs.create', 'tabs.captureVisibleTab', 'tabs.getCurrent'].includes(path)) {
    if (path === 'tabs.group') {
      for (const id of [].concat(args[0].tabIds || [])) await requireTab(id);
      if (args[0].groupId != null) await requireWindow((await chrome.tabGroups.get(args[0].groupId)).windowId);
      if (args[0].createProperties && args[0].createProperties.windowId != null) await requireWindow(args[0].createProperties.windowId);
    } else {
      for (const id of [].concat(args[0])) await requireTab(id);
      if (path === 'tabs.move' && args[1].windowId != null) await requireWindow(args[1].windowId);
    }
  }
  if (path === 'tabs.create') {
    if (args[0].windowId != null) await requireWindow(args[0].windowId);
    else {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const target = windows.find(window => !!window.incognito === isPrivate && window.focused) ||
        windows.find(window => !!window.incognito === isPrivate);
      if (!target) throw new Error('No browser window exists in this privacy context.');
      args[0].windowId = target.id;
    }
  }
  if (path.startsWith('windows.') && ['get', 'update', 'remove'].includes(path.slice(8))) await requireWindow(args[0]);
  if (path === 'windows.create') args[0].incognito = isPrivate;
  if (path.startsWith('tabGroups.') && path !== 'tabGroups.query') {
    await requireWindow((await chrome.tabGroups.get(args[0])).windowId);
    if (path === 'tabGroups.move' && args[1].windowId != null) await requireWindow(args[1].windowId);
  }
  if (path === 'scripting.executeScript') {
    if (!args[0].files || args[0].func || args[0].files.some(file => typeof file !== 'string' || !/^js\/[\w./-]+\.js$/.test(file) || file.includes('..'))) {
      throw new Error('Only bundled script files can be injected through this operation.');
    }
    await requireTab(args[0].target && args[0].target.tabId);
  }
  if (path.startsWith('action.') && args[0] && args[0].tabId != null) await requireTab(args[0].tabId);
}
async function scopedResult(path, result) {
  if (path === 'tabs.query') {
    result.forEach(tab => tabScopes.set(tab.id, !!tab.incognito));
    return result.filter(tab => !!tab.incognito === isPrivate);
  }
  if (path === 'windows.getAll') {
    result.forEach(window => windowScopes.set(window.id, !!window.incognito));
    return result.filter(window => !!window.incognito === isPrivate);
  }
  if (['windows.getCurrent', 'windows.getLastFocused'].includes(path)) {
    if (!!result.incognito !== isPrivate) throw new Error('Focused window belongs to a different privacy context.');
  }
  if (path === 'tabGroups.query') {
    const windows = await chrome.windows.getAll();
    const allowed = new Set(windows.filter(window => !!window.incognito === isPrivate).map(window => window.id));
    return result.filter(group => allowed.has(group.windowId));
  }
  return result;
}
async function scopedEvent(name, args) {
  if (name === 'storage.onChanged' && isPrivate && args[1] === 'local') {
    const changes = { ...args[0] };
    delete changes.gsWorkbenchState;
    if (!Object.keys(changes).length) return null;
    return [changes, args[1]];
  }
  const tab = name === 'tabs.onCreated' ? args[0] : name === 'tabs.onUpdated' ? args[2] :
    name === 'contextMenus.onClicked' || name === 'commands.onCommand' ? args[1] : null;
  if (tab && typeof tab.incognito === 'boolean') {
    tabScopes.set(tab.id, tab.incognito);
    if (tab.incognito !== isPrivate) return null;
  }
  if (name.startsWith('tabs.') && !['tabs.onCreated', 'tabs.onUpdated'].includes(name)) {
    const id = name === 'tabs.onActivated' ? args[0].tabId : args[0];
    if (typeof id === 'number') {
      let privacy = tabScopes.get(id);
      if (privacy === undefined && name !== 'tabs.onRemoved') {
        try { privacy = !!(await chrome.tabs.get(id)).incognito; } catch (_) { return null; }
      }
      if (privacy !== undefined && privacy !== isPrivate) return null;
      if (name === 'tabs.onRemoved') tabScopes.delete(id);
    }
  }
  if (name.startsWith('windows.') || name.startsWith('tabGroups.')) {
    const value = args[0];
    const id = name === 'windows.onFocusChanged' || name === 'windows.onRemoved' ? value :
      name.startsWith('tabGroups.') ? value.windowId : value.id;
    if (id === chrome.windows.WINDOW_ID_NONE) return args;
    let privacy = value && typeof value.incognito === 'boolean' ? value.incognito : windowScopes.get(id);
    if (privacy === undefined) {
      try { privacy = !!(await chrome.windows.get(id)).incognito; } catch (_) { return null; }
    }
    windowScopes.set(id, privacy);
    if (privacy !== isPrivate) return name === 'windows.onFocusChanged' ? [chrome.windows.WINDOW_ID_NONE] : null;
    if (name === 'windows.onRemoved') windowScopes.delete(id);
  }
  return args;
}
function respondTo(promise, respond) {
  promise.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || String(error) }));
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!request || sender.id !== chrome.runtime.id) return false;
  if (request.action === 'browserBroker') {
    respondTo((async () => {
      await authenticateEngine(sender);
      if (request.command === 'initialize') return getCapabilities();
      if (request.command === 'invoke') return scopedResult(request.method, await invoke(request.method, request.args || []));
      if (request.command === 'scriptJob') return runScriptJob(request.details);
      throw new Error('Unknown browser broker command.');
    })(), respond);
    return true;
  }
  if (request.action === 'engineControl' || request.action === 'engineEvent' || request.action === 'workbenchChanged') return false;
  if (sender.tab && !!sender.tab.incognito !== isPrivate) return false;
  respondTo((async () => {
    await ensureEngine();
    const response = await chrome.runtime.sendMessage({ action: 'engineEvent', event: 'runtime.onMessage',
      args: [request, sender] });
    if (!response || !response.ok) throw new Error(response && response.error || 'The engine did not respond.');
    return response.data;
  })(), value => respond(value.ok ? value.data : value));
  return true;
});
for (const name of events) {
  const event = ownerAt(name);
  if (!event || typeof event.addListener !== 'function') continue;
  event.addListener((...args) => {
    scopedEvent(name, args).then(async scoped => {
      if (!scoped) return;
      await ensureEngine();
      return chrome.runtime.sendMessage({ action: 'engineEvent', event: name, args: scoped });
    }).catch(error => console.error('Suspension engine event:', name, error));
  });
}
// Also initializes on worker launch, rather than waiting for the first user action.
ensureEngine().catch(error => console.error('Suspension engine startup:', error));
