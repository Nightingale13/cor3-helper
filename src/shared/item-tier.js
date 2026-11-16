export function normalizeItemTier(tier) {
    if (typeof tier !== 'string' || !tier.trim()) return null;
    return tier.trim().toUpperCase().replace(/^SUPER[\s_-]*RARE$/, 'SUPER_RARE');
}

export function itemTierClass(tier) {
    return (normalizeItemTier(tier) || 'COMMON').toLowerCase().replace(/_/g, '-');
}

export function itemTierLabel(tier) {
    return (normalizeItemTier(tier) || 'COMMON').replace(/_/g, ' ');
}
