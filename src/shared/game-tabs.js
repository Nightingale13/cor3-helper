export async function getGameTab() {
    const [tabs, { automationOwner }] = await Promise.all([
        chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] }),
        chrome.storage.local.get('automationOwner')
    ]);
    return tabs.find(tab => tab.id === automationOwner?.tabId) || tabs.find(tab => tab.active) || tabs[0] || null;
}
