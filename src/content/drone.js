// Launches and rewards share the endpoint queue; live decisions act independently.
import { isContextValid, _automationEnqueue, _automationFinish } from './helpers.js';
import { _initialFetchDone } from './auto-send.js';
import { droneSettings, dronePlan, isDroneRepairStateConflict, matchesRejectedDroneRepair, droneOptionsAfterUpdate, awaitingConfirmedDroneRepair } from '../shared/drone-policy.js';
import { currentDroneDecision, isSupersededDroneEvent } from '../shared/drone-events.js';
import { decisionReady, bestDecisionOption } from '../shared/decision-policy.js';
import { waitForGameReply, collectPendingRewardMail, noteRewardCompletion, hasRewardMailToCollect } from './expedition-mail.js';
import { freeMailSpace } from './inventory-space.js';
import { mergeDroneHistory, historyItems } from '../shared/drone-history.js';
import { isDroneResponseTimeout, droneRetrySeconds, isDroneRewardCollectionError, isDroneStateRecheckError } from '../shared/drone-recovery.js';
import { isTransientAutomationError, isInternalServerError, isServerShutdownError, isInsufficientCredits, isRateLimitError } from '../shared/automation-recovery.js';
import { DRONE_AVAILABILITY_CHECK_MS, isDroneUnavailableError } from '../shared/drone-availability.js';
import { reportActivity } from '../shared/activity-event.js';
import { mergeRepairDiagnostics } from '../shared/drone-repair-diagnostics.js';

let running = null;
let cooldownUntil = 0;
let rateLimitUntil = 0;
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
let diagnosticWrite = Promise.resolve();
const decisionAttempts = new Map();
let decisionTimer = null;

function scheduleDecisionCheck(at) {
    clearTimeout(decisionTimer);
    decisionTimer = setTimeout(() => { decisionTimer = null; checkDroneDecision(); }, Math.max(1, at - Date.now()));
}

function cancelDroneChoices(automaticOnly = false) {
    clearTimeout(decisionTimer);
    decisionTimer = null;
    for (const attempt of decisionAttempts.values()) {
        if (!automaticOnly || attempt.automatic) attempt.controller.abort();
    }
}

async function checkDroneDecision(manual = null) {
    if (!isContextValid() || !_initialFetchDone) return;
    await droneOptionsWrite;
    const { droneData } = await chrome.storage.local.get('droneData');
    if (!droneData?.activeMissionId) return false;
    try {
        await resolveCurrentDecision(droneData, new AbortController().signal, manual);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.log('[COR3 Helper] Drone choice was not confirmed:', error.message);
        if (isTransientAutomationError(error)) {
            status('Drone decision could not be sent. Waiting before trying again.', 'waiting');
        }
    }
    return true;
}

function rememberDroneHistory(remote, observed = []) {
    // Serialize history writes so a server refresh cannot race a completion push.
    historyWrite = historyWrite.then(async () => {
        const local = await chrome.storage.local.get('droneArchivedData');
        const items = mergeDroneHistory(remote, mergeDroneHistory(observed, local.droneArchivedData));
        await chrome.storage.local.set({ droneArchivedData: { items }, droneArchivedUpdatedAt: Date.now() });
    }).catch(error => console.log('[COR3 Helper] Drone history update failed:', error.message));
}

function status(message, state = 'waiting', seconds = null, phase = null) {
    return chrome.storage.local.set({ droneStatus: { message, state, phase, at: Date.now(), until: seconds > 0 ? Date.now() + seconds * 1000 : null } });
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
    return action === 'repair' ? { ...reply.data, helperActivityCost: reply.activityCost } : reply.data;
}

function retryAfterResponseFailure(error) {
    const rateLimited = isRateLimitError(error);
    const seconds = Math.max(rateLimited ? 60 : 0, droneRetrySeconds(++responseRetries));
    cooldownUntil = Date.now() + seconds * 1000;
    if (rateLimited) rateLimitUntil = Math.max(rateLimitUntil, cooldownUntil);
    const rewardFailure = isDroneRewardCollectionError(error) || error.action === 'claim';
    const detail = rewardFailure ? (error.code === 'stash_full' ? 'Waiting for stash space for drone rewards' : 'Unable to collect drone rewards') :
        error.code === 'socket_unavailable' ? 'Waiting for the game connection' :
        error.code === 'request_queue_full' ? 'Game connection is busy' : isDroneResponseTimeout(error) ? 'No response' :
            isDroneStateRecheckError(error) ? 'Waiting for updated drone state' :
            isInternalServerError(error) ? 'Game server error' : isServerShutdownError(error) ? 'Game server unavailable' : rateLimited ? 'Rate limited' : 'Unable to confirm drone state';
    status(detail + (rewardFailure ? '' : error.action ? ' from drone ' + error.action : ' while collecting drone rewards') +
        '. Rechecking current state in ' + seconds + ' seconds.', 'waiting', seconds, 'retry');
    console.log('[COR3 Helper] Drone retry scheduled:', error.action || error.replyType, error.message, seconds);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; checkAutoDrone(); }, seconds * 1000);
}

async function collectDroneRewards(signal, allowInitialCheck = true) {
    try {
        await collectPendingRewardMail({ source: 'DRONE_MISSION', signal, freeSpace: freeMailSpace, allowInitialCheck });
    } catch (error) {
        // Mail failures must never persist a pause requiring the player to resume dispatch.
        throw Object.assign(error, { rewardCollection: true });
    }
}

function storeDroneOptions(data, repairChanges = {}, complete = false) {
    const write = droneOptionsWrite.then(async () => {
        const saved = await chrome.storage.local.get(['droneData', 'droneDataUpdatedAt', 'droneBatteryUpdatedAt', 'droneRepairUpdatedAt', 'droneRepairConflict', 'droneRepairPlan']);
        const previous = saved.droneData;
        if (typeof data === 'function') data = data(previous);
        if (!data) return { ignored: true };
        // Repair replies can omit the battery and mission fields; they are not new battery readings.
        const sameDrone = data?.drone && (!data.drone.id || !previous?.drone?.id || data.drone.id === previous.drone.id);
        const next = !complete && sameDrone ? { ...previous, ...data, drone: { ...previous?.drone, ...data.drone } } : data;
        let repairPlan = Object.hasOwn(repairChanges, 'droneRepairPlan') ? repairChanges.droneRepairPlan : saved.droneRepairPlan;
        if (next?.drone?.isRepairing && repairPlan?.droneId === next.drone.id) repairPlan = { ...repairPlan, confirmed: true };
        const awaitingRepair = awaitingConfirmedDroneRepair(next, repairPlan);
        const sameBattery = previous?.drone?.id === next?.drone?.id && previous?.activeMissionId === next?.activeMissionId &&
            ['current', 'max', 'restorePerHour', 'restoreSeconds'].every(key => previous?.battery?.[key] === next?.battery?.[key]);
        const sameRepair = ['id', 'durability', 'maxDurability', 'isRepairing', 'repairSecondsRemaining'].every(key => previous?.drone?.[key] === next?.drone?.[key]) &&
            ['startDurability', 'targetDurability', 'totalSeconds', 'secondsRemaining'].every(key => previous?.drone?.repair?.[key] === next?.drone?.repair?.[key]);
        const now = Date.now();
        const batteryUpdatedAt = sameBattery ? saved.droneBatteryUpdatedAt ?? saved.droneDataUpdatedAt ?? now : now;
        const repairUpdatedAt = sameRepair ? saved.droneRepairUpdatedAt ?? saved.droneDataUpdatedAt ?? now : now;
        const availability = next?.drone ? { state: 'available', checkedAt: now }
            : complete && Object.hasOwn(data || {}, 'drone') ? { state: 'unavailable', checkedAt: now, nextCheckAt: now + DRONE_AVAILABILITY_CHECK_MS } : null;
        await chrome.storage.local.set({ droneData: next, droneDataUpdatedAt: now, droneBatteryUpdatedAt: batteryUpdatedAt,
            droneRepairUpdatedAt: repairUpdatedAt,
            droneRepairConflict: matchesRejectedDroneRepair(next, saved.droneRepairConflict) ? saved.droneRepairConflict : null,
            droneRepairPlan: next?.drone?.isRepairing || awaitingRepair ? repairPlan : null,
            ...(!next?.drone?.isRepairing && !awaitingRepair ? { droneRepairWhileCharging: false } : {}),
            ...(availability ? { droneAvailability: availability } : {}), ...repairChanges });
        return { becameAvailable: !!next?.drone && !previous?.drone, unavailable: availability?.state === 'unavailable' };
    });
    droneOptionsWrite = write.catch(error => console.log('[COR3 Helper] Drone data update failed:', error.message));
    return write;
}

async function options(signal) {
    const data = await command('get.options', {}, signal);
    if (!Object.hasOwn(data, 'drone')) throw Object.assign(new Error('Waiting for current drone availability.'), { code: 'game_reply_timeout', action: 'get.options' });
    await storeDroneOptions(data, {}, true);
    return data;
}

async function waitForDroneAvailability() {
    const saved = await chrome.storage.sync.get(['autoDrone', 'helperMode']);
    const cfg = droneSettings(saved.autoDrone);
    if (saved.helperMode || !cfg.enabled || cfg.paused) return;
    const local = await chrome.storage.local.get('droneAvailability');
    if (local.droneAvailability?.state !== 'unavailable') return;
    const next = local.droneAvailability.nextCheckAt;
    await status('Waiting for a drone. Unlock it in the game; the helper will check again automatically.', 'waiting',
        Math.max(0, (next - Date.now()) / 1000), 'unlock');
    clearTimeout(droneWaitTimer);
    droneWaitTimer = setTimeout(() => { droneWaitTimer = null; checkAutoDrone(); }, Math.max(1000, next - Date.now()));
}

function refreshDroneArchive() {
    if (!_initialFetchDone) return;
    chrome.storage.local.get('droneData', saved => {
        if (saved.droneData?.drone) window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.archived', data: { cursor: null, limit: 20 } }, '*');
    });
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
    if (saved.helperMode || !cfg.enabled || !cfg.paused || cfg.pauseReason === 'manual') return saved;
    const local = await chrome.storage.local.get(['droneStatus', 'droneMissionData', 'droneEvents', 'droneDecisionError']);
    const message = local.droneStatus?.message;
    // Older builds persisted recoverable races, timeouts and mail failures as permanent pauses.
    if (local.droneStatus?.state !== 'paused' || (!message?.startsWith('Drone automation paused: ') && !isDroneStateRecheckError({ message }) && !isDroneUnavailableError({ message })) ||
        (!isSupersededDroneEvent({ message }) && !isDroneRepairStateConflict({ message }) && !isDroneStateRecheckError({ message }) &&
            !isDroneResponseTimeout({ message }) && !isDroneRewardCollectionError({ message }) &&
            !isTransientAutomationError({ message: message.replace(/^Drone automation paused:\s*/, '') }) && !isDroneUnavailableError({ message }))) return saved;
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
    if (signal.aborted || saved.helperMode || (!manual && saved.decisionModifiers?.autoChoose === false)) return;
    const key = decision.expeditionId + ':' + decision.messageId;
    const previous = decisionAttempts.get(key);
    if (previous?.inFlight || previous?.confirmed) return;
    if (previous?.retryAt > Date.now()) { scheduleDecisionCheck(previous.retryAt); return; }
    if (!manual && !decisionReady(decision, saved.decisionModifiers)) {
        const readyAt = new Date(decision.decisionDeadline).getTime() - 60000;
        if (readyAt > Date.now()) scheduleDecisionCheck(readyAt);
        return;
    }
    const choice = manual ? decision.decisionOptions.find(option => option.id === manual.optionId && !option.unavailable)
        : bestDecisionOption(decision, saved.decisionModifiers);
    if (!choice) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const attempt = { controller, automatic: !manual, inFlight: true };
    decisionAttempts.set(key, attempt);
    try {
        await command('resolve.event', { missionId: decision.expeditionId, eventId: decision.messageId, optionId: choice.id }, controller.signal);
        attempt.confirmed = true;
        await retireDecision(decision, 'resolved');
    } catch (error) {
        if (controller.signal.aborted) throw error;
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
        if (isTransientAutomationError(error)) {
            attempt.retryAt = Date.now() + (isRateLimitError(error) ? 60000 : 10000);
            scheduleDecisionCheck(attempt.retryAt);
            throw error;
        }
        chrome.storage.local.set({ droneDecisionError: error.message });
        throw error;
    } finally {
        attempt.inFlight = false;
        signal.removeEventListener('abort', abort);
        // The saved retired list prevents repeats of confirmed choices.
        if (!attempt.retryAt) decisionAttempts.delete(key);
    }
}

export function requestDroneDecision(request) {
    if (![request.missionId, request.eventId, request.optionId].every(value => typeof value === 'string' && value)) return;
    pendingManualDecision = request;
    checkDroneDecision(request).then(handled => {
        if (handled) {
            if (pendingManualDecision === request) pendingManualDecision = null;
        } else if (running) refreshPending = true; else checkAutoDrone();
    });
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
        if (!data.drone) { await waitForDroneAvailability(); return; }
        const local = await chrome.storage.local.get(['droneCompleted', 'droneMissionData', 'droneEvents']);
        if (local.droneCompleted?.missionId) await noteRewardCompletion('DRONE_MISSION', local.droneCompleted.missionId);
        if (data.activeMissionId) {
            const missionId = data.activeMissionId;
            const mission = local.droneMissionData?.id === missionId ? local.droneMissionData : null;
            const completed = local.droneCompleted?.missionId === missionId || mission?.status === 'COMPLETED';
            if (!completed) {
                await resolveCurrentDecision(data, signal, manual);
                // A flight produces no rewards until it finishes. Only recover
                // mail already known to be pending from a previous completion.
                if (automateFlight) await collectDroneRewards(signal, false);
                if (automateFlight) status('Drone expedition in progress. Waiting for its return.', 'active');
                return;
            }
            if (!automateFlight) return;
            status('Finalizing drone rewards…', 'waiting', null, 'collecting');
            await noteRewardCompletion('DRONE_MISSION', missionId);
            await command('claim', { missionId }, signal);
            data = await options(signal);
            if (data.activeMissionId) {
                status('Waiting for the completed drone mission to leave the active slot.');
                return;
            }
            await chrome.storage.local.remove(['droneCompleted', 'droneEvents']);
        }
        if (!automateFlight) return;
        const { droneRepairPlan } = await chrome.storage.local.get('droneRepairPlan');
        if (awaitingConfirmedDroneRepair(data, droneRepairPlan)) {
            await runDronePlan(data, cfg, signal);
            return;
        }
        if (await hasRewardMailToCollect('DRONE_MISSION')) {
            status('Collecting drone reward mail…', 'waiting', null, 'collecting');
            await collectDroneRewards(signal);
        }
        // Waiting needs no second snapshot. Recheck before an actual repair or
        // launch, since a manual action may have happened during mail collection.
        const { droneRepairConflict } = await chrome.storage.local.get('droneRepairConflict');
        const staleRepair = matchesRejectedDroneRepair(data, droneRepairConflict);
        const candidate = dronePlan(data, { ...cfg, keepCreditReserve: false,
            repairWhileCharging: cfg.repairWhileCharging && !staleRepair && !chargingRepairCreditBlocked }, Infinity);
        if (candidate.type === 'launch' || (candidate.type === 'repair' && !staleRepair)) data = await options(signal);
        await runDronePlan(data, cfg, signal);
    } catch (error) {
        if (signal.aborted || error.name === 'AbortError') return;
        console.log('[COR3 Helper] Drone request failed:', error.action || error.replyType || 'unknown action', error.code || '', error.message);
        if (error.action === 'get.options' && isDroneUnavailableError(error)) {
            await storeDroneOptions({ drone: null }, {}, true);
            await waitForDroneAvailability();
        } else if (isTransientAutomationError(error) || isDroneStateRecheckError(error) || isDroneRewardCollectionError(error) || error.action === 'claim') {
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
    if (!data?.drone) { await waitForDroneAvailability(); return; }
    const local = await chrome.storage.local.get(['droneRepairConflict', 'droneRepairPlan']);
    if (signal.aborted) return;
    if (awaitingConfirmedDroneRepair(data, local.droneRepairPlan)) {
        status('Waiting for the game to confirm the last drone repair.', 'waiting', 60, 'repair-confirmation');
        droneWaitTimer = setTimeout(() => { droneWaitTimer = null; checkAutoDrone(); }, 60000);
        return;
    }
    const staleRepair = matchesRejectedDroneRepair(data, local.droneRepairConflict);
    const planning = chargingRepairCreditBlocked || staleRepair ? { ...cfg, repairWhileCharging: false } : cfg;
    const candidate = dronePlan(data, { ...planning, keepCreditReserve: false }, Infinity);
    if (cfg.keepCreditReserve && allowRepair && !staleRepair && candidate.type === 'repair') {
        const reply = await waitForGameReply('COR3_WS_DRONE_BALANCE', { type: 'COR3_DRONE_BALANCE' }, signal,
            result => !!result.requestId && Number.isFinite(result.credits));
        if (signal.aborted) return;
        creditBalance = reply.credits;
    }
    const plan = dronePlan(data, planning, creditBalance);
    if (plan.type === 'pause') { await pause(plan.message, signal); return; }
    if (plan.type === 'wait') {
        status(plan.message, 'waiting', plan.seconds, plan.phase);
        if (staleRepair || (Number.isFinite(plan.seconds) && plan.seconds >= 0 && plan.seconds <= 60)) {
            const waitMs = staleRepair ? Number.isFinite(plan.seconds) && plan.seconds > 0
                ? Math.max(5000, Math.min(60000, plan.seconds * 1000)) : 60000 : Math.max(5000, plan.seconds * 1000);
            droneWaitTimer = setTimeout(() => { droneWaitTimer = null; checkAutoDrone(); }, waitMs);
        }
        return;
    }
    if (plan.type === 'active') { status('Drone expedition in progress.', 'active'); return; }
    if (plan.type === 'repair') {
        if (!allowRepair || staleRepair) {
            status('Waiting for updated drone durability. Retrying automatically.', 'waiting', 60, 'retry');
            droneWaitTimer = setTimeout(() => { droneWaitTimer = null; checkAutoDrone(); }, 60000);
            return;
        }
        status((plan.opportunistic ? 'Repairing while charging' : 'Starting drone repair') + ' (' + plan.cost.toLocaleString() + ' CR)…');
        const repairStartedAt = Date.now();
        const repairPlan = { mode: plan.opportunistic ? 'charging' : 'target', droneId: data.drone.id, maxDurability: data.drone.maxDurability,
            startDurability: data.drone.durability,
            targetDurability: plan.targetDurability,
            targetPercent: plan.opportunistic ? Math.round(plan.targetDurability / data.drone.maxDurability * 100) : cfg.repairTarget,
            startedAt: repairStartedAt, endsAt: repairStartedAt + plan.seconds * 1000 };
        // Save the requested duration: the server's remaining time may describe a full repair.
        await chrome.storage.local.set({ droneRepairPlan: repairPlan, droneRepairWhileCharging: !!plan.opportunistic });
        let result;
        try {
            result = await command('repair', { targetDurability: plan.targetDurability,
                keepCreditReserve: !!cfg.keepCreditReserve }, signal);
        } catch (error) {
            // A lost reply or server failure may still have started the repair; retain its target for reconciliation.
            if (!isDroneResponseTimeout(error) && !isInternalServerError(error) && !isServerShutdownError(error)) await chrome.storage.local.set({ droneRepairPlan: null, droneRepairWhileCharging: false });
            if (isDroneRepairStateConflict(error)) {
                // Durability may reach the requested target between options and repair.
                // Re-plan from the server state; never immediately retry a stale repair.
                await chrome.storage.local.set({ droneRepairConflict: { droneId: data.drone.id,
                    durability: data.drone.durability, maxDurability: data.drone.maxDurability } });
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
        const { helperActivityCost, ...repairData } = result;
        const confirmed = repairData.drone ? { ...data, ...repairData } : await options(signal);
        if (!confirmed.drone?.isRepairing && !(confirmed.drone?.durability >= plan.targetDurability)) {
            throw new Error('Drone repair was not confirmed.');
        }
        reportActivity({ kind: 'droneRepair', id: 'drone-repair:' + data.drone.id + ':' + repairStartedAt + ':' + plan.targetDurability,
            cost: helperActivityCost });
        await storeDroneOptions(confirmed, {
            droneRepairWhileCharging: !!plan.opportunistic && !!confirmed.drone?.isRepairing,
            droneRepairPlan: confirmed.drone?.isRepairing ? { ...repairPlan, confirmed: true } : null });
        status(plan.opportunistic ? 'Repairing while the battery charges.' : 'Repair in progress.',
            'waiting', plan.opportunistic ? plan.chargingSeconds : Math.max(0, (repairPlan.endsAt - Date.now()) / 1000));
        if (confirmed.drone?.isRepairing) {
            // Refresh shortly after the requested repair finishes. A timer only
            // requests state; projected completion never authorizes a launch.
            droneWaitTimer = setTimeout(() => { droneWaitTimer = null; checkAutoDrone(); },
                Math.max(1000, Math.min(60000, repairPlan.endsAt - Date.now() + 500)));
        }
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
    reportActivity({ kind: 'droneLaunch', id: 'drone-launch:' + latest.activeMissionId });
    await chrome.storage.local.remove(['droneCompleted', 'droneEvents']);
    status('Drone expedition in progress: ' + plan.mission.name, 'active');
}

export async function checkAutoDrone() {
    if (!isContextValid() || !_initialFetchDone || running || Date.now() < Math.max(cooldownUntil, rateLimitUntil)) return;
    const saved = await recoverStalePause(await chrome.storage.sync.get(['autoDrone', 'helperMode', 'decisionModifiers']));
    const cfg = droneSettings(saved.autoDrone);
    if (saved.helperMode || ((!cfg.enabled || cfg.paused) && saved.decisionModifiers?.autoChoose === false && !pendingManualDecision) || running || !_initialFetchDone ||
        Date.now() < Math.max(cooldownUntil, rateLimitUntil)) return;
    const local = await chrome.storage.local.get('droneAvailability');
    if (local.droneAvailability?.state === 'unavailable' && !pendingManualDecision) {
        if (!cfg.enabled || cfg.paused) return;
        if (local.droneAvailability.nextCheckAt > Date.now()) { await waitForDroneAvailability(); return; }
    }
    _automationEnqueue('auto-drone', () => {
        if (!isContextValid() || running || Date.now() < Math.max(cooldownUntil, rateLimitUntil)) {
            _automationFinish('auto-drone');
            return;
        }
        const controller = new AbortController();
        clearTimeout(droneWaitTimer);
        droneWaitTimer = null;
        running = controller;
        cycle(controller);
    });
}

export function setupDrone() {
    window.addEventListener('message', event => {
        if (event.source !== window || !isContextValid()) return;
        const { type, data } = event.data || {};
        if (type === 'COR3_DRONE_REPAIR_TRACE') {
            diagnosticWrite = diagnosticWrite.catch(() => {}).then(async () => {
                const saved = await chrome.storage.local.get(['droneRepairDiagnostics', 'droneRepairPlan']);
                await chrome.storage.local.set({ droneRepairDiagnostics: mergeRepairDiagnostics(saved.droneRepairDiagnostics,
                    { ...data, repair: saved.droneRepairPlan }) });
            });
        } else if (type === 'COR3_WS_ROOM_LEFT' && event.data.room === 'drone-missions') {
            chrome.storage.sync.get(['autoDrone', 'decisionModifiers', 'helperMode']).then(saved => {
                const cfg = droneSettings(saved.autoDrone);
                if (!saved.helperMode && ((cfg.enabled && !cfg.paused) || saved.decisionModifiers?.autoChoose !== false))
                    window.postMessage({ type: 'COR3_SUBSCRIBE_DRONE' }, '*');
            });
        } else if (type === 'COR3_AUTOJOB_PROFILE_CREDITS' && Number.isFinite(data?.newBalance)) {
            creditBalance = data.newBalance;
            if (data.amount > 0) chargingRepairCreditBlocked = false;
        } else if (type === 'COR3_WS_DRONE_UPDATE') {
            if (data?.missionId) {
                if (running) refreshPending = true; else checkAutoDrone();
            } else {
                storeDroneOptions(previous => droneOptionsAfterUpdate(previous, data)).then(result => {
                    if (result.ignored) return;
                    if (running) refreshPending = true; else checkAutoDrone();
                });
            }
        } else if (type === 'COR3_WS_DRONE_OPTIONS') {
            const repairChanges = event.data.action === 'repair.cancel' ? { droneRepairPlan: null, droneRepairWhileCharging: false } : {};
            storeDroneOptions(data, repairChanges, event.data.action === 'get.options').then(result => {
                checkDroneDecision();
                if (result.becameAvailable) {
                    refreshDroneArchive();
                    if (!running) checkAutoDrone();
                } else if (result.unavailable && !running) waitForDroneAvailability();
            });
        } else if (type === 'COR3_WS_DRONE_RESULT' && event.data.action === 'get.options' && !running && isDroneUnavailableError(event.data.error)) {
            storeDroneOptions({ drone: null }, {}, true).then(() => waitForDroneAvailability());
        } else if (type === 'COR3_WS_DRONE_MISSION') {
            chrome.storage.local.get(['droneMissionData', 'droneMissionEventsUpdatedAt'], local => {
                const mission = local.droneMissionData?.id === data.id ? { ...local.droneMissionData, ...data } : data;
                chrome.storage.local.set({ droneMissionData: mission, droneMissionUpdatedAt: Date.now(),
                    droneMissionEventsUpdatedAt: Array.isArray(data.channelEvents) ? Date.now() : local.droneMissionEventsUpdatedAt || 0 }, () => checkDroneDecision());
                if (['COMPLETED', 'FAILED', 'DESTROYED'].includes(mission.status)) rememberDroneHistory([], [mission]);
            });
            if (!running && ['launch', 'claim'].includes(event.data.action)) {
                window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.options', data: {} }, '*');
            }
        } else if (type === 'COR3_WS_DRONE_ARCHIVED') {
            if (Array.isArray(data) || Array.isArray(data?.items) || Array.isArray(data?.data)) rememberDroneHistory(historyItems(data));
        } else if (type === 'COR3_WS_MAIL') {
            // The initial mailbox snapshot also recovers rewards delivered while
            // the browser was closed. Ignore mail for other sources entirely.
            if (data?.messages?.some(message => message.status !== 'CLAIMED' &&
                message.attachments?.some(attachment => attachment.source === 'DRONE_MISSION' && !attachment.claimedAt))) {
                chrome.storage.local.set({ mailData: data }).then(async () => {
                    if (!running && await hasRewardMailToCollect('DRONE_MISSION', false)) {
                        checkAutoDrone();
                    }
                });
            }
        } else if (type === 'COR3_WS_DRONE_COMPLETED') {
            chrome.storage.local.set({ droneCompleted: data }, () => {
                if (running) { refreshPending = true; return; }
                chrome.storage.sync.get(['autoDrone', 'helperMode', 'decisionModifiers'], saved => {
                    const cfg = droneSettings(saved.autoDrone);
                    if (!saved.helperMode && ((cfg.enabled && !cfg.paused) || saved.decisionModifiers?.autoChoose !== false)) checkAutoDrone();
                    else if (!running) window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.options', data: {} }, '*');
                });
            });
            chrome.storage.local.get('droneMissionData', local => {
                const mission = local.droneMissionData?.id === data?.missionId ? local.droneMissionData : {};
                if (data?.missionId) rememberDroneHistory([], [{ ...mission, ...data, id: data.missionId,
                    status: data.status || 'COMPLETED', completedAt: data.completedAt || new Date().toISOString() }]);
            });
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
            }).then(() => {
                // A live event needs a choice, not another options/mail cycle.
                checkDroneDecision().then(handled => {
                    if (!handled) { if (running) refreshPending = true; else checkAutoDrone(); }
                });
            });
        } else if (type === 'COR3_TOKEN_EXPIRED' || type === 'COR3_CONNECTION_LOST') {
            creditBalance = null;
            chargingRepairCreditBlocked = false;
            cancelDroneChoices();
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
                refreshDroneArchive();
            });
        }
    });
    window.postMessage({ type: 'COR3_DRONE_TRACE_INFO' }, '*');
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.decisionModifiers) {
            if (changes.decisionModifiers.newValue?.autoChoose === false) cancelDroneChoices(true);
            checkDroneDecision();
            if (running) refreshPending = true; else checkAutoDrone();
        }
        if (area === 'sync' && changes.helperMode) {
            if (changes.helperMode.newValue) { cancelDroneChoices(); stopAutoDrone(); }
            else { checkDroneDecision(); checkAutoDrone(); }
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
