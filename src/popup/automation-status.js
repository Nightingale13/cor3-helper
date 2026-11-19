import { el } from './dom-helpers.js';
import { automationStatuses, automationCountdown } from '../shared/automation-status.js';
import { formatJobLog } from '../shared/job-log-format.js';

const localKeys = ['automationQueueStatus', 'automationProgress', 'autoJobsRunning', 'autoJobsTracker', 'autoJobsPlanning', 'autoJobsSchedule',
    'autoJobsStoppedRevision', 'marketJobsRevision', 'initialFetchDoneAt', 'expeditionsData', 'mercWarning', 'autoSendRecovery', 'autoSendFundingWait',
    'valuableSearchRunning', 'valuableSellerRunning', 'dailyHackNextCheckAt'];
const settingKeys = ['autoFinishAllJobsEnabled', 'autoSendMerc', 'helperMode', 'autoDailyHackEnabled'];
const local = {}, settings = {}, nodes = {};
for (const [feature, parent] of [['jobs', 'autoJobSolverSection'], ['valuables', 'autoValuableSellerSection'], ['mercenaries', 'mercenariesSectionBody']]) {
    const host = document.getElementById(parent);
    if (!host) continue;
    const node = el('div', { className: 'automation-state', role: 'status', id: feature + 'AutomationStatus' });
    if (feature === 'mercenaries') host.prepend(node); else host.querySelector('.section-title').after(node);
    nodes[feature] = node;
}
function render() {
    const views = automationStatuses(local, settings);
    for (const [feature, node] of Object.entries(nodes)) {
        const view = views[feature];
        node.replaceChildren(el('strong', null, view.icon ? el('span', { 'aria-hidden': 'true' }, view.icon + ' ') : null,
            formatJobLog(view.title)), el('span', null, formatJobLog(view.detail)));
    }
    const daily = document.getElementById('dailyHackLog');
    if (daily) {
        if (settings.autoDailyHackEnabled && !settings.helperMode && local.dailyHackNextCheckAt > Date.now()) {
            daily.dataset.nextCheck = 'Next daily check in ' + automationCountdown(local.dailyHackNextCheckAt, Date.now()) + '.';
        } else delete daily.dataset.nextCheck;
    }
}
Promise.all([chrome.storage.local.get(localKeys), chrome.storage.sync.get(settingKeys)]).then(([stored, saved]) => {
    for (const key of localKeys) if (!Object.hasOwn(local, key)) local[key] = stored[key];
    for (const key of settingKeys) if (!Object.hasOwn(settings, key)) settings[key] = saved[key];
    render();
});
chrome.storage.onChanged.addListener((changes, area) => {
    const keys = area === 'local' ? localKeys : area === 'sync' ? settingKeys : [];
    let changed = false;
    for (const key of keys) if (changes[key]) { (area === 'local' ? local : settings)[key] = changes[key].newValue; changed = true; }
    if (changed) render();
});
setInterval(render, 1000);
