import { isContextValid } from './helpers.js';

let pending = {};
let timer;
let writes = Promise.resolve();
export function saveProgress(feature, message, job = {}, nextAt = null, observedAt = Date.now()) {
    const at = Number.isFinite(observedAt) ? Math.min(observedAt, Date.now()) : Date.now();
    if (pending[feature]?.at > at) return;
    pending[feature] = { message, jobName: job.name || '', serverName: job.serverName || '', at, nextAt };
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        const updates = pending;
        pending = {};
        writes = writes.catch(() => {}).then(async () => {
            if (!isContextValid()) return;
            const { automationProgress = {} } = await chrome.storage.local.get('automationProgress');
            for (const [feature, entry] of Object.entries(updates)) {
                if (!automationProgress[feature] || entry.at >= automationProgress[feature].at) automationProgress[feature] = entry;
            }
            await chrome.storage.local.set({ automationProgress });
        });
    }, 150);
}
