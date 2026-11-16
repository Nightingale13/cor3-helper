import { waitForGameReply } from './expedition-mail.js';

export async function freeMailSpace(stash, slots, signal) {
    const settings = await chrome.storage.sync.get('autoSellCheapest');
    if (!settings.autoSellCheapest) throw Object.assign(new Error('Stash is full. Clear inventory before claiming reward mail.'), { code: 'stash_full' });
    const items = stash.items.filter(i => i.canSell && i.sellPrice > 0)
        .sort((a, b) => a.sellPrice * (a.quantity || 1) - b.sellPrice * (b.quantity || 1));
    let freed = 0;
    for (const item of items) {
        if (signal.aborted) throw new DOMException('Mail collection cancelled', 'AbortError');
        console.log('[COR3 Helper] Auto-sell for reward mail:', item.name);
        // Wait for confirmed removal before selling another item or retrying the claim.
        await waitForGameReply('COR3_WS_STASH', {
            type: 'COR3_SELL_ITEM', itemId: item.id, quantity: item.quantity || 1
        }, signal, reply => Array.isArray(reply.stash?.items) && !reply.stash.items.some(i => i.id === item.id));
        freed += (item.width || 1) * (item.height || 1);
        if (freed >= slots) return;
    }
    throw Object.assign(new Error('Insufficient sellable items to make room for reward mail.'), { code: 'stash_full' });
}

