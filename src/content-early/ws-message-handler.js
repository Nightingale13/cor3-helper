// WebSocket message handler: processes all inbound WS events
import {
    trackedSockets,
    setTokenExpiredFlag, bumpMarketRefreshAbortId,
    USOL_MARKET_ID, markMarketReachable, invalidateMarketBlockage
} from './state.js';
import { HOME_SERVER_ID, MARKET_SERVER_IDS } from '../shared/server-constants.js';
import { marketRouteBlocker } from '../shared/market-reachability.js';
import { handleDroneMessage } from './drone.js';
import { relayJobMarketRead } from './job-markets.js';
import { takeResponse } from './request-tracker.js';
import { queueRetryOp, humanDelay, noteServerRateLimit } from './ws-send.js';
import { isRateLimitError } from '../shared/automation-recovery.js';
import { recordGameVersion } from './game-versions.js';
import { mercenaryDecisions } from '../shared/mercenary-decisions.js';

// Forward declaration — set by index.js after market-requests is loaded
let __cor3PostUnreachable = null;
export function setPostUnreachable(fn) { __cor3PostUnreachable = fn; }

export function handleWsMessage(rawData, socket) {
    if (window.__cor3AutomationOwner === false) return;
    if (typeof rawData !== 'string') return;

    // Log ALL inbound WS messages to content.js for storage (not just 42-prefixed)
    window.postMessage({ type: 'COR3_WS_LOG', direction: 'received', message: rawData }, '*');

    // Socket.IO v4 messages start with "42[" for event frames
    if (!rawData.startsWith('42')) return;

    const jsonStr = rawData.substring(2);
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        return;
    }

    if (!Array.isArray(parsed) || parsed.length < 2) return;

    const eventName = parsed[0];
    const payload = parsed[1];
    // Set the shared pause before response callbacks can enqueue another action.
    if (isRateLimitError(payload?.error) || (eventName === 'error' && isRateLimitError(payload))) noteServerRateLimit();
    const outbound = takeResponse(socket, eventName, payload);
    const automationReply = outbound?.source === 'helper' && !outbound.ambiguous;
    // Untagged errors cannot be assigned safely when the user interleaves the
    // same action. The automation rechecks state instead of blaming its request.
    if (outbound?.ambiguous && payload?.error && eventName !== 'market') return;
    if (payload?.error && outbound?.requestId && ['get.active', 'get.state'].includes(payload.event?.action)) {
        window.postMessage({ type: 'COR3_REQUEST_ERROR', requestId: outbound.requestId, error: payload.error }, '*');
        return;
    }
    if (handleDroneMessage(eventName, payload, outbound)) return;
    if (eventName === 'expeditions' && payload?.event?.action === 'respond.event') {
        if (automationReply && outbound.requestId) {
            window.postMessage({ type: 'COR3_WS_DECISION_RESULT', requestId: outbound.requestId,
                data: payload.data, error: payload.error || null }, '*');
        }
        return;
    }

    // Handle token-expired error — close sockets to force game to reconnect with fresh token
    if (eventName === 'error' && payload && payload.message === 'token-expired') {
        console.log('[COR3 Helper] Token expired detected — closing sockets to force reconnect');
        setTokenExpiredFlag(true);
        // Abort all in-flight market refreshes by bumping the abort ID
        var newAbortId = bumpMarketRefreshAbortId();
        console.log('[COR3 Helper] Bumped market refresh abort ID to', newAbortId);
        // Reset initial fetch so reconnect does a full fresh fetch (not partial retry)
        if (window.__cor3ResetInitialFetch) window.__cor3ResetInitialFetch();
        // Queue NON-market data fetches for retry (markets will be handled by initialFetch)
        queueRetryOp('expeditions');
        queueRetryOp('stash');
        queueRetryOp('mail');
        queueRetryOp('dailyOps');
        window.postMessage({ type: 'COR3_TOKEN_EXPIRED' }, '*');
        // Close all tracked sockets — Socket.IO will auto-reconnect with a new token
        var socketsToClose = trackedSockets.slice();
        for (var i = 0; i < socketsToClose.length; i++) {
            try { socketsToClose[i].close(); } catch (e) {}
        }
        // Safety: if no new socket within 15s, log warning
        setTimeout(function () {
            if (trackedSockets.length === 0) {
                console.log('[COR3 Helper] No new WebSocket connected after token-expired close — game may need page refresh');
            } else {
                console.log('[COR3 Helper] WebSocket reconnected after token-expired');
            }
        }, 15000);
        return;
    }

    // Intercept specialists responses (stash expansion timers)
    if (eventName === 'specialists' && payload && payload.data) {
        window.postMessage({
            type: 'COR3_WS_SPECIALISTS',
            data: payload.data
        }, '*');
    }

    // Intercept stash (inventory) responses
    if (eventName === 'stash' && payload && payload.data) {
        window.postMessage({
            type: 'COR3_WS_STASH',
            stash: payload.data, requestId: outbound?.requestId
        }, '*');
    }

    if (eventName === 'mail' && payload) {
        var mailAction = payload.event && payload.event.action;
        if (payload.data && Array.isArray(payload.data.messages)) {
            window.postMessage({ type: 'COR3_WS_MAIL', data: payload.data, requestId: outbound?.requestId }, '*');
        }
        if (mailAction === 'claim.all') {
            const claimData = payload.data?.attachmentId && !Array.isArray(payload.data.results)
                ? { results: [payload.data] } : payload.data;
            window.postMessage({
                type: 'COR3_WS_MAIL_CLAIM_RESULT', data: claimData || null,
                error: payload.error || null, requestId: outbound?.requestId || payload.requestId
            }, '*');
        }
        return;
    }

    // Intercept loadout responses
    if (eventName === 'loadout' && payload) {
        var loadoutAction = payload.event ? payload.event.action : null;
        if (payload.error) {
            window.postMessage({
                type: 'COR3_WS_LOADOUT_ERROR',
                action: loadoutAction,
                error: payload.error
            }, '*');
        }
        if (payload.data) {
            window.postMessage({
                type: 'COR3_WS_LOADOUT',
                action: loadoutAction,
                loadout: payload.data
            }, '*');
            // Cache loadout data in window global for auto-job-solver access
            window.__cor3LoadoutData = payload.data;
            // Also post as auto-job event so solver waitForEvent can catch it
            window.postMessage({
                type: 'COR3_AUTOJOB_LOADOUT',
                action: loadoutAction,
                data: payload.data,
                error: null
            }, '*');
        }
        if (payload.error) {
            window.postMessage({
                type: 'COR3_AUTOJOB_LOADOUT',
                action: loadoutAction,
                data: null,
                error: payload.error
            }, '*');
        }
    }

    // Intercept mercenary responses — detect market by faction key (core_main vs usol_employment)
    if (eventName === 'expeditions' && payload && payload.event && payload.event.action === 'get.mercenaries') {
        if (payload.error || !payload.data) return;
        var mercFactionKey = null;
        if (payload.data && payload.data.mercenaries && payload.data.mercenaries.length > 0) {
            var firstMerc = payload.data.mercenaries[0];
            if (firstMerc.faction && firstMerc.faction.key) mercFactionKey = firstMerc.faction.key;
        }
        // Fallback: check eliteSlots if no regular mercs
        if (!mercFactionKey && payload.data && payload.data.eliteSlots && payload.data.eliteSlots.length > 0) {
            var firstElite = payload.data.eliteSlots[0];
            if (firstElite.mercenary && firstElite.mercenary.faction && firstElite.mercenary.faction.key) mercFactionKey = firstElite.mercenary.faction.key;
            if (!mercFactionKey && firstElite.marketId === USOL_MARKET_ID) mercFactionKey = 'usol_employment';
        }
        if (!mercFactionKey && outbound?.ambiguous) return;
        const usolMercs = mercFactionKey === 'usol_employment' ||
            (!mercFactionKey && !outbound?.ambiguous && outbound?.marketId === USOL_MARKET_ID);
        if (usolMercs) {
            markMarketReachable('usol');
            window.postMessage({ type: 'COR3_WS_USOL_MERCENARIES', data: payload.data }, '*');
        } else {
            // core_main or unknown — treat as CORE
            if (payload.data && payload.data.mercenaries) {
                window.__cor3CachedMercIds = payload.data.mercenaries.map(function (m) { return m.id; });
            }
            window.postMessage({ type: 'COR3_WS_MERCENARIES', data: payload.data }, '*');
        }
        return;
    }

    // Intercept expedition config response (locations/zones/goals) — detect USOL by pending flag
    if (eventName === 'expeditions' && payload && payload.event && payload.event.action === 'get.config') {
        if (payload.error || !payload.data) return;
        if (outbound?.ambiguous) return;
        // Detect if this is a USOL config response by checking if USOL merc fetch is in progress
        var isUsolConfig = !outbound?.ambiguous && outbound?.marketId
            ? outbound.marketId === USOL_MARKET_ID : !!window.__cor3UsolMercFetchInProgress;
        if (payload.data && payload.data.locations && payload.data.locations.length > 0) {
            var picked = window.__cor3PickLocationConfig(payload.data.locations);
            if (isUsolConfig) {
                window.__cor3UsolExpConfigIds = picked;
            } else {
                window.__cor3ExpConfigIds = picked;
            }
        }
        if (isUsolConfig) {
            window.postMessage({ type: 'COR3_WS_USOL_EXPEDITION_CONFIG', data: payload.data }, '*');
        } else {
            window.postMessage({ type: 'COR3_WS_EXPEDITION_CONFIG', data: payload.data }, '*');
        }
        return;
    }

    if (eventName === 'expeditions' && payload?.event?.action === 'open.container') {
        window.postMessage({
            type: 'COR3_WS_EXPEDITION_SETTLED', data: payload.data || null, requestId: outbound?.requestId,
            error: payload.error || null
        }, '*');
        return;
    }

    // Keep cached expeditions in sync when the server archives a finished raid
    if (eventName === 'expeditions' && payload && payload.event && payload.event.action === 'insert.archive') {
        window.postMessage({
            type: 'COR3_WS_EXPEDITION_ARCHIVED',
            data: payload.data
        }, '*');
        return;
    }

    // Intercept launch response
    if (eventName === 'expeditions' && payload && payload.event && payload.event.action === 'launch') {
        window.postMessage({ type: 'COR3_WS_EXPEDITION_LAUNCH_RESULT', requestId: outbound?.requestId,
            data: payload.data || null, error: payload.error || null }, '*');
        // Automated launches handle their own acknowledgement and reconciliation.
        // Avoid also running the legacy manual-launch retry branches.
        if (payload.error && outbound?.requestId) return;
        // Check for launch errors
        if (payload.error && payload.error.message === 'Maximum 1 active expedition allowed') {
            console.log('[COR3 Helper] Expedition launch failed: Maximum 1 active expedition allowed');
            window.postMessage({
                type: 'COR3_WS_EXPEDITION_LAUNCH_ERROR',
                error: payload.error.message
            }, '*');
            return;
        }

        if (payload.error && payload.error.message === 'This location requires an elite mercenary') {
            console.log('[COR3 Helper] Expedition launch failed: quest location requires elite mercenary — will retry with default location');
            window.postMessage({
                type: 'COR3_WS_EXPEDITION_ELITE_REQUIRED',
                error: payload.error.message
            }, '*');
            return;
        }

        if (payload.error && payload.error.message === 'Mercenary is not available') {
            console.log('[COR3 Helper] Expedition launch failed: Mercenary is not available');
            window.postMessage({
                type: 'COR3_WS_MERC_NOT_AVAILABLE',
                error: payload.error.message
            }, '*');
            return;
        }

        // Check for insufficient credits error
        if (payload.error && payload.error.message === 'insufficient-credits') {
            console.log('[COR3 Helper] Expedition launch failed: insufficient credits');
            window.postMessage({
                type: 'COR3_WS_INSUFFICIENT_CREDITS',
                error: payload.error.message
            }, '*');
            return;
        }

        if (payload.error || !payload.data?.id || !payload.data?.status) {
            window.postMessage({ type: 'COR3_WS_EXPEDITION_LAUNCH_ERROR',
                error: payload.error?.message || payload.error?.code || 'The launch was not confirmed.' }, '*');
            return;
        }

        // Successful launch
        window.postMessage({
            type: 'COR3_WS_EXPEDITION_LAUNCHED',
            data: payload.data
        }, '*');
        // Clear old expedition decisions when new expedition starts
        window.postMessage({
            type: 'COR3_WS_DECISIONS',
            decisions: [] // Clear decisions by sending empty array
        }, '*');
        // Post launch data as expedition data directly — no need for leave-room/join-room/get.active
        window.postMessage({
            type: 'COR3_WS_EXPEDITIONS',
            expeditions: [payload.data]
        }, '*');
        return;
    }

    // Intercept mercenary configure response (cost/risk/chances)
    if (eventName === 'expeditions' && payload && payload.event && payload.event.action === 'configure') {
        var mercId = (window.__cor3PendingMercConfigures && window.__cor3PendingMercConfigures.length > 0)
            ? window.__cor3PendingMercConfigures.shift() : null;
        window.postMessage({
            type: 'COR3_WS_MERC_CONFIGURE',
            mercenaryId: mercId,
            data: payload.data
        }, '*');
        return;
    }

    // Intercept market responses — handle get.options, get.lots, get.jobs separately
    if (eventName === 'market') relayJobMarketRead(payload, outbound);
    // Markets are fetched one at a time (sequential per market) but within each market,
    // get.options + get.lots + get.jobs are sent as a parallel batch.
    // Attribute ID-less responses to their actual outbound request on this socket.
    if (eventName === 'market' && payload && payload.data) {
        var mktAction = payload.event ? payload.event.action : null;

        // Helper: resolve market type from a market ID
        function resolveMarketType(id) {
            if (id === '019d3ea4-85bd-7389-904d-908ba9194aa0') return 'dark';
            if (id === '019da731-2db5-7d76-9447-1ea3b9b78001') return 'soyuz';
            if (id === '019e4065-6ae8-760d-8724-58ab4f2cf7d7') return 'usol';
            return 'home'; // 019d3ea4-85bd-7389-904d-8f7c85841134
        }
        function marketCacheKey(type) {
            return type === 'dark' ? '__cor3DarkMarketCache'
                : type === 'soyuz' ? '__cor3SoyuzMarketCache'
                : type === 'usol' ? '__cor3UsolMarketCache' : '__cor3HomeMarketCache';
        }
        function marketMsgType(type) {
            return type === 'dark' ? 'COR3_WS_DARK_MARKET'
                : type === 'soyuz' ? 'COR3_WS_SOYUZ_MARKET'
                : type === 'usol' ? 'COR3_WS_USOL_MARKET' : 'COR3_WS_MARKET';
        }
        function postMarketUpdate(type, cache) {
            window.postMessage({ type: marketMsgType(type), market: cache }, '*');
        }

        // get.options: contains market info, reputation, userCredits (no lots/jobs)
        var mkt = payload.data.market;
        if (mktAction === 'get.options' && mkt && mkt.marketName && !payload.error) {
            var marketType = resolveMarketType(mkt.id);
            markMarketReachable(marketType);
            var cacheKey = marketCacheKey(marketType);
            // Initialize or reset cache with get.options data
            // Preserve existing jobs/recentJobs/nextJobsResetAt/lots so UI doesn't flicker
            var prevJobs = window[cacheKey] ? window[cacheKey].jobs : undefined;
            var prevRecentJobs = window[cacheKey] ? window[cacheKey].recentJobs : undefined;
            var prevNextJobsResetAt = window[cacheKey] ? window[cacheKey].nextJobsResetAt : undefined;
            var prevLots = window[cacheKey] ? window[cacheKey].lots : undefined;
            window[cacheKey] = Object.assign({}, payload.data);
            if (prevJobs !== undefined) window[cacheKey].jobs = prevJobs;
            if (prevRecentJobs !== undefined) window[cacheKey].recentJobs = prevRecentJobs;
            if (prevNextJobsResetAt !== undefined) window[cacheKey].nextJobsResetAt = prevNextJobsResetAt;
            if (prevLots !== undefined) window[cacheKey].lots = prevLots;
            postMarketUpdate(marketType, window[cacheKey]);
            if (marketType === 'home') window.__cor3LastMarketId = mkt.id;
        }

        // get.lots: merge lots into cached market data
        if (mktAction === 'get.lots' && payload.data.lots && outbound?.marketId && !outbound.ambiguous) {
            var lotsMarketId = outbound.marketId;
            var lotsType = resolveMarketType(lotsMarketId);
            var lotsCacheKey = marketCacheKey(lotsType);
            if (window[lotsCacheKey]) {
                window[lotsCacheKey].lots = payload.data.lots;
                postMarketUpdate(lotsType, window[lotsCacheKey]);
            }
        }

        // get.jobs: merge jobs into cached market data
        if (mktAction === 'get.jobs' && !payload.error && Array.isArray(payload.data.jobs) && outbound?.marketId && !outbound.ambiguous) {
            var jobsMarketId = outbound.marketId;
            var jobsType = resolveMarketType(jobsMarketId);
            var jobsCacheKey = marketCacheKey(jobsType);
            if (window[jobsCacheKey]) {
                window[jobsCacheKey].jobs = payload.data.jobs || [];
                window[jobsCacheKey].recentJobs = payload.data.recentJobs || [];
                window[jobsCacheKey].nextJobsResetAt = payload.data.nextJobsResetAt || window[jobsCacheKey].nextJobsResetAt;
                postMarketUpdate(jobsType, window[jobsCacheKey]);
                window.postMessage({ type: 'COR3_MARKET_JOBS_UPDATED', marketType: jobsType }, '*');
                // Signal that this market's data is fully loaded
                if (automationReply) window.postMessage({ type: 'COR3_MARKET_FETCH_COMPLETE', marketId: jobsMarketId,
                    marketType: jobsType, requestId: outbound?.requestId }, '*');
            }
        }

        // Legacy: handle market responses without action (for backwards compatibility)
        if (!mktAction && mkt && mkt.marketName) {
            var legacyType = resolveMarketType(mkt.id);
            postMarketUpdate(legacyType, payload.data);
            if (legacyType === 'home') window.__cor3LastMarketId = mkt.id;
        }
    }

    // Intercept updater responses for patch version (selectedVersion)
    if (eventName === 'updater' && payload && payload.data) {
        var sv = payload.data.selectedVersion;
        if (sv) {
            console.log('[COR3 Helper] Captured patch version from updater:', sv);
            recordGameVersion('patch', sv);
        }
    }

    // Intercept network-map responses (endpoint set success/failure)
    // detect no-path-to-server, server-in-maintenance, and market-not-reachable errors
    if (eventName === 'network-map' && payload && payload.event) {
        if (payload.event.action === 'set.endpoint' && !payload.error && !outbound?.ambiguous) {
            const type = Object.keys(MARKET_SERVER_IDS).find(key => MARKET_SERVER_IDS[key] === outbound?.serverId);
            if (type) markMarketReachable(type);
        }
        if (payload.event.action === 'set.endpoint' && automationReply) {
            var errMsg = payload.error && payload.error.message;
            var isUnreachableErr = errMsg === 'no-path-to-server' || errMsg === 'server-in-maintenance' || errMsg === 'market-not-reachable';
            if (payload.error && isUnreachableErr) {
                console.log('[COR3 Helper] Server unreachable: ' + errMsg + ' (dark-pt: ' + !!window.__cor3DarkMarketPathThrough + ', dark-pend: ' + !!window.__cor3DarkMarketPending + ', soyuz-pt: ' + !!window.__cor3SoyuzMarketPathThrough + ', soyuz-pend: ' + !!window.__cor3SoyuzMarketPending + ', usol-pt: ' + !!window.__cor3UsolMarketPathThrough + ', usol-pend: ' + !!window.__cor3UsolMarketPending + ', devTc: ' + !!window.__cor3DevTcReachActive + ')');
                // During path-through or Dev TC reach test, forward as ENDPOINT_RESULT for the handler to deal with
                if (window.__cor3DevTcReachActive || window.__cor3DarkMarketPathThrough || window.__cor3SoyuzMarketPathThrough || window.__cor3UsolMarketPathThrough) {
                    window.postMessage({
                        type: 'COR3_WS_ENDPOINT_RESULT',
                        success: false,
                        error: payload.error,
                        serverId: payload.error.serverId || null
                    }, '*');
                } else if (window.__cor3UsolMarketPending) {
                    // USOL market refresh failed — fetch network-map for maintenance blocker
                    __cor3PostUnreachable('usol', null);
                } else if (window.__cor3SoyuzMarketPending) {
                    // SOYUZ market refresh failed — fetch network-map for maintenance blocker
                    __cor3PostUnreachable('soyuz', null);
                } else if (window.__cor3DarkMarketPending) {
                    // D4RK market refresh failed — fetch network-map for maintenance blocker
                    __cor3PostUnreachable('dark', null);
                } else {
                    // Non-market set.endpoint error (e.g. auto-jobs, Dev TC) — forward as generic ENDPOINT_RESULT
                    window.postMessage({
                        type: 'COR3_WS_ENDPOINT_RESULT',
                        success: false,
                        error: payload.error,
                        serverId: payload.error.serverId || null
                    }, '*');
                }
            } else {
                var success = !payload.error;
                var epServerId = outbound?.serverId || (payload.error && payload.error.serverId) || null;
                window.postMessage({
                    type: 'COR3_WS_ENDPOINT_RESULT',
                    success: success,
                    data: payload.data,
                    error: payload.error || null,
                    serverId: epServerId
                }, '*');
            }
        }
        // Intercept get.map for server maintenance data + server type info
        if (payload.event.action === 'get.map' && Array.isArray(payload.data?.servers)) {
            var servers = payload.data.servers;
            if (Array.isArray(payload.data.connections) && servers.some(server => server.id === HOME_SERVER_ID || server.serverTypeName === 'Home' || server.serverName === 'Home Server')) {
                for (const [type, target] of Object.entries(MARKET_SERVER_IDS)) {
                    if (servers.some(server => server.id === target) &&
                        !marketRouteBlocker(servers, payload.data.connections, target)) invalidateMarketBlockage(type);
                }
            }
            var maintenanceInfo = {};
            var serverTypeMap = {};
            for (var si = 0; si < servers.length; si++) {
                var srv = servers[si];
                maintenanceInfo[srv.id] = {
                    serverName: srv.serverName,
                    isInMaintenance: !!srv.isInMaintenance,
                    maintenanceEndsAt: srv.maintenanceEndsAt || null,
                    timeUntilMaintenance: srv.timeUntilMaintenance || null
                };
                // Cache server type + defence rate for loadout power calculations
                serverTypeMap[srv.id] = {
                    serverName: srv.serverName,
                    serverTypeName: srv.serverTypeName || null,
                    serverDefenceRate: srv.serverDefenceRate || 0
                };
            }
            window.__cor3ServerTypeMap = serverTypeMap;
            window.postMessage({ type: 'COR3_WS_NETWORK_MAP', servers: maintenanceInfo }, '*');
            // Post full map data for IP Search and other consumers
            window.postMessage({ type: 'COR3_WS_MAP_DATA', servers: payload.data.servers, connections: payload.data.connections || [] }, '*');
        }
        if (payload.event.action === 'maintenance' && payload.data) {
            window.postMessage({ type: 'COR3_WS_MAINTENANCE_STARTED', data: payload.data }, '*');
        }
    }

    // --- Auto Job Solver: Intercept SAI responses ---
    if (eventName === 'sai' && payload && payload.event && (automationReply || payload.event.action === 'update')) {
        var action = payload.event.action;
        // Login status
        if (action === 'get.login.status') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_LOGIN_STATUS', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Login with access
        if (action === 'login.with-access') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_LOGIN_RESULT', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Hack start
        if (action === 'hack.start') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_HACK_START', data: payload.data || null, error: payload.error || null }, '*');
            return;
        }
        // SAI update (hack finished, etc)
        if (action === 'update') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_UPDATE', data: payload.data }, '*');
            return;
        }
        // Get files
        if (action === 'get.files') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_FILES', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // File download
        if (action === 'file.download') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_FILE_DOWNLOAD', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Get logs
        if (action === 'get.logs') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_LOGS', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Log delete
        if (action === 'log.delete') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_LOG_DELETE', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Log download
        if (action === 'log.download') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_LOG_DOWNLOAD', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Transit (IP list)
        if (action === 'get.transit') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_TRANSIT', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Transit add (IP injection result)
        if (action === 'transit.add') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_TRANSIT_ADD', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Transit remove (IP cleanup result)
        if (action === 'transit.remove') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_TRANSIT_REMOVE', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // File delete (file elimination result)
        if (action === 'file.delete') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_FILE_DELETE', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // File upload (data upload result)
        if (action === 'file.upload') {
            window.postMessage({ type: 'COR3_AUTOJOB_SAI_FILE_UPLOAD', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // File search-valuable (valuable seller)
        if (action === 'file.search-valuable') {
            window.postMessage({ type: 'COR3_VALUABLE_FILE_SEARCH', data: payload.data, error: payload.error || null }, '*');
            return;
        }
        // Log search-valuable (valuable seller)
        if (action === 'log.search-valuable') {
            window.postMessage({ type: 'COR3_VALUABLE_LOG_SEARCH', data: payload.data, error: payload.error || null }, '*');
            return;
        }
    }

    // --- Auto Job Solver: Intercept desktop responses ---
    if (eventName === 'desktop' && payload && payload.event) {
        var dAction = payload.event.action;
        console.log('[COR3 Helper] Desktop event:', dAction);
        if (dAction === 'open.folder') {
            window.postMessage({ type: 'COR3_AUTOJOB_DESKTOP_FOLDER', data: payload.data, error: payload.error || null }, '*');
        }
        if (dAction === 'update.file' || dAction === 'open.file' || dAction === 'decrypt.file') {
            var fileError = payload.error || null;
            if (!fileError && payload.data && payload.data.kind === 'insufficient_power') {
                fileError = { message: 'insufficient_power', kind: 'insufficient_power', ability: payload.data.ability, required: payload.data.required, available: payload.data.available };
            }
            window.postMessage({ type: 'COR3_AUTOJOB_DESKTOP_FILE', data: payload.data, error: fileError }, '*');
            if (dAction === 'update.file') {
                window.postMessage({ type: 'COR3_AUTOJOB_DESKTOP_UPDATE_FILE', data: payload.data, error: payload.error || null }, '*');
            }
        }
        if (dAction === 'get.file.analysis') {
            window.postMessage({ type: 'COR3_AUTOJOB_FILE_ANALYSIS', data: payload.data, error: payload.error || null }, '*');
        }
        if (dAction === 'get.options') {
            console.log('[COR3 Helper] Desktop get.options received — folders:', payload.data && payload.data.folders ? payload.data.folders.length : 0);
            // Cache Downloads folder ID globally for auto job solver
            if (payload.data && payload.data.folders) {
                var dlf = payload.data.folders.find(function (f) { return f.name === 'Downloads'; });
                if (dlf) {
                    window.__cor3DownloadFolderId = dlf.id;
                    console.log('[COR3 Helper] Cached Downloads folder ID:', dlf.id);
                }
            }
            window.postMessage({ type: 'COR3_AUTOJOB_DESKTOP_OPTIONS', data: payload.data, error: payload.error || null }, '*');
        }
    }

    // --- Auto Job Solver: Intercept minigame start ---
    if (eventName === 'minigames' && payload && payload.event && payload.event.action === 'start.minigame') {
        if (payload.data && payload.data.lockExpiresAt && !payload.data.token) {
            window.postMessage({ type: 'COR3_AUTOJOB_MINIGAME_LOCKED', data: payload.data }, '*');
        } else {
            window.postMessage({ type: 'COR3_AUTOJOB_MINIGAME_START', data: payload.data }, '*');
            if (payload.data && payload.data.type === 'EXTERNAL' && payload.data.url && payload.data.url.indexOf('ice-wall-break') !== -1) {
                window.postMessage({ type: 'COR3_ICE_WALL_MINIGAME_START', data: payload.data }, '*');
            }
        }
    }

    // --- Auto Job Solver: Intercept profile receive.progress (renown/XP) ---
    if (eventName === 'profile' && payload && payload.event && payload.event.action === 'receive.progress') {
        window.postMessage({ type: 'COR3_AUTOJOB_PROFILE_PROGRESS', data: payload.data }, '*');
    }

    // --- Auto Job Solver: Intercept profile receive.credits (credit reward) ---
    if (eventName === 'profile' && payload && payload.event && payload.event.action === 'receive.credits') {
        window.postMessage({ type: 'COR3_AUTOJOB_PROFILE_CREDITS', data: payload.data }, '*');
    }

    // --- Auto Job Solver: Intercept market job.take and job.complete ---
    if (eventName === 'market' && payload && payload.event && automationReply) {
        if (payload.event.action === 'job.take') {
            window.postMessage({ type: 'COR3_AUTOJOB_JOB_TAKEN', data: payload.data, error: payload.error || null }, '*');
        }
        if (payload.event.action === 'job.complete') {
            console.log('[COR3 Helper] AutoJob: job.complete intercepted', JSON.stringify(payload.data));
            window.postMessage({ type: 'COR3_AUTOJOB_JOB_COMPLETED', data: payload.data, error: payload.error || null }, '*');
        }
        if (payload.event.action === 'job.can-complete') {
            window.postMessage({ type: 'COR3_AUTOJOB_JOB_CAN_COMPLETE', data: payload.data, error: payload.error || null }, '*');
        }
        // Valuable seller: get sellable items
        if (payload.event.action === 'get.sellable-items') {
            window.postMessage({ type: 'COR3_VALUABLE_SELLABLE_ITEMS', data: payload.data, error: payload.error || null }, '*');
        }
        // Valuable seller: sell items
        if (payload.event.action === 'sell.items') {
            window.postMessage({ type: 'COR3_VALUABLE_SELL_RESULT', data: payload.data, error: payload.error || null }, '*');
        }
    }

    // We're interested in "expeditions" responses that contain expedition data
    if (eventName === 'expeditions' && payload && !payload.error) {
        // Handle archived expeditions response
        if (payload.event && payload.event.action === 'get.archived') {
            window.postMessage({
                type: 'COR3_WS_ARCHIVED_EXPEDITIONS',
                data: payload.data
            }, '*');
            return;
        }

        // Skip merc-related actions — they have their own handlers and
        // must NOT be relayed as expedition data (would trigger auto-send prematurely)
        var expAction = payload.event && payload.event.action;
        if (expAction === 'get.mercenaries' || expAction === 'get.config' || expAction === 'configure') {
            return;
        }

        if (expAction !== 'get.active') {
            // Pushes can contain a single expedition or a single message. They
            // must never replace the complete active-slot snapshot used to launch mercs.
            const update = payload.data?.expedition || payload.data;
            const expeditions = Array.isArray(update) ? update : update?.id && Array.isArray(update.messages) ? [update] : [];
            if (expAction === 'update' || expeditions.some(exp => Array.isArray(exp?.messages)) || update?.expeditionId) {
                window.postMessage({ type: 'COR3_WS_EXPEDITION_UPDATE', data: payload.data }, '*');
            }
            return;
        }
        if (!Array.isArray(payload.data) || !payload.data.every(expedition => expedition?.id && expedition.status)) return;
        const expeditions = payload.data;

        // Relay full expedition data for expedition info display
        window.postMessage({
            type: 'COR3_WS_EXPEDITIONS',
            expeditions: expeditions, requestId: outbound?.requestId
        }, '*');

        window.postMessage({ type: 'COR3_WS_DECISIONS', decisions: mercenaryDecisions(expeditions) }, '*');
    }
}
