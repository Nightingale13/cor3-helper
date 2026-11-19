// WebSocket send infrastructure: throttling, queuing, room management
import {
    OrigWebSocket, trackedSockets, socketLastActivity,
    getActiveSocket, setActiveSocket,
    getCapturedBearerToken,
    pendingRetryOps
} from './state.js';
import { isInteractionPaused, noteManualActivity } from './interaction-guard.js';
import { commandInteractionScope } from '../shared/interaction-scopes.js';
import { parseCommand, trackRequest, discardRequest, validMarketId, hasPendingRequest, currentEndpoint, userOwnsRoom, isRoomJoined } from './request-tracker.js';

// Send a WS message on the active socket (most recently received messages)
// Throttled: minimum 250ms between sends to avoid "Too many requests" errors.
// Uses timestamp-based approach: if last send was <250ms ago, delay this send.
var WS_THROTTLE_MS = 250;
var wsSendLastTime = 0;
var wsSendQueue = [];
var wsSendFlushTimer = null;
let flushGeneration = 0;
var WS_QUEUE_MAX = 50;
let plannedEndpoint = null;
let plannedEndpointOwner = null;
let sendOwner = null;
let rateLimitUntil = 0;
const RATE_LIMIT_PAUSE_MS = 30000;
export function hasOpenSocket() {
    return [getActiveSocket(), ...trackedSockets].some(socket => socket?.readyState === OrigWebSocket.OPEN);
}
// Several features request the same drone snapshot. Space those reads apart
// while leaving live decisions free to pass the passive refresh queue.
const DRONE_OPTIONS_INTERVAL_MS = 2000;
let droneOptionsLastTime = -Infinity;

function isDroneOptions(msg) {
    const command = parseCommand(msg);
    return command?.event.name === 'drone-missions' && command.event.action === 'get.options';
}

function passiveDroneOptions(msg, options) {
    return isDroneOptions(msg) && !options.requestId && !options.onResponse && !options.onReject;
}

function rateLimitError() {
    return { code: 'rate_limited', message: 'Too many requests. Automation is waiting before checking current game state again.' };
}

function deferForRateLimit(msg, options) {
    if (options.cancelled?.()) return false;
    if (options.onReject) options.onReject(rateLimitError());
    // Passive refreshes can wait. Unsent paid actions must be re-planned from
    // fresh state by their automation, never replayed after the pause.
    else if (isRead(msg)) enqueue(msg, options);
    if (wsSendQueue.length) scheduleFlush(rateLimitUntil - Date.now(), true);
    return false;
}

export function noteServerRateLimit() {
    rateLimitUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
    const pending = wsSendQueue.splice(0);
    for (const entry of pending) deferForRateLimit(entry.msg, entry.options);
    if (wsSendQueue.length) scheduleFlush(RATE_LIMIT_PAUSE_MS, true);
}
const ownerGenerations = new Map();
export function withWsOwner(owner, run) {
    const previous = sendOwner;
    sendOwner = owner;
    try { return run(); } finally { sendOwner = previous; }
}
export function cancelWsOwner(owner) {
    ownerGenerations.set(owner, (ownerGenerations.get(owner) || 0) + 1);
    if (plannedEndpointOwner === owner) { plannedEndpoint = null; plannedEndpointOwner = null; }
}

function isRead(msg) {
    const command = parseCommand(msg);
    return !command || command.event.action.startsWith('get.');
}
export function discardDisconnectedWrites() {
    wsSendQueue = wsSendQueue.filter(entry => {
        if (isRead(entry.msg)) return true;
        entry.options.onReject?.({ code: 'socket_unavailable', message: 'Game connection lost. Rechecking state before retrying.' });
        return false;
    });
    plannedEndpoint = null;
    plannedEndpointOwner = null;
}

function enqueue(msg, options, first = false) {
    if (options.cancelled?.()) return false;
    wsSendQueue = wsSendQueue.filter(entry => !entry.options.cancelled?.());
    if (passiveDroneOptions(msg, options) && wsSendQueue.some(entry => passiveDroneOptions(entry.msg, entry.options))) return true;
    const capacity = WS_QUEUE_MAX + (options.interactive || options.urgent ? 10 : 0);
    if (wsSendQueue.length >= capacity) {
        options.onReject?.({ code: 'request_queue_full', message: 'Game connection is busy; the request was not sent.' });
        return false;
    }
    wsSendQueue[first ? 'unshift' : 'push']({ msg, options });
    return true;
}

var _ceChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
var _ceCbs = [];
if (_ceChannel) {
    _ceChannel.port1.onmessage = function () {
        var cbs = _ceCbs.slice();
        _ceCbs.length = 0;
        for (var i = 0; i < cbs.length; i++) cbs[i]();
    };
}
export function ceNextTick(fn) {
    if (_ceChannel) { _ceCbs.push(fn); _ceChannel.port2.postMessage(0); }
    else { setTimeout(fn, 0); }
}
function scheduleFlush(delayMs, replace = false) {
    if (wsSendFlushTimer && !replace) return;
    const generation = ++flushGeneration;
    if (delayMs <= 0) { ceNextTick(() => { if (generation === flushGeneration) wsSendFlush(); }); wsSendFlushTimer = true; return; }
    var target = Date.now() + delayMs;
    function tick() {
        if (generation !== flushGeneration) return;
        if (Date.now() >= target) { wsSendFlush(); return; }
        var rem = target - Date.now();
        if (rem > 200) { setTimeout(function () { ceNextTick(tick); }, Math.min(rem - 50, 500)); }
        else { ceNextTick(tick); }
    }
    wsSendFlushTimer = true;
    ceNextTick(tick);
}

function blocked(msg, options = {}) {
    if (isDroneOptions(msg) && (Date.now() - droneOptionsLastTime < DRONE_OPTIONS_INTERVAL_MS ||
        hasPendingRequest(getActiveSocket(), 'drone-missions', 'get.options'))) return true;
    if (options.interactive) return false;
    const command = parseCommand(msg);
    if (command) {
        const { name, action } = command.event;
        if (name === 'loadout' && action === 'get.options') return false;
        const scope = commandInteractionScope(name);
        const passive = name === 'network-map' && action === 'get.map';
        if (scope && !passive && isInteractionPaused(scope)) return true;
        // Serialize ID-less reads. Manual requests always bypass this helper queue.
        if (name === 'market' && action.startsWith('get.') && hasPendingRequest(getActiveSocket(), name, action)) return true;
        return false;
    }
    const room = roomCommand(msg);
    return !!room && ['network-map', 'market', 'sai'].includes(room.room) && isInteractionPaused('network');
}

function roomCommand(msg) {
    if (typeof msg !== 'string' || !/^42\["(?:leave|join)-room"/.test(msg)) return null;
    try { return JSON.parse(msg.slice(2))[1]; } catch { return null; }
}

function valid(msg, options) {
    if (window.__cor3AutomationOwner === false) {
        options.onReject?.({ code: 'automation_not_owner', message: 'The helper is running in another game tab.' });
        return false;
    }
    if (options.contextError) { options.onReject?.(options.contextError); return false; }
    const command = parseCommand(msg);
    // Recheck ownership when flushing too: the user may have opened the app
    // since this room refresh was queued.
    const room = roomCommand(msg);
    if (room && userOwnsRoom(room.room)) return false;
    if (command?.event.name === 'market' && !validMarketId(command.data?.marketId)) {
        options.onReject?.({ message: 'Market ID is missing or invalid' });
        console.log('[COR3 Helper] Skipped market request with an invalid market ID');
        return false;
    }
    return !options.cancelled?.();
}

export function wsSendRaw(msg, options = {}) {
    if (!valid(msg, options)) return false;
    if (Date.now() < rateLimitUntil) return deferForRateLimit(msg, options);
    if (blocked(msg, options)) {
        enqueue(msg, options);
        scheduleFlush(500);
        return false;
    }
    var toSend = msg;
    var codec = window.__cor3MsgpackCodec;
    if (codec && codec.isReady() && typeof msg === 'string') {
        var buf = codec.stringToPacketBuffer(msg);
        if (buf) toSend = buf;
    }

    var activeSocket = getActiveSocket();
    if (activeSocket && activeSocket.readyState === OrigWebSocket.OPEN) {
        const command = parseCommand(msg);
        // The user may have changed endpoint while this command was deferred.
        // Re-establish its original context only after manual browsing has ended.
        if (options.endpoint && ['market', 'sai'].includes(command?.event.name) &&
            currentEndpoint(activeSocket) !== options.endpoint) {
            if (!enqueue(msg, options, true)) return false;
            if (!hasPendingRequest(activeSocket, 'network-map', 'set.endpoint')) {
                wsSendRaw('42' + JSON.stringify(['event', { event: { name: 'network-map', action: 'set.endpoint' },
                    data: { serverId: options.endpoint } }]), { cancelled: options.cancelled,
                    onResponse: (payload, request) => {
                        if (payload.error && !request.ambiguous) options.contextError = payload.error;
                    } });
            }
            scheduleFlush(500);
            return false;
        }
        if (sendOnSocket(activeSocket)) { wsSendLastTime = Date.now(); return true; }
        if (!isRead(msg)) {
            options.onReject?.({ code: 'socket_unavailable', message: 'Game connection lost. Rechecking state before retrying.' });
            return false;
        }
        enqueue(msg, options, true);
        scheduleFlush(2000);
        return false;
    }

    let bestSocket = null;
    let bestTime = 0;
    for (const ws of trackedSockets) {
        if (ws.readyState === OrigWebSocket.OPEN) {
            const lastActivity = socketLastActivity.get(ws) || 0;
            if (!bestSocket || lastActivity > bestTime) {
                bestTime = lastActivity;
                bestSocket = ws;
            }
        }
    }

    if (bestSocket) {
        setActiveSocket(bestSocket);
        return wsSendRaw(msg, options);
    }

    console.log('[COR3 Helper] No active WebSocket found — re-queuing message for retry');
    if (!isRead(msg)) {
        options.onReject?.({ code: 'socket_unavailable', message: 'Game connection lost. Rechecking state before retrying.' });
        return false;
    }
    // Re-queue message and retry after a short delay
    if (enqueue(msg, options, true)) {
        scheduleFlush(2000);
    } else {
        console.log('[COR3 Helper] No active WebSocket and queue full — message dropped');
    }
    return false;

    function sendOnSocket(socket) {
        const request = trackRequest(socket, msg, 'helper', options);
        // The proxy sees helper sends too. Keep the source explicit even for binary packets.
        socket.__cor3HelperSending = true;
        try { socket.send(toSend); }
        catch (error) {
            discardRequest(socket, request);
            console.log('[COR3 Helper] Socket send failed; waiting for reconnect:', error.message);
            return false;
        }
        finally { socket.__cor3HelperSending = false; }
        if (isDroneOptions(msg)) droneOptionsLastTime = Date.now();
        options.onSent?.();
        return true;
    }
}

function wsSendFlush() {
    wsSendFlushTimer = null;
    if (wsSendQueue.length === 0) return;
    if (Date.now() < rateLimitUntil) { scheduleFlush(rateLimitUntil - Date.now()); return; }
    var now = Date.now();
    var elapsed = now - wsSendLastTime;
    if (elapsed >= WS_THROTTLE_MS) {
        wsSendQueue = wsSendQueue.filter(entry => !entry.options.cancelled?.());
        // Passive updates (including drone data) may pass deferred network work.
        // Decisions have a game deadline. They must also pass a series of
        // popup loadout actions, while retaining the normal request throttle.
        var index = wsSendQueue.findIndex(entry => entry.options.urgent && !blocked(entry.msg, entry.options));
        if (index < 0) index = wsSendQueue.findIndex(entry => entry.options.interactive && !blocked(entry.msg, entry.options));
        if (index < 0) index = wsSendQueue.findIndex(entry => !blocked(entry.msg, entry.options));
        if (index < 0) { if (wsSendQueue.length) scheduleFlush(500); return; }
        var next = wsSendQueue.splice(index, 1)[0];
        wsSendRaw(next.msg, next.options);
        if (wsSendQueue.length > 0) {
            scheduleFlush(WS_THROTTLE_MS);
        }
    } else {
        scheduleFlush(WS_THROTTLE_MS - elapsed);
    }
}

export function wsSend(msg, options = {}) {
    if (!valid(msg, options)) return false;
    if (Date.now() < rateLimitUntil) return deferForRateLimit(msg, options);
    if (sendOwner) {
        const owner = sendOwner;
        const generation = ownerGenerations.get(owner) || 0;
        const cancelled = options.cancelled;
        options = { ...options, cancelled: () => !!cancelled?.() || (ownerGenerations.get(owner) || 0) !== generation };
    }
    const command = parseCommand(msg);
    if (options.interactive && command?.event.name === 'loadout' && command.event.action !== 'get.options') {
        noteManualActivity('loadout');
    }
    if (command?.event.name === 'network-map' && command.event.action === 'set.endpoint') {
        plannedEndpoint = command.data?.serverId;
        plannedEndpointOwner = sendOwner;
    }
    options = { endpoint: plannedEndpoint, ...options };
    var now = Date.now();
    var elapsed = now - wsSendLastTime;
    const canPrioritize = options.urgent || (options.interactive && !wsSendQueue.some(entry => entry.options.interactive || entry.options.urgent));
    if (elapsed >= WS_THROTTLE_MS && (wsSendQueue.length === 0 || canPrioritize)) {
        // Can send immediately
        wsSendRaw(msg, options);
    } else {
        // Queue and schedule flush
        if (!enqueue(msg, options)) return false;
        if (!wsSendFlushTimer || options.interactive || options.urgent) {
            scheduleFlush(Math.max(0, WS_THROTTLE_MS - elapsed), !!(options.interactive || options.urgent));
        }
    }
    return true;
}

export function queueRetryOp(opName) {
    if (!pendingRetryOps.includes(opName)) {
        pendingRetryOps.push(opName);
    }
}

// Get a random human-like delay (400–900ms)
export function humanDelay() {
    return 400 + Math.floor(Math.random() * 500);
}

export function delay(ms) {
    return new Promise(function (resolve) {
        var target = Date.now() + ms;
        function check() {
            if (Date.now() >= target) { resolve(); return; }
            var remaining = target - Date.now();
            if (remaining > 200) {
                setTimeout(function () { ceNextTick(check); }, Math.min(remaining - 50, 500));
            } else {
                ceNextTick(check);
            }
        }
        ceNextTick(check);
    });
}

// Send a leave-room message. Only sends if tracked as joined.
export function leaveRoom(room) {
    if (userOwnsRoom(room)) return false;
    if (!isRoomJoined(getActiveSocket(), room)) return false;
    wsSend('42["leave-room",{"room":"' + room + '"}]');
    return true;
}

// Send a join-room message and mark as joined.
// New format includes jwtToken and clientVersion.
export function sendJoin(room, options = {}) {
    if (userOwnsRoom(room) || isRoomJoined(getActiveSocket(), room)) return false;
    if (wsSendQueue.some(entry => !entry.options.cancelled?.() && entry.msg.startsWith('42["join-room",') && roomCommand(entry.msg)?.room === room)) return false;
    var joinData = { room: room };
    // Include jwtToken (strip "Bearer " prefix from captured token)
    var capturedBearerToken = getCapturedBearerToken();
    if (capturedBearerToken) {
        var jwt = capturedBearerToken;
        if (jwt.startsWith('Bearer ')) jwt = jwt.substring(7);
        joinData.jwtToken = jwt;
    }
    // Include clientVersion from captured web version
    if (window.__cor3WebVersion) {
        joinData.clientVersion = window.__cor3WebVersion;
    }
    return wsSend('42["join-room",' + JSON.stringify(joinData) + ']', options);
}

// Leave multiple rooms in order (child first), with human delays between.
function leaveRoomsInOrder(rooms) {
    var chain = Promise.resolve();
    rooms.forEach(function (room) {
        chain = chain.then(function () {
            if (leaveRoom(room)) {
                return delay(humanDelay());
            }
        });
    });
    return chain;
}

// Join multiple rooms in order (parent first), with human delays between.
function joinRoomsInOrder(rooms) {
    var chain = Promise.resolve();
    rooms.forEach(function (room) {
        chain = chain.then(function () {
            if (sendJoin(room)) return delay(humanDelay());
        });
    });
    return chain;
}

// Subscription is idempotent; explicit reads refresh data without disrupting UI.
// `rooms` must be in parent→child order, e.g. ['network-map', 'market']
export function enterRooms(rooms) {
    return joinRoomsInOrder(rooms);
}
