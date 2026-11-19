// Names deliberately match all copies, including newly acquired ones.
export function inventoryName(item) {
    return String(item?.name || '').trim().toLocaleLowerCase();
}

export function currentInventoryRules(rules = []) {
    return rules.filter(rule => rule && !Object.hasOwn(rule, 'itemId'));
}

function quantity(item) {
    return Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
}

export function matchingInventoryRules(item, rules = []) {
    return currentInventoryRules(rules).filter(rule => inventoryName(rule) && inventoryName(rule) === inventoryName(item));
}

export function protectedStashSales(items = [], rules = []) {
    const totals = new Map();
    for (const item of items) totals.set(inventoryName(item), (totals.get(inventoryName(item)) || 0) + quantity(item));
    const sales = [];
    for (const item of [...items].filter(item => item.canSell && item.sellPrice > 0)
        .sort((a, b) => a.sellPrice * quantity(a) - b.sellPrice * quantity(b))) {
        const matches = matchingInventoryRules(item, rules);
        // An incomplete or invalid protection rule must never permit a sale.
        if (matches.some(rule => !Number.isSafeInteger(rule.minimum) || rule.minimum < 1)) continue;
        const minimum = Math.max(0, ...matches.map(rule => rule.minimum));
        const key = inventoryName(item);
        const count = quantity(item);
        if ((totals.get(key) || 0) - count < minimum) continue;
        // Only a whole stack frees its stash slot. Leave partial stacks intact.
        totals.set(key, totals.get(key) - count);
        sales.push({ item, quantity: count });
    }
    return sales;
}
