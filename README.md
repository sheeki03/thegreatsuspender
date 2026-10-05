# The Great Suspender

<img src="/src/img/suspendy-guy.png" width="100px" />

The Great Suspender is an open-source tab suspender and local tab workbench for Brave and Chrome. This fork uses Manifest V3 and real browser tab groups to manage many tabs without discarding the work still happening in them.

Start with the [installation and usage guide](INSTALLATION_GUIDE.md). Workspaces, safe bulk actions, recovery, local activity summaries, and policies are available from the toolbar popup and cross-window dashboard.

Before replacing or removing an installation, save page drafts, export needed sessions, and restore its suspended tabs. Suspended URLs contain that installation's extension ID. See [recovery and startup behavior](INSTALLATION_GUIDE.md#snapshots-startup-and-bookmarks).

### Version 8.0.0 — Tab workbench

The popup, dashboard, and settings share a responsive light/dark interface with keyboard navigation, visible protection reasons, and revalidated bulk previews.

| # | Feature | Behavior |
| --- | --- | --- |
| 1 | Tab-count policies | Configurable awake ceiling and target; suspend oldest eligible tabs without overriding protection. |
| 2 | Timed snooze | Exclude tabs for a duration, until tomorrow, or until the browser restarts. |
| 3 | Workspaces | Exclusive tab membership and per-workspace suspension-policy overrides with global inheritance. |
| 4 | Hibernate and switch | Sleep/wake workspaces while retaining native windows, order, pins, groups, and geometry. |
| 5 | Cross-window search | Match title, URL, site, group, and status; combine window/status/workspace filters. |
| 6 | Duplicate review | Compare complete URLs, including query and hash; variants stay separate. Choose a survivor safely. |
| 7 | Unreviewed inbox | Keep, archive, or close new tabs; revisits remove them from the inbox. |
| 8 | Automatic grouping | Preview domain or topic groupings, then create real per-window native groups. |
| 9 | Temporary tabs and groups | Archive on expiry; protected overdue tabs remain available for review. |
| 10 | Unsaved-work protection | Detect trusted paste, IME, contenteditable, dynamic forms, and frame edits; skip unverified pages. |
| 11 | Meeting/presentation protection | Explicitly keep selected tabs out of destructive actions and automatic policies. |
| 12 | Undo | Reverse the last suspend, restore, archive, or close operation, with retryable partial results. |
| 13 | Bulk previews | Show eligible tabs and skip reasons; recheck navigation, drafts, and protection before execution. |
| 14 | Versioned snapshots | Schedule immutable local snapshots with retention, identity-aware comparisons, and restoration. |
| 15 | Restore throttling | Configure concurrency and spacing; prioritize foreground/current-workspace restores and wait for native readiness. |
| 16 | Startup policy | Leave tabs asleep, wake the current workspace, or show a workspace chooser on real browser startup. |
| 17 | Keyboard navigation | Search shortcuts, complete tab order, roving row navigation, selection, and dialog focus restoration. |
| 18 | Lifecycle timeline | Local suspend/restore/archive/close events with causes. |
| 19 | Active-time summaries | Foreground, non-idle time by site and workspace, rather than tab lifetime. |
| 20 | Policy metrics | Actual tab counts, sleep duration, restore latency, and protection reasons; no invented RAM savings. |
| 21 | Neglected-tab review | Age-based recommendations with open/review/archive actions. |
| 22 | Native memory pressure | Optional macOS pressure readings and oldest-eligible suspension at a chosen pressure threshold/target. |
| 23 | Bookmark workspaces | Import/export native bookmark folders, retaining nested folders and reporting unsupported URLs. |

Recovery preserves supported browser pages awake, including browser-only native groups. Stable tab witnesses, not recycled numeric window IDs, establish continuity. Expired recovery entries remain visible in Archive; retryable failures keep their saved evidence.

### Install as an extension from source

1. Use Brave or Chrome with Chromium 116 or newer.
2. Open `brave://extensions/` or `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this checkout's `src/` directory. No build is required; do not load an old `build/tgs-temp/src/` copy.
5. Pin the toolbar icon, open the popup, and open the workbench dashboard and Settings.

Keep the source directory in place. Before reloading or replacing the extension, save important page drafts, export needed sessions, and restore suspended tabs: Brave can close extension-owned suspended pages during reload. After source updates, use **Reload** on the existing extension card. Moving or repacking the installation can change its ID.

### Runtime architecture

- `src/worker.js` owns privileged browser APIs and event delivery.
- `src/engine.html` hosts the DOM-dependent legacy and workbench engine in an offscreen document.
- `src/js/gsBrowser.js` is the explicit browser-API boundary. UI pages use acknowledged extension-internal commands, not a background-page reference.
- Tab groups and bookmarks use real native APIs. The old external-extension suspension-message API is not provided.
- All executable extension code is packaged locally.

### Local data and privacy

There is no analytics transmission. The workbench does record tab metadata, workspaces, archives, snapshots, lifecycle causes, foreground-active time, and policy metrics in the local browser profile. Activity recording can be disabled in Settings. Draft protection records flags, not editor values; restoration cannot recover unsaved site application state.

Private windows use isolated legacy controls when incognito access is enabled. They are excluded from normal workbench persistence. Legacy preference sync, if enabled, uses browser sync and can include never-suspend rules. Optional clean screenshots fetch the StevenBlack hosts blocklist as filter data and can contain visible page content.

The optional macOS helper receives no tab URLs or page content and runs no background service. See [native helper setup and removal](INSTALLATION_GUIDE.md#optional-macos-memory-pressure-helper); macOS Brave uses Chrome's native-host registry even with a custom browser profile.

### Release verification

All 23 features were exercised in an isolated macOS Brave profile, including real groups/bookmarks, browser restarts, scheduled alarms, protected drafts, undo, throttled restores, and desktop/narrow light/dark UI. Recovery smokes covered browser-only groups, saved geometry, interrupted restores, expired entries, older sessions without stable IDs, unverified private pages, and duplicate sleeping-tab identities after native reordering and offscreen-engine recreation.

A real macOS normal-pressure reading was observed; the warning-pressure action path used a structured test reading rather than forcing system memory exhaustion. All 58 packaged JavaScript source/library/existing-test files passed `node --check`. This is syntax verification plus real-browser smoke coverage, not a claim that the full automated test suite ran.

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
