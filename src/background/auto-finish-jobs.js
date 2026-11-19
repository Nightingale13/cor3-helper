import { getCor3Tab, bgAutoJobLog } from './helpers.js';
import { MARKET_IDS, LOG_JOB_TYPES } from '../shared/server-constants.js';
import { FALLBACK_PATH_MAP, FALLBACK_SERVER_PRIORITY } from '../shared/server-map.js';
import { ensureGameConnection, sendGameMessage } from '../shared/game-connection.js';
import { isMinigameLocked, isRetryableJobResult } from '../shared/job-retry.js';
import { marketRouteBlocker, maintenanceActive } from '../shared/market-reachability.js';

const SUPPORTED_JOB_TYPES_BG = [
    'File Decryption', 'IP Injection', 'Data Download', 'Log Deletion',
    'Log Download', 'Decrypt & Extract', 'File Elimination', 'Data Upload', 'IP Cleanup'
];

function isJobBuggedBg(job) {
    const sn = (job.relatedServers && job.relatedServers[0]) ? job.relatedServers[0].serverName : (job.serverName || '');
    return sn === 'D4RK RM7CE' && LOG_JOB_TYPES.includes(job.name);
}

const SERVER_PATH_MAP = FALLBACK_PATH_MAP;

function resolveRecentJobMarketBg(recentJob, fallbackKey, marketData, darkMarketData, soyuzMarketData, usolMarketData) {
    if (recentJob.marketId) {
        for (const [key, id] of Object.entries(MARKET_IDS)) {
            if (id === recentJob.marketId) return key;
        }
    }
    const jobId = recentJob.id;
    for (const [key, md] of [['home', marketData], ['dark', darkMarketData], ['soyuz', soyuzMarketData], ['usol', usolMarketData]]) {
        if (md && md.jobs) {
            if (md.jobs.find(j => j.id === jobId)) return key;
        }
    }
    return fallbackKey;
}

export function collectJobsBg(marketData, darkMarketData, completedResults, serverMaintenanceMap, soyuzMarketData, usolMarketData, networkMapData) {
    const SERVER_PRIORITY = FALLBACK_SERVER_PRIORITY;
    const JOB_TYPE_PRIORITY = ['IP Injection', 'IP Cleanup', 'Data Upload', 'Data Download', 'Log Deletion', 'Log Download', 'File Elimination', 'File Decryption', 'Decrypt & Extract'];
    const maint = serverMaintenanceMap || {};
    const now = Date.now();
    const skipIds = new Set();
    if (completedResults && completedResults.length > 0) {
        for (const cr of completedResults) {
            if (isMinigameLocked(cr, now) || cr.status === 'failed' || cr.status === 'bugged' ||
                (cr.status === 'skipped' && !cr.lockExpiresAt)) {
                skipIds.add(cr.jobId);
            }
        }
    }
    function getPathBlocker(serverName, serverId) {
        const servers = Array.isArray(networkMapData?.servers) ? networkMapData.servers.map(server => ({ ...server, ...maint[server.id] })) : null;
        const target = servers?.find(server => server.id === serverId || server.serverName === serverName);
        if (target && Array.isArray(networkMapData.connections)) {
            const blocker = marketRouteBlocker(servers, networkMapData.connections, target.id);
            if (blocker && blocker.blockerName !== 'no-path') return { blocked: true, ...blocker,
                blockerId: servers.find(server => server.serverName === blocker.blockerName)?.id };
            return { blocked: false };
        }
        // With no live graph, only the target's own maintenance is conclusive.
        // The solver will fetch routes before accepting a job.
        const targetId = serverId || SERVER_PATH_MAP[serverName]?.at(-1)?.id;
        const info = maint[targetId];
        return maintenanceActive(info, now) ? { blocked: true, blockerName: serverName, blockerId: targetId,
            maintenanceEndsAt: info.maintenanceEndsAt || null } : { blocked: false };
    }
    function getServerId(job) {
        return (job.relatedServers && job.relatedServers[0]) ? job.relatedServers[0].id
            : (job.conditions && job.conditions.serverConfigId) ? job.conditions.serverConfigId : null;
    }
    const jobs = [];
    const skippedMaintenance = [];
    const seenTakenIds = new Set();
    for (const marketKey of ['dark', 'home', 'soyuz', 'usol']) {
        const md = marketKey === 'home' ? marketData : marketKey === 'dark' ? darkMarketData : marketKey === 'usol' ? usolMarketData : soyuzMarketData;
        if (!md) continue;
        const openJobs = (md.jobs || []).filter(j => !j.isCompleted && !j.isExpired && SUPPORTED_JOB_TYPES_BG.includes(j.name) && !isJobBuggedBg(j) && !skipIds.has(j.id));
        const takenJobs = (md.recentJobs || []).filter(j => j.status === 'TAKEN' && SUPPORTED_JOB_TYPES_BG.includes(j.name) && !isJobBuggedBg(j) && !skipIds.has(j.id));
        for (const job of openJobs) {
            const serverName = (job.relatedServers && job.relatedServers[0]) ? job.relatedServers[0].serverName : 'None';
            const serverId = getServerId(job);
            const blocker = getPathBlocker(serverName, serverId);
            if (blocker.blocked) {
                skippedMaintenance.push({ serverName, serverId, blockerName: blocker.blockerName, blockerId: blocker.blockerId, maintenanceEndsAt: blocker.maintenanceEndsAt });
                continue;
            }
            jobs.push({
                jobId: job.id, name: job.name, type: job.name, serverName, serverId,
                marketId: MARKET_IDS[marketKey], marketKey,
                rewardCredits: job.rewardCredits, rewardReputation: job.rewardReputation,
                deposit: job.deposit || 0,
                conditions: job.conditions ? job.conditions.items || job.conditions : [],
                alreadyTaken: false, canComplete: false, status: 'pending'
            });
        }
        for (const job of takenJobs) {
            if (seenTakenIds.has(job.id)) continue;
            seenTakenIds.add(job.id);
            const trueMarketKey = resolveRecentJobMarketBg(job, marketKey, marketData, darkMarketData, soyuzMarketData, usolMarketData);
            const serverName = (job.relatedServers && job.relatedServers[0]) ? job.relatedServers[0].serverName : 'None';
            const serverId = getServerId(job);
            const blocker = getPathBlocker(serverName, serverId);
            if (blocker.blocked) {
                skippedMaintenance.push({ serverName, serverId, blockerName: blocker.blockerName, blockerId: blocker.blockerId, maintenanceEndsAt: blocker.maintenanceEndsAt });
                continue;
            }
            jobs.push({
                jobId: job.id, name: job.name, type: job.name, serverName, serverId,
                marketId: MARKET_IDS[trueMarketKey], marketKey: trueMarketKey,
                rewardCredits: job.rewardCredits, rewardReputation: job.rewardReputation,
                deposit: job.deposit || 0,
                conditions: job.conditions ? job.conditions.items || job.conditions : [],
                alreadyTaken: true, canComplete: !!job.canComplete, status: 'pending'
            });
        }
    }
    jobs.sort((a, b) => {
        const idxA = SERVER_PRIORITY.indexOf(a.serverName);
        const idxB = SERVER_PRIORITY.indexOf(b.serverName);
        const spA = (a.serverName === 'None' || !a.serverName) ? -1 : (idxA >= 0 ? idxA : SERVER_PRIORITY.length);
        const spB = (b.serverName === 'None' || !b.serverName) ? -1 : (idxB >= 0 ? idxB : SERVER_PRIORITY.length);
        const sp = spA - spB;
        if (sp !== 0) return sp;
        const tpA = JOB_TYPE_PRIORITY.indexOf(a.name);
        const tpB = JOB_TYPE_PRIORITY.indexOf(b.name);
        return (tpA >= 0 ? tpA : JOB_TYPE_PRIORITY.length) - (tpB >= 0 ? tpB : JOB_TYPE_PRIORITY.length);
    });
    jobs._skippedMaintenance = skippedMaintenance;
    return jobs;
}

let _scheduleAutoFinishDebounceTimer = null;
let scheduling = Promise.resolve();
let activeRun = null;
let refreshSequence = 0;

async function refreshJobMarkets(tabId, order) {
    await chrome.storage.local.set({ autoJobsPlanning: { message: 'Refreshing available jobs', at: Date.now() } }).catch(() => {});
    const requestId = 'jobs-refresh:' + Date.now() + ':' + (++refreshSequence);
    let finish;
    const completed = new Promise(resolve => {
        function listener(changes, area) {
            const result = changes.marketRefreshResult?.newValue;
            if (area === 'local' && result?.requestId === requestId) finish(result);
        }
        const timer = setTimeout(() => finish({ success: false }), 330000);
        finish = result => {
            clearTimeout(timer);
            chrome.storage.onChanged.removeListener(listener);
            resolve(result);
        };
        chrome.storage.onChanged.addListener(listener);
    });
    let queued = false;
    try {
        const reply = await chrome.tabs.sendMessage(tabId, { action: 'refreshAllMarketsSeq', skipLots: true, order, requestId });
        queued = reply?.success && !['already-running', 'already-queued'].includes(reply.queueResult);
        if (!queued) { finish({ success: false }); return { success: false }; }
        return await completed;
    } catch (error) {
        finish({ success: false });
        return { success: false };
    } finally {
        if (queued) await chrome.tabs.sendMessage(tabId, { action: 'cancelScheduledMarketRefresh', requestId }).catch(() => {});
    }
}

// Repeated market updates must not keep pushing an imminent run into the future.
async function scheduleJobAlarm(delayInMinutes, reason = 'Waiting for the next automatic check') {
    const existing = await chrome.alarms.get('autoFinishAllJobs');
    const when = Date.now() + delayInMinutes * 60000;
    if (existing?.scheduledTime > Date.now() && existing.scheduledTime <= when + 1000) {
        const { autoJobsSchedule } = await chrome.storage.local.get('autoJobsSchedule');
        if (autoJobsSchedule?.at !== existing.scheduledTime) await chrome.storage.local.set({
            autoJobsSchedule: { at: existing.scheduledTime, reason: 'Waiting for the scheduled job check' }
        }).catch(() => {});
        return false;
    }
    await chrome.alarms.create('autoFinishAllJobs', { when });
    await chrome.storage.local.set({ autoJobsSchedule: { at: when, reason } }).catch(() => {});
    return true;
}

export function scheduleAutoFinishAllBgDebounced() {
    if (_scheduleAutoFinishDebounceTimer) return;
    _scheduleAutoFinishDebounceTimer = setTimeout(() => {
        _scheduleAutoFinishDebounceTimer = null;
        scheduleAutoFinishAllBg();
    }, 2000);
}

export function scheduleAutoFinishAllBg() {
    const pending = scheduling.then(scheduleAutoFinish);
    scheduling = pending.catch(() => {});
    return pending;
}

async function scheduleAutoFinish() {
    const settings = await chrome.storage.sync.get(['autoFinishAllJobsEnabled', 'helperMode']);
    if (!settings.autoFinishAllJobsEnabled || settings.helperMode) {
        await chrome.alarms.clear('autoFinishAllJobs');
        await chrome.storage.local.set({ autoJobsSchedule: null }).catch(() => {});
        return;
    }

    const { marketData, darkMarketData, soyuzMarketData, usolMarketData, autoJobsRunning, serverMaintenanceMap, networkMapData,
        marketJobsRevision = 0, autoJobsStoppedRevision } = await chrome.storage.local.get(['marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData',
            'autoJobsRunning', 'serverMaintenanceMap', 'networkMapData', 'marketJobsRevision', 'autoJobsStoppedRevision']);

    if (autoJobsRunning || activeRun) {
        return;
    }

    const { autoJobsCompletedResults: crSched } = await chrome.storage.local.get('autoJobsCompletedResults');
    const availableNow = collectJobsBg(marketData, darkMarketData, crSched || [], serverMaintenanceMap, soyuzMarketData, usolMarketData, networkMapData);
    const stoppedUntilRefresh = autoJobsStoppedRevision != null && marketJobsRevision <= autoJobsStoppedRevision;
    if (availableNow.length > 0 && !stoppedUntilRefresh) {
        if (await scheduleJobAlarm(10 / 60, 'Jobs are available; starting soon')) {
            bgAutoJobLog('🔄 Auto Finish All: jobs available now — starting in 10s');
        }
        return;
    }

    let minWaitMs = Infinity;
    const now = Date.now();
    let scheduledReason = '';

    for (const md of [marketData, darkMarketData, soyuzMarketData, usolMarketData]) {
        if (md && md.nextJobsResetAt) {
            const diff = new Date(md.nextJobsResetAt).getTime() - now;
            if (diff > 0 && diff < minWaitMs) {
                minWaitMs = diff;
                scheduledReason = 'job reset';
            }
        }
    }

    const skipped = availableNow._skippedMaintenance || [];
    let maintenanceMessage = null;
    if (skipped.length > 0) {
        const seenBlockerIds = new Set();
        for (const s of skipped) {
            if (seenBlockerIds.has(s.blockerId)) continue;
            seenBlockerIds.add(s.blockerId);
            if (s.maintenanceEndsAt) {
                const diff = new Date(s.maintenanceEndsAt).getTime() + 3 * 60 * 1000 - now;
                if (diff > 0 && diff < minWaitMs) {
                    minWaitMs = diff;
                    scheduledReason = `${s.blockerName} maintenance end (+3m buffer)`;
                }
            } else if (minWaitMs > 5 * 60 * 1000) {
                minWaitMs = 5 * 60 * 1000;
                scheduledReason = 'checking maintenance with no end time';
            }
        }
        const blockedPairs = [...new Set(skipped.map(s =>
            s.blockerName === s.serverName ? s.serverName : `${s.serverName} (blocked by ${s.blockerName})`
        ))].join(', ');
        maintenanceMessage = `🔄 Auto Finish All: skipped jobs due to maintenance: ${blockedPairs}`;
    }

    const skippedFromResults = (crSched || []).filter(cr => cr.status === 'skipped' || isRetryableJobResult(cr));
    if (skippedFromResults.length > 0) {
        for (const sr of skippedFromResults) {
            let hasEndTimeInfo = false;
            if (sr.maintenanceEndsAt) {
                hasEndTimeInfo = true;
                const diff = new Date(sr.maintenanceEndsAt).getTime() + 3 * 60 * 1000 - now;
                if (diff > 0 && diff < minWaitMs) {
                    minWaitMs = diff;
                    scheduledReason = `maintenance end (${sr.serverName || 'unknown server'}) (+3m buffer)`;
                } else if (diff <= 0 && minWaitMs > 30000) {
                    minWaitMs = 30 * 1000;
                    scheduledReason = `maintenance ended (${sr.serverName || 'unknown server'}) — rechecking`;
                }
            }
            if (isMinigameLocked(sr, now)) {
                hasEndTimeInfo = true;
                const diff = new Date(sr.lockExpiresAt).getTime() - now;
                if (diff < minWaitMs) {
                    minWaitMs = diff;
                    scheduledReason = `minigame lock expires (${sr.name || sr.serverName || 'unknown'})`;
                }
            }
            if (!hasEndTimeInfo) {
                const fallback = 5 * 60 * 1000;
                if (fallback < minWaitMs) {
                    minWaitMs = fallback;
                    scheduledReason = 'retrying jobs that could not run earlier';
                }
            }
        }
    }

    if (minWaitMs < Infinity) {
        const waitMs = minWaitMs + 15000;
        const mins = Math.max(waitMs / 60000, 0.25);
        const reason = /maintenance/.test(scheduledReason) ? 'Waiting for server maintenance to finish'
            : /minigame/.test(scheduledReason) ? 'Waiting for a locked minigame'
            : /reset/.test(scheduledReason) ? 'Waiting for new market jobs'
            : 'Waiting before retrying skipped jobs';
        if (await scheduleJobAlarm(mins, reason)) {
            if (maintenanceMessage) await bgAutoJobLog(maintenanceMessage, 'warn');
            await bgAutoJobLog(`🔄 Auto Finish All: next run scheduled in ${Math.floor(waitMs / 60000)}m ${Math.floor((waitMs % 60000) / 1000)}s (${scheduledReason})`);
        }
    } else {
        if (await scheduleJobAlarm(5, 'Checking again for available jobs')) {
            bgAutoJobLog('🔄 Auto Finish All: no reset timer found — checking again in 5m');
        }
    }
}

export function runAutoFinishAllBg() {
    if (activeRun) return activeRun;
    activeRun = runAutoFinish().finally(async () => {
        await chrome.storage.local.set({ autoJobsPlanning: null }).catch(() => {});
        activeRun = null;
        await scheduleAutoFinishAllBg();
    });
    return activeRun;
}

async function autoFinishEnabled() {
    const settings = await chrome.storage.sync.get(['autoFinishAllJobsEnabled', 'helperMode']);
    return !!settings.autoFinishAllJobsEnabled && !settings.helperMode;
}

async function runAutoFinish() {
    if (!await autoFinishEnabled()) return;

    const { autoJobsRunning } = await chrome.storage.local.get('autoJobsRunning');
    if (autoJobsRunning) {
        return;
    }

    const tab = await getCor3Tab();
    if (!tab) {
        bgAutoJobLog('🔄 Auto Finish All: no cor3.gg tab found — retrying in 1m', 'warn');
        await scheduleJobAlarm(1, 'Waiting for an open game tab');
        return;
    }

    // Wait for initial page load fetch to complete before refreshing markets
    await chrome.storage.local.set({ autoJobsPlanning: { message: 'Checking for available jobs', at: Date.now() } }).catch(() => {});
    let fetchWaitAttempts = 0;
    while (fetchWaitAttempts < 24) {
        const { initialFetchDoneAt } = await chrome.storage.local.get('initialFetchDoneAt');
        if (initialFetchDoneAt) break;
        fetchWaitAttempts++;
        if (fetchWaitAttempts === 1) {
            bgAutoJobLog('🔄 Auto Finish All: waiting for initial page load to complete...');
            await chrome.storage.local.set({ autoJobsPlanning: { message: 'Waiting for initial game data', at: Date.now() } }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    if (fetchWaitAttempts >= 24) {
        bgAutoJobLog('🔄 Auto Finish All: game data is still loading — checking again in 1m', 'warn');
        await scheduleJobAlarm(1);
        return;
    }

    const { autoJobsCompletedResults: crPre } = await chrome.storage.local.get('autoJobsCompletedResults');
    if (Array.isArray(crPre) && crPre.some(cr => cr.status === 'skipped' || isRetryableJobResult(cr))) {
        const cleared = crPre.filter(cr => isMinigameLocked(cr) || (cr.status !== 'skipped' && !isRetryableJobResult(cr)));
        await chrome.storage.local.set({ autoJobsCompletedResults: cleared });
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        if (!await autoFinishEnabled()) return;
        const runCheck = await chrome.storage.local.get('autoJobsRunning');
        if (runCheck.autoJobsRunning) return;

        const { marketData: mdCheck, darkMarketData: dmdCheck, soyuzMarketData: smdCheck, usolMarketData: umdCheck } = await chrome.storage.local.get(['marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData']);
        const nowCheck = Date.now();
        const expiredMarkets = [];
        if (!mdCheck || !mdCheck.nextJobsResetAt || new Date(mdCheck.nextJobsResetAt).getTime() <= nowCheck) expiredMarkets.push('home');
        if (!dmdCheck || !dmdCheck.nextJobsResetAt || new Date(dmdCheck.nextJobsResetAt).getTime() <= nowCheck) expiredMarkets.push('dark');
        if (!smdCheck || !smdCheck.nextJobsResetAt || new Date(smdCheck.nextJobsResetAt).getTime() <= nowCheck) expiredMarkets.push('soyuz');
        if (!umdCheck || !umdCheck.nextJobsResetAt || new Date(umdCheck.nextJobsResetAt).getTime() <= nowCheck) expiredMarkets.push('usol');

        const refreshOrder = [];
        if (expiredMarkets.includes('usol')) refreshOrder.push('usol');
        if (expiredMarkets.includes('soyuz')) refreshOrder.push('soyuz');
        if (expiredMarkets.includes('dark')) refreshOrder.push('dark');
        if (expiredMarkets.includes('home')) refreshOrder.push('home');
        for (const key of ['usol', 'soyuz', 'dark', 'home']) if (!refreshOrder.includes(key)) refreshOrder.push(key);

        bgAutoJobLog(`🔄 Auto Finish All: refreshing ${refreshOrder.length > 0 ? refreshOrder.join(', ') : 'all'} market data (attempt ${attempt}/3)...`);
        const refreshResult = await refreshJobMarkets(tab.id, refreshOrder);
        if (!refreshResult.success || !refreshResult.markets?.length) {
            bgAutoJobLog('🔄 Auto Finish All: fresh job data was not confirmed — checking again in 1m', 'warn');
            await scheduleJobAlarm(1);
            return;
        }
        if (!await autoFinishEnabled()) return;

        const local = await chrome.storage.local.get(['marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData',
            'autoJobsCompletedResults', 'serverMaintenanceMap', 'networkMapData', 'marketJobsRevision', 'autoJobsStoppedRevision']);
        if (local.autoJobsStoppedRevision != null && (local.marketJobsRevision || 0) <= local.autoJobsStoppedRevision) return;
        const fresh = new Set(refreshResult.markets);
        const marketData = fresh.has('home') ? local.marketData : null;
        const darkMarketData = fresh.has('dark') ? local.darkMarketData : null;
        const soyuzMarketData = fresh.has('soyuz') ? local.soyuzMarketData : null;
        const usolMarketData = fresh.has('usol') ? local.usolMarketData : null;
        const jobsToRun = collectJobsBg(marketData, darkMarketData, local.autoJobsCompletedResults || [], local.serverMaintenanceMap,
            soyuzMarketData, usolMarketData, local.networkMapData);

        if (jobsToRun.length > 0) {
            const skippedList = jobsToRun._skippedMaintenance || [];
            if (skippedList.length > 0) {
                const blockedPairs = [...new Set(skippedList.map(s =>
                    s.blockerName === s.serverName ? s.serverName : `${s.serverName} (blocked by ${s.blockerName})`
                ))].join(', ');
                bgAutoJobLog(`🔄 Auto Finish All: skipped ${skippedList.length} job(s) due to maintenance: ${blockedPairs}`, 'warn');
            }
            bgAutoJobLog(`🔄 Auto Finish All: starting ${jobsToRun.length} job(s)`);
            const { autoJobsTracker: existingTracker } = await chrome.storage.local.get('autoJobsTracker');
            const newJobIds = new Set(jobsToRun.map(j => j.jobId));
            const previousJobs = (existingTracker || []).filter(j =>
                !newJobIds.has(j.jobId) && (j.status === 'done' || j.status === 'failed' || j.status === 'skipped' || j.status === 'bugged')
            );
            const mergedTracker = [...previousJobs, ...jobsToRun];
            try {
                await ensureGameConnection(tab.id);
                if (!await autoFinishEnabled()) return;
                await chrome.storage.local.set({ autoJobsRunning: true, autoJobsQueue: jobsToRun, autoJobsTracker: mergedTracker });
                await sendGameMessage(tab.id, { action: "startAutoJobs", jobs: jobsToRun, automatic: true });
            } catch (e) {
                bgAutoJobLog('🔄 Auto Finish All: failed to start — ' + (e.message || e), 'error');
                cor3LogError('background.js', e, { action: 'autoFinishAll-startJobs' });
                await chrome.storage.local.set({ autoJobsRunning: false });
                await scheduleJobAlarm(1);
            }
            return;
        }

        const allUnfiltered = [];
        const seenUnfilteredIds = new Set();
        for (const md of [marketData, darkMarketData, soyuzMarketData, usolMarketData]) {
            if (!md) continue;
            const open = (md.jobs || []).filter(j => !j.isCompleted && !j.isExpired && SUPPORTED_JOB_TYPES_BG.includes(j.name));
            const taken = (md.recentJobs || []).filter(j => j.status === 'TAKEN' && SUPPORTED_JOB_TYPES_BG.includes(j.name) && !seenUnfilteredIds.has(j.id));
            allUnfiltered.push(...open);
            for (const j of taken) { seenUnfilteredIds.add(j.id); allUnfiltered.push(j); }
        }
        if (allUnfiltered.length > 0) {
            const skipped = jobsToRun._skippedMaintenance || [];
            if (skipped.length > 0) {
                const blockedPairs = [...new Set(skipped.map(s =>
                    s.blockerName === s.serverName ? s.serverName : `${s.serverName} (blocked by ${s.blockerName})`
                ))].join(', ');
                bgAutoJobLog(`🔄 Auto Finish All: remaining jobs blocked by maintenance: ${blockedPairs} — scheduling at maintenance end or reset.`, 'warn');
            } else {
                bgAutoJobLog('🔄 Auto Finish All: only bugged/failed jobs remain — waiting for next reset.', 'warn');
            }
            scheduleAutoFinishAllBg();
            return;
        }

        if (attempt < 3) {
            const { marketData: mdTimerCheck, darkMarketData: dmdTimerCheck, soyuzMarketData: smdTimerCheck, usolMarketData: umdTimerCheck } = await chrome.storage.local.get(['marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData']);
            const nowTimerCheck = Date.now();
            let allFuture = true;
            let earliestResetMs = Infinity;
            for (const md of [mdTimerCheck, dmdTimerCheck, smdTimerCheck, umdTimerCheck]) {
                if (!md || !md.nextJobsResetAt) { allFuture = false; break; }
                const resetMs = new Date(md.nextJobsResetAt).getTime();
                if (resetMs <= nowTimerCheck) { allFuture = false; break; }
                if (resetMs < earliestResetMs) earliestResetMs = resetMs;
            }
            if (allFuture && earliestResetMs < Infinity) {
                const waitMs = earliestResetMs - nowTimerCheck + 15000;
                const mins = Math.max(waitMs / 60000, 0.25);
                bgAutoJobLog(`🔄 Auto Finish All: all markets have future reset timers — scheduling next run in ${Math.floor(waitMs / 60000)}m ${Math.floor((waitMs % 60000) / 1000)}s`);
                await scheduleJobAlarm(mins, 'Waiting for new market jobs');
                return;
            }

            bgAutoJobLog(`🔄 Auto Finish All: no jobs found yet, retrying in 60s (attempt ${attempt}/3)...`, 'warn');
            await new Promise(r => setTimeout(r, 60000));
            const recheck = await chrome.storage.sync.get('autoFinishAllJobsEnabled');
            if (!recheck.autoFinishAllJobsEnabled) return;
        }
    }

    bgAutoJobLog('🔄 Auto Finish All: no jobs found after 3 attempts — scheduling next check at reset');
    scheduleAutoFinishAllBg();
}
