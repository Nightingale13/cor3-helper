// Keep the user's daily automation preference enabled between tasks and retries.
import { isContextValid } from './helpers.js';
import { _initialFetchDone } from './auto-send.js';
import { injectDailyHackSolver, stopDailyHackSolver, dailyHackSolverFinished, ensureAntiAfkEnabled } from './solvers.js';
import { automationRetrySeconds } from '../shared/automation-recovery.js';

let setup = false;
let checking = false;
let active = false;
let generation = 0;
let failures = 0;
let timer = null;
let fetchController = null;
let connectionLost = false;

function log(message) {
    return chrome.storage.local.set({ dailyHackLog: message, dailyHackLogUpdatedAt: Date.now() });
}

function schedule(at) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; checkAutoDailyHack(); }, Math.max(1000, Math.min(at - Date.now(), 86400000)));
}

async function defer(seconds, message) {
    const at = Date.now() + seconds * 1000;
    await chrome.storage.local.set({ dailyHackNextCheckAt: at });
    await log(message);
    schedule(at);
}

function stop() {
    generation++;
    clearTimeout(timer);
    timer = null;
    fetchController?.abort();
    if (active) stopDailyHackSolver();
    // Wait for solver cleanup before another run may own the daily windows.
}

export async function checkAutoDailyHack() {
    if (!isContextValid() || !_initialFetchDone || checking || active) return;
    checking = true;
    const current = generation;
    try {
        const saved = await chrome.storage.sync.get(['autoDailyHackEnabled', 'helperMode']);
        if (!saved.autoDailyHackEnabled || saved.helperMode || current !== generation) return;
        const local = await chrome.storage.local.get(['bearerToken', 'dailyHackNextCheckAt', 'dailyOpsData', 'dailyHackLog']);
        if (current !== generation) return;
        if (local.dailyHackNextCheckAt > Date.now()) {
            const next = new Date(local.dailyOpsData?.nextTaskTime).getTime();
            if (local.dailyOpsData?.hasClaimedToday && (!Number.isFinite(next) || next > Date.now()))
                await log('Daily already completed. Waiting for the next daily task.');
            else if (/^(Starting daily hack solver|Waiting for the game connection)/.test(local.dailyHackLog || ''))
                await log('Waiting for the next daily task check.');
            schedule(local.dailyHackNextCheckAt); return;
        }
        if (!local.bearerToken) {
            await defer(60, 'Waiting for the game connection before checking the daily task.');
            return;
        }
        fetchController = new AbortController();
        await log('Checking today’s daily task…');
        const timeout = setTimeout(() => fetchController?.abort(), 15000);
        let data;
        try {
            const response = await fetch('https://svc-corie.cor3.gg/api/user-daily-claim', {
                headers: { Authorization: local.bearerToken }, signal: fetchController.signal
            });
            if (!response.ok) throw new Error('Daily task check failed (' + response.status + ').');
            data = await response.json();
            if (typeof data?.hasClaimedToday !== 'boolean') throw new Error('Daily task availability was not confirmed.');
        } finally {
            clearTimeout(timeout);
            fetchController = null;
        }
        if (current !== generation) return;
        await chrome.storage.local.set({ dailyOpsData: data, dailyOpsUpdatedAt: Date.now(), dailyOpsError: null });
        failures = 0;
        if (data.hasClaimedToday) {
            const next = new Date(data.nextTaskTime).getTime();
            const seconds = Number.isFinite(next) && next > Date.now() ? Math.ceil((next - Date.now()) / 1000) + 1 : 300;
            await defer(seconds, 'Daily already completed. Waiting for the next daily task.');
            return;
        }
        // The player may turn automation off while the availability request is in flight.
        const latest = await chrome.storage.sync.get(['autoDailyHackEnabled', 'helperMode']);
        if (!latest.autoDailyHackEnabled || latest.helperMode || current !== generation) return;
        ensureAntiAfkEnabled();
        await log('Starting daily hack solver…');
        if (current !== generation) return;
        active = true;
        try { await injectDailyHackSolver(); }
        catch (error) { active = false; throw error; }
    } catch (error) {
        if (current === generation) await defer(automationRetrySeconds(++failures), 'Daily automation will retry: ' + error.message);
    } finally {
        checking = false;
        if (current !== generation) checkAutoDailyHack();
    }
}

export function setupAutoDailyHack() {
    if (setup) return;
    setup = true;
    window.addEventListener('message', event => {
        if (event.source !== window) return;
        const type = event.data?.type;
        if (type === 'COR3_DAILY_HACK_FINISHED' && active) {
            active = false;
            dailyHackSolverFinished();
            const done = event.data;
            if (done.aborted) { checkAutoDailyHack(); return; }
            defer(300, done.success ? 'Daily hack completed. Waiting for the next daily task.'
                : 'Daily hack could not finish. Retrying automatically in 5 minutes.');
        } else if (type === 'COR3_INITIAL_FETCH_DONE') {
            connectionLost = false;
            checkAutoDailyHack();
        } else if (type === 'COR3_TOKEN_EXPIRED' || type === 'COR3_CONNECTION_LOST') {
            connectionLost = true;
            stop();
            chrome.storage.sync.get(['autoDailyHackEnabled', 'helperMode']).then(saved => {
                if (connectionLost && saved.autoDailyHackEnabled && !saved.helperMode)
                    log('Waiting for the game connection before checking the daily task.');
            });
        }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || (!changes.autoDailyHackEnabled && !changes.helperMode)) return;
        stop();
        failures = 0;
        chrome.storage.local.remove('dailyHackNextCheckAt').then(() => checkAutoDailyHack());
    });
    window.addEventListener('online', () => checkAutoDailyHack());
    // Timers may be throttled in background tabs; always check real server state on wake.
    setInterval(checkAutoDailyHack, 60000);
    checkAutoDailyHack();
}
