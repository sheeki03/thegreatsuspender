/*global gsBrowser, gsUtils */
'use strict';
// eslint-disable-next-line no-unused-vars
var gsChrome = {
  cookiesGetAll: function() {
    return new Promise(resolve => {
      gsBrowser.cookies.getAll({}, cookies => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeCookies', gsBrowser.runtime.lastError);
          cookies = [];
        }
        resolve(cookies);
      });
    });
  },
  cookiesRemove: function(url, name) {
    return new Promise(resolve => {
      if (!url || !name) {
        gsUtils.warning('chromeCookies', 'url or name not specified');
        resolve(null);
        return;
      }
      gsBrowser.cookies.remove({ url, name }, details => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeCookies', gsBrowser.runtime.lastError);
          details = null;
        }
        resolve(details);
      });
    });
  },

  tabsCreate: function(details) {
    return new Promise(resolve => {
      if (
        !details ||
        (typeof details !== 'string' && typeof details.url !== 'string')
      ) {
        gsUtils.warning('chromeTabs', 'url not specified');
        resolve(null);
        return;
      }
      details = typeof details === 'string' ? { url: details } : details;
      gsBrowser.tabs.create(details, tab => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeTabs', gsBrowser.runtime.lastError);
          tab = null;
        }
        resolve(tab);
      });
    });
  },
  tabsReload: function(tabId) {
    return new Promise(resolve => {
      if (!tabId) {
        gsUtils.warning('chromeTabs', 'tabId not specified');
        resolve(false);
        return;
      }
      gsBrowser.tabs.reload(tabId, () => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeTabs', gsBrowser.runtime.lastError);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  },
  tabsUpdate: function(tabId, updateProperties) {
    return new Promise(resolve => {
      if (!tabId || !updateProperties) {
        gsUtils.warning(
          'chromeTabs',
          'tabId or updateProperties not specified'
        );
        resolve(null);
        return;
      }
      gsBrowser.tabs.update(tabId, updateProperties, tab => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeTabs', gsBrowser.runtime.lastError);
          tab = null;
        }
        resolve(tab);
      });
    });
  },
  tabsGet: function(tabId) {
    return new Promise(resolve => {
      if (!tabId) {
        gsUtils.warning('chromeTabs', 'tabId not specified');
        resolve(null);
        return;
      }
      gsBrowser.tabs.get(tabId, tab => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeTabs', gsBrowser.runtime.lastError);
          tab = null;
        }
        resolve(tab);
      });
    });
  },
  tabsQuery: function(queryInfo) {
    queryInfo = queryInfo || {};
    return new Promise(resolve => {
      gsBrowser.tabs.query(queryInfo, tabs => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeTabs', gsBrowser.runtime.lastError);
          tabs = [];
        }
        resolve(tabs);
      });
    });
  },
  tabsRemove: function(tabId) {
    return new Promise(resolve => {
      if (!tabId) {
        gsUtils.warning('chromeTabs', 'tabId not specified');
        resolve(null);
        return;
      }
      gsBrowser.tabs.remove(tabId, () => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeTabs', gsBrowser.runtime.lastError);
        }
        resolve();
      });
    });
  },

  windowsGetLastFocused: function() {
    return new Promise(resolve => {
      gsBrowser.windows.getLastFocused({}, window => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeWindows', gsBrowser.runtime.lastError);
          window = null;
        }
        resolve(window);
      });
    });
  },
  windowsGet: function(windowId) {
    return new Promise(resolve => {
      if (!windowId) {
        gsUtils.warning('chromeWindows', 'windowId not specified');
        resolve(null);
        return;
      }
      gsBrowser.windows.get(windowId, { populate: true }, window => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeWindows', gsBrowser.runtime.lastError);
          window = null;
        }
        resolve(window);
      });
    });
  },
  windowsGetAll: function() {
    return new Promise(resolve => {
      gsBrowser.windows.getAll({ populate: true }, windows => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeWindows', gsBrowser.runtime.lastError);
          windows = [];
        }
        resolve(windows);
      });
    });
  },
  windowsCreate: function(createData) {
    createData = createData || {};
    return new Promise(resolve => {
      gsBrowser.windows.create(createData, window => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeWindows', gsBrowser.runtime.lastError);
          window = null;
        }
        resolve(window);
      });
    });
  },
  windowsUpdate: function(windowId, updateInfo) {
    return new Promise(resolve => {
      if (!windowId || !updateInfo) {
        gsUtils.warning('chromeTabs', 'windowId or updateInfo not specified');
        resolve(null);
        return;
      }
      gsBrowser.windows.update(windowId, updateInfo, window => {
        if (gsBrowser.runtime.lastError) {
          gsUtils.warning('chromeWindows', gsBrowser.runtime.lastError);
          window = null;
        }
        resolve(window);
      });
    });
  },
};
