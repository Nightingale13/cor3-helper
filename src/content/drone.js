// Drone automation shares the endpoint queue with mercenaries and auto-jobs.
import { isContextValid, _automationEnqueue, _automationFinish } from './helpers.js';
import { _initialFetchDone } from './auto-send.js';
import { droneSettings, dronePlan, isDroneRepairStateConflict } from '../shared/drone-policy.js';
import { currentDroneDecision, isSupersededDroneEvent } from '../shared/drone-events.js';
import { decisionReady, bestDecisionOption } from '../shared/decision-policy.js';
import { waitForGameReply, collectRewardMail } from './expedition-mail.js';
import { freeMailSpace } from './inventory-space.js';
import { mergeDroneHistory, historyItems } from '../shared/drone-history.js';
import { isDroneResponseTimeout, droneRetrySeconds, isDroneRewardCollectionError, isDroneStateRecheckError } from '../shared/drone-recovery.js';
import { isTransientAutomationError, isInternalServerError, isServerShutdownError, isInsufficientCredits } from '../shared/automation-recovery.js';

let running = null;
let cooldownUntil = 0;
let responseRetries = 0;
let retryTimer = null;
let droneWaitTimer = null;
let refreshPending = false;
let creditBalance = null;
let chargingRepairCreditBlocked = false;
let pendingManualDecision = null;
let eventWrite = Promise.resolve();
let historyWrite = Promise.resolve();
let droneOptionsWrite = Promise.resolve();

function rememberDroneHistory(remote, observed = []) {
    // Serialize history writes so a server refresh cannot race a completion push.
    historyWrite = historyWrite.then(async () => {
        const local = await chrome.storage.local.get('droneArchivedData');
        const items = mergeDroneHistory(remote, mergeDroneHistory(observed, local.droneArchivedData));
        await chrome.storage.local.set({ droneArchivedData: { items }, droneArchivedUpdatedAt: Date.now() });
    }).catch(error => console.log('[COR3 Helper] Drone history update failed:', error.message));
}

function status(message, state = 'waiting', seconds = null, phase = null) {
    return chrome.storage.local.set({ droneStatus: { message, state, phase, until: seconds > 0 ? Date.now() + seconds * 1000 : null } });
}

export function stopAutoDrone() {
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(droneWaitTimer);
    droneWaitTimer = null;
    responseRetries = 0;
    cooldownUntil = 0;
    if (running) running.abort();
    // The cycle's finally block releases its queue slot after cancellation.
}

async function command(action, data, signal) {
    let reply;
    try {
        reply = await waitForGameReply('COR3_WS_DRONE_RESULT', {
            type: 'COR3_DRONE_COMMAND', action, data
        }, signal, result => result.action === action);
    } catch (error) {
        throw Object.assign(error, { action });
    }
    if (reply.error) throw Object.assign(new Error(reply.error.message || reply.error.code || String(reply.error)), { action, code: reply.error.code });
    if (!reply.data) throw Object.assign(new Error('Drone ' + action + ' returned no confirmation.'), { action, code: 'game_reply_timeout' });
    return reply.data;
}

function retryAfterResponseFailure(error) {
    const seconds = droneRetrySeconds(++responseRetries);
    cooldownUntil = Date.now() + seconds * 1000;
    const rewardFailure = isDroneRewardCollectionError(error) || error.action === 'claim';
    const detail = rewardFailure ? (error.code === 'stash_full' ? 'Waiting for stash space for drone rewards' : 'Unable to collect drone rewards') :
        error.code === 'socket_unavailable' ? 'Waiting for the game connection' :
        error.code === 'request_queue_full' ? 'Game connection is busy' : isDroneResponseTimeout(error) ? 'No response' :
            isDroneStateRecheckError(error) ? 'Waiting for updated drone state' :
            isInternalServerError(error) ? 'Game server error' : isServerShutdownError(error) ? 'Game server unavailable' : 'Rate limited';
    status(detail + (rewardFailure ? '' : error.action ? ' from drone ' + error.action : ' while collecting drone rewards') +
        '. Rechecking current state in ' + seconds + ' seconds.', 'waiting', seconds, 'retry');
    console.log('[COR3 Helper] Drone retry scheduled:', error.action || error.replyType, error.message, seconds);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; checkAutoDrone(); }, seconds * 1000);
}

async function collectDroneRewards(signal) {
    try {
        await collectRewardMail({ source: 'DRONE_MISSION', signal, freeSpace: freeMailSpace });
    } catch (error) {
        // Mail failures must never persist a pause requiring the player to resume dispatch.
        throw Object.assign(error, { rewardCollection: true });
    }
}

function storeDroneOptions(data, repairChanges = {}, complete = false) {
    const write = droneOptionsWrite.then(async () => {
        const saved = await chrome.storage.local.get(['droneData', 'droneDataUpdatedAt', 'droneBatteryUpdatedAt', 'droneRepairUpdatedAt']);
        const previous = saved.droneData;
        // Repair replies can omit the battery and mission fields; they are not new battery readings.
        const sameDrone = data?.drone && (!data.drone.id || !previous?.drone?.id || data.drone.id === previous.drone.id);
        const next = !complete && sameDrone ? { ...previous, ...data, drone: { ...previous?.drone, ...data.drone } } : data;
        const sameBattery = previous?.drone?.id === next?.drone?.id && previous?.activeMissionId === next?.activeMissionId &&
            ['current', 'max', 'restorePerHour', 'restoreSeconds'].every(key => previous?.battery?.[key] === next?.battery?.[key]);
        const sameRepair = ['id', 'durability', 'maxDurability', 'isRepairing', 'repairSecondsRemaining'].every(key => previous?.drone?.[key] === next?.drone?.[key]) &&
            ['startDurability', 'targetDurability', 'totalSeconds', 'secondsRemaining'].every(key => previous?.drone?.repair?.[key] === next?.drone?.repair?.[key]);
        const now = Date.now();
        const batteryUpdatedAt = sameBattery ? saved.droneBatteryUpdatedAt ?? saved.droneDataUpdatedAt ?? now : now;
        const repairUpdatedAt = sameRepair ? saved.droneRepairUpdatedAt ?? saved.droneDataUpdatedAt ?? now : now;
        await chrome.storage.local.set({ droneData: next, droneDataUpdatedAt: now, droneBatteryUpdatedAt: batteryUpdatedAt,
            droneRepairUpdatedAt: repairUpdatedAt,
            ...(!next?.drone?.isRepairing ? { droneRepairWhileCharging: false, droneRepairPlan: null } : {}), ...repairChanges });
    });
    droneOptionsWrite = write.catch(error => console.log('[COR3 Helper] Drone data update failed:', error.message));
    return write;
}

async function options(signal) {
    const data = await command('get.options', {}, signal);
    await storeDroneOptions(data, {}, true);
    return data;
}

async function pause(message, signal) {
    if (signal.aborted) return;
    const saved = await chrome.storage.sync.get('autoDrone');
    if (signal.aborted || !droneSettings(saved.autoDrone).enabled) return;
    status(message, 'paused');
    await chrome.storage.sync.set({ autoDrone: { ...saved.autoDrone, paused: true } });
}

async function retireDecision(decision, reason) {
    const write = eventWrite.then(async () => {
        const local = await chrome.storage.local.get(['droneRetiredEvents', 'droneEvents']);
        const retired = (local.droneRetiredEvents || []).filter(entry =>
            entry.missionId !== decision.expeditionId || entry.eventId !== decision.messageId);
        retired.push({ missionId: decision.expeditionId, eventId: decision.messageId, reason });
        const events = { ...local.droneEvents };
        delete events[decision.messageId];
        await chrome.storage.local.set({ droneRetiredEvents: retired.slice(-100), droneEvents: events, droneDecisionError: null });
    });
    eventWrite = write.catch(() => {});
    await write;
}

async function recoverStalePause(saved) {
    const cfg = droneSettings(saved.autoDrone);
    if (saved.helperMode || !cfg.enabled || !cfg.paused) return saved;
    const local = await chrome.storage.local.get(['droneStatus', 'droneMissionData', 'droneEvents', 'droneDecisionError']);
    const message = local.droneStatus?.message;
    // Older builds persisted recoverable races, timeouts and mail failures as permanent pauses.
    if (local.droneStatus?.state !== 'paused' || (!message?.startsWith('Drone automation paused: ') && !isDroneStateRecheckError({ message })) ||
        (!isSupersededDroneEvent({ message }) && !isDroneRepairStateConflict({ message }) && !isDroneStateRecheckError({ message }) &&
            !isDroneResponseTimeout({ message }) && !isDroneRewardCollectionError({ message }) &&
            !isTransientAutomationError({ message: message.replace(/^Drone automation paused:\s*/, '') }))) return saved;
    const eventId = /\bEvent\s+(\S+)\s+has expired\b/i.exec(message)?.[1];
    const missionId = local.droneEvents?.[eventId]?.missionId ||
        (local.droneMissionData?.channelEvents?.some(event => event.eventId === eventId) ? local.droneMissionData.id : null);
    if (eventId && missionId) await retireDecision({ expeditionId: missionId, messageId: eventId }, 'superseded');
    if (isDroneResponseTimeout({ message: local.droneDecisionError }) || isTransientAutomationError({ message: local.droneDecisionError }))
        await chrome.storage.local.set({ droneDecisionError: null });
    // Re-read settings so recovery cannot turn on a drone the player just disabled.
    const latest = await chrome.storage.sync.get(['autoDrone', 'helperMode', 'decisionModifiers']);
    const latestCfg = droneSettings(latest.autoDrone);
    if (latest.helperMode || !latestCfg.enabled || !latestCfg.paused) return latest;
    await status('Checking drone status…');
    latest.autoDrone = { ...latest.autoDrone, paused: false };
    await chrome.storage.sync.set({ autoDrone: latest.autoDrone });
    return latest;
}

async function resolveCurrentDecision(data, signal, manual) {
    await eventWrite;
    const local = await chrome.storage.local.get(['droneMissionData', 'droneMissionEventsUpdatedAt', 'droneEvents', 'droneRetiredEvents']);
    const decision = currentDroneDecision(data, local.droneMissionData, local.droneEvents, local.droneRetiredEvents, local.droneMissionEventsUpdatedAt);
    if (!decision || (manual && (manual.missionId !== decision.expeditionId || manual.eventId !== decision.messageId))) return;
    const saved = await chrome.storage.sync.get(['decisionModifiers', 'helperMode']);
    if (saved.helperMode || (!manual && !decisionReady(decision, saved.decisionModifiers))) return;
    const choice = manual ? decision.decisionOptions.find(option => option.id === manual.optionId && !option.unavailable)
        : bestDecisionOption(decision, saved.decisionModifiers);
    if (!choice) return;
    try {
        await command('resolve.event', { missionId: decision.expeditionId, eventId: decision.messageId, optionId: choice.id }, signal);
        await retireDecision(decision, 'resolved');
    } catch (error) {
        if (isDroneResponseTimeout(error) || isInternalServerError(error) || isServerShutdownError(error)) {
            // A lost reply or server failure does not prove the choice failed. Wait for a fresh server event.
            await retireDecision(decision, 'unconfirmed');
            throw error;
        }
        if (isSupersededDroneEvent(error)) {
            await retireDecision(decision, 'superseded');
            await options(signal);
            return;
        }
        if (isTransientAutomationError(error)) throw error;
        chrome.storage.local.set({ droneDecisionError: error.message });
        throw error;
    }
}

export function requestDroneDecision(request) {
    if (![request.missionId, request.eventId, request.optionId].every(value => typeof value === 'string' && value)) return;
    pendingManualDecision = request;
    if (running) refreshPending = true; else checkAutoDrone();
}

async function cycle(controller) {
    const signal = controller.signal;
    let responseFailed = false;
    try {
        const saved = await chrome.storage.sync.get(['autoDrone', 'helperMode', 'decisionModifiers']);
        const cfg = droneSettings(saved.autoDrone);
        const automateFlight = cfg.enabled && !cfg.paused;
        const manual = pendingManualDecision;
        pendingManualDecision = null;
        if (saved.helperMode || (!automateFlight && saved.decisionModifiers?.autoChoose === false && !manual) || !_initialFetchDone || signal.aborted) return;
        let data = await options(signal);
        // Mail collection remains independent of mercenary funding and drone flight state.
        if (automateFlight) {
            status('Checking drone reward mail…', 'waiting', null, 'collecting');
            await collectDroneRewards(signal);
        }
        const local = await chrome.storage.local.get(['droneCompleted', 'droneMissionData', 'droneEvents']);
        if (data.activeMissionId) {
            const missionId = data.activeMissionId;
            const mission = local.droneMissionData?.id === missionId ? local.droneMissionData : null;
            const completed = local.droneCompleted?.missionId === missionId || mission?.status === 'COMPLETED';
            if (!completed) {
                await resolveCurrentDecision(data, signal, manual);
                if (automateFlight) status('Drone expedition in progress. Waiting for its return.', 'active');
                return;
            }
            if (!automateFlight) return;
            status('Finalizing drone rewards…', 'waiting', null, 'collecting');
            await command('claim', { missionId }, signal);
            data = await options(signal);
            if (data.activeMissionId) {
                status('Waiting for the completed drone mission to leave the active slot.');
                return;
            }
            await chrome.storage.local.remove(['droneCompleted', 'droneEvents']);
            status('Collecting drone reward mail…', 'waiting', null, 'collecting');
            await collectDroneRewards(signal);
        }
        if (!automateFlight) return;
        data = await options(signal); // protects against manual launches/repairs during collection
        await runDronePlan(data, cfg, signal);
    } catch (error) {
        if (signal.aborted || error.name === 'AbortError') return;
        console.log('[COR3 Helper] Drone request failed:', error.action || error.replyType || 'unknown action', error.code || '', error.message);
        if (isTransientAutomationError(error) || isDroneStateRecheckError(error) || isDroneRewardCollectionError(error) || error.action === 'claim') {
            responseFailed = true;
            retryAfterResponseFailure(error);
        } else if (isInsufficientCredits(error)) {
            status('Waiting for credits to repair the drone. Retrying automatically.', 'waiting', 60, 'credits');
            cooldownUntil = Date.now() + 60000;
        } else {
            await pause('Drone automation paused: ' + error.message, signal);
        }
    } finally {
        if (!responseFailed && !signal.aborted) responseRetries = 0;
        if (running === controller) running = null;
        _automationFinish('auto-drone');
        if (refreshPending) { refreshPending = false; checkAutoDrone(); }
    }
}

async function runDronePlan(data, cfg, signal, allowRepair = true) {
    clearTimeout(droneWaitTimer);
    droneWaitTimer = null;
    const plan = dronePlan(data, chargingRepairCreditBlocked ? { ...cfg, repairWhileCharging: false } : cfg, creditBalance);
    if (plan.type === 'pause') { await pause(plan.message, signal); return; }
    if (plan.type === 'wait') {
        status(plan.message, 'waiting', plan.seconds, plan.phase);
        if (Number.isFinite(plan.seconds) && plan.seconds >= 0 && plan.seconds <= 60) {
            droneWaitTimer = setTimeout(() => { droneWaitTimer = null; checkAutoDrone(); }, Math.max(5000, plan.seconds * 1000));
        }
        return;
    }
    if (plan.type === 'active') { status('Drone expedition in progress.', 'active'); return; }
    if (plan.type === 'repair') {
        if (!allowRepair) {
            status('Waiting for updated drone durability. Retrying automatically.');
            return;
        }
        status((plan.opportunistic ? 'Repairing while charging' : 'Starting drone repair') + ' (' + plan.cost.toLocaleString() + ' CR)…');
        const repairStartedAt = Date.now();
        const repairPlan = { mode: plan.opportunistic ? 'charging' : 'target', droneId: data.drone.id,
            startDurability: data.drone.durability,
            targetDurability: plan.targetDurability,
            targetPercent: plan.opportunistic ? Math.round(plan.targetDurability / data.drone.maxDurability * 100) : cfg.repairTarget,
            startedAt: repairStartedAt, endsAt: repairStartedAt + plan.seconds * 1000 };
        // Save the requested duration: the server's remaining time may describe a full repair.
        await chrome.storage.local.set({ droneRepairPlan: repairPlan, droneRepairWhileCharging: !!plan.opportunistic });
        let result;
        try {
            result = await command('repair', { targetDurability: plan.targetDurability }, signal);
        } catch (error) {
            // A lost reply or server failure may still have started the repair; retain its target for reconciliation.
            if (!isDroneResponseTimeout(error) && !isInternalServerError(error) && !isServerShutdownError(error)) await chrome.storage.local.set({ droneRepairPlan: null, droneRepairWhileCharging: false });
            if (isDroneRepairStateConflict(error)) {
                // Durability may reach the requested target between options and repair.
                // Re-plan from the server state; never immediately retry a stale repair.
                const latest = await options(signal);
                await runDronePlan(latest, cfg, signal, false);
                return;
            }
            if (plan.opportunistic && isInsufficientCredits(error)) {
                chargingRepairCreditBlocked = true;
                status('Charging. Optional repair skipped because credits are insufficient.');
                return;
            }
            throw error;
        }
        const confirmed = result.drone ? { ...data, ...result } : await options(signal);
        if (!confirmed.drone?.isRepairing && !(confirmed.drone?.durability >= plan.targetDurability)) {
            throw new Error('Drone repair was not confirmed.');
        }
        await storeDroneOptions(confirmed, {
            droneRepairWhileCharging: !!plan.opportunistic && !!confirmed.drone?.isRepairing,
            droneRepairPlan: confirmed.drone?.isRepairing ? repairPlan : null });
        status(plan.opportunistic ? 'Repairing while the battery charges.' : 'Repair in progress.',
            'waiting', plan.opportunistic ? plan.chargingSeconds : Math.max(0, (repairPlan.endsAt - Date.now()) / 1000));
        return;
    }
    status('Launching ' + plan.mission.name + '…', 'waiting', null, 'launching');
    const launched = await command('launch', {
        locationConfigId: plan.mission.locationConfigId, missionConfigId: plan.mission.id
    }, signal);
    const latest = await options(signal);
    if (!latest.activeMissionId || (launched.id && latest.activeMissionId !== launched.id)) {
        throw new Error('Drone launch was not confirmed by the active mission state.');
    }
    await chrome.storage.local.remove(['droneCompleted', 'droneEvents']);
    status('Drone expedition in progress: ' + plan.mission.name, 'active');
}

export async function checkAutoDrone() {
    if (!isContextValid() || !_initialFetchDone || running || Date.now() < cooldownUntil) return;
    const saved = await recoverStalePause(await chrome.storage.sync.get(['autoDrone', 'helperMode', 'decisionModifiers']));
    const cfg = droneSettings(saved.autoDrone);
    if (saved.helperMode || ((!cfg.enabled || cfg.paused) && saved.decisionModifiers?.autoChoose === false && !pendingManualDecision) || running || !_initialFetchDone) return;
    _automationEnqueue('auto-drone', () => {
        const controller = new AbortController();
        running = controller;
        cycle(controller);
    });
}

export function setupDrone() {
    window.addEventListener('message', event => {
        if (event.source !== window || !isContextValid()) return;
        const { type, data } = event.data || {};
        if (type === 'COR3_AUTOJOB_PROFILE_CREDITS' && Number.isFinite(data?.newBalance)) {
            creditBalance = data.newBalance;
            if (data.amount > 0) chargingRepairCreditBlocked = false;
        } else if (type === 'COR3_WS_DRONE_OPTIONS') {
            storeDroneOptions(data, {}, event.data.action === 'get.options');
        } else if (type === 'COR3_WS_DRONE_MISSION') {
            chrome.storage.local.get(['droneMissionData', 'droneMissionEventsUpdatedAt'], local => {
                const mission = local.droneMissionData?.id === data.id ? { ...local.droneMissionData, ...data } : data;
                chrome.storage.local.set({ droneMissionData: mission, droneMissionUpdatedAt: Date.now(),
                    droneMissionEventsUpdatedAt: Array.isArray(data.channelEvents) ? Date.now() : local.droneMissionEventsUpdatedAt || 0 });
                if (['COMPLETED', 'FAILED', 'DESTROYED'].includes(mission.status)) rememberDroneHistory([], [mission]);
            });
            if (!running && ['launch', 'claim'].includes(event.data.action)) {
                window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.options', data: {} }, '*');
            }
        } else if (type === 'COR3_WS_DRONE_ARCHIVED') {
            if (Array.isArray(data) || Array.isArray(data?.items) || Array.isArray(data?.data)) rememberDroneHistory(historyItems(data));
        } else if (type === 'COR3_WS_DRONE_COMPLETED') {
            chrome.storage.local.set({ droneCompleted: data }, () => {
                if (running) refreshPending = true; else checkAutoDrone();
            });
            chrome.storage.local.get('droneMissionData', local => {
                const mission = local.droneMissionData?.id === data?.missionId ? local.droneMissionData : {};
                if (data?.missionId) rememberDroneHistory([], [{ ...mission, ...data, id: data.missionId,
                    status: data.status || 'COMPLETED', completedAt: data.completedAt || new Date().toISOString() }]);
            });
            if (!running) window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.options', data: {} }, '*');
        } else if (type === 'COR3_WS_DRONE_EVENT' && data?.event?.eventId) {
            const receivedAt = Date.now();
            eventWrite = eventWrite.then(async () => {
                const local = await chrome.storage.local.get('droneRetiredEvents');
                // An explicit unresolved event push is fresh evidence a timed-out choice can be retried.
                const retired = (local.droneRetiredEvents || []).filter(entry => !(entry.reason === 'unconfirmed' &&
                    entry.missionId === data.missionId && entry.eventId === data.event.eventId &&
                    data.event.isResolvable && !data.event.isResolved && !data.event.isExpired));
                await chrome.storage.local.set({ droneEvents: { [data.event.eventId]: { ...data, receivedAt } },
                    droneRetiredEvents: retired, droneDecisionError: null });
            }).then(() => { if (running) refreshPending = true; else checkAutoDrone(); });
        } else if (type === 'COR3_TOKEN_EXPIRED' || type === 'COR3_CONNECTION_LOST') {
            creditBalance = null;
            chargingRepairCreditBlocked = false;
            stopAutoDrone();
        } else if (type === 'COR3_INITIAL_FETCH_DONE') {
            if (responseRetries > 0) {
                clearTimeout(retryTimer);
                retryTimer = null;
                cooldownUntil = 0;
            }
            chrome.storage.sync.get(['autoDrone', 'helperMode', 'decisionModifiers'], saved => {
                const cfg = droneSettings(saved.autoDrone);
                if ((cfg.enabled || saved.decisionModifiers?.autoChoose !== false) && !saved.helperMode) checkAutoDrone();
                else window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.options', data: {} }, '*');
                window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.archived', data: { cursor: null, limit: 20 } }, '*');
            });
        }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.decisionModifiers) {
            if (running) refreshPending = true; else checkAutoDrone();
        }
        if (area === 'sync' && changes.helperMode) {
            if (changes.helperMode.newValue) stopAutoDrone();
            else checkAutoDrone();
        }
        if (area !== 'sync' || !changes.autoDrone) return;
        stopAutoDrone();
        cooldownUntil = 0;
        chargingRepairCreditBlocked = false;
        if (!changes.autoDrone.newValue?.enabled) status('Automatic drone expeditions are off.', 'off');
        else if (!changes.autoDrone.newValue.paused) status('Checking drone status…');
        if (running) refreshPending = true; else checkAutoDrone();
    });
    window.addEventListener('online', () => {
        if (!responseRetries) return;
        clearTimeout(retryTimer);
        retryTimer = null;
        cooldownUntil = 0;
        checkAutoDrone();
    });
    setInterval(checkAutoDrone, 60000);
}
