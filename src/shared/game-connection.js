const reconnecting = new Map();

async function ping(tabId) {
    let timeout;
    try {
        const reply = await Promise.race([chrome.tabs.sendMessage(tabId, { action: 'cor3Ping' }),
            new Promise(resolve => { timeout = setTimeout(() => resolve(null), 500); })]);
        return reply?.ready === true;
    } catch { return false; }
    finally { clearTimeout(timeout); }
}

export function isGameUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && ['cor3.gg', 'os.cor3.gg'].includes(parsed.hostname); }
    catch { return false; }
}

export async function ensureGameConnection(tabId) {
    if (!Number.isInteger(tabId)) throw new Error('Open cor3.gg before starting Auto Jobs.');
    if (await ping(tabId)) return;
    if (reconnecting.has(tabId)) return reconnecting.get(tabId);
    const pending = reconnect(tabId);
    reconnecting.set(tabId, pending);
    try { await pending; } finally { reconnecting.delete(tabId); }
}

async function reconnect(tabId) {
    // Reuse the game's existing socket bridge. Reloading the page here would
    // close the windows the player is using.
    const [bridge] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: () => ({ active: !!window.__cor3WsInterceptorActive,
            initialFetchDone: !!window.__cor3InitialMercsFetchDone && !window.__cor3InitialFetchInProgress }) });
    if (!bridge?.result?.active) throw new Error('Refresh cor3.gg once to connect the helper, then start Auto Jobs again.');
    const [globals] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
        func: () => ({ errors: typeof cor3LogError === 'function', messages: typeof cor3LogWsMessage === 'function' }) });
    const files = [];
    // These legacy libraries declare global constants, so do not redeclare them.
    if (!globals?.result?.errors) files.push('errors.js');
    if (!globals?.result?.messages) files.push('ws-messages.js');
    files.push('content.js');
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files });
    for (let attempt = 0; attempt < 20; attempt++) {
        if (await ping(tabId)) {
            await chrome.tabs.sendMessage(tabId, { action: 'restoreGameConnection', initialFetchDone: bridge.result.initialFetchDone });
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The helper could not reconnect. Refresh cor3.gg once, then start Auto Jobs again.');
}

export async function sendGameMessage(tabId, message) {
    await ensureGameConnection(tabId);
    // Send a job-start command only once. A lost acknowledgement must not replay
    // mutations that may already have reached the content script.
    const reply = await chrome.tabs.sendMessage(tabId, message);
    if (!reply?.success) throw new Error(reply?.error || 'The helper did not accept the command.');
    return reply;
}
