// Protocol actions referenced by upstream PR #6; get.options verified against the live game.
import { wsSend, sendJoin, hasOpenSocket } from './ws-send.js';
import { requestOptions } from './request-control.js';
import { HOME_MARKET_ID, getActiveSocket } from './state.js';
import { hasPendingRequest } from './request-tracker.js';
import { BUILD_ID } from '../shared/build-info.js';
import { repairDiagnosticSnapshot, repairDiagnosticText } from '../shared/drone-repair-diagnostics.js';
import { droneOptionsAfterUpdate } from '../shared/drone-policy.js';

const actions = ['get.options', 'launch', 'repair', 'resolve.event', 'claim', 'get.archived'];
let latestOptions = null;
let droneRevision = 0;
let lastDurabilityUpdate = null;
const repairHistory = [];
function traceRepair(stage, details = {}) {
    const entry = { at: Date.now(), build: BUILD_ID, stage, ...details };
    if (Object.hasOwn(entry, 'target') && !Number.isFinite(entry.target)) entry.target = null;
    repairHistory.push(entry);
    if (repairHistory.length > 40) repairHistory.shift();
    window.postMessage({ type: 'COR3_DRONE_REPAIR_TRACE', data: { entry,
        ...(stage === 'reply' && entry.error ? { history: [...repairHistory] } : {}) } }, '*');
}

function currentOptions(data, request) {
    if (lastDurabilityUpdate) {
        if (Number.isInteger(request?.droneRevision) && request.droneRevision < droneRevision &&
            latestOptions?.drone?.id === data?.drone?.id) {
            // An old active-slot reading must not invalidate a newer idle repair
            // completion. A read sent after completion can confirm a new flight.
            data = { ...data, activeMissionId: latestOptions.activeMissionId };
        }
        if (!data?.drone || data.activeMissionId || data.drone.isDestroyed ||
            (lastDurabilityUpdate.droneId && data.drone.id !== lastDurabilityUpdate.droneId) ||
            (Number.isFinite(latestOptions?.drone?.maxDurability) && data.drone.maxDurability !== latestOptions.drone.maxDurability)) {
            lastDurabilityUpdate = null;
        } else if (Number.isFinite(data.drone.durability) && data.drone.durability <= lastDurabilityUpdate.data.durability) {
            // A completion push is authoritative until another mission or repair
            // changes the drone. Even a later request may read a stale snapshot.
            return droneOptionsAfterUpdate(data, lastDurabilityUpdate.data) || data;
        }
    }
    return data;
}

function balance(options, callback) {
    wsSend('42' + JSON.stringify(['event', { event: { name: 'market', action: 'get.options' }, data: { marketId: HOME_MARKET_ID } }]),
        { ...options, onResponse(payload, request) {
            if (options.cancelled?.()) return;
            if (request.ambiguous || payload.error || !Number.isFinite(payload.data?.userCredits)) {
                options.onReject?.({ code: 'game_reply_timeout', message: 'Could not confirm current credits for drone repairs.' });
                return;
            }
            callback(payload.data.userCredits);
        } });
}

export function handleDroneMessage(eventName, payload, outbound) {
    if (eventName !== 'drone-missions' || !payload) return false;
    var action = payload.event && payload.event.action;
    if (action === 'get.options') traceRepair('options', { source: outbound?.source || 'untracked',
        raw: repairDiagnosticSnapshot(payload.data) });
    if (action === 'repair') traceRepair('reply', { source: outbound?.source || 'untracked',
        target: outbound?.repairTarget, observed: repairDiagnosticSnapshot(latestOptions), result: repairDiagnosticSnapshot(payload.data),
        ...(payload.error ? { error: repairDiagnosticText(payload.error.message || payload.error.code || payload.error) } : {}) });
    if (action === 'repair.cancel') traceRepair('cancelled', { source: outbound?.source || 'untracked',
        result: repairDiagnosticSnapshot(payload.data), ...(payload.error ? { error: repairDiagnosticText(payload.error.message || payload.error) } : {}) });
    if (action === 'get.options' && outbound?.ambiguous) {
        if (outbound.requestId) window.postMessage({ type: 'COR3_WS_DRONE_RESULT', action, requestId: outbound.requestId,
            error: { code: 'game_reply_timeout', message: 'Drone state changed during a refresh. Checking again shortly.' } }, '*');
        return true;
    }
    if (action === 'get.options' && !payload.error && !outbound?.ambiguous) payload = { ...payload, data: currentOptions(payload.data, outbound) };
    if (action === 'get.options' && !payload.error && !outbound?.ambiguous && payload.data?.drone) {
        latestOptions = payload.data;
        const drone = latestOptions.drone;
        if (!latestOptions.activeMissionId && !drone.isRepairing && Number.isFinite(drone.maxDurability) &&
            drone.maxDurability > 0 && drone.durability === drone.maxDurability) {
            if (lastDurabilityUpdate?.droneId !== drone.id || lastDurabilityUpdate?.data.durability !== drone.durability) droneRevision++;
            lastDurabilityUpdate = { droneId: drone.id, data: { durability: drone.durability } };
        }
    }
    if (action === 'update' && !payload.error) {
        const updated = droneOptionsAfterUpdate(latestOptions, payload.data);
        if (updated) {
            latestOptions = updated;
            droneRevision++;
            lastDurabilityUpdate = { droneId: updated.drone.id, data: payload.data };
        } else if (!latestOptions && !payload.data?.missionId && Number.isFinite(payload.data?.durability) && payload.data.durability >= 0) {
            droneRevision++;
            lastDurabilityUpdate = { droneId: payload.data.droneId || null, data: payload.data };
        } else if (payload.data?.missionId) lastDurabilityUpdate = null;
        window.postMessage({ type: 'COR3_WS_DRONE_UPDATE', data: payload.data }, '*');
    }
    if (action === 'launch' && !payload.error && payload.data?.id) {
        lastDurabilityUpdate = null;
        if (latestOptions) latestOptions = { ...latestOptions, activeMissionId: payload.data.id };
    }
    if (action === 'repair' && !payload.error && payload.data?.drone?.isRepairing) {
        lastDurabilityUpdate = null;
        latestOptions = { ...latestOptions, ...payload.data, drone: { ...latestOptions?.drone, ...payload.data.drone } };
    }
    if (action === 'repair' && !payload.error && payload.data?.drone && !payload.data.drone.isRepairing) {
        latestOptions = { ...latestOptions, ...payload.data, drone: { ...latestOptions?.drone, ...payload.data.drone } };
        const drone = latestOptions.drone;
        if (Number.isFinite(drone.maxDurability) && drone.maxDurability > 0 && drone.durability === drone.maxDurability) {
            droneRevision++;
            lastDurabilityUpdate = { droneId: drone.id, data: { durability: drone.durability } };
        }
    }
    window.postMessage({ type: 'COR3_WS_DRONE_RESULT', action: action,
        requestId: outbound?.requestId, data: payload.data || null, error: payload.error || null,
        activityCost: outbound?.activityCost }, '*');
    if (payload.error) return true;
    if (payload.data && (payload.data.drone || (action === 'get.options' && Object.hasOwn(payload.data, 'drone')))) {
        window.postMessage({ type: 'COR3_WS_DRONE_OPTIONS', action, data: payload.data }, '*');
    }
    if (payload.data && payload.data.id && payload.data.status) {
        window.postMessage({ type: 'COR3_WS_DRONE_MISSION', action, data: payload.data }, '*');
    }
    if (action === 'get.archived') {
        window.postMessage({ type: 'COR3_WS_DRONE_ARCHIVED', data: payload.data }, '*');
    }
    if (action === 'event' || action === 'completed') {
        window.postMessage({ type: action === 'event' ? 'COR3_WS_DRONE_EVENT' : 'COR3_WS_DRONE_COMPLETED', data: payload.data }, '*');
    }
    return true;
}

window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.data?.type === 'COR3_DRONE_TRACE_INFO') { traceRepair('ready'); return; }
    if (['COR3_CONNECTION_LOST', 'COR3_TOKEN_EXPIRED'].includes(event.data?.type)) {
        latestOptions = null;
        lastDurabilityUpdate = null;
        return;
    }
    if (event.data?.type === 'COR3_SUBSCRIBE_DRONE') {
        sendJoin('drone-missions', { urgent: true });
        return;
    }
    if (event.data?.type === 'COR3_DRONE_BALANCE') {
        const options = requestOptions(event.data.requestId);
        balance(options, credits => window.postMessage({ type: 'COR3_WS_DRONE_BALANCE', requestId: options.requestId, credits }, '*'));
        return;
    }
    if (event.data?.type !== 'COR3_DRONE_COMMAND') return;
    if (actions.indexOf(event.data.action) < 0) return;
    const { keepCreditReserve, ...data } = event.data.data || {};
    const options = { ...requestOptions(event.data.requestId), urgent: event.data.action === 'resolve.event', droneRevision: () => droneRevision };
    if (event.data.action === 'repair' && !hasOpenSocket()) {
        options.onReject?.({ code: 'socket_unavailable', message: 'Game connection lost. Rechecking state before repairing.' });
        return;
    }
    sendJoin('drone-missions');
    if (options.cancelled?.()) return;
    const message = '42' + JSON.stringify(['event', { event: { name: 'drone-missions', action: event.data.action }, data }]);
    if (event.data.action !== 'repair') { wsSend(message, options); return; }
    // Every repair needs fresh durability, even with the credit reserve off.
    wsSend('42' + JSON.stringify(['event', { event: { name: 'drone-missions', action: 'get.options' }, data: {} }]), {
        ...options, onResponse(payload, request) {
            if (options.cancelled?.()) return;
            if (!payload.error && !request.ambiguous) {
                payload = { ...payload, data: currentOptions(payload.data, request) };
                latestOptions = payload.data;
            }
            const current = payload.data?.drone;
            const verifiedAt = Date.now();
            traceRepair('checked', { target: data.targetDurability, observed: repairDiagnosticSnapshot(payload.data) });
            const price = payload.data?.repairRate?.creditsPerPoint;
            const points = data.targetDurability - current?.durability;
            if (request.ambiguous || payload.error || !current || current.isRepairing || current.isDestroyed || payload.data.activeMissionId ||
                !Number.isFinite(current.maxDurability) || !Number.isInteger(data.targetDurability) ||
                (keepCreditReserve && (!Number.isFinite(price) || price < 0)) ||
                !Number.isFinite(points) || points <= 0 || data.targetDurability > current.maxDurability) {
                traceRepair('prevented', { reason: 'The fresh repair check did not authorize a repair.' });
                options.onReject?.({ code: 'game_reply_timeout', message: 'Drone repair details changed. Checking again shortly.' });
                return;
            }
            const sendRepair = () => {
                let changed = false;
                let sent = false;
                wsSend(message, { ...options, activityCost: Number.isFinite(price) && price >= 0 ? points * price : undefined,
                    onSent: () => {
                        sent = true;
                        traceRepair('sent', { source: 'helper', target: data.targetDurability,
                            verifiedAgeMs: Date.now() - verifiedAt, observed: repairDiagnosticSnapshot(latestOptions) });
                    },
                    cancelled: () => {
                        if (options.cancelled?.() || changed) return true;
                        // After sending, this callback is also used by the reply
                        // ledger. Only unsent work may test the pending-repair gate.
                        if (sent) return false;
                        const latest = latestOptions?.drone;
                        if (Date.now() - verifiedAt > 5000 || hasPendingRequest(getActiveSocket(), 'drone-missions', 'repair') ||
                            (latest && (latest.id !== current.id || latest.durability >= data.targetDurability ||
                            latest.isRepairing || latest.isDestroyed || latestOptions.activeMissionId))) {
                            changed = true;
                            traceRepair('prevented', { reason: 'The repair check expired, another repair is pending, or the drone state changed.',
                                verifiedAgeMs: Date.now() - verifiedAt, observed: repairDiagnosticSnapshot(latestOptions) });
                            options.onReject?.({ code: 'game_reply_timeout', message: 'Drone repair details changed. Checking again shortly.' });
                        }
                        return changed;
                    } });
            };
            if (!keepCreditReserve) { sendRepair(); return; }
            balance(options, credits => {
                if (credits < points * price + 2000) {
                    options.onReject?.({ code: 'insufficient_credits', message: 'Waiting to keep 2,000 credits after the drone repair.' });
                    return;
                }
                sendRepair();
            });
        }
    });
});
