/*global gsBrowser, tgs, gsFavicon, gsStorage, gsSession, gsUtils, gsIndexedDb, gsMessages */
// eslint-disable-next-line no-unused-vars
var gsSuspendedTab = (function() {
  'use strict';
  const privatePreviews = new Map();

  async function savePreview(tab, previewUrl) {
    if (tab.incognito) {
      privatePreviews.set(tab.url, previewUrl);
    } else {
      await gsIndexedDb.addPreviewImage(tab.url, previewUrl);
    }
  }


  async function getData(tab) {
    const originalUrl = gsUtils.getOriginalUrl(tab.url);
    const options = gsStorage.getSettings();
    const favicon = await gsFavicon.getFaviconMetaData(tab);
    const preview = tab.incognito
      ? { img: privatePreviews.get(originalUrl) }
      : await gsIndexedDb.fetchPreviewImage(originalUrl);
    const previewUri = preview && typeof preview.img === 'string' &&
      preview.img.startsWith('data:image/') ? preview.img : null;
    const scrollPosition = Number(gsUtils.getSuspendedScrollPosition(tab.url)) || 0;
    tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);
    return {
      tabId: tab.id,
      sessionId: gsSession.getSessionId(),
      title: gsUtils.getSuspendedTitle(tab.url) || tab.title || originalUrl,
      originalUrl,
      scrollPosition,
      theme: options[gsStorage.THEME] === 'dark' ? 'dark' : 'light',
      previewMode: String(options[gsStorage.SCREEN_CAPTURE]),
      previewUri,
      favicon: {
        normalisedDataUrl: favicon.normalisedDataUrl,
        transparentDataUrl: favicon.transparentDataUrl,
        isDark: !!favicon.isDark,
      },
      hotkey: await tgs.getSuspensionToggleHotkey(),
      reason: tgs.getTabStatePropForTabId(tab.id, tgs.STATE_SUSPEND_REASON) === 3
        ? gsBrowser.i18n.getMessage('js_suspended_low_memory') : null,
    };
  }

  function notify(tabId, action, data) {
    return new Promise(resolve => {
      const message = { action, tabId };
      if (data) message.data = data;
      gsBrowser.tabs.sendMessage(tabId, message, { frameId: 0 }, () => {
        resolve(!gsBrowser.runtime.lastError);
      });
    });
  }

  async function initTab(tab) {
    const data = await getData(tab);
    await notify(tab.id, 'legacy.suspended.changed', data);
    return data;
  }

  function getPageStatus(tabId) {
    return new Promise(resolve => {
      gsMessages.sendMessageToTab(tabId, { action: 'legacy.suspended.status' },
        gsMessages.INFO, (error, status) => resolve(error ? null : status));
    });
  }

  return { getData, savePreview, initTab, notify, getPageStatus };
})();
