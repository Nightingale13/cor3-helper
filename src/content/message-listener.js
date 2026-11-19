// chrome.runtime.onMessage listener — handles messages from popup/background

import { isContextValid, _automationEnqueue, _automationFinish, _broadcastQueueStatus, setAutomationQueue, getAutomationQueue, getAutomationActive } from './helpers.js';
import { userIdleTimeout as setTimeout } from '../shared/ws-utils.js';
import { isMinigameLocked } from '../shared/job-retry.js';
import { setAlarms, resetAlarmTriggered, playAlarm, startContinuousAlarm, stopAlarm } from './alarms.js';
import { setAutoRefreshSettings } from './auto-refresh.js';
import { requestDroneDecision } from './drone.js';
import { checkAutoChooseFromContent, requestMercenaryDecision } from './auto-choose.js';
import { checkAutoDailyHack } from './daily-hack.js';
import { setMarketRefreshInProgress, setAutoUpdateMarketsLastRefresh, setAutoJobsActive, _marketRefreshInProgress, _autoUpdateMarketsLastRefresh, queueMarketRefresh } from './auto-update-markets.js';
import {
    injectDecryptSolver, stopDecryptSolver,
    injectIceWallSolver, stopIceWallSolver,
    injectSimpleDecryptSolver, stopSimpleDecryptSolver,
    injectAutoJobSolver, injectAutoValuableSeller,
    ensureAntiAfkEnabled
} from './solvers.js';
import {
    deleteBackgroundElements,
    hideNetworkFogVideos, showNetworkFogVideos,
    startNetworkFogObserver, stopNetworkFogObserver,
    applyNotificationsLeft, removeNotificationsLeft
} from './dom-tweaks.js';

function fetchDailyRewards(token) {
    fetch('https://svc-corie.cor3.gg/api/user-daily-claim/rewards', {
        headers: { 'Authorization': token }
    })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
        if (data && Array.isArray(data)) {
            chrome.storage.local.set({ dailyRewardsData: data });
        }
    })
    .catch(() => {});
}

let autoJobsGeneration = 0;
let autoJobsStarted = false;
let valuableGeneration = 0;
let valuableStarted = false;

export function setupMessageListener() {
    window.addEventListener('message', event => {
        if (event.source === window && event.data?.type === 'COR3_AUTOJOB_DONE') autoJobsStarted = false;
        if (event.source === window && ['COR3_VALUABLE_DONE', 'COR3_VALUABLE_FORCE_MAINT_DONE'].includes(event.data?.type)) valuableStarted = false;
    });
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'cor3Ping') {
            sendResponse({ ready: window.__cor3ContentBootstrap?.ready === true });
        } else if (request.action === 'restoreGameConnection') {
            if (request.initialFetchDone) {
                window.postMessage({ type: 'COR3_USOL_MERCS_DONE' }, '*');
                window.postMessage({ type: 'COR3_INITIAL_FETCH_DONE' }, '*');
            }
            sendResponse({ success: true });
        } else if (request.action === "respondDroneDecision") {
            requestDroneDecision({ missionId: request.expeditionId, eventId: request.messageId, optionId: request.selectedOption });
            sendResponse({ success: true });
        } else if (request.action === "requestDroneOptions") {
            window.postMessage({ type: "COR3_DRONE_COMMAND", action: "get.options", data: {} }, "*");
            sendResponse({ success: true });
        } else if (request.action === "requestDroneArchived") {
            chrome.storage.local.get('droneData', local => {
                if (local.droneData?.drone) window.postMessage({ type: "COR3_DRONE_COMMAND", action: "get.archived", data: { cursor: null, limit: 20 } }, "*");
                sendResponse({ success: true });
            });
            return true;
        } else if (request.action === "updateAlarms") {
            setAlarms(request.alarms || []);
            resetAlarmTriggered();
            sendResponse({ success: true });
        } else if (request.action === "testAlarm") {
            const vol = request.volume !== undefined ? request.volume : 50;
            if (request.continuous) {
                startContinuousAlarm(vol);
            } else {
                playAlarm(vol);
            }
            sendResponse({ success: true });
        } else if (request.action === "stopAlarm") {
            stopAlarm();
            sendResponse({ success: true });
        } else if (request.action === "requestExpeditions") {
            window.postMessage({ type: 'COR3_REQUEST_EXPEDITIONS' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestNetworkMap") {
            window.postMessage({ type: 'COR3_REQUEST_NETWORK_MAP' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "devTcTestReachability") {
            window.postMessage({ type: 'COR3_DEV_TC_TEST_REACHABILITY', serverId: request.serverId }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestStash") {
            window.postMessage({ type: 'COR3_REQUEST_STASH' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestSpecialists") {
            window.postMessage({ type: 'COR3_REQUEST_SPECIALISTS' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "purchaseSpecialist") {
            window.postMessage({ type: 'COR3_PURCHASE_SPECIALIST', specialistType: request.specialistType, kind: request.kind, level: request.level, priceId: request.priceId }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestLoadout") {
            window.postMessage({ type: 'COR3_REQUEST_LOADOUT' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "equipHardware") {
            window.postMessage({ type: 'COR3_EQUIP_HARDWARE', moduleConfigId: request.moduleConfigId }, '*');
            sendResponse({ success: true });
        } else if (request.action === "equipSoftware") {
            window.postMessage({ type: 'COR3_EQUIP_SOFTWARE', moduleConfigId: request.moduleConfigId }, '*');
            sendResponse({ success: true });
        } else if (request.action === "unequipSoftware") {
            window.postMessage({ type: 'COR3_UNEQUIP_SOFTWARE', moduleConfigId: request.moduleConfigId }, '*');
            sendResponse({ success: true });
        } else if (['requestMarket', 'refreshMarket', 'requestDarkMarket', 'refreshDarkMarket',
            'requestSoyuzMarket', 'refreshSoyuzMarket', 'requestUsolMarket', 'refreshUsolMarket'].includes(request.action)) {
            const market = /Dark/.test(request.action) ? 'dark' : /Soyuz/.test(request.action) ? 'soyuz' : /Usol/.test(request.action) ? 'usol' : 'home';
            setAutoUpdateMarketsLastRefresh(Date.now());
            const queueResult = queueMarketRefresh('market-' + market, { type: 'COR3_REFRESH_ALL_MARKETS_SEQ', order: [market] });
            sendResponse({ success: true, queueResult });
        } else if (request.action === "refreshAllMarketsSeq") {
            setAutoUpdateMarketsLastRefresh(Date.now());
            const message = { type: 'COR3_REFRESH_ALL_MARKETS_SEQ', skipLots: !!request.skipLots };
            if (request.requestId) message.requestId = request.requestId;
            if (request.order) message.order = request.order;
            const queueResult = queueMarketRefresh(request.requestId ? 'scheduled-market-refresh' : 'manual-market-refresh', message);
            sendResponse({ success: true, queueResult });
        } else if (request.action === 'cancelScheduledMarketRefresh') {
            setAutomationQueue(getAutomationQueue().filter(task => task.type !== 'scheduled-market-refresh'));
            window.postMessage({ type: 'COR3_STOP_MARKET_REFRESH', requestId: request.requestId }, '*');
            sendResponse({ success: true });
        } else if (request.action === "leaveStash") {
            window.postMessage({ type: 'COR3_LEAVE_STASH' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "sellItem") {
            window.postMessage({ type: 'COR3_SELL_ITEM', itemId: request.itemId, quantity: request.quantity || 1 }, '*');
            sendResponse({ success: true });
        } else if (request.action === "keepWorkerAlive") {
            window.postMessage({ type: 'COR3_KEEP_ALIVE' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "updateAutoRefresh") {
            if (request.autoRefresh) {
                setAutoRefreshSettings(request.autoRefresh);
            }
            sendResponse({ success: true });
        } else if (request.action === "toggleDecryptSolver") {
            if (request.enabled) {
                ensureAntiAfkEnabled();
                injectDecryptSolver();
            } else {
                stopDecryptSolver();
            }
            sendResponse({ success: true });
        } else if (request.action === "toggleIceWallSolver") {
            if (request.enabled) {
                ensureAntiAfkEnabled();
                injectIceWallSolver();
            } else {
                stopIceWallSolver();
            }
            sendResponse({ success: true });
        } else if (request.action === "toggleSimpleDecryptSolver") {
            if (request.enabled) {
                ensureAntiAfkEnabled();
                injectSimpleDecryptSolver();
            } else {
                stopSimpleDecryptSolver();
            }
            sendResponse({ success: true });
        } else if (request.action === "toggleDailyHackSolver") {
            chrome.storage.sync.set({ autoDailyHackEnabled: !!request.enabled }).then(() => checkAutoDailyHack());
            sendResponse({ success: true });
        } else if (request.action === "checkMercenaryDecisions") {
            checkAutoChooseFromContent().catch(() => {});
            sendResponse({ success: true });
        } else if (request.action === "respondDecision") {
            requestMercenaryDecision(request).then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        } else if (request.action === "requestArchivedExpeditions") {
            window.postMessage({ type: 'COR3_REQUEST_ARCHIVED_EXPEDITIONS' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestMercenaries") {
            window.postMessage({ type: 'COR3_REQUEST_MERCENARIES' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestUsolMercenaries") {
            window.postMessage({ type: 'COR3_REQUEST_USOL_MERCENARIES', force: true }, '*');
            sendResponse({ success: true });
        } else if (request.action === "requestExpeditionConfig") {
            window.postMessage({ type: 'COR3_REQUEST_EXPEDITION_CONFIG', mercenaryId: request.mercenaryId }, '*');
            sendResponse({ success: true });
        } else if (request.action === "launchExpedition") {
            chrome.storage.local.set({ lastExpeditionLaunchData: request.config });
            window.postMessage({ type: 'COR3_LAUNCH_EXPEDITION', config: request.config }, '*');
            sendResponse({ success: true });
        } else if (request.action === "fetchDailyOps") {
            chrome.storage.local.get('bearerToken', (result) => {
                const token = result.bearerToken;
                if (!token) {
                    sendResponse({ error: 'no token' });
                    return;
                }
                fetch('https://svc-corie.cor3.gg/api/user-daily-claim', {
                    headers: { 'Authorization': token }
                })
                .then(r => {
                    if (r.ok) return r.json();
                    if (r.status === 400 || r.status === 401 || r.status === 403) return r.json().then(d => { throw new Error(d.message || 'token_expired'); }).catch(() => { throw new Error('token_expired'); });
                    return null;
                })
                .then(data => {
                    if (data) {
                        chrome.storage.local.set({ dailyOpsData: data, dailyOpsUpdatedAt: Date.now() });
                        fetchDailyRewards(token);
                    }
                    sendResponse({ data: data });
                })
                .catch(e => { cor3LogError('content.js', e, { action: 'fetchDailyOps' }); sendResponse({ error: e.message || 'fetch failed' }); });
            });
            return true; // keep channel open for async sendResponse
        } else if (request.action === "disableBackground") {
            chrome.storage.sync.set({ disableBackground: true });
            deleteBackgroundElements();
            console.log('[COR3 Helper] Background elements deleted');
            sendResponse({ success: true });
        } else if (request.action === "enableBackground") {
            chrome.storage.sync.set({ disableBackground: false });
            console.log('[COR3 Helper] Background elements will be restored on page reload');
            sendResponse({ success: true });
        } else if (request.action === "disableNetworkFog") {
            chrome.storage.sync.set({ disableNetworkFog: true });
            startNetworkFogObserver();
            hideNetworkFogVideos();
            console.log('[COR3 Helper] Network fog disabled');
            sendResponse({ success: true });
        } else if (request.action === "enableNetworkFog") {
            chrome.storage.sync.set({ disableNetworkFog: false });
            stopNetworkFogObserver();
            showNetworkFogVideos();
            console.log('[COR3 Helper] Network fog re-enabled');
            sendResponse({ success: true });
        } else if (request.action === "moveNotificationsLeft") {
            chrome.storage.sync.set({ moveNotificationsLeft: true });
            applyNotificationsLeft();
            console.log('[COR3 Helper] Notifications moved to left');
            sendResponse({ success: true });
        } else if (request.action === "moveNotificationsRight") {
            chrome.storage.sync.set({ moveNotificationsLeft: false });
            removeNotificationsLeft();
            console.log('[COR3 Helper] Notifications moved back to right');
            sendResponse({ success: true });
        } else if (request.action === "getVersionFallbacks") {
            sendResponse({
                webVersion: window.__cor3WebVersion,
                systemVersion: window.__cor3SystemVersion,
                patchVersion: window.__cor3PatchVersion,
                gameVersionSession: window.__cor3GameVersionSession
            });
        } else if (request.action === "startAutoJobs") {
            ensureAntiAfkEnabled();
            const jobs = request.jobs;
            const settings = request.settings || {};
            const generation = autoJobsGeneration;
            const result = _automationEnqueue('auto-jobs', async () => {
                const active = getAutomationActive();
                setAutoJobsActive(true);
                try {
                    await injectAutoJobSolver();
                    if (generation !== autoJobsGeneration || !isContextValid()) return;
                    if (!request.automatic) await chrome.storage.local.remove('autoJobsStoppedRevision');
                    const lockData = await chrome.storage.local.get(['autoJobsLockedJobs', 'autoJobsCompletedResults']);
                    if (generation !== autoJobsGeneration) return;
                    var lockedJobs = [...(lockData.autoJobsLockedJobs || []), ...(lockData.autoJobsCompletedResults || []), ...(settings.lockedJobs || [])];
                    if (lockedJobs && lockedJobs.length > 0) {
                        var now = Date.now();
                        var locksByJob = new Map();
                        for (const job of lockedJobs) {
                            const previous = locksByJob.get(job.jobId);
                            if (isMinigameLocked(job, now) && (!previous ||
                                new Date(job.lockExpiresAt).getTime() > new Date(previous.lockExpiresAt).getTime())) {
                                locksByJob.set(job.jobId, { jobId: job.jobId, lockExpiresAt: job.lockExpiresAt });
                            }
                        }
                        var stillLocked = [...locksByJob.values()];
                        settings.lockedJobs = stillLocked;
                        await chrome.storage.local.set({ autoJobsLockedJobs: stillLocked });
                    }
                    await chrome.storage.local.set({ autoJobsRunning: true });
                    if (generation !== autoJobsGeneration) return;
                    autoJobsStarted = true;
                    window.postMessage({ type: 'COR3_AUTOJOB_START', jobs: jobs, settings: settings }, '*');
                } catch (error) {
                    if (isContextValid()) await chrome.storage.local.set({ autoJobsRunning: false });
                    throw error;
                } finally {
                    if (!autoJobsStarted && getAutomationActive() === active) {
                        setAutoJobsActive(false);
                        _automationFinish('auto-jobs');
                    }
                }
            });
            sendResponse({ success: true, queueResult: result });
        } else if (request.action === "stopAutoJobs") {
            autoJobsGeneration++;
            setAutomationQueue(getAutomationQueue().filter(q => q.type !== 'auto-jobs'));
            window.postMessage({ type: 'COR3_AUTOJOB_STOP' }, '*');
            const active = getAutomationActive();
            if (autoJobsStarted && active?.type === 'auto-jobs') active.stopping = true;
            else { setAutoJobsActive(false); _automationFinish('auto-jobs'); }
            _broadcastQueueStatus();
            chrome.storage.local.get('marketJobsRevision').then(local => chrome.storage.local.set({
                autoJobsStoppedRevision: local.marketJobsRevision || 0, autoJobsRunning: false
            })).then(() => sendResponse({ success: true })).catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        } else if (request.action === "enableHackSolvers") {
            ensureAntiAfkEnabled();
            injectDecryptSolver();
            injectIceWallSolver();
            injectSimpleDecryptSolver();
            sendResponse({ success: true });
        } else if (request.action === "dismissFailedJobs") {
            var dismissJobs = request.jobs || [];
            var dismissMarketKey = request.marketKey || '';
            var dismissStorageKey = { home: 'marketData', dark: 'darkMarketData', soyuz: 'soyuzMarketData', usol: 'usolMarketData' }[dismissMarketKey] || '';
            var dismissRefreshType = { home: 'COR3_REFRESH_MARKET', dark: 'COR3_REFRESH_DARK_MARKET', soyuz: 'COR3_REFRESH_SOYUZ_MARKET', usol: 'COR3_REFRESH_USOL_MARKET' }[dismissMarketKey] || '';
            var result = _automationEnqueue('clear-failed-jobs', function () {
                (async function () {
                    try {
                        for (var i = 0; i < dismissJobs.length; i++) {
                            window.postMessage({ type: 'COR3_AUTOJOB_CMD', cmd: 'job.dismiss', data: dismissJobs[i] }, '*');
                            if (dismissStorageKey) {
                                var fresh = await chrome.storage.local.get(dismissStorageKey);
                                var freshMd = fresh[dismissStorageKey];
                                if (freshMd && freshMd.recentJobs) {
                                    freshMd.recentJobs = freshMd.recentJobs.filter(function (j) { return j.id !== dismissJobs[i].jobId; });
                                    await chrome.storage.local.set({ [dismissStorageKey]: freshMd });
                                }
                            }
                            await new Promise(function (r) { setTimeout(r, 500); });
                        }
                        await new Promise(function (r) { setTimeout(r, 2000); });
                        if (dismissRefreshType) {
                            setAutoUpdateMarketsLastRefresh(Date.now());
                            queueMarketRefresh('market-' + dismissMarketKey, { type: 'COR3_REFRESH_ALL_MARKETS_SEQ', order: [dismissMarketKey] });
                        }
                    } catch (e) {
                        console.log('[COR3 Helper] dismissFailedJobs error:', e);
                    } finally {
                        _automationFinish('clear-failed-jobs');
                    }
                })();
            });
            sendResponse({ success: true, queueResult: result });
        } else if (request.action === "devtoolsSendWs") {
            window.postMessage({ type: 'COR3_DEVTOOLS_WS_SEND', message: request.message }, '*');
            sendResponse({ success: true });
        } else if (request.action === "startValuableSearch") {
            ensureAntiAfkEnabled();
            const generation = valuableGeneration;
            const result = _automationEnqueue('auto-valuable', async () => {
                const active = getAutomationActive();
                try {
                    await injectAutoValuableSeller();
                    if (generation !== valuableGeneration) return;
                    await chrome.storage.local.set({ valuableSearchRunning: true });
                    if (generation !== valuableGeneration) return;
                    valuableStarted = true;
                    window.postMessage({ type: 'COR3_VALUABLE_START_SEARCH' }, '*');
                } finally {
                    if (!valuableStarted && getAutomationActive() === active) {
                        chrome.storage.local.set({ valuableSearchRunning: false });
                        _automationFinish('auto-valuable');
                    }
                }
            });
            sendResponse({ success: true, queueResult: result });
        } else if (request.action === "startValuableSeller") {
            ensureAntiAfkEnabled();
            const selServers = request.selectedServers || [];
            const selDownloads = request.selectedDownloads || [];
            const generation = valuableGeneration;
            const result = _automationEnqueue('auto-valuable', async () => {
                const active = getAutomationActive();
                try {
                    await injectAutoValuableSeller();
                    if (generation !== valuableGeneration) return;
                    await chrome.storage.local.set({ valuableSellerRunning: true });
                    if (generation !== valuableGeneration) return;
                    valuableStarted = true;
                    window.postMessage({
                        type: 'COR3_VALUABLE_START_SELLER',
                        selectedServers: selServers,
                        selectedDownloads: selDownloads
                    }, '*');
                } finally {
                    if (!valuableStarted && getAutomationActive() === active) {
                        chrome.storage.local.set({ valuableSellerRunning: false });
                        _automationFinish('auto-valuable');
                    }
                }
            });
            sendResponse({ success: true, queueResult: result });
        } else if (request.action === "stopValuable") {
            valuableGeneration++;
            setAutomationQueue(getAutomationQueue().filter(q => !['auto-valuable', 'force-maintenance'].includes(q.type)));
            window.postMessage({ type: 'COR3_VALUABLE_STOP' }, '*');
            const active = getAutomationActive();
            if (valuableStarted && ['auto-valuable', 'force-maintenance'].includes(active?.type)) active.stopping = true;
            else if (active?.type === 'force-maintenance') _automationFinish('force-maintenance');
            else _automationFinish('auto-valuable');
            _broadcastQueueStatus();
            sendResponse({ success: true });
        } else if (request.action === "forceMaintenanceBatch") {
            const generation = valuableGeneration;
            const result = _automationEnqueue('force-maintenance', async () => {
                const active = getAutomationActive();
                try {
                    await injectAutoValuableSeller();
                    if (generation !== valuableGeneration) return;
                    valuableStarted = true;
                    window.postMessage({
                        type: 'COR3_VALUABLE_FORCE_MAINTENANCE_BATCH',
                        servers: request.servers
                    }, '*');
                } finally {
                    if (!valuableStarted && getAutomationActive() === active) _automationFinish('force-maintenance');
                }
            });
            sendResponse({ success: true, queueResult: result });
        } else if (request.action === "startIpSearch") {
            window.postMessage({ type: 'COR3_IP_SEARCH_START' }, '*');
            sendResponse({ success: true });
        } else if (request.action === "fetchDailyOps") {
            window.postMessage({ type: 'COR3_FETCH_DAILY_OPS' }, '*');
            sendResponse({ success: true });
        }
    });
}
