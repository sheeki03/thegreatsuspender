/* Unit suites run in their own page and tgsTest database, not the live engine. */
var gsBrowser = {
  runtime: chrome.runtime, extension: chrome.extension, i18n: chrome.i18n,
  tabs: chrome.tabs, windows: chrome.windows, storage: chrome.storage,
  scripting: chrome.scripting, action: chrome.action, history: chrome.history,
  contextMenus: chrome.contextMenus, bookmarks: chrome.bookmarks, tabGroups: chrome.tabGroups,
  alarms: chrome.alarms, idle: chrome.idle, cookies: chrome.cookies,
  declarativeNetRequest: chrome.declarativeNetRequest,
  runScriptJob: function(details, callback) {
    const job = gsInjectionJobs[details.job];
    if (!Object.hasOwn(gsInjectionJobs, details.job) || typeof job !== 'function') throw new Error('Unknown bundled test script job.');
    return chrome.scripting.executeScript({ target: details.target, func: job, args: details.args || [],
      injectImmediately: !!details.injectImmediately }, callback);
  },
};
