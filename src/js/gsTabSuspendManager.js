/*global gsBrowser, tgs, gsFavicon, gsMessages, gsStorage, gsUtils, gsChrome, gsIndexedDb, gsTabDiscardManager, gsTabCheckManager, gsCleanScreencaps, gsSuspendedTab, GsTabQueue, gsWorkbench */
// eslint-disable-next-line no-unused-vars
var gsTabSuspendManager = (function() {
  'use strict';

  const DEFAULT_CONCURRENT_SUSPENSIONS = 3;
  const DEFAULT_SUSPENSION_TIMEOUT = 60 * 1000;

  const QUEUE_ID = 'suspendQueue';

  let _suspensionQueue;

  function initAsPromised() {
    return new Promise(async function(resolve) {
      const screenCaptureMode = gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
      const forceScreenCapture = gsStorage.getOption(
        gsStorage.SCREEN_CAPTURE_FORCE
      );
      //TODO: This should probably update when the screencapture mode changes
      const concurrentSuspensions =
        screenCaptureMode === '0' ? 5 : DEFAULT_CONCURRENT_SUSPENSIONS;
      const suspensionTimeout = forceScreenCapture
        ? 5 * 60 * 1000
        : DEFAULT_SUSPENSION_TIMEOUT;
      const queueProps = {
        concurrentExecutors: concurrentSuspensions,
        jobTimeout: suspensionTimeout,
        executorFn: performSuspension,
        exceptionFn: handleSuspensionException,
      };
      _suspensionQueue = GsTabQueue('suspensionQueue', queueProps);
      gsUtils.log(QUEUE_ID, 'init successful');
      resolve();
    });
  }

  function queueTabForSuspension(tab, forceLevel) {
    queueTabForSuspensionAsPromise(tab, forceLevel).catch(e => {
      gsUtils.log(tab.id, QUEUE_ID, e);
    });
  }

  function queueTabForSuspensionAsPromise(tab, forceLevel, options) {
    if (typeof tab === 'undefined') return Promise.resolve(false);

    if (!checkTabEligibilityForSuspension(tab, forceLevel, options)) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab not eligible for suspension.');
      return Promise.resolve(false);
    }

    gsUtils.log(tab.id, QUEUE_ID, 'Queueing tab for suspension.');
    return _suspensionQueue.queueTabAsPromise(tab, { forceLevel, ...options });
  }

  function unqueueTabForSuspension(tab) {
    const removed = _suspensionQueue.unqueueTab(tab);
    gsCleanScreencaps.cancelTab(tab.id).catch(error => {
      console.error('Failed to release cancelled capture rules', error);
    });
    if (removed) {
      gsUtils.log(tab.id, QUEUE_ID, 'Removed tab from suspension queue.');
    }
  }

  async function performSuspension(
    tab,
    executionProps,
    resolve,
    reject,
    requeue
  ) {
    if (executionProps.refetchTab || gsUtils.isSuspendedTab(tab) ||
        executionProps.forceLevel >= 2 || executionProps.workbench) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab refetch required. Getting updated tab..'
      );
      const _tab = await gsChrome.tabsGet(tab.id);
      if (!_tab) {
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Could not find tab with id. Will ignore suspension request'
        );
        resolve(false);
        return;
      }
      tab = _tab;
    }

    if (!checkTabEligibilityForSuspension(tab, executionProps.forceLevel, executionProps)) {
      resolve(false);
      return;
    }

    if (gsUtils.isSuspendedTab(tab)) {
      if (!executionProps.refetchTab) {
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Tab is already suspended. Will check again in 3 seconds'
        );
        requeue(3000, { refetchTab: true });
      } else {
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Tab still suspended after 3 seconds. Will ignore tab suspension request'
        );
        resolve(false);
      }
      return;
    }

    // If tab is in loading state, try to suspend early if possible
    // Note: doing so will bypass a few checks below. Namely:
    // - Any temporary pause flag that has been set up on the tab
    // - It may lose any scrollPos value
    // Although if the tab is still loading then pause and scroll pos should
    // not be set?
    // Do not bypass loading state if screen capture is required
    let screenCaptureMode = gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
    if (tab.status === 'loading') {
      const savedTabInfo = await gsIndexedDb.fetchTabInfo(tab.url);
      if (screenCaptureMode === '0' && savedTabInfo) {
        const suspendedUrl = gsUtils.generateSuspendedUrl(
          tab.url,
          savedTabInfo.title,
          0
        );
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Interrupting tab loading to resuspend tab'
        );
        const success = await executeTabSuspension(tab, suspendedUrl, executionProps);
        resolve(success);
      } else {
        requeue(3000, { refetchTab: true });
      }
      return;
    }

    const discardInPlaceOfSuspend = typeof executionProps.discardInPlace === 'boolean' ?
      executionProps.discardInPlace : gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
    if (discardInPlaceOfSuspend) {
      screenCaptureMode = '0';
    }

    let tabInfo = await getContentScriptTabInfo(tab);
    if (shouldProtectForms(tab.id, executionProps.forceLevel, executionProps.workbench) &&
        !tab.discarded && (!tabInfo || typeof tabInfo.dirty !== 'boolean' ||
        typeof tabInfo.draftUnverified !== 'boolean' || tabInfo.dirty || tabInfo.draftUnverified)) {
      resolve(false);
      return;
    }

    // If tabInfo is null this is usually due to tab loading, being discarded or 'parked' on chrome restart
    // If we need to make a screen capture and tab is not responding then reload it
    // TODO: This doesn't actually seem to work
    // Tabs that have just been reloaded usually fail to run the screen capture script :(
    if (!tabInfo && screenCaptureMode !== '0' && !executionProps.reloaded) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab is not responding. Will reload for screen capture.'
      );
      await gsChrome.tabsUpdate(tab.id, { url: tab.url });
      // allow up to 30 seconds for tab to reload and trigger its subsequent suspension request
      // note that this will not reset the DEFAULT_SUSPENSION_TIMEOUT of 60 seconds
      requeue(30000, { reloaded: true });
      return;
    }

    tabInfo = tabInfo || {
      status: 'unknown',
      scrollPos: '0',
    };

    const isEligible = checkContentScriptEligibilityForSuspension(
      tabInfo,
      executionProps.forceLevel,
      executionProps.workbench,
      tab.id
    );
    if (!isEligible) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        `Content script status of ${
          tabInfo.status
        } not eligible for suspension. Removing tab from suspensionQueue.`
      );
      resolve(false);
      return;
    }

    // Temporarily change tab.url to append youtube timestamp
    const timestampedUrl = executionProps.preserveExactUrl ? tab.url : await generateUrlWithYouTubeTimestamp(tab);
    // NOTE: This does not actually change the tab url, just the current tab object
    tab.url = timestampedUrl;
    await saveSuspendData(tab);

    const suspendedUrl = gsUtils.generateSuspendedUrl(
      tab.url,
      tab.title,
      tabInfo.scrollPos
    );
    executionProps.suspendedUrl = suspendedUrl;

    if (screenCaptureMode === '0') {
      const success = await executeTabSuspension(tab, suspendedUrl, executionProps);
      resolve(success);
      return;
    }

    // Hack. Save handle to resolve function so we can call it later
    executionProps.resolveFn = resolve;
    requestGeneratePreviewImage(tab); //async
    gsUtils.log(
      tab.id,
      QUEUE_ID,
      'Preview generation script started successfully.'
    );
    // handlePreviewImageResponse is called on the 'savePreviewData' message response
    // this will refetch the queued tabDetails and call executionProps.resolveFn(true)
  }

  async function handlePreviewImageResponse(tab, previewUrl, errorMsg) {

    const queuedTabDetails = getQueuedTabDetails(tab);
    if (!queuedTabDetails) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab missing from suspensionQueue. Assuming suspension cancelled for this tab.'
      );
      return;
    }

    const suspensionForceLevel = queuedTabDetails.executionProps.forceLevel;
    if (!checkTabEligibilityForSuspension(tab, suspensionForceLevel, queuedTabDetails.executionProps)) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab is no longer eligible for suspension. Removing tab from suspensionQueue.'
      );
      queuedTabDetails.executionProps.resolveFn(false);
      return;
    }

    // Temporarily change tab.url with that from the generated suspended url
    // This is because for youtube tabs we manually change the url to persist timestamp
    const timestampedUrl = gsUtils.getOriginalUrl(
      queuedTabDetails.executionProps.suspendedUrl
    );
    // NOTE: This does not actually change the tab url, just the current tab object
    tab.url = timestampedUrl;

    if (!previewUrl) {
      gsUtils.warning(
        tab.id,
        QUEUE_ID,
        'savePreviewData reported an error: ',
        errorMsg
      );
    } else {
      await gsSuspendedTab.savePreview(tab, previewUrl);
    }

    const success = await executeTabSuspension(
      tab,
      queuedTabDetails.executionProps.suspendedUrl,
      queuedTabDetails.executionProps
    );

    queuedTabDetails.executionProps.resolveFn(success);
  }

  function getQueuedTabDetails(tab) {
    return _suspensionQueue.getQueuedTabDetails(tab);
  }

  async function handleSuspensionException(
    tab,
    executionProps,
    exceptionType,
    resolve,
    reject,
    requeue
  ) {
    await gsCleanScreencaps.cancelTab(tab.id);
    if (exceptionType === _suspensionQueue.EXCEPTION_TIMEOUT) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        `Tab took more than ${_suspensionQueue.getQueueProperties().jobTimeout
        }ms to suspend. Will force suspension.`
      );
      const success = await executeTabSuspension(
        tab,
        executionProps.suspendedUrl,
        executionProps
      );
      resolve(success);
    } else {
      gsUtils.warning(
        tab.id,
        QUEUE_ID,
        `Failed to suspend tab: ${exceptionType}`
      );
      resolve(false);
    }
  }

  async function executeTabSuspension(tab, suspendedUrl, executionProps) {
    executionProps = executionProps || { forceLevel: 3 };
    let currentTab = await gsChrome.tabsGet(tab.id);
    if (!currentTab || gsUtils.isSuspendedTab(currentTab, true) ||
        !checkTabEligibilityForSuspension(currentTab, executionProps.forceLevel, executionProps)) {
      return false;
    }
    if (executionProps.expectedOriginalUrl &&
        executionProps.expectedOriginalUrl !== currentTab.url) {
      return false;
    }
    if (typeof executionProps.guard === 'function') {
      const meta = gsWorkbench.getMeta(currentTab.id) || {};
      const reasons = await executionProps.guard({
        ...currentTab,
        uid: meta.uid,
        originalUrl: currentTab.url,
        workspaceId: meta.workspaceId || null,
      });
      if (!Array.isArray(reasons) || reasons.length) return false;
    }

    const protectForms = shouldProtectForms(currentTab.id, executionProps.forceLevel, executionProps.workbench);
    let lease = null;
    if (executionProps.forceLevel >= 2 || executionProps.workbench) {
      if (!currentTab.discarded) {
        const info = await getContentScriptTabInfo(currentTab, 'prepareTabAction', { allowDirtyForPolicy: !protectForms });
        const verifiedLease = info && info.draftLease && info.documentUrl === currentTab.url &&
          info.draftLease.expiresAt > Date.now() &&
          typeof info.dirty === 'boolean' && typeof info.draftUnverified === 'boolean';
        if ((protectForms && !verifiedLease) ||
            !checkContentScriptEligibilityForSuspension(info || { status: 'unknown' }, executionProps.forceLevel, executionProps.workbench, currentTab.id) ||
            !checkTabEligibilityForSuspension(currentTab, executionProps.forceLevel, executionProps)) {
          if (info && info.draftLease) {
            gsMessages.sendMessageToContentScript(currentTab.id, {
              action: 'releaseTabAction', token: info.draftLease.token,
            }, gsMessages.WARNING);
          }
          return false;
        }
        lease = verifiedLease ? info.draftLease : null;
      }
    }
    const latestTab = await gsChrome.tabsGet(currentTab.id);
    if (!latestTab || latestTab.url !== currentTab.url || gsUtils.isSuspendedTab(latestTab, true) ||
        !checkTabEligibilityForSuspension(latestTab, executionProps.forceLevel, executionProps) ||
        (protectForms && !latestTab.discarded && !lease) ||
        (lease && lease.expiresAt <= Date.now())) {
      if (lease) gsMessages.sendMessageToContentScript(currentTab.id, {
        action: 'releaseTabAction', token: lease.token,
      }, gsMessages.WARNING);
      return false;
    }
    currentTab = latestTab;

    gsTabCheckManager.unqueueTabCheck(currentTab);
    const discardInPlaceOfSuspend = typeof executionProps.discardInPlace === 'boolean' ?
      executionProps.discardInPlace : gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
    let success = false;
    if (discardInPlaceOfSuspend) {
      tgs.clearAutoSuspendTimerForTabId(currentTab.id);
      let leaseActive = true;
      const renew = lease ? setInterval(async () => {
        try {
          const protectsNow = shouldProtectForms(currentTab.id, executionProps.forceLevel, executionProps.workbench);
          const info = await getContentScriptTabInfo(currentTab, 'prepareTabAction', { allowDirtyForPolicy: !protectsNow });
          if (!leaseActive) {
            if (info && info.draftLease) {
              gsMessages.sendMessageToContentScript(currentTab.id, {
                action: 'releaseTabAction', token: info.draftLease.token,
              }, gsMessages.WARNING);
            }
          } else if (!info || !info.draftLease ||
              !checkContentScriptEligibilityForSuspension(info, executionProps.forceLevel, executionProps.workbench, currentTab.id) ||
              info.documentUrl !== currentTab.url) {
            gsTabDiscardManager.unqueueTabForDiscard(currentTab);
          } else {
            lease = info.draftLease;
          }
        } catch (error) {
          if (leaseActive) gsTabDiscardManager.unqueueTabForDiscard(currentTab);
        }
      }, 750) : null;
      try {
        success = !!(await gsTabDiscardManager.queueTabForDiscardAsPromise(currentTab, {
          beforeDiscard: async rawTab => {
            if (!checkTabEligibilityForSuspension(rawTab, executionProps.forceLevel, executionProps) ||
                (executionProps.expectedOriginalUrl && executionProps.expectedOriginalUrl !== rawTab.url)) return false;
            if (!rawTab.discarded) {
              const protectsNow = shouldProtectForms(rawTab.id, executionProps.forceLevel, executionProps.workbench);
              const info = await getContentScriptTabInfo(rawTab, 'prepareTabAction', { allowDirtyForPolicy: !protectsNow });
              const verified = info && info.draftLease && info.documentUrl === rawTab.url &&
                info.draftLease.expiresAt > Date.now();
              if ((protectsNow && !verified) ||
                  !checkContentScriptEligibilityForSuspension(info || { status: 'unknown' }, executionProps.forceLevel, executionProps.workbench, rawTab.id) ||
                  !checkTabEligibilityForSuspension(rawTab, executionProps.forceLevel, executionProps)) return false;
              if (verified) lease = info.draftLease;
            }
            const latest = await gsChrome.tabsGet(rawTab.id);
            if (!latest || latest.url !== rawTab.url ||
                !checkTabEligibilityForSuspension(latest, executionProps.forceLevel, executionProps) ||
                (lease && lease.expiresAt <= Date.now())) return false;
            if (executionProps.workbench) gsWorkbench.intent(rawTab.id, 'suspend', executionProps.reason || 'bulk-suspend');
            return true;
          },
        }));
      } catch (error) {
        gsUtils.warning(currentTab.id, 'Discard cancelled during safety revalidation', error);
      } finally {
        leaseActive = false;
        clearInterval(renew);
      }
    } else {
      if (!suspendedUrl) {
        suspendedUrl = gsUtils.generateSuspendedUrl(currentTab.url, currentTab.title, 0);
      }
      gsUtils.log(currentTab.id, 'Suspending tab');
      if (executionProps.workbench) {
        gsWorkbench.intent(currentTab.id, 'suspend', executionProps.reason || 'bulk-suspend');
      }
      tgs.setTabStatePropForTabId(currentTab.id, tgs.STATE_INITIALISE_SUSPENDED_TAB, true);
      const updatedTab = await gsChrome.tabsUpdate(currentTab.id, { url: suspendedUrl });
      success = updatedTab !== null;
    }
    if (lease) {
      gsMessages.sendMessageToContentScript(currentTab.id, {
        action: 'releaseTabAction',
        token: lease.token,
      }, gsMessages.WARNING);
    }
    return success;
  }

  // forceLevel indicates which users preferences to respect when attempting to suspend the tab
  // 1: Suspend if at all possible
  // 2: Respect whitelist, temporary whitelist, form input, pinned tabs, audible preferences, and exclude current active tab
  // 3: Same as above (2), plus also respect internet connectivity, running on battery, and time to suspend=never preferences.
  function checkTabEligibilityForSuspension(tab, forceLevel, options) {
    const hasWorkbench = !tab.incognito && typeof gsWorkbench !== 'undefined' && gsWorkbench.isReady();
    if (hasWorkbench && (forceLevel >= 2 || (options && options.workbench))) {
      const meta = gsWorkbench.getMeta(tab.id);
      const row = {
        ...tab,
        originalUrl: gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url,
        asleep: !!tab.discarded || gsUtils.isSuspendedTab(tab),
        status: tab.status === 'loading' ? 'loading' : tab.discarded ? 'discarded' :
          gsUtils.isSuspendedTab(tab) ? 'suspended' : 'awake',
        workspaceId: meta ? meta.workspaceId : null,
      };
      if (gsWorkbench.getProtectionReasonsSync(row, 'suspend', {
        ...options,
        respectSuspensionPolicy: !(options && options.workbench),
      }).length) {
        return false;
      }
    } else if (!tab.incognito && typeof gsWorkbench !== 'undefined' &&
        (forceLevel >= 2 || (options && options.workbench))) {
      // No automatic suspension may race initial policy hydration.
      return false;
    }
    if (forceLevel >= 1) {
      // if (gsUtils.isSuspendedTab(tab, true) || gsUtils.isSpecialTab(tab)) {
      // actually allow suspended tabs to attempt suspension in case they are
      // in the process of being reloaded and we have changed our mind and
      // want to suspend them again.
      if (gsUtils.isSpecialTab(tab)) {
        return false;
      }
    }
    if (forceLevel >= 2 && !hasWorkbench) {
      if (
        gsUtils.isProtectedActiveTab(tab) ||
        gsUtils.checkWhiteList(tab.url) ||
        gsUtils.isProtectedPinnedTab(tab) ||
        gsUtils.isProtectedAudibleTab(tab)
      ) {
        return false;
      }
    }
    if (forceLevel >= 3) {
      if (
        gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) &&
        !navigator.onLine
      ) {
        return false;
      }
      if (
        gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) &&
        tgs.isCharging()
      ) {
        return false;
      }
      if ((hasWorkbench ? gsWorkbench.getSuspendMinutes(tab.id) :
          gsStorage.getOption(gsStorage.SUSPEND_TIME)) === '0') {
        return false;
      }
    }
    return true;
  }

  function shouldProtectForms(tabId, forceLevel, workbench) {
    if (workbench) return true;
    if (!(forceLevel >= 2)) return false;
    return !gsBrowser.extension.inIncognitoContext && typeof gsWorkbench !== 'undefined' && gsWorkbench.isReady() ?
      !!gsWorkbench.getPolicy(tabId).ignoreForms : !!gsStorage.getOption(gsStorage.IGNORE_FORMS);
  }

  function checkContentScriptEligibilityForSuspension(
    tabInfo,
    forceLevel,
    workbench,
    tabId
  ) {
    if ((forceLevel >= 2 || workbench) &&
        (tabInfo.temporaryWhitelist || tabInfo.status === gsUtils.STATUS_TEMPWHITELIST)) {
      return false;
    }
    if (shouldProtectForms(tabId, forceLevel, workbench) &&
        (tabInfo.dirty || tabInfo.draftUnverified || tabInfo.status === gsUtils.STATUS_FORMINPUT)) {
      return false;
    }
    return true;
  }

  function getContentScriptTabInfo(tab, action, options) {
    return new Promise(resolve => {
      gsMessages.sendMessageToContentScript(tab.id, {
        action: action || 'requestInfo',
        ...options,
      }, gsMessages.WARNING, (error, tabInfo) => {
        //TODO: Should we wait here for the tab to load? Doesnt seem to matter..
        if (error) {
          gsUtils.warning(
            tab.id,
            QUEUE_ID,
            'Failed to get content script info',
            error
          );
          // continue here but will lose information about scroll position,
          // temp whitelist, and form input
        }
        resolve(tabInfo);
      });
    });
  }

  function generateUrlWithYouTubeTimestamp(tab) {
    return new Promise(resolve => {
      if (tab.url.indexOf('https://www.youtube.com/watch') < 0) {
        resolve(tab.url);
        return;
      }

      gsMessages.runJobOnTab(
        tab.id, 'youtubeTimestamp', [],
        (error, results) => {
          if (error) {
            gsUtils.warning(
              tab.id,
              QUEUE_ID,
              'Failed to fetch YouTube timestamp',
              error
            );
          }
          const timestamp = results && results[0] && results[0].result;
          if (!Number.isFinite(timestamp)) {
            resolve(tab.url);
            return;
          }
          const youTubeUrl = new URL(tab.url);
          youTubeUrl.searchParams.set('t', timestamp + 's');
          resolve(youTubeUrl.href);
        }
      );
    });
  }


  async function saveSuspendData(tab) {
    if (tab.incognito) return;
    const tabProperties = {
      date: new Date(),
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned,
      index: tab.index,
      windowId: tab.windowId,
    };
    await gsIndexedDb.addSuspendedTabInfo(tabProperties);

    const faviconMeta = await gsFavicon.buildFaviconMetaFromChromeFaviconCache(
      tab.url
    );
    if (faviconMeta) {
      await gsFavicon.saveFaviconMetaDataToCache(tab.url, faviconMeta);
    }
  }

  async function requestGeneratePreviewImage(tab) {
    const screenCaptureMode = gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
    const forceScreenCapture = gsStorage.getOption(gsStorage.SCREEN_CAPTURE_FORCE);
    const useAlternateScreenCaptureLib = gsStorage.getOption(gsStorage.USE_ALT_SCREEN_CAPTURE_LIB);
    const screenCaptureLib = useAlternateScreenCaptureLib
      ? 'js/dom-to-image.js' : 'js/html2canvas.min.js';
    let capture;
    let image;
    try {
      if (gsStorage.getOption(gsStorage.ENABLE_CLEAN_SCREENCAPS)) {
        capture = await gsCleanScreencaps.beginCapture(tab.id, _suspensionQueue.getQueueProperties().jobTimeout);
      }
      await new Promise((resolve, reject) => {
        gsMessages.injectFileOnTab(tab.id, screenCaptureLib, error => {
          if (error) reject(new Error(error.message || String(error)));
          else resolve();
        });
      });
      const results = await new Promise((resolve, reject) => {
        gsMessages.runJobOnTab(tab.id, 'capturePreview', [
          screenCaptureMode, forceScreenCapture, useAlternateScreenCaptureLib,
          capture ? capture.blockedHosts : null,
        ], (error, result) => {
          if (error) reject(new Error(error.message || String(error)));
          else resolve(result);
        });
      });
      image = results && results[0] && results[0].result;
      if (!image || typeof image !== 'object') {
        throw new Error('Capture job returned no image result');
      }
    } catch (error) {
      image = { previewUrl: null, errorMsg: error.message || String(error) };
    } finally {
      try {
        await gsCleanScreencaps.endCapture(capture);
      } catch (error) {
        console.error('Failed to release clean capture rules', error);
        image = { previewUrl: null, errorMsg: error.message || String(error) };
      }
    }
    await handlePreviewImageResponse(tab, image.previewUrl, image.errorMsg);
  }

  return {
    initAsPromised,
    queueTabForSuspension,
    queueTabForSuspensionAsPromise,
    unqueueTabForSuspension,
    handlePreviewImageResponse,
    saveSuspendData,
    checkTabEligibilityForSuspension,
    executeTabSuspension,
    getQueuedTabDetails,
  };
})();

