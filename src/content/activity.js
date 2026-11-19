import { applyActivity, activityDay, reconcileActivityJobs } from '../shared/activity-summary.js';
import { isContextValid } from './helpers.js';

let writes = Promise.resolve();
let sequence = 0;
export function recordActivity(events) {
    const pending = writes.catch(() => {}).then(async () => {
        if (!isContextValid()) return;
        const { activitySummary } = await chrome.storage.local.get('activitySummary');
        let next = reconcileActivityJobs(activitySummary);
        for (const event of events) next = applyActivity(next, event);
        if (next && next !== activitySummary) await chrome.storage.local.set({ activitySummary: next });
    });
    writes = pending;
    return pending;
}

export function setupActivityTracking() {
    recordActivity([]).catch(() => {});
    window.addEventListener('message', event => {
        if (event.source !== window || !isContextValid()) return;
        const data = event.data;
        let events = [];
        if (data?.type === 'COR3_AUTOJOB_PROFILE_CREDITS' && Number.isFinite(data.data?.amount)) {
            events = [{ kind: 'credits', id: 'credits:' + (data.data.transactionId || Date.now() + ':' + (++sequence)),
                amount: data.data.amount, balance: data.data.newBalance }];
        } else if (data?.type === 'COR3_AUTOJOB_SAVE_COMPLETED') {
            events = (data.jobs || []).flatMap(job => {
                if (!job.jobId) return [];
                // Job reputation belongs to the market; profile progress is player Renown.
                if (job.status === 'done') return [{ kind: 'jobDone', id: 'job:' + job.jobId, jobId: job.jobId, name: job.name,
                    earnings: job.reward?.credits, reputation: job.reward?.reputation, marketXp: job.reward?.renown }];
                if (job.status === 'skipped' || job.status === 'failed' || job.status === 'bugged') {
                    return [{ kind: 'jobSkipped', id: 'skip:' + activityDay() + ':' + job.jobId, jobId: job.jobId, name: job.name, reason: job.error }];
                }
                return [];
            });
        } else if (data?.type === 'COR3_ACTIVITY_EVENT') events = [data.event];
        if (events.length) recordActivity(events).catch(() => {});
    });
}
