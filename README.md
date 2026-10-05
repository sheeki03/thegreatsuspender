# The Great Suspender

<img src="/src/img/suspendy-guy.png" width="100px" />

The Great Suspender puts tabs you aren't using to sleep so your browser uses less memory, and lets you find, organise and bring them back easily. This fork runs on Manifest V3 in Brave and Chrome.

Start with the [installation and usage guide](INSTALLATION_GUIDE.md).

### Version 8.0.0

- **One-click popup.** Suspend or wake the current tab, or the tabs you've selected, with one click and an Undo. Keep a tab awake for an hour, until restart, or always for its site. Suspend or wake every other tab in the window, or in all windows.
- **Your choice wins.** When you suspend a tab yourself, it suspends. The only question is "Suspend anyway?" when you've typed something that may not be saved. Automatic suspension and bulk actions still leave pinned, audio-playing, kept-awake and stay-awake tabs alone.
- **Automatic suspension** after a set time unused, plus an optional limit on how many tabs stay awake. The least recently used tabs sleep first.
- **Tab list.** Every tab across windows, with search, Awake/Asleep/Kept-awake filters, one-click Suspend/Wake per row, and a selection bar for Suspend, Wake, Keep awake, Move to workspace, Archive and Close.
- **Workspaces.** Named sets of tabs you can switch between or put to sleep together, each with an optional suspend timer.
- **Duplicates.** Find pages open more than once and close the extra copies.
- **Snapshots and recovery.** Save the list of open tabs manually or on a schedule, and reopen missing tabs later. Suspended tabs lost in an extension crash come back automatically. After a reload, use **Recover lost tabs**.
- **Archive.** Close tabs but keep them, ready to restore.
- **Undo** for suspend, wake, archive and close.

Unsaved-work protection only counts typing the page actually reported. Earlier builds also treated pages as unsafe when they embedded another site's frame or already had a text box. That blocked suspension on most real sites; it no longer does.

### Install as an extension from source

1. Use Brave or Chrome with Chromium 116 or newer.
2. Open `brave://extensions/` or `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked** and select this checkout's `src/` directory. No build is required.
4. Pin the toolbar icon.

Keep the source directory in place. Before reloading or replacing the extension, save important page drafts and wake your suspended tabs: Brave can close extension-owned suspended pages during a reload. Moving or repacking the installation can change its ID.

### Runtime architecture

- `src/worker.js` owns privileged browser APIs and event delivery.
- `src/engine.html` hosts the DOM-dependent suspension engine in an offscreen document. The workbench modules are `gsWorkbench.js` (tab metadata, protection rules, snooze, tab limit), `gsWorkbenchActions.js` (suspend, wake, archive, close, undo, restore), `gsWorkbenchWorkspaces.js` (workspaces and duplicates) and `gsWorkbenchSnapshots.js`.
- `src/js/gsBrowser.js` is the explicit browser-API boundary. UI pages talk to the engine through extension-internal commands.
- All executable extension code is packaged locally. The old external-extension suspension-message API is not provided.

### Local data and privacy

There is no analytics or network reporting. Settings, tab metadata, workspaces, archive, snapshots and the last undo record are stored in the local browser profile. Unsaved-work detection records only a "typed something" flag, never what was typed. Private windows are never stored. Settings sync, if you turn it on, syncs settings (including stay-awake sites) only. The optional "Hide ads in screenshots" setting downloads a public host blocklist from GitHub, and screenshots can contain visible page content.

### Release verification

Checked in Chrome for Testing (Chromium) with the unpacked `src/` folder, on real sites. Popup: suspend and wake (including stay-awake, kept-awake and pages with embedded frames), Suspend anyway after real typing, keep-awake options, Suspend others and Wake all for this window and all windows, several selected tabs, search, and private windows. Tab list: selection actions, filters, keyboard navigation, Close/Archive with Undo, workspaces (create from selection, switch, sleep, edit, delete), duplicates with Undo, snapshots (save, reopen missing, compare), and archive restore. Settings autosave for every control type. Automatic suspension with a short timer, a tab limit and a stay-awake list. Loading data saved by the previous build. Recovery of lost suspended tabs. Light, dark and narrow layouts. This is real-browser smoke coverage plus `node --check` and ESLint on the changed files, not a full automated test suite. Brave-specific behavior was not re-tested in this pass.

### Windows Group Policies

It is possible to force settings by defining group policies on Microsoft
Windows.

The whitelist is stored internally as a string, with one URL per line.

The following settings can be defined:

* `SCREEN_CAPTURE` (string, default: '0')
* `SCREEN_CAPTURE_FORCE` (boolean, default: false)
* `SUSPEND_IN_PLACE_OF_DISCARD` (boolean, default: false)
* `DISCARD_IN_PLACE_OF_SUSPEND` (boolean, default: false)
* `USE_ALT_SCREEN_CAPTURE_LIB` (boolean, default: false)
* `DISCARD_AFTER_SUSPEND` (boolean, default: false)
* `IGNORE_WHEN_OFFLINE` (boolean, default: false)
* `IGNORE_WHEN_CHARGING` (boolean, default: false)
* `UNSUSPEND_ON_FOCUS` (boolean, default: false)
* `IGNORE_PINNED` (boolean, default: true)
* `IGNORE_FORMS` (boolean, default: true)
* `IGNORE_AUDIO` (boolean, default: true)
* `IGNORE_ACTIVE_TABS` (boolean, default: true)
* `IGNORE_CACHE` (boolean, default: false)
* `ADD_CONTEXT` (boolean, default: true)
* `SYNC_SETTINGS` (boolean, default: true)
* `SUSPEND_TIME` (string (minutes), default: '60')
* `NO_NAG` (boolean, default: false)
* `WHITELIST` (string (one URL per line), default: '')
* `THEME` (string, default: 'light')

### Contributing to this extension

Contributions are very welcome. Feel free to submit pull requests for new features and bug fixes. For new features, ideally you would raise an issue for the proposed change first so that we can discuss ideas. This will go a long way to ensuring your pull request is accepted.

### License

This work is licensed under a GNU GENERAL PUBLIC LICENSE (v2)

### Shoutouts

This package uses the [html2canvas](https://github.com/niklasvh/html2canvas) library written by Niklas von Hertzen.
It also uses the indexedDb wrapper [db.js](https://github.com/aaronpowell/db.js) written by Aaron Powell.
Thank you also to [BrowserStack](https://www.browserstack.com) for providing free chrome testing tools.
