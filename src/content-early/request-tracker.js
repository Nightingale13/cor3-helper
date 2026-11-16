// Socket.IO does not echo a correlation ID for these events. Keep an outbound
// ledger per socket, and discard ambiguous replies rather than guessing ownership.
const sockets = new Map();
const manualRooms = new Map();
const joinedRooms = new Map();
const endpoints = new Map();
const quietUntil = new Map();
function prune(socket, key) {
    const pending = sockets.get(socket)?.get(key);
    if (!pending?.length) return pending || [];
    const live = pending.filter(entry => Date.now() - entry.sentAt < 30000 && !entry.cancelled?.());
    if (live.length !== pending.length) {
        sockets.get(socket).set(key, live);
        if (!quietUntil.has(socket)) quietUntil.set(socket, new Map());
        // Drain late untagged replies before another helper read uses this action.
        quietUntil.get(socket).set(key, Date.now() + 5000);
    }
    return live;
}
export function parseCommand(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('42[')) return null;
    try {
        const [type, payload] = JSON.parse(raw.slice(2));
        return type === 'event' && payload?.event?.name && payload.event.action ? payload : null;
    } catch { return null; }
}
export function validMarketId(id) {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
export function trackRequest(socket, raw, source, options = {}) {
    if (typeof raw === 'string' && /^42\["(?:join|leave)-room"/.test(raw)) {
        try {
            const [type, data] = JSON.parse(raw.slice(2));
            let joined = joinedRooms.get(socket);
            if (!joined) { joined = new Set(); joinedRooms.set(socket, joined); }
            if (type === 'join-room') joined.add(data.room);
            else joined.delete(data.room);
            if (source === 'manual') {
                let rooms = manualRooms.get(socket);
                if (!rooms) { rooms = new Set(); manualRooms.set(socket, rooms); }
                if (type === 'join-room') rooms.add(data.room);
                else rooms.delete(data.room);
            }
        } catch { /* Ignore unrelated frames. */ }
    }
    const command = parseCommand(raw);
    if (!command) return;
    const { name, action } = command.event;
    if (name === 'network-map' && action === 'set.endpoint') endpoints.delete(socket);
    if (!['market', 'network-map', 'sai', 'expeditions', 'mail', 'stash', 'drone-missions'].includes(name)) return;
    let ledger = sockets.get(socket);
    if (!ledger) { ledger = new Map(); sockets.set(socket, ledger); }
    const key = name + ':' + action;
    const pending = prune(socket, key);
    const request = { source, marketId: command.data?.marketId, requestId: options.requestId,
        serverId: command.data?.serverId, action, ambiguous: false, onResponse: options.onResponse,
        sentAt: Date.now(), cancelled: options.cancelled, name };
    // If the user interleaves an indistinguishable read, neither reply can safely
    // confirm automation. Explicit market IDs can still identify cache updates.
    if (pending.some(entry => entry.source !== source)) {
        request.ambiguous = true;
        for (const entry of pending) entry.ambiguous = true;
    }
    pending.push(request);
    ledger.set(key, pending);
    return request;
}
export function discardRequest(socket, request) {
    if (!request) return;
    const pending = sockets.get(socket)?.get(request.name + ':' + request.action);
    const index = pending?.indexOf(request) ?? -1;
    if (index >= 0) pending.splice(index, 1);
}
export function takeResponse(socket, name, payload) {
    const pending = sockets.get(socket)?.get(name + ':' + payload?.event?.action);
    if (!pending?.length) return null;
    const marketId = payload.data?.market?.id;
    const index = marketId ? pending.findIndex(entry => entry.marketId === marketId) : 0;
    if (index < 0) return null;
    const request = pending.splice(index, 1)[0];
    if (name === 'network-map' && request.action === 'set.endpoint' && !request.ambiguous && !payload.error)
        endpoints.set(socket, request.serverId);
    request.onResponse?.(payload, request);
    return request;
}
export function hasPendingRequest(socket, name, action) {
    const key = name + ':' + action;
    return prune(socket, key).length > 0 || (quietUntil.get(socket)?.get(key) || 0) > Date.now();
}
export function currentEndpoint(socket) { return endpoints.get(socket); }
export function userOwnsRoom(room) { return [...manualRooms.values()].some(rooms => rooms.has(room)); }
export function isRoomJoined(socket, room) { return !!joinedRooms.get(socket)?.has(room); }
export function forgetSocket(socket) { sockets.delete(socket); manualRooms.delete(socket); joinedRooms.delete(socket); endpoints.delete(socket); quietUntil.delete(socket); }
