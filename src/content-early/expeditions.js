// Expedition-related functions: request, respond, archive, mercs, launch, mail
import { USOL_MARKET_ID, USOL_SERVER_ID } from './state.js';
import { wsSend, enterRooms, sendJoin, humanDelay } from './ws-send.js';
import { safeTimeout as setTimeout, safeClearTimeout as clearTimeout } from '../shared/ws-utils.js';
import { requestOptions } from './request-control.js';
import { reportActivity } from '../shared/activity-event.js';
import { __cor3FetchMapData, __cor3FindPathsToServer, __cor3EnsureServerAccess, __cor3WaitForMsg, __cor3PostUnreachable } from './market-requests.js';

var DEFAULT_LOCATION_NAMES = ['Skylift Remains', 'Koute Mining and Reprocessing Outpost'];

window.__cor3PickDefaultLocation = function (locations) {
    if (!locations || locations.length === 0) return null;
    if (locations.length === 1) return locations[0];
    var def = null;
    for (var i = 0; i < locations.length; i++) {
        if (DEFAULT_LOCATION_NAMES.indexOf(locations[i].name) !== -1) { def = locations[i]; break; }
    }
    return def || locations[0];
};

window.__cor3PickLocationConfig = function (locations) {
    var loc = window.__cor3PickDefaultLocation(locations);
    if (!loc) return { locationConfigId: null, zoneConfigId: null, goalId: null };
    var zone0 = loc.zones && loc.zones[0] ? loc.zones[0] : null;
    var goal0 = zone0 && zone0.goals && zone0.goals[0] ? zone0.goals[0] : null;
    return { locationConfigId: loc.id, zoneConfigId: zone0 ? zone0.id : null, goalId: goal0 ? goal0.id : null };
};

// Global variables to store versions as fallback
window.__cor3WebVersion = null;
window.__cor3SystemVersion = null;
window.__cor3PatchVersion = null;
window.__cor3DownloadFolderId = null;

// Send expedition request through any open tracked socket
// Read explicitly even when the player already owns the subscription. Waiting
// for a room-join snapshot can hang, and passive reads must not pause with navigation.
window.__cor3RequestExpeditions = function (requestId, urgent = false) {
    const options = { ...requestOptions(requestId), urgent };
    console.log('[COR3 Helper] Requesting expedition data');
    if (urgent) {
        // Empty update notifications need a fresh reading of the decision,
        // ahead of passive refreshes and without a room-join delay.
        sendJoin('expeditions', { urgent: true });
        wsSend('42["event",{"event":{"name":"expeditions","action":"get.active"},"data":{}}]', options);
        return true;
    }
    enterRooms(['expeditions']).then(function () {
        wsSend('42["event",{"event":{"name":"expeditions","action":"get.active"},"data":{}}]', options);
    });
    return true;
};

// Send decision response via WS
window.__cor3RespondDecision = function (expeditionId, messageId, selectedOption, requestId) {
    var payload = JSON.stringify({
        expeditionId: expeditionId,
        messageId: messageId,
        selectedOption: selectedOption
    });
    var msg = '42["event",{"event":{"name":"expeditions","action":"respond.event"},"data":' + payload + '}]';
    console.log('[COR3 Helper] Sending decision response:', selectedOption);
    return wsSend(msg, { ...requestOptions(requestId), urgent: true });
};

// Request archived expeditions
window.__cor3RequestArchivedExpeditions = function () {
    console.log('[COR3 Helper] Requesting archived expeditions');
    var msg = '42["event",{"event":{"name":"expeditions","action":"get.archived"},"data":{"cursor":null,"limit":20}}]';
    wsSend(msg);
    return true;
};

// CORE merc abort handle for cancelling in-flight requests
var coreMercAbort = null;

// Request mercenary data: get.mercenaries → (get.config if needed) → configure each merc sequentially
window.__cor3RequestMercenaries = function (marketId, callback) {
    if (window.__cor3CoreMercFetchInProgress) {
        console.log('[COR3 Helper] CORE merc fetch already in progress — aborting previous');
        if (coreMercAbort) coreMercAbort();
    }
    var mid = marketId || window.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
    console.log('[COR3 Helper] Starting CORE mercenary data fetch for market:', mid);
    window.__cor3CoreMercFetchInProgress = true;

    var aborted = false;
    coreMercAbort = function () {
        aborted = true;
        window.__cor3CoreMercFetchInProgress = false;
        window.removeEventListener('message', onCoreData);
        clearTimeout(coreTimer);
        coreMercAbort = null;
    };

    var getMercs = '42["event",{"event":{"name":"expeditions","action":"get.mercenaries"},"data":{"marketId":"' + mid + '"}}]';
    wsSend(getMercs);
    setTimeout(function () {
        if (aborted) return;
        var getConfig = '42["event",{"event":{"name":"expeditions","action":"get.config"},"data":{"marketId":"' + mid + '"}}]';
        wsSend(getConfig);
    }, humanDelay());

    var coreMercData = null;
    var coreConfigData = null;
    var coreDone = false;
    function onCoreData(evt) {
        if (aborted || coreDone) return;
        if (!evt.data) return;
        if (evt.data.type === 'COR3_WS_MERCENARIES') {
            coreMercData = evt.data.data;
            checkAndConfigureCore();
        }
        if (evt.data.type === 'COR3_WS_EXPEDITION_CONFIG') {
            coreConfigData = window.__cor3PickLocationConfig(evt.data.data && evt.data.data.locations);
            window.__cor3ExpConfigIds = coreConfigData;
            checkAndConfigureCore();
        }
    }
    function checkAndConfigureCore() {
        if (!coreMercData || !coreConfigData) return;
        coreDone = true;
        window.removeEventListener('message', onCoreData);
        clearTimeout(coreTimer);
        var configIds = coreConfigData;
        var allMercIds = [];
        if (coreMercData.mercenaries) {
            allMercIds = coreMercData.mercenaries.map(function (m) { return m.id; });
        }
        if (coreMercData.eliteSlots) {
            coreMercData.eliteSlots.forEach(function (es) {
                if (es.mercenary && allMercIds.indexOf(es.mercenary.id) === -1) {
                    allMercIds.push(es.mercenary.id);
                }
            });
        }
        console.log('[COR3 Helper] Configuring ' + allMercIds.length + ' CORE mercs');
        (function configureNext(i) {
            if (aborted || i >= allMercIds.length) {
                window.__cor3CoreMercFetchInProgress = false;
                coreMercAbort = null;
                if (!aborted) {
                    console.log('[COR3 Helper] CORE merc configure complete');
                    if (callback) callback();
                }
                return;
            }
            window.__cor3RequestMercConfigure(allMercIds[i], mid, configIds.locationConfigId, configIds.zoneConfigId, configIds.goalId);
            function onConfigResponse(evt3) {
                if (aborted) { window.removeEventListener('message', onConfigResponse); return; }
                if (evt3.data && evt3.data.type === 'COR3_WS_MERC_CONFIGURE') {
                    window.removeEventListener('message', onConfigResponse);
                    clearTimeout(configTimeout);
                    setTimeout(function () { configureNext(i + 1); }, 200);
                }
            }
            window.addEventListener('message', onConfigResponse);
            var configTimeout = setTimeout(function () {
                window.removeEventListener('message', onConfigResponse);
                configureNext(i + 1);
            }, 5000);
        })(0);
    }
    window.addEventListener('message', onCoreData);
    var coreTimer = setTimeout(function () {
        if (!coreDone && !aborted) {
            coreDone = true;
            window.removeEventListener('message', onCoreData);
            window.__cor3CoreMercFetchInProgress = false;
            coreMercAbort = null;
            console.log('[COR3 Helper] CORE merc data fetch timeout');
            if (callback) callback();
        }
    }, 30000);
    return true;
};

// Request expedition config (returns location/zone/goal IDs)
window.__cor3RequestExpeditionConfig = function (marketId) {
    var mid = marketId || window.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
    console.log('[COR3 Helper] Requesting expedition config for market:', mid);
    var msg = '42["event",{"event":{"name":"expeditions","action":"get.config"},"data":{"marketId":"' + mid + '"}}]';
    wsSend(msg);
    return true;
};

// Track pending mercenary configure requests (queue of mercenaryIds)
window.__cor3PendingMercConfigures = [];

// Request mercenary configure details (cost, risk, chances)
window.__cor3RequestMercConfigure = function (mercenaryId, marketId, locationConfigId, zoneConfigId, goalId) {
    var mid = marketId || window.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
    console.log('[COR3 Helper] Requesting configure for mercenary:', mercenaryId);
    window.__cor3PendingMercConfigures.push(mercenaryId);
    var data = {
        mercenaryId: mercenaryId,
        marketId: mid,
        locationConfigId: locationConfigId,
        zoneConfigId: zoneConfigId,
        goalId: goalId,
        hasInsurance: false
    };
    var msg = '42["event",{"event":{"name":"expeditions","action":"configure"},"data":' + JSON.stringify(data) + '}]';
    wsSend(msg);
    return true;
};

// USOL merc abort handle for cancelling in-flight requests
var usolMercAbort = null;

// Request USOL mercenary data: set endpoint → get.mercenaries → (get.config if needed) → configure each merc
window.__cor3RequestUsolMercenaries = function (callback, opts = {}) {
    var cachedUnreachable = opts.force ? null : window.__cor3IsMarketUnreachable('usol');
    if (cachedUnreachable) {
        console.log('[COR3 Helper] USOL market known unreachable (' + cachedUnreachable.blockerName + ' maintenance) — skipping merc fetch');
        window.postMessage({
            type: 'COR3_WS_USOL_MARKET_UNREACHABLE',
            error: 'no-path-to-server',
            blockerServerName: cachedUnreachable.blockerName,
            maintenanceEndsAt: cachedUnreachable.maintenanceEndsAt,
            cached: true, checkedAt: cachedUnreachable.detectedAt
        }, '*');
        if (callback) callback();
        return true;
    }
    if (window.__cor3UsolMercFetchInProgress) {
        console.log('[COR3 Helper] USOL merc fetch already in progress — aborting previous');
        if (usolMercAbort) usolMercAbort();
    }
    console.log('[COR3 Helper] Starting USOL mercenary data fetch');
    window.__cor3UsolMercFetchInProgress = true;

    var aborted = false;
    usolMercAbort = function () {
        aborted = true;
        window.__cor3UsolMercFetchInProgress = false;
        usolMercAbort = null;
    };

    var setEndpoint = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + USOL_SERVER_ID + '"}}]';
    wsSend(setEndpoint);

    function fetchMercData() {
        setTimeout(function () {
            if (aborted) return;
            console.log('[COR3 Helper] Requesting USOL mercenaries');
            var getMercs = '42["event",{"event":{"name":"expeditions","action":"get.mercenaries"},"data":{"marketId":"' + USOL_MARKET_ID + '"}}]';
            wsSend(getMercs);
            setTimeout(function () {
                if (aborted) return;
                var getConfig = '42["event",{"event":{"name":"expeditions","action":"get.config"},"data":{"marketId":"' + USOL_MARKET_ID + '"}}]';
                wsSend(getConfig);
            }, humanDelay());
        }, humanDelay());

        var usolMercData = null;
        var usolConfigData = null;
        var usolDone = false;
        function onUsolData(evt2) {
            if (usolDone || aborted) return;
            if (!evt2.data) return;
            if (evt2.data.type === 'COR3_WS_USOL_MERCENARIES') {
                usolMercData = evt2.data.data;
                checkAndConfigure();
            }
            if (evt2.data.type === 'COR3_WS_USOL_EXPEDITION_CONFIG') {
                usolConfigData = window.__cor3PickLocationConfig(evt2.data.data && evt2.data.data.locations);
                window.__cor3UsolExpConfigIds = usolConfigData;
                checkAndConfigure();
            }
        }
        function checkAndConfigure() {
            if (!usolMercData || !usolConfigData) return;
            usolDone = true;
            window.removeEventListener('message', onUsolData);
            clearTimeout(usolTimer);
            var configIds = usolConfigData;
            var allMercIds = [];
            if (usolMercData.mercenaries) {
                allMercIds = usolMercData.mercenaries.map(function (m) { return m.id; });
            }
            if (usolMercData.eliteSlots) {
                usolMercData.eliteSlots.forEach(function (es) {
                    if (es.mercenary && allMercIds.indexOf(es.mercenary.id) === -1) {
                        allMercIds.push(es.mercenary.id);
                    }
                });
            }
            console.log('[COR3 Helper] Configuring ' + allMercIds.length + ' USOL mercs');
            (function configureNext(i) {
                if (aborted || i >= allMercIds.length) {
                    window.__cor3UsolMercFetchInProgress = false;
                    usolMercAbort = null;
                    if (!aborted) {
                        console.log('[COR3 Helper] USOL merc configure complete');
                        if (callback) callback();
                    }
                    return;
                }
                window.__cor3RequestMercConfigure(allMercIds[i], USOL_MARKET_ID, configIds.locationConfigId, configIds.zoneConfigId, configIds.goalId);
                function onConfigResponse(evt3) {
                    if (aborted) { window.removeEventListener('message', onConfigResponse); return; }
                    if (evt3.data && evt3.data.type === 'COR3_WS_MERC_CONFIGURE') {
                        window.removeEventListener('message', onConfigResponse);
                        clearTimeout(configTimeout);
                        setTimeout(function () { configureNext(i + 1); }, 200);
                    }
                }
                window.addEventListener('message', onConfigResponse);
                var configTimeout = setTimeout(function () {
                    window.removeEventListener('message', onConfigResponse);
                    configureNext(i + 1);
                }, 5000);
            })(0);
        }
        window.addEventListener('message', onUsolData);
        var usolTimer = setTimeout(function () {
            if (!usolDone && !aborted) {
                usolDone = true;
                window.removeEventListener('message', onUsolData);
                window.__cor3UsolMercFetchInProgress = false;
                usolMercAbort = null;
                console.log('[COR3 Helper] USOL merc data fetch timeout');
                if (callback) callback();
            }
        }, 30000);
    }

    function startPathThroughThenRetry() {
        console.log('[COR3 Helper] USOL merc: endpoint unreachable — starting dynamic path-through');
        __cor3FetchMapData().then(function (mapData) {
            if (aborted) return;
            if (!mapData) {
                console.log('[COR3 Helper] USOL merc path-through: map data timeout — giving up');
                window.__cor3UsolMercFetchInProgress = false;
                usolMercAbort = null;
                __cor3PostUnreachable('usol', null);
                if (callback) callback();
                return;
            }
            var paths = __cor3FindPathsToServer(mapData.servers, mapData.connections, USOL_SERVER_ID);
            if (paths.length === 0) {
                console.log('[COR3 Helper] USOL merc path-through: no viable paths (maintenance blocked)');
                window.__cor3UsolMercFetchInProgress = false;
                usolMercAbort = null;
                __cor3PostUnreachable('usol', null);
                if (callback) callback();
                return;
            }
            console.log('[COR3 Helper] USOL merc path-through: found ' + paths.length + ' path(s)');
            var pathIdx = 0;
            function tryNextPath() {
                if (aborted) return;
                if (pathIdx >= paths.length) {
                    console.log('[COR3 Helper] USOL merc path-through: all paths exhausted');
                    window.__cor3UsolMercFetchInProgress = false;
                    usolMercAbort = null;
                    __cor3PostUnreachable('usol', null);
                    if (callback) callback();
                    return;
                }
                var currentPath = paths[pathIdx];
                pathIdx++;
                var intermediates = currentPath.length > 1 ? currentPath.slice(0, currentPath.length - 1) : [];
                if (intermediates.length === 0) { retryEndpoint(); return; }
                var pathNames = currentPath.map(function (s) { return s.name; }).join(' → ');
                console.log('[COR3 Helper] USOL merc path-through: trying path ' + pathIdx + '/' + paths.length + ': ' + pathNames);
                var stepIdx = 0;
                function nextStep() {
                    if (aborted) return;
                    if (stepIdx >= intermediates.length) { retryEndpoint(); return; }
                    var server = intermediates[stepIdx];
                    stepIdx++;
                    var setEp = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + server.id + '"}}]';
                    wsSend(setEp);
                    __cor3WaitForMsg('COR3_WS_ENDPOINT_RESULT', 10000).then(function (epData) {
                        if (aborted) return;
                        if (epData.success === false) {
                            console.log('[COR3 Helper] USOL merc path-through: ' + server.name + ' unreachable — trying next path');
                            tryNextPath();
                            return;
                        }
                        __cor3EnsureServerAccess(server.id, server.name).then(function () {
                            if (aborted) return;
                            setTimeout(nextStep, 500);
                        }).catch(function () {
                            tryNextPath();
                        });
                    }).catch(function () {
                        __cor3EnsureServerAccess(server.id, server.name).then(function () {
                            if (aborted) return;
                            setTimeout(nextStep, 500);
                        }).catch(function () {
                            tryNextPath();
                        });
                    });
                }
                nextStep();
            }
            function retryEndpoint() {
                if (aborted) return;
                console.log('[COR3 Helper] USOL merc path-through: retrying endpoint');
                var setEp2 = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + USOL_SERVER_ID + '"}}]';
                wsSend(setEp2);
                __cor3WaitForMsg('COR3_WS_ENDPOINT_RESULT', 10000).then(function (retryData) {
                    if (aborted) return;
                    if (retryData.success === false) {
                        console.log('[COR3 Helper] USOL merc path-through: endpoint retry failed');
                        window.__cor3UsolMercFetchInProgress = false;
                        usolMercAbort = null;
                        __cor3PostUnreachable('usol', null);
                        if (callback) callback();
                        return;
                    }
                    console.log('[COR3 Helper] USOL merc path-through: endpoint set — fetching merc data');
                    fetchMercData();
                }).catch(function () {
                    window.__cor3UsolMercFetchInProgress = false;
                    usolMercAbort = null;
                    console.log('[COR3 Helper] USOL merc path-through: retry timeout');
                    if (callback) callback();
                });
            }
            tryNextPath();
        });
    }

    var handled = false;
    function onEndpointResult(evt) {
        if (handled || aborted) return;
        if (evt.data && evt.data.type === 'COR3_WS_ENDPOINT_RESULT') {
            handled = true;
            window.removeEventListener('message', onEndpointResult);
            clearTimeout(epTimer);
            if (evt.data.success === false) {
                startPathThroughThenRetry();
                return;
            }
            fetchMercData();
        }
        if (evt.data && evt.data.type === 'COR3_WS_USOL_MARKET_UNREACHABLE') {
            handled = true;
            window.removeEventListener('message', onEndpointResult);
            clearTimeout(epTimer);
            startPathThroughThenRetry();
        }
    }
    window.addEventListener('message', onEndpointResult);
    var epTimer = setTimeout(function () {
        if (!handled && !aborted) {
            handled = true;
            window.removeEventListener('message', onEndpointResult);
            window.__cor3UsolMercFetchInProgress = false;
            usolMercAbort = null;
            console.log('[COR3 Helper] USOL merc endpoint timeout');
            if (callback) callback();
        }
    }, 10000);
    return true;
};

// Configure and launch expedition with mercenary
// For non-HOME markets, set.endpoint to the market server first
let lastLaunchCreditReserve = false;
window.__cor3LaunchExpedition = function (configData, requestId, keepCreditReserve) {
    // Legacy location/rate-limit retries omit the preference. Retain the guard
    // from the original launch rather than bypassing it on those retries.
    if (typeof keepCreditReserve === 'boolean') lastLaunchCreditReserve = keepCreditReserve;
    keepCreditReserve = lastLaunchCreditReserve;
    const options = requestOptions(requestId);
    if (!requestId && keepCreditReserve) options.onReject = error => {
        window.postMessage({ type: error.code === 'insufficient_credits'
            ? 'COR3_WS_INSUFFICIENT_CREDITS' : 'COR3_WS_EXPEDITION_LAUNCH_ERROR',
            error: error.message }, '*');
    };
    console.log('[COR3 Helper] Launching expedition with config:', configData);
    var marketId = configData.marketId;
    var needsEndpoint = marketId && marketId !== '019d3ea4-85bd-7389-904d-8f7c85841134'; // not HOME
    var serverId = null;
    if (marketId === USOL_MARKET_ID) serverId = USOL_SERVER_ID;

    function doConfigureAndLaunch() {
        if (options.cancelled?.()) return;
        var configureMsg = '42["event",{"event":{"name":"expeditions","action":"configure"},"data":' + JSON.stringify(configData) + '}]';
        let quotedCost = null;
        function launch() { setTimeout(function () {
            var launchMsg = '42["event",{"event":{"name":"expeditions","action":"launch"},"data":' + JSON.stringify(configData) + '}]';
            wsSend(launchMsg, { ...options, onResponse(payload, request) {
                if (!request.ambiguous && !payload.error && payload.data?.id) reportActivity({ kind: 'mercenaryLaunch',
                    id: 'mercenary-launch:' + payload.data.id, cost: quotedCost });
            } });
            console.log('[COR3 Helper] Expedition launch sent');
        }, humanDelay() + 500); }
        if (!keepCreditReserve) {
            wsSend(configureMsg, { ...options, onResponse(quote, request) {
                if (!request.ambiguous && !quote.error && Number.isFinite(quote.data?.totalCost)) quotedCost = quote.data.totalCost;
            } });
            launch();
            return;
        }
        // Use the live quote, including insurance, and a fresh balance from the
        // same market. Missing or ambiguous replies must never allow a launch.
        const invalidBudget = () => options.onReject?.({ code: 'game_reply_timeout',
            message: 'Could not confirm the expedition cost and credit reserve. Retrying automatically.' });
        wsSend(configureMsg, { ...options, onResponse(quote, request) {
            if (options.cancelled?.()) return;
            if (request.ambiguous || quote.error || !Number.isFinite(quote.data?.totalCost) || quote.data.totalCost < 0) {
                invalidBudget(); return;
            }
            const requiredCredits = quote.data.totalCost + 2000;
            quotedCost = quote.data.totalCost;
            const balanceMsg = '42' + JSON.stringify(['event', {
                event: { name: 'market', action: 'get.options' }, data: { marketId }
            }]);
            wsSend(balanceMsg, { ...options, onResponse(balance, balanceRequest) {
                if (options.cancelled?.()) return;
                if (balanceRequest.ambiguous || balance.error || !Number.isFinite(balance.data?.userCredits)) {
                    invalidBudget(); return;
                }
                if (balance.data.userCredits < requiredCredits) {
                    options.onReject?.({ code: 'insufficient_credits', requiredCredits,
                        message: 'Waiting for enough credits to keep 2,000 after the expedition cost.' });
                    return;
                }
                launch();
            } });
        } });
    }

    if (needsEndpoint && serverId) {
        console.log('[COR3 Helper] Setting endpoint to market server before launch:', serverId);
        var setEp = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + serverId + '"}}]';
        wsSend(setEp, options);
        var epHandled = false;
        function onEpResult(evt) {
            if (epHandled) return;
            if (evt.data && evt.data.type === 'COR3_WS_ENDPOINT_RESULT') {
                if (evt.data.serverId && evt.data.serverId !== serverId) return;
                epHandled = true;
                window.removeEventListener('message', onEpResult);
                clearTimeout(epTimeout);
                if (evt.data.success === false) {
                    console.log('[COR3 Helper] Endpoint unreachable for launch, aborting');
                    options.onReject?.(evt.data.error || { message: 'The expedition market is unavailable.' });
                    return;
                }
                setTimeout(doConfigureAndLaunch, humanDelay());
            }
        }
        window.addEventListener('message', onEpResult);
        var epTimeout = setTimeout(function () {
            if (!epHandled) {
                epHandled = true;
                window.removeEventListener('message', onEpResult);
                console.log('[COR3 Helper] Endpoint not confirmed; deferring launch');
                options.onReject?.({ code: 'game_reply_timeout', message: 'Timed out waiting for COR3_WS_ENDPOINT_RESULT.', replyType: 'COR3_WS_ENDPOINT_RESULT' });
            }
        }, 8000);
    } else {
        doConfigureAndLaunch();
    }
    return true;
};

// The game retains this action name for paying and sending rewards to mail.
window.__cor3PayExpeditionToMail = function (expeditionId, requestId) {
    if (typeof expeditionId !== 'string' || !expeditionId) return false;
    wsSend('42' + JSON.stringify(['event', {
        event: { name: 'expeditions', action: 'open.container' },
        data: { expeditionId: expeditionId }
    }]), requestOptions(requestId));
    return true;
};

// Refresh mailbox state. Joining rooms follows the same protocol as stash.
window.__cor3RequestMail = function (requestId) {
    const options = requestOptions(requestId);
    enterRooms(['mail']).then(function () {
        wsSend('42["event",{"event":{"name":"mail","action":"get.state"},"data":{}}]', options);
    });
    return true;
};

window.__cor3ClaimMail = function (messageId, requestId) {
    if (typeof messageId !== 'string' || !messageId) return false;
    wsSend('42' + JSON.stringify(['event', {
        event: { name: 'mail', action: 'claim.all' }, data: { messageId: messageId }
    }]), requestOptions(requestId));
    return true;
};
