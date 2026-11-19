import { waitForGameReply } from './expedition-mail.js';
import { protectedStashSales } from '../shared/inventory-protection.js';

export async function freeMailSpace(stash, slots, signal) {
    let freed = 0;
    while (freed < slots) {
        if (signal.aborted) throw new DOMException('Mail collection cancelled', 'AbortError');
        const [settings, saved] = await Promise.all([chrome.storage.sync.get(['autoSellCheapest', 'helperMode']),
            chrome.storage.local.get('protectedInventoryRules')]);
        if (settings.autoSellCheapest !== true || settings.helperMode) throw Object.assign(new Error('Stash is full. Clear inventory before claiming reward mail.'), { code: 'stash_full' });
        const sale = protectedStashSales(stash.items, saved.protectedInventoryRules || [])[0];
        if (!sale) throw Object.assign(new Error('Stash is full. The remaining items are protected or cannot be sold. Free some space before claiming reward mail.'), { code: 'stash_full' });
        const { item, quantity } = sale;
        console.log('[COR3 Helper] Auto-sell for reward mail:', item.name);
        // Wait for confirmed removal before selling another item or retrying the claim.
        const reply = await waitForGameReply('COR3_WS_STASH', {
            type: 'COR3_SELL_ITEM', itemId: item.id, quantity
        }, signal, reply => Array.isArray(reply.stash?.items) && !reply.stash.items.some(i => i.id === item.id));
        freed += Number.isFinite(stash.currentUsage) && Number.isFinite(reply.stash.currentUsage)
            ? Math.max(0, stash.currentUsage - reply.stash.currentUsage) : (item.width || 1) * (item.height || 1);
        stash = reply.stash;
    }
}

