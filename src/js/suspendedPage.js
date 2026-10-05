/* global chrome, workbenchClient, legacyUi */
(function() {
  'use strict';
  var C = workbenchClient, tabId = null, data = null, initialized = false, loading = false, refreshAgain = false, pendingData = null, waking = false;
  var pageUrl = location.href;

  function animate(value) {
    waking = value;
    document.body.classList.toggle('waking', value);
    document.getElementById('snoozyImg').src = chrome.runtime.getURL(value ? 'img/snoozy_tab_awake.svg' : 'img/snoozy_tab.svg');
    document.getElementById('snoozySpinner').classList.toggle('spinner', value && !document.body.classList.contains('img-preview-mode'));
    document.getElementById('refreshSpinner').classList.toggle('spinner', value && document.body.classList.contains('img-preview-mode'));
    document.getElementById('suspendedRestore').disabled = value;
    var previewButton = document.getElementById('previewRestore');
    if (previewButton) previewButton.disabled = value;
  }

  function offline() {
    animate(false);
    legacyUi.status(chrome.i18n.getMessage('html_suspended_toast_not_connected') + ' ' + chrome.i18n.getMessage('html_suspended_toast_reload_disabled'), 'error');
  }

  async function restore(event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    if (!initialized || waking) return;
    animate(true); legacyUi.status('');
    try {
      var result = await C.request('legacy.suspended.restore', { tabId: tabId, url: pageUrl });
      if (!result.restoring && result.offline) offline();
      else if (!result.restoring) { animate(false); legacyUi.status('The tab could not be restored. Try again.', 'error'); }
    } catch (error) { animate(false); legacyUi.error(error); }
  }

  async function render(info) {
    var focus = legacyUi.focusKey(document.activeElement);
    data = info;
    document.title = info.title || info.originalUrl;
    document.getElementById('gsTopBarTitle').textContent = info.title || info.originalUrl;
    var url = document.getElementById('gsTopBarUrl');
    url.textContent = info.originalUrl;
    var link = legacyUi.href(info.originalUrl);
    if (link) url.href = link; else url.removeAttribute('href');
    url.title = info.originalUrl;
    var favicon = info.favicon || {};
    document.getElementById('gsTopBarImg').src = legacyUi.imageSource(favicon.normalisedDataUrl) || legacyUi.favicon(info.originalUrl);
    document.getElementById('gsFavicon').href = legacyUi.imageSource(favicon.transparentDataUrl) || chrome.runtime.getURL('img/ic_suspendy_16x16.png');
    document.body.classList.toggle('dark', info.theme === 'dark');
    document.getElementById('faviconWrap').classList.toggle('faviconWrapLowContrast', info.theme === 'dark' && !!favicon.isDark);
    var hotkey = document.getElementById('hotkeyWrapper');
    if (info.hotkey) hotkey.replaceChildren(C.node('span', { class: 'hotkeyCommand', text: '(' + info.hotkey + ')' }));
    else {
      var configure = C.node('a', { id: 'setKeyboardShortcut', href: 'chrome://extensions/shortcuts', 'data-focus-key': 'suspended-shortcut', text: chrome.i18n.getMessage('js_suspended_hotkey_to_reload') });
      legacyUi.bind(configure, function() { return C.api(chrome.tabs, 'create', [{ url: 'chrome://extensions/shortcuts' }]); });
      hotkey.replaceChildren(configure);
    }
    var reason = document.getElementById('reasonMsg');
    if (!reason) { reason = C.node('span', { id: 'reasonMsg', class: 'reasonMsg' }); document.getElementById('suspendedMsg-instr').prepend(reason); }
    reason.textContent = info.reason || ''; reason.hidden = !info.reason;
    var preview = document.getElementById('gsPreviewContainer');
    var previewUri = legacyUi.imageSource(info.previewUri);
    var showPreview = info.previewMode !== '0' && !!previewUri;
    if (!preview && showPreview) {
      var image = C.node('img', { id: 'gsPreviewImg', class: 'gsPreviewImg', alt: 'Saved screenshot of ' + (info.title || info.originalUrl) });
      var button = C.button('' , restore, { id: 'previewRestore', class: 'preview-restore', 'data-focus-key': 'suspended-preview', 'aria-label': 'Restore ' + (info.title || info.originalUrl) });
      button.appendChild(image);
      preview = C.node('div', { id: 'gsPreviewContainer', class: 'gsPreviewContainer' }, [button]);
      document.body.appendChild(preview);
    }
    if (preview) {
      preview.hidden = !showPreview;
      if (showPreview) {
        var imageElement = document.getElementById('gsPreviewImg');
        if (imageElement.getAttribute('src') !== previewUri) {
          await new Promise(function(resolve) {
            function done() { imageElement.removeEventListener('load', done); imageElement.removeEventListener('error', done); resolve(); }
            imageElement.addEventListener('load', done); imageElement.addEventListener('error', done); imageElement.src = previewUri;
          });
        }
      }
    }
    document.body.classList.toggle('img-preview-mode', showPreview);
    document.getElementById('suspendedMsg').hidden = showPreview;
    document.body.style.overflowY = showPreview && info.previewMode === '2' ? 'auto' : 'hidden';
    document.body.classList.remove('hide-initially');
    if (!initialized) window.scrollTo(0, showPreview && info.previewMode === '2' && Number(info.scrollPosition) > 15 ? Number(info.scrollPosition) + 151 : 0);
    initialized = true;
    animate(waking);
    legacyUi.restoreFocus(focus);
  }

  async function refresh(info) {
    if (tabId === null) return;
    if (info) pendingData = info;
    if (loading) { refreshAgain = true; return; }
    loading = true;
    var next = pendingData; pendingData = null;
    try { await render(next || await C.request('legacy.suspended.get', { tabId: tabId, url: pageUrl })); }
    catch (error) { legacyUi.error(error); }
    finally { loading = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
  }

  chrome.runtime.onMessage.addListener(function(message, sender, respond) {
    if (sender.id !== chrome.runtime.id || !message || message.tabId !== undefined && tabId !== null && message.tabId !== tabId) return;
    if (message.action === 'legacy.suspended.status') { respond({ sessionId: data && data.sessionId || null, initialized: initialized, visible: initialized && !document.body.hidden && !document.body.classList.contains('hide-initially') }); return; }
    if (message.action === 'legacy.suspended.changed') refresh(message.data);
    else if (message.action === 'legacy.suspended.offline') offline();
    else if (message.action === 'legacy.suspended.reload' && initialized) animate(true);
  });

  legacyUi.start(async function() {
    var tab = await C.api(chrome.tabs, 'getCurrent');
    if (!tab || !Number.isInteger(tab.id)) throw new Error('Open this suspended page in its original browser tab.');
    tabId = tab.id;
    document.getElementById('suspendedRestore').addEventListener('click', restore);
    document.getElementById('suspendedMsg').addEventListener('click', function(event) { if (!event.target.closest('button, a')) restore(event); });
    document.getElementById('gsTopBarUrl').addEventListener('click', restore);
    document.getElementById('gsTopBar').addEventListener('click', function(event) { if (!event.target.closest('#gsTopBarTitleWrap, a, button')) restore(event); });
    legacyUi.bind(document.querySelector('.watermark'), function() { return C.openPage('about.html'); });
    window.addEventListener('beforeunload', function() { if (initialized) C.request('legacy.suspended.unload', { tabId: tabId, url: pageUrl }).catch(function(error) { console.warn('Unable to record suspended-page reload:', error.message); }); });
    C.subscribe(refresh);
    await refresh();
  });
})();
