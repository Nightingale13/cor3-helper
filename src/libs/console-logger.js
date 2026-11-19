// console-logger.js — Intercepts console.log/warn/error and stores entries.
// Works in two modes:
//   1. Extension contexts (content script, background, popup) — writes to chrome.storage.local + IndexedDB
//   2. MAIN world (content-early.js) — stores in window.__cor3ConsoleLogs array + IndexedDB
//
// Storage key: 'cor3_console_logs' (extension contexts share one key, source is per-entry).
// Each entry: { timestamp, level, source, args (stringified arguments) }
// Both modes also write to IndexedDB 'logs' store (category 'page-console' or 'ext-console')
// so logs survive page refreshes and can be read uniformly by DevTools panel and copy button.
// Purges entries older than 24h on every write (debounced).

(function () {
    'use strict';

    // Detect context
    var hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
    var isMainWorld = !hasStorage && typeof window !== 'undefined';
    var uuidPattern = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;
    var displayNames = new Map();
    function learnNames(value, seen = new WeakSet(), depth = 0) {
        if (typeof value === 'string' && depth < 16 && /^\d*[\[{]/.test(value)) {
            try { learnNames(JSON.parse(value.replace(/^\d+(?=[\[{])/, '')), seen, depth + 1); } catch (error) {}
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value) || depth > 16) return;
        seen.add(value);
        var name = value.name || value.callsign || value.serverName || value.marketName || value.fileName;
        if (typeof name === 'string') {
            var cleanName = name.replace(uuidPattern, '').trim();
            for (var key of ['id', 'moduleConfigId', 'serverId', 'marketId', 'itemId', 'fileId']) {
                if ((key === 'serverId' && !value.serverName) || (key === 'marketId' && !value.marketName)) continue;
                if (cleanName && typeof value[key] === 'string' && value[key].match(uuidPattern)) {
                    if (displayNames.size >= 5000) displayNames.delete(displayNames.keys().next().value);
                    displayNames.set(value[key].toLowerCase(), cleanName);
                }
            }
        }
        for (var child of Object.values(value)) learnNames(child, seen, depth + 1);
    }
    function niceText(text, fallback) {
        return String(text).replace(/\s+\((?:(?:new\s+)?(?:id|fileId|moduleConfigId):\s*)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\)/gi, '')
            .replace(uuidPattern, id => displayNames.get(id.toLowerCase()) || fallback);
    }
    function niceValue(value, fallback, seen = new WeakMap(), depth = 0) {
        if (typeof value === 'string') return niceText(value, fallback);
        if (!value || typeof value !== 'object') return value;
        if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
        if (depth > 24) return '[Nested details]';
        if (seen.has(value)) return seen.get(value);
        var result = Array.isArray(value) ? [] : {};
        seen.set(value, result);
        if (value instanceof Error) {
            result = new Error(niceText(value.message, fallback));
            result.name = value.name;
            result.stack = niceText(value.stack || '', fallback);
            seen.set(value, result);
        }
        for (var key of Object.keys(value)) Object.defineProperty(result, niceText(key, fallback), {
            value: niceValue(value[key], fallback, seen, depth + 1), enumerable: true, configurable: true, writable: true
        });
        return result;
    }
    function displayArgs(args) {
        try {
            var values = Array.from(args);
            learnNames(values);
            var text = values.filter(value => typeof value === 'string').join(' ');
            var fallback = /software/i.test(text) ? 'Unknown software' : /hardware/i.test(text) ? 'Unknown hardware'
                : /server/i.test(text) ? 'Unknown server' : /mercenary/i.test(text) ? 'Unknown mercenary' : 'Unnamed item';
            return values.map(value => niceValue(value, fallback));
        } catch (error) { return ['[Log details unavailable]']; }
    }
    // Learn names without changing the messages used by the game or automation.
    if (typeof window !== 'undefined') window.addEventListener('message', event => {
        if (event.source === window && /^COR3_/.test(event.data?.type || '')) learnNames(event.data);
    });
    if (hasStorage) {
        var nameKeys = ['loadoutData', 'stashData', 'marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData', 'mercenariesData', 'usolMercenariesData', 'autoJobsTracker'];
        chrome.storage.local.get(nameKeys, data => learnNames(data));
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local') for (var key of nameKeys) if (changes[key]) learnNames(changes[key].newValue);
        });
    }

    // Auto-detect source context
    var source = 'unknown';
    if (hasStorage) {
        if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
            source = 'background';
        } else if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
            source = 'popup';
        } else {
            source = 'content';
        }
    }

    var MAX_AGE = 8 * 60 * 60 * 1000; // 8 hours
    var MAX_ENTRIES = 5000;
    var PURGE_INTERVAL = 60000; // purge at most once per minute
    var _lastPurge = 0;

    // ─── IndexedDB writer (shared by both modes) ───
    // Writes to cor3_ws_db / 'logs' store with category 'page-console' or 'ext-console'.
    // Lightweight and fire-and-forget — failures are silently ignored to avoid
    // interfering with normal console output.
    var IDB_NAME = 'cor3_ws_db';
    var IDB_VERSION = 2;
    var IDB_STORE = 'logs';
    var _idbInstance = null;
    var _idbQueue = [];
    var _idbFlushTimer = null;
    var _idbOpening = false;

    function _idbOpen() {
        if (_idbInstance) {
            try { _idbInstance.objectStoreNames.contains(IDB_STORE); return Promise.resolve(_idbInstance); }
            catch (e) { _idbInstance = null; }
        }
        if (_idbOpening) return new Promise(function (r) { setTimeout(function () { r(_idbInstance); }, 200); });
        _idbOpening = true;
        return new Promise(function (resolve) {
            try {
                var req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = function (e) {
                    var db = e.target.result;
                    if (!db.objectStoreNames.contains('messages')) {
                        var s = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                        s.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(IDB_STORE)) {
                        var ls = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
                        ls.createIndex('timestamp', 'timestamp', { unique: false });
                        ls.createIndex('category', 'category', { unique: false });
                        ls.createIndex('cat_ts', ['category', 'timestamp'], { unique: false });
                    }
                };
                req.onsuccess = function (e) { _idbInstance = e.target.result; _idbOpening = false; resolve(_idbInstance); };
                req.onerror = function () { _idbOpening = false; resolve(null); };
            } catch (e) { _idbOpening = false; resolve(null); }
        });
    }

    function _idbWrite(category, entry) {
        _idbQueue.push({ timestamp: entry.timestamp, category: category, message: '[' + entry.source + '] ' + entry.args, level: entry.level });
        if (!_idbFlushTimer) _idbFlushTimer = setTimeout(_idbFlush, 300);
    }

    function _idbFlush() {
        _idbFlushTimer = null;
        if (_idbQueue.length === 0) return;
        var batch = _idbQueue.splice(0);
        _idbOpen().then(function (db) {
            if (!db) return;
            try {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                var store = tx.objectStore(IDB_STORE);
                for (var i = 0; i < batch.length; i++) store.add(batch[i]);
            } catch (e) { /* silently ignore */ }
        });
    }

    // Stringify arguments safely
    function stringifyArgs(args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) {
            try {
                if (typeof args[i] === 'string') {
                    parts.push(args[i]);
                } else if (args[i] instanceof Error) {
                    parts.push(args[i].message + (args[i].stack ? '\n' + args[i].stack : ''));
                } else {
                    parts.push(JSON.stringify(args[i]));
                }
            } catch (e) {
                parts.push('[unserializable]');
            }
        }
        return parts.join(' ');
    }

    // ─── MAIN WORLD MODE ───
    if (isMainWorld) {
        if (!window.__cor3ConsoleLogs) window.__cor3ConsoleLogs = [];
        var logs = window.__cor3ConsoleLogs;

        var origLog = console.log;
        var origWarn = console.warn;
        var origError = console.error;

        var _safeApply = (function () {
            try {
                return new Function('fn', 'ctx', 'a', 'try{fn.apply(ctx,a)}catch(e){}');
            } catch (e) {
                return function (fn, ctx, a) { try { fn.apply(ctx, a); } catch (e) {} };
            }
        })();

        function intercept(level, origFn) {
            return function () {
                _safeApply(origFn, console, displayArgs(arguments));
                var entry = {
                    timestamp: new Date().toISOString(),
                    level: level,
                    source: 'page',
                    args: stringifyArgs(arguments)
                };
                logs.push(entry);
                // Also persist to IndexedDB for DevTools panel / copy
                _idbWrite('page-console', entry);
                // Trim if over max
                while (logs.length > MAX_ENTRIES) logs.shift();
                // Purge old entries periodically
                var now = Date.now();
                if (now - _lastPurge > PURGE_INTERVAL) {
                    _lastPurge = now;
                    var cutoff = new Date(now - MAX_AGE).toISOString();
                    while (logs.length > 0 && logs[0].timestamp < cutoff) logs.shift();
                }
            };
        }

        console.log = intercept('log', origLog);
        console.warn = intercept('warn', origWarn);
        console.error = intercept('error', origError);
        for (var method of ['info', 'debug', 'dir', 'table', 'trace', 'group', 'groupCollapsed'])
            if (typeof console[method] === 'function') console[method] = intercept(method, console[method]);
        return;
    }

    // ─── EXTENSION CONTEXT MODE (content script, background, popup) ───
    if (!hasStorage) return; // bail if neither mode applies

    var STORAGE_KEY = 'cor3_console_logs';
    var _writeQueue = [];
    var _flushTimer = null;

    function flushQueue() {
        _flushTimer = null;
        if (_writeQueue.length === 0) return;
        var batch = _writeQueue.splice(0);
        try {
            chrome.storage.local.get(STORAGE_KEY, function (data) {
                try {
                    var existing = data[STORAGE_KEY] || [];
                    existing = existing.concat(batch);
                    // Purge old
                    var now = Date.now();
                    if (now - _lastPurge > PURGE_INTERVAL) {
                        _lastPurge = now;
                        var cutoff = new Date(now - MAX_AGE).toISOString();
                        while (existing.length > 0 && existing[0].timestamp < cutoff) existing.shift();
                    }
                    // Trim if over max
                    while (existing.length > MAX_ENTRIES) existing.shift();
                    var obj = {};
                    obj[STORAGE_KEY] = existing;
                    chrome.storage.local.set(obj);
                } catch (e) { /* extension context invalidated */ }
            });
        } catch (e) { /* extension context invalidated */ }
    }

    function scheduleFlush() {
        if (_flushTimer) return;
        _flushTimer = setTimeout(flushQueue, 500); // batch writes every 500ms
    }

    var origLog = console.log;
    var origWarn = console.warn;
    var origError = console.error;

    function intercept(level, origFn) {
        return function () {
            try { origFn.apply(console, displayArgs(arguments)); } catch (e) { /* DOMException from invalidated context */ }
            var entry = {
                timestamp: new Date().toISOString(),
                level: level,
                source: source,
                args: stringifyArgs(arguments)
            };
            _writeQueue.push(entry);
            scheduleFlush();
            // Also persist to IndexedDB for DevTools panel / copy
            // Only content scripts run on cor3.gg origin (same IndexedDB as the page)
            if (source === 'content') _idbWrite('ext-console', entry);
        };
    }

    console.log = intercept('log', origLog);
    console.warn = intercept('warn', origWarn);
    console.error = intercept('error', origError);
    for (var method of ['info', 'debug', 'dir', 'table', 'trace', 'group', 'groupCollapsed'])
        if (typeof console[method] === 'function') console[method] = intercept(method, console[method]);
})();
