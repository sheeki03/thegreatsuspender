# The Great Suspender — Installation and Usage

## Requirements

- Brave or Chrome with Chromium 116 or newer. This release uses Manifest V3, an offscreen engine, and real native tab groups.
- Load this checkout's `src/` directory. No build is required for unpacked installation.
- The optional system-memory-pressure helper supports macOS only and requires Apple's command-line tools. All other features work without it.

## Install or upgrade

1. Before reloading or replacing an existing installation, save important page drafts, export any sessions you need, and restore suspended tabs with the old installation. Brave can close extension-owned suspended pages during reload. Suspended URLs also refer to that installation's extension ID; changing folders or removing it can make those URLs inaccessible.
2. Open `brave://extensions/` or `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's `src/` directory, not the repository root or an old `build/tgs-temp/` copy.
4. Confirm that The Great Suspender is enabled, then pin its toolbar icon from the browser's extensions menu.
5. Open the popup and its workbench dashboard. Open **Settings** to configure policies.

Keep the source directory in place. After source updates, use **Reload** on the extension's card. Reloading the extension is not a browser restart: restart-scoped snooze and startup policies use the browser's actual session boundary.

The old external-extension suspension-message API is not provided by this Manifest V3 release. Popup, dashboard, settings, history, and recovery use the extension's own command boundary.

## First-use workflow

1. Choose conservative automatic suspension preferences and an awake-tab ceiling/target in **Settings**. Eligible tabs are processed oldest-first; protected tabs can leave the browser above the target.
2. Create a workspace in the dashboard and assign selected tabs. A tab belongs to at most one workspace. Workspace policy overrides inherit unspecified global settings; reset an override to restore inheritance.
3. Use the window/status filters and search field to find tabs across windows. Search matches titles, URLs, sites, groups, and statuses; filters and query are retained in the dashboard URL.
4. Select tabs, inspect the bulk preview and skip reasons, then confirm the operation. Eligibility is checked again immediately before changing each tab.
5. Hibernate a workspace or switch to another one. Saved restoration preserves supported native placement, pins, group details, and window geometry; it does not restore a site's in-memory JavaScript or unsaved editor contents.
6. Review the inbox, neglected-tab suggestions, and exact-URL duplicates. Choose the duplicate survivor explicitly and keep any tabs that should remain active.

The [README release table](README.md#version-800--tab-workbench) lists all 23 workbench features.

## Protection and bulk operations

- Snooze tabs for a duration, until tomorrow, or until the browser restarts. Clear snooze explicitly when it is no longer needed.
- Mark meeting or presentation tabs to protect them from destructive bulk actions, automatic policies, and expiry.
- Draft checks detect trusted typing, paste, IME composition, contenteditable edits, dynamic editors, and accessible frames. Hidden or inaccessible editor/frame state is treated conservatively when it cannot be verified. Unresponsive pages are skipped rather than assumed clean.
- Draft protection stores evidence flags, not editor values. It cannot recover unsaved page data after a browser crash; save important drafts in the site itself.
- A native form reset clears form-draft evidence only after the real controls reset. Synthetic reset events do not clear protection.
- Bulk previews explain eligible and skipped tabs. A later navigation, edit, or protection change can cause additional skips at confirmation time.
- **Undo** reverses the last suspend, restore, archive, or close operation where it is safe to do so. Partial failures remain retryable; inspect the reasons rather than assuming every tab was restored.
- Temporary tabs and native groups archive on expiry. Protected overdue tabs remain open with their skip reason. Restoring archived/undone entries clears obsolete expiry intent so they are not immediately re-expired.

Browser and extension pages cannot be suspended. Saved legacy sessions can restore supported `about:`, `chrome://`, and `brave://` pages awake, including their native order, pins, groups, and geometry. They are not ordinary managed web tabs in the dashboard. For `file://` pages, enable **Allow access to file URLs** on the extension's Details page.

## Snapshots, startup, and bookmarks

Configure snapshot interval and retention in **Settings**. The dashboard can capture, compare, and restore immutable session versions. Comparison uses stable tab identity and reports additions, removals, and organization changes. Snapshots are local metadata backups, not copies of form values or site application state.

Choose one of three browser startup behaviors: leave suspended tabs asleep, wake the current workspace, or show the workspace chooser. Missing suspended tabs are recovered from saved evidence; a recycled native window ID alone does not establish continuity. Expired recovery entries are retained visibly in **Archive** instead of silently reopened or discarded. Failed recovery remains retryable without overwriting its saved evidence.

Import a bookmark folder into a workspace or export a workspace to a browser bookmark folder. Nested folders and same-name siblings are retained. Unsupported bookmark URLs are reported as skipped. Native bookmark export writes to the browser's bookmarks; other workbench state remains extension-local.

## Keyboard navigation

- **Tab / Shift+Tab:** move through available controls.
- **/** or **Command/Ctrl+K:** focus search outside editable controls.
- **Arrow Up / Arrow Down, Home / End:** navigate dashboard tab rows.
- **Space:** toggle the focused row's selection.
- **Enter:** activate the focused control or row; bulk actions still use their preview/confirmation.
- **Escape:** close previews or dialogs and return focus to the invoking control.

Configure browser-level suspension shortcuts at `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`. Theme selection applies consistently to popup, dashboard, and settings; the dashboard and settings also support narrow layouts.

## Optional macOS memory-pressure helper

The helper reads macOS's `kern.memorystatus_vm_pressure_level`. It returns normal, warning, or critical pressure with a timestamp; it does not estimate bytes or percentages of RAM saved. It receives no tab URLs, titles, or page content and installs no background service.

1. Install Apple's command-line tools if needed:

   ```sh
   xcode-select --install
   ```

2. Open the extension's Details page and copy its 32-character ID. The ID can change if you move/repack the unpacked extension.
3. From the repository root, run the following command, replacing `YOUR_EXTENSION_ID` with that ID. Settings also shows a command containing the current ID.

   ```sh
   bash native/install-host.sh --extension-id YOUR_EXTENSION_ID
   ```

4. Open **Settings → macOS memory helper** and choose **Check pressure now**. Confirm a real native reading before enabling automation.
5. Choose warning-or-critical or critical-only pressure and an awake target, then enable automatic checks. The extension polls once per minute and suspends oldest eligible tabs until the target is reached or only protected tabs remain.

Installation is user-local; do not use `sudo`. Defaults:

- Executable: `~/Library/Application Support/TheGreatSuspender/MemoryHost/tab-memory-host`
- Native registration: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sheeki.tab_memory.json`

**Brave on macOS uses the Chrome native-host registry above.** Its `--user-data-dir` does not redirect native-host lookup. `--browser-dir` changes where the installer writes the registration; it does not reconfigure browser lookup. For isolated tests, launch Brave with both `HOME` and `CFFIXED_USER_HOME` pointing to an isolated home and register under that home.

The installer accepts absolute `--browser-dir` and `--install-dir` paths. If customized, use the same ID and paths when removing it. To remove the default installation, first choose **Disable & disconnect**, then run:

```sh
bash native/uninstall-host.sh --extension-id YOUR_EXTENSION_ID
```

Removal checks the registered ID and executable before deleting only this helper's registration and binary. It leaves browser profiles intact. A missing or unsupported helper reports an installation error; the extension never substitutes invented pressure readings. Without the helper, leave pressure automation disabled and use time/count policies instead.

## Local data and privacy

This fork has no analytics transmission. It does store workspaces, archives, snapshots, tab URLs/titles, lifecycle causes, foreground-active time, and policy metrics locally in the browser profile. Activity summaries count foreground, non-idle time rather than a tab's age; disable activity recording in Settings if it is not wanted. Counts, sleep durations, and restore latency are measurements, not a RAM-savings claim.

Private windows use isolated legacy suspension controls when **Allow in incognito** is enabled. Their tabs, workspaces, activity, and history are excluded from normal workbench persistence. Unverified private tabs are skipped; private mode does not provide the persistent workbench features.

Legacy preference sync, if enabled, uses the browser's synchronization service and can include never-suspend rules. Optional clean screenshot capture can fetch the StevenBlack hosts blocklist from GitHub as filter data, not executable code. Optional screenshots can contain visible page content. Native memory messages contain only pressure requests/results.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Load unpacked fails or old controls appear | Use `src/`, Chromium 116+, and Reload the correct extension card. Avoid loading a stale built copy. |
| The toolbar icon is missing | Pin it from the browser's extensions menu. |
| A bulk operation changes fewer tabs than requested | Read preview/result skip reasons. Pins, audio, active tabs, drafts, meeting protection, snooze, or unverified state can prevent an action. |
| A temporary tab stays open past expiry | Clear its protection or save its draft, then review the overdue reason. Expiry does not override draft/meeting safety. |
| A file page cannot be managed | Enable file-URL access in the extension's Details page. |
| Private controls are unavailable | Enable Allow in incognito. Workspaces and local metrics intentionally remain normal-window-only. |
| Check pressure reports a missing host | Verify the current extension ID, Chrome registry path, executable path, and command-line-tools installation. Reinstall after an ID change. |
| A recovery entry is absent from open windows | Check Archive for expired recovery entries and Recovery for retryable failures. Restore intentionally; do not delete the saved session first. |

For a release smoke, use a separate browser profile rather than manipulating your normal tabs. Verify a clean tab's suspend/restore, a protected draft's skip, a native-group workspace restore, and a saved browser-only group restore. Memory-pressure threshold verification should use a structured test reading; forcing system memory exhaustion is not required or recommended.
