/*global gsBrowser, gsStorage, gsUtils */
// Clean captures use short-lived, image-only DNR session rules scoped to one tab.
// eslint-disable-next-line no-unused-vars
var gsCleanScreencaps = (function() {
  'use strict';
  const FIRST_RULE_ID = gsBrowser.extension.inIncognitoContext ? 1250000000 : 1200000000;
  const LAST_RULE_ID = FIRST_RULE_ID + 49999999;
  const CACHE_LIFETIME = 30 * 24 * 60 * 60 * 1000;
  const activeCaptures = new Map();
  let nextRuleId = FIRST_RULE_ID;
  let blacklist = null;
  let loading = null;

  function call(method, value) {
    return new Promise((resolve, reject) => {
      const callback = result => {
        if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
        else resolve(result);
      };
      if (value === undefined) gsBrowser.declarativeNetRequest[method](callback);
      else gsBrowser.declarativeNetRequest[method](value, callback);
    });
  }

  async function initAsPromised() {
    const rules = await call('getSessionRules');
    const removeRuleIds = rules.filter(rule => rule.id >= FIRST_RULE_ID && rule.id <= LAST_RULE_ID)
      .map(rule => rule.id);
    if (removeRuleIds.length) await call('updateSessionRules', { removeRuleIds });
  }

  async function loadList() {
    if (blacklist) return blacklist;
    if (loading) return loading;
    loading = (async () => {
      const stored = await new Promise((resolve, reject) => {
        gsBrowser.storage.local.get('gsCleanScreencapsBlacklist', result => {
          if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
          else resolve(result.gsCleanScreencapsBlacklist);
        });
      });
      if (stored && stored.blockedHosts && stored.time + CACHE_LIFETIME > Date.now()) {
        blacklist = stored.blockedHosts;
        return blacklist;
      }
      const response = await fetch('https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts');
      if (!response.ok) throw new Error('Clean capture blocklist request failed: ' + response.status);
      const text = await response.text();
      const blockedHosts = {};
      for (const line of text.split('\n')) {
        const match = /^0\.0\.0\.0\s+([^\s#]+)/.exec(line);
        if (match && match[1] !== '0.0.0.0') blockedHosts[match[1].toLowerCase()] = true;
      }
      if (!Object.keys(blockedHosts).length) throw new Error('Clean capture blocklist contains no hosts');
      await new Promise((resolve, reject) => {
        gsBrowser.storage.local.set({ gsCleanScreencapsBlacklist: { time: Date.now(), blockedHosts } }, () => {
          if (gsBrowser.runtime.lastError) reject(new Error(gsBrowser.runtime.lastError.message));
          else resolve();
        });
      });
      blacklist = blockedHosts;
      return blacklist;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function beginCapture(tabId, timeoutMs) {
    await cancelTab(tabId);
    const blockedHosts = await loadList();
    const domains = Object.keys(blockedHosts);
    const rules = [];
    for (let offset = 0; offset < domains.length; offset += 1000) {
      if (nextRuleId > LAST_RULE_ID) throw new Error('Clean capture rule IDs exhausted');
      rules.push({
        id: nextRuleId++, priority: 1, action: { type: 'block' },
        condition: { tabIds: [tabId], resourceTypes: ['image'], requestDomains: domains.slice(offset, offset + 1000) },
      });
    }
    const capture = { tabId, blockedHosts, ruleIds: rules.map(rule => rule.id), timer: null };
    capture.installing = call('updateSessionRules', { addRules: rules });
    activeCaptures.set(tabId, capture);
    try {
      await capture.installing;
      if (activeCaptures.get(tabId) === capture) {
        capture.timer = setTimeout(() => endCapture(capture).catch(error => {
          console.error('Failed to release clean capture rules', error);
        }), timeoutMs || 60000);
      }
      return capture;
    } catch (error) {
      if (activeCaptures.get(tabId) === capture) activeCaptures.delete(tabId);
      throw error;
    }
  }

  async function endCapture(capture) {
    if (!capture) return;
    if (capture.releasing) return capture.releasing;
    clearTimeout(capture.timer);
    capture.releasing = (async () => {
      try {
        await capture.installing;
        await call('updateSessionRules', { removeRuleIds: capture.ruleIds });
      } finally {
        if (activeCaptures.get(capture.tabId) === capture) activeCaptures.delete(capture.tabId);
      }
    })();
    return capture.releasing;
  }

  function cancelTab(tabId) {
    return endCapture(activeCaptures.get(tabId));
  }

  return { initAsPromised, loadList, beginCapture, endCapture, cancelTab };
})();
