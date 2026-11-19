import { isGameUrl } from '../shared/game-connection.js';

let writes = Promise.resolve();
function serialize(run) {
    const next = writes.then(run);
    writes = next.catch(() => {});
    return next;
}

export function claimAutomationOwner(sender, instanceId) {
    return serialize(async () => {
        if (!Number.isInteger(sender.tab?.id) || !isGameUrl(sender.tab.url) || !instanceId)
            return { granted: false };
        const { automationOwner } = await chrome.storage.local.get('automationOwner');
        if (automationOwner && automationOwner.tabId !== sender.tab.id) {
            const tabs = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
            if (tabs.some(tab => tab.id === automationOwner.tabId)) return { granted: false, owner: automationOwner };
        }
        const owner = { tabId: sender.tab.id, instanceId, documentId: sender.documentId || null };
        await chrome.storage.local.set({ automationOwner: owner });
        return { granted: true, owner };
    });
}

export function releaseAutomationOwner(tabId, instanceId) {
    return serialize(async () => {
        if (!Number.isInteger(tabId)) return;
        const { automationOwner } = await chrome.storage.local.get('automationOwner');
        if (automationOwner?.tabId === tabId && (!instanceId || automationOwner.instanceId === instanceId)) {
            await chrome.storage.local.set({ automationOwner: null });
        }
    });
}

export function setupAutomationOwner() {
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
        if (request.action === 'releaseAutomationOwner') {
            releaseAutomationOwner(sender.tab?.id, request.instanceId).then(() => respond({ success: true }))
                .catch(error => respond({ success: false, error: error.message }));
            return true;
        }
        if (request.action !== 'claimAutomationOwner') return;
        claimAutomationOwner(sender, request.instanceId).then(respond).catch(error => respond({ granted: false, error: error.message }));
        return true;
    });
    chrome.tabs.onRemoved?.addListener(tabId => { releaseAutomationOwner(tabId).catch(() => {}); });
    chrome.tabs.onUpdated?.addListener((tabId, change) => {
        if (change.url && !isGameUrl(change.url)) releaseAutomationOwner(tabId).catch(() => {});
    });
}
