/*global chrome */
/*
 * The Great Suspender
 * Copyright (C) 2017 Dean Oemcke
 * Available under GNU GENERAL PUBLIC LICENSE v2
 * http://github.com/greatsuspender/thegreatsuspender
 * ლ(ಠ益ಠლ)
*/
(function() {
  'use strict';

  // Versioned so a reloaded extension installs this logic rather than reusing an older guard.
  const guardKey = '__greatSuspenderDraftGuardV2';
  if (window[guardKey]) {
    window[guardKey].reconnect(chrome.runtime);
    window[guardKey].refresh();
    return;
  }

  function createToken() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  const documentToken = createToken();
  let isReceivingFormInput = false;
  let isDirty = false;
  let isIgnoreForms = false;
  let tempWhitelist = false;
  let draftLease = null;
  let activeRuntime = null;
  let messageListener = null;
  let leaseTimer = null;
  const editLocks = new Map();
  const dirtyEditors = new Set();
  const designModeLocks = new Map();
  let isInitialised = false;
  let hiddenEditableState = false;
  const observedDocuments = new WeakSet();
  const documents = new Set();
  const disabledLockTypes = ['checkbox', 'radio', 'file', 'color', 'range'];
  const hiddenEditEvents = new Set([
    'beforeinput', 'input', 'compositionstart', 'compositionend', 'paste', 'drop',
  ]);

  function editableTarget(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    return path.find(node => {
      if (!node || node.nodeType !== 1) {
        return false;
      }
      if (editLocks.has(node) || designModeLocks.has(node.ownerDocument)) {
        return true;
      }
      if (node.isContentEditable || node.ownerDocument.designMode === 'on') {
        return true;
      }
      const tagName = node.tagName.toUpperCase();
      if (tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return !node.disabled && !node.readOnly;
      }
      if (tagName === 'INPUT') {
        return !node.disabled && (!node.readOnly || disabledLockTypes.includes(node.type)) &&
          !['button', 'submit', 'reset', 'image', 'hidden'].includes(node.type);
      }
      return node.type === 'application/pdf';
    });
  }

  function releaseDraftLease() {
    draftLease = null;
    clearTimeout(leaseTimer);
    editLocks.forEach((lock, node) => {
      if (lock.kind === 'contenteditable') {
        if (node.getAttribute('contenteditable') === 'false') {
          if (lock.attribute == null) node.removeAttribute('contenteditable');
          else node.setAttribute('contenteditable', lock.attribute);
        }
      } else if (node[lock.kind] === true) {
        node[lock.kind] = false;
      }
    });
    designModeLocks.forEach((mode, doc) => {
      if (doc.designMode === 'off') doc.designMode = mode;
    });
    editLocks.clear();
    designModeLocks.clear();
  }

  function freezeEditors() {
    if (!draftLease || draftLease.expiresAt <= Date.now()) return;
    documents.forEach(doc => {
      if (doc.designMode === 'on' && !designModeLocks.has(doc)) {
        designModeLocks.set(doc, doc.designMode);
        doc.designMode = 'off';
      }
      doc.querySelectorAll('input,textarea,select,[contenteditable]').forEach(node => {
        if (editLocks.has(node)) return;
        const tag = node.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          if (node.disabled || (node.readOnly && !disabledLockTypes.includes(node.type)) ||
              ['hidden', 'button', 'submit', 'reset', 'image'].includes(node.type)) return;
          const kind = tag === 'SELECT' || disabledLockTypes.includes(node.type) ? 'disabled' : 'readOnly';
          editLocks.set(node, { kind });
          node[kind] = true;
        } else if (node.isContentEditable) {
          editLocks.set(node, { kind: 'contenteditable', attribute: node.getAttribute('contenteditable') });
          node.setAttribute('contenteditable', 'false');
        }
      });
    });
  }

  function reportState() {
    try {
      const runtime = activeRuntime || chrome.runtime;
      runtime.sendMessage(buildReportTabStatePayload(), () => {
        // Reading lastError consumes disconnect errors after extension reload.
        if (runtime.lastError) {
          return;
        }
      });
    } catch (e) {
      // The local dirty flag remains protective even while background reloads.
    }
  }

  function formInputListener(e) {
    const target = editableTarget(e);
    const hiddenEdit = !target && e.isTrusted && hiddenEditEvents.has(e.type);
    if (!target && !hiddenEdit) {
      return;
    }
    if (draftLease && draftLease.expiresAt <= Date.now()) {
      releaseDraftLease();
    }
    const newlyUnverified = hiddenEdit && !hiddenEditableState;
    if (hiddenEdit) {
      // Closed shadow roots expose only their host. Keep the edit protective
      // without inspecting values or pretending its hidden editor can be frozen.
      hiddenEditableState = true;
    }
    if (draftLease && e.cancelable) {
      // Close/navigation is already committed. Do not accept a last-millisecond
      // edit between the background's final check and the browser API call.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!hiddenEdit) return;
    }
    if (!hiddenEdit && (['pointerdown', 'click'].includes(e.type) || (e.type === 'keydown' &&
        (target.type !== 'application/pdf' ||
        !((e.key && e.key.length === 1) || e.key === 'Backspace' || e.key === 'Delete'))))) {
      return;
    }
    releaseDraftLease();
    if (target) dirtyEditors.add(target);
    isReceivingFormInput = true;
    if (!isDirty || newlyUnverified) {
      isDirty = true;
      reportState();
    }
  }

  function formResetListener(event) {
    if (!event.isTrusted) return;
    setTimeout(() => {
      if (event.defaultPrevented) return;
      for (const target of dirtyEditors) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && target.form === event.target) dirtyEditors.delete(target);
      }
      const dirty = dirtyEditors.size > 0 || hiddenEditableState;
      if (isDirty === dirty && isReceivingFormInput === dirty) return;
      isDirty = dirty;
      isReceivingFormInput = dirty;
      reportState();
    }, 0);
  }

  function observeDocument(doc) {
    if (!doc) {
      return;
    }
    documents.add(doc);
    if (observedDocuments.has(doc)) {
      return;
    }
    observedDocuments.add(doc);
    [
      'beforeinput', 'input', 'change', 'compositionstart', 'compositionend',
      'paste', 'cut', 'drop', 'keydown', 'pointerdown', 'click',
    ].forEach(type => doc.addEventListener(type, formInputListener, true));
    doc.addEventListener('reset', formResetListener, true);
    doc.addEventListener('load', e => {
      if (e.target && /^(IFRAME|FRAME)$/.test(e.target.tagName)) {
        refreshDocuments();
        if (isInitialised) {
          reportState();
        }
      }
    }, true);
    const observer = new MutationObserver(refreshDocuments);
    observer.observe(doc.documentElement || doc, { childList: true, subtree: true });
  }

  function refreshDocuments() {
    documents.clear();
    observeDocument(document);
    documents.forEach(doc => {
      doc.querySelectorAll('iframe,frame').forEach(frame => {
        try {
          observeDocument(frame.contentDocument);
        } catch (e) {
          // Cross-origin frame content cannot be inspected in this world.
        }
      });
    });
    freezeEditors();
  }

  // Only an edit we saw but could not attribute to an element (a closed shadow
  // root) is reported. Cross-site frames and pre-existing inputs are not edits.
  function hasHiddenEdits() {
    refreshDocuments();
    return hiddenEditableState;
  }

  window[guardKey] = {
    refresh: refreshDocuments,
    reconnect(runtime) {
      init(true, runtime);
      reportState();
    },
  };
  refreshDocuments();

  function init(force, runtime) {
    if (isInitialised && !force) {
      return;
    }
    if (activeRuntime && messageListener) {
      try { activeRuntime.onMessage.removeListener(messageListener); } catch (error) {
        // The old extension runtime may already have invalidated its listeners.
      }
    }
    activeRuntime = runtime || chrome.runtime;
    isInitialised = true;
    messageListener = function(request, sender, sendResponse) {
      if (request.action === 'releaseTabAction') {
        if (draftLease && draftLease.token === request.token) {
          releaseDraftLease();
        }
        sendResponse(buildReportTabStatePayload());
        return false;
      }
      if (request.action === 'prepareTabAction') {
        const response = buildReportTabStatePayload();
        response.documentUrl = location.href;
        const withinDeadline = !Number.isFinite(request.deadlineAt) || request.deadlineAt > Date.now();
        if (withinDeadline && (!response.dirty || request.allowDirtyForPolicy === true)) {
          draftLease = {
            token: createToken(),
            expiresAt: Date.now() + 2000,
          };
          // Readonly/disabled editing flags also stop non-cancelable native IME
          // changes. Only flags are retained; input values are never accessed.
          freezeEditors();
          clearTimeout(leaseTimer);
          leaseTimer = setTimeout(releaseDraftLease, 2000);
          response.draftLease = draftLease;
        }
        sendResponse(response);
        return false;
      }
      if (request.action === 'requestInfo') {
        sendResponse(buildReportTabStatePayload());
        return false;
      }

      const previousIgnoreForms = isIgnoreForms;
      const previousTemporaryWhitelist = tempWhitelist;
      if (request.hasOwnProperty('scrollPos')) {
        if (request.scrollPos !== '' && request.scrollPos !== '0') {
          if (document.body) {
            document.body.scrollTop = request.scrollPos;
          }
          if (document.documentElement) {
            document.documentElement.scrollTop = request.scrollPos;
          }
        }
      }
      if (request.hasOwnProperty('ignoreForms')) {
        isIgnoreForms = request.ignoreForms;
        isReceivingFormInput = isReceivingFormInput && isIgnoreForms;
      }
      if (request.hasOwnProperty('tempWhitelist')) {
        if (isReceivingFormInput && !request.tempWhitelist) {
          isReceivingFormInput = false;
        }
        tempWhitelist = request.tempWhitelist;
      }
      sendResponse(buildReportTabStatePayload());
      if (previousIgnoreForms !== isIgnoreForms || previousTemporaryWhitelist !== tempWhitelist) reportState();
      return false;
    };
    activeRuntime.onMessage.addListener(messageListener);
  }

  function waitForRuntimeReady(retries) {
    retries = retries || 0;
    return new Promise(r => r(chrome.runtime)).then(chromeRuntime => {
      if (chromeRuntime) {
        return Promise.resolve();
      }
      if (retries > 3) {
        return Promise.reject('Failed waiting for chrome.runtime');
      }
      retries += 1;
      return new Promise(r => window.setTimeout(r, 500)).then(() =>
        waitForRuntimeReady(retries)
      );
    });
  }


  function buildReportTabStatePayload() {
    return {
      action: 'reportTabState',
      documentToken,
      status:
        isIgnoreForms && isReceivingFormInput
          ? 'formInput'
          : tempWhitelist
            ? 'tempWhitelist'
            : 'normal',
      dirty: isDirty,
      temporaryWhitelist: !!tempWhitelist,
      draftUnverified: hasHiddenEdits(),
      scrollPos:
        (document.body && document.body.scrollTop) ||
        (document.documentElement && document.documentElement.scrollTop) || 0,
    };
  }

  waitForRuntimeReady()
    .then(() => {
      init();
      reportState();
    })
    .catch(e => {
      console.error(e);
      setTimeout(() => {
        init();
      }, 200);
    });
})();
