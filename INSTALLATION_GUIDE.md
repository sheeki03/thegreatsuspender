# The Great Suspender — Installation and Usage

## Requirements

- Brave or Chrome with Chromium 116 or newer. This release uses Manifest V3 and an offscreen engine.
- Load this checkout's `src/` directory. No build is required.

## Install or upgrade

1. Before reloading or replacing an existing installation, save important page drafts, export any sessions you need, and wake your suspended tabs. Brave can close extension-owned suspended pages during a reload, and suspended URLs refer to that installation's extension ID.
2. Open `brave://extensions/` or `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's `src/` directory (not the repository root or an old `build/` copy).
4. Pin the toolbar icon from the browser's extensions menu.

Keep the source directory in place. After source updates, use **Reload** on the extension's card. If suspended tabs disappear after a reload, open **All tabs → Recover lost tabs**.

## Everyday use

- **Suspend or wake the current tab:** click the toolbar icon, then the big button. The keyboard shortcut (default ⇧⌘S / Ctrl+Shift+S) does the same.
- **Several tabs at once:** select them in the tab strip (Shift/⌘-click) before opening the popup, or use **Suspend others** / **Wake all** for this window or all windows.
- **Keep a tab awake:** in the popup, choose *1 hour*, *Until restart*, or *Always on this site*. Your stay-awake sites are listed in **Settings → Sites that stay awake**.
- **Undo:** every suspend, wake, archive and close made from the popup or tab list can be undone. Undo restores URLs, order, groups and sleep state, not unsaved page contents.

When you suspend a tab yourself, it suspends, even if it is pinned, playing audio, kept awake, or on a stay-awake site. The only thing that asks first is a page where you have typed something that may not be saved. You'll see **Suspend anyway**. Automatic suspension and bulk actions (*Suspend others*, the tab limit, workspace switching) still leave protected tabs awake and tell you why.

## The tab list

Open it with **All tabs** in the popup.

- **Tabs:** every open tab, grouped by window. Click a title to go to that tab. Each row has a one-click Suspend or Wake button. Tick tabs to get a bar with Suspend, Wake, Keep awake, Move to (a workspace), Archive and Close. Filter by Awake, Asleep or Kept awake, and search by title, site or URL (press <kbd>/</kbd>).
- **Duplicates:** pages open more than once. Pick the copy to keep, or close all extra copies at once.
- **Workspaces:** named sets of tabs, such as "Work" or "Trip planning". Create one from selected tabs with **Move to → New workspace**. **Switch to** wakes a workspace and puts tabs from your other workspaces to sleep. **Put to sleep** suspends one workspace. A workspace can have its own suspend timer.
- **Snapshots:** saved lists of your open tabs. **Reopen missing tabs** brings back a snapshot's tabs that aren't open, asleep, in their windows and groups. Automatic snapshots can be turned on in Settings.
- **Archive:** archived tabs are closed but kept here, so you can restore them later.

Keyboard: <kbd>/</kbd> or <kbd>⌘/Ctrl</kbd>+<kbd>K</kbd> searches. In the list, <kbd>↑</kbd>/<kbd>↓</kbd> move between tabs, <kbd>Space</kbd> selects, <kbd>Enter</kbd> goes to the tab, and <kbd>Esc</kbd> clears the selection or closes a menu.

## Settings

Settings save as you change them.

- **Automatic suspension:** how long a tab can sit unused before it sleeps (default 1 hour), and which tabs to keep awake: pinned tabs, tabs with unsaved typing, tabs playing audio, the tab you're viewing, while offline, while plugged in.
- **Sites that stay awake:** one site or address per line. **Which open tabs match?** checks the list against your open tabs.
- **Tab limit:** when more tabs than the limit are awake, the least recently used ones go to sleep until the lower number is reached.
- **Snapshots:** save automatically every hour, 4 hours, 12 hours, day or week, and choose how many to keep.
- **Appearance:** theme, the sleeping-tab page, and optional screenshots on sleeping tabs.
- **Advanced:** wake on focus, reload fresh, let the browser unload sleeping tabs, suspend instead of unloading, right-click menu, and settings sync.

Browser and extension pages can't be suspended. For `file://` pages, enable **Allow access to file URLs** on the extension's Details page.

## Local data and privacy

There is no analytics or network reporting. The extension stores your settings, tab metadata (titles, URLs, which workspace a tab belongs to), workspaces, archive, snapshots and the last undo record in your local browser profile. Unsaved-work detection stores only a "typed something" flag, never what you typed.

Private windows get the popup's suspend, wake and stay-awake controls when **Allow in incognito** is enabled. Workspaces, snapshots, snooze and undo are not available there, and nothing from private windows is stored.

If settings sync is turned on, your settings (including stay-awake sites) sync through your browser account. Tabs, workspaces and snapshots never sync. The optional "Hide ads in screenshots" setting downloads a public ad-blocking host list from GitHub.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Load unpacked fails, or old controls appear | Use `src/`, Chromium 116+, and Reload the correct extension card. |
| The toolbar icon is missing | Pin it from the browser's extensions menu. |
| A tab won't suspend automatically | Find it in the tab list. Its labels show whether it's pinned, playing audio, kept awake, on a stay-awake site, or has unsaved typing. You can always suspend it yourself. |
| A bulk action changed fewer tabs than expected | Open **See why** under the result. Protected tabs are left awake on purpose. |
| Suspended tabs disappeared after reloading the extension | Open **All tabs → Recover lost tabs** and choose **Restore tabs automatically**. |
| A file page can't be suspended | Enable file-URL access on the extension's Details page. |
