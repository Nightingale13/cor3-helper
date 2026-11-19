import { mercenaryWarning } from './merc-status.js';

const names = { 'auto-jobs': 'Auto Jobs', 'auto-send': 'Mercenary Expeditions', 'auto-drone': 'Drone automation',
    'auto-valuable': 'Valuable Seller', 'force-maintenance': 'server maintenance',
    'scheduled-market-refresh': 'the market refresh', 'manual-market-refresh': 'the market refresh',
    'auto-update-markets': 'the market refresh', 'auto-refresh-markets': 'the market refresh' };

function countdown(at, now) {
    const seconds = Math.max(0, Math.ceil((at - now) / 1000));
    return seconds >= 3600 ? Math.ceil(seconds / 3600) + 'h' : seconds >= 60 ? Math.ceil(seconds / 60) + 'm' : seconds + 's';
}
export { countdown as automationCountdown };
function scheduleDetail(schedule, now) {
    if (!Number.isFinite(schedule?.at)) return '';
    return schedule.at > now ? 'Next check in ' + countdown(schedule.at, now) + ' (' + new Date(schedule.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ').'
        : 'The next check is due. Waiting for the game to respond.';
}

export function automationStatuses(local, settings, now = Date.now()) {
    const queue = local.automationQueueStatus || {};
    const progress = local.automationProgress || {};
    const stopped = local.autoJobsStoppedRevision != null && (local.marketJobsRevision || 0) <= local.autoJobsStoppedRevision;
    const queued = type => (queue.queued || []).includes(type);
    const waiting = type => queued(type) && queue.active !== type ? {
        title: queue.pausedForUser && !queue.active ? 'Waiting while you use the game' : 'Queued behind ' + (names[queue.active] || 'another automation'),
        detail: 'This will continue when the current action finishes.'
    } : null;
    const current = (type, feature) => {
        const entry = progress[feature];
        const job = feature === 'jobs' ? (local.autoJobsTracker || []).find(item => item.status === 'running') : null;
        return entry && (!queue.startedAt || entry.at >= queue.startedAt) ? {
            title: entry.message,
            detail: [entry.jobName || job?.name, (entry.serverName || job?.serverName) !== 'None' ? entry.serverName || job?.serverName : '',
                entry.nextAt > now ? 'Retry in ' + countdown(entry.nextAt, now) + '.' : ''].filter(Boolean).join(' · ')
        } : { title: 'Preparing ' + (names[type] || 'automation'), detail: '' };
    };
    let jobs;
    if (queue.active === 'auto-jobs' && queue.stopping) jobs = { title: 'Stopping the current run', detail: 'Automatic mode remains enabled if its switch is on.' };
    else if (waiting('auto-jobs') && local.autoJobsRunning) jobs = waiting('auto-jobs');
    else if (local.autoJobsRunning || queue.active === 'auto-jobs') jobs = queue.pausedForUser
        ? { title: 'Waiting while you use the game', detail: 'The current job will continue when you finish.' } : current('auto-jobs', 'jobs');
    else if (settings.helperMode) jobs = { title: 'Automatic starts are paused', detail: 'Helper-Only Mode is on.' };
    else if (!settings.autoFinishAllJobsEnabled) jobs = { title: 'Manual mode', detail: 'Select job types and click Start Auto Jobs.' };
    else if (waiting('auto-jobs')) jobs = waiting('auto-jobs');
    else if (local.autoJobsPlanning) jobs = { title: local.autoJobsPlanning.message,
        detail: queue.active ? 'Waiting for ' + (names[queue.active] || 'the current action') + ' if necessary.' : '' };
    else if (stopped) jobs = { title: 'Current run stopped', detail: 'Automatic jobs can resume after the next market refresh. ' + scheduleDetail(local.autoJobsSchedule, now) };
    else if (!local.initialFetchDoneAt) jobs = { title: 'Waiting for game data', detail: 'Open the game and let its initial data load.' };
    else jobs = { title: local.autoJobsSchedule?.reason || 'Waiting for the next automatic check', detail: scheduleDetail(local.autoJobsSchedule, now) };

    const cfg = settings.autoSendMerc || {};
    const warning = mercenaryWarning(cfg, local.mercWarning, local.autoSendRecovery);
    const active = (local.expeditionsData || []).find(expedition => expedition.status && !['COMPLETED', 'FAILED'].includes(expedition.status));
    let mercenaries;
    if (active) {
        const end = new Date(active.endTime).getTime();
        mercenaries = { icon: '🚶‍♂️', title: 'Mercenary expedition in progress', detail: (active.mercenary?.callsign || 'Your mercenary') +
            (Number.isFinite(end) ? end > now ? ' returns in ' + countdown(end, now) + '.' : ' is waiting for the game to confirm the result.' : ' is on an expedition.') +
            (settings.helperMode || !cfg.enabled ? ' Automatic Mercenary Expeditions is off.' : '') };
    } else if (settings.helperMode) mercenaries = { icon: '⏸️', title: 'Automatic sending is paused', detail: 'Helper-Only Mode is on.' };
    else if (!cfg.enabled) mercenaries = { icon: warning ? '⚠️' : '⏹️', title: 'Automatic sending is off', detail: warning?.message || 'Enable Automatic Mercenary Expeditions to send the next mercenary automatically.' };
    else if (local.autoSendFundingWait) mercenaries = { icon: '💰', title: 'Waiting for credits',
        detail: (Number.isFinite(local.autoSendFundingWait.requiredCredits) ? 'Need ' + local.autoSendFundingWait.requiredCredits.toLocaleString() + ' CR. ' : '') +
            (local.autoSendFundingWait.nextRetryAt > now ? 'Next check in ' + countdown(local.autoSendFundingWait.nextRetryAt, now) + '. ' : 'Checking again when the game is available. ') +
            'Income can trigger an earlier check.' };
    else if (local.autoSendRecovery?.nextRetryAt > now) mercenaries = { icon: '🔄', title: 'Retrying in ' + countdown(local.autoSendRecovery.nextRetryAt, now), detail: warning?.message || 'Waiting before checking current game state again.' };
    else if (waiting('auto-send')) mercenaries = { ...waiting('auto-send'), icon: '⏳' };
    else if (queue.active === 'auto-send') mercenaries = { ...current('auto-send', 'mercenaries'), icon: '⚙️' };
    else if (local.autoSendRecovery) mercenaries = { icon: '⏳', title: 'Waiting to retry', detail: 'The retry is due. Waiting for the game to become available.' };
    else if (warning) mercenaries = { icon: '⚠️', title: 'Waiting for the next mercenary', detail: warning.message };
    else mercenaries = { icon: '🔎', title: 'Waiting for expedition data', detail: 'Checking whether a mercenary is available or already on an expedition.' };

    let valuables;
    const valuableType = queue.active === 'force-maintenance' || queued('force-maintenance') ? 'force-maintenance' : 'auto-valuable';
    if (queue.active === valuableType && queue.stopping) valuables = { title: 'Stopping the current action', detail: 'Waiting for the current step to finish.' };
    else if (waiting(valuableType)) valuables = waiting(valuableType);
    else if (queue.active === valuableType || local.valuableSearchRunning || local.valuableSellerRunning) {
        valuables = queue.pausedForUser ? { title: 'Waiting while you use the game', detail: 'The current action will continue when you finish.' }
            : current(valuableType, 'valuables');
    } else valuables = { title: 'Idle', detail: 'Choose servers to search or valuable items to sell.' };
    return { jobs, mercenaries, valuables };
}
