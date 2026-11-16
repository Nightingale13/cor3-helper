// MAIN-world ownership and user priority. Never infer ownership from window order.
import { commandInteractionScope } from '../shared/interaction-scopes.js';

export const APP_SELECTOR = '[data-sentry-component="Application"]';
const CLOSE_SELECTOR = '[data-component-name="close-app-btn"]';
const MANUAL_IDLE_MS = 2000;
const owners = new Map();
const claimedByUser = new WeakSet();
const activity = new Map();
const pointers = new Map();
const appScopes = new WeakMap();
let recentInput = null;
let installed = false;

function applications() {
    return typeof document === 'undefined' ? [] : [...document.querySelectorAll(APP_SELECTOR)];
}
function appId(app) { return (app.getAttribute('data-component-name') || '').replace(/^Application-/, ''); }
function appScope(app) { return 'app:' + appId(app); }
function stateFor(scope) {
    if (!activity.has(scope)) activity.set(scope, { until: 0, pausedAt: null, total: 0 });
    return activity.get(scope);
}
function scopesForApp(app) {
    const scopes = new Set([appScope(app), ...(appScopes.get(app) || [])]);
    // Recognize the window itself, never text in its documents or file contents.
    const heading = app.querySelector?.('h1, h2, [role="heading"]');
    const label = appId(app) + ' ' + (heading?.textContent || '');
    if (/network[ _-]?map|market|\bsai\b/i.test(label) ||
        app.querySelector?.('video[src*="/video/network-map/"]')) scopes.add('network');
    if (/loadout|hardware|software/i.test(label)) scopes.add('loadout');
    return [...scopes];
}
function held(scope) { return [...pointers.values()].some(input => input.app?.isConnected && input.scopes.includes(scope)); }

export function noteManualActivity(scope = 'network') {
    isInteractionPaused(scope);
    stateFor(scope).until = Date.now() + MANUAL_IDLE_MS;
    isInteractionPaused(scope);
}

export function isInteractionPaused(scope = 'network') {
    if (Array.isArray(scope)) return scope.map(id => isInteractionPaused('app:' + id)).some(Boolean);
    const state = stateFor(scope);
    const paused = held(scope) || Date.now() < state.until;
    if (paused && state.pausedAt === null) {
        state.pausedAt = Date.now();
        window.postMessage({ type: 'COR3_MANUAL_ACTIVITY', scope, paused: true }, '*');
    } else if (!paused && state.pausedAt !== null) {
        state.total += Math.max(0, Math.min(Date.now(), state.until) - state.pausedAt);
        state.pausedAt = null;
        window.postMessage({ type: 'COR3_MANUAL_ACTIVITY', scope, paused: false }, '*');
    }
    return paused;
}

export function automationNow(scope = 'network') {
    isInteractionPaused(scope);
    const state = stateFor(scope);
    return Date.now() - state.total - (state.pausedAt === null ? 0 : Date.now() - state.pausedAt);
}

// Learn opaque application IDs only from requests accompanying real user input.
// Background polling and synthetic helper clicks cannot renew these pauses.
export function noteManualCommand(command) {
    if (!recentInput?.app?.isConnected || Date.now() - recentInput.at > 1000) return;
    const scope = commandInteractionScope(command?.event?.name);
    if (!scope) return;
    const scopes = appScopes.get(recentInput.app) || new Set();
    scopes.add(scope);
    appScopes.set(recentInput.app, scopes);
    for (const input of pointers.values()) if (input.app === recentInput.app && !input.scopes.includes(scope)) input.scopes.push(scope);
    noteManualActivity(scope);
    recentInput = null;
}

export function createWindowOwner(allowedIds) {
    const existing = new WeakSet(applications());
    const owned = new Set();
    let opening = false;
    function scan() {
        if (!opening) return;
        for (const app of applications()) {
            if (!existing.has(app) && !claimedByUser.has(app) && allowedIds.includes(appId(app))) {
                owners.set(app, owned);
                owned.add(app);
            }
        }
    }
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return {
        beginOpen() { opening = true; },
        endOpen() { scan(); opening = false; },
        owns(element) { scan(); return owners.get(element.closest(APP_SELECTOR)) === owned; },
        async close(count = Infinity) {
            scan();
            for (const app of [...owned].reverse()) {
                if (count <= 0) break;
                // Recheck after every close: a user's click permanently relinquishes ownership.
                if (!app.isConnected || owners.get(app) !== owned || isInteractionPaused(appScope(app))) continue;
                const close = app.querySelector(CLOSE_SELECTOR);
                if (close) { close.click(); count--; }
                owners.delete(app);
                owned.delete(app);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        },
        dispose() {
            observer.disconnect();
            for (const app of owned) if (owners.get(app) === owned) owners.delete(app);
            owned.clear();
        }
    };
}

export function installInteractionGuard() {
    if (installed) return;
    installed = true;
    function onUserInput(event) {
        if (!event.isTrusted || (event.type === 'pointermove' && !event.buttons)) return;
        const previous = pointers.get(event.pointerId);
        const app = previous?.app || event.target?.closest?.(APP_SELECTOR);
        if (!app) return;
        claimedByUser.add(app); owners.delete(app);
        const scopes = scopesForApp(app);
        if (event.type === 'pointerdown') pointers.set(event.pointerId, { app, scopes });
        const input = recentInput = { app, at: Date.now() };
        // Only requests originating in this input event may identify its window.
        setTimeout(() => { if (recentInput === input) recentInput = null; }, 0);
        for (const scope of scopes) noteManualActivity(scope);
    }
    for (const type of ['pointerdown', 'pointermove', 'click', 'contextmenu', 'keydown', 'wheel'])
        document.addEventListener(type, onUserInput, { capture: true, passive: true });
    function release(event) {
        if (!event.isTrusted) return;
        const input = pointers.get(event.pointerId);
        if (!input) return;
        for (const scope of input.scopes) noteManualActivity(scope);
        pointers.delete(event.pointerId);
    }
    for (const type of ['pointerup', 'pointercancel'])
        document.addEventListener(type, release, { capture: true, passive: true });
    function releaseAll() {
        for (const input of pointers.values()) for (const scope of input.scopes) noteManualActivity(scope);
        pointers.clear();
        recentInput = null;
    }
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') releaseAll(); });
    // Shared with injected solvers; isolated content scripts receive the status message.
    window.__cor3InteractionGuard = { isPaused: isInteractionPaused, now: automationNow, createWindowOwner };
    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.type !== 'COR3_MANUAL_ACTIVITY_QUERY') return;
        for (const scope of activity.keys()) window.postMessage({ type: 'COR3_MANUAL_ACTIVITY', scope, paused: isInteractionPaused(scope) }, '*');
    });
    setInterval(() => { for (const scope of activity.keys()) isInteractionPaused(scope); }, 250);
}
