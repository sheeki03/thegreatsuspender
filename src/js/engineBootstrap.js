/* Load context-dependent libraries only after the real browser capabilities arrive. */
(async () => {
  'use strict';
  try {
    await gsBrowser.ready;
    const files = [
      'gsUtils.js', 'gsChrome.js', 'gsStorage.js', 'db.js', 'gsIndexedDb.js', 'gsMessages.js',
      'gsSession.js', 'gsTabQueue.js', 'gsTabCheckManager.js', 'gsFavicon.js', 'gsCleanScreencaps.js',
      'gsTabSuspendManager.js', 'gsTabDiscardManager.js', 'gsSuspendedTab.js',
      'gsWorkbench.js', 'gsWorkbenchActions.js', 'gsWorkbenchWorkspaces.js', 'gsWorkbenchSnapshots.js',
      'gsLegacyRpc.js', 'background.js',
    ];
    for (const file of files) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = gsBrowser.runtime.getURL('js/' + file);
        script.onload = resolve;
        script.onerror = () => reject(new Error('Unable to load engine library: ' + file));
        document.body.appendChild(script);
      });
    }
  } catch (error) {
    console.error('Engine initialization:', error);
    gsBrowser.signalReady(error);
  }
})();
