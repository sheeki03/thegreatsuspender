/*global gsBrowser, gsUtils, gsStorage */
// eslint-disable-next-line no-unused-vars
var gsMessages = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',

  sendInitTabToContentScript(
    tabId,
    ignoreForms,
    tempWhitelist,
    scrollPos,
    callback
  ) {
    var payload = {
      ignoreForms: ignoreForms,
      tempWhitelist: tempWhitelist,
    };
    if (scrollPos) {
      payload.scrollPos = scrollPos;
    }
    gsMessages.sendMessageToContentScript(
      tabId,
      payload,
      gsMessages.ERROR,
      callback
    );
  },

  sendUpdateToContentScriptOfTab: function(tab) {
    if (
      gsUtils.isSpecialTab(tab) ||
      gsUtils.isSuspendedTab(tab, true) ||
      gsUtils.isDiscardedTab(tab)
    ) {
      return;
    }

    const ignoreForms = gsUtils.getSuspensionPolicy(tab).ignoreForms;
    gsMessages.sendMessageToContentScript(
      tab.id,
      { ignoreForms },
      gsMessages.WARNING
    );
  },

  sendTemporaryWhitelistToContentScript: function(tabId, callback) {
    gsMessages.sendMessageToContentScript(
      tabId,
      {
        tempWhitelist: true,
      },
      gsMessages.WARNING,
      callback
    );
  },

  sendUndoTemporaryWhitelistToContentScript: function(tabId, callback) {
    gsMessages.sendMessageToContentScript(
      tabId,
      {
        tempWhitelist: false,
      },
      gsMessages.WARNING,
      callback
    );
  },

  sendRequestInfoToContentScript(tabId, callback) {
    gsMessages.sendMessageToContentScript(
      tabId,
      {
        action: 'requestInfo',
      },
      gsMessages.WARNING,
      callback
    );
  },

  sendMessageToContentScript: function(tabId, message, severity, callback) {
    gsMessages.sendMessageToTab(tabId, message, severity, function(
      error,
      response
    ) {
      if (error) {
        if (callback) callback(error);
      } else {
        if (callback) callback(null, response);
      }
    });
  },

  sendPingToTab: function(tabId, callback) {
    gsMessages.sendMessageToTab(
      tabId,
      {
        action: 'ping',
      },
      gsMessages.INFO,
      callback
    );
  },

  sendMessageToTab: function(tabId, message, severity, callback) {
    if (!tabId) {
      if (callback) callback('tabId not specified');
      return;
    }
    var responseHandler = function(response) {
      gsUtils.log(tabId, 'response from tab', response);
      if (gsBrowser.runtime.lastError) {
        if (callback) callback(gsBrowser.runtime.lastError);
      } else {
        if (callback) callback(null, response);
      }
    };

    message.tabId = tabId;
    gsUtils.log(tabId, 'send message to tab', message);
    gsBrowser.tabs.sendMessage(tabId, message, { frameId: 0 }, responseHandler);
  },

  injectFileOnTab: function(tabId, scriptPath, callback) {
    if (!Number.isInteger(tabId)) {
      if (callback) callback(new Error('tabId not specified'));
      return;
    }
    gsBrowser.scripting.executeScript({
      target: { tabId },
      files: [scriptPath],
    }, results => {
      if (gsBrowser.runtime.lastError) {
        if (callback) callback(gsBrowser.runtime.lastError);
      } else if (callback) {
        callback(null, results);
      }
    });
  },

  runJobOnTab: function(tabId, job, args, callback) {
    gsBrowser.runScriptJob({ target: { tabId }, job, args }, results => {
      if (gsBrowser.runtime.lastError) {
        if (callback) callback(gsBrowser.runtime.lastError);
      } else if (callback) {
        callback(null, results);
      }
    });
  },
};
