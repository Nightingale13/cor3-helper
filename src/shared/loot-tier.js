import { historyItems } from './drone-history.js';
import { normalizeItemTier } from './item-tier.js';

function itemKeys(loot) {
    const item = loot.item || loot;
    return [
        (item.itemConfigId || loot.itemConfigId) && 'config:' + (item.itemConfigId || loot.itemConfigId),
        item.id && 'id:' + item.id,
        (item.imageUrl || item.image) && 'image:' + (item.imageUrl || item.image),
        item.name && 'name:' + item.name.trim().toLowerCase()
    ].filter(Boolean);
}

function ownTier(loot) {
    const tier = (loot.item || loot).tier || loot.tier;
    return normalizeItemTier(tier);
}

// Drone rewards can omit tier. Reuse metadata from the same items elsewhere,
// without inventing a rarity when a name/image has conflicting tiers.
export function createLootTierResolver(storage) {
    const tiers = new Map();
    const knownItems = [...(storage.stashData?.items || [])];
    for (const key of ['marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData']) {
        for (const lot of storage[key]?.lots || []) {
            if (lot.details) knownItems.push(lot.details);
        }
    }
    for (const key of ['archivedExpeditionsData', 'droneArchivedData']) {
        for (const mission of historyItems(storage[key])) {
            const container = mission.containerData || mission.container;
            knownItems.push(...(Array.isArray(container) ? container : container?.items || []), ...(mission.loot || []));
        }
    }
    for (const item of knownItems) {
        const tier = ownTier(item);
        if (!tier) continue;
        for (const key of itemKeys(item)) {
            tiers.set(key, tiers.has(key) && tiers.get(key) !== tier ? null : tier);
        }
    }
    return loot => {
        const tier = ownTier(loot);
        if (tier) return tier;
        for (const key of itemKeys(loot)) {
            if (tiers.get(key)) return tiers.get(key);
        }
        return null;
    };
}
