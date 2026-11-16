import { HOME_SERVER_ID } from './server-constants.js';

export const MARKET_RECHECK_MS = 30000;

export function maintenanceActive(server, now = Date.now()) {
    return !!server?.isInMaintenance && (!server.maintenanceEndsAt || new Date(server.maintenanceEndsAt).getTime() > now);
}

// A blocked route is not a blocked market. Check every alternative before
// explaining an actual access failure as a maintenance problem.
export function marketRouteBlocker(servers, connections, targetId) {
    if (!Array.isArray(servers) || !Array.isArray(connections)) return null;
    const byId = new Map(servers.map(server => [server.id, server]));
    const home = servers.find(server => server.id === HOME_SERVER_ID || server.serverTypeName === 'Home' || server.serverName === 'Home Server');
    if (!home || !byId.has(targetId)) return null;
    const target = byId.get(targetId);
    if (target.isReachable === true || target.isEndpoint === true) return null;
    if (maintenanceActive(target)) return { blockerName: target.serverName, maintenanceEndsAt: target.maintenanceEndsAt || null };
    const roots = [...new Set([home.id, ...servers.filter(server => server.isEndpoint && !maintenanceActive(server)).map(server => server.id)])];
    const adjacency = new Map(servers.map(server => [server.id, []]));
    for (const connection of connections) {
        if (!adjacency.has(connection.serverA) || !adjacency.has(connection.serverB)) continue;
        adjacency.get(connection.serverA).push(connection.serverB);
        adjacency.get(connection.serverB).push(connection.serverA);
    }
    function path(avoidMaintenance) {
        const parent = new Map(roots.map(id => [id, null])), queue = [...roots];
        for (let i = 0; i < queue.length; i++) {
            const id = queue[i];
            if (id === targetId) {
                const route = [];
                for (let at = id; parent.get(at) !== null; at = parent.get(at)) route.unshift(byId.get(at));
                return route;
            }
            for (const next of adjacency.get(id)) {
                if (parent.has(next) || (avoidMaintenance && maintenanceActive(byId.get(next)))) continue;
                parent.set(next, id); queue.push(next);
            }
        }
        return null;
    }
    if (path(true)) return null;
    const blockedRoute = path(false);
    if (!blockedRoute) return { blockerName: 'no-path', maintenanceEndsAt: null };
    const blocker = blockedRoute.find(server => maintenanceActive(server));
    return blocker ? { blockerName: blocker.serverName, maintenanceEndsAt: blocker.maintenanceEndsAt || null } : null;
}

export function freshMarketFailure(available, checkedAt, now = Date.now()) {
    return available === false && Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt < MARKET_RECHECK_MS;
}
