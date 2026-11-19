import { getCor3Tab } from './helpers.js';

export async function checkAutoChooseBackground() {
    try {
        const settings = await chrome.storage.sync.get(['decisionModifiers', 'helperMode']);
        if (settings.helperMode || settings.decisionModifiers?.autoChoose === false) return;
        // Content owns confirmation and retries for every mercenary choice.
        const tab = await getCor3Tab();
        if (tab) await chrome.tabs.sendMessage(tab.id, { action: 'checkMercenaryDecisions' });
    } catch { /* The game tab may have closed or be reloading. */ }
}
