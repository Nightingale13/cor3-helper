// content.js helpers — context check, automation queue
import { automationPaused } from '../shared/ws-utils.js';

window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'COR3_MANUAL_ACTIVITY') return;
    _broadcastQueueStatus();
    if (!event.data.paused) _automationProcessNext();
});

export function isContextValid() {
    try { return window.__cor3ContentOwnsAutomation !== false && !!chrome.runtime.id && !!chrome.runtime.getManifest(); } catch (e) { return false; }
}

// --- Automation Queue: prevents parallel endpoint-changing processes ---
let _automationQueue = [];
let _automationActive = null; // { type, startedAt }
let idleTimer = null;

function startAutomation(next) {
    clearTimeout(idleTimer);
    idleTimer = null;
    const active = { type: next.type, startedAt: Date.now() };
    _automationActive = active;
    _broadcastQueueStatus();
    function failed(error) {
        console.log('[COR3 Helper] Automation task stopped:', next.type, error.message);
        if (_automationActive === active) _automationFinish(next.type);
    }
    try { Promise.resolve(next.run()).catch(failed); } catch (error) { failed(error); }
}

export function _automationQueueStatus() {
    return {
        active: _automationActive ? _automationActive.type : null,
        startedAt: _automationActive?.startedAt || null,
        stopping: !!_automationActive?.stopping,
        queued: _automationQueue.map(q => q.type),
        pausedForUser: automationPaused()
    };
}

export function getAutomationActive() { return _automationActive; }
export function setAutomationActive(v) { _automationActive = v; }
export function getAutomationQueue() { return _automationQueue; }
export function setAutomationQueue(v) { _automationQueue = v; }

export function _broadcastQueueStatus() {
    if (!isContextValid()) return;
    try { chrome.storage.local.set({ automationQueueStatus: _automationQueueStatus() }); } catch (e) {}
}

export function _automationFinish(type) {
    if (_automationActive && _automationActive.type === type) {
        console.log('[COR3 Helper] Automation finished:', type);
        _automationActive = null;
        _broadcastQueueStatus();
        _automationProcessNext();
    }
}

export function _automationProcessNext() {
    if (!isContextValid()) return;
    if (_automationActive) return;
    if (_automationQueue.length === 0) {
        _broadcastQueueStatus();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (!isContextValid()) return;
            if (_automationActive || _automationQueue.length > 0) return;
            chrome.storage.local.get('expeditionsData', (result) => {
                if (result.expeditionsData) {
                    // Lazy import to avoid circular dependency
                    import('./auto-send.js').then(m => m.checkAutoSendOnExpeditionData(result.expeditionsData));
                }
            });
        }, 3000);
        return;
    }
    const index = automationPaused() ? _automationQueue.findIndex(q => q.type === 'auto-drone') : 0;
    if (index < 0) { _broadcastQueueStatus(); return; }
    var next = _automationQueue.splice(index, 1)[0];
    console.log('[COR3 Helper] Automation starting:', next.type);
    startAutomation(next);
}

export function _automationEnqueue(type, runFn) {
    if (_automationActive && _automationActive.type === type && !_automationActive.stopping) return 'already-running';
    if (_automationQueue.some(q => q.type === type)) return 'already-queued';
    if (!_automationActive && (!automationPaused() || type === 'auto-drone')) {
        console.log('[COR3 Helper] Automation starting:', type);
        startAutomation({ type, run: runFn });
        return 'started';
    }
    _automationQueue.push({ type: type, run: runFn });
    console.log('[COR3 Helper] Automation queued:', type, '(waiting for', _automationActive?.type || 'manual browsing', ')');
    _broadcastQueueStatus();
    return 'queued';
}
