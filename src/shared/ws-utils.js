import { eventInteractionScope } from './interaction-scopes.js';

const manualActivity = new Map();
function activityFor(scope) {
    if (!manualActivity.has(scope)) manualActivity.set(scope, { paused: false, at: 0, total: 0 });
    return manualActivity.get(scope);
}
window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'COR3_MANUAL_ACTIVITY') return;
    const state = activityFor(event.data.scope || 'network');
    const paused = !!event.data.paused;
    if (paused === state.paused) return;
    if (paused) state.at = Date.now();
    else state.total += Date.now() - state.at;
    state.paused = paused;
});
if (typeof document !== 'undefined') window.postMessage({ type: 'COR3_MANUAL_ACTIVITY_QUERY' }, '*');

export function humanDelay() {
    return 800 + Math.floor(Math.random() * 700);
}

export function createSendCmd(messageType, owner) {
    messageType = messageType || 'COR3_AUTOJOB_CMD';
    return function sendCmd(cmd, data) {
        window.postMessage({ type: messageType, cmd: cmd, data: data || {}, ...(owner ? { owner } : {}) }, '*');
    };
}

var _mcChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
var _mcCallbacks = [];
if (_mcChannel) {
    _mcChannel.port1.onmessage = function () {
        var cbs = _mcCallbacks.slice();
        _mcCallbacks.length = 0;
        for (var i = 0; i < cbs.length; i++) cbs[i]();
    };
}

export function nextTick(fn) {
    if (_mcChannel) {
        _mcCallbacks.push(fn);
        _mcChannel.port2.postMessage(0);
    } else {
        setTimeout(fn, 0);
    }
}

var _safeTimeoutId = 0;
var _safeTimeouts = {};

// Only the conflicting resource's automation clock stops. Game clocks use real time.
export function automationNow(scope = 'network') {
    const state = activityFor(scope);
    return window.__cor3InteractionGuard?.now(scope) ??
        Date.now() - state.total - (state.paused ? Date.now() - state.at : 0);
}
export function automationPaused(scope = 'network') { return window.__cor3InteractionGuard?.isPaused(scope) ?? activityFor(scope).paused; }

export function safeTimeout(fn, ms, pauseOnManual = true, scope = 'network') {
    var id = ++_safeTimeoutId;
    const now = pauseOnManual ? () => automationNow(scope) : Date.now;
    var target = now() + ms;
    _safeTimeouts[id] = true;
    function tick() {
        if (!_safeTimeouts[id]) return;
        if (pauseOnManual && automationPaused(scope)) { setTimeout(tick, 250); return; }
        if (now() >= target) { delete _safeTimeouts[id]; fn(); return; }
        var rem = target - now();
        if (rem > 200) { setTimeout(function () { nextTick(tick); }, Math.min(rem - 50, 1000)); }
        else { nextTick(tick); }
    }
    nextTick(tick);
    return id;
}

export function safeClearTimeout(id) { delete _safeTimeouts[id]; }

// UI scheduling and watchdog callbacks may become due during manual browsing.
// Run them once the user is idle, without restarting their original delay.
export function userIdleTimeout(fn, ms, scope = 'network') {
    const id = ++_safeTimeoutId;
    _safeTimeouts[id] = true;
    function tick() {
        if (!_safeTimeouts[id]) return;
        if (automationPaused(scope)) { setTimeout(tick, 250); return; }
        delete _safeTimeouts[id];
        fn();
    }
    setTimeout(tick, ms);
    return id;
}

export function createDelay(abortFlagFn, scope = 'network') {
    return function delay(ms) {
        return new Promise(function (resolve, reject) {
            var target = automationNow(scope) + ms;
            function check() {
                if (abortFlagFn && abortFlagFn()) { reject(new Error('Aborted')); return; }
                if (automationPaused(scope)) { setTimeout(check, 250); return; }
                if (automationNow(scope) >= target) { resolve(); return; }
                var remaining = target - automationNow(scope);
                if (remaining > 200) {
                    setTimeout(function () { nextTick(check); }, Math.min(remaining - 50, 1000));
                } else {
                    nextTick(check);
                }
            }
            nextTick(check);
        });
    };
}

export function createWaitForEvent(abortFlagFn) {
    return function waitForEvent(eventType, timeoutMs) {
        timeoutMs = timeoutMs || 15000;
        const scope = eventInteractionScope(eventType);
        return new Promise(function (resolve, reject) {
            var done = false;
            var deadline = automationNow(scope) + timeoutMs;
            function handler(evt) {
                if (evt.data && evt.data.type === eventType) {
                    if (done) return;
                    done = true;
                    window.removeEventListener('message', handler);
                    resolve(evt.data);
                }
            }
            window.addEventListener('message', handler);
            function checkTimeout() {
                if (done) return;
                if (abortFlagFn && abortFlagFn()) {
                    done = true;
                    window.removeEventListener('message', handler);
                    reject(new Error('Aborted'));
                    return;
                }
                if (automationPaused(scope)) { setTimeout(checkTimeout, 250); return; }
                if (automationNow(scope) >= deadline) {
                    done = true;
                    window.removeEventListener('message', handler);
                    reject(new Error('Timeout waiting for ' + eventType));
                    return;
                }
                var remaining = deadline - automationNow(scope);
                if (remaining > 200) {
                    setTimeout(function () { nextTick(checkTimeout); }, Math.min(remaining - 50, 1000));
                } else {
                    nextTick(checkTimeout);
                }
            }
            nextTick(checkTimeout);
        });
    };
}

export function createLogger(prefix, messageType) {
    return function log(msg, level) {
        level = level || 'info';
        console.log(prefix, msg);
        window.postMessage({ type: messageType, msg: msg, level: level }, '*');
    };
}
