# COR3 Helper

A Chrome extension that enhances the [cor3.gg](https://cor3.gg) experience by monitoring markets, expeditions, daily ops, and providing timer alerts — all from a compact popup UI.

## About This Fork

This is a personal-use fork of [femtacore's original COR3 Helper (Femtoce11/cor3-helper)](https://github.com/Femtoce11/cor3-helper). I forked it to build the features and quality-of-life improvements I want, try out ideas, and get fixes and enhancements into my own setup faster. Development follows my own needs and priorities.

Credit for the original extension and its foundation goes to femtacore and the upstream contributors.

## Affiliation & Disclaimer

This extension is in no way affiliated with, partnered with, or endorsed by cor3.gg, Fragmentary Order, or Rant Gaming Studios.

The use of automation tools may be detectable by the site's developers and could put your account at risk. Always make sure you understand what a particular feature does before enabling it. The developers of this extension assume no liability for any consequences that may arise from your use of its features.

## Features

- **Theme Support** — Multiple color themes to match your preference, including an "Original" theme matching the game's native UI colors
- **Pop-up Window / Panel Support** — Exports the UI to pop-up window or side panel depending on your preference
- **Refresh System** — Either by using "refresh all" button or by clicking "refresh" for each section, it refreshes related data available on the UI
- **Pinned Timers** — Every timer except "RESTING" timer for mercenaries can be pinned to top of the UI for tracking
- **Auto Job Refresh** — If the "auto-refresh" checkbox next to pinned job timer is enabled, jobs get automatically refreshed when they reach zero. This gives users more jobs per day by triggering them earlier and giving enough time to finish
- **Auto Decrypt Hacking** — Automatically solves decryption hacks when enabled. Just toggle it on and the extension handles the rest
- **Auto ICE Wall Hacking** — Automatically solves ICE Wall hacking minigame. Detects triangle patterns and clicks them in the correct sequence to complete the puzzle
- **Auto Simple Decrypt Hacking** — Automatically solves Simple Decrypt hacking minigame. Clicks the decrypt button and monitors progress until completion
- **Anti-AFK Clicker** — Automatically prevents the anti-AFK screen locker from appearing by simulating a click on the desktop wrapper every 3 minutes. Enabled internally whenever any automation feature starts (Auto Job Solver, Auto Valuable Seller, Auto Daily Hacking, hack solvers, etc.)
- **Auto Daily Hacking** — Recurring daily ops automation. Opens daily ops, solves System Log Integrity or Signal Hack, and closes its windows. Stays enabled after completion, waits for the server's next task time, and resumes after page reloads while the game is open. Each run makes up to 3 attempts; unsuccessful runs retry after 5 minutes. Turning it off or enabling Helper-Only Mode stops it.
- **Auto Job Solver** — Automated market job solver supporting 9 job types: File Decryption, IP Injection, Data Download, Log Deletion, Log Download, Decrypt & Extract, File Elimination, Data Upload, and IP Cleanup. Features a tabbed UI showing HOME, D4RK, SOYUZ, and USOL market jobs with per-type checkboxes, a start/stop button, and a debug console with Jobs and Logs tabs. Jobs are sorted by server priority (furthest first) and job type priority, automatically handle endpoint setting (with hack-through if unreachable), server login (with hack if no active access), type-specific actions, and job completion with reward tracking. Checks server maintenance status before each job and skips jobs on servers currently in maintenance. Includes dynamic loadout management — automatically equips the right hack/decrypt software before each job and retries with loadout swaps on power/software errors
- **Auto Valuable Seller** — Automated valuable file/log scanner and seller. Scans all reachable servers for valuable files and logs, downloads them, and sells to the best market. Automatically equips optimal SEARCH and HACK software for each server type before scanning. Features a debug console with real-time progress logs, a server/download results UI, and a Maintenance tab with per-server checkbox selections and batch "Force selected!" for triggering multiple servers at once (furthest-to-closest order)
- **Auto Dismiss Failed Jobs** — Toggle to automatically dismiss failed and bugged jobs after each solver run, keeping the job queue clean
- **Auto Finish All Jobs** — Background scheduling that automatically starts the Auto Job Solver when new jobs become available after reset. Uses chrome.alarms to schedule runs at job reset times with retry logic. Works even when the popup is closed. Server maintenance–aware: skips jobs on servers currently in maintenance and schedules retries at the earlier of job reset or maintenance end.
- **Market Path-Through** — When market servers (D4RK, SOYUZ, USOL) or USOL mercenary endpoints are unreachable (no-path-to-server), dynamically fetches the live network map, discovers all paths via DFS, filters out maintenance-blocked routes, and walks intermediate servers (set endpoint + hack) before retrying the target. Falls back to alternate paths if one fails mid-way.
- **Daily Ops** — Countdown to your next daily ops task with streak bonus, difficulty, and claim status
- **Market Monitoring** — View Market-1 (HOME), Market-2 (D4RK), Market-3 (SOYUZ), and Market-4 (USOL) stats, job reset timers, items list (with INFO popup for item details), and jobs list (with Category/Server/Reward columns)
- **Loadout Viewer** — View and manage your equipped hardware (CPU/GPU/RAM/PSU) and installed software. Game-style card UI with hardware specs, software power ratios, resource supply/demand overview with boot status, CHANGE/INFO buttons for hardware, and sort/search/equip/unequip for software
- **Active Expedition Tracking** — See active expeditions with remaining timer, cost, risk, insurance, and mercenary info
- **Expedition Decisions** — View and respond to pending decisions by clicking them with score calculation
- **Auto Choose Decision** — Automatically chooses the highest-scoring decision immediately by default. Turn off "Do not wait to auto choose" to wait until one minute before the deadline. All Decisions toggles start on; saved preferences are kept. Configure loot/risk modifiers to change how scoring works.
- **Inventory Viewer** — Browse your stash sorted by rarity (rarest first) then price, with item/storage details, total value, and last-updated timestamps
- **Mercenaries (Multi-Market)** — View mercenaries from CORE and USOL markets in expandable rows with faction icons. Each merc card shows callsign, rank, status, specialization, traits, mission count, cost, rest timers, risk, failed-survive chance, and death chance. Elite mercenaries are displayed on top with a bold "ELITE" badge.
- **Auto Send Mercenary** — Enable "auto send" toggle and select a mercenary to send after the current expedition ends. It pays completed expeditions with Pay & Send to Mail, claims their rewards into inventory, confirms collection, then selects the next mercenary. Insufficient credits leave auto-send on: it waits for income and retries every minute without blocking drone automation. Works across both CORE and USOL markets with market-aware expedition config.
- **Mercenary Credit Reserve** — On by default. Auto-send checks the current balance against the full expedition cost, including insurance, and waits if it would leave less than 2,000 credits for marketplace jobs.
- **Auto Choose Mercenary** — Enable "auto choose" toggle for extension to do best mercenary selection according to their cost and risk values across all markets.
- **Auto-choose USOL First** — When enabled, USOL mercenaries are prioritized over CORE mercenaries during auto-choose, picking the cheapest USOL merc before considering CORE.
- **Ignore Elite Mercenary** — When enabled, elite mercenaries are excluded from auto-choose selection.
- **Apply Merc Cost Limiter** — When enabled, mercenaries with costs above the configured "Maximum merc cost limit" are excluded from auto-choose selection. Default limit is 15,000.
- **Get rid of Veterans** — When enabled, overrides loot/risk modifiers for veteran mercenary expeditions with loot=1 and risk=10, making decisions favor high-risk options to have higher chance on getting rid of veteran mercs. Located in the Decisions section.
- **Auto Sell Cheapest Items** — Enable "auto sell" to free inventory space when a mercenary or drone mail claim reports insufficient capacity. Other collection errors stop auto-send without selling items.
- **Drone Expeditions** — Replaces the unused Personal Drone Assembling panel (same icon). Displays durability, battery, stealth and payload. Enable automatic dispatch for a selected mission, or choose by battery cost, base risk and duration. Mission battery costs and upgraded maximums come from the server. Repair at a configurable percentage of maximum durability, to a configurable target; cost and duration use current server rates. Optional Repair while charging uses otherwise idle charging time to repair towards full durability, independently of the normal repair target. Mail collection and cheapest-item sales continue while mercenaries wait for funds. Reward collection failures keep dispatch enabled and retry automatically with delays capped at five minutes; saved pauses from earlier mail failures recover automatically. Capacity errors that disagree with available inventory space get one fresh retry before automatic sales.
- **Drone Mission History** — Drone flights appear alongside mercenary expeditions in Active Expeditions and Archived Expeditions. Refresh controls update both sources; completed drone missions observed by the helper are retained and merged with server history.
- **Drone Events & Modules** — Drone events use the same Decisions panel, risk/loot score, auto-choose toggle and deadline controls as mercenary events. Superseded events are skipped without pausing automation. Choices requiring unverified modules remain manual. Manage the six upgrade slots in game; automatic module swapping is deferred until its protocol and item data are verified. Drone mutations use PR #6 as a reference and still need live testing on the current server. For new drone setups, auto-send, lowest-battery mission selection and both repair options start on. Repairs start at 20% durability and target 60%. Saved preferences are kept.
- **Archived Expeditions** — View past expeditions with outcome, cost, risk, location, loot container details and item images. Auto-loaded on startup
- **Multi-Alarm System** — Create multiple configurable alarms for any timer (daily ops, market job resets, expeditions). Each alarm has its own threshold, volume, continuous mode, and on/off toggle
- **Move Notifications** — Option to move in-game notification toasts and history panel from the right side to the left side of the screen
- **Secret Link/Server Finder** — Scans all known server IPs on the network map to discover hidden connections and servers. Sends `connect.ip` for each known IP, then compares before/after map data. Uses a toggle switch (auto-disables after scan) with progress and results shown in a log box. Reports new connections and new servers found
- **Helper-Only Mode** — Toggle to hide all automation features, converting the extension to a pure info/helper tool
- **Auto Update Markets** — Toggle to automatically refresh market data when WebSocket events arrive
- **Version Tracking** — Displays the installed extension version and the game web, system, and patch versions last observed from cor3.gg. Game values may be cached; they are informational, not compatibility warnings.
- **Check for Updates** — Checks the latest published stable release from Nightingale13/cor3-helper on GitHub and links to that release when it is newer. Drafts, prereleases, and unreleased branch changes do not trigger updates. Download dist.zip and reload the extension manually to install an update.
- **Cache-First Design** — Data loads instantly from cache on popup open. Use the "Refresh All" button or per-section refresh buttons to fetch fresh data
- **Real-Time Updates** — WebSocket listeners auto-update daily ops, markets, expeditions, decisions, inventory, mercenaries, loadout, and archived expeditions live when data arrives — even if the popup is opened before data is ready
- **DevTools WS Inspector** — Built-in Chrome DevTools panel for real-time WebSocket message inspection and multicategory log viewer. Features include: category selector (WS Messages, Auto Job Solver, Auto Valuable Seller, Error Logs, Page Console Logs, Extension Console Logs), direction/event/action/server column filtering for WS messages, level/message columns for log categories, format dropdown (Raw / JSON-pretty / Interactive Tree View with inline object/array previews), search with highlight & navigation inside message detail (including tree view traversal with auto-expand), export filtered data as JSON or Markdown table, paginated log display (1000 entries per page) with section selector, IndexedDB-backed storage with 24-hour auto-cleanup, per-category clear, and resizable columns/detail pane. Includes an offline popout log viewer that imports exported log files (JSON, MD, Discord clipboard format) for offline analysis
- **Lightweight** — Only intercepts existing WebSocket traffic and re-triggers some API calls that the game already sends

## Installation

### Option A: Pre-built Release (recommended)

1. **Download** — Go to [this fork's GitHub Releases](https://github.com/Nightingale13/cor3-helper/releases) and download the latest `dist.zip` asset.

2. **Extract** — Unzip `dist.zip` to a folder on your computer.

3. **Open Chrome Extensions** — Navigate to `chrome://extensions/` in your browser.

4. **Enable Developer Mode** — Toggle the **Developer mode** switch in the top-right corner.

5. **Load the Extension** — Click **Load unpacked** and select the extracted `dist/` folder (containing `manifest.json`).

6. **Navigate to cor3.gg** — Open [https://cor3.gg](https://cor3.gg) and log in. The extension will automatically start intercepting game data.

7. **Open the Popup** — Click the COR3 Helper icon in your browser toolbar to view your dashboard.

### Option B: Build from Source

1. **Clone** — Clone the repository:
   ```
   git clone https://github.com/Nightingale13/cor3-helper.git
   ```

2. **Install Dependencies** — From the project root, run:
   ```
   npm install
   ```

3. **Build** — Bundle the extension into the `dist/` folder:
   ```
   npm run build
   ```
   For development, use watch mode to rebuild on changes:
   ```
   npm run watch
   ```

4. Follow steps 3–7 from **Option A** above to load the `dist/` folder in Chrome.

## Usage

- **On page load**, the extension automatically fetches daily ops, market data, expedition data, and mercenary data to populate the cache.
- **Open the popup** to see cached data instantly with "last updated" timestamps.
- **Refresh All** button sequentially refreshes daily ops → markets → expeditions -> mercenary.
- **Per-section refresh** buttons let you refresh individual data types.
- **Pin timers** to keep them visible at the top of the popup.
- **Auto job refresh** feature can be used to automatically refresh jobs when needed after pinning timers and clicking the "Auto" checkbox next to it.
- **Auto Decrypt Hacking** — Toggle the switch to enable. It automatically solves decryption hacks whenever one appears.
- **Auto ICE Wall Hacking** — Toggle the switch to enable. It automatically solves ICE Wall hacking minigames by detecting and clicking triangle patterns.
- **Auto Simple Decrypt Hacking** — Toggle the switch to enable. It automatically solves Simple Decrypt hacking minigames by clicking the decrypt button and monitoring progress.
- **Auto Daily Hacking** — Enable once to solve each available daily task automatically while the game is open. It stays enabled between tasks; turn it off to stop recurring runs.
- **Auto Job Solver** — Toggle the switch to reveal job selection UI. Choose job types from HOME, D4RK, SOYUZ, and USOL market tabs, then click Start. The debug console shows real-time job progress and logs. Toggle "Auto Finish All Jobs" for fully automatic operation.
- **Set decision scores** by clicking edit button. After the change click save button to keep the changes. This way you can change default scoring that extension shows next to each decision.
- **Enable auto choose decision** for extension to automatically choose best decision according to scoring which is calculated by default/modified loot/risk modifiers.
- **Enable auto send mercenary** for extension to send selected mercenary by itself after the current expedition ends.
- **Enable auto choose mercenary** for extension to choose which mercenary to send for next expedition according to their cost and risk values across CORE and USOL markets. It only works if "auto-send" feature is turned on. Use "Auto-choose USOL first" to prioritize USOL mercs, "Ignore elite mercenary" to exclude elite mercs from selection, "Apply merc cost limiter" with a configured max cost to exclude expensive mercs and "Insure high risk" to auto buy insurance for any merc with "high" risk.
- **Get rid of Veterans** — Enable in the Decisions section to override loot/risk modifiers (loot=1, risk=10) for veteran mercenary expeditions, making auto-choose favor high-risk options.
- **Secret Link/Server Finder** — Toggle the switch to enable. It scans all known server IPs by connecting to each one, then compares the network map before and after to discover any new hidden connections or servers. The toggle auto-disables when the scan completes.
- **Alarms** — Click ➕ in the Alarms section to create a new alarm. Choose a timer source, set a threshold, and configure volume/continuous beeping. Toggle alarms on/off or edit/delete them anytime.
- **Check for Updates** — Click "Check Extension Updates" at the bottom of the popup to check this fork's published stable GitHub releases. This checks for updates; installation remains manual.
- **DevTools WS Inspector** — Open Chrome DevTools (F12) and navigate to the "COR3 Helper" tab. Use the category selector to switch between WS Messages, Auto Job Solver logs, Auto Valuable Seller logs, Error Logs, Page Console Logs, and Extension Console Logs. Use the page selector to browse log history (1000 entries per page). Use the filter inputs, format dropdown, search bar, and export buttons to analyze data. Toggle Live mode to see only new entries from the activation point onward. Click the ⧉ popout button to open an offline log viewer in a new window where you can import previously exported log files.

## Files

| File                       | Description                                                                                                                                                               |
|----------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `manifest.json`            | Extension manifest (Manifest V3) — permissions include storage, scripting, activeTab, tabs, alarms, sidePanel                                                             |
| `popup.html`               | Popup UI (HTML + CSS) — includes auto job solver section, debug console, and all toggle UIs                                                                               |
| `popup.js`                 | Popup logic, rendering, alarm management, auto job solver UI, debug console, live storage update listeners                                                                |
| `console-logger.js`        | Console interceptor — captures console.log/warn/error in both MAIN world and extension contexts for DevTools log viewing                                                  |
| `errors.js`                | Centralized error logging — stores errors to chrome.storage.local with source, message, stack, and context (max 200 entries)                                              |
| `notepack.min.js`          | Bundled notepack.io 3.0.1 library — local copy of msgpack encoder/decoder used by the binary WS codec                                                                     |
| `msgpack-codec.js`         | Socket.IO v5 binary packet codec — converts between legacy 42[...] strings and binary msgpack WS frames using notepack.io                                                 |
| `content-early.js`         | Injected at `document_start` — intercepts WebSocket/HTTP polling messages, WS send functions, D4RK path-through logic                                                     |
| `content.js`               | Injected at `document_idle` — relays data to storage, handles auto-refresh, auto job solver injection, notification repositioning                                         |
| `background.js`            | Service worker — auto finish all jobs scheduling, expedition polling, alarm management                                                         |
| `ws-messages.js`           | IndexedDB writer for WS messages and categorized logs (auto-jobs, auto-valuable, errors). 24h purge                                                                       |
| `ws-interceptor.js`        | WebSocket interceptor helper                                                                                                                                              |
| `decrypt-solver.js`        | Auto-solver for decryption hacking minigame (injected into page when enabled)                                                                                             |
| `ice-wall-solver.js`       | Auto-solver for ICE Wall hacking minigame — detects triangle patterns and clicks them in sequence                                                                         |
| `simple-decrypt-solver.js` | Auto-solver for Simple Decrypt hacking minigame — clicks decrypt button and monitors progress                                                                             |
| `daily-hack-solver.js`     | Fully automated daily ops solver — opens tab, starts task, detects puzzle, solves it, closes windows, auto-disables toggle                                                |
| `auto-job-solver.js`       | MAIN world auto job solver engine — handles 9 job types with promise-based WS event orchestration                                                                         |
| `auto-valuable-seller.js`  | MAIN world valuable seller engine — scans servers for valuable files/logs, downloads them, and sells to markets with auto loadout                                         |
| `devtools.html`            | DevTools entry point — registers the WS Inspector panel                                                                                                                   |
| `devtools.js`              | DevTools page script — creates the panel tab                                                                                                                              |
| `devtools-panel.html`      | DevTools panel UI — message table, detail pane, export/search/format controls, popout button                                                                              |
| `devtools-panel.js`        | DevTools panel logic — multi-category viewing (incl. console logs), filtering, raw/json-pretty/tree-view, search, export, live mode, paginated IndexedDB loading, WS send |
| `devtools-log-viewer.html` | Offline log viewer UI — standalone popout window for importing and viewing exported logs                                                                                  |
| `devtools-log-viewer.js`   | Offline log viewer logic — import/parse JSON, MD table, Discord clipboard formats, category switching, filtering, detail view                                             |
| `versions.json`            | Legacy game-version reference values; no longer used for update checks or warnings                                                                                                   |
| `build.js`                 | esbuild bundler script — bundles modular `src/` entry points into `dist/`, copies static files, syncs manifest version from `package.json`                                 |
| `package.json`             | Node.js project config — defines `build`, `watch`, and `clean` scripts, extension version, esbuild dependency                                                              |

## Requirements

- Node.js 18+ (for building)
- Google Chrome (or Chromium-based browser)
- An active [cor3.gg](https://cor3.gg) account

## License

MIT
