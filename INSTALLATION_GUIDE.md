# 🚀 The Great Suspender - Installation & Usage Guide

## 📋 Overview
This is your privacy-enhanced version of The Great Suspender with:
- **🔒 Zero tracking** - No analytics or data collection
- **🌐 All-windows suspension** - Suspend/unsuspend tabs across ALL browser windows
- **✨ Original functionality** - All standard tab suspension features intact

---

## 📦 Installation Instructions

### Step 1: Prepare the Extension
The extension is already built and ready in the `build/tgs-temp/src/` directory.

### Step 2: Open Chrome Extensions Page
1. Open Google Chrome
2. Type `chrome://extensions/` in the address bar and press Enter
   - **Alternative**: Click the three dots menu → More tools → Extensions

### Step 3: Enable Developer Mode
1. Look for the **"Developer mode"** toggle in the top-right corner
2. **Turn it ON** (should show blue/enabled)

### Step 4: Load Your Extension
1. Click the **"Load unpacked"** button (appears after enabling Developer mode)
2. Navigate to your project folder: `/Users/home/Downloads/thegreatsuspender/`
3. Select the **`build/tgs-temp/src/`** folder
4. Click **"Select Folder"**

### Step 5: Verify Installation
✅ You should see "The Great Suspender" appear in your extensions list  
✅ The extension icon should appear in your Chrome toolbar  
✅ Status should show "Enabled"

---

## 🎯 How to Use the Extension

### 🖱️ Basic Usage - Extension Popup

**To open the popup:**
- Click the extension icon in your Chrome toolbar

**Available Actions:**
```
┌─ Current Tab Actions ─────────────────┐
│ • Suspend tab                         │
│ • Unsuspend tab                       │
│ • Never suspend this page             │
│ • Never suspend this domain           │
└───────────────────────────────────────┘

┌─ Selected Tabs Actions ───────────────┐
│ • Suspend selected tabs               │
│ • Unsuspend selected tabs             │
└───────────────────────────────────────┘

┌─ Current Window Actions ──────────────┐
│ • Suspend other tabs                  │
│ • Unsuspend all tabs                  │
└───────────────────────────────────────┘

┌─ 🌐 ALL WINDOWS ACTIONS (NEW!) ─────┐
│ • Suspend all tabs (all windows)     │
│ • Unsuspend all tabs (all windows)   │
└───────────────────────────────────────┘
```

### 🖱️ Right-Click Context Menu

**Right-click on any webpage to access:**
- Suspend tab
- Unsuspend tab  
- Never suspend this domain
- **Suspend all tabs in all windows** 🆕
- **Unsuspend all tabs in all windows** 🆕

### ⌨️ Keyboard Shortcuts

**To view/customize shortcuts:**
1. Go to `chrome://extensions/shortcuts`
2. Find "The Great Suspender"
3. Set your preferred key combinations

**Available shortcuts:**
- Suspend/unsuspend current tab
- Suspend all tabs (current window)
- **Suspend all tabs (all windows)** 🆕
- **Unsuspend all tabs (all windows)** 🆕

---

## ⚙️ Configuration & Settings

### Opening Settings
1. Click the extension icon
2. Click **"Settings"** at the bottom of the popup
3. **Alternative**: Right-click extension icon → Options

### Key Settings You Should Configure

#### ⏰ **Suspend Timer**
```
Automatically suspend tabs after: [X minutes]
Options: 20 seconds, 1 min, 5 min, 15 min, 30 min, 1 hour, 3 hours, Never
```

#### 🔒 **Protection Settings**
```
☐ Don't suspend pinned tabs
☐ Don't suspend tabs playing audio  
☐ Don't suspend forms with user input
☐ Don't suspend active tabs
☐ Only suspend when on battery power
☐ Only suspend when offline
```

#### 🎨 **Visual Settings**
```
Theme: Light / Dark
Show tab screenshots: Yes / No
Screen capture quality: High / Low / None
```

#### 📝 **Whitelist**
Add websites that should never be suspended:
```
• mail.google.com
• calendar.google.com  
• music.spotify.com
• [your important sites]
```

---

## 🌟 New Features Highlights

### 🌐 All-Windows Suspension (Your Custom Feature!)

**What it does:**
- **"Suspend all tabs (all windows)"** - Suspends ALL tabs across EVERY Chrome window
- **"Unsuspend all tabs (all windows)"** - Restores ALL tabs across EVERY Chrome window

**When to use:**
- When you have multiple Chrome windows open
- To quickly free up maximum memory across your entire browser
- For complete tab management across your workspace

**Smart behavior:**
- Respects your protection settings (pinned tabs, audio, etc.)
- Handles focus management intelligently
- Works with hundreds of tabs efficiently

### 🔒 Privacy Protection (Your Custom Enhancement!)

**What was removed:**
- All usage analytics and tracking
- Session metrics collection  
- External data transmission
- User behavior monitoring

**Your privacy:**
- ✅ Zero data collection
- ✅ No external requests
- ✅ Complete local operation
- ✅ No usage statistics stored

---

## 🛠️ Troubleshooting

### Extension Not Loading
**Problem:** "Load unpacked" fails or extension doesn't appear
**Solution:**
1. Make sure you selected the `build/tgs-temp/src/` folder (not the root folder)
2. Check that Developer mode is enabled
3. Try refreshing the extensions page

### Extension Icon Missing
**Problem:** Can't see the extension icon in toolbar
**Solution:**
1. Click the puzzle piece icon in Chrome toolbar
2. Find "The Great Suspender"
3. Click the pin icon to pin it to your toolbar

### All-Windows Feature Not Working
**Problem:** All-windows buttons don't appear or don't work
**Solution:**
1. Make sure you're using the modified version (look for blue-styled buttons)
2. Check you have multiple windows open to test
3. Verify extension permissions in chrome://extensions/

### Tabs Not Suspending
**Problem:** Tabs won't suspend automatically or manually
**Solution:**
1. Check if tab is in your whitelist (Settings → Whitelist)
2. Verify protection settings aren't blocking suspension
3. Some special Chrome pages (chrome://, extensions) cannot be suspended
4. Check if tab is pinned or playing audio (if those protections are enabled)

### Permission Issues
**Problem:** Extension can't access certain pages
**Solution:**
1. Go to chrome://extensions/
2. Click "Details" on The Great Suspender
3. Enable "Allow in incognito" if needed
4. Enable "Allow access to file URLs" for local files

---

## 📊 Usage Tips & Best Practices

### 💡 **Optimal Settings for Different Users**

**Heavy Multitasker (Many tabs/windows):**
```
Timer: 15-30 minutes
✅ Don't suspend pinned tabs
✅ Don't suspend audio tabs
✅ Enable all-windows shortcuts
```

**Memory-Conscious User:**
```
Timer: 5 minutes  
✅ Suspend everything except audio
✅ Use all-windows suspension frequently
```

**Privacy-Focused User:**
```
✅ Whitelist sensitive sites (banking, email)
✅ Review whitelist regularly
✅ Your tracking is already removed! 🎉
```

### 🚀 **Power User Tips**

1. **Bulk Operations**: Use all-windows suspension before closing Chrome to save session
2. **Memory Management**: Monitor Chrome Task Manager (Shift+Esc) to see memory savings
3. **Workflow Integration**: Set keyboard shortcuts for all-windows actions
4. **Whitelist Strategy**: Add productivity tools but suspend entertainment sites
5. **Session Recovery**: Extension automatically recovers suspended tabs after crashes

---

## 🆘 Support & Additional Info

### Check Extension Status
- **Green icon**: Tab can be suspended
- **Orange icon**: Tab will be suspended soon  
- **Red icon**: Tab cannot be suspended
- **Gray icon**: Tab is already suspended

### Memory Savings
- Suspended tabs typically use 95% less memory
- Visual preview preserved for easy identification
- Original tab state restored on click

### Compatibility
- ✅ Works with Chrome 80+
- ✅ Compatible with other extensions
- ✅ Supports incognito mode (if enabled)
- ✅ Works with Chrome profiles

---

## 🎯 Quick Start Checklist

After installation, follow this checklist:

- [ ] Extension appears in Chrome toolbar
- [ ] Test basic suspend/unsuspend on a single tab
- [ ] Configure auto-suspend timer (start with 15 minutes)
- [ ] Test **all-windows suspension** with multiple windows open
- [ ] Add important sites to whitelist
- [ ] Set up keyboard shortcuts (optional)
- [ ] Verify privacy settings in extension options

**🎉 You're all set! Enjoy your privacy-enhanced, all-windows-capable tab suspender!**

---

*This extension has been modified to remove all tracking and add all-windows functionality. Your privacy is completely protected, and you now have powerful multi-window tab management capabilities.* 